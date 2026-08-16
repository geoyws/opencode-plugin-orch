import { z } from "zod";
import { genID, Store } from "../state/store.js";
import { ModelRef, RunConfig, type Run, type StepState } from "../state/schemas.js";
import {
  renderTemplate,
  type StepDef,
  type WorkflowDef,
  type WorkflowRegistry,
} from "../workflows/index.js";
import { runShell } from "./exec.js";
import {
  addWorktree,
  collectChanges,
  copyBack,
  removeWorktree,
  worktreePath,
} from "./worktree.js";
import type { Reporter } from "./reporter.js";
import { tokenTotal } from "./usage.js";

// Structural client interface — the subset of the opencode SDK the runner
// uses. Declared structurally (instead of importing the SDK client type) so
// tests can drive the runner with a fake client.
export interface RunnerClient {
  session: {
    create(opts: {
      body: { title: string };
      query?: { directory?: string };
    }): Promise<{ data?: { id: string } }>;
    promptAsync(opts: {
      path: { id: string };
      body: {
        parts: Array<{ type: "text"; text: string }>;
        agent?: string;
        model?: { providerID: string; modelID: string };
      };
      query?: { directory?: string };
    }): Promise<unknown>;
    abort(opts: {
      path: { id: string };
      query?: { directory?: string };
    }): Promise<unknown>;
    delete(opts: {
      path: { id: string };
      query?: { directory?: string };
    }): Promise<unknown>;
    messages(opts: {
      path: { id: string };
      query?: { directory?: string };
    }): Promise<{
      data?: Array<{
        info: {
          role: string;
          time?: { completed?: number };
          cost?: number;
          tokens?: {
            total?: number;
            input?: number;
            output?: number;
            reasoning?: number;
            cache?: { read?: number; write?: number };
          };
        };
        parts: Array<{ type: string; text?: string }>;
      }>;
    }>;
  };
}

type MessagesData = NonNullable<
  Awaited<ReturnType<RunnerClient["session"]["messages"]>>["data"]
>;

// Optional overrides accepted by `orch_run`'s `config` JSON string.
export const RunConfigOverrides = z.object({
  model: ModelRef.optional(),
  maxIterations: z.number().int().min(1).optional(),
  concurrency: z.number().int().min(1).optional(),
  // Escape hatch for tests / very short tasks; default stays 10 minutes.
  stepTimeoutMs: z.number().int().min(1).optional(),
  isolation: z.enum(["worktree"]).optional(),
  gateCommand: z.string().min(1).optional(),
  stepModels: z.record(z.string(), ModelRef).optional(),
  maxStepOutputChars: z.number().int().min(1000).optional(),
  // Keep step sessions after they settle (debugging); default deletes them.
  keepSessions: z.boolean().optional(),
  // Max retries per LLM step for transient provider errors. 0 disables.
  stepRetries: z.number().int().min(0).max(3).optional(),
  maxTokens: z.number().int().positive().optional(),
  softTokens: z.number().int().positive().optional(),
  maxCost: z.number().positive().optional(),
  maxAgents: z.number().int().positive().optional(),
  maxDurationMs: z.number().int().positive().optional(),
  permissionMode: z.enum(["ask", "auto"]).optional(),
});
export type RunConfigOverrides = z.infer<typeof RunConfigOverrides>;

interface PendingStep {
  runID: string;
  stepID: string;
  timer: ReturnType<typeof setTimeout>;
  /** Worktree sessions only: 2s poll fallback for completion detection. */
  poll?: ReturnType<typeof setInterval>;
  /** Directory the step session runs in (project dir or its worktree). */
  directory: string;
  worktreePath?: string;
  /** Run config opt-out: skip session deletion on settle. */
  keepSessions: boolean;
  /** 1-based attempt counter and the attempt budget (1 + stepRetries). */
  attempt: number;
  maxAttempts: number;
  resolve: (output: string) => void;
  reject: (err: Error) => void;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Provider blips worth a bounded retry: rate limits, overloads, network
// errors. Anything else fails the step immediately.
const TRANSIENT_ERROR =
  /rate.?limit|429|overload|too many|temporar|timed? ?out|ECONN|ENET|network|fetch failed|502|503|504/i;

// Internal marker: the step's session died with a transient provider error
// and invokeStep may retry it as a fresh session. Never written to the store.
class TransientStepError extends Error {}
class BudgetExceededError extends Error {}

// Routing: first route key (insertion order) that appears as a standalone
// word in the classifier output wins, case-insensitive.
export function matchRoute(
  classifierOutput: string,
  routes: Record<string, string[]>
): string | undefined {
  for (const key of Object.keys(routes)) {
    if (new RegExp(`\\b${escapeRegExp(key)}\\b`, "i").test(classifierOutput)) {
      return key;
    }
  }
  return undefined;
}

// Orchestrator: extract the first JSON array in the planner output by
// scanning candidate "[ ... ]" spans until one parses to an array.
export function extractJsonArray(text: string): unknown[] {
  const start = text.indexOf("[");
  if (start === -1) throw new Error("planner output contains no JSON array");
  for (let end = text.indexOf("]", start); end !== -1; end = text.indexOf("]", end + 1)) {
    try {
      const parsed: unknown = JSON.parse(text.slice(start, end + 1));
      if (Array.isArray(parsed)) return parsed;
    } catch {
      // keep scanning for a later closing bracket
    }
  }
  throw new Error("planner output contains no valid JSON array");
}

/** A critic passes only with an explicit PASS-only response.
 * Some providers append a generated timestamp footer; accept that harmless
 * footer, but never treat prose merely containing the word PASS as approval.
 */
export function isPassVerdict(text: string): boolean {
  const withoutTimestamp = text.replace(
    /\n\s*_?\d{4}-\d{2}-\d{2}\s+\d{1,2}:\d{2}(?::\d{2})?(?:\s+[A-Z]{2,6})?_?\s*$/i,
    ""
  );
  return /^\s*PASS\s*$/i.test(withoutTimestamp);
}

// Last assistant message's concatenated text parts, or undefined when the
// session has no assistant message yet.
function extractLastAssistant(messages: MessagesData):
  | { output: string; usage?: NonNullable<StepState["usage"]> }
  | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].info.role === "assistant") {
      const output = messages[i].parts
        .filter((p) => p.type === "text")
        .map((p) => p.text ?? "")
        .join("");
      const tokens = messages[i].info.tokens;
      const cost = messages[i].info.cost;
      const usage =
        tokens || typeof cost === "number"
          ? {
              ...(tokens?.total === undefined ? {} : { total: tokens.total }),
              input: tokens?.input ?? 0,
              output: tokens?.output ?? 0,
              reasoning: tokens?.reasoning ?? 0,
              cacheRead: tokens?.cache?.read ?? 0,
              cacheWrite: tokens?.cache?.write ?? 0,
              ...(typeof cost === "number" ? { cost } : {}),
            }
          : undefined;
      return { output, usage };
    }
  }
  return undefined;
}

