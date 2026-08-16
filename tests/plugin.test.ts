import { describe, it, expect, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import type { PluginInput, Hooks } from "@opencode-ai/plugin";
import { plugin } from "../src/plugin.js";
import { FakeClient, tmpProject, rmrf, waitFor } from "./_harness.js";

let dirs: string[] = [];
let cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const c of cleanups) await c();
  cleanups = [];
  // dispose() rejects in-flight runs; their execute() continuation writes a
  // failRun event asynchronously. Let it land before removing the store dir.
  await new Promise((r) => setTimeout(r, 20));
  for (const d of dirs) rmrf(d);
  dirs = [];
});

function tmp(): string {
  const d = tmpProject("orch-plugin-test-");
  dirs.push(d);
  return d;
}

function fakeInput(directory: string, client = new FakeClient()): PluginInput {
  return {
    client,
    directory,
    project: {},
    worktree: directory,
    serverUrl: new URL("http://localhost:4096"),
    $: {},
  } as unknown as PluginInput;
}

/** Poll orch_status until it contains `needle` (run state settles async). */
async function statusUntil(
  hooks: Hooks,
  runID: string,
  needle: string
): Promise<string> {
  let status = "";
  for (let i = 0; i < 200; i++) {
    status = (await hooks.tool!.orch_status.execute(
      { run: runID },
      {} as never
    )) as string;
    if (status.includes(needle)) return status;
    await new Promise((r) => setTimeout(r, 5));
  }
  return status;
}

