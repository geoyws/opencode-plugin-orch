import { afterEach, describe, expect, it } from "bun:test";
import { GoalController, type GoalClient } from "../src/core/goal-controller.js";
import { Store } from "../src/state/store.js";
import { noopReporter, rmrf, tmpProject } from "./_harness.js";

type Message = {
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
  parts: Array<{ type: string; text?: string }>;
};

class GoalFake {
  messagesBySession = new Map<string, Message[]>();
  verdict = { verdict: "met", reason: "observed evidence" };
  continuations: Array<{ sessionID: string; text: string; model?: object }> = [];
  summaries: string[] = [];
  deletes: string[] = [];
  aborts: string[] = [];
  private counter = 0;

  session: GoalClient["session"] = {
    create: async () => ({ data: { id: `eval_${++this.counter}` } }),
    prompt: async () => ({
      data: {
        info: { role: "assistant" },
        parts: [{ type: "text", text: JSON.stringify(this.verdict) }],
      },
    }),
    promptAsync: async (opts) => {
      this.continuations.push({
        sessionID: opts.path.id,
        text: opts.body.parts.map((part) => part.text).join(""),
        model: opts.body.model,
      });
      return {};
    },
    abort: async (opts) => {
      this.aborts.push(opts.path.id);
      return {};
    },
    messages: async (opts) => ({ data: this.messagesBySession.get(opts.path.id) ?? [] }),
    delete: async (opts) => {
      this.deletes.push(opts.path.id);
      return {};
    },
    summarize: async (opts) => {
      this.summaries.push(opts.path.id);
      return {};
    },
  };
}

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmrf(dir);
});

async function setup() {
  const directory = tmpProject("orch-goal-test-");
  dirs.push(directory);
  const store = new Store(directory);
  await store.init();
  const client = new GoalFake();
  const goals = new GoalController({
    store,
    client,
    directory,
    reporter: noopReporter,
    options: {
      evaluatorModel: { providerID: "deepseek", modelID: "deepseek-chat" },
      summarizerModel: { providerID: "deepseek", modelID: "deepseek-chat" },
      maxTurns: 20,
      maxDurationMs: 60_000,
      maxTokens: 1000,
      softTokens: 700,
      noProgressLimit: 3,
      evidenceChars: 2000,
    },
  });
  return { store, client, goals, destroy: () => store.destroy() };
}

function assistant(
  text: string,
  tokens = 10,
  parts: Message["parts"] = [{ type: "text", text }],
  id?: string
): Message {
  return {
    info: {
      id,
      role: "assistant",
      cost: 0.01,
      tokens: { input: tokens, output: tokens, cache: { read: 3, write: 1 } },
    },
    parts,
  };
}

