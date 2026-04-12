import { tool, type ToolDefinition } from "@opencode-ai/plugin";
import type { TeamManager } from "../core/team-manager.js";

export function createShutdownTool(manager: TeamManager): ToolDefinition {
  return tool({
    description:
      "Shutdown a specific team member or the entire team. " +
      "Aborts active sessions and releases file locks.",
    args: {
      team: tool.schema.string().describe("Team name"),
      member: tool.schema
        .string()
        .optional()
        .describe("Role name to shutdown (omit to shutdown entire team)"),
    },
    async execute(args) {
      const team = manager.requireTeam(args.team);

      if (args.member) {
        const member = manager.getMemberByRole(team.id, args.member);
        if (!member) return `Member "${args.member}" not found in team "${team.name}"`;

        await manager.shutdownMember(member.id);
        return `Member "${args.member}" shut down`;
      }

      await manager.shutdownTeam(args.team);
      return `Team "${team.name}" shut down (all members terminated)`;
    },
  });
}
