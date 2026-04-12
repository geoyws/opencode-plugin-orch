import { tool, type ToolDefinition } from "@opencode-ai/plugin";
import type { TeamManager } from "../core/team-manager.js";
import type { Scratchpad } from "../core/scratchpad.js";

export function createMemoTool(manager: TeamManager, pad: Scratchpad): ToolDefinition {
  return tool({
    description:
      "Shared team scratchpad — store and retrieve findings so teammates " +
      "don't duplicate work. Actions: set, get, list, delete.",
    args: {
      team: tool.schema.string().describe("Team name"),
      action: tool.schema
        .enum(["set", "get", "list", "delete"])
        .describe("Action to perform"),
      key: tool.schema.string().optional().describe("Memo key (for set/get/delete)"),
      value: tool.schema.string().optional().describe("Memo value (for set)"),
    },
    async execute(args) {
      const team = manager.requireTeam(args.team);

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
          const keys = Object.keys(entries);
          if (keys.length === 0) return "Scratchpad is empty.";
          const lines = keys.map((k) => `  ${k}: ${entries[k]}`);
          return `Scratchpad for "${team.name}":\n${lines.join("\n")}`;
        }

        case "delete": {
          if (!args.key) return "Error: key is required for delete";
          pad.delete(team.id, args.key);
          return `Memo deleted: ${args.key}`;
        }

        default:
          return `Unknown action: ${args.action}`;
      }
    },
  });
}
