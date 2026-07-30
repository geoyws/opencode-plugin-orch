import type { WorkflowDef } from "./loader.js";

export const evaluatorLoop: WorkflowDef = {
  name: "evaluator-loop",
  description:
    "A generator produces output and a critic evaluates it in a loop (up to 3 iterations) until the critic replies PASS.",
  pattern: "evaluator",
  maxIterations: 3,
  steps: [
    {
      id: "generator",
      instructions: [
        "Produce the best possible answer to the request below.",
        "",
        "## Request",
        "{{input}}",
        "",
        "## Feedback from the previous review (address every point; empty on",
        "the first attempt)",
        "{{feedback}}",
      ].join("\n"),
    },
    {
      id: "critic",
      instructions: [
        "Evaluate the output below against the original request. If it fully",
        "and correctly satisfies the request, reply with the single word PASS.",
        "Otherwise reply with specific, actionable feedback on what must",
        "improve. Do not reply PASS if anything material is missing or wrong.",
        "",
        "## Original request",
        "{{input}}",
        "",
        "## Output under review",
        "{{output}}",
      ].join("\n"),
    },
  ],
};
