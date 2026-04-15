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
      "default mode is NOT atomic — on failure, already-created tasks are kept and the error reports the partial count, " +
      "and if two specs in the same call share a title, later by-title dependency lookups resolve to the most recently created task. " +
      "Pass atomic=true to validate the whole batch first (rejects duplicate titles in the batch and any unresolvable deps) " +
      "and only commit if validation passes — guarantees all-or-nothing on bad input), " +
      "deps (visualize the dep graph for the team — without taskID renders an ASCII tree from each root task; " +
      "with taskID shows that task's upstream dependencies and downstream dependents). " +
      "Tasks with unmet dependencies cannot be claimed. Completed tasks auto-unblock dependents.",
    args: {
      team: tool.schema.string().describe("Team name"),
      action: tool.schema
        .enum(["list", "add", "add_many", "claim", "complete", "fail", "unblock", "reassign", "deps"])
        .describe("Action to perform"),
      title: tool.schema.string().optional().describe("Task title (for add)"),
      description: tool.schema.string().optional().describe("Task description (for add)"),
      taskID: tool.schema.string().optional().describe("Task ID (for claim/complete/fail/unblock/reassign; optional for deps)"),
      to: tool.schema
        .string()
        .optional()
        .describe("Role name of the new assignee (for reassign)"),
      tasks: tool.schema
        .string()
        .optional()
        .describe(
          "JSON array of tasks for add_many. Each entry: " +
          "{ title, description?, dependsOn?: string[], tags?: string[], priority?: number }. " +
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
      priority: tool.schema
        .number()
        .int()
        .optional()
        .describe(
          "Task priority (for add). Higher = more important; work-stealing and claim ordering prefer higher priority. Default 0."
        ),
      filter: tool.schema
        .enum(["available", "claimed", "completed", "failed"])
        .optional()
        .describe("Filter by status (for list)"),
      atomic: tool.schema
        .boolean()
        .optional()
        .describe(
          "If true, add_many validates the whole batch first and commits only if every spec passes; " +
          "rejects duplicate titles in the batch. Default false (partial-success semantics)."
        ),
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
            const prio = ` p:${t.priority ?? 0}`;
            return `  ${t.id}  [${t.status}]  ${t.title}  assignee:${assignee}${prio}${deps}`;
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
            priority: args.priority,
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
            priority?: number;
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

          const atomic = args.atomic === true;

          if (atomic) {
            // Pass 1 — pure validation, no side effects. Simulate the same
            // dep resolution the commit pass will do, tracking proposed
            // batch titles in a shadow set so later entries can reference
            // earlier ones by title. If anything fails here we bail with a
            // single error string and zero tasks created.
            const batchTitles = new Set<string>();
            for (let i = 0; i < parsed.length; i++) {
              const spec = parsed[i];
              if (!spec.title) {
                return `Error: validation failed for atomic add_many: spec at index ${i} has no title`;
              }
              const lower = spec.title.toLowerCase();
              if (batchTitles.has(lower)) {
                return `Error: validation failed for atomic add_many: duplicate title "${spec.title}" in batch`;
              }
              if (spec.dependsOn) {
                for (const entry of spec.dependsOn) {
                  if (store.getTask(entry)) continue;
                  if (titleToID.has(entry.toLowerCase())) continue;
                  if (batchTitles.has(entry.toLowerCase())) continue;
                  return `Error: validation failed for atomic add_many: dependency "${entry}" for task "${spec.title}" not found`;
                }
              }
              batchTitles.add(lower);
            }
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
                { dependsOn: deps, tags: spec.tags, priority: spec.priority }
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
          return atomic
            ? `Added ${created.length} task${created.length === 1 ? "" : "s"} (atomic)`
            : `Added ${created.length} task${created.length === 1 ? "" : "s"}`;
        }

        case "deps": {
          const tasks = board.listTasks(team.id);
          if (tasks.length === 0) return `No tasks in team "${team.name}"`;

          const byID = new Map(tasks.map((t) => [t.id, t]));

          if (args.taskID) {
            const focus = byID.get(args.taskID);
            if (!focus) return `Error: Task ${args.taskID} not found`;

            const upstream = focus.dependsOn
              .map((id) => byID.get(id))
              .filter((t): t is NonNullable<typeof t> => !!t);
            const downstream = tasks.filter((t) => t.dependsOn.includes(focus.id));

            const lines: string[] = [];
            lines.push(`Task "${focus.title}" (id: ${focus.id}) [${focus.status}]:`);
            lines.push("  Depends on (upstream):");
            if (upstream.length === 0) {
              lines.push("    (none)");
            } else {
              for (const t of upstream) {
                lines.push(`    - ${t.title} (${t.status})`);
              }
            }
            lines.push("  Required by (downstream):");
            if (downstream.length === 0) {
              lines.push("    (none)");
            } else {
              for (const t of downstream) {
                lines.push(`    - ${t.title} (${t.status})`);
              }
            }
            return lines.join("\n");
          }

          // Whole-graph mode. Build dependent-of map (parent → children
          // where a child is any task that depends on the parent), find
          // root tasks (no dependsOn), then walk the tree from each root.
          // Diamond dependencies render the shared task once per parent
          // (duplicate-render); future readers can switch to dedupe-and-
          // mark if the noise becomes a problem.
          const dependentsOf = new Map<string, string[]>();
          for (const t of tasks) {
            for (const depID of t.dependsOn) {
              const arr = dependentsOf.get(depID) ?? [];
              arr.push(t.id);
              dependentsOf.set(depID, arr);
            }
          }
          const roots = tasks.filter((t) => t.dependsOn.length === 0);
          const lines: string[] = [`Task dependency graph for "${team.name}":`];

          // Defensive: addTask validates deps so a cycle is unreachable
          // via the public API, but a future mutation path could leave
          // every task with an upstream dep. Surface that explicitly
          // instead of rendering a silent header-only graph.
          if (roots.length === 0 && tasks.length > 0) {
            lines.push(
              "  (no root tasks — graph may be cyclic or all tasks have upstream deps)"
            );
            return lines.join("\n");
          }

          // `visited` is per-path, not global: diamond dependencies
          // legitimately need shared nodes to render multiple times, but
          // cycles-on-the-same-path would otherwise stack-overflow. When
          // we hit a node already on the current path, emit a [cycle]
          // marker and bail out of that branch.
          const renderNode = (
            id: string,
            prefix: string,
            isLast: boolean,
            visited: Set<string>
          ): void => {
            const t = byID.get(id);
            if (!t) return;
            const branch = isLast ? "└─ " : "├─ ";
            if (visited.has(id)) {
              lines.push(`${prefix}${branch}${t.title}  [cycle]`);
              return;
            }
            const depHint =
              t.dependsOn.length > 0
                ? ` (depends on ${t.dependsOn
                    .map((d) => byID.get(d)?.title ?? d)
                    .join(", ")})`
                : "";
            lines.push(`${prefix}${branch}${t.title}  [${t.status}]${depHint}`);
            const nextVisited = new Set(visited);
            nextVisited.add(id);
            const childPrefix = prefix + (isLast ? "   " : "│  ");
            const kids = dependentsOf.get(t.id) ?? [];
            kids.forEach((kid, i) =>
              renderNode(kid, childPrefix, i === kids.length - 1, nextVisited)
            );
          };

          for (const root of roots) {
            lines.push(`  ${root.title}  [${root.status}]`);
            const kids = dependentsOf.get(root.id) ?? [];
            const visited = new Set<string>([root.id]);
            kids.forEach((kid, i) =>
              renderNode(kid, "  ", i === kids.length - 1, visited)
            );
          }

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
