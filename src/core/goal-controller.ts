import { z } from "zod";
import type { GoalState, ModelRef } from "../state/schemas.js";
import type { Store } from "../state/store.js";
import type { Reporter } from "./reporter.js";
import { tokenTotal } from "./usage.js";

type MessageRecord = {
  info: {
    id?: string;
    role: string;
    cost?: number;
    tokens?: {
      total?: number;
      input?: number;
      output?: number;
      reasoning?: number;
      cache?: { read?: number; write?: number };
    };
  };
  parts: Array<{ type: string; text?: string; [key: string]: unknown }>;
};

export interface GoalClient {
  tool?: {
    ids(opts: { query?: { directory?: string } }): Promise<{ data?: string[] }>;
  };
  session: {
    create(opts: {
      body: { title: string };
      query?: { directory?: string };
    }): Promise<{ data?: { id: string } }>;
    prompt(opts: {
      path: { id: string };
      body: {
        parts: Array<{ type: "text"; text: string }>;
        model?: ModelRef;
        agent?: string;
        tools?: Record<string, boolean>;
      };
      query?: { directory?: string };
    }): Promise<{ data?: MessageRecord }>;
    promptAsync(opts: {
      path: { id: string };
      body: {
        parts: Array<{ type: "text"; text: string }>;
        model?: ModelRef;
        agent?: string;
      };
      query?: { directory?: string };
    }): Promise<unknown>;
    abort(opts: {
      path: { id: string };
      query?: { directory?: string };
    }): Promise<unknown>;
    messages(opts: {
      path: { id: string };
      query?: { directory?: string; limit?: number };
    }): Promise<{ data?: MessageRecord[] }>;
    delete(opts: {
      path: { id: string };
      query?: { directory?: string };
    }): Promise<unknown>;
    summarize?(opts: {
      path: { id: string };
      body: ModelRef;
      query?: { directory?: string };
    }): Promise<unknown>;
  };
}

export interface GoalOptions {
  evaluatorModel?: ModelRef;
  summarizerModel?: ModelRef;
  maxTurns: number;
  maxDurationMs: number;
  maxTokens: number;
  softTokens: number;
  noProgressLimit: number;
  evidenceChars: number;
  maxCost?: number;
}

export interface GoalSetOptions {
  evaluatorModel?: ModelRef;
  maxTurns?: number;
  maxDurationMs?: number;
  maxTokens?: number;
  softTokens?: number;
  noProgressLimit?: number;
  maxCost?: number;
}

const Verdict = z.object({
  verdict: z.enum(["met", "not_met", "impossible"]),
  reason: z.string().min(1).max(2000),
});

const CLEAR_ALIASES = new Set(["clear", "stop", "off", "reset", "none", "cancel"]);

function textOf(message: MessageRecord | undefined): string {
  return (message?.parts ?? [])
    .filter((part) => part.type === "text")
    .map((part) => part.text ?? "")
    .join("");
}

function parseVerdict(text: string): z.infer<typeof Verdict> {
  const candidates = [text];
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text)?.[1];
  if (fenced) candidates.push(fenced);
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start !== -1 && end > start) candidates.push(text.slice(start, end + 1));
  for (const candidate of candidates) {
    try {
      return Verdict.parse(JSON.parse(candidate.trim()));
    } catch {
      // Try the next bounded candidate.
    }
  }
  throw new Error("goal evaluator did not return valid verdict JSON");
}

function boundedEvidence(messages: MessageRecord[], maxChars: number): string {
  const assistant = messages
    .filter((m) => m.info.role === "assistant")
    .slice(-8)
    .map((m, index) => `## Assistant turn ${index + 1}\n${textOf(m)}`)
    .join("\n\n");
  if (assistant.length <= maxChars) return assistant;
  const half = Math.floor((maxChars - 80) / 2);
  return `${assistant.slice(0, half)}\n\n[... compacted ${assistant.length - half * 2} chars ...]\n\n${assistant.slice(-half)}`;
}

