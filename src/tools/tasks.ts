import { tool, type ToolDefinition } from "@opencode-ai/plugin";
import type { TeamManager } from "../core/team-manager.js";
import type { TaskBoard } from "../core/task-board.js";
import type { Store } from "../state/store.js";
import type { RateLimiterRegistry } from "../core/rate-limit.js";
import { checkRate } from "./_rate.js";

export function createTasksTool(
  manager: TeamManager,
  board: TaskBoard,
  store: Store,
  rateLimiter: RateLimiterRegistry
): ToolDefinition {
  return tool({
    description:
      "Manage the team task board. Actions: list (view tasks, optionally filtered by status), " +
      "add (create a task with optional dependencies and tags), claim (take an available task — only team members can claim), " +
      "complete (mark done with result text), fail (mark failed with reason), " +
      "unblock (clear all dependencies on an available task — escape hatch when an upstream dep is stuck), " +
      "reassign (move a claimed task to a different member by role — avoids going through fail), " +
      "add_many (bulk-add multiple tasks from a JSON array; later tasks can depend on earlier ones by title; " +
      "NOT atomic — on failure, already-created tasks are kept and the error reports the partial count). " +
      "Tasks with unmet dependencies cannot be claimed. Completed tasks auto-unblock dependents.",
    args: {
      team: tool.schema.string().describe("Team name"),
      action: tool.schema
        .enum(["list", "add", "add_many", "claim", "complete", "fail", "unblock", "reassign"])
        .describe("Action to perform"),
      title: tool.schema.string().optional().describe("Task title (for add)"),
      description: tool.schema.string().optional().describe("Task description (for add)"),
      taskID: tool.schema.string().optional().describe("Task ID (for claim/complete/fail/unblock/reassign)"),
      to: tool.schema
        .string()
        .optional()
        .describe("Role name of the new assignee (for reassign)"),
      tasks: tool.schema
        .string()
        .optional()
        .describe(
          "JSON array of tasks for add_many. Each entry: " +
          "{ title, description?, dependsOn?: string[], tags?: string[] }. " +
          "dependsOn entries may be task IDs or case-insensitive titles of tasks in the same team " +
          "(including titles of earlier entries in the same add_many call)."
        ),
      result: tool.schema
        .string()
        .optional()
        .describe("Result or reason (for complete/fail)"),
      dependsOn: tool.schema
        .string()
        .optional()
        .describe(
          "Comma-separated task IDs OR titles this task depends on (for add). " +
          "Each entry is tried as a task ID first, then as a case-insensitive exact title match within the same team."
        ),
      tags: tool.schema
        .string()
        .optional()
        .describe("Comma-separated tags (for add)"),
      filter: tool.schema
        .enum(["available", "claimed", "completed", "failed"])
        .optional()
        .describe("Filter by status (for list)"),
    },
    async execute(args, context) {
      try {
      const team = manager.requireTeam(args.team);
      const rateErr = checkRate(rateLimiter, context, manager, team);
      if (rateErr) return rateErr;

      switch (args.action) {
        case "list": {
          const tasks = board.listTasks(team.id, args.filter);
          if (tasks.length === 0) return "No tasks found.";

          const lines = tasks.map((t) => {
            const assignee = t.assignee
              ? store.getMember(t.assignee)?.role ?? t.assignee
              : "-";
            const deps = t.dependsOn.length > 0 ? ` (deps: ${t.dependsOn.join(",")})` : "";
            return `  ${t.id}  [${t.status}]  ${t.title}  assignee:${assignee}${deps}`;
          });
          return `Tasks for team "${team.name}":\n${lines.join("\n")}`;
        }

        case "add": {
          if (!args.title) return "Error: title is required for add";
          let deps: string[] | undefined;
          if (args.dependsOn) {
            const rawDeps = args.dependsOn
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean);
            const resolved: string[] = [];
            const teamTasks = board.listTasks(team.id);
            for (const entry of rawDeps) {
              // Try as task ID first (O(1) in the store).
              if (store.getTask(entry)) {
                resolved.push(entry);
                continue;
              }
              // Fall back to case-insensitive exact title match within the team.
              const byTitle = teamTasks.find(
                (t) => t.title.toLowerCase() === entry.toLowerCase()
              );
              if (byTitle) {
                resolved.push(byTitle.id);
                continue;
              }
              return `Error: dependency "${entry}" not found (tried as both task ID and task title)`;
            }
            deps = resolved;
          }
          const tags = args.tags
            ? args.tags.split(",").map((s) => s.trim()).filter(Boolean)
            : undefined;

          const task = board.addTask(team.id, args.title, args.description ?? "", {
            dependsOn: deps,
            tags,
          });
          return `Task added: "${task.title}" (id: ${task.id})`;
        }

        case "claim": {
          if (!args.taskID) return "Error: taskID is required for claim";
          const member = manager.getMemberBySession(context.sessionID);
          if (!member) return "Error: Only team members can claim tasks";

          const task = board.claim(args.taskID, member.id);
          return `Claimed task "${task.title}"`;
        }

        case "complete": {
          if (!args.taskID) return "Error: taskID is required for complete";
          const task = board.complete(args.taskID, args.result ?? "Done");
          return `Completed task "${task.title}"`;
        }

        case "fail": {
          if (!args.taskID) return "Error: taskID is required for fail";
          const task = board.fail(args.taskID, args.result ?? "Unknown failure");
          return `Failed task "${task.title}"`;
        }

        case "unblock": {
          if (!args.taskID) return "Error: taskID is required for unblock";
          const { task, cleared } = board.unblock(args.taskID);
          return `Unblocked task "${task.title}": cleared ${cleared} ${
            cleared === 1 ? "dependency" : "dependencies"
          }`;
        }

        case "reassign": {
          if (!args.taskID) return "Error: taskID is required for reassign";
          if (!args.to) return "Error: to is required for reassign";
          const current = store.getTask(args.taskID);
          if (!current) return `Error: Task ${args.taskID} not found`;
          const newAssignee = manager.getMemberByRole(team.id, args.to);
          if (!newAssignee) {
            return `Error: Member "${args.to}" not found in team "${team.name}"`;
          }
          if (["shutdown", "error"].includes(newAssignee.state)) {
            return `Error: Cannot reassign to "${args.to}" — state is ${newAssignee.state}`;
          }
          if (newAssignee.id === current.assignee) {
            return `Task "${current.title}" is already assigned to ${args.to}`;
          }
          const oldRole = current.assignee
            ? store.getMember(current.assignee)?.role ?? current.assignee
            : "unassigned";
          const task = board.reassign(args.taskID, newAssignee.id);
          return `Reassigned task "${task.title}" from ${oldRole} to ${args.to}`;
        }

        case "add_many": {
          if (!args.tasks) return "Error: tasks JSON array is required for add_many";
          type Spec = {
            title?: string;
            description?: string;
            dependsOn?: string[];
            tags?: string[];
          };
          let parsed: Spec[];
          try {
            const raw = JSON.parse(args.tasks);
            if (!Array.isArray(raw)) throw new Error("expected array");
            parsed = raw as Spec[];
          } catch (e) {
            return `Error: invalid tasks JSON: ${
              e instanceof Error ? e.message : String(e)
            }`;
          }

          // Build a lowercase-title → id index once upfront, then keep it in
          // sync with each successful board.addTask. This keeps dep-by-title
          // lookup O(1) per entry instead of O(N) per entry (the previous
          // code called board.listTasks() inside the loop — quadratic on
          // long chains). store.getTask() is already O(1), so IDs go
          // straight through.
          const titleToID = new Map<string, string>();
          for (const t of board.listTasks(team.id)) {
            titleToID.set(t.title.toLowerCase(), t.id);
          }

          const created: string[] = [];
          for (const spec of parsed) {
            if (!spec.title) {
              return `Error: each task needs a title (got: ${JSON.stringify(spec)}) (created ${
                created.length
              } task${created.length === 1 ? "" : "s"} before failure)`;
            }

            let deps: string[] | undefined;
            if (spec.dependsOn && spec.dependsOn.length > 0) {
              const resolved: string[] = [];
              for (const entry of spec.dependsOn) {
                if (store.getTask(entry)) {
                  resolved.push(entry);
                  continue;
                }
                const byTitle = titleToID.get(entry.toLowerCase());
                if (byTitle) {
                  resolved.push(byTitle);
                  continue;
                }
                return `Error: failed adding task "${spec.title}": dependency "${entry}" not found (tried as both task ID and task title) (created ${
                  created.length
                } task${created.length === 1 ? "" : "s"} before failure)`;
              }
              deps = resolved;
            }

            try {
              const task = board.addTask(
                team.id,
                spec.title,
                spec.description ?? "",
                { dependsOn: deps, tags: spec.tags }
              );
              created.push(task.id);
              titleToID.set(task.title.toLowerCase(), task.id);
            } catch (e) {
              return `Error: failed adding task "${spec.title}": ${
                e instanceof Error ? e.message : String(e)
              } (created ${created.length} task${
                created.length === 1 ? "" : "s"
              } before failure)`;
            }
          }
          return `Added ${created.length} task${created.length === 1 ? "" : "s"}`;
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
