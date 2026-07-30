import { tool, type ToolDefinition } from "@opencode-ai/plugin";
import type { Store } from "../state/store.js";

export function createResultTool(store: Store): ToolDefinition {
  return tool({
    description:
      "Get the final output of a workflow run. `detailed` also includes " +
      "every step output; `json` returns the raw run record.",
    args: {
      run: tool.schema.string().describe("Run id or unique id prefix"),
      format: tool.schema
        .enum(["summary", "detailed", "json"])
        .optional()
        .describe("summary (default) | detailed | json"),
    },
    async execute(args) {
      try {
        const run = store.findRun(args.run);
        if (!run) return `Error: Run "${args.run}" not found`;

        if (run.status === "running") {
          return `Run ${run.id} is still running — check orch_status for progress.`;
        }

        const format = args.format ?? "summary";

        if (format === "json") {
          return JSON.stringify(run, null, 2);
        }

        if (run.status === "failed") {
          return `Run ${run.id} failed: ${run.error ?? "unknown error"}`;
        }
        if (run.status === "cancelled") {
          return `Run ${run.id} was cancelled.`;
        }

        // completed
        const lines: string[] = [];
        if (run.note) lines.push(`Note: ${run.note}`, "");
        lines.push(run.output ?? "(no output)");

        if (format === "detailed") {
          lines.push("", "─".repeat(40), "Step outputs:");
          for (const s of Object.values(run.steps)) {
            lines.push("", `## ${s.id} [${s.status}]`);
            if (s.output !== undefined) lines.push(s.output);
            if (s.error) lines.push(`Error: ${s.error}`);
          }
        }
        return lines.join("\n");
      } catch (err) {
        return `Error: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  });
}
