import { tool, type ToolDefinition } from "@opencode-ai/plugin";
import type { TeamManager } from "../core/team-manager.js";
import type { MessageBus } from "../core/message-bus.js";
import type { RateLimiter } from "../core/rate-limit.js";
import { checkRate } from "./_rate.js";

export function createBroadcastTool(
  manager: TeamManager,
  bus: MessageBus,
  rateLimiter: RateLimiter
): ToolDefinition {
  return tool({
    description:
      "Broadcast a message to all active members in a team (skips shutdown/errored members and the sender). " +
      "Idle members are auto-woken. Members at their backpressure limit are silently skipped. " +
      "Returns the count of members reached.",
    args: {
      team: tool.schema.string().describe("Team name"),
      content: tool.schema.string().describe("Message content"),
    },
    async execute(args, context) {
      try {
        const rateErr = checkRate(rateLimiter, context, manager);
        if (rateErr) return rateErr;
        const team = manager.requireTeam(args.team);
        const senderMember = manager.getMemberBySession(context.sessionID);
        const fromRole = senderMember?.role ?? "lead";

        const ids = bus.broadcast(team.name, fromRole, args.content);
        return `Broadcast sent to ${ids.length} member(s)`;
      } catch (err) {
        return `Error: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  });
}
