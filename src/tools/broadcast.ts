import { tool, type ToolDefinition } from "@opencode-ai/plugin";
import type { TeamManager } from "../core/team-manager.js";
import type { MessageBus } from "../core/message-bus.js";
import type { RateLimiterRegistry } from "../core/rate-limit.js";
import { checkRate } from "./_rate.js";

// Convert a simple glob (with `*` wildcards) to a RegExp. Other regex
// metacharacters are escaped so a pattern like "coder-*" matches
// "coder-1" and "coder-2" but treats dots, brackets, etc. literally.
function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`);
}

export function createBroadcastTool(
  manager: TeamManager,
  bus: MessageBus,
  rateLimiter: RateLimiterRegistry
): ToolDefinition {
  return tool({
    description:
      "Broadcast a message to all active members in a team (skips shutdown/errored members and the sender). " +
      "Idle members are auto-woken. Members at their backpressure limit are silently skipped. " +
      "Optional rolePattern filter — simple glob with `*` wildcards (e.g. `coder-*` matches `coder-1`, `coder-2`); " +
      "omit to reach all active members. " +
      "Returns the count of members reached.",
    args: {
      team: tool.schema.string().describe("Team name"),
      content: tool.schema.string().describe("Message content"),
      rolePattern: tool.schema
        .string()
        .optional()
        .describe(
          "Optional glob pattern filter on role names. `*` is a wildcard (e.g. `coder-*`). Omit to broadcast to everyone."
        ),
    },
    async execute(args, context) {
      try {
        const team = manager.requireTeam(args.team);
        const rateErr = checkRate(rateLimiter, context, manager, team);
        if (rateErr) return rateErr;
        const senderMember = manager.getMemberBySession(context.sessionID);
        const fromRole = senderMember?.role ?? "lead";

        let filter: ((role: string) => boolean) | undefined;
        if (args.rolePattern) {
          const re = globToRegExp(args.rolePattern);
          filter = (role) => re.test(role);
        }

        const ids = bus.broadcast(team.name, fromRole, args.content, filter);
        const suffix = args.rolePattern ? ` matching "${args.rolePattern}"` : "";
        return `Broadcast sent to ${ids.length} member(s)${suffix}`;
      } catch (err) {
        return `Error: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  });
}
