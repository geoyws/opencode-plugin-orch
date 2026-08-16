import type { WorkflowDef } from "./loader.js";

export const testFixLoop: WorkflowDef = {
  version: 1,
  name: "test-fix-loop",
  description:
    "Writes or fixes tests AND the code under test until the gate command passes (default `npm test`, override via run config gateCommand), up to 5 iterations. On failure the gate output tail is fed back to the generator.",
  pattern: "evaluator",
  maxIterations: 5,
  gate: { command: "npm test" },
  steps: [
    {
      id: "generator",
      instructions: [
        "Work on the request below. Write or fix tests AND the code under",
        "test as needed so the test suite passes. Make real edits in the",
        "repository — a gate command will be run after you finish to",
        "verify the suite is green.",
        "",
        "## Request",
        "{{input}}",
        "",
        "## Output of the last failing gate run (fix the failures; empty",
        "on the first attempt)",
        "{{feedback}}",
      ].join("\n"),
    },
  ],
};
