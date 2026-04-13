import { tool, type ToolDefinition } from "@opencode-ai/plugin";
import type { TeamManager } from "../core/team-manager.js";

export function createSpawnTool(manager: TeamManager): ToolDefinition {
  return tool({
    description:
      "Spawn a new AI team member in a separate session. Each member needs a unique role name within the team. " +
      "The member gets its own context, receives instructions, and can coordinate via orch_message, orch_broadcast, " +
      "orch_tasks, and orch_memo. Optionally pre-load files into the member's context to save exploration time.",
    args: {
      team: tool.schema.string().describe("Team name"),
      role: tool.schema.string().describe("Unique role name for this member (e.g. reviewer, coder, tester)"),
      instructions: tool.schema
        .string()
        .describe("Detailed instructions for what this member should do"),
      agent: tool.schema
        .string()
        .optional()
        .describe("Agent type: plan, build, explore (default: build)"),
      providerID: tool.schema
        .string()
        .optional()
        .describe("Provider ID for the model (e.g. anthropic)"),
      modelID: tool.schema
        .string()
        .optional()
        .describe("Model ID (e.g. claude-sonnet-4-6)"),
      files: tool.schema
        .string()
        .optional()
        .describe("Comma-separated file paths to pre-load into context"),
    },
    async execute(args) {
      try {
        const team = manager.requireTeam(args.team);

        const model =
          args.providerID && args.modelID
            ? { providerID: args.providerID, modelID: args.modelID }
            : undefined;

        const files = args.files
          ? args.files.split(",").map((f) => f.trim()).filter(Boolean)
          : undefined;

        const member = await manager.spawnMember({
          teamID: team.id,
          role: args.role,
          instructions: args.instructions,
          agent: args.agent,
          model,
          files,
        });

        let output = `Spawned member "${member.role}" (id: ${member.id}, session: ${member.sessionID})`;
        if (files?.length) {
          output += `\nPre-loaded ${files.length} file(s) into context`;
        }
        if (model) {
          output += `\nModel: ${model.providerID}/${model.modelID}`;
        }
        if (args.agent) {
          output += `\nAgent: ${args.agent}`;
        }

        return output;
      } catch (err) {
        return `Error: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  });
}
