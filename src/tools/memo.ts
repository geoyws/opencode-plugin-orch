import { tool, type ToolDefinition } from "@opencode-ai/plugin";
import type { TeamManager } from "../core/team-manager.js";
import type { Scratchpad } from "../core/scratchpad.js";
import type { RateLimiterRegistry } from "../core/rate-limit.js";
import { checkRate } from "./_rate.js";

export function createMemoTool(
  manager: TeamManager,
  pad: Scratchpad,
  rateLimiter: RateLimiterRegistry
): ToolDefinition {
  return tool({
    description:
      "Shared team scratchpad — store and retrieve findings so teammates " +
      "don't duplicate work. Actions: set, get, list, delete, append, prepend. " +
      "append/prepend grow a multiline memo without clobbering — append adds `\\n<value>` " +
      "at the end, prepend adds `<value>\\n` at the start; both create the memo if missing. " +
      "Known limitation: writes are last-write-wins at the store level, so two simultaneous " +
      "appends from different members could still race and lose one entry (rare in practice). " +
      "Keys may use a `scope:name` convention (e.g. `auth:jwt-secret`, `deploy:staging-url`) " +
      "to organize memos by subject; `list` groups keys by their scope prefix, and " +
      "`list scope=auth` filters to a single scope. The `:` is purely a presentation " +
      "hint — the store treats the full key literally.",
    args: {
      team: tool.schema.string().describe("Team name"),
      action: tool.schema
        .enum(["set", "get", "list", "delete", "append", "prepend"])
        .describe("Action to perform"),
      key: tool.schema.string().optional().describe("Memo key (for set/get/delete/append/prepend)"),
      value: tool.schema.string().optional().describe("Memo value (for set/append/prepend)"),
      scope: tool.schema
        .string()
        .optional()
        .describe(
          "Scope filter for list (e.g. 'auth' or 'auth:'). Returns only keys with the given scope prefix."
        ),
    },
    async execute(args, context) {
      try {
      const team = manager.requireTeam(args.team);
      const rateErr = checkRate(rateLimiter, context, manager, team);
      if (rateErr) return rateErr;

      switch (args.action) {
        case "set": {
          if (!args.key) return "Error: key is required for set";
          if (!args.value) return "Error: value is required for set";
          pad.set(team.id, args.key, args.value);
          return `Memo set: ${args.key}`;
        }

        case "get": {
          if (!args.key) return "Error: key is required for get";
          const val = pad.get(team.id, args.key);
          if (val === undefined) return `Memo "${args.key}" not found`;
          return `${args.key}: ${val}`;
        }

        case "list": {
          const entries = pad.list(team.id);
          const allKeys = Object.keys(entries);
          if (allKeys.length === 0) return "Scratchpad is empty.";

          let keys = allKeys;
          if (args.scope) {
            const scope = args.scope.replace(/:$/, "");
            keys = allKeys.filter((k) => k.startsWith(`${scope}:`));
            if (keys.length === 0) {
              return `No memos in scope "${scope}" for team "${team.name}".`;
            }
          }

          // Group by the text before the first ':'. Keys with no ':' go into
          // a synthetic "(unscoped)" bucket that is rendered last.
          const UNSCOPED = "(unscoped)";
          const groups = new Map<string, string[]>();
          for (const k of keys) {
            const idx = k.indexOf(":");
            const s = idx === -1 ? UNSCOPED : k.slice(0, idx);
            const bucket = groups.get(s) ?? [];
            bucket.push(k);
            groups.set(s, bucket);
          }

          const sortedScopes = [...groups.keys()].sort((a, b) => {
            if (a === UNSCOPED) return 1;
            if (b === UNSCOPED) return -1;
            return a.localeCompare(b);
          });

          const scopeCount = sortedScopes.length;
          const memoCount = keys.length;
          const lines = [
            `Scratchpad for "${team.name}" (${scopeCount} scope${
              scopeCount === 1 ? "" : "s"
            }, ${memoCount} memo${memoCount === 1 ? "" : "s"}):`,
            "",
          ];
          for (const s of sortedScopes) {
            lines.push(`${s}:`);
            for (const k of groups.get(s)!.sort()) {
              lines.push(`  ${k} = ${entries[k]}`);
            }
            lines.push("");
          }
          while (lines[lines.length - 1] === "") lines.pop();
          return lines.join("\n");
        }

        case "delete": {
          if (!args.key) return "Error: key is required for delete";
          pad.delete(team.id, args.key);
          return `Memo deleted: ${args.key}`;
        }

        case "append": {
          if (!args.key) return "Error: key is required for append";
          // Allow value="" so callers can intentionally add a blank line
          // to a log-style memo. `set` still rejects empty values.
          if (args.value === undefined) return "Error: value is required for append";
          const current = pad.get(team.id, args.key);
          const next = current === undefined ? args.value : `${current}\n${args.value}`;
          pad.set(team.id, args.key, next);
          const entries = next.split("\n").length;
          return `Appended to ${args.key} (${entries} ${entries === 1 ? "entry" : "entries"})`;
        }

        case "prepend": {
          if (!args.key) return "Error: key is required for prepend";
          if (args.value === undefined) return "Error: value is required for prepend";
          const current = pad.get(team.id, args.key);
          const next = current === undefined ? args.value : `${args.value}\n${current}`;
          pad.set(team.id, args.key, next);
          const entries = next.split("\n").length;
          return `Prepended to ${args.key} (${entries} ${entries === 1 ? "entry" : "entries"})`;
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
