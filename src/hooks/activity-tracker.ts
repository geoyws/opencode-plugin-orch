import type { TeamManager } from "../core/team-manager.js";
import type { ActivityTracker } from "../core/activity.js";
import { logHookError } from "./_safe.js";

export function createActivityHook(
  manager: TeamManager,
  tracker: ActivityTracker,
  projectDir: string
) {
  return async (
    input: { tool: string; sessionID: string; callID: string; args: unknown },
    output: { title: string; output: string; metadata: unknown }
  ): Promise<void> => {
    try {
      const member = manager.getMemberBySession(input.sessionID);
      if (!member) return;

      // Extract a useful target from the tool call args
      let target = "";
      const args = input.args as Record<string, unknown> | null;
      if (args) {
        // Common patterns across tools
        target =
          (args.file_path as string) ??
          (args.path as string) ??
          (args.command as string) ??
          (args.pattern as string) ??
          "";
      }

      // Truncate commands for readability
      if (input.tool === "bash" && target.length > 40) {
        target = target.slice(0, 37) + "...";
      }

      tracker.record(member.id, input.tool, target);
      // Bump lastActivityAt so IdleMonitor considers the member active.
      // A member running a long tool call (e.g. bash) never transitions
      // state, so without this the idle monitor would flag them as stuck.
      manager.touchMember(member.id);
    } catch (err) {
      // Activity tracking is purely informational — on failure, silently
      // skip recording. Never crash the host.
      logHookError(projectDir, "tool.execute.after", err);
    }
  };
}