// Bounded concurrency map. Results preserve input order; the first rejection
// propagates (remaining in-flight work finishes in the background but its
// store writes are ignored once the run leaves `running`).
async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.max(1, Math.min(limit, items.length)) },
    async () => {
      while (next < items.length) {
        const i = next++;
        results[i] = await fn(items[i], i);
      }
    }
  );
  await Promise.all(workers);
  return results;
}

// The workflow engine. Each step invocation is one ephemeral opencode
// session: create → promptAsync → wait for the `session.idle` event (driven
// in via onSessionIdle) → read the last assistant message as the output.
// Worktree-isolated steps additionally poll `session.messages` every 2s as a
// completion fallback (a worktree is its own git project, so its opencode
// instance's events may not reach this one). Pattern runners are plain async
// functions awaiting per-step promises keyed by session id.
export class Runner {
  private pending = new Map<string, PendingStep>();
  // In-flight command (shell) steps, keyed `<runID>/<stepID>` — tracked so
  // cancel()/destroy() can kill their process group. LLM steps live in
  // `pending` instead.
  private commands = new Map<string, { runID: string; stepID: string; kill: () => void }>();
  // LLM steps waiting out the retry backoff (no live session), keyed
  // `<runID>/<stepID>` — tracked so cancel() can write their terminal
  // step event instead of leaving them `running` in the store.
  private retryBackoff = new Map<string, { runID: string; stepID: string }>();
  private pauseWaiters = new Map<string, Set<() => void>>();
  private activeRuns = new Set<string>();
  private destroyed = false;
  /** Backoff between step retries in ms (tests shrink it). */
  retryDelayMs = 5000;
  // runID → (relative file path → step id that last touched it). Used to
  // record copy-back conflicts between worktree steps of the same run.
  private touched = new Map<string, Map<string, string>>();

  constructor(
    private deps: {
      store: Store;
      workflows: WorkflowRegistry;
      client: RunnerClient;
      directory: string;
      reporter: Reporter;
    }
  ) {}

  // ── Run lifecycle ─────────────────────────────────────────────────
  async startRun(
    workflowName: string,
    input: string,
    overrides?: unknown
  ): Promise<Run> {
    const def = this.deps.workflows.require(workflowName);
    const o = RunConfigOverrides.parse(overrides ?? {});
    const config = RunConfig.parse({
      model: o.model,
      maxIterations: o.maxIterations ?? def.maxIterations ?? 3,
      concurrency: o.concurrency ?? 4,
      stepTimeoutMs: o.stepTimeoutMs ?? 600_000,
      // Run config wins over the workflow def when set on either.
      isolation: o.isolation ?? def.isolation,
      gateCommand: o.gateCommand ?? def.gate?.command,
      stepModels: o.stepModels,
      maxStepOutputChars: o.maxStepOutputChars ?? 50_000,
      keepSessions: o.keepSessions ?? false,
      stepRetries: o.stepRetries ?? 1,
      maxTokens: o.maxTokens,
      softTokens:
        o.softTokens === undefined
          ? o.maxTokens === undefined
            ? undefined
            : Math.floor(o.maxTokens * 0.75)
          : Math.min(o.softTokens, o.maxTokens ?? o.softTokens),
      maxCost: o.maxCost,
      maxAgents: o.maxAgents ?? 20,
      maxDurationMs: o.maxDurationMs,
      permissionMode: o.permissionMode ?? (this.deps.workflows.isCustom(workflowName) ? "ask" : "auto"),
    });

    const run: Run = {
      id: genID("run"),
      workflow: def.name,
      pattern: def.pattern,
      input,
      status: "running",
      config,
      plan: def,
      steps: {},
      steering: [],
      iteration: 0,
      createdAt: Date.now(),
    };
    this.deps.store.createRun(run);

    // Drive the pattern in the background; terminal state is written to the
    // store by execute(). Errors never escape.
    this.activeRuns.add(run.id);
    void this.execute(run.id, def, config);

    return run;
  }

