import type { WorkflowDef } from "./loader.js";

export const parallelReview: WorkflowDef = {
  version: 1,
  name: "parallel-review",
  description:
    "Three reviewers (security, performance, style) examine the input concurrently; an aggregate step synthesizes their findings.",
  pattern: "parallel",
  steps: [
    {
      id: "security",
      instructions: [
        "Review the following for security issues: injection, auth flaws,",
        "secret handling, unsafe deserialization, missing validation. Report",
        "findings as a prioritized list with concrete file/line references",
        "where possible. If clean, say so explicitly.",
        "",
        "## Subject",
        "{{input}}",
      ].join("\n"),
    },
    {
      id: "performance",
      instructions: [
        "Review the following for performance issues: algorithmic complexity,",
        "unnecessary allocations, N+1 patterns, blocking I/O, missing caching.",
        "Report findings as a prioritized list. If clean, say so explicitly.",
        "",
        "## Subject",
        "{{input}}",
      ].join("\n"),
    },
    {
      id: "style",
      instructions: [
        "Review the following for style and maintainability issues: naming,",
        "structure, duplication, error handling, consistency with surrounding",
        "conventions. Report findings as a prioritized list. If clean, say so",
        "explicitly.",
        "",
        "## Subject",
        "{{input}}",
      ].join("\n"),
    },
  ],
  aggregate: {
    id: "aggregate",
    instructions: [
      "Synthesize the three reviews below into a single report: deduplicate",
      "findings, order by severity, and end with a short list of recommended",
      "actions.",
      "",
      "## Security review",
      "{{steps.security.output}}",
      "",
      "## Performance review",
      "{{steps.performance.output}}",
      "",
      "## Style review",
      "{{steps.style.output}}",
    ].join("\n"),
  },
};
