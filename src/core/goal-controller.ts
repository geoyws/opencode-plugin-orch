import { z } from "zod";
import type { GoalState, ModelRef } from "../state/schemas.js";
import type { Store } from "../state/store.js";
import type { Reporter } from "./reporter.js";

type MessageRecord = {
  info: {
    id?: string;
    role: string;
    cost?: number;
    tokens?: {
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
      tokens +=
        (usage.input ?? 0) +
        (usage.output ?? 0) +
        (usage.reasoning ?? 0) +
        (usage.cache?.write ?? 0);
      // Cache reads are observed but do not represent newly generated context.
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

  set(sessionID: string, condition: string, options: GoalSetOptions = {}): GoalState {
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
      accountedMessageIDs: [],
    };
    this.deps.store.setGoal(goal);
    return goal;
  }

  clear(sessionID: string): GoalState | undefined {
    const goal = this.deps.store.getGoal(sessionID);
    if (!goal || goal.status !== "active") return goal;
    const resolved: GoalState = {
      ...goal,
      status: "cleared",
      updatedAt: Date.now(),
      completedAt: Date.now(),
      lastReason: "cleared by user",
    };
    this.deps.store.resolveGoal(resolved);
    return resolved;
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
    return lines.join("\n");
  }

  handleGoalCommand(
    sessionID: string,
    args: string
  ): { prompt: string; status: string } {
    const clean = args.trim();
    if (!clean) {
      const status = this.status(sessionID);
      return { prompt: `Report this Orch goal status exactly:\n\n${status}`, status };
    }
    if (CLEAR_ALIASES.has(clean.toLowerCase())) {
      const before = this.deps.store.getGoal(sessionID);
      this.clear(sessionID);
      const status = before?.status === "active" ? `Goal cleared: ${before.condition}` : "No goal set.";
      return { prompt: `Report this result exactly:\n\n${status}`, status };
    }
    const goal = this.set(sessionID, clean);
    return {
      prompt:
        `Work autonomously toward this active Orch goal now. Surface concrete evidence ` +
        `for the independent evaluator at the end of the turn. Do not claim success ` +
        `without observing the requested boundary.\n\nGoal: ${goal.condition}`,
      status: `Goal active: ${goal.condition}`,
    };
  }

  isEvaluatorSession(sessionID: string): boolean {
    return this.evaluatorSessions.has(sessionID);
  }

  async onSessionIdle(sessionID: string): Promise<void> {
    const goal = this.deps.store.getGoal(sessionID);
    if (!goal || goal.status !== "active") return;
    if (this.evaluating.has(sessionID) || this.evaluatorSessions.has(sessionID)) return;
    this.evaluating.add(sessionID);
    try {
      await this.evaluate(goal);
    } catch (err) {
      this.deps.reporter.warn(
        "[orch]",
        `goal evaluation for ${sessionID} deferred: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    } finally {
      this.evaluating.delete(sessionID);
    }
  }

  private async evaluate(original: GoalState): Promise<void> {
    const response = await this.deps.client.session.messages({
      path: { id: original.sessionID },
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
          path: { id: goal.sessionID },
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
    goal = {
      ...goal,
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
        completedAt: Date.now(),
      });
      return;
    }
    if (goal.noProgressTurns >= goal.noProgressLimit) {
      this.deps.store.resolveGoal({
        ...goal,
        status: "paused",
        lastReason: `paused after ${goal.noProgressTurns} turns without tool activity: ${verdict.reason}`,
      });
      return;
    }

    this.deps.store.updateGoal(goal);
    await this.deps.client.session.promptAsync({
      path: { id: goal.sessionID },
      query: { directory: this.deps.directory },
      body: {
        ...(goal.workerModel ? { model: goal.workerModel } : {}),
        ...(goal.workerAgent ? { agent: goal.workerAgent } : {}),
        parts: [
          {
            type: "text",
            text:
              `Continue working autonomously toward the active goal. The independent ` +
              `evaluator said it is not yet met: ${verdict.reason}\n\n` +
              `Goal: ${goal.condition}\n\nUse tools and surface fresh concrete evidence.`,
          },
        ],
      },
    });
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
