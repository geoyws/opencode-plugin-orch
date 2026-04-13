import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  createHarness,
  MockClient,
  sessionIdleEvent,
  sessionStatusEvent,
  sessionErrorEvent,
  messageUpdatedEvent,
  type Harness,
} from "./_harness.js";
import type { PluginInput } from "@opencode-ai/plugin";
import { plugin } from "../src/plugin.js";
import { Store } from "../src/state/store.js";

// ── session.idle ─────────────────────────────────────────────────────
describe("session.idle", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await createHarness();
  });
  afterEach(() => {
    h.cleanup();
  });

  test("transitions initializing → ready and toasts", async () => {
    const team = h.manager.createTeam("t1", "lead-1");
    const member = await h.manager.spawnMember({
      teamID: team.id,
      role: "coder",
      instructions: "do stuff",
    });
    expect(member.state).toBe("initializing");

    h.client.toasts = [];
    await h.fireEvent(sessionIdleEvent(member.sessionID));

    const updated = h.store.getMember(member.id)!;
    expect(updated.state).toBe("ready");
    expect(h.client.toasts.some((t) => t.message.includes("ready"))).toBe(true);
  });

  test("transitions busy → ready", async () => {
    const team = h.manager.createTeam("t1", "lead-1");
    const member = await h.manager.spawnMember({
      teamID: team.id,
      role: "coder",
      instructions: "do stuff",
    });
    h.manager.transitionMember(member.id, "ready");
    h.manager.transitionMember(member.id, "busy");

    await h.fireEvent(sessionIdleEvent(member.sessionID));
    expect(h.store.getMember(member.id)!.state).toBe("ready");
  });

  test("auto-wakes with pending messages", async () => {
    const team = h.manager.createTeam("t1", "lead-1");
    const sender = await h.manager.spawnMember({
      teamID: team.id,
      role: "sender",
      instructions: "x",
    });
    const receiver = await h.manager.spawnMember({
      teamID: team.id,
      role: "receiver",
      instructions: "y",
    });
    // Put receiver into an idle-candidate state by transitioning via ready
    h.manager.transitionMember(receiver.id, "ready");
    h.manager.transitionMember(receiver.id, "busy");

    // Queue a message while receiver is busy (so it doesn't auto-deliver)
    h.bus.send(team.id, "sender", "receiver", "hello world");

    h.client.calls = [];
    await h.fireEvent(sessionIdleEvent(receiver.sessionID));

    const prompts = h.client.callsFor("session.promptAsync");
    const delivered = prompts.some((c) => {
      const body = (c.args as { body?: { parts?: Array<{ text?: string }> } }).body;
      return body?.parts?.some((p) => p.text?.includes("hello world"));
    });
    expect(delivered).toBe(true);
  });

  test("shutdown_requested → shutdown and locks released", async () => {
    const team = h.manager.createTeam("t1", "lead-1");
    const member = await h.manager.spawnMember({
      teamID: team.id,
      role: "coder",
      instructions: "x",
    });
    h.fileLocks.tryAcquire("/tmp/foo.ts", member.id, team.id);
    h.manager.transitionMember(member.id, "ready");
    h.manager.transitionMember(member.id, "shutdown_requested");

    await h.fireEvent(sessionIdleEvent(member.sessionID));

    expect(h.store.getMember(member.id)!.state).toBe("shutdown");
    expect(h.fileLocks.isLocked("/tmp/foo.ts")).toBe(false);
  });

  test("releases file locks on idle", async () => {
    const team = h.manager.createTeam("t1", "lead-1");
    const member = await h.manager.spawnMember({
      teamID: team.id,
      role: "coder",
      instructions: "x",
    });
    h.fileLocks.tryAcquire("/tmp/a.ts", member.id, team.id);
    h.fileLocks.tryAcquire("/tmp/b.ts", member.id, team.id);

    await h.fireEvent(sessionIdleEvent(member.sessionID));

    expect(h.fileLocks.isLocked("/tmp/a.ts")).toBe(false);
    expect(h.fileLocks.isLocked("/tmp/b.ts")).toBe(false);
  });

  test("work stealing: claims available task and wakes member", async () => {
    const team = h.manager.createTeam("t1", "lead-1", { workStealing: true });
    const member = await h.manager.spawnMember({
      teamID: team.id,
      role: "coder",
      instructions: "x",
    });
    h.manager.transitionMember(member.id, "ready");

    const task = h.board.addTask(team.id, "Fix bug", "Fix the thing");

    h.client.calls = [];
    h.client.toasts = [];
    await h.fireEvent(sessionIdleEvent(member.sessionID));

    const claimed = h.store.getTask(task.id)!;
    expect(claimed.status).toBe("claimed");
    expect(claimed.assignee).toBe(member.id);

    const prompts = h.client.callsFor("session.promptAsync");
    const hasWakeup = prompts.some((c) => {
      const body = (c.args as { body?: { parts?: Array<{ text?: string }> } }).body;
      return body?.parts?.some((p) => p.text?.includes("Work stolen"));
    });
    expect(hasWakeup).toBe(true);
    expect(h.client.toasts.some((t) => t.message.includes("claimed task"))).toBe(true);
  });

  test("work stealing disabled → no task claimed", async () => {
    const team = h.manager.createTeam("t1", "lead-1", { workStealing: false });
    const member = await h.manager.spawnMember({
      teamID: team.id,
      role: "coder",
      instructions: "x",
    });
    h.manager.transitionMember(member.id, "ready");

    const task = h.board.addTask(team.id, "Fix bug", "Fix the thing");

    await h.fireEvent(sessionIdleEvent(member.sessionID));

    expect(h.store.getTask(task.id)!.status).toBe("available");
  });

  test("work stealing with no tasks → no-op", async () => {
    const team = h.manager.createTeam("t1", "lead-1", { workStealing: true });
    const member = await h.manager.spawnMember({
      teamID: team.id,
      role: "coder",
      instructions: "x",
    });
    h.manager.transitionMember(member.id, "ready");

    // Should not throw
    await h.fireEvent(sessionIdleEvent(member.sessionID));
    expect(h.store.getMember(member.id)!.state).toBe("ready");
  });

  test("idle event for non-member sessionID → no-op", async () => {
    await h.fireEvent(sessionIdleEvent("unknown-session"));
    // no crash
    expect(true).toBe(true);
  });
});

