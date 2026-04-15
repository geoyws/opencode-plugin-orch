// Periodic sweep that flags `ready` members who haven't transitioned or
// touched their lastActivityAt in longer than TeamConfig.idleTimeoutMs.
// Warning-only — does NOT auto-shutdown. The team lead is responsible
// for deciding whether to respawn/abort a stale member.

import type { Store } from "../state/store.js";
import type { Reporter } from "./reporter.js";

const DEFAULT_TIMEOUT_MS = 600_000; // 10 minutes
const DEFAULT_INTERVAL_MS = 60_000; // 60 seconds

export class IdleMonitor {
  private timer: NodeJS.Timeout | undefined;
  // Track which members we've already warned about so a stuck member
  // doesn't re-toast on every sweep. Cleared when the member transitions.
  private warned = new Set<string>();

  constructor(
    private store: Store,
    private reporter: Reporter,
    private opts: {
      intervalMs?: number;
      defaultTimeoutMs?: number;
    } = {}
  ) {}

  start(): void {
    if (this.timer) return;
    const interval = this.opts.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.timer = setInterval(() => this.sweep(), interval);
    // Don't block process exit.
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /** Returns the number of members flagged this sweep (useful for tests). */
  sweep(now: number = Date.now()): number {
    let flagged = 0;
    try {
      const teams = this.store.listTeams();
      for (const team of teams) {
        const timeout = team.config.idleTimeoutMs ?? this.opts.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
        for (const member of this.store.listMembers(team.id)) {
          if (member.state !== "ready") {
            // Clear prior warning — a transition means the member is active again.
            this.warned.delete(member.id);
            continue;
          }
          // Fall back to createdAt when lastActivityAt is missing or 0
          // (pre-feature snapshot). Without this, every ready member loaded
          // from an old snapshot would compute `age = now - 0` and warn on
          // the first sweep after upgrade.
          const activityTs =
            member.lastActivityAt && member.lastActivityAt > 0
              ? member.lastActivityAt
              : member.createdAt;
          const age = now - activityTs;
          if (age < timeout) {
            this.warned.delete(member.id);
            continue;
          }
          if (this.warned.has(member.id)) continue;
          this.warned.add(member.id);
          const mins = Math.floor(age / 60_000);
          this.reporter.warn(
            "[orch]",
            `${member.role} idle > ${mins}m (team ${team.name})`
          );
          flagged++;
        }
      }
    } catch {
      // Never let a sweep failure crash the plugin.
    }
    return flagged;
  }

  /** Test hook — forget we've warned about a member. */
  resetWarned(memberID?: string): void {
    if (memberID === undefined) this.warned.clear();
    else this.warned.delete(memberID);
  }
}
