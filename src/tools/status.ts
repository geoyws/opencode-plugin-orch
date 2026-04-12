import { tool, type ToolDefinition } from "@opencode-ai/plugin";
import type { TeamManager } from "../core/team-manager.js";
import type { CostTracker } from "../core/cost-tracker.js";
import type { ActivityTracker } from "../core/activity.js";
import type { TaskBoard } from "../core/task-board.js";
import type { Store } from "../state/store.js";
import { stateIcon } from "../core/member.js";

export function createStatusTool(
  manager: TeamManager,
  costs: CostTracker,
  activity: ActivityTracker,
  board: TaskBoard,
  store: Store
): ToolDefinition {
  return tool({
    description:
      "Show a powerline-formatted team overview with member states, " +
      "current activity, costs, and task progress.",
    args: {
      team: tool.schema.string().describe("Team name"),
      verbose: tool.schema
        .boolean()
        .optional()
        .describe("Show detailed task list (default: false)"),
    },
    async execute(args) {
      const team = manager.requireTeam(args.team);
      const members = manager.listMembers(team.id);
      const tasks = board.listTasks(team.id);
      const teamCost = costs.getTeamCost(team.id);

      const activeCount = members.filter((m) =>
        !["shutdown", "error"].includes(m.state)
      ).length;
      const completedTasks = tasks.filter((t) => t.status === "completed").length;

      // Header
      const header = ` ${team.name}  ${activeCount}/${members.length} active  tasks ${completedTasks}/${tasks.length} done  ${costs.formatCost(teamCost)} `;

      // Member rows
      const maxRoleLen = Math.max(...members.map((m) => m.role.length), 8);
      const memberRows = members.map((m) => {
        const icon = stateIcon(m.state);
        const role = m.role.padEnd(maxRoleLen);
        const state = m.state.padEnd(7);
        const act = activity.formatActivity(m.id);
        const cost = costs.formatCost(costs.getMemberCost(m.id));
        return `│ ${role}  ${icon} ${state} ${act.padEnd(30)} ${cost}│`;
      });

      const width = Math.max(header.length, ...memberRows.map((r) => r.length), 48);
      const border = "─".repeat(width - 2);

      const lines = [
        header,
        `╭${border}╮`,
        ...memberRows,
        `╰${border}╯`,
      ];

      // Verbose: task list
      if (args.verbose) {
        lines.push("");
        lines.push("Tasks:");
        for (const t of tasks) {
          const assignee = t.assignee
            ? store.getMember(t.assignee)?.role ?? "?"
            : "-";
          lines.push(`  [${t.status}] ${t.title} (${assignee})`);
        }
      }

      // Budget warning
      if (team.config.budgetLimit) {
        const pct = (teamCost / team.config.budgetLimit) * 100;
        if (pct >= 80) {
          lines.push(`\n⚠ Budget: ${costs.formatCost(teamCost)} / ${costs.formatCost(team.config.budgetLimit)} (${pct.toFixed(0)}%)`);
        }
      }

      return lines.join("\n");
    },
  });
}
