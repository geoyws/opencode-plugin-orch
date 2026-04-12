import { tool, type ToolDefinition } from "@opencode-ai/plugin";
import type { TeamManager } from "../core/team-manager.js";
import type { TaskBoard } from "../core/task-board.js";
import type { CostTracker } from "../core/cost-tracker.js";
import type { Store } from "../state/store.js";

export function createResultTool(
  manager: TeamManager,
  board: TaskBoard,
  costs: CostTracker,
  store: Store
): ToolDefinition {
  return tool({
    description:
      "Aggregate and display results from completed tasks. " +
      "Formats: summary (default), detailed, json.",
    args: {
      team: tool.schema.string().describe("Team name"),
      format: tool.schema
        .enum(["summary", "detailed", "json"])
        .optional()
        .describe("Output format (default: summary)"),
    },
    async execute(args) {
      const team = manager.requireTeam(args.team);
      const tasks = board.listTasks(team.id);
      const completed = tasks.filter((t) => t.status === "completed");
      const failed = tasks.filter((t) => t.status === "failed");
      const pending = tasks.filter((t) =>
        ["available", "claimed"].includes(t.status)
      );

      const format = args.format ?? "summary";

      if (format === "json") {
        return JSON.stringify(
          {
            team: team.name,
            totalCost: costs.getTeamCost(team.id),
            tasks: {
              total: tasks.length,
              completed: completed.length,
              failed: failed.length,
              pending: pending.length,
            },
            results: completed.map((t) => ({
              id: t.id,
              title: t.title,
              result: t.result,
              assignee: t.assignee
                ? store.getMember(t.assignee)?.role ?? t.assignee
                : null,
            })),
            failures: failed.map((t) => ({
              id: t.id,
              title: t.title,
              reason: t.result,
            })),
          },
          null,
          2
        );
      }

      const lines: string[] = [];
      lines.push(`# Results for team "${team.name}"`);
      lines.push(
        `Tasks: ${completed.length} completed, ${failed.length} failed, ${pending.length} remaining`
      );
      lines.push(`Total cost: ${costs.formatCost(costs.getTeamCost(team.id))}`);
      lines.push("");

      if (completed.length > 0) {
        lines.push("## Completed");
        for (const t of completed) {
          const assignee = t.assignee
            ? store.getMember(t.assignee)?.role ?? "?"
            : "unassigned";
          lines.push(`### ${t.title} (${assignee})`);
          if (format === "detailed") {
            lines.push(t.result ?? "(no result)");
          } else {
            // Summary: first line only
            const firstLine = (t.result ?? "(no result)").split("\n")[0];
            lines.push(firstLine);
          }
          lines.push("");
        }
      }

      if (failed.length > 0) {
        lines.push("## Failed");
        for (const t of failed) {
          lines.push(`- ${t.title}: ${t.result ?? "unknown"}`);
        }
        lines.push("");
      }

      if (pending.length > 0) {
        lines.push("## Remaining");
        for (const t of pending) {
          lines.push(`- [${t.status}] ${t.title}`);
        }
      }

      return lines.join("\n");
    },
  });
}
