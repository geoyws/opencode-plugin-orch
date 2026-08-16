import { tool, type ToolDefinition } from "@opencode-ai/plugin";
import { parseModelRef, type GoalController } from "../core/goal-controller.js";

export function createGoalTool(goals: GoalController): ToolDefinition {
  return tool({
    description:
      "Set, inspect, or clear the current OpenCode session's autonomous goal. " +
      "A set goal is independently evaluated after each turn and automatically " +
      "continues until met, impossible, cleared, stalled, or budget-exhausted.",
    args: {
      action: tool.schema.enum(["set", "status", "clear"]),
      condition: tool.schema.string().max(4000).optional(),
      evaluatorProvider: tool.schema.string().optional(),
      evaluatorModel: tool.schema.string().optional(),
      maxTurns: tool.schema.number().int().positive().optional(),
      maxDurationMs: tool.schema.number().int().positive().optional(),
      maxTokens: tool.schema.number().int().positive().optional(),
      softTokens: tool.schema.number().int().positive().optional(),
      noProgressLimit: tool.schema.number().int().positive().optional(),
      maxCost: tool.schema.number().positive().optional(),
    },
    async execute(args, context) {
      try {
        if (args.action === "status") return goals.status(context.sessionID);
        if (args.action === "clear") {
          const before = goals.status(context.sessionID);
          goals.clear(context.sessionID);
          return before === "No goal set." ? before : `Goal cleared.\n${before}`;
        }
        if (!args.condition?.trim()) {
          return "Error: condition is required for action=set";
        }
        const goal = goals.set(context.sessionID, args.condition, {
          evaluatorModel: parseModelRef(
            args.evaluatorProvider,
            args.evaluatorModel
          ),
          maxTurns: args.maxTurns,
          maxDurationMs: args.maxDurationMs,
          maxTokens: args.maxTokens,
          softTokens: args.softTokens,
          noProgressLimit: args.noProgressLimit,
          maxCost: args.maxCost,
        });
        return (
          `Goal active: ${goal.condition}\n` +
          `Continue working on it now and surface concrete completion evidence.`
        );
      } catch (err) {
        return `Error: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  });
}
