// Shared rate-limit gate for member-callable orch_* tools.
//
// The lead session is authoritative — it bypasses the limiter entirely.
// Members are keyed by member.id so per-session buckets aren't affected by
// session churn during escalation/respawn.

import type { RateLimiter } from "../core/rate-limit.js";
import type { TeamManager } from "../core/team-manager.js";
import type { Team } from "../state/schemas.js";

export const RATE_LIMIT_MAX = 60;
export const RATE_LIMIT_WINDOW_MS = 60_000;

export function checkRate(
  rateLimiter: RateLimiter,
  context: { sessionID: string },
  manager: TeamManager,
  team?: Team
): string | null {
  const member = manager.getMemberBySession(context.sessionID);
  if (member) {
    if (!rateLimiter.tryAcquire(member.id)) {
      const retryMs = rateLimiter.retryAfter(member.id);
      return `Error: rate limit exceeded (${RATE_LIMIT_MAX} calls/min). Retry in ${Math.ceil(retryMs / 1000)}s.`;
    }
    return null;
  }
  // Non-member session. The lead is explicitly authoritative; unknown
  // non-member sessions no-op since opencode session IDs are opaque and
  // not forgeable in practice.
  if (team && context.sessionID === team.leadSessionID) return null;
  return null;
}
