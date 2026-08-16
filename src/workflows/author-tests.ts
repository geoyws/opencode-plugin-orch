import type { WorkflowDef } from "./loader.js";

export const authorTests: WorkflowDef = {
  version: 1,
  name: "author-tests",
  description:
    "A planner identifies the areas most needing tests (unit / integration / e2e) from the input plus repo layout, workers author the tests in isolated git worktrees (each worker owns a disjoint area), and an aggregate step summarizes what was written. Run test-fix-loop afterwards to make the suite green.",
  pattern: "orchestrator",
  isolation: "worktree",
  steps: [
    {
      id: "planner",
      instructions: [
        "Identify the areas of this repository that most need tests, given",
        "the request below. Consider unit, integration, and e2e levels.",
        "Split the work into independent subtasks for separate workers.",
        "Each subtask MUST own a disjoint set of files/areas so workers",
        "never write to the same test file, and must be self-contained:",
        "include all context the worker needs (paths, APIs, conventions).",
        "",
        "Output ONLY a JSON array of objects, no prose, no code fences:",
        '[{"instructions": "..."}, {"instructions": "..."}]',
        "",
        "## Request",
        "{{input}}",
      ].join("\n"),
    },
  ],
  aggregate: {
    id: "aggregate",
    instructions: [
      "Summarize the tests that were authored for the original request:",
      "which areas are now covered at which level (unit / integration /",
      "e2e), which test files were added or changed, and any gaps the",
      "workers reported.",
      "",
      "## Original request",
      "{{input}}",
    ].join("\n"),
  },
};
