import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { Store } from "../src/state/store.js";
import { Scratchpad } from "../src/core/scratchpad.js";
import { CostTracker } from "../src/core/cost-tracker.js";
import { ActivityTracker } from "../src/core/activity.js";
import { MessageBus } from "../src/core/message-bus.js";
import { EscalationManager } from "../src/core/escalation.js";
import type { Team, Member, CostEntry } from "../src/state/schemas.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;
let store: Store;

/** Create a minimal team record in the store. */
function seedTeam(overrides: Partial<Team> = {}): Team {
  const team: Team = {
    id: overrides.id ?? "team_test",
    name: overrides.name ?? "test-team",
    leadSessionID: overrides.leadSessionID ?? "lead-session-1",
    config: overrides.config ?? {
      workStealing: true,
      backpressureLimit: 5,
      budgetLimit: undefined,
    },
    createdAt: overrides.createdAt ?? Date.now(),
  };
  store.createTeam(team);
  return team;
}

/** Create a minimal member record in the store. */
function seedMember(overrides: Partial<Member> = {}): Member {
  const member: Member = {
    id: overrides.id ?? "member_test",
    teamID: overrides.teamID ?? "team_test",
    sessionID: overrides.sessionID ?? "session-1",
    role: overrides.role ?? "worker",
    state: overrides.state ?? "ready",
    instructions: overrides.instructions ?? "do work",
    files: overrides.files ?? [],
    escalationLevel: overrides.escalationLevel ?? 0,
    retryCount: overrides.retryCount ?? 0,
    createdAt: overrides.createdAt ?? Date.now(),
    agent: overrides.agent,
    model: overrides.model,
    toolsAllowed: overrides.toolsAllowed,
  };
  store.createMember(member);
  return member;
}

/** Build a cost entry (without timestamp — record() adds it). */
function makeCostInput(
  overrides: Partial<Omit<CostEntry, "timestamp">> = {},
): Omit<CostEntry, "timestamp"> {
  return {
    memberID: overrides.memberID ?? "member_test",
    teamID: overrides.teamID ?? "team_test",
    sessionID: overrides.sessionID ?? "session-1",
    cost: overrides.cost ?? 0.01,
    tokens: overrides.tokens ?? {
      input: 100,
      output: 50,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    },
  };
}

// ---------------------------------------------------------------------------
// Scratchpad
// ---------------------------------------------------------------------------

describe("Scratchpad", () => {
  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-test-"));
    store = new Store(tmpDir);
    await store.init();
  });

  afterEach(() => {
    store.destroy();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("set and get a value", () => {
    const pad = new Scratchpad(store);
    pad.set("team1", "key1", "value1");
    expect(pad.get("team1", "key1")).toBe("value1");
  });

  test("get returns undefined for missing key", () => {
    const pad = new Scratchpad(store);
    expect(pad.get("team1", "nonexistent")).toBeUndefined();
  });

  test("get returns undefined for missing team", () => {
    const pad = new Scratchpad(store);
    expect(pad.get("no-team", "key1")).toBeUndefined();
  });

  test("overwrite an existing key", () => {
    const pad = new Scratchpad(store);
    pad.set("team1", "k", "old");
    pad.set("team1", "k", "new");
    expect(pad.get("team1", "k")).toBe("new");
  });

  test("delete removes a key", () => {
    const pad = new Scratchpad(store);
    pad.set("team1", "k", "v");
    pad.delete("team1", "k");
    expect(pad.get("team1", "k")).toBeUndefined();
  });

  test("delete on missing key is a no-op", () => {
    const pad = new Scratchpad(store);
    // Should not throw
    pad.delete("team1", "nonexistent");
    expect(pad.list("team1")).toEqual({});
  });

  test("list returns all entries for a team", () => {
    const pad = new Scratchpad(store);
    pad.set("team1", "a", "1");
    pad.set("team1", "b", "2");
    pad.set("team1", "c", "3");
    expect(pad.list("team1")).toEqual({ a: "1", b: "2", c: "3" });
  });

  test("list returns empty object for empty / unknown team", () => {
    const pad = new Scratchpad(store);
    expect(pad.list("nonexistent")).toEqual({});
  });

  test("teams are isolated from each other", () => {
    const pad = new Scratchpad(store);
    pad.set("teamA", "key", "A");
    pad.set("teamB", "key", "B");
    expect(pad.get("teamA", "key")).toBe("A");
    expect(pad.get("teamB", "key")).toBe("B");
    expect(pad.list("teamA")).toEqual({ key: "A" });
  });

  test("delete in one team does not affect another", () => {
    const pad = new Scratchpad(store);
    pad.set("teamA", "key", "A");
    pad.set("teamB", "key", "B");
    pad.delete("teamA", "key");
    expect(pad.get("teamA", "key")).toBeUndefined();
    expect(pad.get("teamB", "key")).toBe("B");
  });
});

