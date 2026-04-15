// Tests for session revalidation on plugin init.
//
// Flow: spawn members into a harness, destroy (snapshots state to disk),
// then invoke plugin() pointing at the same tmpdir with a fresh MockClient
// so the revalidation path runs on recovered state. Finally read state
// back via a fresh Store to assert the outcome.

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { PluginInput } from "@opencode-ai/plugin";
import { plugin } from "../src/plugin.js";
import { Store } from "../src/state/store.js";
import { createHarness, MockClient, type Harness } from "./_harness.js";

function makeInput(client: MockClient, tmpDir: string): PluginInput {
  return {
    client,
    project: { id: "test-project" },
    directory: tmpDir,
    worktree: tmpDir,
    serverUrl: new URL("http://localhost:0"),
    $: null,
  } as unknown as PluginInput;
}

// Read back member state via a fresh Store on the same tmpdir.
async function readMembers(tmpDir: string) {
  const s = new Store(tmpDir);
  await s.init();
  const teams = s.listTeams();
  const all = teams.flatMap((t) => s.listMembers(t.id));
  s.destroy();
  return all;
}

describe("session revalidation", () => {
  let h: Harness;
  let tmpDir: string;

  beforeEach(async () => {
    h = await createHarness();
    tmpDir = h.tmpDir;
    h.manager.createTeam("rv", "lead-session");
    // Spawn 2 members; harness MockClient.session.create records them so
    // default session.get on that same client would resolve.
    await h.tools.orch_spawn.execute(
      { team: "rv", role: "alpha", instructions: "x" },
      { sessionID: "lead-session", messageID: "m", agent: "build", directory: tmpDir, worktree: tmpDir, abort: new AbortController().signal, metadata: () => {}, ask: async () => {} }
    );
    await h.tools.orch_spawn.execute(
      { team: "rv", role: "beta", instructions: "x" },
      { sessionID: "lead-session", messageID: "m", agent: "build", directory: tmpDir, worktree: tmpDir, abort: new AbortController().signal, metadata: () => {}, ask: async () => {} }
    );
    // Snapshot + close the harness store; do NOT rm the tmpdir.
    h.store.destroy();
  });

  afterEach(() => {
    // Each plugin() call registers a `beforeExit` handler that snapshots the
    // store on exit. Across many tests those accumulate and later fire against
    // tmpdirs that have already been rm'd. Trigger + strip them now so cleanup
    // is idempotent and the tmpdir can be safely removed after.
    process.emit("beforeExit", 0);
    process.removeAllListeners("beforeExit");
    process.removeAllListeners("SIGINT");
    process.removeAllListeners("SIGTERM");
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("dead session → member is marked shutdown and info toast fires", async () => {
    // Fresh client has empty sessions map, so default session.get will 404
    // for every recovered member → they should all be cleaned up.
    const client = new MockClient();
    const hooks = await plugin(makeInput(client, tmpDir));
    expect(hooks.tool).toBeDefined();

    // Every recovered member should now be in `shutdown` state.
    const members = await readMembers(tmpDir);
    expect(members.length).toBe(2);
    for (const m of members) expect(m.state).toBe("shutdown");

    // Both probes ran.
    expect(client.callsFor("session.get").length).toBe(2);

    // Reporter fired the cleanup info toast.
    const cleanup = client.toasts.find(
      (t) => t.variant === "info" && t.message.includes("cleaned")
    );
    expect(cleanup).toBeDefined();
    expect(cleanup!.message).toContain("2");
  });

  test("live session → recovered member state is preserved", async () => {
    // Pre-populate the new client's sessions map with every known session id
    // so its default session.get resolves cleanly.
    const client = new MockClient();
    const beforeMembers = await readMembers(tmpDir);
    for (const m of beforeMembers) {
      client.sessions.set(m.sessionID, { id: m.sessionID });
    }
    // Capture pre-revalidation states (typically "initializing" right after spawn).
    const priorStates = new Map(beforeMembers.map((m) => [m.id, m.state]));

    const hooks = await plugin(makeInput(client, tmpDir));
    expect(hooks.tool).toBeDefined();

    const afterMembers = await readMembers(tmpDir);
    expect(afterMembers.length).toBe(beforeMembers.length);
    for (const m of afterMembers) {
      expect(m.state).toBe(priorStates.get(m.id));
    }
    // No "cleaned N stale member" toast.
    const cleanup = client.toasts.find((t) => t.message.includes("cleaned"));
    expect(cleanup).toBeUndefined();
  });

  test(
    "session.get hang → members NOT marked shutdown, init stays under 5s",
    async () => {
      const client = new MockClient();
      // Monkey-patch session.get to return a never-resolving promise.
      client.session.get = async () => new Promise(() => {});

      const start = Date.now();
      const hooks = await plugin(makeInput(client, tmpDir));
      const elapsed = Date.now() - start;

      // Init must complete well inside the 5s budget — per-call 500ms timeout
      // runs 2 probes in parallel, so total revalidation wait ≈ 500ms.
      expect(elapsed).toBeLessThan(4000);
      expect(hooks.tool).toBeDefined();

      // Optimistic fallback: hanging probe should NOT mark members shutdown.
      const members = await readMembers(tmpDir);
      for (const m of members) expect(m.state).not.toBe("shutdown");
      const cleanup = client.toasts.find((t) => t.message.includes("cleaned"));
      expect(cleanup).toBeUndefined();
    },
    { timeout: 8000 }
  );

  test("terminal-state members skipped — session.get never called for them", async () => {
    // Transition both members to `shutdown` before snapshotting.
    // Since they're currently in `initializing`, that path is valid.
    const s1 = new Store(tmpDir);
    await s1.init();
    for (const team of s1.listTeams()) {
      for (const m of s1.listMembers(team.id)) {
        s1.updateMember({ ...m, state: "shutdown" });
      }
    }
    s1.destroy();

    const client = new MockClient();
    await plugin(makeInput(client, tmpDir));

    // No probe should have been issued for terminal members.
    expect(client.callsFor("session.get").length).toBe(0);

    // And state is unchanged.
    const members = await readMembers(tmpDir);
    for (const m of members) expect(m.state).toBe("shutdown");
  });
});