  /**
   * Keep an initiating tool call attached until the run leaves `running`.
   * This is essential for one-shot `opencode run`: once the lead turn exits,
   * OpenCode disposes the process and aborts every background step session.
   * Persistent TUI callers can opt into detached execution instead.
   */
  async waitForSettled(runID: string, signal?: AbortSignal): Promise<Run> {
    for (;;) {
      const run = this.deps.store.getRun(runID);
      if (!run) throw new Error(`Run ${runID} not found`);
      if (run.status !== "running") return run;
      if (signal?.aborted) throw new Error(`Run ${runID} wait aborted`);
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(done, 50);
        const abort = () => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", abort);
          reject(new Error(`Run ${runID} wait aborted`));
        };
        function done() {
          signal?.removeEventListener("abort", abort);
          resolve();
        }
        signal?.addEventListener("abort", abort, { once: true });
      });
    }
  }

  async cancel(runID: string): Promise<void> {
    const run = this.deps.store.getRun(runID);
    if (!run) throw new Error(`Run ${runID} not found`);
    if (run.status !== "running" && run.status !== "paused") {
      throw new Error(`Run ${runID} is already ${run.status}`);
    }

    // Reject in-flight steps and abort their sessions (best-effort). Step
    // records are marked cancelled before the run so the store's
    // status-guard still accepts the step events.
    const aborts: Promise<unknown>[] = [];
    for (const [sessionID, entry] of [...this.pending.entries()]) {
      if (entry.runID !== runID) continue;
      this.pending.delete(sessionID);
      this.clearStepTimers(entry);
      const prev = this.stepRecord(runID, entry.stepID);
      if (prev) {
        this.deps.store.failStep(runID, {
          ...prev,
          status: "cancelled",
          error: "run cancelled",
          completedAt: Date.now(),
        });
      }
      const aborted = Promise.resolve(
        this.deps.client.session.abort({
          path: { id: sessionID },
          query: { directory: entry.directory },
        })
      ).catch(() => {});
      // Session no longer needed: delete it once the abort landed
      // (best-effort — a delete failure must never affect the run).
      aborts.push(
        entry.keepSessions
          ? aborted
          : aborted.then(() =>
              Promise.resolve(
                this.deps.client.session.delete({
                  path: { id: sessionID },
                  query: { directory: entry.directory },
                })
              ).catch(() => {})
            )
      );
      // Cancelled worktree steps: remove the worktree, no copy-back.
      if (entry.worktreePath) {
        aborts.push(removeWorktree(this.deps.directory, entry.worktreePath));
      }
      entry.reject(new Error("run cancelled"));
    }
    // Command (shell) steps have no session: kill their process group and
    // write the same terminal step event LLM steps get — otherwise they
    // keep executing after the cancel and stay `running` in the store.
    for (const [key, cmd] of [...this.commands.entries()]) {
      if (cmd.runID !== runID) continue;
      this.commands.delete(key);
      cmd.kill();
      const prev = this.stepRecord(runID, cmd.stepID);
      if (prev && prev.status === "running") {
        this.deps.store.failStep(runID, {
          ...prev,
          status: "cancelled",
          error: "run cancelled",
          completedAt: Date.now(),
        });
      }
    }
    // Steps waiting out the retry backoff have no live session either —
    // same terminal event, same reason.
    for (const [key, rb] of [...this.retryBackoff.entries()]) {
      if (rb.runID !== runID) continue;
      this.retryBackoff.delete(key);
      const prev = this.stepRecord(runID, rb.stepID);
      if (prev && prev.status === "running") {
        this.deps.store.failStep(runID, {
          ...prev,
          status: "cancelled",
          error: "run cancelled",
          completedAt: Date.now(),
        });
      }
    }
    this.deps.store.cancelRun(runID);
    this.wakePaused(runID);
    await Promise.all(aborts);
  }

  async steer(runID: string, message: string): Promise<number> {
    const run = this.deps.store.getRun(runID);
    if (!run) throw new Error(`Run ${runID} not found`);
    if (run.status !== "running" && run.status !== "paused") {
      throw new Error(`Run ${runID} is already ${run.status}`);
    }
    const text = message.trim();
    if (!text) throw new Error("steering message must not be empty");
    if (text.length > 4000) throw new Error("steering message exceeds 4000 characters");

    const deliveredTo: string[] = [];
    await Promise.all(
      [...this.pending.entries()]
        .filter(([, entry]) => entry.runID === runID)
        .map(async ([sessionID, entry]) => {
          try {
            await this.deps.client.session.promptAsync({
              path: { id: sessionID },
              query: { directory: entry.directory },
              body: {
                parts: [
                  {
                    type: "text",
                    text:
                      "Operator steering for the active workflow. Apply this direction now " +
                      `and in your final evidence:\n\n${text}`,
                  },
                ],
              },
            });
            deliveredTo.push(sessionID);
          } catch {
            // The session may have settled between discovery and delivery.
            // The persisted note still reaches every later LLM step.
          }
        })
    );
    this.deps.store.steerRun(runID, {
      text,
      createdAt: Date.now(),
      deliveredTo,
    });
    return deliveredTo.length;
  }

  pause(runID: string): void {
    const run = this.deps.store.getRun(runID);
    if (!run) throw new Error(`Run ${runID} not found`);
    if (run.status !== "running") throw new Error(`Run ${runID} is already ${run.status}`);
    this.deps.store.pauseRun(runID);
  }

  resume(runID: string): void {
    const run = this.deps.store.getRun(runID);
    if (!run) throw new Error(`Run ${runID} not found`);
    if (run.status !== "paused") throw new Error(`Run ${runID} is ${run.status}, not paused`);
    const active = this.activeRuns.has(runID);
    const def = active
      ? undefined
      : run.plan
        ? this.deps.workflows.validate(run.plan)
        : this.deps.workflows.require(run.workflow);
    this.deps.store.resumeRun(runID);
    if (active) {
      this.wakePaused(runID);
    } else {
      this.activeRuns.add(runID);
      void this.execute(runID, def!, run.config);
    }
  }

  async retry(runID: string): Promise<void> {
    const run = this.deps.store.getRun(runID);
    if (!run) throw new Error(`Run ${runID} not found`);
    if (run.status !== "failed" && run.status !== "cancelled") {
      throw new Error(`Run ${runID} is ${run.status}, not failed or cancelled`);
    }
    // A terminal event can precede execute()'s finally by a microtask. Wait a
    // bounded interval so an old execution cannot race the retried lifecycle.
    const deadline = Date.now() + 1000;
    while (this.activeRuns.has(runID) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    if (this.activeRuns.has(runID)) {
      throw new Error(`Run ${runID} is still settling; retry shortly`);
    }
    this.deps.workflows.require(run.workflow);
    this.deps.store.retryRun(runID);
    this.resume(runID);
  }

  /** Clear all pending step timers (plugin shutdown / dispose). */
  destroy(): void {
    this.destroyed = true;
    for (const entry of this.pending.values()) {
      this.clearStepTimers(entry);
      entry.reject(new Error("plugin shutting down"));
    }
    this.pending.clear();
    for (const cmd of this.commands.values()) cmd.kill();
    this.commands.clear();
    this.retryBackoff.clear();
    for (const runID of this.pauseWaiters.keys()) this.wakePaused(runID);
  }

  /** True while the given session belongs to an in-flight step. */
  isStepSession(sessionID: string): boolean {
    return this.pending.has(sessionID);
  }

  stepPermissionMode(sessionID: string): "ask" | "auto" | undefined {
    const entry = this.pending.get(sessionID);
    return entry
      ? this.deps.store.getRun(entry.runID)?.config.permissionMode
      : undefined;
  }

  // ── Event entry points (called from the `event` hook) ─────────────
  async onSessionIdle(sessionID: string): Promise<void> {
    const entry = this.pending.get(sessionID);
    if (!entry) return; // not a step session
    this.pending.delete(sessionID);
    this.clearStepTimers(entry);

    try {
      const res = await this.deps.client.session.messages({
        path: { id: sessionID },
        query: { directory: entry.directory },
      });
      const assistant = extractLastAssistant(res.data ?? []);
      if (assistant === undefined) {
        throw new Error(`step "${entry.stepID}" produced no assistant message`);
      }
      await this.settleStepSuccess(entry, assistant.output, assistant.usage);
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      await this.settleStepFailure(entry, e);
    } finally {
      // Output was already extracted above — the ephemeral session can go.
      this.deleteSession(sessionID, entry.directory, entry.keepSessions);
    }
  }

  async onSessionError(sessionID: string, message: string): Promise<void> {
    const entry = this.pending.get(sessionID);
    if (!entry) return;
    this.pending.delete(sessionID);
    this.clearStepTimers(entry);
    if (TRANSIENT_ERROR.test(message) && entry.attempt < entry.maxAttempts) {
      // Transient provider blip with retries left: tear down the errored
      // session (respecting keepSessions) and let invokeStep re-run the
      // step as a fresh session. The step record stays `running`.
      this.deleteSession(sessionID, entry.directory, entry.keepSessions);
      entry.reject(new TransientStepError(message));
      return;
    }
    try {
      const note = entry.attempt > 1 ? ` (after ${entry.attempt} attempts)` : "";
      await this.settleStepFailure(entry, new Error(message + note));
    } finally {
      this.deleteSession(sessionID, entry.directory, entry.keepSessions);
    }
  }

  // Best-effort teardown of step sessions orphaned by a restart. Store.init
  // recovers their runs as paused, but the old sessions may still be alive and
  // burning tokens. keepSessions does not apply to interrupted invocations.
  sweepInterruptedSessions(): void {
    for (const { sessionID } of this.deps.store.interruptedSessions) {
      void Promise.resolve(
        this.deps.client.session.abort({
          path: { id: sessionID },
          query: { directory: this.deps.directory },
        })
      )
        .catch(() => {})
        .then(() =>
          Promise.resolve(
            this.deps.client.session.delete({
              path: { id: sessionID },
              query: { directory: this.deps.directory },
            })
          ).catch(() => {})
        );
    }
  }

  // ── Pattern dispatch ──────────────────────────────────────────────
  private async execute(
    runID: string,
    def: WorkflowDef,
    config: RunConfig
  ): Promise<void> {
    try {
      let output: string;
      let note: string | undefined;
      switch (def.pattern) {
        case "chain":
          output = await this.runChain(runID, def, config);
          break;
        case "routing":
          output = await this.runRouting(runID, def, config);
          break;
        case "parallel":
          output = await this.runParallel(runID, def, config);
          break;
        case "orchestrator":
          output = await this.runOrchestrator(runID, def, config);
          break;
        case "evaluator": {
          const r = await this.runEvaluator(runID, def, config);
          output = r.output;
          note = r.note;
          break;
        }
      }
      this.deps.store.completeRun(runID, output, note);
      if (this.deps.store.getRun(runID)?.status === "completed") {
        this.deps.reporter.info("[orch]", `run ${runID} (${def.name}) completed`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Steps of a cancelled run reject after run_cancelled was written
      // (e.g. a killed command step) — don't clobber the terminal state
      // with a late run_failed event in the log.
      if (err instanceof BudgetExceededError) {
        const status = this.deps.store.getRun(runID)?.status;
        if (status === "running" || status === "paused") {
          this.deps.store.exhaustRunBudget(runID, msg);
        }
      } else if (this.deps.store.getRun(runID)?.status === "running") {
        this.deps.store.failRun(runID, msg);
      }
      if (this.deps.store.getRun(runID)?.status === "failed") {
        this.deps.reporter.error("[orch]", `run ${runID} (${def.name}) failed: ${msg}`);
      }
    } finally {
      this.touched.delete(runID);
      this.activeRuns.delete(runID);
    }
  }

  private async runChain(
    runID: string,
    def: WorkflowDef,
    config: RunConfig
  ): Promise<string> {
    let output = "";
    for (const step of def.steps) {
      const prompt = renderTemplate(step.instructions ?? "", {
        input: this.runInput(runID),
        output: this.cap(output, config, runID),
        steps: this.cappedStepOutputs(runID, config),
      });
      output = await this.invokeStep(runID, step, step.id, prompt, config);
    }
    return output;
  }

  private async runRouting(
    runID: string,
    def: WorkflowDef,
    config: RunConfig
  ): Promise<string> {
    const input = this.runInput(runID);
    const classifier = def.steps[0];
    const classification = await this.invokeStep(
      runID,
      classifier,
      classifier.id,
      renderTemplate(classifier.instructions ?? "", { input }),
      config
    );

    const routes = def.routes ?? {};
    const label = matchRoute(classification, routes);
    if (!label) {
      throw new Error(
        `classifier output matched no route (${Object.keys(routes).join(", ")}): ` +
          `"${classification.slice(0, 120)}"`
      );
    }

    let output = "";
    for (const stepID of routes[label]) {
      const step = def.steps.find((s) => s.id === stepID);
      if (!step) throw new Error(`route "${label}" references unknown step "${stepID}"`);
      output = await this.invokeStep(
        runID,
        step,
        step.id,
        renderTemplate(step.instructions ?? "", {
          input,
          output: this.cap(output, config, runID),
          steps: this.cappedStepOutputs(runID, config),
        }),
        config
      );
    }
    return output;
  }

  private async runParallel(
    runID: string,
    def: WorkflowDef,
    config: RunConfig
  ): Promise<string> {
    const input = this.runInput(runID);
    if (def.steps.length > config.maxAgents) {
      throw new Error(
        `parallel workflow has ${def.steps.length} workers; maxAgents is ${config.maxAgents}`
      );
    }
    const isolated = config.isolation === "worktree";
    await mapLimit(def.steps, config.concurrency, async (step) => {
      await this.invokeStep(
        runID,
        step,
        step.id,
        renderTemplate(step.instructions ?? "", { input }),
        config,
        undefined,
        { isolated }
      );
    });
    if (!def.aggregate) throw new Error("parallel workflow has no aggregate step");
    const prompt = renderTemplate(def.aggregate.instructions ?? "", {
      input,
      steps: this.cappedStepOutputs(runID, config),
    });
    return this.invokeStep(runID, def.aggregate, def.aggregate.id, prompt, config);
  }

  private async runOrchestrator(
    runID: string,
    def: WorkflowDef,
    config: RunConfig
  ): Promise<string> {
    const input = this.runInput(runID);
    const planner = def.steps[0];
    const plan = await this.invokeStep(
      runID,
      planner,
      planner.id,
      renderTemplate(planner.instructions ?? "", { input }),
      config
    );

    const rawTasks = extractJsonArray(plan);
    const tasks = rawTasks.map((t, i) => {
      const instructions = (t as { instructions?: unknown })?.instructions;
      if (typeof instructions !== "string" || instructions.length === 0) {
        throw new Error(`planner subtask #${i + 1} has no string "instructions"`);
      }
      return instructions;
    });
    if (tasks.length === 0) throw new Error("planner returned an empty subtask list");
    if (tasks.length > config.maxAgents) {
      throw new Error(
        `planner returned ${tasks.length} subtasks; maxAgents is ${config.maxAgents}`
      );
    }

    const isolated = config.isolation === "worktree";
    await mapLimit(tasks, config.concurrency, async (instructions, i) => {
      const stepID = `worker-${i + 1}`;
      const stepDef: StepDef = { id: stepID, instructions };
      await this.invokeStep(
        runID,
        stepDef,
        stepID,
        renderTemplate(instructions, { input }),
        config,
        undefined,
        { isolated }
      );
    });

    if (!def.aggregate) throw new Error("orchestrator workflow has no aggregate step");
    const outputs = this.cappedStepOutputs(runID, config);
    // Worker ids are dynamic (worker-1..N), so their outputs can't be named
    // in the aggregate template — append them as a results section.
    const results = tasks
      .map((_, i) => {
        const id = `worker-${i + 1}`;
        return `\n\n## Result of ${id}\n${outputs[id]?.output ?? ""}`;
      })
      .join("");
    const prompt =
      renderTemplate(def.aggregate.instructions ?? "", { input, steps: outputs }) + results;
    return this.invokeStep(runID, def.aggregate, def.aggregate.id, prompt, config);
  }

  private async runEvaluator(
    runID: string,
    def: WorkflowDef,
    config: RunConfig
  ): Promise<{ output: string; note?: string }> {
    const input = this.runInput(runID);
    const generator = def.steps[0];
    const critic = def.steps[1]; // optional when a gate is configured
    const gate = config.gateCommand;
    const max = config.maxIterations;

    let feedback = "";
    let output = "";
    for (let iter = 1; iter <= max; iter++) {
      // Later iterations get suffixed step ids so each loop is its own record.
      const genStepID = iter === 1 ? generator.id : `${generator.id}#${iter}`;

      output = await this.invokeStep(
        runID,
        generator,
        genStepID,
        renderTemplate(generator.instructions ?? "", {
          input,
          feedback: this.cap(feedback, config, runID),
        }),
        config,
        iter
      );

      // Programmatic gate: runs in the project dir, exit 0 = pass. On
      // failure the last ~4000 chars of its output become the feedback.
      let gatePassed = true;
      let gateFeedback = "";
      if (gate) {
        const res = await runShell(gate, this.deps.directory, config.stepTimeoutMs).done;
        gatePassed = res.code === 0;
        this.deps.reporter.info(
          "[orch]",
          `run ${runID} gate ${gatePassed ? "passed" : `failed (exit ${res.code})`} · iteration ${iter}/${max}`
        );
        if (!gatePassed) gateFeedback = res.output.slice(-4000);
      }

      // Critic (optional): passes by emitting the standalone token PASS.
      let criticPassed = true;
      let critique = "";
      if (critic) {
        const evalStepID = iter === 1 ? critic.id : `${critic.id}#${iter}`;
        critique = await this.invokeStep(
          runID,
          critic,
          evalStepID,
          renderTemplate(critic.instructions ?? "", {
            input,
            output: this.cap(output, config, runID),
          }),
          config,
          iter
        );
        criticPassed = isPassVerdict(critique);
      }

      // With both a gate and a critic, both must pass to end the loop.
      if (gatePassed && criticPassed) return { output };
      feedback = [criticPassed ? "" : critique, gateFeedback]
        .filter((s) => s.length > 0)
        .join("\n\n");
    }
    return {
      output,
      note: `iteration budget exhausted (${max} iterations without PASS)`,
    };
  }

  // ── Step invocation ───────────────────────────────────────────────
  private async invokeStep(
    runID: string,
    stepDef: StepDef,
    stepID: string,
    prompt: string,
    config: RunConfig,
    iteration?: number,
    opts?: { isolated?: boolean }
  ): Promise<string> {
    await this.waitUntilRunnable(runID);
    const run = this.deps.store.getRun(runID);
    if (!run || run.status !== "running") {
      throw new Error(`run ${runID} is no longer running (${run?.status ?? "not found"})`);
    }
    const previous = this.stepRecord(runID, stepID);
    if (previous?.status === "completed" && previous.output !== undefined) {
      return previous.output;
    }
    this.assertWithinBudget(runID, config);

    // Worktree isolation (parallel/orchestrator fan-out steps only). Any
    // failure of `git worktree add` (not a repo, no commits) falls back to
    // running in the main directory — never fails the run.
    let directory = this.deps.directory;
    let wtPath: string | undefined;
    let isolationFallback = false;
    if (opts?.isolated) {
      const candidate = worktreePath(this.deps.directory, runID, stepID);
      try {
        await addWorktree(this.deps.directory, candidate);
        wtPath = candidate;
        directory = candidate;
      } catch {
        isolationFallback = true;
      }
    }

    // Shell step: no LLM session, combined stdout+stderr is the output.
    if (stepDef.command !== undefined) {
      return this.invokeCommandStep(
        runID,
        stepID,
        stepDef.command,
        directory,
        wtPath,
        isolationFallback,
        config,
        iteration
      );
    }

    // LLM step: bounded retries for transient provider errors (session.error
    // matching TRANSIENT_ERROR). Each attempt is a fresh session with the
    // same instructions/model/agent; the step record stays `running`.
    const maxAttempts = 1 + config.stepRetries;
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.invokeSessionAttempt(
          runID,
          stepDef,
          stepID,
          prompt,
          config,
          iteration,
          directory,
          wtPath,
          isolationFallback,
          attempt,
          maxAttempts
        );
      } catch (err) {
        if (!(err instanceof TransientStepError) || attempt >= maxAttempts) throw err;
        // Cancelled / shut down while the previous attempt died: no retry.
        const runNow = this.deps.store.getRun(runID);
        if (this.destroyed || !runNow || !["running", "paused"].includes(runNow.status)) throw err;
        // Back off (unref'd — never holds the process open), tracked so
        // cancel() can write the terminal step event in this window.
        const key = `${runID}/${stepID}`;
        this.retryBackoff.set(key, { runID, stepID });
        try {
          await new Promise((r) => {
            const t = setTimeout(r, this.retryDelayMs);
            if (typeof t.unref === "function") t.unref();
          });
        } finally {
          this.retryBackoff.delete(key);
        }
      }
    }
  }

  // One LLM-step attempt: create a session, start the step record, prompt,
  // and await completion (settled via onSessionIdle / onSessionError / the
  // worktree poll fallback / the per-step timeout / cancel()).
  private async invokeSessionAttempt(
    runID: string,
    stepDef: StepDef,
    stepID: string,
    prompt: string,
    config: RunConfig,
    iteration: number | undefined,
    directory: string,
    wtPath: string | undefined,
    isolationFallback: boolean,
    attempt: number,
    maxAttempts: number
  ): Promise<string> {
    await this.waitUntilRunnable(runID);
    const run = this.deps.store.getRun(runID);
    if (!run || run.status !== "running") {
      throw new Error(`run ${runID} is no longer running (${run?.status ?? "not found"})`);
    }

    const created = await this.deps.client.session.create({
      body: { title: `orch/${runID}/${stepID}` },
      query: { directory },
    });
    const sessionID = created.data?.id;
    if (!sessionID) {
      if (wtPath) await removeWorktree(this.deps.directory, wtPath);
      throw new Error(`session.create returned no session id for step "${stepID}"`);
    }

    this.deps.store.startStep(
      runID,
      {
        id: stepID,
        status: "running",
        sessionID,
        startedAt: Date.now(),
        ...(isolationFallback ? { isolationFallback: true } : {}),
        // Attempt counter rides the step_started event (survives replay).
        ...(attempt > 1 ? { attempts: attempt } : {}),
      },
      iteration
    );

    // The completion promise settles from onSessionIdle / onSessionError /
    // the worktree poll fallback / the per-step timeout / cancel().
    const completion = new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        const e = this.pending.get(sessionID);
        if (!e) return;
        this.pending.delete(sessionID);
        this.clearStepTimers(e);
        const msg = `step "${stepID}" timed out after ${Math.round(
          config.stepTimeoutMs / 1000
        )}s`;
        Promise.resolve(
          this.deps.client.session.abort({
            path: { id: sessionID },
            query: { directory: e.directory },
          })
        ).catch(() => {});
        if (e.worktreePath) void removeWorktree(this.deps.directory, e.worktreePath);
        this.failStep(runID, stepID, msg);
        this.deleteSession(sessionID, e.directory, e.keepSessions);
        reject(new Error(msg));
      }, config.stepTimeoutMs);
      // Unref so a stuck step never keeps the opencode process alive.
      if (typeof timer.unref === "function") timer.unref();
      this.pending.set(sessionID, {
        runID,
        stepID,
        timer,
        directory,
        worktreePath: wtPath,
        keepSessions: config.keepSessions,
        attempt,
        maxAttempts,
        resolve,
        reject,
      });
    });
    // Defensive: cancel()/timeout can reject the completion while promptAsync
    // is still in flight and nothing awaits it yet. Awaiters still see the
    // rejection — this only marks it observed for the runtime.
    completion.catch(() => {});

    // Worktree sessions: poll for completion every 2s (unref'd). Events from
    // the worktree's own opencode instance may not reach this one.
    if (wtPath) {
      const poll = setInterval(() => {
        void this.pollWorktreeStep(sessionID);
      }, 2000);
      if (typeof poll.unref === "function") poll.unref();
      const e = this.pending.get(sessionID);
      if (e) e.poll = poll;
      else clearInterval(poll);
    }

    try {
      // Model resolution: stepModels[step.id] ?? step.model ?? config.model
      // ?? server default.
      const model = config.stepModels?.[stepDef.id] ?? stepDef.model ?? config.model;
      const currentRun = this.deps.store.getRun(runID);
      const steering = (currentRun?.steering ?? []).slice(-10);
      const steeredPrompt =
        steering.length === 0
          ? prompt
          : `${prompt}\n\n## Durable operator steering\n${steering
              .map((note, index) => `${index + 1}. ${note.text}`)
              .join("\n")}`;
      await this.deps.client.session.promptAsync({
        path: { id: sessionID },
        body: {
          parts: [{ type: "text", text: steeredPrompt }],
          agent: stepDef.agent ?? "build",
          ...(model ? { model } : {}),
        },
        query: { directory },
      });
    } catch (err) {
      const entry = this.pending.get(sessionID);
      if (entry) {
        this.clearStepTimers(entry);
        this.pending.delete(sessionID);
      }
      if (wtPath) await removeWorktree(this.deps.directory, wtPath);
      const e = err instanceof Error ? err : new Error(String(err));
      this.failStep(runID, stepID, e.message);
      // The session was created but never prompted — delete it too.
      this.deleteSession(sessionID, directory, config.keepSessions);
      throw e;
    }

    return completion;
  }

  // Shell steps (`command`): run in the project dir (or the step's
  // worktree), share the step timeout, fail on non-zero exit.
  private async invokeCommandStep(
    runID: string,
    stepID: string,
    command: string,
    directory: string,
    wtPath: string | undefined,
    isolationFallback: boolean,
    config: RunConfig,
    iteration?: number
  ): Promise<string> {
    this.deps.store.startStep(
      runID,
      {
        id: stepID,
        status: "running",
        startedAt: Date.now(),
        ...(isolationFallback ? { isolationFallback: true } : {}),
      },
      iteration
    );

    // Tracked so cancel()/destroy() can kill the process group mid-run.
    const key = `${runID}/${stepID}`;
    const shell = runShell(command, directory, config.stepTimeoutMs);
    this.commands.set(key, { runID, stepID, kill: shell.kill });
    const res = await shell.done.finally(() => {
      // Only clear our own entry — cancel() may have removed it already.
      if (this.commands.get(key)?.kill === shell.kill) this.commands.delete(key);
    });
    if (res.code !== 0) {
      if (wtPath) await removeWorktree(this.deps.directory, wtPath);
      const tail = res.output.slice(-2000).trim();
      const msg = `command exited ${res.code}${tail ? `: ${tail}` : ""}`;
      this.failStep(runID, stepID, msg);
      throw new Error(`step "${stepID}" ${msg}`);
    }

    let extra: Partial<StepState> = {};
    if (wtPath) {
      try {
        extra = await this.finalizeWorktree(runID, stepID, wtPath);
      } catch (err) {
        const e = err instanceof Error ? err : new Error(String(err));
        this.failStep(runID, stepID, e.message);
        throw e;
      }
    }

    const prev = this.stepRecord(runID, stepID);
    if (prev) {
      this.deps.store.completeStep(runID, {
        ...prev,
        status: "completed",
        output: res.output,
        completedAt: Date.now(),
        ...extra,
      });
    }
    return res.output;
  }

  // Poll fallback for worktree sessions: the step is complete when the
  // newest assistant message has `time.completed` set.
  private async pollWorktreeStep(sessionID: string): Promise<void> {
    const entry = this.pending.get(sessionID);
    if (!entry) return;

    let messages: MessagesData;
    try {
      const res = await this.deps.client.session.messages({
        path: { id: sessionID },
        query: { directory: entry.directory },
      });
      messages = res.data ?? [];
    } catch {
      return; // transient poll failure — try again on the next tick
    }

    let completed = false;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].info.role === "assistant") {
        completed = messages[i].info.time?.completed !== undefined;
        break;
      }
    }
    if (!completed) return;

    if (this.pending.get(sessionID) !== entry) return;
    this.pending.delete(sessionID);
    this.clearStepTimers(entry);
    try {
      const assistant = extractLastAssistant(messages);
      if (assistant === undefined) {
        throw new Error(`step "${entry.stepID}" produced no assistant message`);
      }
      await this.settleStepSuccess(entry, assistant.output, assistant.usage);
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      await this.settleStepFailure(entry, e);
    } finally {
      this.deleteSession(sessionID, entry.directory, entry.keepSessions);
    }
  }

  // Shared success path: copy back worktree changes (if any), write the
  // completed step record, resolve the step promise.
  private async settleStepSuccess(
    entry: PendingStep,
    output: string,
    usage?: NonNullable<StepState["usage"]>
  ): Promise<void> {
    let extra: Partial<StepState> = {};
    if (entry.worktreePath) {
      extra = await this.finalizeWorktree(entry.runID, entry.stepID, entry.worktreePath);
    }
    const prev = this.stepRecord(entry.runID, entry.stepID);
    if (prev) {
      this.deps.store.completeStep(entry.runID, {
        ...prev,
        status: "completed",
        output,
        summary: this.compactCheckpoint(output),
        ...(usage ? { usage } : {}),
        completedAt: Date.now(),
        ...extra,
      });
    }
    entry.resolve(output);
  }

  // Shared failure path: remove the worktree (no copy-back), fail the step
  // record, reject the step promise.
  private async settleStepFailure(entry: PendingStep, err: Error): Promise<void> {
    if (entry.worktreePath) {
      await removeWorktree(this.deps.directory, entry.worktreePath);
    }
    this.failStep(entry.runID, entry.stepID, err.message);
    entry.reject(err);
  }

  // Copy a finished worktree step's changes into the project dir, record
  // cross-step conflicts (last finisher wins), then remove the worktree.
  private async finalizeWorktree(
    runID: string,
    stepID: string,
    wtPath: string
  ): Promise<Partial<StepState>> {
    try {
      const changes = await collectChanges(wtPath);
      const conflicts = this.recordTouched(runID, stepID, [
        ...changes.upserts,
        ...changes.deletes,
      ]);
      const copiedFiles = await copyBack(wtPath, this.deps.directory, changes);
      return {
        copiedFiles,
        ...(conflicts.length > 0 ? { conflicts } : {}),
        ...(changes.skippedSymlinks.length > 0
          ? { skippedSymlinks: changes.skippedSymlinks }
          : {}),
      };
    } finally {
      await removeWorktree(this.deps.directory, wtPath);
    }
  }

  private recordTouched(runID: string, stepID: string, files: string[]): string[] {
    let map = this.touched.get(runID);
    if (!map) {
      map = new Map();
      this.touched.set(runID, map);
    }
    const conflicts: string[] = [];
    for (const f of files) {
      const owner = map.get(f);
      if (owner !== undefined && owner !== stepID) conflicts.push(f);
      map.set(f, stepID);
    }
    return conflicts;
  }

  // ── Helpers ───────────────────────────────────────────────────────
  private clearStepTimers(entry: PendingStep): void {
    clearTimeout(entry.timer);
    if (entry.poll) clearInterval(entry.poll);
  }

  // Best-effort session teardown after a step settles: step sessions are
  // ephemeral and their output was already extracted. Fire-and-forget — a
  // delete failure must never affect the run. Skipped when the run opts into
  // keepSessions (debugging). Command steps have no session and never get
  // here.
  private deleteSession(sessionID: string, directory: string, keep: boolean): void {
    if (keep) return;
    void Promise.resolve(
      this.deps.client.session.delete({
        path: { id: sessionID },
        query: { directory },
      })
    ).catch(() => {});
  }

  // Output cap: full outputs stay in the store; only text injected into
  // subsequent prompts is deterministically compacted. Head + tail retains
  // decisions and final receipts better than a head-only truncation.
  private cap(text: string, config: RunConfig, runID?: string): string {
    if (
      runID &&
      config.softTokens !== undefined &&
      (this.aggregateUsage(runID) ?? -1) >= config.softTokens
    ) {
      return this.compactCheckpoint(text);
    }
    const max = config.maxStepOutputChars;
    if (text.length <= max) return text;
    const half = Math.max(1, Math.floor((max - 80) / 2));
    return `${text.slice(0, half)}\n[... compacted ${text.length - half * 2} chars ...]\n${text.slice(-half)}`;
  }

  private cappedStepOutputs(
    runID: string,
    config: RunConfig
  ): Record<string, { output?: string }> {
    const steps = this.stepOutputs(runID);
    const out: Record<string, { output?: string }> = {};
    for (const [id, s] of Object.entries(steps)) {
      const aggregate = this.aggregateUsage(runID);
      const compact =
        config.softTokens !== undefined &&
        aggregate !== undefined &&
        aggregate >= config.softTokens;
      out[id] = {
        output:
          s.output === undefined
            ? undefined
            : compact && s.summary
              ? s.summary
              : this.cap(s.output, config),
      };
    }
    return out;
  }

  private runInput(runID: string): string {
    return this.deps.store.getRun(runID)?.input ?? "";
  }

  private stepRecord(runID: string, stepID: string): StepState | undefined {
    return this.deps.store.getRun(runID)?.steps[stepID];
  }

  private stepOutputs(runID: string): Record<string, StepState> {
    return this.deps.store.getRun(runID)?.steps ?? {};
  }

  private failStep(runID: string, stepID: string, error: string): void {
    const prev = this.stepRecord(runID, stepID);
    if (!prev || prev.status !== "running") return;
    this.deps.store.failStep(runID, {
      ...prev,
      status: "failed",
      error,
      completedAt: Date.now(),
    });
  }

  private compactCheckpoint(text: string): string {
    const max = 4000;
    if (text.length <= max) return text;
    const half = Math.floor((max - 80) / 2);
    return `${text.slice(0, half)}\n[... checkpoint compacted ${text.length - half * 2} chars ...]\n${text.slice(-half)}`;
  }

  private aggregateUsage(runID: string): number | undefined {
    const steps = Object.values(this.deps.store.getRun(runID)?.steps ?? {});
    let known = false;
    let total = 0;
    for (const step of steps) {
      if (!step.usage) continue;
      known = true;
      total += tokenTotal(step.usage);
    }
    return known ? total : undefined;
  }

  private assertWithinBudget(runID: string, config: RunConfig): void {
    const run = this.deps.store.getRun(runID);
    if (
      config.maxDurationMs !== undefined &&
      run &&
      Date.now() - run.createdAt >= config.maxDurationMs
    ) {
      throw new BudgetExceededError(
        `time budget exhausted (${Date.now() - run.createdAt}/${config.maxDurationMs}ms); no new step started`
      );
    }
    const used = this.aggregateUsage(runID);
    if (config.maxTokens !== undefined && used !== undefined && used >= config.maxTokens) {
      throw new BudgetExceededError(
        `token budget exhausted (${used}/${config.maxTokens}); no new step started`
      );
    }
    const cost = this.aggregateCost(runID);
    if (config.maxCost !== undefined && cost !== undefined && cost >= config.maxCost) {
      throw new BudgetExceededError(
        `cost budget exhausted (${cost}/${config.maxCost}); no new step started`
      );
    }
  }

  private aggregateCost(runID: string): number | undefined {
    const costs = Object.values(this.deps.store.getRun(runID)?.steps ?? {})
      .map((step) => step.usage?.cost)
      .filter((cost): cost is number => cost !== undefined);
    return costs.length > 0 ? costs.reduce((sum, cost) => sum + cost, 0) : undefined;
  }

  private async waitUntilRunnable(runID: string): Promise<void> {
    for (;;) {
      if (this.destroyed) throw new Error("plugin shutting down");
      const run = this.deps.store.getRun(runID);
      if (!run) throw new Error(`run ${runID} not found`);
      if (run.status === "running") return;
      if (run.status !== "paused") {
        throw new Error(`run ${runID} is no longer runnable (${run.status})`);
      }
      await new Promise<void>((resolve) => {
        let waiters = this.pauseWaiters.get(runID);
        if (!waiters) {
          waiters = new Set();
          this.pauseWaiters.set(runID, waiters);
        }
        waiters.add(resolve);
      });
    }
  }

  private wakePaused(runID: string): void {
    const waiters = this.pauseWaiters.get(runID);
    if (!waiters) return;
    this.pauseWaiters.delete(runID);
    for (const resolve of waiters) resolve();
  }
}