// ── session.status ───────────────────────────────────────────────────
describe("session.status", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await createHarness();
  });
  afterEach(() => {
    h.cleanup();
  });

  test("busy transitions ready → busy", async () => {
    const team = h.manager.createTeam("t1", "lead-1");
    const member = await h.manager.spawnMember({
      teamID: team.id,
      role: "coder",
      instructions: "x",
    });
    h.manager.transitionMember(member.id, "ready");

    await h.fireEvent(sessionStatusEvent(member.sessionID, "busy"));

    expect(h.store.getMember(member.id)!.state).toBe("busy");
  });

  test("non-member → no-op", async () => {
    await h.fireEvent(sessionStatusEvent("unknown-session", "busy"));
    expect(true).toBe(true);
  });
});

// ── session.error ────────────────────────────────────────────────────
describe("session.error", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await createHarness();
  });
  afterEach(() => {
    h.cleanup();
  });

  test("transitions to error, releases locks, toasts", async () => {
    const team = h.manager.createTeam("t1", "lead-1");
    const member = await h.manager.spawnMember({
      teamID: team.id,
      role: "coder",
      instructions: "x",
    });
    h.manager.transitionMember(member.id, "ready");
    h.fileLocks.tryAcquire("/tmp/x.ts", member.id, team.id);

    h.client.toasts = [];
    await h.fireEvent(sessionErrorEvent(member.sessionID));

    expect(h.store.getMember(member.id)!.state).toBe("error");
    expect(h.fileLocks.isLocked("/tmp/x.ts")).toBe(false);
    expect(h.client.toasts.some((t) => t.message.includes("error"))).toBe(true);
  });

  test("escalation enabled with retries remaining → retried", async () => {
    const team = h.manager.createTeam("t1", "lead-1", {
      escalation: {
        enabled: true,
        chain: [
          { providerID: "anthropic", modelID: "haiku" },
          { providerID: "anthropic", modelID: "sonnet" },
        ],
        maxRetries: 2,
      },
    });
    const member = await h.manager.spawnMember({
      teamID: team.id,
      role: "coder",
      instructions: "x",
    });
    h.manager.transitionMember(member.id, "ready");

    h.client.toasts = [];
    await h.fireEvent(sessionErrorEvent(member.sessionID));

    const updated = h.store.getMember(member.id)!;
    expect(updated.state).toBe("ready");
    expect(updated.retryCount).toBe(1);
    expect(h.client.toasts.some((t) => t.message.includes("retrying"))).toBe(true);
  });

  test("escalation with chain exhausted → toast says failed", async () => {
    const team = h.manager.createTeam("t1", "lead-1", {
      escalation: {
        enabled: true,
        chain: [{ providerID: "anthropic", modelID: "haiku" }],
        maxRetries: 0,
      },
    });
    const member = await h.manager.spawnMember({
      teamID: team.id,
      role: "coder",
      instructions: "x",
    });
    h.manager.transitionMember(member.id, "ready");

    h.client.toasts = [];
    await h.fireEvent(sessionErrorEvent(member.sessionID));

    expect(h.client.toasts.some((t) => t.message.includes("failed"))).toBe(true);
  });

  test("escalation disabled → toast says failed", async () => {
    const team = h.manager.createTeam("t1", "lead-1");
    const member = await h.manager.spawnMember({
      teamID: team.id,
      role: "coder",
      instructions: "x",
    });
    h.manager.transitionMember(member.id, "ready");

    h.client.toasts = [];
    await h.fireEvent(sessionErrorEvent(member.sessionID));

    expect(h.client.toasts.some((t) => t.message.includes("failed"))).toBe(true);
  });

  test("error event without sessionID → no-op", async () => {
    await h.fireEvent({
      type: "session.error",
      properties: { error: { name: "X", data: { message: "m" } } },
    } as unknown as Parameters<typeof h.fireEvent>[0]);
    expect(true).toBe(true);
  });

  test("error event for non-member → no-op", async () => {
    await h.fireEvent(sessionErrorEvent("unknown-session"));
    expect(true).toBe(true);
  });
});

