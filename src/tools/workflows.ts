import { tool, type ToolDefinition } from "@opencode-ai/plugin";
import type { WorkflowRegistry } from "../workflows/index.js";

export function createWorkflowsTool(workflows: WorkflowRegistry): ToolDefinition {
  return tool({
    description:
      "List available workflow definitions (built-in + custom from " +
      ".opencode/workflows/*.json), or show one workflow in detail.",
    args: {
      action: tool.schema.enum(["list", "info"]).describe("list | info"),
      name: tool.schema
        .string()
        .optional()
        .describe("Workflow name (required for `info`)"),
    },
    async execute(args) {
      try {
        switch (args.action) {
          case "list": {
            const all = workflows.list();
            if (all.length === 0) return "No workflows defined.";
            const lines = all.map(({ def, custom }) => {
              const src = custom ? " (custom)" : "";
              return `${def.name}${src} [${def.pattern}] — ${def.description}`;
            });
            if (workflows.errors.length > 0) {
              lines.push("", "Load errors:");
              for (const e of workflows.errors) lines.push(`  ${e}`);
            }
            return lines.join("\n");
          }
          case "info": {
            if (!args.name) return "Error: `name` is required for action=info";
            const def = workflows.get(args.name);
            if (!def) {
              const known = workflows.list().map((w) => w.def.name).join(", ");
              return `Error: Workflow "${args.name}" not found. Available: ${known}`;
            }
            const lines = [
              `${def.name} [${def.pattern}]`,
              def.description,
              "",
              "Steps:",
            ];
            for (const s of def.steps) {
              const extras = [
                s.agent ? `agent=${s.agent}` : undefined,
                s.model ? `model=${s.model.providerID}/${s.model.modelID}` : undefined,
                s.command ? "shell" : undefined,
              ]
                .filter(Boolean)
                .join(" ");
              lines.push(`  ${s.id}${extras ? ` (${extras})` : ""}`);
              const firstLine = (s.command ? `$ ${s.command}` : (s.instructions ?? ""))
                .split("\n")[0]
                .slice(0, 100);
              lines.push(`    ${firstLine}`);
            }
            if (def.routes) {
              lines.push("", "Routes:");
              for (const [label, ids] of Object.entries(def.routes)) {
                lines.push(`  ${label} → ${ids.join(" → ")}`);
              }
            }
            if (def.aggregate) {
              lines.push("", `Aggregate step: ${def.aggregate.id}`);
            }
            if (def.maxIterations !== undefined) {
              lines.push("", `Max iterations: ${def.maxIterations}`);
            }
            if (def.gate) {
              lines.push("", `Gate: ${def.gate.command}`);
            }
            if (def.isolation) {
              lines.push("", `Isolation: ${def.isolation}`);
            }
            return lines.join("\n");
          }
        }
      } catch (err) {
        return `Error: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  });
}