// ---------------------------------------------------------------------------
// CostTracker
// ---------------------------------------------------------------------------

describe("CostTracker", () => {
  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-test-"));
    store = new Store(tmpDir);
    await store.init();
  });

  afterEach(() => {
    store.destroy();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("record stores a cost entry retrievable by member", () => {
    const tracker = new CostTracker(store);
    tracker.record(makeCostInput({ cost: 0.05 }));
    expect(tracker.getMemberCost("member_test")).toBeCloseTo(0.05, 6);
  });

  test("getMemberCost sums multiple entries", () => {
    const tracker = new CostTracker(store);
    tracker.record(makeCostInput({ cost: 0.01 }));
    tracker.record(makeCostInput({ cost: 0.02 }));
    tracker.record(makeCostInput({ cost: 0.03 }));
    expect(tracker.getMemberCost("member_test")).toBeCloseTo(0.06, 6);
  });

  test("getMemberCost returns 0 for unknown member", () => {
    const tracker = new CostTracker(store);
    expect(tracker.getMemberCost("no-one")).toBe(0);
  });

  test("getTeamCost sums across all members in the team", () => {
    const tracker = new CostTracker(store);
    tracker.record(makeCostInput({ memberID: "m1", teamID: "t1", cost: 0.10 }));
    tracker.record(makeCostInput({ memberID: "m2", teamID: "t1", cost: 0.20 }));
    tracker.record(makeCostInput({ memberID: "m3", teamID: "t2", cost: 0.50 }));
    expect(tracker.getTeamCost("t1")).toBeCloseTo(0.30, 6);
    expect(tracker.getTeamCost("t2")).toBeCloseTo(0.50, 6);
  });

  test("getTeamCost returns 0 for unknown team", () => {
    const tracker = new CostTracker(store);
    expect(tracker.getTeamCost("no-team")).toBe(0);
  });

  test("isOverBudget returns false when budget is undefined", () => {
    const tracker = new CostTracker(store);
    tracker.record(makeCostInput({ teamID: "t1", cost: 999 }));
    expect(tracker.isOverBudget("t1", undefined)).toBe(false);
  });

  test("isOverBudget returns false when under budget", () => {
    const tracker = new CostTracker(store);
    tracker.record(makeCostInput({ teamID: "t1", cost: 0.05 }));
    expect(tracker.isOverBudget("t1", 1.00)).toBe(false);
  });

  test("isOverBudget returns true when at budget exactly", () => {
    const tracker = new CostTracker(store);
    tracker.record(makeCostInput({ teamID: "t1", cost: 1.00 }));
    expect(tracker.isOverBudget("t1", 1.00)).toBe(true);
  });

  test("isOverBudget returns true when over budget", () => {
    const tracker = new CostTracker(store);
    tracker.record(makeCostInput({ teamID: "t1", cost: 1.50 }));
    expect(tracker.isOverBudget("t1", 1.00)).toBe(true);
  });

  test("formatCost formats to 4 decimal places with dollar sign", () => {
    const tracker = new CostTracker(store);
    expect(tracker.formatCost(0)).toBe("$0.0000");
    expect(tracker.formatCost(0.1)).toBe("$0.1000");
    expect(tracker.formatCost(1.23456)).toBe("$1.2346");
    expect(tracker.formatCost(100)).toBe("$100.0000");
  });
});

// ---------------------------------------------------------------------------
// ActivityTracker
// ---------------------------------------------------------------------------

