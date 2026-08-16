import { describe, it, expect, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { createTools } from "../src/tools/index.js";
import { createLogTool } from "../src/tools/log.js";
import type { Run } from "../src/state/schemas.js";
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
let dirs: string[] = [];

async function env() {
  const e = await makeEnv();
  envs.push(e);
  const tools = createTools({
    runner: e.runner,
    store: e.store,
    workflows: e.workflows,
    goals: e.goals,
  });
  return { e, tools };
}

afterEach(() => {
  for (const e of envs) {
    e.destroy();
    rmrf(e.projectDir);
  }
  envs = [];
  for (const d of dirs) rmrf(d);
  dirs = [];
});

// Tools never look at the context — a dummy is enough.
const ctx = {} as never;

async function call(tool: { execute: (a: never, c: never) => Promise<unknown> }, args: object): Promise<string> {
  return (await tool.execute(args as never, ctx)) as string;
}

/** Run chain-draft-refine to completion through orch_run. */
async function completedChainRun(e: Env, tools: ReturnType<typeof createTools>): Promise<string> {
  const out = await call(tools.orch_run, { workflow: "chain-draft-refine", input: "hello" });
  const id = /Run (\S+) started/.exec(out)![1];
  await completePrompt(e, "draft out");
  await completePrompt(e, "final out");
  await waitForRun(e, id);
  return id;
}

function manualRun(id: string, over: Partial<Run> = {}): Run {
  return {
    id,
    workflow: "chain-draft-refine",
    pattern: "chain",
    input: "x",
    status: "completed",
    config: { maxIterations: 3, concurrency: 4, stepTimeoutMs: 600_000 },
    steps: {},
    iteration: 0,
    createdAt: Date.now(),
    ...over,
  };
}

describe("orch_run", () => {
  it("starts a run and reports the id", async () => {
    const { e, tools } = await env();
    const id = await completedChainRun(e, tools);
    expect(e.store.getRun(id)!.status).toBe("completed");
  });

  it("returns Error: for an unknown workflow", async () => {
    const { tools } = await env();
    const out = await call(tools.orch_run, { workflow: "nope", input: "x" });
    expect(out).toStartWith('Error: Workflow "nope" not found.');
  });

  it("returns Error: for malformed config JSON", async () => {
    const { tools } = await env();
    const out = await call(tools.orch_run, {
      workflow: "chain-draft-refine",
      input: "x",
      config: "{not json",
    });
    expect(out).toStartWith("Error: config is not valid JSON:");
  });

  it("returns Error: for schema-invalid config", async () => {
    const { tools } = await env();
    const out = await call(tools.orch_run, {
      workflow: "chain-draft-refine",
      input: "x",
      config: '{"concurrency": 0}',
    });
    expect(out).toStartWith("Error:");
  });

  it("accepts the v0.3 config keys (gateCommand, stepModels, maxStepOutputChars, isolation)", async () => {
    const { e, tools } = await env();
    const out = await call(tools.orch_run, {
      workflow: "chain-draft-refine",
      input: "x",
      config: JSON.stringify({
        isolation: "worktree",
        gateCommand: "npm test",
        stepModels: { draft: { providerID: "p", modelID: "m" } },
        maxStepOutputChars: 1000,
      }),
    });
    expect(out).toContain("started");
    expect(out).not.toStartWith("Error:");
    const id = /Run (\S+) started/.exec(out)![1];
    const run = e.store.getRun(id)!;
    expect(run.config.isolation).toBe("worktree");
    expect(run.config.gateCommand).toBe("npm test");
    expect(run.config.stepModels).toEqual({ draft: { providerID: "p", modelID: "m" } });
    expect(run.config.maxStepOutputChars).toBe(1000);
    await e.runner.cancel(id);
    // Let the background execute() settle before teardown removes the dir.
    await new Promise((r) => setTimeout(r, 20));
  });

  it("rejects maxStepOutputChars below the 1000 minimum", async () => {
    const { tools } = await env();
    const out = await call(tools.orch_run, {
      workflow: "chain-draft-refine",
      input: "x",
      config: '{"maxStepOutputChars": 10}',
    });
    expect(out).toStartWith("Error:");
  });
});

describe("orch_workflows", () => {
  it("lists the 5 built-ins", async () => {
    const { tools } = await env();
    const out = await call(tools.orch_workflows, { action: "list" });
    for (const name of [
      "chain-draft-refine",
      "route-by-intent",
      "parallel-review",
      "orchestrate-tasks",
      "evaluator-loop",
    ]) {
      expect(out).toContain(name);
    }
  });

  it("shows info for one workflow and errors otherwise", async () => {
    const { tools } = await env();
    const info = await call(tools.orch_workflows, {
      action: "info",
      name: "route-by-intent",
    });
    expect(info).toContain("route-by-intent [routing]");
    expect(info).toContain("Routes:");
    expect(info).toContain("code → code");

    expect(await call(tools.orch_workflows, { action: "info" })).toBe(
      "Error: `name` is required for action=info"
    );
    expect(
      await call(tools.orch_workflows, { action: "info", name: "nope" })
    ).toStartWith('Error: Workflow "nope" not found.');
  });

  it("validates and saves model-authored JSON without executing code", async () => {
    const { e, tools } = await env();
    const definition = JSON.stringify({
      version: 1,
      name: "deepseek-review",
      description: "Review with DeepSeek",
      pattern: "chain",
      steps: [
        {
          id: "review",
          model: { providerID: "deepseek", modelID: "deepseek-chat" },
          instructions: "Review {{input}}",
        },
      ],
    });
    expect(await call(tools.orch_workflows, { action: "validate", definition })).toContain(
      "Valid workflow IR v1"
    );
    expect(await call(tools.orch_workflows, { action: "save", definition })).toContain(
      "Saved workflow IR v1"
    );
    expect(e.workflows.require("deepseek-review").steps[0].model).toEqual({
      providerID: "deepseek",
      modelID: "deepseek-chat",
    });
  });
});

describe("orch_runs", () => {
  it("reports empty state, then lists runs newest-first with filters", async () => {
    const { e, tools } = await env();
    expect(await call(tools.orch_runs, {})).toBe("No runs yet.");

    const id = await completedChainRun(e, tools);
    e.store.createRun(manualRun("run_manual_1", { status: "failed", createdAt: Date.now() + 1 }));

    const all = await call(tools.orch_runs, {});
    expect(all).toContain(id);
    expect(all).toContain("run_manual_1");
    // newest first
    expect(all.indexOf("run_manual_1")).toBeLessThan(all.indexOf(id));

    const failedOnly = await call(tools.orch_runs, { status: "failed" });
    expect(failedOnly).toContain("run_manual_1");
    expect(failedOnly).not.toContain(id);

    expect(await call(tools.orch_runs, { status: "cancelled" })).toBe("No cancelled runs.");
  });
});

describe("orch_status", () => {
  it("shows run detail by id and by unique prefix", async () => {
    const { e, tools } = await env();
    const id = await completedChainRun(e, tools);

    const full = await call(tools.orch_status, { run: id });
    expect(full).toContain(`${id} — chain-draft-refine [chain] — completed`);
    expect(full).toContain("[completed] draft");
    expect(full).toContain("[completed] refine");

    const byPrefix = await call(tools.orch_status, { run: id.slice(0, 12) });
    expect(byPrefix).toContain(id);
  });

  it("returns Error: for unknown and ambiguous run ids", async () => {
    const { e, tools } = await env();
    expect(await call(tools.orch_status, { run: "run_zzz" })).toBe(
      'Error: Run "run_zzz" not found'
    );

    e.store.createRun(manualRun("run_dup_aaa1"));
    e.store.createRun(manualRun("run_dup_aaa2"));
    const out = await call(tools.orch_status, { run: "run_dup_aaa" });
    expect(out).toStartWith('Error: run id prefix "run_dup_aaa" is ambiguous');
    expect(out).toContain("run_dup_aaa1");
    expect(out).toContain("run_dup_aaa2");
  });

  it("shows copiedFiles, conflicts, and isolationFallback for worktree steps", async () => {
    const { e, tools } = await env();
    const now = Date.now();
    e.store.createRun(
      manualRun("run_wt_1", {
        steps: {
          w1: {
            id: "w1",
            status: "completed",
            copiedFiles: ["a.txt", "b.txt"],
            startedAt: now,
            completedAt: now,
          },
          w2: {
            id: "w2",
            status: "completed",
            copiedFiles: ["shared.txt"],
            conflicts: ["shared.txt"],
            startedAt: now,
            completedAt: now,
          },
          w3: {
            id: "w3",
            status: "completed",
            isolationFallback: true,
            startedAt: now,
            completedAt: now,
          },
        },
      })
    );

    const out = await call(tools.orch_status, { run: "run_wt_1" });
    expect(out).toContain("copied 2 file(s) from worktree");
    expect(out).toContain("copied 1 file(s) from worktree");
    expect(out).toContain("conflicts: shared.txt");
    expect(out).toContain("isolation fallback: ran in main directory");
  });
});

describe("orch_result", () => {
  it("returns summary, detailed, and json formats for a completed run", async () => {
    const { e, tools } = await env();
    const id = await completedChainRun(e, tools);

    const summary = await call(tools.orch_result, { run: id });
    expect(summary).toBe("final out");

    const detailed = await call(tools.orch_result, { run: id, format: "detailed" });
    expect(detailed).toContain("## draft [completed]");
    expect(detailed).toContain("draft out");
    expect(detailed).toContain("## refine [completed]");

    const json = await call(tools.orch_result, { run: id, format: "json" });
    const parsed = JSON.parse(json);
    expect(parsed.id).toBe(id);
    expect(parsed.output).toBe("final out");
  });

  it("handles running, failed, and unknown runs", async () => {
    const { e, tools } = await env();
    // running
    const started = await call(tools.orch_run, {
      workflow: "chain-draft-refine",
      input: "x",
    });
    const runningID = /Run (\S+) started/.exec(started)![1];
    expect(await call(tools.orch_result, { run: runningID })).toContain("still running");
    await e.runner.cancel(runningID);

    // failed
    e.store.createRun(manualRun("run_fail_1", { status: "failed", error: "kaput" }));
    expect(await call(tools.orch_result, { run: "run_fail_1" })).toContain(
      "failed: kaput"
    );

    // unknown
    expect(await call(tools.orch_result, { run: "run_zzz" })).toBe(
      'Error: Run "run_zzz" not found'
    );
  });
});

describe("orch_cancel", () => {
  it("cancels a running run and aborts its sessions", async () => {
    const { e, tools } = await env();
    const started = await call(tools.orch_run, {
      workflow: "chain-draft-refine",
      input: "x",
    });
    const id = /Run (\S+) started/.exec(started)![1];
    // wait for the step session to exist
    await waitFor(() => e.client.prompts.length === 1, "step session");
    const sid = e.client.prompts[0].sessionID;

    const out = await call(tools.orch_cancel, { run: id });
    expect(out).toBe(`Run ${id} cancelled.`);
    expect(e.client.aborts).toContain(sid);
    expect(e.store.getRun(id)!.status).toBe("cancelled");
  });

  it("returns Error: for unknown or finished runs", async () => {
    const { e, tools } = await env();
    expect(await call(tools.orch_cancel, { run: "run_zzz" })).toBe(
      'Error: Run "run_zzz" not found'
    );
    const id = await completedChainRun(e, tools);
    expect(await call(tools.orch_cancel, { run: id })).toStartWith(
      `Error: Run ${id} is already completed`
    );
  });
});

describe("orch_control", () => {
  it("pauses, resumes, cancels, and retries through one lifecycle tool", async () => {
    const { e, tools } = await env();
    const started = await call(tools.orch_run, {
      workflow: "chain-draft-refine",
      input: "x",
    });
    const id = /Run (\S+) started/.exec(started)![1];
    await waitFor(() => e.client.prompts.length === 1, "step session");
    expect(await call(tools.orch_control, { action: "pause", run: id })).toContain("paused");
    expect(e.store.getRun(id)?.status).toBe("paused");
    expect(await call(tools.orch_control, { action: "resume", run: id })).toContain("resumed");
    expect(e.store.getRun(id)?.status).toBe("running");
    expect(await call(tools.orch_control, { action: "cancel", run: id })).toContain("cancelled");
    expect(e.store.getRun(id)?.status).toBe("cancelled");
    expect(await call(tools.orch_control, { action: "retry", run: id })).toContain("retrying");
    await waitFor(() => e.client.prompts.length === 2, "retried first step");
    e.cursor = 1;
    await completePrompt(e, "draft retry");
    await completePrompt(e, "final retry");
    expect((await waitForRun(e, id)).status).toBe("completed");
  });
});

describe("orch_goal", () => {
  it("sets, reports, and clears a session-scoped DeepSeek goal", async () => {
    const { tools } = await env();
    const context = { sessionID: "lead" } as never;
    const set = (await tools.orch_goal.execute(
      {
        action: "set",
        condition: "tests pass",
        evaluatorProvider: "deepseek",
        evaluatorModel: "deepseek-chat",
      },
      context
    )) as string;
    expect(set).toContain("Goal active: tests pass");
    expect((await tools.orch_goal.execute({ action: "status" }, context)) as string).toContain(
      "Evaluator: deepseek/deepseek-chat"
    );
    expect((await tools.orch_goal.execute({ action: "clear" }, context)) as string).toContain(
      "Goal cleared"
    );
  });
});

describe("orch_log", () => {
  function makeLogDir(): string {
    const dir = tmpProject("orch-log-test-");
    dirs.push(dir);
    fs.writeFileSync(
      path.join(dir, "2026-07-28T00-00-00.log"),
      [
        "INFO service=app unrelated line",
        "INFO [orch] ready · 7 tools",
        "WARN [orch] workflow load: bad.json: broken",
        "ERROR [orch] run run_x (chain) failed: boom",
        "INFO service=opencode-plugin-orch something",
        "DEBUG noise",
        "",
      ].join("\n"),
      "utf-8"
    );
    return dir;
  }

  it("tails plugin lines, filters errors, and counts stats", async () => {
    const dir = makeLogDir();
    const log = createLogTool({ findLogDir: () => dir });

    const tail = await call(log, { action: "tail" });
    expect(tail).toContain("[orch] ready · 7 tools");
    expect(tail).toContain("opencode-plugin-orch something");
    expect(tail).not.toContain("unrelated line");

    const tail1 = await call(log, { action: "tail", lines: 1 });
    expect(tail1).toContain("Last 1 plugin line(s)");
    expect(tail1).toContain("opencode-plugin-orch something");
    expect(tail1).not.toContain("ready · 7 tools");

    const errors = await call(log, { action: "errors" });
    expect(errors).toContain("1 plugin error line(s)");
    expect(errors).toContain("failed: boom");

    const stats = await call(log, { action: "stats" });
    expect(stats).toContain("2 INFO, 1 WARN, 1 ERROR");
  });

  it("returns Error: when no log directory exists", async () => {
    const log = createLogTool({ findLogDir: () => undefined });
    expect(await call(log, { action: "tail" })).toStartWith(
      "Error: could not locate opencode log directory"
    );
  });

  it("is included in createTools and never throws", async () => {
    const { tools } = await env();
    const out = await call(tools.orch_log, { action: "tail" });
    expect(typeof out).toBe("string"); // real home dir: either lines or Error:
  });
});

describe("createTools", () => {
  it("wires exactly the 9 orch_* tools", async () => {
    const { tools } = await env();
    expect(Object.keys(tools).sort()).toEqual([
      "orch_cancel",
      "orch_control",
      "orch_goal",
      "orch_log",
      "orch_result",
      "orch_run",
      "orch_runs",
      "orch_status",
      "orch_workflows",
    ]);
  });
});
