import { tool, type ToolDefinition } from "@opencode-ai/plugin";
import type { TeamManager } from "../core/team-manager.js";
import type { MessageBus } from "../core/message-bus.js";

export function createBroadcastTool(manager: TeamManager, bus: MessageBus): ToolDefinition {
  return tool({
    description:
      "Broadcast a message to all active members in a team. " +
      "Idle members are auto-woken. Skips members at backpressure limit.",
    args: {
      team: tool.schema.string().describe("Team name"),
      content: tool.schema.string().describe("Message content"),
    },
    async execute(args, context) {
      const team = manager.requireTeam(args.team);
      const senderMember = manager.getMemberBySession(context.sessionID);
      const fromRole = senderMember?.role ?? "lead";

      const ids = bus.broadcast(team.name, fromRole, args.content);
      return `Broadcast sent to ${ids.length} member(s)`;
    },
  });
}
