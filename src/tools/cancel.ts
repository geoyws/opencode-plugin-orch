import { tool, type ToolDefinition } from "@opencode-ai/plugin";
import type { Store } from "../state/store.js";
import type { Runner } from "../core/runner.js";

export function createCancelTool(store: Store, runner: Runner): ToolDefinition {
  return tool({
    description:
      "Cancel a running workflow run: aborts in-flight step sessions and " +
      "marks the run cancelled.",
    args: {
      run: tool.schema.string().describe("Run id or unique id prefix"),
    },
    async execute(args) {
      try {
        const run = store.findRun(args.run);
        if (!run) return `Error: Run "${args.run}" not found`;
        await runner.cancel(run.id);
        return `Run ${run.id} cancelled.`;
      } catch (err) {
        return `Error: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  });
}