function observedUsage(messages: MessageRecord[], accounted: string[]): {
  tokens?: number;
  cost?: number;
  messageIDs: string[];
  incremental: boolean;
} {
  let tokens = 0;
  let cost = 0;
  let tokenKnown = false;
  let costKnown = false;
  const charged = new Set(accounted);
  const assistants = messages.filter((message) => message.info.role === "assistant");
  // Mixed/absent IDs are unsafe for delta accounting, so fall back to a
  // monotonic visible-transcript total unless every assistant message has one.
  const incremental =
    assistants.length > 0 && assistants.every((message) => Boolean(message.info.id));
  const messageIDs = [...accounted];
  for (const message of messages) {
    if (message.info.role !== "assistant") continue;
    const messageID = message.info.id;
    if (incremental && messageID && charged.has(messageID)) continue;
    const usage = message.info.tokens;
    if (usage) {
      tokenKnown = true;
      tokens += tokenTotal({
        total: usage.total,
        input: usage.input,
        output: usage.output,
        reasoning: usage.reasoning,
        cacheRead: usage.cache?.read,
        cacheWrite: usage.cache?.write,
      });
    }
    if (typeof message.info.cost === "number") {
      costKnown = true;
      cost += message.info.cost;
    }
    if (incremental && messageID) {
      charged.add(messageID);
      messageIDs.push(messageID);
    }
  }
  return {
    tokens: tokenKnown ? tokens : undefined,
    cost: costKnown ? cost : undefined,
    // Bound persisted metadata without affecting the monotonic totals.
    messageIDs: messageIDs.slice(-200),
    incremental,
  };
}

function latestAssistantUsedTools(messages: MessageRecord[]): boolean {
  const latest = [...messages].reverse().find((m) => m.info.role === "assistant");
  return latest?.parts.some((part) => part.type === "tool") ?? false;
}

export class GoalController {
  private evaluating = new Set<string>();
  private evaluatorSessions = new Set<string>();
  private sessionMeta = new Map<
    string,
    { model?: ModelRef; agent?: string }
  >();

  constructor(
    private deps: {
      store: Store;
      client: GoalClient;
      directory: string;
      reporter: Reporter;
      options: GoalOptions;
    }
  ) {}

  noteSession(
    sessionID: string,
    meta: { model?: ModelRef; agent?: string }
  ): void {
    const previous = this.sessionMeta.get(sessionID) ?? {};
    this.sessionMeta.set(sessionID, { ...previous, ...meta });
    const goal = this.deps.store.getGoal(sessionID);
    if (goal?.status === "active") {
      this.deps.store.updateGoal({
        ...goal,
        workerModel: meta.model ?? goal.workerModel,
        workerAgent: meta.agent ?? goal.workerAgent,
        updatedAt: Date.now(),
      });
    }
  }

  private set(sessionID: string, condition: string, options: GoalSetOptions = {}): GoalState {
    const clean = condition.trim();
    if (!clean) throw new Error("goal condition must not be empty");
    if (clean.length > 4000) throw new Error("goal condition exceeds 4000 characters");
    const now = Date.now();
    const meta = this.sessionMeta.get(sessionID);
    const goal: GoalState = {
      sessionID,
      condition: clean,
      status: "active",
      createdAt: now,
      updatedAt: now,
      turns: 0,
      maxTurns: options.maxTurns ?? this.deps.options.maxTurns,
      maxDurationMs: options.maxDurationMs ?? this.deps.options.maxDurationMs,
      maxTokens: options.maxTokens ?? this.deps.options.maxTokens,
      softTokens: Math.min(
        options.softTokens ?? this.deps.options.softTokens,
        options.maxTokens ?? this.deps.options.maxTokens
      ),
      noProgressLimit: options.noProgressLimit ?? this.deps.options.noProgressLimit,
      maxCost: options.maxCost ?? this.deps.options.maxCost,
      noProgressTurns: 0,
      evaluatorModel: options.evaluatorModel ?? this.deps.options.evaluatorModel,
      workerModel: meta?.model,
      workerAgent: meta?.agent,
      workerStatus: "starting",
      steering: [],
      accountedMessageIDs: [],
    };
    this.deps.store.setGoal(goal);
    return goal;
  }

  async start(
    sessionID: string,
    condition: string,
    options: GoalSetOptions = {}
  ): Promise<GoalState> {
    const previous = this.deps.store.getGoal(sessionID);
    if (previous?.status === "active" || previous?.status === "paused") {
      await this.stopWorker(previous);
    }
    const goal = this.set(sessionID, condition, options);
    return this.launchWorker(goal);
  }

  async clear(sessionID: string): Promise<GoalState | undefined> {
    const goal = this.deps.store.getGoal(sessionID);
    if (!goal || (goal.status !== "active" && goal.status !== "paused")) return goal;
    await this.stopWorker(goal);
    const resolved: GoalState = {
      ...goal,
      status: "cleared",
      workerStatus: "stopped",
      updatedAt: Date.now(),
      completedAt: Date.now(),
      lastReason: "cleared by user",
    };
    this.deps.store.resolveGoal(resolved);
    return resolved;
  }

