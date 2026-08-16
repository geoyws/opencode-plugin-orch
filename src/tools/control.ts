import { tool, type ToolDefinition } from "@opencode-ai/plugin";
import type { Runner } from "../core/runner.js";
import type { Store } from "../state/store.js";

export function createControlTool(store: Store, runner: Runner): ToolDefinition {
  return tool({
    description:
      "Pause a workflow at its next safe step boundary, resume it, steer active/future workers, " +
      "retry a failed/cancelled run, or cancel it. Pause never kills an already-running model or shell invocation.",
    args: {
      action: tool.schema.enum(["pause", "resume", "steer", "retry", "cancel"]),
      run: tool.schema.string().describe("Run id or unique id prefix"),
      message: tool.schema.string().max(4000).optional(),
    },
    async execute(args) {
      try {
        const run = store.findRun(args.run);
        if (!run) return `Error: Run "${args.run}" not found`;
        if (args.action === "pause") runner.pause(run.id);
        else if (args.action === "resume") runner.resume(run.id);
        else if (args.action === "steer") {
          if (!args.message?.trim()) return "Error: message is required for action=steer";
          const delivered = await runner.steer(run.id, args.message);
          return (
            `Run ${run.id} steered; direction persisted for future steps` +
            (delivered > 0
              ? ` and delivered to ${delivered} active agent${delivered === 1 ? "" : "s"}.`
              : ".")
          );
        }
        else if (args.action === "retry") await runner.retry(run.id);
        else await runner.cancel(run.id);
        const past = {
          pause: "paused",
          resume: "resumed",
          steer: "steered",
          retry: "retrying",
          cancel: "cancelled",
        } as const;
        return `Run ${run.id} ${past[args.action]}.`;
      } catch (err) {
        return `Error: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  });
}
