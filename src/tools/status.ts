import { tool, type ToolDefinition } from "@opencode-ai/plugin";
import type { Store } from "../state/store.js";
import type { WorkflowRegistry } from "../workflows/index.js";

function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

export function createStatusTool(
  store: Store,
  workflows: WorkflowRegistry
): ToolDefinition {
  return tool({
    description:
      "Show run detail: pattern, status, per-step state, current iteration " +
      "(evaluator), and timing. Accepts a run id or unique id prefix.",
    args: {
      run: tool.schema.string().describe("Run id or unique id prefix"),
    },
    async execute(args) {
      try {
        const run = store.findRun(args.run);
        if (!run) return `Error: Run "${args.run}" not found`;

        const now = Date.now();
        const lines = [
          `Run ${run.id} — ${run.workflow} [${run.pattern}] — ${run.status}`,
        ];
        if (run.pattern === "evaluator" && run.status === "running") {
          lines.push(`Iteration: ${run.iteration}/${run.config.maxIterations}`);
        }
        lines.push(
          `Started: ${new Date(run.createdAt).toISOString()} (${formatDuration(
            (run.completedAt ?? now) - run.createdAt
          )}${run.completedAt ? "" : ", still running"})`
        );
        if (run.error) lines.push(`Error: ${run.error}`);
        if (run.note) lines.push(`Note: ${run.note}`);
        const usage = Object.values(run.steps).reduce(
          (sum, step) =>
            step.usage
              ? sum +
                step.usage.input +
                step.usage.output +
                step.usage.reasoning +
                step.usage.cacheWrite
              : sum,
          0
        );
        const usageKnown = Object.values(run.steps).some((step) => step.usage);
        lines.push(
          `Observed tokens: ${usageKnown ? usage : "unknown"}${
            run.config.maxTokens ? `/${run.config.maxTokens}` : ""
          }`
        );
        if (run.config.softTokens) lines.push(`Compact threshold: ${run.config.softTokens}`);
        const costs = Object.values(run.steps)
          .map((step) => step.usage?.cost)
          .filter((cost): cost is number => cost !== undefined);
        lines.push(
          `Observed cost: ${
            costs.length ? costs.reduce((sum, cost) => sum + cost, 0) : "unknown"
          }${run.config.maxCost ? `/${run.config.maxCost}` : ""}`
        );

        // Steps present in the run record (started or finished).
        const steps = Object.values(run.steps);
        const shown = new Set<string>();
        lines.push("", "Steps:");
        if (steps.length === 0) lines.push("  (no steps started yet)");
        for (const s of steps) {
          shown.add(s.id);
          const timing = s.startedAt
            ? ` ${formatDuration((s.completedAt ?? now) - s.startedAt)}`
            : "";
          const err = s.error ? ` — ${s.error}` : "";
          lines.push(`  [${s.status}] ${s.id}${timing}${err}`);
          if (s.usage) {
            lines.push(
              `    tokens: in=${s.usage.input} out=${s.usage.output} reasoning=${s.usage.reasoning} cache-read=${s.usage.cacheRead} cache-write=${s.usage.cacheWrite}`
            );
          }
          if (s.summary && s.output && s.summary.length < s.output.length) {
            lines.push(`    checkpoint: ${s.summary.length} chars (raw ${s.output.length})`);
          }
          if (s.isolationFallback) {
            lines.push("    isolation fallback: ran in main directory");
          }
          if (s.copiedFiles && s.copiedFiles.length > 0) {
            lines.push(`    copied ${s.copiedFiles.length} file(s) from worktree`);
          }
          if (s.conflicts && s.conflicts.length > 0) {
            lines.push(`    conflicts: ${s.conflicts.join(", ")}`);
          }
          if (s.skippedSymlinks && s.skippedSymlinks.length > 0) {
            lines.push(`    skipped symlinks: ${s.skippedSymlinks.join(", ")}`);
          }
        }

        // Def steps that haven't started yet read as pending (chain/routing/
        // evaluator ids are known upfront; parallel ids too).
        const def = workflows.get(run.workflow);
        if (def) {
          for (const s of def.steps) {
            if (!shown.has(s.id)) lines.push(`  [pending] ${s.id}`);
          }
          if (def.aggregate && !shown.has(def.aggregate.id)) {
            lines.push(`  [pending] ${def.aggregate.id}`);
          }
        }
        return lines.join("\n");
      } catch (err) {
        return `Error: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  });
}
