import { tool, type ToolDefinition } from "@opencode-ai/plugin";
import type { TeamManager } from "../core/team-manager.js";
import type { Store } from "../state/store.js";

export function createTeamTool(
  manager: TeamManager,
  store: Store
): ToolDefinition {
  return tool({
    description:
      "List, inspect, or prune agent teams. Actions: list (all teams with summary stats), " +
      "info (detailed view of a specific team), prune (delete teams whose members are all " +
      "shutdown/error or that have no members — keeps historical tasks/messages/costs). " +
      "Useful when you don't remember team names or want to tidy up after smoke tests.",
    args: {
      action: tool.schema
        .enum(["list", "info", "prune"])
        .describe("Action to perform"),
      team: tool.schema
        .string()
        .optional()
        .describe("Team name (required for info action)"),
    },
    async execute(args) {
      try {
        switch (args.action) {
          case "list": {
            const teams = store.listTeams();
            if (teams.length === 0) return "No teams exist.";

            const lines = [
              `${teams.length} team${teams.length === 1 ? "" : "s"}:`,
              "",
            ];
            for (const t of teams) {
              const members = store.listMembers(t.id);
              const active = members.filter(
                (m) => !["shutdown", "error"].includes(m.state)
              ).length;
              const tasks = store.listTasks(t.id);
              const completed = tasks.filter((tk) => tk.status === "completed").length;
              lines.push(
                `  ${t.name}  ${active}/${members.length} active  ${completed}/${tasks.length} tasks done`
              );
            }
            return lines.join("\n");
          }

          case "prune": {
            const teams = store.listTeams();
            const prunable = teams.filter((t) => {
              const members = store.listMembers(t.id);
              if (members.length === 0) return true;
              return members.every(
                (m) => m.state === "shutdown" || m.state === "error"
              );
            });
            if (prunable.length === 0) {
              return "No prunable teams (all teams have active members)";
            }
            for (const t of prunable) {
              for (const m of store.listMembers(t.id)) {
                store.deleteMember(m.id);
              }
              store.deleteTeam(t.id);
            }
            const names = prunable.map((t) => t.name).join(", ");
            return `Pruned ${prunable.length} team${
              prunable.length === 1 ? "" : "s"
            }: ${names}`;
          }

          case "info": {
            if (!args.team) return "Error: team is required for info action";
            const team = manager.requireTeam(args.team);
            const members = store.listMembers(team.id);
            const tasks = store.listTasks(team.id);
            const messages = store.getTeamMessages(team.id);

            const memberSummary =
              members.map((m) => `${m.role}:${m.state}`).join(", ") || "none";
            const budgetBit = team.config.budgetLimit
              ? `, budget=$${team.config.budgetLimit}`
              : "";
            const completed = tasks.filter((t) => t.status === "completed").length;
            const failed = tasks.filter((t) => t.status === "failed").length;
            const peerCount = messages.filter((m) => m.from !== "lead").length;

            const lines = [
              `Team: ${team.name}`,
              `  ID: ${team.id}`,
              `  Lead session: ${team.leadSessionID}`,
              `  Created: ${new Date(team.createdAt).toISOString()}`,
              `  Config: workStealing=${team.config.workStealing}, backpressure=${team.config.backpressureLimit}${budgetBit}`,
              `  Members: ${members.length} (${memberSummary})`,
              `  Tasks: ${tasks.length} (${completed} completed, ${failed} failed)`,
              `  Messages: ${messages.length} (${peerCount} peer)`,
            ];
            return lines.join("\n");
          }

          default:
            return `Unknown action: ${args.action}`;
        }
      } catch (err) {
        return `Error: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  });
}
