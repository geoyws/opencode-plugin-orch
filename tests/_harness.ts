// Shared fake-client harness for the orch test suites.
//
// The Runner only needs a structural subset of the opencode SDK client
// (RunnerClient), so the fake below records session.create / promptAsync /
// abort / delete calls and serves canned assistant messages from
// `session.messages`.
// Tests drive step completion by setting an output for a session and then
// calling `runner.onSessionIdle(sessionID)` (or `onSessionError`).

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Store } from "../src/state/store.js";
import { Runner, type RunnerClient } from "../src/core/runner.js";
import { WorkflowRegistry } from "../src/workflows/index.js";
import type { Reporter } from "../src/core/reporter.js";
import { GoalController, type GoalClient } from "../src/core/goal-controller.js";

export interface PromptRecord {
  sessionID: string;
  /** Step id parsed from the session title `orch/<run-id>/<step-id>`. */
  stepID: string;
  title: string;
  text: string;
  agent?: string;
  model?: { providerID: string; modelID: string };
}

export class FakeClient {
  prompts: PromptRecord[] = [];
  aborts: string[] = [];
  deletes: string[] = [];
  /** Ordered cross-call log (`messages:<id>` / `delete:<id>`) for ordering assertions. */
  calls: string[] = [];
  /** When true, session.delete rejects (teardown failures must be swallowed). */
  failDeletes = false;
  /** Currently unanswered promptAsync calls (test-maintained). */
  inflight = 0;
  maxInflight = 0;
  private sessionCounter = 0;
  private titles = new Map<string, string>();
  private outputs = new Map<
    string,
    {
      text: string;
      completed: boolean;
      usage?: { input?: number; output?: number; reasoning?: number; cacheWrite?: number };
    }
  >();

  session: RunnerClient["session"] = {
    create: async ({ body }) => {
      const id = `sess_${(++this.sessionCounter).toString(36)}`;
      this.titles.set(id, body.title);
      return { data: { id } };
    },
    promptAsync: async (opts) => {
      this.inflight++;
      if (this.inflight > this.maxInflight) this.maxInflight = this.inflight;
      const title = this.titles.get(opts.path.id) ?? "";
      this.prompts.push({
        sessionID: opts.path.id,
        stepID: title.split("/").pop() ?? "",
        title,
        text: opts.body.parts.map((p) => p.text).join(""),
        agent: opts.body.agent,
        model: opts.body.model,
      });
      return {};
    },
    abort: async (opts) => {
      this.aborts.push(opts.path.id);
      return {};
    },
    delete: async (opts) => {
      this.calls.push(`delete:${opts.path.id}`);
      this.deletes.push(opts.path.id);
      if (this.failDeletes) throw new Error("delete failed");
      return {};
    },
    messages: async (opts) => {
      this.calls.push(`messages:${opts.path.id}`);
      const out = this.outputs.get(opts.path.id);
      if (out === undefined) return { data: [] };
      return {
        data: [
          { info: { role: "user" }, parts: [{ type: "text", text: "prompt" }] },
          {
            // `time.completed` drives the worktree poll fallback.
            info: {
              role: "assistant",
              ...(out.completed ? { time: { completed: Date.now() } } : {}),
              ...(out.usage
                ? {
                    tokens: {
                      input: out.usage.input,
                      output: out.usage.output,
                      reasoning: out.usage.reasoning,
                      cache: { write: out.usage.cacheWrite },
                    },
                  }
                : {}),
            },
            parts: [{ type: "text", text: out.text }],
          },
        ],
      };
    },
  };

  // Reporter sinks (used by plugin.test.ts, harmless elsewhere).
  tui = { showToast: (_params: unknown) => Promise.resolve({}) };
  app = { log: (_params: unknown) => Promise.resolve({}) };

  setOutput(
    sessionID: string,
    text: string,
    opts?: {
      completed?: boolean;
      usage?: { input?: number; output?: number; reasoning?: number; cacheWrite?: number };
    }
  ): void {
    this.outputs.set(sessionID, {
      text,
      completed: opts?.completed ?? false,
      usage: opts?.usage,
    });
  }
}

export const noopReporter = {
  info() {},
  success() {},
  warn() {},
  error() {},
} as unknown as Reporter;

export function tmpProject(prefix = "orch-test-"): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function rmrf(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

/** Poll a condition (5ms interval) until it holds or the timeout expires. */
export async function waitFor(
  cond: () => boolean,
  what = "condition",
  timeoutMs = 3000
): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitFor timed out after ${timeoutMs}ms: ${what}`);
    }
    await new Promise((r) => setTimeout(r, 5));
  }
}

export interface Env {
  projectDir: string;
  store: Store;
  workflows: WorkflowRegistry;
  client: FakeClient;
  runner: Runner;
  goals: GoalController;
  /** Index of the next unanswered prompt (advanced by completePrompt). */
  cursor: number;
  destroy: () => void;
}

/** Store + registry + runner wired to a FakeClient inside a temp project dir. */
export async function makeEnv(projectDir?: string): Promise<Env> {
  const dir = projectDir ?? tmpProject();
  const store = new Store(dir);
  await store.init();
  const workflows = new WorkflowRegistry();
  workflows.loadCustom(dir);
  const client = new FakeClient();
  const runner = new Runner({
    store,
    workflows,
    client,
    directory: dir,
    reporter: noopReporter,
  });
  const goals = new GoalController({
    store,
    client: client as unknown as GoalClient,
    directory: dir,
    reporter: noopReporter,
    options: {
      maxTurns: 20,
      maxDurationMs: 14_400_000,
      maxTokens: 250_000,
      softTokens: 180_000,
      noProgressLimit: 3,
      evidenceChars: 12_000,
    },
  });
  return {
    projectDir: dir,
    store,
    workflows,
    client,
    runner,
    goals,
    cursor: 0,
    destroy: () => {
      runner.destroy();
      store.destroy();
    },
  };
}

/**
 * Wait for the next unanswered prompt (index `at`, default: the cursor), set
 * the canned assistant output for its session, and fire `session.idle` at the
 * runner. Note the first prompt may already exist by the time this is called
 * (the runner dispatches it on microtasks during `startRun`), so the cursor —
 * not `prompts.length` — decides which prompt to answer.
 */
export async function completePrompt(
  env: Env,
  output: string,
  at?: number,
  opts?: { usage?: { input?: number; output?: number; reasoning?: number; cacheWrite?: number } }
): Promise<PromptRecord> {
  const idx = at ?? env.cursor;
  await waitFor(
    () => env.client.prompts.length > idx,
    `prompt #${idx + 1} to be sent`
  );
  env.cursor = idx + 1;
  const rec = env.client.prompts[idx];
  env.client.inflight--;
  env.client.setOutput(rec.sessionID, output, opts);
  await env.runner.onSessionIdle(rec.sessionID);
  return rec;
}

/** Wait until a run reaches a terminal status and return its record. */
export async function waitForRun(env: Env, runID: string) {
  await waitFor(() => {
    const s = env.store.getRun(runID)?.status;
    return s === "completed" || s === "failed" || s === "cancelled" || s === "budget_exhausted";
  }, `run ${runID} to finish`);
  return env.store.getRun(runID)!;
}
