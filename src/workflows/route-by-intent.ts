import type { WorkflowDef } from "./loader.js";

export const routeByIntent: WorkflowDef = {
  version: 1,
  name: "route-by-intent",
  description:
    "Classify the request by intent (code / docs / other) and route it to a specialized handler.",
  pattern: "routing",
  steps: [
    {
      id: "classify",
      instructions: [
        "Classify the intent of the request below into exactly one of these",
        "categories: code, docs, other.",
        "",
        "- code: writing, changing, debugging, or explaining source code",
        "- docs: writing or updating documentation, READMEs, comments",
        "- other: anything else",
        "",
        "Reply with a single word: the category name. No punctuation, no explanation.",
        "",
        "## Request",
        "{{input}}",
      ].join("\n"),
    },
    {
      id: "code",
      instructions: [
        "Handle the following request as a coding task. Read the relevant",
        "files, make the change, and verify it. Be concise in your final",
        "answer — summarize what you changed and where.",
        "",
        "## Request",
        "{{input}}",
      ].join("\n"),
    },
    {
      id: "docs",
      instructions: [
        "Handle the following request as a documentation task. Write clear,",
        "accurate prose matching the project's existing documentation style.",
        "",
        "## Request",
        "{{input}}",
      ].join("\n"),
    },
    {
      id: "other",
      instructions: [
        "Handle the following request as well as you can.",
        "",
        "## Request",
        "{{input}}",
      ].join("\n"),
    },
  ],
  routes: {
    code: ["code"],
    docs: ["docs"],
    other: ["other"],
  },
};
