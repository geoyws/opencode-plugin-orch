import { tool, type ToolDefinition } from "@opencode-ai/plugin";
import type { TeamManager } from "../core/team-manager.js";
import type { MessageBus } from "../core/message-bus.js";

export function createMessageTool(manager: TeamManager, bus: MessageBus): ToolDefinition {
  return tool({
    description:
      "Send a message to a specific team member. If the member is idle, " +
      "they will be auto-woken. Messages are queued with backpressure limits.",
    args: {
      team: tool.schema.string().describe("Team name"),
      to: tool.schema.string().describe("Role name of the recipient"),
      content: tool.schema.string().describe("Message content"),
    },
    async execute(args, context) {
      const team = manager.requireTeam(args.team);

      // Determine sender role
      const senderMember = manager.getMemberBySession(context.sessionID);
      const fromRole = senderMember?.role ?? "lead";

      const msgID = bus.send(team.name, fromRole, args.to, args.content);
      return `Message sent to "${args.to}" (id: ${msgID})`;
    },
  });
}
