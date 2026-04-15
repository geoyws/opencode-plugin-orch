// Shared rate-limit gate for member-callable orch_* tools.
//
// The lead session is authoritative — it bypasses the limiter entirely.
// Members are keyed by member.id so per-session buckets aren't affected by
// session churn during escalation/respawn.

import type { RateLimiter } from "../core/rate-limit.js";
import type { TeamManager } from "../core/team-manager.js";

export const RATE_LIMIT_MAX = 60;
export const RATE_LIMIT_WINDOW_MS = 60_000;

export function checkRate(
  rateLimiter: RateLimiter,
  context: { sessionID: string },
  manager: TeamManager
): string | null {
  const member = manager.getMemberBySession(context.sessionID);
  if (!member) return null; // lead or unknown session — not rate-limited
  if (!rateLimiter.tryAcquire(member.id)) {
    const retryMs = rateLimiter.retryAfter(member.id);
    return `Error: rate limit exceeded (${RATE_LIMIT_MAX} calls/min). Retry in ${Math.ceil(retryMs / 1000)}s.`;
  }
  return null;
}
