// Regression: every opencode SDK call that accepts `query.directory` must
// be threaded with the plugin's `ctx.directory`. Without it, the opencode
// server routes session ops to the wrong project in git worktrees (where
// multiple project directories are registered), manifesting as code-type
// team members spawning but immediately erroring because the custom
// agent config ("code", defined in the worktree dir) can't be resolved
// from whatever default dir the server picked.
//
// These tests simply assert that the recorded call args on the MockClient
// carry `query.directory === harness.tmpDir` for every wrapped SDK call.

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { createHarness, makeToolContext, sessionIdleEvent, sessionErrorEvent, type Harness } from "./_harness.js";
import { revalidateMemberSessions } from "../src/core/revalidate.js";
import type { PluginInput } from "@opencode-ai/plugin";

type Args = { query?: { directory?: string } };

function dirOf(args: unknown): string | undefined {
  return (args as Args).query?.directory;
}

describe("directory routing — every SDK call carries ctx.directory", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await createHarness();
  });
  afterEach(() => { h.cleanup(); });

  test("orch_spawn: session.create, tool.ids, session.promptAsync all pass directory", async () => {
    h.manager.createTeam("t1", "lead-session");
    await h.tools.orch_spawn.execute(
      { team: "t1", role: "coder", instructions: "x" },
      makeToolContext("lead-session")
    );

    const create = h.client.callsFor("session.create");
    const toolIds = h.client.callsFor("tool.ids");
    const promptAsync = h.client.callsFor("session.promptAsync");

    expect(create).toHaveLength(1);
    expect(toolIds).toHaveLength(1);
    expect(promptAsync).toHaveLength(1);

    expect(dirOf(create[0].args)).toBe(h.tmpDir);
    expect(dirOf(toolIds[0].args)).toBe(h.tmpDir);
    expect(dirOf(promptAsync[0].args)).toBe(h.tmpDir);
  });

  test("orch_spawn with files: file.read and session.prompt (seed) pass directory", async () => {
    h.manager.createTeam("t1", "lead-session");
    h.client.registerFile("src/foo.ts", "export const foo = 1;");
    h.client.registerFile("src/bar.ts", "export const bar = 2;");

    await h.tools.orch_spawn.execute(
      {
        team: "t1",
        role: "reader",
        instructions: "read",
        files: "src/foo.ts, src/bar.ts",
      },
      makeToolContext("lead-session")
    );

    const reads = h.client.callsFor("file.read");
    const seeds = h.client.callsFor("session.prompt");

    expect(reads).toHaveLength(2);
    for (const r of reads) {
      expect((r.args as { query: { directory?: string } }).query.directory).toBe(h.tmpDir);
    }

    expect(seeds.length).toBeGreaterThanOrEqual(1);
    expect(dirOf(seeds[0].args)).toBe(h.tmpDir);
  });

  test("orch_shutdown: session.abort passes directory", async () => {
    h.manager.createTeam("t1", "lead-session");
    await h.tools.orch_spawn.execute(
      { team: "t1", role: "coder", instructions: "x" },
      makeToolContext("lead-session")
    );

    await h.tools.orch_shutdown.execute(
      { team: "t1", role: "coder" },
      makeToolContext("lead-session")
    );

    const aborts = h.client.callsFor("session.abort");
    expect(aborts.length).toBeGreaterThanOrEqual(1);
    expect(dirOf(aborts[0].args)).toBe(h.tmpDir);
  });

  test("message delivery: session.promptAsync to a member passes directory", async () => {
    h.manager.createTeam("msg", "lead-session");
    await h.tools.orch_spawn.execute(
      { team: "msg", role: "alpha", instructions: "x" },
      makeToolContext("lead-session")
    );

    // Clear the spawn-side promptAsync calls so we can see just the delivery
    // call.
    const before = h.client.callsFor("session.promptAsync").length;

    // Queue a message then fire session.idle to trigger delivery.
    await h.tools.orch_message.execute(
      { team: "msg", to: "alpha", content: "hello" },
      makeToolContext("lead-session")
    );
    await h.fireEvent(sessionIdleEvent("mock-session-1"));

    const after = h.client.callsFor("session.promptAsync");
    expect(after.length).toBeGreaterThan(before);
    const delivery = after[after.length - 1];
    expect(dirOf(delivery.args)).toBe(h.tmpDir);
  });

  test("escalation respawn: session.create + session.promptAsync pass directory", async () => {
    h.manager.createTeam("esc", "lead-session", {
      escalation: {
        enabled: true,
        maxRetries: 0,
        chain: [
          { providerID: "anthropic", modelID: "sonnet" },
          { providerID: "anthropic", modelID: "opus" },
        ],
      },
    });
    await h.tools.orch_spawn.execute(
      { team: "esc", role: "coder", instructions: "retry me" },
      makeToolContext("lead-session")
    );

    const createBefore = h.client.callsFor("session.create").length;
    const promptBefore = h.client.callsFor("session.promptAsync").length;

    // Fire session.error — triggers escalation path → respawn.
    await h.fireEvent(sessionErrorEvent("mock-session-1"));

    const createAfter = h.client.callsFor("session.create");
    const promptAfter = h.client.callsFor("session.promptAsync");

    expect(createAfter.length).toBeGreaterThan(createBefore);
    expect(promptAfter.length).toBeGreaterThan(promptBefore);

    const respawnCreate = createAfter[createAfter.length - 1];
    const respawnPrompt = promptAfter[promptAfter.length - 1];
    expect(dirOf(respawnCreate.args)).toBe(h.tmpDir);
    expect(dirOf(respawnPrompt.args)).toBe(h.tmpDir);
  });

  test("work stealing: session.promptAsync on stolen task passes directory", async () => {
    h.manager.createTeam("steal", "lead-session", { workStealing: true });
    await h.tools.orch_spawn.execute(
      { team: "steal", role: "worker", instructions: "x" },
      makeToolContext("lead-session")
    );

    // Add an unclaimed task to the board.
    await h.tools.orch_tasks.execute(
      {
        team: "steal",
        action: "add",
        title: "implement thing",
        description: "do it",
      },
      makeToolContext("lead-session")
    );

    const before = h.client.callsFor("session.promptAsync").length;
    await h.fireEvent(sessionIdleEvent("mock-session-1"));
    const after = h.client.callsFor("session.promptAsync");

    // If the steal fired, its promptAsync is the new tail call.
    expect(after.length).toBeGreaterThan(before);
    const stealCall = after[after.length - 1];
    expect(dirOf(stealCall.args)).toBe(h.tmpDir);
  });

  test("revalidate: session.get passes directory", async () => {
    h.manager.createTeam("rv", "lead-session");
    await h.tools.orch_spawn.execute(
      { team: "rv", role: "alpha", instructions: "x" },
      makeToolContext("lead-session")
    );

    // Drop prior calls to make the assertion unambiguous.
    h.client.calls = [];

    const ctx = {
      client: h.client,
      project: { id: "test-project" },
      directory: h.tmpDir,
      worktree: h.tmpDir,
      serverUrl: new URL("http://localhost:0"),
      $: null,
    } as unknown as PluginInput;

    await revalidateMemberSessions(h.store, h.fileLocks, ctx, h.reporter);

    const probes = h.client.callsFor("session.get");
    expect(probes.length).toBeGreaterThanOrEqual(1);
    for (const p of probes) {
      expect(dirOf(p.args)).toBe(h.tmpDir);
    }
  });
});
