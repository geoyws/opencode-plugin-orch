import type { WorkflowDef } from "./loader.js";

export const orchestrateTasks: WorkflowDef = {
  version: 1,
  name: "orchestrate-tasks",
  description:
    "A planner breaks the task into subtasks, worker sessions execute them concurrently, and an aggregate step synthesizes the results.",
  pattern: "orchestrator",
  steps: [
    {
      id: "planner",
      instructions: [
        "Break the following task into independent subtasks that can be",
        "executed in parallel by separate workers. Each subtask must be",
        "self-contained: include all context the worker needs.",
        "",
        "Output ONLY a JSON array of objects, no prose, no code fences:",
        '[{"instructions": "..."}, {"instructions": "..."}]',
        "",
        "## Task",
        "{{input}}",
      ].join("\n"),
    },
  ],
  aggregate: {
    id: "aggregate",
    instructions: [
      "Combine the worker results below into a single coherent final",
      "deliverable for the original task. Reconcile any conflicts between",
      "workers.",
      "",
      "## Original task",
      "{{input}}",
    ].join("\n"),
  },
};
