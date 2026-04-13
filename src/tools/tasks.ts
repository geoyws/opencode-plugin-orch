import { tool, type ToolDefinition } from "@opencode-ai/plugin";
import type { TeamManager } from "../core/team-manager.js";
import type { TaskBoard } from "../core/task-board.js";
import type { Store } from "../state/store.js";

export function createTasksTool(manager: TeamManager, board: TaskBoard, store: Store): ToolDefinition {
  return tool({
    description:
      "Manage the team task board. Actions: list (view tasks, optionally filtered by status), " +
      "add (create a task with optional dependencies and tags), claim (take an available task — only team members can claim), " +
      "complete (mark done with result text), fail (mark failed with reason). " +
      "Tasks with unmet dependencies cannot be claimed. Completed tasks auto-unblock dependents.",
    args: {
      team: tool.schema.string().describe("Team name"),
      action: tool.schema
        .enum(["list", "add", "claim", "complete", "fail"])
        .describe("Action to perform"),
      title: tool.schema.string().optional().describe("Task title (for add)"),
      description: tool.schema.string().optional().describe("Task description (for add)"),
      taskID: tool.schema.string().optional().describe("Task ID (for claim/complete/fail)"),
      result: tool.schema
        .string()
        .optional()
        .describe("Result or reason (for complete/fail)"),
      dependsOn: tool.schema
        .string()
        .optional()
        .describe("Comma-separated task IDs this depends on (for add)"),
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
          const deps = args.dependsOn
            ? args.dependsOn.split(",").map((s) => s.trim()).filter(Boolean)
            : undefined;
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

        default:
          return `Unknown action: ${args.action}`;
      }
      } catch (err) {
        return `Error: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  });
}
