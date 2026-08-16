import { tool, type ToolDefinition } from "@opencode-ai/plugin";
import type { WorkflowRegistry } from "../workflows/index.js";

export function createWorkflowsTool(workflows: WorkflowRegistry): ToolDefinition {
  return tool({
    description:
      "List, inspect, validate, or atomically save versioned workflow IR. " +
      "Definitions are data, never executable JavaScript.",
    args: {
      action: tool.schema
        .enum(["list", "info", "validate", "save"])
        .describe("list | info | validate | save"),
      name: tool.schema
        .string()
        .optional()
        .describe("Workflow name (required for `info`)"),
      definition: tool.schema
        .string()
        .optional()
        .describe("Workflow definition as strict JSON (validate/save)"),
      replace: tool.schema.boolean().optional().describe("Replace an existing custom definition"),
      allowShell: tool.schema
        .boolean()
        .optional()
        .describe("Explicitly authorize shell/gate nodes in a saved definition"),
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
          case "validate":
          case "save": {
            if (!args.definition) {
              return `Error: \`definition\` is required for action=${args.action}`;
            }
            let raw: unknown;
            try {
              raw = JSON.parse(args.definition);
            } catch (err) {
              return `Error: definition is not valid JSON: ${
                err instanceof Error ? err.message : String(err)
              }`;
            }
            if (args.action === "validate") {
              const def = workflows.validate(raw);
              return `Valid workflow IR v${def.version}: ${def.name} [${def.pattern}] (${def.steps.length} step(s)).`;
            }
            const saved = workflows.save(raw, {
              replace: args.replace,
              allowShell: args.allowShell,
            });
            return `Saved workflow IR v${saved.def.version}: ${saved.def.name} [${saved.def.pattern}] at ${saved.path}`;
          }
        }
      } catch (err) {
        return `Error: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  });
}
