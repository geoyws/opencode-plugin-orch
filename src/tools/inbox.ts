import { tool, type ToolDefinition } from "@opencode-ai/plugin";
import type { TeamManager } from "../core/team-manager.js";
import type { Store } from "../state/store.js";
import type { RateLimiterRegistry } from "../core/rate-limit.js";
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

export function createInboxTool(
  manager: TeamManager,
  store: Store,
  rateLimiter: RateLimiterRegistry
): ToolDefinition {
  return tool({
    description:
      "Team-lead inbox for peer messages (member → member DMs). " +
      "Actions: list (unread by default, all=true for all), count (number of unread), " +
      "mark_read (mark all current unread as read, clearing the inbox). " +
      "Messages the lead sent are never in this inbox.",
    args: {
      team: tool.schema.string().describe("Team name"),
      action: tool.schema
        .enum(["list", "count", "mark_read"])
        .describe("Action to perform"),
      all: tool.schema
        .boolean()
        .optional()
        .describe("For list: include already-read messages (default false)"),
      limit: tool.schema
        .number()
        .optional()
        .describe("For list: max messages to return (default 20, max 100)"),
    },
    async execute(args, context) {
      try {
        const team = manager.requireTeam(args.team);
        const rateErr = checkRate(rateLimiter, context, manager, team);
        if (rateErr) return rateErr;
        // Teams persisted before this field existed may deserialize without
        // it; store bypasses Zod on load, so we tolerate undefined here.
        const lastSeen = team.leadInboxLastSeenAt ?? 0;
        const peerMessages = store
          .getTeamMessages(team.id)
          .filter((m) => m.from !== "lead");

        switch (args.action) {
          case "count": {
            const unread = peerMessages.filter((m) => m.createdAt > lastSeen).length;
            return `${unread} unread peer message${unread === 1 ? "" : "s"}`;
          }

          case "list": {
            const filter = args.all
              ? peerMessages
              : peerMessages.filter((m) => m.createdAt > lastSeen);
            const limit = Math.min(args.limit ?? 20, 100);
            const sorted = filter
              .sort((a, b) => b.createdAt - a.createdAt)
              .slice(0, limit);

            if (sorted.length === 0) {
              return args.all
                ? `Inbox is empty (no peer messages in team "${team.name}")`
                : `No unread peer messages in team "${team.name}"`;
            }

            const lines = [
              `Inbox for "${team.name}" (${sorted.length} ${args.all ? "total" : "unread"}):`,
              "",
            ];
            for (const m of sorted) {
              const from = store.getMember(m.from)?.role ?? m.from;
              const to = store.getMember(m.to)?.role ?? m.to;
              const age = formatAge(Date.now() - m.createdAt);
              const body =
                m.content.length > 80 ? m.content.slice(0, 77) + "..." : m.content;
              lines.push(`  [${age}] ${from} → ${to}: ${body}`);
            }
            return lines.join("\n");
          }

          case "mark_read": {
            const now = Date.now();
            const before = peerMessages.filter((m) => m.createdAt > lastSeen).length;
            store.updateTeamInboxSeen(team.id, now);
            return `Marked ${before} message${before === 1 ? "" : "s"} as read`;
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
