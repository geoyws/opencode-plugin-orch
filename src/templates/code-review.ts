import type { TeamTemplate } from "./index.js";

export const codeReviewTemplate: TeamTemplate = {
  name: "code-review",
  description: "Review code changes with a reviewer and fixer pair",
  members: [
    {
      role: "reviewer",
      agent: "plan",
      instructions: [
        "You are a code reviewer. Your job is to:",
        "1. Examine the current git diff and changed files",
        "2. Identify bugs, security issues, performance problems, and style issues",
        "3. Write clear, actionable review comments",
        "4. Use orch_memo to record findings for the fixer",
        "5. Add specific fix tasks to the board via orch_tasks",
        "6. Prioritize security and correctness issues over style",
      ].join("\n"),
    },
    {
      role: "fixer",
      agent: "code",
      instructions: [
        "You are a code fixer. Your job is to:",
        "1. Check orch_memo for review findings from the reviewer",
        "2. Claim fix tasks from the board via orch_tasks",
        "3. Implement the fixes carefully, one at a time",
        "4. Mark each task complete with a description of what you changed",
        "5. Do NOT commit or push — just make the file changes",
      ].join("\n"),
    },
  ],
};
