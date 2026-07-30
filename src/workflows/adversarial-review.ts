import type { WorkflowDef } from "./loader.js";

export const adversarialReview: WorkflowDef = {
  name: "adversarial-review",
  description:
    "A generator produces the deliverable and an adversarial critic attacks it (correctness bugs, security holes, edge cases, spec violations) until it finds nothing, up to 4 iterations. Pin a different/stronger critic model via run config stepModels.",
  pattern: "evaluator",
  maxIterations: 4,
  steps: [
    {
      id: "generator",
      instructions: [
        "Produce the best possible deliverable for the request below.",
        "Assume it will be reviewed adversarially: it must be correct,",
        "secure, and robust at the edges, not merely plausible.",
        "",
        "## Request",
        "{{input}}",
        "",
        "## Findings from the previous adversarial review (fix every one;",
        "empty on the first attempt)",
        "{{feedback}}",
      ].join("\n"),
    },
    {
      id: "critic",
      instructions: [
        "You are an adversarial reviewer. Attack the deliverable below:",
        "hunt for correctness bugs, security holes, unhandled edge cases,",
        "and violations of the original request. Try to break it — do not",
        "give the benefit of the doubt.",
        "",
        "If you find concrete problems, list each one with why it matters",
        "and how to fix it. Reply with the single word PASS only when a",
        "genuine attempt to find defects turns up nothing.",
        "",
        "## Original request",
        "{{input}}",
        "",
        "## Deliverable under attack",
        "{{output}}",
      ].join("\n"),
    },
  ],
};
