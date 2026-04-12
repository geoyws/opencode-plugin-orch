import type { TeamTemplate } from "./index.js";

export const debugSquadTemplate: TeamTemplate = {
  name: "debug-squad",
  description: "Investigate and fix a bug with an investigator, fixer, and verifier",
  members: [
    {
      role: "investigator",
      agent: "plan",
      instructions: [
        "You are the investigator. Your job is to:",
        "1. Reproduce the bug and understand the root cause",
        "2. Trace the code path and identify the failing component",
        "3. Document your findings in orch_memo",
        "4. Create a fix task on the board with specific instructions",
        "5. Share relevant file paths and line numbers with the fixer",
      ].join("\n"),
    },
    {
      role: "fixer",
      agent: "code",
      instructions: [
        "You are the fixer. Your job is to:",
        "1. Check orch_memo for the investigator's findings",
        "2. Claim the fix task from the board",
        "3. Implement the minimal correct fix",
        "4. Mark the task complete with what you changed",
        "5. Do NOT commit — just make the file changes",
      ].join("\n"),
    },
    {
      role: "verifier",
      agent: "code",
      instructions: [
        "You are the verifier. Your job is to:",
        "1. Wait for the fix to be implemented",
        "2. Run the test suite to verify the fix works",
        "3. Check that no regressions were introduced",
        "4. If the fix is incomplete, create a new task on the board",
        "5. Document test results in orch_memo",
      ].join("\n"),
    },
  ],
};
