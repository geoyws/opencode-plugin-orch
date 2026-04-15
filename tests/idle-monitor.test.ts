// Unit tests for IdleMonitor — verifies it flags stale ready members
// via reporter.warn without changing state.

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { createHarness, makeToolContext, type Harness } from "./_harness.js";
import { IdleMonitor } from "../src/core/idle-monitor.js";

async function setupTeamWithMember(
  h: Harness,
  role: string,
  opts?: { idleTimeoutMs?: number }
) {
  h.manager.createTeam("idle-team", "lead-session", opts ?? {});
  await h.tools.orch_spawn.execute(
    { team: "idle-team", role, instructions: "x" },
    makeToolContext("lead-session")
  );
  const team = h.store.getTeamByName("idle-team")!;
  const member = h.store.getMemberByRole(team.id, role)!;
  // Mark as ready
  h.manager.transitionMember(member.id, "ready");
  return { team, member };
}

describe("IdleMonitor", () => {
  let h: Harness;
  beforeEach(async () => { h = await createHarness(); });
  afterEach(() => { h.cleanup(); });

  test("stale ready member triggers warning exactly once per stuck period", async () => {
    const { member } = await setupTeamWithMember(h, "w", { idleTimeoutMs: 1000 });
    // Backdate lastActivityAt 2 minutes into the past
    const current = h.store.getMember(member.id)!;
    h.store.updateMember({ ...current, lastActivityAt: Date.now() - 120_000 });

    const monitor = new IdleMonitor(h.store, h.reporter);
    const flagged1 = monitor.sweep();
    expect(flagged1).toBe(1);
    // Second sweep — same stale member — shouldn't re-toast
    const flagged2 = monitor.sweep();
    expect(flagged2).toBe(0);

    // Check the toast actually fired via the mock client
    const warnToast = h.client.toasts.find(
      (t) => t.variant === "warning" && t.message.includes("idle")
    );
    expect(warnToast).toBeDefined();
    expect(warnToast?.message).toContain("w");
  });

  test("activity resets the idle timer", async () => {
    const { member } = await setupTeamWithMember(h, "w", { idleTimeoutMs: 1000 });
    const current = h.store.getMember(member.id)!;
    h.store.updateMember({ ...current, lastActivityAt: Date.now() - 120_000 });

    const monitor = new IdleMonitor(h.store, h.reporter);
    expect(monitor.sweep()).toBe(1);

    // touchMember bumps lastActivityAt to now
    h.manager.touchMember(member.id);
    // Also clear the warning so the next stale period can re-flag
    monitor.resetWarned(member.id);
    expect(monitor.sweep()).toBe(0);

    // Backdate again → fires again
    const updated = h.store.getMember(member.id)!;
    h.store.updateMember({ ...updated, lastActivityAt: Date.now() - 120_000 });
    monitor.resetWarned(member.id);
    expect(monitor.sweep()).toBe(1);
  });

  test("non-ready members are never flagged", async () => {
    const { member } = await setupTeamWithMember(h, "w", { idleTimeoutMs: 1000 });
    const current = h.store.getMember(member.id)!;
    h.store.updateMember({ ...current, lastActivityAt: Date.now() - 120_000 });
    // Move out of ready
    h.manager.transitionMember(member.id, "busy");

    const monitor = new IdleMonitor(h.store, h.reporter);
    expect(monitor.sweep()).toBe(0);

    // shutdown/error members also don't trigger
    h.manager.transitionMember(member.id, "ready");
    const again = h.store.getMember(member.id)!;
    h.store.updateMember({ ...again, state: "shutdown", lastActivityAt: Date.now() - 120_000 });
    expect(monitor.sweep()).toBe(0);
  });

  test("TeamConfig.idleTimeoutMs override applies", async () => {
    // Tiny timeout — 10ms
    const { member } = await setupTeamWithMember(h, "w", { idleTimeoutMs: 10 });
    const current = h.store.getMember(member.id)!;
    // Backdate just enough: 50ms ago
    h.store.updateMember({ ...current, lastActivityAt: Date.now() - 50 });

    const monitor = new IdleMonitor(h.store, h.reporter);
    expect(monitor.sweep()).toBe(1);
  });

  test("transitioning out of ready clears the warning latch so a re-entry can re-flag", async () => {
    const { member } = await setupTeamWithMember(h, "w", { idleTimeoutMs: 1000 });
    const current = h.store.getMember(member.id)!;
    h.store.updateMember({ ...current, lastActivityAt: Date.now() - 120_000 });

    const monitor = new IdleMonitor(h.store, h.reporter);
    expect(monitor.sweep()).toBe(1);
    expect(monitor.sweep()).toBe(0); // latched

    // Transition to busy (clears warning latch on next sweep) and back to ready
    h.manager.transitionMember(member.id, "busy");
    monitor.sweep(); // clears latch
    h.manager.transitionMember(member.id, "ready");
    // Backdate again
    const updated = h.store.getMember(member.id)!;
    h.store.updateMember({ ...updated, lastActivityAt: Date.now() - 120_000 });
    expect(monitor.sweep()).toBe(1);
  });

  test("pre-feature snapshot member (lastActivityAt=0) uses createdAt as baseline", async () => {
    const { member } = await setupTeamWithMember(h, "w", { idleTimeoutMs: 600_000 });
    // Simulate a member loaded from a pre-feature snapshot: lastActivityAt
    // is 0, and createdAt is 5 minutes ago (well under the 10min timeout).
    const current = h.store.getMember(member.id)!;
    const fiveMinAgo = Date.now() - 5 * 60_000;
    h.store.updateMember({ ...current, lastActivityAt: 0, createdAt: fiveMinAgo });

    const monitor = new IdleMonitor(h.store, h.reporter);
    // First sweep: 5min < 10min timeout → no warning
    expect(monitor.sweep()).toBe(0);

    // Advance "now" past the 10min threshold (pass explicit now)
    expect(monitor.sweep(fiveMinAgo + 11 * 60_000)).toBe(1);
  });
});
