// Shared rate-limit gate for member-callable orch_* tools.
//
// The lead session is authoritative — it bypasses the limiter entirely.
// Members are keyed by member.id so per-session buckets aren't affected by
// session churn during escalation/respawn.
//
// Each team gets its own RateLimiter via the RateLimiterRegistry — teams
// can override the default via TeamConfig.rateLimit.

import type { RateLimiterRegistry } from "../core/rate-limit.js";
import type { TeamManager } from "../core/team-manager.js";
import type { Team } from "../state/schemas.js";

export function checkRate(
  registry: RateLimiterRegistry,
  context: { sessionID: string },
  manager: TeamManager,
  team?: Team
): string | null {
  const member = manager.getMemberBySession(context.sessionID);
  if (member) {
    // Resolve the per-team limiter using the member's team config.
    const memberTeam = manager.getTeamById(member.teamID);
    const limiter = registry.forTeam(
      member.teamID,
      memberTeam?.config.rateLimit
    );
    if (!limiter.tryAcquire(member.id)) {
      const retryMs = limiter.retryAfter(member.id);
      const cap = (memberTeam?.config.rateLimit ?? registry.defaultConfig).maxCalls;
      return `Error: rate limit exceeded (${cap} calls/min). Retry in ${Math.ceil(retryMs / 1000)}s.`;
    }
    return null;
  }
  // Non-member session. Lead is explicitly authoritative; unknown
  // non-member sessions no-op since opencode session IDs are opaque and
  // not forgeable in practice.
  if (team && context.sessionID === team.leadSessionID) return null;
  return null;
}