  async pause(sessionID: string): Promise<GoalState> {
    const goal = this.requireControllableGoal(sessionID);
    if (goal.status !== "active") throw new Error(`goal is ${goal.status}, not active`);
    if (goal.workerSessionID) {
      await Promise.resolve(
        this.deps.client.session.abort({
          path: { id: goal.workerSessionID },
          query: { directory: this.deps.directory },
        })
      ).catch(() => {});
    }
    const paused: GoalState = {
      ...goal,
      status: "paused",
      workerStatus: "idle",
      updatedAt: Date.now(),
      lastReason: "paused by user",
    };
    this.deps.store.updateGoal(paused);
    return paused;
  }

  async resume(sessionID: string): Promise<GoalState> {
    const goal = this.requireControllableGoal(sessionID);
    if (goal.status !== "paused") throw new Error(`goal is ${goal.status}, not paused`);
    const resumed: GoalState = {
      ...goal,
      status: "active",
      workerStatus: goal.workerSessionID ? "running" : "starting",
      updatedAt: Date.now(),
      completedAt: undefined,
      lastReason: "resumed by user",
    };
    this.deps.store.updateGoal(resumed);
    if (!resumed.workerSessionID) return this.launchWorker(resumed);
    await this.promptWorker(
      resumed,
      `Resume autonomous work toward the goal. Apply all durable steering and surface fresh evidence.\n\nGoal: ${resumed.condition}`
    );
    return this.deps.store.getGoal(sessionID) ?? resumed;
  }

  async steer(sessionID: string, message: string): Promise<GoalState> {
    const goal = this.requireControllableGoal(sessionID);
    const text = message.trim();
    if (!text) throw new Error("steering message must not be empty");
    if (text.length > 4000) throw new Error("steering message exceeds 4000 characters");
    const note = {
      text,
      createdAt: Date.now(),
      deliveredTo: goal.status === "active" && goal.workerSessionID ? [goal.workerSessionID] : [],
    };
    const steered: GoalState = {
      ...goal,
      steering: [...(goal.steering ?? []), note].slice(-20),
      updatedAt: Date.now(),
    };
    this.deps.store.updateGoal(steered);
    if (goal.status === "active" && goal.workerSessionID) {
      try {
        await this.promptWorker(
          steered,
          `Operator steering for the active goal. Apply this direction immediately and preserve it in future work:\n\n${text}\n\nGoal: ${goal.condition}`
        );
      } catch {
        // Persisted steering remains authoritative even if an in-flight
        // worker settled during delivery.
      }
    }
    return this.deps.store.getGoal(sessionID) ?? steered;
  }

  status(sessionID: string): string {
    const goal = this.deps.store.getGoal(sessionID);
    if (!goal) return "No goal set.";
    const elapsed = Math.max(0, (goal.completedAt ?? Date.now()) - goal.createdAt);
    const tokens =
      goal.observedTokens === undefined
        ? "unknown"
        : `${goal.observedTokens}/${goal.maxTokens}`;
    const lines = [
      `Goal ${goal.status}: ${goal.condition}`,
      `Worker: ${goal.workerStatus ?? "unknown"}${
        goal.workerSessionID ? ` (${goal.workerSessionID})` : ""
      }`,
      `Turns: ${goal.turns}/${goal.maxTurns}`,
      `Elapsed: ${Math.floor(elapsed / 1000)}s`,
      `Observed tokens: ${tokens}`,
      `Observed cost: ${
        goal.observedCost === undefined ? "unknown" : goal.observedCost
      }${goal.maxCost === undefined ? "" : `/${goal.maxCost}`}`,
    ];
    if (goal.evaluatorModel) {
      lines.push(
        `Evaluator: ${goal.evaluatorModel.providerID}/${goal.evaluatorModel.modelID}`
      );
    }
    if (goal.lastReason) lines.push(`Last verdict: ${goal.lastReason}`);
    if (goal.lastCompactedTokens !== undefined) {
      lines.push(`Last auto-compaction: ${goal.lastCompactedTokens} tokens`);
    }
    if ((goal.steering ?? []).length > 0) {
      lines.push(`Latest steering: ${goal.steering.at(-1)?.text}`);
    }
    return lines.join("\n");
  }

