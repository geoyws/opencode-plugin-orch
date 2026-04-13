import type { TeamManager } from "../core/team-manager.js";
import type { ActivityTracker } from "../core/activity.js";
import { logHookError } from "./_safe.js";

export function createActivityHook(
  manager: TeamManager,
  tracker: ActivityTracker
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
    } catch (err) {
      // Activity tracking is purely informational — on failure, silently
      // skip recording. Never crash the host.
      logHookError("tool.execute.after", err);
    }
  };
}