// ── message.updated ──────────────────────────────────────────────────
describe("message.updated", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await createHarness();
  });
  afterEach(() => {
    h.cleanup();
  });

  test("records cost for assistant message from member", async () => {
    const team = h.manager.createTeam("t1", "lead-1");
    const member = await h.manager.spawnMember({
      teamID: team.id,
      role: "coder",
      instructions: "x",
    });

    await h.fireEvent(messageUpdatedEvent(member.sessionID, 0.05));

    expect(h.costs.getMemberCost(member.id)).toBeCloseTo(0.05);
  });

  test("does NOT record for user messages", async () => {
    const team = h.manager.createTeam("t1", "lead-1");
    const member = await h.manager.spawnMember({
      teamID: team.id,
      role: "coder",
      instructions: "x",
    });

    await h.fireEvent({
      type: "message.updated",
      properties: {
        info: {
          id: "m",
          sessionID: member.sessionID,
          role: "user",
          cost: 0.1,
          tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
        },
      },
    } as unknown as Parameters<typeof h.fireEvent>[0]);

    expect(h.costs.getMemberCost(member.id)).toBe(0);
  });

  test("does NOT record for non-member sessions", async () => {
    const team = h.manager.createTeam("t1", "lead-1");
    await h.fireEvent(messageUpdatedEvent("unknown-session", 1));
    expect(h.costs.getTeamCost(team.id)).toBe(0);
  });

  test("budget enforcement: shuts down active members and toasts", async () => {
    const team = h.manager.createTeam("t1", "lead-1", { budgetLimit: 0.001 });
    const m1 = await h.manager.spawnMember({
      teamID: team.id,
      role: "a",
      instructions: "x",
    });
    const m2 = await h.manager.spawnMember({
      teamID: team.id,
      role: "b",
      instructions: "x",
    });

    h.client.calls = [];
    h.client.toasts = [];
    await h.fireEvent(messageUpdatedEvent(m1.sessionID, 0.5));

    const aborts = h.client.callsFor("session.abort");
    expect(aborts.length).toBeGreaterThanOrEqual(2);
    expect(h.store.getMember(m1.id)!.state).toBe("shutdown");
    expect(h.store.getMember(m2.id)!.state).toBe("shutdown");
    expect(h.client.toasts.some((t) => t.message.includes("budget"))).toBe(true);
  });
});

// ── Top-level error boundary ─────────────────────────────────────────
describe("event hook error boundary", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await createHarness();
  });
  afterEach(() => {
    h.cleanup();
  });

  test("malformed event does not throw", async () => {
    // Feed an event with wrong shape — e.g. missing properties
    await h.fireEvent({
      type: "session.error",
      properties: { sessionID: null as unknown as string },
    } as unknown as Parameters<typeof h.fireEvent>[0]);

    // Should not throw. Also if an internal error happens, app.log should catch it.
    expect(true).toBe(true);
  });
});

