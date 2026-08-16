import { tool, type ToolDefinition } from "@opencode-ai/plugin";
import { parseModelRef, type GoalController } from "../core/goal-controller.js";

export function createGoalTool(goals: GoalController): ToolDefinition {
  return tool({
    description:
      "Set, inspect, pause, resume, steer, or clear the current OpenCode session's autonomous goal. " +
      "Substantive work runs in a dedicated worker session while the current session remains the lead/control plane.",
    args: {
      action: tool.schema.enum(["set", "status", "pause", "resume", "steer", "clear"]),
      condition: tool.schema.string().max(4000).optional(),
      message: tool.schema.string().max(4000).optional(),
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
          await goals.clear(context.sessionID);
          return before === "No goal set." ? before : `Goal cleared.\n${before}`;
        }
        if (args.action === "pause") {
          const goal = await goals.pause(context.sessionID);
          return `Goal paused: ${goal.condition}`;
        }
        if (args.action === "resume") {
          const goal = await goals.resume(context.sessionID);
          return `Goal resumed in worker ${goal.workerSessionID}: ${goal.condition}`;
        }
        if (args.action === "steer") {
          if (!args.message?.trim()) return "Error: message is required for action=steer";
          const goal = await goals.steer(context.sessionID, args.message);
          return `Goal worker steered: ${goal.steering.at(-1)?.text}`;
        }
        if (!args.condition?.trim()) {
          return "Error: condition is required for action=set";
        }
        const goal = await goals.start(context.sessionID, args.condition, {
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
          `Goal active in dedicated worker ${goal.workerSessionID}: ${goal.condition}\n` +
          `Keep this lead conversation available for status, steering, pause, resume, or clear.`
        );
      } catch (err) {
        return `Error: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  });
}