describe("plugin()", () => {
  it("wires hooks and returns exactly 9 tools", async () => {
    const hooks = await plugin(fakeInput(tmp()));
    cleanups.push(() => hooks.dispose?.());
    expect(Object.keys(hooks.tool ?? {}).sort()).toEqual([
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
    expect(typeof hooks.event).toBe("function");
  });

  it("registers goal, authoring, run, discovery, and saved-workflow commands", async () => {
    const hooks = await plugin(fakeInput(tmp()));
    cleanups.push(() => hooks.dispose?.());
    const config: { command?: Record<string, unknown> } = {};
    await hooks.config!(config as never);
    const names = Object.keys(config.command ?? {});
    for (const name of [
      "goal",
      "workflows",
      "workflow-author",
      "workflow-run",
      "chain-draft-refine",
    ]) {
      expect(names).toContain(name);
    }

    const output = { parts: [{ type: "text", text: "original" }] };
    await hooks["command.execute.before"]!(
      { command: "goal", sessionID: "lead", arguments: "all tests pass" },
      output as never
    );
    expect(output.parts[0].text).toContain("Goal: all tests pass");
  });

  it("returns {} without throwing when init fails", async () => {
    // A directory path that is actually a file makes Store.init's mkdir fail.
    const dir = tmp();
    const fileDir = path.join(dir, "not-a-dir");
    fs.writeFileSync(fileDir, "x", "utf-8");

    const hooks = await plugin(fakeInput(fileDir));
    expect(hooks).toEqual({});
  });

  it("is dormant inside .orch-worktrees: no hooks, no files created", async () => {
    // A worktree's own opencode instance loads the plugin too; it must go
    // fully dormant there (the lead instance drives workers via the API).
    const dir = path.join(tmp(), ".orch-worktrees", "proj", "run_1", "worker-1");
    fs.mkdirSync(dir, { recursive: true });

    const hooks = await plugin(fakeInput(dir));
    expect(hooks).toEqual({});
    expect(hooks.tool).toBeUndefined();
    // No store/reporter writes in the worktree.
    expect(fs.existsSync(path.join(dir, ".opencode"))).toBe(false);
  });

  it('stepPermissions: "ask" via plugin options disables the auto-allow', async () => {
    const client = new FakeClient();
    const hooks: Hooks = await plugin(fakeInput(tmp(), client), {
      stepPermissions: "ask",
    });
    cleanups.push(() => hooks.dispose?.());

    await hooks.tool!.orch_run.execute(
      { workflow: "chain-draft-refine", input: "hello", background: true },
      {} as never
    );
    await waitFor(() => client.prompts.length === 1, "step session");

    // Tracked step session, but the hook leaves the output untouched.
    const output: { status?: string } = {};
    await hooks["permission.ask"]!(
      { sessionID: client.prompts[0].sessionID, metadata: { command: "npm test" } } as never,
      output as never
    );
    expect(output.status).toBeUndefined();
  });

  it("unknown stepPermissions values fall back to auto without throwing", async () => {
    const client = new FakeClient();
    const hooks: Hooks = await plugin(fakeInput(tmp(), client), {
      stepPermissions: "yolo",
    });
    cleanups.push(() => hooks.dispose?.());
    expect(Object.keys(hooks.tool ?? {}).length).toBe(9); // init succeeded

    await hooks.tool!.orch_run.execute(
      { workflow: "chain-draft-refine", input: "hello", background: true },
      {} as never
    );
    await waitFor(() => client.prompts.length === 1, "step session");

    const output: { status?: string } = {};
    await hooks["permission.ask"]!(
      { sessionID: client.prompts[0].sessionID, metadata: { command: "npm test" } } as never,
      output as never
    );
    expect(output.status).toBe("allow"); // auto behavior
  });

  it("routes session.idle events to the runner", async () => {
    const client = new FakeClient();
    const hooks: Hooks = await plugin(fakeInput(tmp(), client));
    cleanups.push(() => hooks.dispose?.());

    const started = (await hooks.tool!.orch_run.execute(
      { workflow: "chain-draft-refine", input: "hello", background: true },
      {} as never
    )) as string;
    const runID = /Run (\S+) started/.exec(started)![1];

    // First step session is created and prompted.
    await waitFor(() => client.prompts.length === 1, "draft prompt");
    const draft = client.prompts[0];
    expect(draft.stepID).toBe("draft");

    // Fire session.idle through the event hook — the runner should collect
    // the output and advance the chain to the refine step.
    client.setOutput(draft.sessionID, "draft text");
    await hooks.event!({
      event: {
        type: "session.idle",
        properties: { sessionID: draft.sessionID },
      },
    } as never);

    await waitFor(() => client.prompts.length === 2, "refine prompt");
    expect(client.prompts[1].stepID).toBe("refine");
    expect(client.prompts[1].text).toContain("draft text");

    // Finish the run through the event hook too.
    client.setOutput(client.prompts[1].sessionID, "refined text");
    await hooks.event!({
      event: {
        type: "session.idle",
        properties: { sessionID: client.prompts[1].sessionID },
      },
    } as never);

    // The chain's completion continuation runs on microtasks after idle.
    const status = await statusUntil(hooks, runID, "— completed");
    expect(status).toContain("— completed");
  });

  it("routes session.error events to the runner and never throws", async () => {
    const client = new FakeClient();
    const hooks: Hooks = await plugin(fakeInput(tmp(), client));
    cleanups.push(() => hooks.dispose?.());

    const started = (await hooks.tool!.orch_run.execute(
      { workflow: "chain-draft-refine", input: "hello", background: true },
      {} as never
    )) as string;
    const runID = /Run (\S+) started/.exec(started)![1];
    await waitFor(() => client.prompts.length === 1, "draft prompt");

    await hooks.event!({
      event: {
        type: "session.error",
        properties: {
          sessionID: client.prompts[0].sessionID,
          // Non-transient — a transient message would trigger a step retry.
          error: { name: "ProviderError", data: { message: "provider blew up" } },
        },
      },
    } as never);

    const status = await statusUntil(hooks, runID, "— failed");
    expect(status).toContain("provider blew up");

    // Unknown event types and idle for unknown sessions are ignored.
    await hooks.event!({ event: { type: "session.idle", properties: { sessionID: "nope" } } } as never);
    await hooks.event!({ event: { type: "message.updated", properties: {} } } as never);
  });
});
