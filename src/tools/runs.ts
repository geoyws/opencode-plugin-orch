import { tool, type ToolDefinition } from "@opencode-ai/plugin";
import type { Store } from "../state/store.js";

function formatAge(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

export function createRunsTool(store: Store): ToolDefinition {
  return tool({
    description: "List workflow runs, newest first.",
    args: {
      status: tool.schema
        .enum(["running", "completed", "failed", "cancelled"])
        .optional()
        .describe("Filter by run status"),
      limit: tool.schema
        .number()
        .optional()
        .describe("Max runs to return (default 20)"),
    },
    async execute(args) {
      try {
        let runs = store.listRuns();
        if (args.status) runs = runs.filter((r) => r.status === args.status);
        const limit = Math.max(1, args.limit ?? 20);
        const total = runs.length;
        runs = runs.slice(0, limit);
        if (runs.length === 0) {
          return args.status ? `No ${args.status} runs.` : "No runs yet.";
        }
        const now = Date.now();
        const lines = runs.map((r) => {
          const span = r.completedAt
            ? `took ${formatAge(r.completedAt - r.createdAt)}`
            : `running for ${formatAge(now - r.createdAt)}`;
          const preview =
            r.input.length > 60 ? r.input.slice(0, 59) + "…" : r.input;
          return `${r.id}  ${r.status.padEnd(9)}  ${r.workflow}  ${span}  "${preview}"`;
        });
        if (total > runs.length) {
          lines.push(`… and ${total - runs.length} more (use limit to see more)`);
        }
        return lines.join("\n");
      } catch (err) {
        return `Error: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  });
}