  async handleGoalCommand(
    sessionID: string,
    args: string
  ): Promise<{ prompt: string; status: string }> {
    const clean = args.trim();
    if (!clean) {
      const status = this.status(sessionID);
      return { prompt: `Report this Orch goal status exactly:\n\n${status}`, status };
    }
    if (CLEAR_ALIASES.has(clean.toLowerCase())) {
      const before = this.deps.store.getGoal(sessionID);
      await this.clear(sessionID);
      const status = before && ["active", "paused"].includes(before.status)
        ? `Goal cleared: ${before.condition}`
        : "No goal set.";
      return { prompt: `Report this result exactly:\n\n${status}`, status };
    }
    if (clean.toLowerCase() === "pause") {
      const goal = await this.pause(sessionID);
      const status = `Goal paused: ${goal.condition}`;
      return { prompt: `Report this result exactly:\n\n${status}`, status };
    }
    if (clean.toLowerCase() === "resume") {
      const goal = await this.resume(sessionID);
      const status = `Goal resumed: ${goal.condition}`;
      return { prompt: `Report this result exactly:\n\n${status}`, status };
    }
    if (clean.toLowerCase().startsWith("steer ")) {
      const goal = await this.steer(sessionID, clean.slice(6));
      const status = `Goal worker steered: ${goal.steering.at(-1)?.text}`;
      return { prompt: `Report this result exactly:\n\n${status}`, status };
    }
    const goal = await this.start(sessionID, clean);
    return {
      prompt:
        `Report that Orch accepted the goal and launched a dedicated worker. Stay in ` +
        `the lead conversation for status, steering, and control; do not duplicate the ` +
        `worker's implementation here.\n\nGoal: ${goal.condition}\nWorker: ${goal.workerSessionID}`,
      status: `Goal active in worker ${goal.workerSessionID}: ${goal.condition}`,
    };
  }

  isEvaluatorSession(sessionID: string): boolean {
    return this.evaluatorSessions.has(sessionID);
  }

  isWorkerSession(sessionID: string): boolean {
    return this.deps.store.listGoals().some(
      (goal) => goal.workerSessionID === sessionID && ["active", "paused"].includes(goal.status)
    );
  }

