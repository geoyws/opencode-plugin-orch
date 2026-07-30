import { loadCustomWorkflows, renderTemplate, type WorkflowDef } from "./loader.js";
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
  readonly errors: string[] = [];

  constructor() {
    for (const def of BUILTINS) {
      this.defs.set(def.name, { def, custom: false });
    }
  }

  loadCustom(projectDir: string): void {
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
}
