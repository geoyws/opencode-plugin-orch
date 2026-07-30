import { tool, type ToolDefinition } from "@opencode-ai/plugin";
import type { Runner } from "../core/runner.js";

export function createRunTool(runner: Runner): ToolDefinition {
  return tool({
    description:
      "Start a workflow run. The run executes in the background as a set of " +
      "ephemeral opencode sessions (one per step). Use orch_status to track " +
      "progress and orch_result to get the final output.",
    args: {
      workflow: tool.schema
        .string()
        .describe("Workflow name (see `orch_workflows list`)"),
      input: tool.schema.string().describe("Input text for the run"),
      config: tool.schema
        .string()
        .optional()
        .describe(
          'Optional JSON config string: {"model":{"providerID":"...","modelID":"..."},' +
            '"maxIterations":N,"concurrency":N,"stepTimeoutMs":N,' +
            '"isolation":"worktree","gateCommand":"...","stepModels":{"<step-id>":{...}},' +
            '"maxStepOutputChars":N,"keepSessions":bool,"stepRetries":N}. `model` overrides the model for every step;' +
            ' `stepModels` pins a model per step id (wins over step and run model).' +
            ' Step sessions are deleted when their step settles unless `keepSessions` is true.' +
            ' `stepRetries` (0-3, default 1) retries an LLM step on transient provider errors.'
        ),
    },
    async execute(args) {
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
