import type { TeamManager } from "../core/team-manager.js";
import type { ActivityTracker } from "../core/activity.js";
import { logHookError } from "./_safe.js";

// Fires on tool.execute.before. Just bumps the member's lastActivityAt so
// a long-running tool call (e.g. 30s bash) doesn't get flagged as idle
// mid-flight. The after hook (createActivityHook) records the tool call
// *and* bumps again once it completes.
export function createActivityBeforeHook(
  manager: TeamManager,
  projectDir: string
) {
  return async (
    input: { tool: string; sessionID: string; callID: string },
    _output: unknown
  ): Promise<void> => {
    try {
      const member = manager.getMemberBySession(input.sessionID);
      if (!member) return;
      manager.touchMember(member.id);
    } catch (err) {
      logHookError(projectDir, "tool.execute.before", err);
    }
  };
}

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
