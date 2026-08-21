import * as fs from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import { ModelRef, Pattern } from "../state/schemas.js";
import { validateOutputSchema } from "../core/structured-output.js";

// ── Workflow definition schema ────────────────────────────────────────
export const OutputContract = z.object({
  schema: z.record(z.string(), z.unknown()),
  retryCount: z.number().int().min(0).max(3).default(1),
});
export type OutputContract = z.infer<typeof OutputContract>;

export const StepDef = z
  .object({
    id: z.string().min(1),
    // Prompt template. Optional when `command` is set (shell step).
    instructions: z.string().min(1).optional(),
    agent: z.string().optional(),
    model: ModelRef.optional(),
    // Shell step: run via /bin/sh -c in the project dir (or the step's
    // worktree), combined stdout+stderr is the step output, non-zero exit
    // fails the step. No LLM session is created.
    command: z.string().min(1).optional(),
    // IR v2: locally validated JSON Schema contract. The server-plugin client
    // has no portable provider-side format field, so local validation remains
    // authoritative and retryCount is enforced by the runner.
    output: OutputContract.optional(),
  })
  .refine((s) => s.instructions !== undefined || s.command !== undefined, {
    message: "a step requires `instructions` or `command`",
  });
export type StepDef = z.infer<typeof StepDef>;

export const WorkflowDef = z
  .object({
    version: z.union([z.literal(1), z.literal(2)]).default(1),
    name: z
      .string()
      .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "name must be kebab-case"),
    description: z.string(),
    pattern: Pattern,
    steps: z.array(StepDef).min(1),
    // IR v2 static map: literal JSON data, never planner-authored at runtime.
    items: z.array(z.json()).min(1).optional(),
    routes: z.record(z.string(), z.array(z.string())).optional(),
    aggregate: StepDef.optional(),
    maxIterations: z.number().int().min(1).optional(),
    // Run parallel/orchestrator fan-out steps in per-step git worktrees.
    isolation: z.enum(["worktree"]).optional(),
    // Evaluator only: programmatic gate run after each generator iteration.
    gate: z.object({ command: z.string().min(1) }).optional(),
  })
  .superRefine((def, ctx) => {
    const ids = def.steps.map((s) => s.id);
    const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
    if (dupes.length > 0) {
      ctx.addIssue({
        code: "custom",
        message: `duplicate step ids: ${[...new Set(dupes)].join(", ")}`,
        path: ["steps"],
      });
    }
    if (def.pattern === "routing") {
      if (!def.routes || Object.keys(def.routes).length === 0) {
        ctx.addIssue({
          code: "custom",
          message: "routing workflows require `routes`",
          path: ["routes"],
        });
      } else {
        for (const [label, stepIds] of Object.entries(def.routes)) {
          for (const id of stepIds) {
            if (!ids.includes(id)) {
              ctx.addIssue({
                code: "custom",
                message: `route "${label}" references unknown step "${id}"`,
                path: ["routes", label],
              });
            }
          }
        }
      }
    }
    if (
      def.pattern === "parallel" ||
      def.pattern === "map" ||
      def.pattern === "orchestrator"
    ) {
      if (!def.aggregate) {
        ctx.addIssue({
          code: "custom",
          message: `${def.pattern} workflows require an \`aggregate\` step`,
          path: ["aggregate"],
        });
      }
    }
    if (def.aggregate && ids.includes(def.aggregate.id)) {
      ctx.addIssue({
        code: "custom",
        message: `aggregate id "${def.aggregate.id}" conflicts with a worker step id`,
        path: ["aggregate", "id"],
      });
    }
    if (def.pattern === "map") {
      if (!def.items || def.items.length === 0) {
        ctx.addIssue({
          code: "custom",
          message: "map workflows require a non-empty `items` array",
          path: ["items"],
        });
      }
      if (def.steps.length !== 1) {
        ctx.addIssue({
          code: "custom",
          message: "map workflows require exactly one worker template step",
          path: ["steps"],
        });
      }
      if (def.steps[0]?.command !== undefined) {
        ctx.addIssue({
          code: "custom",
          message:
            "map worker templates must use `instructions`; shell interpolation of items is intentionally unsupported",
          path: ["steps", 0, "command"],
        });
      }
      if (
        def.aggregate &&
        def.items?.some((_, index) => def.aggregate!.id === `${def.steps[0]?.id}-${index + 1}`)
      ) {
        ctx.addIssue({
          code: "custom",
          message: `aggregate id "${def.aggregate.id}" conflicts with a dynamic map worker id`,
          path: ["aggregate", "id"],
        });
      }
    } else if (def.items !== undefined) {
      ctx.addIssue({
        code: "custom",
        message: "`items` is only valid for map workflows",
        path: ["items"],
      });
    }
    if (def.pattern === "evaluator" && def.steps.length < 2 && !def.gate) {
      ctx.addIssue({
        code: "custom",
        message:
          "evaluator workflows require a critic step (steps[1]) or a `gate`",
        path: ["steps"],
      });
    }
    if (def.pattern === "routing" && def.steps.length < 2) {
      ctx.addIssue({
        code: "custom",
        message: "routing workflows require at least 2 steps (classifier + routes)",
        path: ["steps"],
      });
    }
    const structured = [...def.steps, ...(def.aggregate ? [def.aggregate] : [])]
      .filter((step) => step.output !== undefined);
    if (def.version === 1 && (def.pattern === "map" || def.items || structured.length > 0)) {
      ctx.addIssue({
        code: "custom",
        message: "map and structured outputs require workflow IR version 2",
        path: ["version"],
      });
    }
    for (const step of structured) {
      const problem = validateOutputSchema(step.output!.schema);
      if (problem) {
        ctx.addIssue({
          code: "custom",
          message: `step "${step.id}" ${problem}`,
          path: ["steps", step.id, "output", "schema"],
        });
      }
      if (step.command !== undefined && step.output!.retryCount > 0) {
        ctx.addIssue({
          code: "custom",
          message: `command step "${step.id}" cannot retry structured output; set retryCount to 0`,
          path: ["steps", step.id, "output", "retryCount"],
        });
      }
    }
  });
