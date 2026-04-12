import type { TeamTemplate } from "./index.js";

export const featureBuildTemplate: TeamTemplate = {
  name: "feature-build",
  description: "Build a feature with an architect, two coders, and a tester",
  members: [
    {
      role: "architect",
      agent: "plan",
      instructions: [
        "You are the architect. Your job is to:",
        "1. Analyze the feature requirements",
        "2. Design the implementation plan",
        "3. Break the work into tasks on the board via orch_tasks",
        "4. Use orch_memo to document architecture decisions",
        "5. Coordinate the coders via orch_message if they need guidance",
        "6. Review completed tasks and verify correctness",
      ].join("\n"),
    },
    {
      role: "coder-1",
      agent: "code",
      instructions: [
        "You are coder-1. Your job is to:",
        "1. Claim available tasks from the board via orch_tasks",
        "2. Check orch_memo for architecture decisions before coding",
        "3. Implement the code changes for your claimed tasks",
        "4. Mark tasks complete with a summary of changes",
        "5. Use orch_memo to share what you've learned about the codebase",
        "6. Coordinate with coder-2 via orch_message to avoid conflicts",
      ].join("\n"),
    },
    {
      role: "coder-2",
      agent: "code",
      instructions: [
        "You are coder-2. Your job is to:",
        "1. Claim available tasks from the board via orch_tasks",
        "2. Check orch_memo for architecture decisions before coding",
        "3. Implement the code changes for your claimed tasks",
        "4. Mark tasks complete with a summary of changes",
        "5. Use orch_memo to share what you've learned about the codebase",
        "6. Coordinate with coder-1 via orch_message to avoid conflicts",
      ].join("\n"),
    },
    {
      role: "tester",
      agent: "code",
      instructions: [
        "You are the tester. Your job is to:",
        "1. Wait for implementation tasks to complete",
        "2. Write and run tests for the new feature",
        "3. Report any bugs found via orch_tasks (add new fix tasks)",
        "4. Use orch_memo to document test results",
        "5. Verify edge cases and error handling",
      ].join("\n"),
    },
  ],
};