describe("ActivityTracker", () => {
  test("record and get an activity", () => {
    const tracker = new ActivityTracker();
    tracker.record("m1", "read_file", "/src/main.ts");
    const act = tracker.get("m1");
    expect(act).toBeDefined();
    expect(act!.memberID).toBe("m1");
    expect(act!.tool).toBe("read_file");
    expect(act!.target).toBe("/src/main.ts");
    expect(typeof act!.timestamp).toBe("number");
  });

  test("get returns undefined for unknown member", () => {
    const tracker = new ActivityTracker();
    expect(tracker.get("unknown")).toBeUndefined();
  });

  test("record overwrites previous activity for the same member", () => {
    const tracker = new ActivityTracker();
    tracker.record("m1", "read_file", "/a.ts");
    tracker.record("m1", "write_file", "/b.ts");
    const act = tracker.get("m1");
    expect(act!.tool).toBe("write_file");
    expect(act!.target).toBe("/b.ts");
  });

  test("different members have independent activities", () => {
    const tracker = new ActivityTracker();
    tracker.record("m1", "read_file", "/a.ts");
    tracker.record("m2", "write_file", "/b.ts");
    expect(tracker.get("m1")!.tool).toBe("read_file");
    expect(tracker.get("m2")!.tool).toBe("write_file");
  });

  test("getIdleDuration returns 0 for unknown member", () => {
    const tracker = new ActivityTracker();
    expect(tracker.getIdleDuration("unknown")).toBe(0);
  });

  test("getIdleDuration returns non-negative duration since last activity", () => {
    const tracker = new ActivityTracker();
    tracker.record("m1", "read_file", "/a.ts");
    const idle = tracker.getIdleDuration("m1");
    // Should be very small (< 100ms) since we just recorded
    expect(idle).toBeGreaterThanOrEqual(0);
    expect(idle).toBeLessThan(100);
  });

  test("formatActivity returns '(no activity)' for unknown member", () => {
    const tracker = new ActivityTracker();
    expect(tracker.formatActivity("unknown")).toBe("(no activity)");
  });

  test("formatActivity returns 'tool target' for recent activity", () => {
    const tracker = new ActivityTracker();
    tracker.record("m1", "read_file", "/src/main.ts");
    const formatted = tracker.formatActivity("m1");
    // Since the activity was just recorded (elapsed < 5000ms), it should be "tool target"
    expect(formatted).toBe("read_file /src/main.ts");
  });

  test("formatActivity truncates long targets to 30 chars", () => {
    const tracker = new ActivityTracker();
    const longTarget = "/this/is/a/very/long/file/path/that/exceeds/thirty/characters.ts";
    tracker.record("m1", "read_file", longTarget);
    const formatted = tracker.formatActivity("m1");
    // Target should be first 27 chars + "..."
    expect(formatted).toBe(`read_file ${longTarget.slice(0, 27)}...`);
    expect(formatted.length).toBeLessThanOrEqual("read_file ".length + 30);
  });

  test("formatActivity shows idle message when elapsed > 5s", () => {
    const tracker = new ActivityTracker();
    tracker.record("m1", "read_file", "/a.ts");
    // Manually backdate the timestamp to simulate idle
    const act = tracker.get("m1")!;
    (act as { timestamp: number }).timestamp = Date.now() - 10_000; // 10 seconds ago
    const formatted = tracker.formatActivity("m1");
    expect(formatted).toMatch(/^\(idle \d+s\)$/);
  });

  test("clear removes a member's activity", () => {
    const tracker = new ActivityTracker();
    tracker.record("m1", "read_file", "/a.ts");
    tracker.clear("m1");
    expect(tracker.get("m1")).toBeUndefined();
    expect(tracker.formatActivity("m1")).toBe("(no activity)");
  });

  test("clear on unknown member is a no-op", () => {
    const tracker = new ActivityTracker();
    // Should not throw
    tracker.clear("unknown");
    expect(tracker.get("unknown")).toBeUndefined();
  });

  test("clear does not affect other members", () => {
    const tracker = new ActivityTracker();
    tracker.record("m1", "read_file", "/a.ts");
    tracker.record("m2", "write_file", "/b.ts");
    tracker.clear("m1");
    expect(tracker.get("m1")).toBeUndefined();
    expect(tracker.get("m2")).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// MessageBus — store-level operations (no SDK calls)
// ---------------------------------------------------------------------------

describe("MessageBus", () => {
  // MessageBus needs a TeamManager and PluginInput (ctx) for delivery,
  // but we can test send/broadcast at the store level with mocks.
  // deliverMessages() calls ctx.client.session.promptAsync, so we skip
  // delivery tests here and focus on message creation + backpressure.

  let mockCtx: any;
  let mockManager: any;
  let toasts: Array<{ title?: string; message: string; variant: string; duration?: number }>;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-test-"));
    store = new Store(tmpDir);
    await store.init();

    toasts = [];
    // Minimal mocks — we never call delivery in these tests because
    // member states are set so auto-wake doesn't trigger, or because
    // the mock promptAsync resolves harmlessly.
    mockCtx = {
      client: {
        session: {
          promptAsync: async () => ({ data: {} }),
        },
        tui: {
          showToast: async (params: any) => {
            if (params?.body) toasts.push(params.body);
            return { data: true };
          },
        },
      },
    };
    mockManager = {
      getMemberBySession: () => null,
    };
  });

  afterEach(() => {
    store.destroy();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("send creates a message in the store", () => {
    const team = seedTeam();
    seedMember({ id: "m_sender", role: "sender", state: "busy" });
    seedMember({ id: "m_receiver", role: "receiver", state: "busy" });

    const bus = new MessageBus(store, mockManager, mockCtx);
    const msgID = bus.send(team.id, "sender", "receiver", "hello");

    expect(msgID).toBeDefined();
    expect(typeof msgID).toBe("string");

    // Verify the message is in the store
    const messages = store.getTeamMessages(team.id);
    expect(messages.length).toBe(1);
    expect(messages[0].content).toBe("hello");
    expect(messages[0].from).toBe("m_sender");
    expect(messages[0].to).toBe("m_receiver");
    expect(messages[0].delivered).toBe(false);
  });

  test("send can be called by a non-existent sender (lead)", () => {
    const team = seedTeam();
    seedMember({ id: "m_receiver", role: "receiver", state: "busy" });

    const bus = new MessageBus(store, mockManager, mockCtx);
    // Sender "lead" has no member record — send uses "lead" as from
    const msgID = bus.send(team.id, "lead", "receiver", "instructions");

    const messages = store.getTeamMessages(team.id);
    expect(messages.length).toBe(1);
    expect(messages[0].from).toBe("lead");
  });

  test("send throws when team not found", () => {
    const bus = new MessageBus(store, mockManager, mockCtx);
    expect(() => bus.send("nonexistent", "a", "b", "hello")).toThrow(
      /Team not found/,
    );
  });

  test("send throws when recipient role not found", () => {
    seedTeam();
    seedMember({ role: "sender" });
    const bus = new MessageBus(store, mockManager, mockCtx);
    expect(() =>
      bus.send("team_test", "sender", "nonexistent_role", "hello"),
    ).toThrow(/not found in team/);
  });

  test("send throws on backpressure limit", () => {
    const team = seedTeam({
      config: { workStealing: true, backpressureLimit: 3 },
    });
    seedMember({ id: "m_sender", role: "sender", state: "busy" });
    seedMember({ id: "m_receiver", role: "receiver", state: "busy" });

    const bus = new MessageBus(store, mockManager, mockCtx);

    // Fill up to the backpressure limit
    bus.send(team.id, "sender", "receiver", "msg1");
    bus.send(team.id, "sender", "receiver", "msg2");
    bus.send(team.id, "sender", "receiver", "msg3");

    // 4th message should fail
    expect(() =>
      bus.send(team.id, "sender", "receiver", "msg4"),
    ).toThrow(/Backpressure limit reached/);
  });

  test("peer send fires a toast to the lead with role-formatted preview", () => {
    const team = seedTeam();
    seedMember({ id: "m_sender", role: "sender", state: "busy" });
    seedMember({ id: "m_receiver", role: "receiver", state: "busy" });

    const bus = new MessageBus(store, mockManager, mockCtx);
    bus.send(team.id, "sender", "receiver", "found a bug");

    expect(toasts).toHaveLength(1);
    expect(toasts[0].title).toBe("[orch]");
    expect(toasts[0].message).toBe("sender → receiver: found a bug");
    expect(toasts[0].variant).toBe("info");
  });

  test("lead send does NOT fire a toast", () => {
    const team = seedTeam();
    seedMember({ id: "m_receiver", role: "receiver", state: "busy" });

    const bus = new MessageBus(store, mockManager, mockCtx);
    bus.send(team.id, "lead", "receiver", "go do it");

    expect(toasts).toHaveLength(0);
  });

  test("long peer DM content is truncated to ~60 chars + ellipsis", () => {
    const team = seedTeam();
    seedMember({ id: "m_sender", role: "sender", state: "busy" });
    seedMember({ id: "m_receiver", role: "receiver", state: "busy" });

    const long = "x".repeat(200);
    const bus = new MessageBus(store, mockManager, mockCtx);
    bus.send(team.id, "sender", "receiver", long);

    expect(toasts).toHaveLength(1);
    const msg = toasts[0].message;
    // Format: "sender → receiver: <57 x's>..."  → preview portion capped at 60
    expect(msg).toContain("...");
    // prefix "sender → receiver: " (19 chars) + 60-char preview = 79
    const previewPart = msg.slice(msg.indexOf(": ") + 2);
    expect(previewPart.length).toBeLessThanOrEqual(60);
    expect(previewPart.endsWith("...")).toBe(true);
  });

  test("peer toast body uses `<from> → <to>: <preview>` format", () => {
    const team = seedTeam();
    seedMember({ id: "m_alpha", role: "alpha", state: "busy" });
    seedMember({ id: "m_beta", role: "beta", state: "busy" });

    const bus = new MessageBus(store, mockManager, mockCtx);
    bus.send(team.id, "alpha", "beta", "hi");

    expect(toasts[0].message).toMatch(/^alpha → beta: hi$/);
  });

  test("backpressure rejection does NOT fire a toast", () => {
    const team = seedTeam({
      id: "team_bp",
      name: "bp-team",
      config: { workStealing: true, backpressureLimit: 1, budgetLimit: undefined },
    });
    seedMember({ id: "m_s", role: "sender", teamID: "team_bp", state: "busy" });
    seedMember({ id: "m_r", role: "receiver", teamID: "team_bp", state: "busy" });

    const bus = new MessageBus(store, mockManager, mockCtx);
    bus.send(team.id, "sender", "receiver", "first"); // ok → 1 toast
    expect(() =>
      bus.send(team.id, "sender", "receiver", "second") // rejected
    ).toThrow(/Backpressure limit reached/);

    expect(toasts).toHaveLength(1);
    expect(toasts[0].message).toContain("first");
  });

  test("send uses team name lookup when id does not match", () => {
    const team = seedTeam({ id: "team_abc", name: "my-team" });
    seedMember({
      id: "m_s",
      role: "sender",
      teamID: "team_abc",
      state: "busy",
    });
    seedMember({
      id: "m_r",
      role: "receiver",
      teamID: "team_abc",
      state: "busy",
    });

    const bus = new MessageBus(store, mockManager, mockCtx);
    // Pass the team name instead of the id
    const msgID = bus.send("my-team", "sender", "receiver", "hi");
    expect(msgID).toBeDefined();

    const messages = store.getTeamMessages("team_abc");
    expect(messages.length).toBe(1);
  });

  test("broadcast sends to all active members except sender", () => {
    const team = seedTeam();
    seedMember({ id: "m_lead", role: "lead", state: "busy" });
    seedMember({ id: "m_worker1", role: "worker1", state: "busy" });
    seedMember({ id: "m_worker2", role: "worker2", state: "busy" });

    const bus = new MessageBus(store, mockManager, mockCtx);
    const ids = bus.broadcast(team.id, "lead", "all hands update");

    expect(ids.length).toBe(2); // worker1 + worker2
    const messages = store.getTeamMessages(team.id);
    expect(messages.length).toBe(2);

    const recipients = messages.map((m) => m.to).sort();
    expect(recipients).toEqual(["m_worker1", "m_worker2"]);
  });

  test("broadcast skips shutdown members", () => {
    const team = seedTeam();
    seedMember({ id: "m_lead", role: "lead", state: "busy" });
    seedMember({ id: "m_active", role: "active", state: "busy" });
    seedMember({ id: "m_done", role: "done", state: "shutdown" });

    const bus = new MessageBus(store, mockManager, mockCtx);
    const ids = bus.broadcast(team.id, "lead", "update");

    expect(ids.length).toBe(1);
    expect(store.getTeamMessages(team.id)[0].to).toBe("m_active");
  });

  test("broadcast skips shutdown_requested members", () => {
    const team = seedTeam();
    seedMember({ id: "m_lead", role: "lead", state: "busy" });
    seedMember({ id: "m_active", role: "active", state: "busy" });
    seedMember({
      id: "m_shutting",
      role: "shutting",
      state: "shutdown_requested",
    });

    const bus = new MessageBus(store, mockManager, mockCtx);
    const ids = bus.broadcast(team.id, "lead", "update");

    expect(ids.length).toBe(1);
    expect(store.getTeamMessages(team.id)[0].to).toBe("m_active");
  });

  test("broadcast skips members at backpressure limit", () => {
    const team = seedTeam({
      config: { workStealing: true, backpressureLimit: 2 },
    });
    seedMember({ id: "m_lead", role: "lead", state: "busy" });
    seedMember({ id: "m_w1", role: "w1", state: "busy" });
    seedMember({ id: "m_w2", role: "w2", state: "busy" });

    // Pre-fill w1 to backpressure limit
    store.addMessage({
      id: "pre1",
      teamID: team.id,
      from: "lead",
      to: "m_w1",
      content: "a",
      delivered: false,
      createdAt: Date.now(),
    });
    store.addMessage({
      id: "pre2",
      teamID: team.id,
      from: "lead",
      to: "m_w1",
      content: "b",
      delivered: false,
      createdAt: Date.now(),
    });

    const bus = new MessageBus(store, mockManager, mockCtx);
    const ids = bus.broadcast(team.id, "lead", "update");

    // Only w2 should receive the broadcast; w1 is at limit
    expect(ids.length).toBe(1);
    const messages = store
      .getTeamMessages(team.id)
      .filter((m) => m.content === "update");
    expect(messages[0].to).toBe("m_w2");
  });

  test("broadcast throws when team not found", () => {
    const bus = new MessageBus(store, mockManager, mockCtx);
    expect(() => bus.broadcast("nonexistent", "lead", "hello")).toThrow(
      /Team not found/,
    );
  });

  test("broadcast returns empty array when only the sender exists", () => {
    const team = seedTeam();
    seedMember({ id: "m_lead", role: "lead", state: "busy" });

    const bus = new MessageBus(store, mockManager, mockCtx);
    const ids = bus.broadcast(team.id, "lead", "lonely message");
    expect(ids).toEqual([]);
  });

  test("broadcast fires a single toast when sender is a member", () => {
    const team = seedTeam();
    seedMember({ id: "m_rev", role: "reviewer", state: "busy" });
    seedMember({ id: "m_a", role: "a", state: "busy" });
    seedMember({ id: "m_b", role: "b", state: "busy" });
    seedMember({ id: "m_c", role: "c", state: "busy" });

    const bus = new MessageBus(store, mockManager, mockCtx);
    bus.broadcast(team.id, "reviewer", "heads up, all");

    expect(toasts).toHaveLength(1);
    expect(toasts[0].title).toBe("[orch]");
    expect(toasts[0].message).toBe("reviewer → all (3): heads up, all");
    expect(toasts[0].variant).toBe("info");
  });

  test("broadcast from lead fires no toast", () => {
    const team = seedTeam();
    seedMember({ id: "m_a", role: "a", state: "busy" });
    seedMember({ id: "m_b", role: "b", state: "busy" });

    const bus = new MessageBus(store, mockManager, mockCtx);
    bus.broadcast(team.id, "lead", "all hands");

    expect(toasts).toHaveLength(0);
  });

  test("broadcast toast truncates long content to ~60 chars + ellipsis", () => {
    const team = seedTeam();
    seedMember({ id: "m_rev", role: "reviewer", state: "busy" });
    seedMember({ id: "m_a", role: "a", state: "busy" });

    const long = "y".repeat(200);
    const bus = new MessageBus(store, mockManager, mockCtx);
    bus.broadcast(team.id, "reviewer", long);

    expect(toasts).toHaveLength(1);
    const previewPart = toasts[0].message.slice(toasts[0].message.indexOf(": ") + 2);
    expect(previewPart.length).toBeLessThanOrEqual(60);
    expect(previewPart.endsWith("...")).toBe(true);
  });

  test("broadcast stores `from` as sender's member id, not role", () => {
    const team = seedTeam();
    seedMember({ id: "m_rev", role: "reviewer", state: "busy" });
    seedMember({ id: "m_a", role: "a", state: "busy" });
    seedMember({ id: "m_b", role: "b", state: "busy" });

    const bus = new MessageBus(store, mockManager, mockCtx);
    bus.broadcast(team.id, "reviewer", "check this out");

    const msgs = store.getTeamMessages(team.id);
    expect(msgs).toHaveLength(2);
    for (const m of msgs) {
      expect(m.from).toBe("m_rev");
      expect(m.from).not.toBe("reviewer");
    }
  });

  test("broadcast from lead stores `from` as 'lead' string", () => {
    const team = seedTeam();
    seedMember({ id: "m_a", role: "a", state: "busy" });
    seedMember({ id: "m_b", role: "b", state: "busy" });

    const bus = new MessageBus(store, mockManager, mockCtx);
    bus.broadcast(team.id, "lead", "go");

    const msgs = store.getTeamMessages(team.id);
    for (const m of msgs) {
      expect(m.from).toBe("lead");
    }
  });

  test("messages track undelivered state correctly", () => {
    const team = seedTeam();
    seedMember({ id: "m_s", role: "sender", state: "busy" });
    seedMember({ id: "m_r", role: "receiver", state: "busy" });

    const bus = new MessageBus(store, mockManager, mockCtx);
    const msgID = bus.send(team.id, "sender", "receiver", "check delivery");

    // Initially undelivered
    const pending = store.getUndeliveredMessages("m_r");
    expect(pending.length).toBe(1);
    expect(pending[0].id).toBe(msgID);

    // Mark delivered
    store.markDelivered(msgID);
    expect(store.getUndeliveredMessages("m_r").length).toBe(0);
  });

  test("deliverMessages includes the member's toolsAllowed in promptAsync body", async () => {
    // Capture promptAsync bodies on this test's mockCtx
    const promptCalls: Array<{ path: unknown; body: unknown }> = [];
    mockCtx.client.session.promptAsync = async (params: {
      path: unknown;
      body: unknown;
    }) => {
      promptCalls.push(params);
      return { data: {} };
    };

    const team = seedTeam();
    seedMember({ id: "m_s", role: "sender", state: "busy" });
    // Receiver must be "ready" for deliverMessages to actually send.
    // Attach a restricted toolsAllowed record.
    const toolsAllowed: Record<string, boolean> = {
      read: true,
      bash: true,
      webfetch: false,
      orch_create: false,
    };
    seedMember({
      id: "m_r",
      role: "receiver",
      state: "ready",
      toolsAllowed,
    });

    const bus = new MessageBus(store, mockManager, mockCtx);
    // Send directly to the store so send()'s auto-wake doesn't fire first
    store.addMessage({
      id: "msg_x",
      teamID: team.id,
      from: "m_s",
      to: "m_r",
      content: "wake up",
      delivered: false,
      createdAt: Date.now(),
    });

    const delivered = await bus.deliverMessages("m_r");
    expect(delivered).toBe(1);

    expect(promptCalls.length).toBe(1);
    const body = promptCalls[0].body as {
      parts: unknown[];
      tools?: Record<string, boolean>;
    };
    expect(body.tools).toBeDefined();
    expect(body.tools).toEqual(toolsAllowed);
  });

  test("deliverMessages omits body.tools when member has no toolsAllowed", async () => {
    const promptCalls: Array<{ body: { tools?: unknown } }> = [];
    mockCtx.client.session.promptAsync = async (params: {
      body: { tools?: unknown };
    }) => {
      promptCalls.push(params);
      return { data: {} };
    };

    const team = seedTeam();
    seedMember({ id: "m_s2", role: "sender2", state: "busy" });
    // No toolsAllowed — pre-existing member shape
    seedMember({ id: "m_r2", role: "receiver2", state: "ready" });

    const bus = new MessageBus(store, mockManager, mockCtx);
    store.addMessage({
      id: "msg_y",
      teamID: team.id,
      from: "m_s2",
      to: "m_r2",
      content: "no tools",
      delivered: false,
      createdAt: Date.now(),
    });

    await bus.deliverMessages("m_r2");
    expect(promptCalls.length).toBe(1);
    expect(promptCalls[0].body.tools).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// EscalationManager — logic tests with minimal mocking
// ---------------------------------------------------------------------------

describe("EscalationManager", () => {
  let mockCtx: any;
  let mockManager: any;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-test-"));
    store = new Store(tmpDir);
    await store.init();

    mockCtx = {
      client: {
        session: {
          create: async () => ({ data: { id: "new-session-id" } }),
          promptAsync: async () => ({ data: {} }),
        },
      },
    };
    mockManager = {};
  });

  afterEach(() => {
    store.destroy();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("returns { retried: false, escalated: false } when member not found", async () => {
    const esc = new EscalationManager(store, mockManager, mockCtx);
    const result = await esc.handleError("nonexistent");
    expect(result).toEqual({ retried: false, escalated: false });
  });

  test("returns { retried: false, escalated: false } when team not found", async () => {
    // Create member with a teamID that doesn't exist
    seedMember({ id: "m_orphan", teamID: "no-team" });

    const esc = new EscalationManager(store, mockManager, mockCtx);
    const result = await esc.handleError("m_orphan");
    expect(result).toEqual({ retried: false, escalated: false });
  });

  test("returns { retried: false, escalated: false } when escalation is not enabled", async () => {
    seedTeam({
      config: {
        workStealing: true,
        backpressureLimit: 50,
        escalation: undefined, // no escalation config
      },
    });
    seedMember({ id: "m1" });

    const esc = new EscalationManager(store, mockManager, mockCtx);
    const result = await esc.handleError("m1");
    expect(result).toEqual({ retried: false, escalated: false });
  });

  test("returns { retried: false, escalated: false } when escalation.enabled is false", async () => {
    seedTeam({
      config: {
        workStealing: true,
        backpressureLimit: 50,
        escalation: {
          enabled: false,
          chain: [{ providerID: "p", modelID: "m1" }],
          maxRetries: 2,
        },
      },
    });
    seedMember({ id: "m1" });

    const esc = new EscalationManager(store, mockManager, mockCtx);
    const result = await esc.handleError("m1");
    expect(result).toEqual({ retried: false, escalated: false });
  });

  test("retries at current level when retryCount < maxRetries", async () => {
    seedTeam({
      config: {
        workStealing: true,
        backpressureLimit: 50,
        escalation: {
          enabled: true,
          chain: [
            { providerID: "anthropic", modelID: "sonnet" },
            { providerID: "anthropic", modelID: "opus" },
          ],
          maxRetries: 2,
        },
      },
    });
    seedMember({
      id: "m1",
      state: "error",
      retryCount: 0,
      escalationLevel: 0,
    });

    const esc = new EscalationManager(store, mockManager, mockCtx);
    const result = await esc.handleError("m1");

    expect(result).toEqual({ retried: true, escalated: false });

    // Member should have retryCount incremented and state set to ready
    const member = store.getMember("m1")!;
    expect(member.retryCount).toBe(1);
    expect(member.state).toBe("ready");
  });

  test("escalates to next model when retries exhausted", async () => {
    seedTeam({
      config: {
        workStealing: true,
        backpressureLimit: 50,
        escalation: {
          enabled: true,
          chain: [
            { providerID: "anthropic", modelID: "sonnet" },
            { providerID: "anthropic", modelID: "opus" },
          ],
          maxRetries: 1,
        },
      },
    });
    seedMember({
      id: "m1",
      state: "error",
      retryCount: 1, // at maxRetries
      escalationLevel: 0,
    });

    const esc = new EscalationManager(store, mockManager, mockCtx);
    const result = await esc.handleError("m1");

    expect(result).toEqual({ retried: false, escalated: true });

    // Member should be escalated: new level, reset retryCount, new model
    const member = store.getMember("m1")!;
    expect(member.escalationLevel).toBe(1);
    expect(member.retryCount).toBe(0);
    expect(member.model).toEqual({ providerID: "anthropic", modelID: "opus" });
    expect(member.state).toBe("ready");
  });

  test("returns { retried: false, escalated: false } when chain is exhausted", async () => {
    seedTeam({
      config: {
        workStealing: true,
        backpressureLimit: 50,
        escalation: {
          enabled: true,
          chain: [{ providerID: "anthropic", modelID: "sonnet" }],
          maxRetries: 1,
        },
      },
    });
    seedMember({
      id: "m1",
      state: "error",
      retryCount: 1,
      escalationLevel: 0, // already at the last model (chain length 1)
    });

    const esc = new EscalationManager(store, mockManager, mockCtx);
    const result = await esc.handleError("m1");

    // Chain is exhausted (escalationLevel 0 is already chain.length - 1 = 0)
    expect(result).toEqual({ retried: false, escalated: false });
  });

  test("getModelLabel returns 'default' for undefined model", () => {
    const esc = new EscalationManager(store, mockManager, mockCtx);
    expect(esc.getModelLabel(undefined)).toBe("default");
  });

  test("getModelLabel returns 'provider/model' for defined model", () => {
    const esc = new EscalationManager(store, mockManager, mockCtx);
    expect(
      esc.getModelLabel({ providerID: "anthropic", modelID: "opus-4" }),
    ).toBe("anthropic/opus-4");
  });

  // NOTE: Full respawnMember tests would require deeper SDK mocking
  // (session.create + session.promptAsync). The retry/escalate paths
  // above already exercise respawnMember through the mock — further
  // testing of the error path in respawnMember is omitted since it
  // would only test our mock, not real behavior.
});

// ---------------------------------------------------------------------------
// Store-level integration: message + cost persistence across init
// ---------------------------------------------------------------------------

describe("Store persistence", () => {
  test("scratchpad data survives destroy + re-init via snapshot", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-test-"));

    const store1 = new Store(tmpDir);
    await store1.init();
    store1.scratchpadSet("t1", "key", "persisted-value");
    store1.destroy(); // triggers snapshot

    const store2 = new Store(tmpDir);
    await store2.init();
    expect(store2.scratchpadGet("t1", "key")).toBe("persisted-value");
    store2.destroy();

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("cost data survives destroy + re-init via JSONL replay", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-test-"));

    const store1 = new Store(tmpDir);
    await store1.init();
    store1.addCost({
      memberID: "m1",
      teamID: "t1",
      sessionID: "s1",
      cost: 0.42,
      tokens: {
        input: 100,
        output: 50,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      },
      timestamp: Date.now(),
    });
    store1.destroy();

    const store2 = new Store(tmpDir);
    await store2.init();
    expect(store2.getTeamCost("t1")).toBeCloseTo(0.42, 6);
    store2.destroy();

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("updateTeamInboxSeen persists across destroy + re-init", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-test-"));

    const store1 = new Store(tmpDir);
    await store1.init();
    const team: Team = {
      id: "team_ib1",
      name: "ib-persist",
      leadSessionID: "lead-sess",
      config: { workStealing: true, backpressureLimit: 5 },
      createdAt: 1000,
      leadInboxLastSeenAt: 1000,
    };
    store1.createTeam(team);
    store1.updateTeamInboxSeen("team_ib1", 9999);
    store1.destroy();

    const store2 = new Store(tmpDir);
    await store2.init();
    const reloaded = store2.getTeam("team_ib1");
    expect(reloaded).toBeDefined();
    expect(reloaded?.leadInboxLastSeenAt).toBe(9999);
    store2.destroy();

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("messages persist and can be queried after re-init", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-test-"));

    const store1 = new Store(tmpDir);
    await store1.init();
    store1.addMessage({
      id: "msg_1",
      teamID: "t1",
      from: "lead",
      to: "m1",
      content: "do the thing",
      delivered: false,
      createdAt: Date.now(),
    });
    store1.destroy();

    const store2 = new Store(tmpDir);
    await store2.init();
    const msgs = store2.getTeamMessages("t1");
    expect(msgs.length).toBe(1);
    expect(msgs[0].content).toBe("do the thing");
    expect(msgs[0].delivered).toBe(false);
    store2.destroy();

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});
