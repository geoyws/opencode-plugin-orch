import { tool, type ToolDefinition } from "@opencode-ai/plugin";
import type { Runner } from "../core/runner.js";

export function createRunTool(runner: Runner): ToolDefinition {
  return tool({
    description:
      "Run a workflow as a set of ephemeral opencode agent sessions. By " +
      "default this tool stays attached until completion so one-shot CLI " +
      "processes cannot abort the workflow during shutdown. Set background=true " +
      "only in a persistent TUI/server session, then use orch_status and " +
      "orch_result to track it.",
    args: {
      workflow: tool.schema
        .string()
        .describe("Workflow name (see `orch_workflows list`)"),
      input: tool.schema.string().describe("Input text for the run"),
      background: tool.schema
        .boolean()
        .optional()
        .describe(
          "Detach immediately instead of waiting for completion. Use only when " +
            "OpenCode will remain running (for example the interactive TUI)."
        ),
      config: tool.schema
        .string()
        .optional()
        .describe(
          'Optional JSON config string: {"model":{"providerID":"...","modelID":"..."},' +
            '"maxIterations":N,"concurrency":N,"stepTimeoutMs":N,' +
            '"isolation":"worktree","gateCommand":"...","stepModels":{"<step-id>":{...}},' +
            '"maxStepOutputChars":N,"keepSessions":bool,"stepRetries":N,' +
            '"maxTokens":N,"softTokens":N,"maxCost":N,"maxAgents":N,"maxDurationMs":N,"permissionMode":"ask|auto"}. `model` overrides the model for every step; ' +
            '`maxTokens` prevents the next step after observed usage reaches the hard budget; ' +
            '`softTokens` switches downstream context to persisted compact checkpoints. ' +
            ' `stepModels` pins a model per step id (wins over step and run model).' +
            ' Step sessions are deleted when their step settles unless `keepSessions` is true.' +
            ' `stepRetries` (0-3, default 1) retries an LLM step on transient provider errors.'
        ),
    },
    async execute(args, context) {
      try {
        let overrides: unknown;
        if (args.config !== undefined) {
          try {
            overrides = JSON.parse(args.config);
          } catch (err) {
            return `Error: config is not valid JSON: ${
              err instanceof Error ? err.message : String(err)
            }`;
          }
        }
        const run = await runner.startRun(args.workflow, args.input, overrides);
        if (!args.background) {
          const settled = await runner.waitForSettled(run.id, context.abort);
          if (settled.status === "completed") {
            return (
              `Run ${settled.id} completed (workflow "${settled.workflow}", pattern ${settled.pattern}).` +
              `${settled.note ? `\nNote: ${settled.note}` : ""}` +
              `\n\nFinal output:\n${settled.output ?? ""}`
            );
          }
          if (settled.status === "paused") {
            return `Run ${settled.id} paused. Resume with orch_control.`;
          }
          return `Error: Run ${settled.id} ${settled.status}: ${settled.error ?? "no terminal reason recorded"}`;
        }
        return (
          `Run ${run.id} started (workflow "${run.workflow}", pattern ${run.pattern}). ` +
          `Track with orch_status, collect with orch_result.`
        );
      } catch (err) {
        return `Error: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  });
}
