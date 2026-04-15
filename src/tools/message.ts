import { tool, type ToolDefinition } from "@opencode-ai/plugin";
import type { TeamManager } from "../core/team-manager.js";
import type { MessageBus } from "../core/message-bus.js";
import type { RateLimiter } from "../core/rate-limit.js";
import { checkRate } from "./_rate.js";

export function createMessageTool(
  manager: TeamManager,
  bus: MessageBus,
  rateLimiter: RateLimiter
): ToolDefinition {
  return tool({
    description:
      "Send a message to a specific team member by role name. If the member is idle, they are auto-woken to process it. " +
      "Messages are queued — if the recipient has too many unread messages (backpressure limit, default 50), the send will fail. " +
      "Use orch_broadcast to message all members at once.",
    args: {
      team: tool.schema.string().describe("Team name"),
      to: tool.schema.string().describe("Role name of the recipient"),
      content: tool.schema.string().describe("Message content"),
    },
    async execute(args, context) {
      try {
        const team = manager.requireTeam(args.team);
        const rateErr = checkRate(rateLimiter, context, manager, team);
        if (rateErr) return rateErr;
        const senderMember = manager.getMemberBySession(context.sessionID);
        const fromRole = senderMember?.role ?? "lead";
        const msgID = bus.send(team.name, fromRole, args.to, args.content);
        return `Message sent to "${args.to}" (id: ${msgID})`;
      } catch (err) {
        return `Error: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  });
}
