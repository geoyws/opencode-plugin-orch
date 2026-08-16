import { describe, it, expect, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { matchRoute, extractJsonArray, isPassVerdict } from "../src/core/runner.js";
import {
  makeEnv,
  completePrompt,
  waitForRun,
  waitFor,
  tmpProject,
  rmrf,
  type Env,
} from "./_harness.js";

let envs: Env[] = [];

async function env(): Promise<Env> {
  const e = await makeEnv();
  envs.push(e);
  return e;
}

/** Env whose temp project has the given custom workflow pre-installed. */
async function envWith(def: object): Promise<Env> {
  const dir = tmpProject();
  const wfDir = path.join(dir, ".opencode", "workflows");
  fs.mkdirSync(wfDir, { recursive: true });
  fs.writeFileSync(path.join(wfDir, "custom.json"), JSON.stringify(def), "utf-8");
  const e = await makeEnv(dir);
  envs.push(e);
  return e;
}

afterEach(() => {
  for (const e of envs) {
    e.destroy();
    rmrf(e.projectDir);
  }
  envs = [];
});

describe("pure helpers", () => {
  it("matchRoute matches route keys as standalone words, case-insensitive", () => {
    const routes = { code: ["a"], docs: ["b"] };
    expect(matchRoute("This is a CODE task", routes)).toBe("code");
    expect(matchRoute("docs please", routes)).toBe("docs");
    expect(matchRoute("decode this", routes)).toBeUndefined(); // word boundary
    expect(matchRoute("unrelated", routes)).toBeUndefined();
  });

  it("extractJsonArray finds the first JSON array, even embedded in prose", () => {
    expect(extractJsonArray('[{"instructions":"a"}]')).toEqual([{ instructions: "a" }]);
    expect(
      extractJsonArray('Here is the plan:\n[{"instructions":"x"}]\nDone.')
    ).toEqual([{ instructions: "x" }]);
    // Extraction scans "[" spans from the first "[" in the output.
    expect(() => extractJsonArray("no array here")).toThrow(/no JSON array/);
    expect(() => extractJsonArray("[1, 2")).toThrow(/no valid JSON array/);
  });

  it("accepts only a PASS-only critic verdict, with an optional timestamp footer", () => {
    expect(isPassVerdict("PASS")).toBe(true);
    expect(isPassVerdict("PASS\n\n_2026-08-16 12:30 MYT_")).toBe(true);
    expect(isPassVerdict("This should PASS after one fix")).toBe(false);
    expect(isPassVerdict("PASS\nbut there is still a defect")).toBe(false);
  });
});

describe("chain pattern", () => {
  it("runs steps in order, chaining {{output}}, final output wins", async () => {
    const e = await env();
    const run = await e.runner.startRun("chain-draft-refine", "write a poem");

    const p1 = await completePrompt(e, "draft v1");
    expect(p1.stepID).toBe("draft");
    expect(p1.text).toContain("write a poem"); // {{input}}
    expect(p1.agent).toBe("build");

    const p2 = await completePrompt(e, "refined v2");
    expect(p2.stepID).toBe("refine");
    expect(p2.text).toContain("draft v1"); // {{output}} from step 1
    expect(p2.text).toContain("write a poem");

    const done = await waitForRun(e, run.id);
    expect(done.status).toBe("completed");
    expect(done.output).toBe("refined v2");
    expect(Object.keys(done.steps)).toEqual(["draft", "refine"]);
  });

  it("applies the config model override to every step", async () => {
    const e = await env();
    const run = await e.runner.startRun("chain-draft-refine", "x", {
      model: { providerID: "p", modelID: "m" },
    });
    const p1 = await completePrompt(e, "a");
    const p2 = await completePrompt(e, "b");
    expect(p1.model).toEqual({ providerID: "p", modelID: "m" });
    expect(p2.model).toEqual({ providerID: "p", modelID: "m" });
    await waitForRun(e, run.id);
  });
});

describe("routing pattern", () => {
  it("matches the classifier label and runs the routed chain", async () => {
    const e = await env();
    const run = await e.runner.startRun("route-by-intent", "fix the bug");

    const cls = await completePrompt(e, "This is clearly a code request.");
    expect(cls.stepID).toBe("classify");

    const routed = await completePrompt(e, "fixed it");
    expect(routed.stepID).toBe("code");

    const done = await waitForRun(e, run.id);
    expect(done.status).toBe("completed");
    expect(done.output).toBe("fixed it");
    expect(Object.keys(done.steps)).toEqual(["classify", "code"]);
  });

  it("fails the run when the classifier output matches no route", async () => {
    const e = await env();
    const run = await e.runner.startRun("route-by-intent", "whatever");
    await completePrompt(e, "banana hammock");
    const done = await waitForRun(e, run.id);
    expect(done.status).toBe("failed");
    expect(done.error).toContain("matched no route");
  });
});

describe("parallel pattern", () => {
  it("bounds concurrency and feeds every output to the aggregate step", async () => {
    const e = await env();
    const run = await e.runner.startRun("parallel-review", "review this", {
      concurrency: 2,
    });

    // Only 2 branches may be in flight at once (3 steps, concurrency 2).
    await waitFor(() => e.client.prompts.length === 2, "first two branches");
    await new Promise((r) => setTimeout(r, 50));
    expect(e.client.prompts.length).toBe(2);
    expect(e.client.maxInflight).toBe(2);

    const outputs: Record<string, string> = {
      security: "sec findings",
      performance: "perf findings",
      style: "style findings",
    };
    for (const rec of [...e.client.prompts]) {
      e.client.inflight--;
      e.client.setOutput(rec.sessionID, outputs[rec.stepID]);
      await e.runner.onSessionIdle(rec.sessionID);
    }
    // Third branch starts only after a slot freed.
    await waitFor(() => e.client.prompts.length === 3, "third branch");
    const third = e.client.prompts[2];
    e.client.inflight--;
    e.client.setOutput(third.sessionID, outputs[third.stepID]);
    await e.runner.onSessionIdle(third.sessionID);
    // The 3 branch prompts were answered manually; the cursor starts at the
    // aggregate prompt.
    e.cursor = 3;

    const agg = await completePrompt(e, "combined report");
    expect(agg.stepID).toBe("aggregate");
    expect(agg.text).toContain("sec findings");
    expect(agg.text).toContain("perf findings");
    expect(agg.text).toContain("style findings");

    const done = await waitForRun(e, run.id);
    expect(done.status).toBe("completed");
    expect(done.output).toBe("combined report");
  });

  it("a failed branch fails the run", async () => {
    const e = await env();
    const run = await e.runner.startRun("parallel-review", "review this", {
      concurrency: 3,
    });
    await waitFor(() => e.client.prompts.length === 3, "all branches");
    const victim = e.client.prompts[1];
    await e.runner.onSessionError(victim.sessionID, "branch exploded");

    const done = await waitForRun(e, run.id);
    expect(done.status).toBe("failed");
    expect(done.error).toContain("branch exploded");

    // Late completions from the other branches are ignored.
    for (const rec of e.client.prompts) {
      if (rec.sessionID !== victim.sessionID) {
        e.client.setOutput(rec.sessionID, "late");
        await e.runner.onSessionIdle(rec.sessionID);
      }
    }
    expect(e.store.getRun(run.id)!.status).toBe("failed");
  });
});

describe("orchestrator pattern", () => {
  it("parses a JSON plan embedded in prose, runs workers, aggregates", async () => {
    const e = await env();
    const run = await e.runner.startRun("orchestrate-tasks", "build a thing");

    const plan = await completePrompt(
      e,
      'Here is the plan:\n[{"instructions":"do A"},{"instructions":"do B"}]\nGood luck.'
    );
    expect(plan.stepID).toBe("planner");

    await waitFor(() => e.client.prompts.length === 3, "two workers");
    const w1 = e.client.prompts[1];
    const w2 = e.client.prompts[2];
    expect(w1.stepID).toBe("worker-1");
    expect(w2.stepID).toBe("worker-2");
    expect(w1.text).toContain("do A");
    expect(w2.text).toContain("do B");

    e.client.inflight -= 2;
    e.client.setOutput(w1.sessionID, "result A");
    e.client.setOutput(w2.sessionID, "result B");
    await e.runner.onSessionIdle(w1.sessionID);
    await e.runner.onSessionIdle(w2.sessionID);
    e.cursor = 3; // planner + 2 workers answered; next is the aggregate

    const agg = await completePrompt(e, "final deliverable");
    expect(agg.stepID).toBe("aggregate");
    expect(agg.text).toContain("## Result of worker-1");
    expect(agg.text).toContain("result A");
    expect(agg.text).toContain("## Result of worker-2");
    expect(agg.text).toContain("result B");

    const done = await waitForRun(e, run.id);
    expect(done.status).toBe("completed");
    expect(done.output).toBe("final deliverable");
  });

  it("fails the run when the planner outputs no JSON array", async () => {
    const e = await env();
    const run = await e.runner.startRun("orchestrate-tasks", "build a thing");
    await completePrompt(e, "I cannot plan this, sorry.");
    const done = await waitForRun(e, run.id);
    expect(done.status).toBe("failed");
    expect(done.error).toContain("no JSON array");
  });

  it("fails the run on an empty subtask list", async () => {
    const e = await env();
    const run = await e.runner.startRun("orchestrate-tasks", "build a thing");
    await completePrompt(e, "[]");
    const done = await waitForRun(e, run.id);
    expect(done.status).toBe("failed");
    expect(done.error).toContain("empty subtask list");
  });
});

describe("evaluator pattern", () => {
  it("loops generator/critic until the critic says PASS", async () => {
    const e = await env();
    const run = await e.runner.startRun("evaluator-loop", "answer me");

    const g1 = await completePrompt(e, "attempt 1");
    expect(g1.stepID).toBe("generator");
    const c1 = await completePrompt(e, "too short, add detail");
    expect(c1.stepID).toBe("critic");

    const g2 = await completePrompt(e, "attempt 2 with detail");
    expect(g2.stepID).toBe("generator#2");
    expect(g2.text).toContain("too short, add detail"); // {{feedback}}
    const c2 = await completePrompt(e, "PASS");
    expect(c2.stepID).toBe("critic#2");
    expect(c2.text).toContain("attempt 2 with detail"); // {{output}}

    const done = await waitForRun(e, run.id);
    expect(done.status).toBe("completed");
    expect(done.output).toBe("attempt 2 with detail");
    expect(done.note).toBeUndefined();
    expect(Object.keys(done.steps)).toEqual([
      "generator",
      "critic",
      "generator#2",
      "critic#2",
    ]);
  });

  it("completes with a note when the iteration budget is exhausted", async () => {
    const e = await env();
    const run = await e.runner.startRun("evaluator-loop", "answer me", {
      maxIterations: 2,
    });

    await completePrompt(e, "v1");
    await completePrompt(e, "not good enough");
    await completePrompt(e, "v2");
    await completePrompt(e, "still not good enough");

    const done = await waitForRun(e, run.id);
    expect(done.status).toBe("completed");
    expect(done.output).toBe("v2");
    expect(done.note).toContain("iteration budget exhausted");
  });
});

describe("run control", () => {
  it("carries durable steering into later workflow agents", async () => {
    const e = await env();
    const run = await e.runner.startRun("chain-draft-refine", "x");
    await waitFor(() => e.client.prompts.length === 1, "draft prompt");
    const draft = e.client.prompts[0];
    expect(await e.runner.steer(run.id, "focus on the browser regression")).toBe(1);
    e.client.setOutput(draft.sessionID, "draft done");
    await e.runner.onSessionIdle(draft.sessionID);
    await waitFor(() => e.client.prompts.some((prompt) => prompt.stepID === "refine"));
    const refine = e.client.prompts.find((prompt) => prompt.stepID === "refine")!;
    expect(refine.text).toContain("Durable operator steering");
    expect(refine.text).toContain("focus on the browser regression");
    await e.runner.cancel(run.id);
  });

  it("cancel aborts in-flight sessions and marks the run cancelled", async () => {
    const e = await env();
    const run = await e.runner.startRun("chain-draft-refine", "x");
    await waitFor(() => e.client.prompts.length === 1, "first step");
    const sid = e.client.prompts[0].sessionID;

    await e.runner.cancel(run.id);

    expect(e.client.aborts).toContain(sid);
    const done = await waitForRun(e, run.id);
    expect(done.status).toBe("cancelled");
    expect(done.steps.draft.status).toBe("cancelled");

    // Cancelling a finished run throws.
    await expect(e.runner.cancel(run.id)).rejects.toThrow(/already cancelled/);
    // A late idle for the aborted session is a no-op.
    e.client.setOutput(sid, "too late");
    await e.runner.onSessionIdle(sid);
    expect(e.store.getRun(run.id)!.status).toBe("cancelled");
  });

  it("a per-step timeout fails the run", async () => {
    const e = await env();
    const run = await e.runner.startRun("chain-draft-refine", "x", {
      stepTimeoutMs: 50,
    });
    await waitFor(() => e.client.prompts.length === 1, "first step");
    const sid = e.client.prompts[0].sessionID;

    const done = await waitForRun(e, run.id);
    expect(done.status).toBe("failed");
    expect(done.error).toMatch(/step "draft" timed out/);
    expect(done.steps.draft.status).toBe("failed");
    // The stuck session is aborted best-effort.
    expect(e.client.aborts).toContain(sid);
  });

  it("pauses at the next safe boundary and resumes without repeating work", async () => {
    const e = await env();
    const run = await e.runner.startRun("chain-draft-refine", "x");
    await waitFor(() => e.client.prompts.length === 1, "first step");
    e.runner.pause(run.id);
    expect(e.store.getRun(run.id)?.status).toBe("paused");

    await completePrompt(e, "draft done");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(e.client.prompts).toHaveLength(1);
    expect(e.store.getRun(run.id)?.steps.draft.status).toBe("completed");

    e.runner.resume(run.id);
    await waitFor(() => e.client.prompts.length === 2, "resumed second step");
    await completePrompt(e, "final");
    const done = await waitForRun(e, run.id);
    expect(done.status).toBe("completed");
    expect(Object.keys(done.steps)).toEqual(["draft", "refine"]);
  });

  it("session.error fails the run", async () => {
    const e = await env();
    const run = await e.runner.startRun("chain-draft-refine", "x");
    await waitFor(() => e.client.prompts.length === 1, "first step");
    await e.runner.onSessionError(e.client.prompts[0].sessionID, "provider blew up");

    const done = await waitForRun(e, run.id);
    expect(done.status).toBe("failed");
    expect(done.error).toBe("provider blew up");
    expect(done.steps.draft.status).toBe("failed");
    expect(done.steps.draft.error).toBe("provider blew up");
  });

  it("startRun rejects unknown workflows and bad overrides", async () => {
    const e = await env();
    await expect(e.runner.startRun("nope", "x")).rejects.toThrow(/not found/);
    await expect(
      e.runner.startRun("chain-draft-refine", "x", { concurrency: 0 })
    ).rejects.toThrow();
  });
});

describe("command steps", () => {
  const cmdChain = {
    name: "cmd-chain",
    description: "command then prompt",
    pattern: "chain",
    steps: [
      { id: "produce", command: "echo hello" },
      { id: "consume", instructions: "received: {{output}}" },
    ],
  };

  it("a command step runs via /bin/sh and feeds {{output}} to the next step", async () => {
    const e = await envWith(cmdChain);
    const run = await e.runner.startRun("cmd-chain", "go");

    // The command step creates no LLM session — the first prompt is `consume`.
    const p = await completePrompt(e, "done");
    expect(p.stepID).toBe("consume");
    expect(p.text).toBe("received: hello\n");

    const done = await waitForRun(e, run.id);
    expect(done.status).toBe("completed");
    expect(done.output).toBe("done");
    expect(done.steps.produce.output).toBe("hello\n");
    expect(done.steps.produce.sessionID).toBeUndefined(); // no session created
    expect(Object.keys(done.steps)).toEqual(["produce", "consume"]);
  });

  it("a non-zero exit fails the step and the run", async () => {
    const e = await envWith({
      name: "cmd-fail",
      description: "failing command",
      pattern: "chain",
      steps: [{ id: "build", command: "echo boom >&2; exit 1" }],
    });
    const run = await e.runner.startRun("cmd-fail", "go");

    const done = await waitForRun(e, run.id);
    expect(done.status).toBe("failed");
    expect(done.error).toContain('step "build" command exited 1');
    expect(done.error).toContain("boom");
    expect(done.steps.build.status).toBe("failed");
  });

  // The command backgrounds `sleep 30` and writes ITS pid — the defect was
  // the grandchild surviving, so the assertion must be about $!, not $$.
  const sleepCmd = "sleep 30 & echo $! > sleep.pid; wait";

  async function readSleepPid(e: Env): Promise<number> {
    const pidFile = path.join(e.projectDir, "sleep.pid");
    await waitFor(() => fs.existsSync(pidFile), "command step to start");
    const pid = Number(fs.readFileSync(pidFile, "utf-8").trim());
    expect(pid).toBeGreaterThan(0);
    return pid;
  }

  async function expectDead(pid: number): Promise<void> {
    await waitFor(() => {
      try {
        process.kill(pid, 0);
        return false; // still alive
      } catch {
        return true; // ESRCH — gone
      }
    }, `pid ${pid} to die`);
  }

  it("cancel kills a running command step's process group and marks the step cancelled", async () => {
    const e = await envWith({
      name: "cmd-sleep",
      description: "slow command",
      pattern: "chain",
      steps: [{ id: "slow", command: sleepCmd }],
    });
    const run = await e.runner.startRun("cmd-sleep", "go");
    const pid = await readSleepPid(e);

    await e.runner.cancel(run.id);

    const done = await waitForRun(e, run.id);
    expect(done.status).toBe("cancelled");
    // Terminal step event — not stuck `running` forever.
    expect(done.steps.slow.status).toBe("cancelled");
    expect(done.steps.slow.error).toBe("run cancelled");
    // The orphaned sleep is actually dead.
    await expectDead(pid);
  });

  it("a command step timeout kills the process group", async () => {
    const e = await envWith({
      name: "cmd-timeout",
      description: "slow command with a timeout",
      pattern: "chain",
      steps: [{ id: "slow", command: sleepCmd }],
    });
    const run = await e.runner.startRun("cmd-timeout", "go", { stepTimeoutMs: 50 });
    const pid = await readSleepPid(e);

    const done = await waitForRun(e, run.id);
    expect(done.status).toBe("failed");
    expect(done.error).toContain('step "slow" command exited 124');
    expect(done.error).toContain("timed out");
    await expectDead(pid);
  });
});

describe("evaluator gates", () => {
  // test-fix-loop's built-in gate is `npm test`; overriding it with a
  // marker-file gate makes the pass/fail sequence deterministic.
  it("completes a gate-only evaluator once the gate passes (no critic step)", async () => {
    const e = await env();
    const run = await e.runner.startRun("test-fix-loop", "fix the tests", {
      gateCommand:
        "if [ -f gate.pass ]; then exit 0; else echo GATE_TAIL_MARKER; exit 1; fi",
    });

    await completePrompt(e, "attempt 1"); // gate fails → feedback

    // Wait for the iteration-2 prompt, create the marker, THEN answer it so
    // the gate that runs on its completion passes.
    await waitFor(() => e.client.prompts.length === 2, "generator#2 prompt");
    expect(e.client.prompts[1].text).toContain("GATE_TAIL_MARKER");
    fs.writeFileSync(path.join(e.projectDir, "gate.pass"), "");
    await completePrompt(e, "attempt 2");

    const done = await waitForRun(e, run.id);
    expect(done.status).toBe("completed");
    expect(done.output).toBe("attempt 2");
    expect(done.note).toBeUndefined();
    // Gate runs are not store steps; there is no critic.
    expect(Object.keys(done.steps)).toEqual(["generator", "generator#2"]);
  });

  it("with gate + critic both present, both must pass to end the loop", async () => {
    const e = await envWith({
      name: "gated-eval",
      description: "evaluator with gate and critic",
      pattern: "evaluator",
      maxIterations: 3,
      gate: {
        command: "if [ -f gate.pass ]; then exit 0; else echo GATE_FAIL; exit 1; fi",
      },
      steps: [
        { id: "gen", instructions: "make {{input}}\n{{feedback}}" },
        { id: "crit", instructions: "review {{output}}" },
      ],
    });
    const run = await e.runner.startRun("gated-eval", "thing");

    await completePrompt(e, "v1"); // gate fails (no marker)
    const c1 = await completePrompt(e, "PASS"); // critic passes, gate didn't → loop
    expect(c1.stepID).toBe("crit");

    const g2 = await completePrompt(e, "v2");
    expect(g2.stepID).toBe("gen#2");
    expect(g2.text).toContain("GATE_FAIL"); // only gate feedback (critic passed)
    // Gate passes from now on.
    fs.writeFileSync(path.join(e.projectDir, "gate.pass"), "");
    const c2 = await completePrompt(e, "still broken"); // gate passes, critic doesn't → loop
    expect(c2.stepID).toBe("crit#2");

    const g3 = await completePrompt(e, "v3");
    expect(g3.stepID).toBe("gen#3");
    expect(g3.text).toContain("still broken"); // only the critique (gate passed)
    await completePrompt(e, "PASS");

    const done = await waitForRun(e, run.id);
    expect(done.status).toBe("completed");
    expect(done.output).toBe("v3");
    expect(done.note).toBeUndefined();
    expect(Object.keys(done.steps)).toEqual([
      "gen",
      "crit",
      "gen#2",
      "crit#2",
      "gen#3",
      "crit#3",
    ]);
  });
});

describe("model and output config", () => {
  it("resolves models as stepModels[step.id] ?? step.model ?? config.model", async () => {
    const e = await envWith({
      name: "model-chain",
      description: "per-step model resolution",
      pattern: "chain",
      steps: [
        { id: "a", instructions: "a {{input}}" },
        { id: "b", instructions: "b {{output}}", model: { providerID: "sd", modelID: "sm" } },
        { id: "c", instructions: "c {{output}}" },
      ],
    });
    const run = await e.runner.startRun("model-chain", "x", {
      model: { providerID: "rd", modelID: "rm" },
      stepModels: { a: { providerID: "od", modelID: "om" } },
    });

    const pa = await completePrompt(e, "out a");
    const pb = await completePrompt(e, "out b");
    const pc = await completePrompt(e, "out c");
    expect(pa.model).toEqual({ providerID: "od", modelID: "om" }); // stepModels wins
    expect(pb.model).toEqual({ providerID: "sd", modelID: "sm" }); // step def model
    expect(pc.model).toEqual({ providerID: "rd", modelID: "rm" }); // run config model
    await waitForRun(e, run.id);
  });

  it("maxStepOutputChars truncates prompt-injected output but not the store", async () => {
    const e = await envWith({
      name: "cap-chain",
      description: "output cap",
      pattern: "chain",
      steps: [
        { id: "a", instructions: "a {{input}}" },
        { id: "b", instructions: "b {{output}}" },
      ],
    });
    const big = "x".repeat(1500);
    const run = await e.runner.startRun("cap-chain", "x", { maxStepOutputChars: 1000 });

    await completePrompt(e, big);
    const pb = await completePrompt(e, "done");
    expect(pb.text).toContain("x".repeat(450));
    expect(pb.text).toContain("[... compacted 580 chars ...]");
    expect(pb.text).not.toContain(big);

    const done = await waitForRun(e, run.id);
    expect(done.status).toBe("completed");
    expect(done.steps.a.output).toBe(big); // full output stays in the store
  });

  it("hard token budget prevents the next step and records provider usage", async () => {
    const e = await env();
    const run = await e.runner.startRun("chain-draft-refine", "x", {
      maxTokens: 100,
      softTokens: 75,
    });
    await completePrompt(e, "draft", undefined, {
      usage: { input: 80, output: 25, reasoning: 5, cacheRead: 100, cacheWrite: 2 },
    });
    const done = await waitForRun(e, run.id);
    expect(done.status).toBe("budget_exhausted");
    expect(done.error).toContain("212/100");
    expect(e.client.prompts).toHaveLength(1);
    expect(done.steps.draft.usage).toEqual({
      input: 80,
      output: 25,
      reasoning: 5,
      cacheRead: 100,
      cacheWrite: 2,
    });
  });

  it("soft token threshold injects the persisted compact checkpoint", async () => {
    const e = await env();
    const big = `HEAD-${"x".repeat(5988)}-TAIL`;
    const run = await e.runner.startRun("chain-draft-refine", "x", {
      maxTokens: 1000,
      softTokens: 50,
      maxStepOutputChars: 10_000,
    });
    await completePrompt(e, big, undefined, {
      usage: { input: 40, output: 20 },
    });
    const next = await completePrompt(e, "done");
    expect(next.text).toContain("checkpoint compacted");
    expect(next.text).not.toContain(big);
    const done = await waitForRun(e, run.id);
    expect(done.steps.draft.output).toBe(big);
    expect(done.steps.draft.summary?.length).toBeLessThan(big.length);
  });
});

describe("session teardown", () => {
  it("deletes the step session on success, after the output was extracted", async () => {
    const e = await env();
    const run = await e.runner.startRun("chain-draft-refine", "x");

    const p1 = await completePrompt(e, "draft v1");
    expect(e.client.deletes).toContain(p1.sessionID);
    // The messages fetch (output extraction) must precede the delete.
    const mi = e.client.calls.indexOf(`messages:${p1.sessionID}`);
    const di = e.client.calls.indexOf(`delete:${p1.sessionID}`);
    expect(mi).toBeGreaterThanOrEqual(0);
    expect(di).toBeGreaterThan(mi);

    const p2 = await completePrompt(e, "refined v2");
    expect(e.client.deletes).toContain(p2.sessionID);

    const done = await waitForRun(e, run.id);
    expect(done.status).toBe("completed");
    expect(e.client.deletes).toHaveLength(2);
  });

  it("deletes the session on failure (session.error)", async () => {
    const e = await env();
    const run = await e.runner.startRun("chain-draft-refine", "x");
    await waitFor(() => e.client.prompts.length === 1, "first step");
    const sid = e.client.prompts[0].sessionID;

    await e.runner.onSessionError(sid, "boom");

    expect(e.client.deletes).toContain(sid);
    const done = await waitForRun(e, run.id);
    expect(done.status).toBe("failed");
  });

  it("deletes the session on cancel (after abort)", async () => {
    const e = await env();
    const run = await e.runner.startRun("chain-draft-refine", "x");
    await waitFor(() => e.client.prompts.length === 1, "first step");
    const sid = e.client.prompts[0].sessionID;

    await e.runner.cancel(run.id);

    expect(e.client.aborts).toContain(sid);
    expect(e.client.deletes).toContain(sid);
    const done = await waitForRun(e, run.id);
    expect(done.status).toBe("cancelled");
  });

  it("deletes the session on step timeout", async () => {
    const e = await env();
    const run = await e.runner.startRun("chain-draft-refine", "x", {
      stepTimeoutMs: 50,
    });
    await waitFor(() => e.client.prompts.length === 1, "first step");
    const sid = e.client.prompts[0].sessionID;

    const done = await waitForRun(e, run.id);
    expect(done.status).toBe("failed");
    expect(e.client.aborts).toContain(sid);
    expect(e.client.deletes).toContain(sid);
  });

  it("keepSessions: true keeps step sessions", async () => {
    const e = await env();
    const run = await e.runner.startRun("chain-draft-refine", "x", {
      keepSessions: true,
    });
    await completePrompt(e, "draft v1");
    await completePrompt(e, "refined v2");

    const done = await waitForRun(e, run.id);
    expect(done.status).toBe("completed");
    expect(e.client.deletes).toHaveLength(0);
  });

  it("a failing delete never affects the run", async () => {
    const e = await env();
    e.client.failDeletes = true;
    const run = await e.runner.startRun("chain-draft-refine", "x");
    await completePrompt(e, "draft v1");
    await completePrompt(e, "refined v2");

    const done = await waitForRun(e, run.id);
    expect(done.status).toBe("completed");
    expect(done.output).toBe("refined v2");
    expect(e.client.deletes).toHaveLength(2); // attempted, swallowed
  });

  it("sweeps step sessions of runs left running across a restart", async () => {
    // Simulate a crash: a run left `running` with a live step session,
    // flushed to disk without cancelling anything.
    const dir = tmpProject();
    const e1 = await makeEnv(dir);
    envs.push(e1);
    const run = await e1.runner.startRun("chain-draft-refine", "x");
    await waitFor(() => e1.client.prompts.length === 1, "first step");
    const sid = e1.client.prompts[0].sessionID;
    e1.store.destroy(); // flush snapshot with the run still `running`

    // Reload in the same project dir: the store pauses the run and
    // collects the orphaned step session for the sweep.
    const e2 = await makeEnv(dir);
    envs.push(e2);
    const got = e2.store.getRun(run.id)!;
    expect(got.status).toBe("paused");
    expect(got.steps.draft.status).toBe("cancelled");

    e2.runner.sweepInterruptedSessions();
    expect(e2.client.aborts).toContain(sid);
    await waitFor(() => e2.client.deletes.includes(sid), "swept session delete");

    // Both envs share one project dir — clean up here so afterEach's
    // per-env destroy+rmrf doesn't rm the dir out from under e2. e1's
    // runner.destroy() rejects the pending step, whose continuation writes
    // a failRun event — give it a tick to land before the rmrf.
    envs = envs.filter((x) => x !== e1 && x !== e2);
    e2.destroy();
    e1.destroy();
    await new Promise((r) => setTimeout(r, 10));
    rmrf(dir);
  });

  it("resumes after restart from completed steps without replaying them", async () => {
    const dir = tmpProject();
    const e1 = await makeEnv(dir);
    envs.push(e1);
    const now = Date.now();
    e1.store.createRun({
      id: "run_recover_1",
      workflow: "chain-draft-refine",
      pattern: "chain",
      input: "x",
      status: "running",
      config: {
        maxIterations: 3,
        concurrency: 4,
        stepTimeoutMs: 600_000,
        maxStepOutputChars: 50_000,
        keepSessions: false,
        stepRetries: 1,
      },
      steps: {
        draft: {
          id: "draft",
          status: "completed",
          output: "saved draft",
          summary: "saved draft",
          startedAt: now,
          completedAt: now,
        },
        refine: {
          id: "refine",
          status: "running",
          sessionID: "orphan_refine",
          startedAt: now,
        },
      },
      iteration: 0,
      createdAt: now,
    });
    e1.store.destroy();

    const e2 = await makeEnv(dir);
    envs.push(e2);
    expect(e2.store.getRun("run_recover_1")?.status).toBe("paused");
    e2.runner.resume("run_recover_1");
    const prompt = await completePrompt(e2, "refined after restart");
    expect(prompt.stepID).toBe("refine");
    expect(prompt.text).toContain("saved draft");
    const done = await waitForRun(e2, "run_recover_1");
    expect(done.status).toBe("completed");
    expect(done.output).toBe("refined after restart");
    expect(e2.client.prompts).toHaveLength(1);

    envs = envs.filter((x) => x !== e1 && x !== e2);
    e2.destroy();
    e1.runner.destroy();
    rmrf(dir);
  });
});

describe("step retries", () => {
  it("retries a transient session.error with a fresh session and records attempts", async () => {
    const e = await env();
    e.runner.retryDelayMs = 10;
    const run = await e.runner.startRun("chain-draft-refine", "x");
    await waitFor(() => e.client.prompts.length === 1, "first attempt");
    const sid1 = e.client.prompts[0].sessionID;

    await e.runner.onSessionError(sid1, "429 rate limit exceeded");

    // The errored attempt's session is deleted before the retry starts.
    expect(e.client.deletes).toContain(sid1);
    expect(e.client.prompts.length).toBe(1);

    // The retry re-runs the step as a NEW session, step stays running.
    await waitFor(() => e.client.prompts.length === 2, "retry prompt");
    const sid2 = e.client.prompts[1].sessionID;
    expect(sid2).not.toBe(sid1);
    expect(e.client.prompts[1].stepID).toBe("draft");
    expect(e.store.getRun(run.id)!.steps.draft.status).toBe("running");
    expect(e.store.getRun(run.id)!.steps.draft.attempts).toBe(2);

    e.client.setOutput(sid2, "draft v1");
    await e.runner.onSessionIdle(sid2);
    await completePrompt(e, "refined v2", 2);

    const done = await waitForRun(e, run.id);
    expect(done.status).toBe("completed");
    expect(done.output).toBe("refined v2");
    expect(done.steps.draft.attempts).toBe(2);
  });

  it("does not retry non-transient errors", async () => {
    const e = await env();
    e.runner.retryDelayMs = 10;
    const run = await e.runner.startRun("chain-draft-refine", "x");
    await waitFor(() => e.client.prompts.length === 1, "first step");

    await e.runner.onSessionError(e.client.prompts[0].sessionID, "provider blew up");

    const done = await waitForRun(e, run.id);
    expect(done.status).toBe("failed");
    expect(done.error).toBe("provider blew up");
    expect(done.steps.draft.attempts).toBeUndefined();
    await new Promise((r) => setTimeout(r, 30)); // past the backoff window
    expect(e.client.prompts.length).toBe(1); // no retry happened
  });

  it("stepRetries: 0 fails transient errors immediately", async () => {
    const e = await env();
    e.runner.retryDelayMs = 10;
    const run = await e.runner.startRun("chain-draft-refine", "x", {
      stepRetries: 0,
    });
    await waitFor(() => e.client.prompts.length === 1, "first step");

    await e.runner.onSessionError(e.client.prompts[0].sessionID, "503 overloaded");

    const done = await waitForRun(e, run.id);
    expect(done.status).toBe("failed");
    expect(done.error).toBe("503 overloaded");
    await new Promise((r) => setTimeout(r, 30));
    expect(e.client.prompts.length).toBe(1);
  });

  it("exhausted retries fail with an attempts note", async () => {
    const e = await env();
    e.runner.retryDelayMs = 10;
    const run = await e.runner.startRun("chain-draft-refine", "x", {
      stepRetries: 1,
    });
    await waitFor(() => e.client.prompts.length === 1, "first attempt");
    const sid1 = e.client.prompts[0].sessionID;
    await e.runner.onSessionError(sid1, "503 overloaded");
    await waitFor(() => e.client.prompts.length === 2, "retry prompt");
    const sid2 = e.client.prompts[1].sessionID;

    await e.runner.onSessionError(sid2, "503 overloaded");

    const done = await waitForRun(e, run.id);
    expect(done.status).toBe("failed");
    expect(done.error).toContain("503 overloaded");
    expect(done.error).toContain("after 2 attempts");
    expect(done.steps.draft.attempts).toBe(2);
    // Both attempt sessions were deleted.
    expect(e.client.deletes).toContain(sid1);
    expect(e.client.deletes).toContain(sid2);
  });

  it("keepSessions keeps the errored attempt's session across a retry", async () => {
    const e = await env();
    e.runner.retryDelayMs = 10;
    const run = await e.runner.startRun("chain-draft-refine", "x", {
      keepSessions: true,
    });
    await waitFor(() => e.client.prompts.length === 1, "first attempt");
    const sid1 = e.client.prompts[0].sessionID;
    await e.runner.onSessionError(sid1, "429 rate limit");
    await waitFor(() => e.client.prompts.length === 2, "retry prompt");

    expect(e.client.deletes).toHaveLength(0);
    e.client.setOutput(e.client.prompts[1].sessionID, "draft v1");
    await e.runner.onSessionIdle(e.client.prompts[1].sessionID);
    await completePrompt(e, "refined v2", 2);
    const done = await waitForRun(e, run.id);
    expect(done.status).toBe("completed");
    expect(e.client.deletes).toHaveLength(0);
  });
});
