import { tool, type ToolDefinition } from "@opencode-ai/plugin";
import type { TeamManager } from "../core/team-manager.js";
import type { TaskBoard } from "../core/task-board.js";
import type { CostTracker } from "../core/cost-tracker.js";
import type { Store } from "../state/store.js";
import type { RateLimiterRegistry } from "../core/rate-limit.js";
import { checkRate } from "./_rate.js";

const PROGRESS_WIDTH = 20;

function renderProgressBar(completed: number, total: number): string {
  if (total === 0) return "Progress: no tasks";
  const pct = Math.round((completed / total) * 100);
  const filled = Math.round((completed / total) * PROGRESS_WIDTH);
  const empty = PROGRESS_WIDTH - filled;
  return `Progress: ${"█".repeat(filled)}${"░".repeat(empty)} ${pct}%`;
}

export function createResultTool(
  manager: TeamManager,
  board: TaskBoard,
  costs: CostTracker,
  store: Store,
  rateLimiter: RateLimiterRegistry
): ToolDefinition {
  return tool({
    description:
      "Aggregate completed-task results from a team. Formats: summary (default, markdown with progress bar + one-line per task), " +
      "detailed (markdown with progress bar + full task results), json (machine-readable). " +
      "JSON shape: { team: string, " +
      "progress: {percent, completed, failed, remaining, total}, " +
      "totalCost: number, " +
      "tasks: {total, completed, failed, pending}, " +
      "results: Array<{id, title, result, assignee}>, " +
      "failures: Array<{id, title, reason}> }.",
    args: {
      team: tool.schema.string().describe("Team name"),
      format: tool.schema
        .enum(["summary", "detailed", "json"])
        .optional()
        .describe("Output format (default: summary)"),
    },
    async execute(args, context) {
      try {
      const team = manager.requireTeam(args.team);
      const rateErr = checkRate(rateLimiter, context, manager, team);
      if (rateErr) return rateErr;
      const tasks = board.listTasks(team.id);
      const completed = tasks.filter((t) => t.status === "completed");
      const failed = tasks.filter((t) => t.status === "failed");
      const pending = tasks.filter((t) =>
        ["available", "claimed"].includes(t.status)
      );

      const format = args.format ?? "summary";

      const progressPct =
        tasks.length === 0
          ? 0
          : Math.round((completed.length / tasks.length) * 100);

      if (format === "json") {
        return JSON.stringify(
          {
            team: team.name,
            progress: {
              percent: progressPct,
              completed: completed.length,
              failed: failed.length,
              remaining: pending.length,
              total: tasks.length,
            },
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
      lines.push(renderProgressBar(completed.length, tasks.length));
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
      } catch (err) {
        return `Error: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  });
}
