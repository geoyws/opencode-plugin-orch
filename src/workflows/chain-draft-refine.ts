import type { WorkflowDef } from "./loader.js";

export const chainDraftRefine: WorkflowDef = {
  name: "chain-draft-refine",
  description:
    "Two-step prompt chain: produce a first draft, then refine it against the original request.",
  pattern: "chain",
  steps: [
    {
      id: "draft",
      instructions: [
        "Produce a complete first draft responding to the following request.",
        "Do not explain your process — output the draft only.",
        "",
        "## Request",
        "{{input}}",
      ].join("\n"),
    },
    {
      id: "refine",
      instructions: [
        "Improve the draft below. Fix errors, tighten the writing, and make",
        "sure it fully addresses the original request. Output only the refined",
        "version — no commentary.",
        "",
        "## Original request",
        "{{input}}",
        "",
        "## Draft",
        "{{output}}",
      ].join("\n"),
    },
  ],
};
