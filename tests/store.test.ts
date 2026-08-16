import { describe, it, expect, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { Store, genID } from "../src/state/store.js";
import type { Run, StoreEvent } from "../src/state/schemas.js";
import { tmpProject, rmrf } from "./_harness.js";

let dirs: string[] = [];
let stores: Store[] = [];

function makeRun(id: string, over: Partial<Run> = {}): Run {
  return {
    id,
    workflow: "chain-draft-refine",
    pattern: "chain",
    input: "hello",
    status: "running",
    config: { maxIterations: 3, concurrency: 4, stepTimeoutMs: 600_000 },
    steps: {},
    iteration: 0,
    createdAt: Date.now(),
    ...over,
  };
}

async function makeStore(dir?: string): Promise<{ store: Store; dir: string }> {
  const d = dir ?? tmpProject();
  const store = new Store(d);
  await store.init();
  dirs.push(d);
  stores.push(store);
  return { store, dir: d };
}

function storeDir(dir: string): string {
  return path.join(dir, ".opencode", "plugin-orch");
}

afterEach(() => {
  for (const s of stores) s.destroy();
  stores = [];
  for (const d of dirs) rmrf(d);
  dirs = [];
});

describe("Store event append", () => {
  it("appends events to runs.jsonl and applies them in memory", async () => {
    const { store, dir } = await makeStore();
    const run = makeRun("run_a1");
    store.createRun(run);
    store.startStep(run.id, {
      id: "draft",
      status: "running",
      sessionID: "sess_1",
      startedAt: Date.now(),
    });
    store.completeStep(run.id, {
      id: "draft",
      status: "completed",
      sessionID: "sess_1",
      output: "draft text",
      completedAt: Date.now(),
    });
    store.completeRun(run.id, "final output");

    const got = store.getRun("run_a1")!;
    expect(got.status).toBe("completed");
    expect(got.output).toBe("final output");
    expect(got.steps.draft.status).toBe("completed");
    expect(got.steps.draft.output).toBe("draft text");

    const view = JSON.parse(
      fs.readFileSync(path.join(storeDir(dir), "view.json"), "utf-8")
    ) as { runs: Record<string, Run> };
    expect(view.runs.run_a1.status).toBe("completed");
    expect(view.runs.run_a1.output).toBe("final output");

    const lines = fs
      .readFileSync(path.join(storeDir(dir), "runs.jsonl"), "utf-8")
      .split("\n")
      .filter(Boolean);
    expect(lines.map((l) => (JSON.parse(l) as StoreEvent).type)).toEqual([
      "run_created",
      "step_started",
      "step_completed",
      "run_completed",
    ]);
  });

  it("records failures and cancellations", async () => {
    const { store } = await makeStore();
    store.createRun(makeRun("run_b1"));
    store.failRun("run_b1", "boom");
    expect(store.getRun("run_b1")!.status).toBe("failed");
    expect(store.getRun("run_b1")!.error).toBe("boom");

    store.createRun(makeRun("run_b2"));
    store.cancelRun("run_b2");
    expect(store.getRun("run_b2")!.status).toBe("cancelled");
  });

  it("ignores step events for runs that already left `running`", async () => {
    const { store } = await makeStore();
    store.createRun(makeRun("run_c1"));
    store.completeRun("run_c1", "done");
    // A late parallel branch reports after completion — must be dropped.
    store.completeStep("run_c1", {
      id: "late",
      status: "completed",
      output: "late",
    });
    expect(store.getRun("run_c1")!.steps.late).toBeUndefined();
  });
});

describe("Store snapshot + replay", () => {
  it("preserves workflow steering across restart recovery", async () => {
    const { store, dir } = await makeStore();
    store.createRun(makeRun("run_steer"));
    store.steerRun("run_steer", {
      text: "verify the live boundary",
      createdAt: Date.now(),
      deliveredTo: ["sess_1"],
    });
    store.destroy();
    stores.pop();

    const store2 = new Store(dir);
    stores.push(store2);
    await store2.init();
    expect(store2.getRun("run_steer")?.status).toBe("paused");
    expect(store2.getRun("run_steer")?.steering.at(-1)?.text).toBe(
      "verify the live boundary"
    );
  });

  it("snapshot on destroy preserves state across reload", async () => {
    const { store, dir } = await makeStore();
    store.createRun(makeRun("run_d1"));
    store.completeRun("run_d1", "kept");
    store.destroy();
    stores.pop(); // already destroyed

    expect(fs.existsSync(path.join(storeDir(dir), "snapshot.json"))).toBe(true);

    const store2 = new Store(dir);
    stores.push(store2);
    await store2.init();
    expect(store2.getRun("run_d1")!.status).toBe("completed");
    expect(store2.getRun("run_d1")!.output).toBe("kept");
  });

  it("replays the JSONL log and skips malformed lines", async () => {
    const dir = tmpProject();
    dirs.push(dir);
    fs.mkdirSync(storeDir(dir), { recursive: true });
    const run = makeRun("run_e1");
    const events: StoreEvent[] = [
      { type: "run_created", timestamp: Date.now() - 10, data: run },
      {
        type: "run_completed",
        timestamp: Date.now(),
        data: { runID: run.id, output: "from log", completedAt: Date.now() },
      },
    ];
    fs.writeFileSync(
      path.join(storeDir(dir), "runs.jsonl"),
      events.map((e) => JSON.stringify(e)).join("\n") + "\n{not json\n",
      "utf-8"
    );

    const store = new Store(dir);
    stores.push(store);
    await store.init();
    expect(store.getRun("run_e1")!.status).toBe("completed");
    expect(store.getRun("run_e1")!.output).toBe("from log");
  });

  it("falls back to the event log when snapshot.json is corrupt", async () => {
    const dir = tmpProject();
    dirs.push(dir);
    fs.mkdirSync(storeDir(dir), { recursive: true });
    fs.writeFileSync(path.join(storeDir(dir), "snapshot.json"), "{{{corrupt", "utf-8");
    const run = makeRun("run_f1");
    const evt: StoreEvent = {
      type: "run_created",
      timestamp: Date.now(),
      data: run,
    };
    fs.writeFileSync(
      path.join(storeDir(dir), "runs.jsonl"),
      JSON.stringify(evt) + "\n",
      "utf-8"
    );

    const store = new Store(dir);
    stores.push(store);
    await store.init(); // must not throw
    // run_created replayed, then recovered at an explicit paused boundary.
    expect(store.getRun("run_f1")!.status).toBe("paused");
  });
});

describe("Store recovery", () => {
  it("recovers runs as paused and marks only the interrupted step cancelled", async () => {
    const { store, dir } = await makeStore();
    store.createRun(makeRun("run_g1"));
    store.startStep("run_g1", {
      id: "draft",
      status: "running",
      sessionID: "sess_9",
      startedAt: Date.now(),
    });
    store.destroy();
    stores.pop();

    const store2 = new Store(dir);
    stores.push(store2);
    await store2.init();
    const got = store2.getRun("run_g1")!;
    expect(got.status).toBe("paused");
    expect(got.error).toBeUndefined();
    expect(got.steps.draft.status).toBe("cancelled");
    expect(got.steps.draft.error).toContain("plugin restarted");
    expect(store2.interruptedSessions).toEqual([{ sessionID: "sess_9" }]);
  });
});

describe("Store queries", () => {
  it("findRun resolves exact ids and unique prefixes, throws on ambiguity", async () => {
    const { store } = await makeStore();
    store.createRun(makeRun("run_h_aaa1"));
    store.createRun(makeRun("run_h_aaa2"));
    store.createRun(makeRun("run_h_bbb1"));

    expect(store.findRun("run_h_aaa1")!.id).toBe("run_h_aaa1");
    expect(store.findRun("run_h_bbb")!.id).toBe("run_h_bbb1");
    expect(store.findRun("run_h_zzz")).toBeUndefined();
    expect(() => store.findRun("run_h_aaa")).toThrow(/ambiguous/);
  });

  it("listRuns returns newest first", async () => {
    const { store } = await makeStore();
    store.createRun(makeRun("run_i1", { createdAt: 1000 }));
    store.createRun(makeRun("run_i2", { createdAt: 3000 }));
    store.createRun(makeRun("run_i3", { createdAt: 2000 }));
    expect(store.listRuns().map((r) => r.id)).toEqual(["run_i2", "run_i3", "run_i1"]);
  });

  it("genID produces unique prefixed ids", () => {
    const a = genID("run");
    const b = genID("run");
    expect(a).toStartWith("run_");
    expect(a).not.toBe(b);
  });
});
