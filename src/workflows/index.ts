import * as fs from "node:fs";
import * as path from "node:path";
import {
  loadCustomWorkflows,
  renderTemplate,
  WorkflowDef as WorkflowDefSchema,
  type WorkflowDef,
} from "./loader.js";
import { chainDraftRefine } from "./chain-draft-refine.js";
import { routeByIntent } from "./route-by-intent.js";
import { parallelReview } from "./parallel-review.js";
import { orchestrateTasks } from "./orchestrate-tasks.js";
import { evaluatorLoop } from "./evaluator-loop.js";
import { adversarialReview } from "./adversarial-review.js";
import { authorTests } from "./author-tests.js";
import { testFixLoop } from "./test-fix-loop.js";

export { renderTemplate, WorkflowDef as WorkflowDefSchema } from "./loader.js";
export type { WorkflowDef, StepDef } from "./loader.js";

const BUILTINS: WorkflowDef[] = [
  chainDraftRefine,
  routeByIntent,
  parallelReview,
  orchestrateTasks,
  evaluatorLoop,
  adversarialReview,
  authorTests,
  testFixLoop,
];

// Registry of workflow definitions: the 8 built-ins plus any custom defs
// from <project>/.opencode/workflows/*.json. Custom defs may not shadow a
// built-in name; load problems are collected in `errors` and surfaced by
// the caller (they must never break plugin init).
export class WorkflowRegistry {
  private defs = new Map<string, { def: WorkflowDef; custom: boolean }>();
  private projectDir?: string;
  readonly errors: string[] = [];

  constructor() {
    for (const def of BUILTINS) {
      this.defs.set(def.name, { def, custom: false });
    }
  }

  loadCustom(projectDir: string): void {
    this.projectDir = projectDir;
    const { workflows, errors } = loadCustomWorkflows(projectDir);
    for (const err of errors) this.errors.push(err);
    for (const def of workflows) {
      if (this.defs.has(def.name)) {
        this.errors.push(
          `custom workflow "${def.name}" conflicts with an existing definition — skipped`
        );
        continue;
      }
      this.defs.set(def.name, { def, custom: true });
    }
  }

  get(name: string): WorkflowDef | undefined {
    return this.defs.get(name)?.def;
  }

  require(name: string): WorkflowDef {
    const def = this.get(name);
    if (!def) {
      const known = [...this.defs.keys()].join(", ");
      throw new Error(`Workflow "${name}" not found. Available: ${known}`);
    }
    return def;
  }

  list(): Array<{ def: WorkflowDef; custom: boolean }> {
    return [...this.defs.values()].sort((a, b) => a.def.name.localeCompare(b.def.name));
  }

  isCustom(name: string): boolean {
    return this.defs.get(name)?.custom ?? false;
  }

  validate(raw: unknown): WorkflowDef {
    return WorkflowDefSchema.parse(raw);
  }

  save(
    raw: unknown,
    options: { replace?: boolean; allowShell?: boolean } = {}
  ): { def: WorkflowDef; path: string } {
    if (!this.projectDir) throw new Error("workflow registry has no project directory");
    const def = this.validate(raw);
    const existing = this.defs.get(def.name);
    if (existing && !existing.custom) {
      throw new Error(`workflow "${def.name}" is built in and cannot be replaced`);
    }
    if (existing && !options.replace) {
      throw new Error(`workflow "${def.name}" already exists; set replace=true explicitly`);
    }
    const hasShell =
      def.gate !== undefined ||
      def.steps.some((step) => step.command !== undefined) ||
      def.aggregate?.command !== undefined;
    if (hasShell && !options.allowShell) {
      throw new Error(
        "model-authored shell and gate commands require allowShell=true explicitly"
      );
    }

    const openCodeDir = path.join(this.projectDir, ".opencode");
    const workflowDir = path.join(openCodeDir, "workflows");
    for (const candidate of [openCodeDir, workflowDir]) {
      if (fs.existsSync(candidate) && fs.lstatSync(candidate).isSymbolicLink()) {
        throw new Error(`refusing symlinked workflow directory: ${candidate}`);
      }
    }
    fs.mkdirSync(workflowDir, { recursive: true });
    const target = path.join(workflowDir, `${def.name}.json`);
    if (fs.existsSync(target) && fs.lstatSync(target).isSymbolicLink()) {
      throw new Error(`refusing symlinked workflow file: ${target}`);
    }
    const temp = path.join(workflowDir, `.${def.name}.${process.pid}.tmp`);
    try {
      fs.writeFileSync(temp, `${JSON.stringify(def, null, 2)}\n`, {
        encoding: "utf-8",
        flag: "wx",
        mode: 0o600,
      });
      fs.renameSync(temp, target);
    } finally {
      if (fs.existsSync(temp)) fs.unlinkSync(temp);
    }
    this.defs.set(def.name, { def, custom: true });
    return { def, path: target };
  }
}