describe("GoalController", () => {
  it("persists a DeepSeek-backed goal and resolves it from independent evidence", async () => {
    const e = await setup();
    e.goals.noteSession("lead", {
      model: { providerID: "deepseek", modelID: "deepseek-reasoner" },
      agent: "build",
    });
    const goal = await e.goals.start("lead", "typecheck passes");
    expect(goal.evaluatorModel).toEqual({ providerID: "deepseek", modelID: "deepseek-chat" });
    expect(goal.workerSessionID).toBeDefined();
    e.client.messagesBySession.set(goal.workerSessionID!, [assistant("typecheck exited 0")]);

    await e.goals.onSessionIdle("lead");
    expect(e.store.getGoal("lead")?.turns).toBe(0);
    await e.goals.onSessionIdle(goal.workerSessionID!);
    const resolved = e.store.getGoal("lead")!;
    expect(resolved.status).toBe("achieved");
    expect(resolved.lastVerdict).toBe("met");
    expect(resolved.observedTokens).toBe(24);
    expect(e.client.continuations).toHaveLength(1);
    expect(e.client.deletes).toHaveLength(1);
    e.destroy();
  });

  it("continues the dedicated worker on not_met using the worker model", async () => {
    const e = await setup();
    e.goals.noteSession("lead", {
      model: { providerID: "deepseek", modelID: "deepseek-reasoner" },
      agent: "build",
    });
    const goal = await e.goals.start("lead", "all tests pass");
    e.client.verdict = { verdict: "not_met", reason: "tests were not run" };
    e.client.messagesBySession.set(goal.workerSessionID!, [
      assistant("edited source", 10, [
        { type: "text", text: "edited source" },
        { type: "tool" },
      ]),
    ]);

    await e.goals.onSessionIdle(goal.workerSessionID!);
    expect(e.store.getGoal("lead")?.status).toBe("active");
    expect(e.store.getGoal("lead")?.turns).toBe(1);
    expect(e.client.continuations).toHaveLength(2);
    expect(e.client.continuations[1].sessionID).toBe(goal.workerSessionID);
    expect(e.client.continuations[1].text).toContain("tests were not run");
    expect(e.client.continuations[1].model).toEqual({
      providerID: "deepseek",
      modelID: "deepseek-reasoner",
    });
    e.destroy();
  });

  it("auto-compacts at the soft budget and stops at the hard budget", async () => {
    const e = await setup();
    const goal = await e.goals.start("lead", "finish", { softTokens: 100, maxTokens: 500 });
    e.client.verdict = { verdict: "not_met", reason: "keep going" };
    e.client.messagesBySession.set(goal.workerSessionID!, [assistant("progress", 75)]);
    await e.goals.onSessionIdle(goal.workerSessionID!);
    expect(e.client.summaries).toEqual([goal.workerSessionID]);
    expect(e.store.getGoal("lead")?.lastCompactedTokens).toBe(154);

    e.client.messagesBySession.set(goal.workerSessionID!, [assistant("too much", 300)]);
    await e.goals.onSessionIdle(goal.workerSessionID!);
    expect(e.store.getGoal("lead")?.status).toBe("budget_exhausted");
    expect(e.client.continuations).toHaveLength(2);
    e.destroy();
  });

  it("keeps usage monotonic when compaction replaces already-accounted messages", async () => {
    const e = await setup();
    const goal = await e.goals.start("lead", "finish", { softTokens: 900, maxTokens: 1000 });
    e.client.verdict = { verdict: "not_met", reason: "keep going" };
    e.client.messagesBySession.set(goal.workerSessionID!, [assistant("first", 10, undefined, "msg_1")]);
    await e.goals.onSessionIdle(goal.workerSessionID!);
    expect(e.store.getGoal("lead")?.observedTokens).toBe(24);

    // Simulate a compacted transcript: msg_1 disappeared and msg_2 is new.
    e.client.messagesBySession.set(goal.workerSessionID!, [assistant("second", 10, undefined, "msg_2")]);
    await e.goals.onSessionIdle(goal.workerSessionID!);
    expect(e.store.getGoal("lead")?.observedTokens).toBe(48);
    expect(e.store.getGoal("lead")?.observedCost).toBeCloseTo(0.02);
    expect(e.store.getGoal("lead")?.accountedMessageIDs).toEqual(["msg_1", "msg_2"]);
    e.destroy();
  });

  it("supports status and clear without another evaluator turn", async () => {
    const e = await setup();
    const goal = await e.goals.start("lead", "ship safely");
    expect(e.goals.status("lead")).toContain("Goal active: ship safely");
    expect(e.goals.status("lead")).toContain(`Worker: running (${goal.workerSessionID})`);
    await e.goals.clear("lead");
    expect(e.store.getGoal("lead")?.status).toBe("cleared");
    expect(e.client.aborts).toContain(goal.workerSessionID!);
    expect(e.client.deletes).toContain(goal.workerSessionID!);
    expect(e.goals.status("missing")).toBe("No goal set.");
    e.destroy();
  });

  it("persists steering and delivers it to the worker without touching the lead", async () => {
    const e = await setup();
    const goal = await e.goals.start("lead", "ship safely");
    await e.goals.steer("lead", "run the browser test before declaring success");
    const steered = e.store.getGoal("lead")!;
    expect(steered.steering.at(-1)?.text).toContain("browser test");
    expect(steered.steering.at(-1)?.deliveredTo).toEqual([goal.workerSessionID!]);
    expect(e.client.continuations.at(-1)?.sessionID).toBe(goal.workerSessionID);
    expect(e.client.continuations.at(-1)?.text).toContain("browser test");
    e.destroy();
  });
});
