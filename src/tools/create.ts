import { tool, type ToolDefinition } from "@opencode-ai/plugin";
import type { TeamManager } from "../core/team-manager.js";
import type { TeamConfig } from "../state/schemas.js";
import type { TemplateRegistry } from "../templates/index.js";

export function createCreateTool(manager: TeamManager, templates: TemplateRegistry): ToolDefinition {
  return tool({
    description:
      "Create a new agent team for orchestrating parallel AI teammates. " +
      "Optionally use a template (code-review, feature-build, debug-squad) " +
      "to auto-spawn members with predefined roles.",
    args: {
      name: tool.schema.string().describe("Unique team name"),
      template: tool.schema
        .string()
        .optional()
        .describe("Template name (code-review, feature-build, debug-squad)"),
      workStealing: tool.schema
        .boolean()
        .optional()
        .describe("Enable work stealing for idle members (default: true)"),
      backpressureLimit: tool.schema
        .number()
        .optional()
        .describe("Max pending messages per member (default: 50)"),
      budgetLimit: tool.schema
        .number()
        .optional()
        .describe("Max total spend for the team in dollars"),
      escalation: tool.schema
        .string()
        .optional()
        .describe(
          'Model escalation chain as JSON, e.g. \'[{"providerID":"anthropic","modelID":"haiku"},{"providerID":"anthropic","modelID":"sonnet"}]\''
        ),
      maxRetries: tool.schema
        .number()
        .optional()
        .describe("Max retries per escalation level (default: 1)"),
    },
    async execute(args, context) {
      const config: Partial<TeamConfig> = {
        workStealing: args.workStealing,
        backpressureLimit: args.backpressureLimit,
        budgetLimit: args.budgetLimit,
      };

      if (args.escalation) {
        try {
          const chain = JSON.parse(args.escalation);
          config.escalation = {
            enabled: true,
            chain,
            maxRetries: args.maxRetries ?? 1,
          };
        } catch {
          return "Error: Invalid escalation JSON";
        }
      }

      const team = manager.createTeam(args.name, context.sessionID, config);

      let output = `Team "${team.name}" created (id: ${team.id})`;

      // If template specified, describe what to spawn
      if (args.template) {
        const tmpl = templates.get(args.template);
        if (tmpl) {
          output += `\n\nTemplate "${args.template}" loaded. Spawn these members:`;
          for (const m of tmpl.members) {
            output += `\n  - ${m.role} (agent: ${m.agent ?? "default"})`;
            output += `\n    ${m.instructions}`;
          }
          output += "\n\nUse orch_spawn for each member, or I can auto-spawn them all.";

          // Auto-spawn template members
          const spawned: string[] = [];
          for (const m of tmpl.members) {
            try {
              await manager.spawnMember({
                teamID: team.id,
                role: m.role,
                instructions: m.instructions,
                agent: m.agent,
                model: m.model,
              });
              spawned.push(m.role);
            } catch (e) {
              output += `\nFailed to spawn ${m.role}: ${e}`;
            }
          }
          if (spawned.length > 0) {
            output = `Team "${team.name}" created with template "${args.template}"\n`;
            output += `Spawned members: ${spawned.join(", ")}`;
          }
        } else {
          output += `\nTemplate "${args.template}" not found. Available: ${templates.list().join(", ")}`;
        }
      }

      return output;
    },
  });
}
