import type { Permission } from "@opencode-ai/sdk";
import type { Runner } from "../core/runner.js";
import { logHookError } from "./_safe.js";

// Git commands that mutate repository state — DENIED for step sessions
// (only the lead commits). Matcher resurrected from the pre-0.2.0
// permissions hook, aligned with the 0.3.0 addendum's list.
const GIT_MUTATING_PATTERNS = [
  /\bgit\s+commit\b/,
  /\bgit\s+push\b/,
  /\bgit\s+merge\b/,
  /\bgit\s+rebase\b/,
  /\bgit\s+reset\s+--hard\b/,
  /\bgit\s+clean\b/,
  /\bgit\s+stash\b/,
  /\bgit\s+cherry-pick\b/,
  /\bgit\s+revert\b/,
  /\bgit\s+branch\s+-(d|D|m|M)\b/,
  /\bgit\s+tag\s+-d\b/,
  /\bgit\s+checkout\b/,
  /\bgit\s+switch\b/,
  /\bgit\s+restore\b/,
  /\bgit\s+worktree\s+remove\b/,
];

// Git commands that are read-only — never denied even if a mutating
// pattern would (accidentally) match.
const GIT_READONLY_PATTERNS = [
  /\bgit\s+status\b/,
  /\bgit\s+log\b/,
  /\bgit\s+diff\b/,
  /\bgit\s+show\b/,
  /\bgit\s+blame\b/,
  /\bgit\s+branch\s*$/,
  /\bgit\s+branch\s+-[avr]/,
  /\bgit\s+tag\s*$/,
  /\bgit\s+tag\s+-l\b/,
  /\bgit\s+ls-files\b/,
  /\bgit\s+rev-parse\b/,
];

export function isGitMutating(command: string): boolean {
  if (GIT_READONLY_PATTERNS.some((p) => p.test(command))) return false;
  return GIT_MUTATING_PATTERNS.some((p) => p.test(command));
}

// Auto-permissions for runner-tracked step sessions: allow everything
// except git-mutating bash commands (denied). Sessions the runner is not
// tracking are left completely untouched (output not set at all). Escape
// hatches (either one wins): ORCH_STEP_PERMISSIONS=ask env var, or the
// `stepPermissions: "ask"` plugin option. Wrapped so a throw can never
// propagate into opencode.
export function createPermissionHook(deps: {
  runner: Runner;
  directory: string;
  stepPermissions?: "auto" | "ask";
}) {
  const { runner, directory, stepPermissions = "auto" } = deps;

  return async (
    input: Permission,
    output: { status: "ask" | "deny" | "allow" }
  ): Promise<void> => {
    try {
      if (process.env.ORCH_STEP_PERMISSIONS === "ask" || stepPermissions === "ask") return;
      if (!runner.isStepSession(input.sessionID)) return;

      const command =
        (input.metadata?.command as string) ??
        (input.metadata?.bash as string) ??
        (typeof input.pattern === "string" ? input.pattern : input.pattern?.[0]) ??
        input.title ??
        "";

      output.status = isGitMutating(command) ? "deny" : "allow";
    } catch (err) {
      // Never crash the host. Leaving output.status alone falls back to
      // "ask" — the safest default.
      logHookError(directory, "permission.ask", err);
    }
  };
}