export type WorkflowDef = z.infer<typeof WorkflowDef>;

// ── Prompt template rendering ─────────────────────────────────────────
// Placeholders: {{input}}, {{output}}, {{feedback}}, {{item}}, {{index}},
// {{steps.<id>.output}}.
// Unknown or unavailable values render as the empty string.
export function renderTemplate(
  template: string,
  ctx: {
    input: string;
    output?: string;
    feedback?: string;
    item?: unknown;
    index?: number;
    steps?: Record<string, { output?: string }>;
  }
): string {
  const item =
    typeof ctx.item === "string"
      ? ctx.item
      : ctx.item === undefined
        ? ""
        : JSON.stringify(ctx.item);
  return template
    .replace(/\{\{input\}\}/g, ctx.input)
    .replace(/\{\{output\}\}/g, ctx.output ?? "")
    .replace(/\{\{feedback\}\}/g, ctx.feedback ?? "")
    .replace(/\{\{item\}\}/g, item)
    .replace(/\{\{index\}\}/g, ctx.index === undefined ? "" : String(ctx.index))
    .replace(
      /\{\{steps\.([A-Za-z0-9_-]+)\.output\}\}/g,
      (_m, id: string) => ctx.steps?.[id]?.output ?? ""
    );
}

// ── Custom workflow loader ────────────────────────────────────────────
// Reads <projectDir>/.opencode/workflows/*.json. Invalid files are skipped
// and reported in `errors` — a bad custom def must never break plugin init.
export function loadCustomWorkflows(projectDir: string): {
  workflows: WorkflowDef[];
  errors: string[];
} {
  const dir = path.join(projectDir, ".opencode", "workflows");
  const workflows: WorkflowDef[] = [];
  const errors: string[] = [];
  let files: string[];
  try {
    for (const candidate of [path.join(projectDir, ".opencode"), dir]) {
      if (fs.existsSync(candidate) && fs.lstatSync(candidate).isSymbolicLink()) {
        errors.push(`${candidate}: symlinked workflow directories are refused`);
        return { workflows, errors };
      }
    }
    files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch {
    return { workflows, errors }; // no custom dir — fine
  }
  for (const file of files.sort()) {
    const fp = path.join(dir, file);
    try {
      if (fs.lstatSync(fp).isSymbolicLink()) {
        errors.push(`${file}: symlinked workflow files are refused`);
        continue;
      }
      const raw = JSON.parse(fs.readFileSync(fp, "utf-8"));
      const parsed = WorkflowDef.safeParse(raw);
      if (!parsed.success) {
        errors.push(`${file}: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
        continue;
      }
      workflows.push(parsed.data);
    } catch (err) {
      errors.push(`${file}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { workflows, errors };
}
