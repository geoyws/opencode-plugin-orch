import { tool, type ToolDefinition } from "@opencode-ai/plugin";
import type { TeamManager } from "../core/team-manager.js";
import type { CostTracker } from "../core/cost-tracker.js";
import type { ActivityTracker } from "../core/activity.js";
import type { TaskBoard } from "../core/task-board.js";
import type { Store } from "../state/store.js";
import type { RateLimiterRegistry } from "../core/rate-limit.js";
import { stateIcon } from "../core/member.js";
import { checkRate } from "./_rate.js";

function formatAge(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export function createStatusTool(
  manager: TeamManager,
  costs: CostTracker,
  activity: ActivityTracker,
  board: TaskBoard,
  store: Store,
  rateLimiter: RateLimiterRegistry
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
    async execute(args, context) {
      try {
      const team = manager.requireTeam(args.team);
      const rateErr = checkRate(rateLimiter, context, manager, team);
      if (rateErr) return rateErr;
      const members = manager.listMembers(team.id);
      const tasks = board.listTasks(team.id);
      const teamCost = costs.getTeamCost(team.id);

      const activeCount = members.filter((m) =>
        !["shutdown", "error"].includes(m.state)
      ).length;
      const completedTasks = tasks.filter((t) => t.status === "completed").length;

      // Header
      const header = ` ${team.name}  ${activeCount}/${members.length} active  tasks ${completedTasks}/${tasks.length} done  ${costs.formatCost(teamCost)} `;

      // Member rows. If a ready member is past its idle timeout, surface
      // the staleness in the activity column so the lead sees it without
      // having to wait for the IdleMonitor warning toast.
      const now = Date.now();
      const idleTimeout = team.config.idleTimeoutMs ?? 600_000;
      const maxRoleLen = Math.max(...members.map((m) => m.role.length), 8);
      const memberRows = members.map((m) => {
        const icon = stateIcon(m.state);
        const role = m.role.padEnd(maxRoleLen);
        const state = m.state.padEnd(7);
        let act = activity.formatActivity(m.id);
        if (m.state === "ready") {
          const age = now - (m.lastActivityAt ?? 0);
          if (age >= idleTimeout) {
            const mins = Math.floor(age / 60_000);
            act = `idle ${mins}m`;
          }
        }
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

      // Recent peer messages — surfaces member-to-member chatter that the lead
      // would otherwise miss. Lead-originated messages are excluded because
      // the lead already saw them when they sent them.
      const limit = args.verbose ? 20 : 5;
      const peerMessages = store
        .getTeamMessages(team.id)
        .filter((m) => m.from !== "lead")
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, limit);
      lines.push("");
      if (peerMessages.length === 0) {
        lines.push("Recent messages: (none)");
      } else {
        lines.push("Recent messages:");
        for (const m of peerMessages.reverse()) {
          const fromRole = store.getMember(m.from)?.role ?? m.from;
          const toRole = store.getMember(m.to)?.role ?? m.to;
          const body = args.verbose
            ? m.content
            : m.content.length > 50
              ? m.content.slice(0, 49) + "…"
              : m.content;
          const age = formatAge(Date.now() - m.createdAt);
          lines.push(`  ${fromRole} → ${toRole}  "${body}" (${age})`);
        }
      }

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
      } catch (err) {
        return `Error: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  });
}