  async onSessionIdle(sessionID: string): Promise<void> {
    const goal = this.deps.store
      .listGoals()
      .find((candidate) => candidate.workerSessionID === sessionID);
    if (!goal || goal.status !== "active") return;
    if (this.evaluating.has(goal.sessionID) || this.evaluatorSessions.has(sessionID)) return;
    this.evaluating.add(goal.sessionID);
    try {
      await this.evaluate(goal);
    } catch (err) {
      const latest = this.deps.store.getGoal(goal.sessionID);
      if (latest?.status === "active") {
        this.deps.store.updateGoal({
          ...latest,
          status: "paused",
          workerStatus: "idle",
          updatedAt: Date.now(),
          lastReason: `evaluation deferred: ${
            err instanceof Error ? err.message : String(err)
          }`,
        });
      }
      this.deps.reporter.warn(
        "[orch]",
        `goal evaluation for ${sessionID} deferred: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    } finally {
      this.evaluating.delete(goal.sessionID);
    }
  }

  async onSessionError(sessionID: string, message: string): Promise<void> {
    const goal = this.deps.store
      .listGoals()
      .find((candidate) => candidate.workerSessionID === sessionID);
    if (!goal || goal.status !== "active") return;
    this.deps.store.updateGoal({
      ...goal,
      status: "paused",
      workerStatus: "idle",
      updatedAt: Date.now(),
      lastReason: `worker error: ${message}`,
    });
  }

  private requireControllableGoal(sessionID: string): GoalState {
    const goal = this.deps.store.getGoal(sessionID);
    if (!goal) throw new Error("No goal set.");
    if (goal.status !== "active" && goal.status !== "paused") {
      throw new Error(`goal is ${goal.status} and can no longer be controlled`);
    }
    return goal;
  }

  private async launchWorker(original: GoalState): Promise<GoalState> {
    const created = await this.deps.client.session.create({
      body: { title: `orch-goal/${original.sessionID}/worker` },
      query: { directory: this.deps.directory },
    });
    const workerSessionID = created.data?.id;
    if (!workerSessionID) throw new Error("failed to create goal worker session");
    const goal: GoalState = {
      ...original,
      workerSessionID,
      workerStatus: "running",
      updatedAt: Date.now(),
    };
    this.deps.store.updateGoal(goal);
    try {
      await this.promptWorker(
        goal,
        `You are the dedicated Orch worker for a lead conversation. Perform the substantive ` +
          `work autonomously in this session so the lead remains clear for operator status and ` +
          `steering. Use tools, verify the requested boundary, manage context with compact ` +
          `checkpoints, and report concrete evidence. Do not create or replace the goal.\n\n` +
          `Goal: ${goal.condition}`
      );
    } catch (err) {
      this.deps.store.updateGoal({
        ...goal,
        status: "paused",
        workerStatus: "idle",
        updatedAt: Date.now(),
        lastReason: `worker launch failed: ${err instanceof Error ? err.message : String(err)}`,
      });
      throw err;
    }
    return this.deps.store.getGoal(goal.sessionID) ?? goal;
  }

  private async promptWorker(goal: GoalState, text: string): Promise<void> {
    if (!goal.workerSessionID) throw new Error("goal worker session is not available");
    const steering = (goal.steering ?? []).slice(-10);
    const prompt =
      steering.length === 0
        ? text
        : `${text}\n\n## Durable operator steering\n${steering
            .map((note, index) => `${index + 1}. ${note.text}`)
            .join("\n")}`;
    this.deps.store.updateGoal({
      ...goal,
      workerStatus: "running",
      updatedAt: Date.now(),
    });
    await this.deps.client.session.promptAsync({
      path: { id: goal.workerSessionID },
      query: { directory: this.deps.directory },
      body: {
        ...(goal.workerModel ? { model: goal.workerModel } : {}),
        ...(goal.workerAgent ? { agent: goal.workerAgent } : { agent: "build" }),
        parts: [{ type: "text", text: prompt }],
      },
    });
  }

  private async stopWorker(goal: GoalState): Promise<void> {
    if (!goal.workerSessionID) return;
    await Promise.resolve(
      this.deps.client.session.abort({
        path: { id: goal.workerSessionID },
        query: { directory: this.deps.directory },
      })
    ).catch(() => {});
    await Promise.resolve(
      this.deps.client.session.delete({
        path: { id: goal.workerSessionID },
        query: { directory: this.deps.directory },
      })
    ).catch(() => {});
  }

  private async evaluate(original: GoalState): Promise<void> {
    if (!original.workerSessionID) throw new Error("goal has no worker session");
    const workerSessionID = original.workerSessionID;
    this.deps.store.updateGoal({
      ...original,
      workerStatus: "evaluating",
      updatedAt: Date.now(),
    });
    const response = await this.deps.client.session.messages({
      path: { id: workerSessionID },
      query: { directory: this.deps.directory, limit: 60 },
    });
    const messages = response.data ?? [];
    const usage = observedUsage(messages, original.accountedMessageIDs ?? []);
    const now = Date.now();
    const observedTokens =
      usage.tokens === undefined
        ? original.observedTokens
        : usage.incremental
          ? (original.observedTokens ?? 0) + usage.tokens
          : Math.max(original.observedTokens ?? 0, usage.tokens);
    const observedCost =
      usage.cost === undefined
        ? original.observedCost
        : usage.incremental
          ? (original.observedCost ?? 0) + usage.cost
          : Math.max(original.observedCost ?? 0, usage.cost);
    let goal: GoalState = {
      ...original,
      observedTokens,
      observedCost,
      accountedMessageIDs: usage.messageIDs,
      updatedAt: now,
    };

    const limitReason = this.limitReason(goal, now);
    if (limitReason) {
      goal = {
        ...goal,
        status: "budget_exhausted",
        workerStatus: "stopped",
        completedAt: now,
        lastReason: limitReason,
      };
      this.deps.store.resolveGoal(goal);
      return;
    }

    if (
      observedTokens !== undefined &&
      observedTokens >= goal.softTokens &&
      (goal.lastCompactedTokens === undefined || observedTokens > goal.lastCompactedTokens)
    ) {
      const model =
        this.deps.options.summarizerModel ??
        goal.evaluatorModel ??
        goal.workerModel;
      if (model && this.deps.client.session.summarize) {
        await this.deps.client.session.summarize({
          path: { id: workerSessionID },
          body: model,
          query: { directory: this.deps.directory },
        });
        goal = { ...goal, lastCompactedTokens: observedTokens, updatedAt: Date.now() };
        this.deps.store.updateGoal(goal);
      }
    }

    const evidence = boundedEvidence(messages, this.deps.options.evidenceChars);
    const evaluator = await this.deps.client.session.create({
      body: { title: `orch-goal/${goal.sessionID}/evaluate-${goal.turns + 1}` },
      query: { directory: this.deps.directory },
    });
    const evaluatorID = evaluator.data?.id;
    if (!evaluatorID) throw new Error("failed to create goal evaluator session");
    this.evaluatorSessions.add(evaluatorID);
    let verdict: z.infer<typeof Verdict>;
    try {
      const evaluated = await this.deps.client.session.prompt({
        path: { id: evaluatorID },
        query: { directory: this.deps.directory },
        body: {
          ...(goal.evaluatorModel ? { model: goal.evaluatorModel } : {}),
          tools: await this.disabledTools(),
          parts: [
            {
              type: "text",
              text:
                `Evaluate whether the goal is met using only the evidence below. ` +
                `Do not call tools and do not assume unreported facts. Reply with JSON only: ` +
                `{"verdict":"met|not_met|impossible","reason":"short evidence-based reason"}.\n\n` +
                `Goal:\n${goal.condition}\n\nEvidence:\n${evidence || "(none)"}`,
            },
          ],
        },
      });
      verdict = parseVerdict(textOf(evaluated.data));
    } finally {
      this.evaluatorSessions.delete(evaluatorID);
      void Promise.resolve(
        this.deps.client.session.delete({
          path: { id: evaluatorID },
          query: { directory: this.deps.directory },
        })
      ).catch(() => {});
    }

    const usedTools = latestAssistantUsedTools(messages);
    const current = this.deps.store.getGoal(goal.sessionID);
    if (!current || current.status !== "active") return;
    goal = {
      ...goal,
      steering: current.steering ?? goal.steering,
      turns: goal.turns + 1,
      noProgressTurns: usedTools ? 0 : goal.noProgressTurns + 1,
      lastVerdict: verdict.verdict,
      lastReason: verdict.reason,
      checkpoint: `Goal: ${goal.condition}\nVerdict: ${verdict.verdict}\nReason: ${verdict.reason}`,
      updatedAt: Date.now(),
    };

    if (verdict.verdict === "met" || verdict.verdict === "impossible") {
      this.deps.store.resolveGoal({
        ...goal,
        status: verdict.verdict === "met" ? "achieved" : "impossible",
        workerStatus: "stopped",
        completedAt: Date.now(),
      });
      return;
    }
    if (goal.noProgressTurns >= goal.noProgressLimit) {
      this.deps.store.resolveGoal({
        ...goal,
        status: "paused",
        workerStatus: "idle",
        lastReason: `paused after ${goal.noProgressTurns} turns without tool activity: ${verdict.reason}`,
      });
      return;
    }

    this.deps.store.updateGoal(goal);
    await this.promptWorker(
      goal,
      `Continue working autonomously toward the active goal. The independent ` +
        `evaluator said it is not yet met: ${verdict.reason}\n\n` +
        `Goal: ${goal.condition}\n\nUse tools and surface fresh concrete evidence.`
    );
  }

  private async disabledTools(): Promise<Record<string, boolean>> {
    try {
      const result = await this.deps.client.tool?.ids({
        query: { directory: this.deps.directory },
      });
      const ids = result?.data ?? [];
      if (ids.length > 0) return Object.fromEntries(ids.map((id) => [id, false]));
    } catch {
      // Fall through to the OpenCode wildcard understood by current servers.
    }
    return { "*": false };
  }

  private limitReason(goal: GoalState, now: number): string | undefined {
    if (goal.turns >= goal.maxTurns) return `turn budget exhausted (${goal.maxTurns})`;
    if (now - goal.createdAt >= goal.maxDurationMs) {
      return `time budget exhausted (${goal.maxDurationMs}ms)`;
    }
    if (goal.observedTokens !== undefined && goal.observedTokens >= goal.maxTokens) {
      return `token budget exhausted (${goal.observedTokens}/${goal.maxTokens})`;
    }
    if (
      goal.maxCost !== undefined &&
      goal.observedCost !== undefined &&
      goal.observedCost >= goal.maxCost
    ) {
      return `cost budget exhausted (${goal.observedCost}/${goal.maxCost})`;
    }
    return undefined;
  }
}

export function parseModelRef(providerID?: string, modelID?: string): ModelRef | undefined {
  if (providerID === undefined && modelID === undefined) return undefined;
  if (!providerID || !modelID) {
    throw new Error("both evaluatorProvider and evaluatorModel are required");
  }
  return { providerID, modelID };
}
