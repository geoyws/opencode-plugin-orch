// Session revalidation — run on plugin init to detect members whose opencode
// session no longer exists (server restart, GC, etc.). Dead-session members
// are force-shutdown so we don't try to wake zombies during message delivery,
// work stealing, or escalation.
//
// Budget-sensitive: lives inside the 5-second init deadline. All per-member
// probes run with a 500ms timeout and the whole thing is wrapped in a top-
// level try/catch so a hang or failure here never blocks startup.

import type { PluginInput } from "@opencode-ai/plugin";
import type { Store } from "../state/store.js";
import type { FileLockManager } from "./file-locks.js";
import type { Reporter } from "./reporter.js";

const PROBE_TIMEOUT_MS = 500;

// Sentinel the probe resolves to on timeout — we treat this as "session still
// exists" (optimistic) rather than killing a member because opencode is slow.
const TIMEOUT_SENTINEL = Symbol("probe-timeout");

export async function revalidateMemberSessions(
  store: Store,
  fileLocks: FileLockManager,
  ctx: PluginInput,
  reporter: Reporter
): Promise<number> {
  let cleaned = 0;
  try {
    const teams = store.listTeams();
    for (const team of teams) {
      const members = store.listMembers(team.id);
      // Skip already-terminal members — their session state is irrelevant.
      const live = members.filter(
        (m) => m.state !== "shutdown" && m.state !== "error"
      );

      // Parallelize within a team so N members take ~500ms total, not N*500ms.
      const results = await Promise.all(
        live.map(async (m) => {
          const probe = (ctx.client as unknown as {
            session: { get(params: { path: { id: string } }): Promise<unknown> };
          }).session.get({ path: { id: m.sessionID } });

          const timer = new Promise<typeof TIMEOUT_SENTINEL>((resolve) => {
            setTimeout(() => resolve(TIMEOUT_SENTINEL), PROBE_TIMEOUT_MS);
          });

          try {
            const outcome = await Promise.race([
              probe.then(() => "alive" as const),
              timer,
            ]);
            return { member: m, alive: true, timedOut: outcome === TIMEOUT_SENTINEL };
          } catch {
            return { member: m, alive: false, timedOut: false };
          }
        })
      );

      for (const r of results) {
        if (r.alive) continue; // still alive, or timed out (optimistic)
        // Dead session — force to shutdown. We bypass the state machine because
        // a member in `initializing` has no valid direct transition to `shutdown`
        // via `canTransition`, but after a crash that's exactly where we land.
        store.updateMember({ ...r.member, state: "shutdown" });
        fileLocks.releaseAll(r.member.id);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      reporter.info(
        "[orch]",
        `cleaned ${cleaned} stale member${cleaned === 1 ? "" : "s"} on init`
      );
    }
  } catch {
    // Fault-tolerant by design: revalidation is an optimization, not a
    // correctness gate. If anything throws (bad SDK shape, store panic, etc.)
    // init still succeeds with whatever state we managed to clean up.
  }
  return cleaned;
}