// ── Plugin entry point ───────────────────────────────────────────────
describe("plugin() entry", () => {
  test("returns hooks with tool, event, permission.ask, tool.execute.after", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-plugin-"));
    try {
      const client = new MockClient();
      const input = {
        client,
        project: { id: "test-project" },
        directory: tmpDir,
        worktree: tmpDir,
        serverUrl: new URL("http://localhost:0"),
        $: null,
      } as unknown as PluginInput;

      const hooks = await plugin(input);

      expect(hooks.tool).toBeDefined();
      expect(typeof hooks.event).toBe("function");
      expect(typeof hooks["permission.ask"]).toBe("function");
      expect(typeof hooks["tool.execute.after"]).toBe("function");

      // Firing an event should not throw
      await hooks.event!({
        event: { type: "session.idle", properties: { sessionID: "x" } } as unknown as Parameters<NonNullable<typeof hooks.event>>[0]["event"],
      });

      // Logged startup — Reporter.success() emits "ready · N tools"
      expect(client.logs.some((l) => l.message.includes("ready"))).toBe(true);
      // And shows a success toast
      expect(client.toasts.some((t) => t.variant === "success" && t.message.includes("ready"))).toBe(true);

      // Trigger cleanup via beforeExit handler to clear the snapshot interval
      process.emit("beforeExit", 0);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ── Plugin init failure handling ─────────────────────────────────────
// These tests are the whole point of the hardening work: make sure a
// broken init surfaces loudly via a TUI toast AND returns valid (empty)
// hooks so the opencode TUI stays usable.
describe("plugin() init failure handling", () => {
  const originalInit = Store.prototype.init;
  const originalDestroy = Store.prototype.destroy;

  afterEach(() => {
    Store.prototype.init = originalInit;
    Store.prototype.destroy = originalDestroy;
  });

  function makeInput(): { input: PluginInput; client: MockClient; tmpDir: string } {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-plugin-fail-"));
    const client = new MockClient();
    const input = {
      client,
      project: { id: "test-project" },
      directory: tmpDir,
      worktree: tmpDir,
      serverUrl: new URL("http://localhost:0"),
      $: null,
    } as unknown as PluginInput;
    return { input, client, tmpDir };
  }

  test("init throw → returns empty hooks and shows error toast", async () => {
    Store.prototype.init = async function () {
      throw new Error("boom-from-store");
    };

    const { input, client, tmpDir } = makeInput();
    try {
      const hooks = await plugin(input);

      // Must not have blown up, and must not register tools.
      expect(hooks).toBeDefined();
      expect(hooks.tool).toBeUndefined();

      // Error toast was raised with the failure reason.
      const errorToast = client.toasts.find(
        (t) => t.variant === "error" && t.message.includes("boom-from-store")
      );
      expect(errorToast).toBeDefined();
      expect(errorToast!.title).toContain("init failed");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test(
    "init hang → times out, returns empty hooks, error toast mentions timeout",
    async () => {
      Store.prototype.init = function () {
        // Never resolves — simulates a pathological hang.
        return new Promise<void>(() => {});
      };

      const { input, client, tmpDir } = makeInput();
      try {
        const start = Date.now();
        const hooks = await plugin(input);
        const elapsed = Date.now() - start;

        // Should resolve around the 5s timeout, not hang forever.
        expect(elapsed).toBeGreaterThanOrEqual(4500);
        expect(elapsed).toBeLessThan(8000);

        expect(hooks.tool).toBeUndefined();

        const errorToast = client.toasts.find(
          (t) => t.variant === "error" && t.message.includes("timed out")
        );
        expect(errorToast).toBeDefined();
        expect(errorToast!.title).toContain("init failed");
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    },
    { timeout: 10000 }
  );

  test(
    "init resolves after timeout → store.destroy() called to clean up leaked resources",
    async () => {
      // Simulate a slow init that eventually succeeds ~6s in (past the 5s deadline).
      // This is the realistic scenario: disk I/O stalls long enough to blow the
      // deadline but still completes, leaving a running snapshot timer + signal
      // handlers that nothing references.
      Store.prototype.init = function () {
        return new Promise<void>((resolve) => {
          setTimeout(() => resolve(), 6000);
        });
      };

      let destroyCalls = 0;
      Store.prototype.destroy = function () {
        destroyCalls++;
        // Do NOT call originalDestroy — the stubbed init never started a timer.
      };

      const { input, client, tmpDir } = makeInput();
      try {
        const start = Date.now();
        const hooks = await plugin(input);
        const elapsed = Date.now() - start;

        // Timeout fired at ~5s, not waiting for the 6s init.
        expect(elapsed).toBeGreaterThanOrEqual(4500);
        expect(elapsed).toBeLessThan(6000);

        // Empty hooks were returned so opencode keeps working.
        expect(hooks.tool).toBeUndefined();

        // Error toast mentions the timeout.
        const errorToast = client.toasts.find(
          (t) => t.variant === "error" && t.message.includes("timed out")
        );
        expect(errorToast).toBeDefined();

        // At timeout point, destroy hasn't been called yet — init is still running.
        expect(destroyCalls).toBe(0);

        // Wait for the late init to resolve; the catch branch should then call
        // destroy exactly once to clean up the leaked snapshot timer.
        await new Promise((r) => setTimeout(r, 2000));
        expect(destroyCalls).toBe(1);
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    },
    { timeout: 15000 }
  );
});
