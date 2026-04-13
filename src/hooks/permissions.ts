import type { Permission } from "@opencode-ai/sdk";
import type { TeamManager } from "../core/team-manager.js";
import type { FileLockManager } from "../core/file-locks.js";
import { logHookError } from "./_safe.js";

// Git commands that mutate repository state — DENIED for members
const GIT_MUTATING_PATTERNS = [
  /\bgit\s+commit\b/,
  /\bgit\s+push\b/,
  /\bgit\s+pull\b/,
  /\bgit\s+merge\b/,
  /\bgit\s+rebase\b/,
  /\bgit\s+checkout\b/,
  /\bgit\s+switch\b/,
  /\bgit\s+restore\b/,
  /\bgit\s+reset\b/,
  /\bgit\s+clean\b/,
  /\bgit\s+stash\b/,
  /\bgit\s+cherry-pick\b/,
  /\bgit\s+revert\b/,
  /\bgit\s+am\b/,
  /\bgit\s+apply\b/,
  /\bgit\s+branch\s+-(d|D|m|M)\b/,
  /\bgit\s+tag\s+-d\b/,
];

// Git commands that are read-only — ALLOWED
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

function isGitMutating(command: string): boolean {
  // First check if it's a known read-only command
  if (GIT_READONLY_PATTERNS.some((p) => p.test(command))) return false;
  // Then check if it matches any mutating pattern
  return GIT_MUTATING_PATTERNS.some((p) => p.test(command));
}

export function createPermissionHook(
  manager: TeamManager,
  fileLocks: FileLockManager,
  projectDir: string
) {
  return async (
    input: Permission,
    output: { status: "ask" | "deny" | "allow" }
  ): Promise<void> => {
    try {
      const sessionID = input.sessionID;

      // Only enforce for member sessions
      if (!manager.isMemberSession(sessionID)) return;

      const member = manager.getMemberBySession(sessionID);
      if (!member) return;

      // ── Git safety ────────────────────────────────────────────────
      // Check if this is a bash/shell permission with a git-mutating command
      const command =
        (input.metadata?.command as string) ??
        (input.metadata?.bash as string) ??
        (typeof input.pattern === "string" ? input.pattern : input.pattern?.[0]) ??
        input.title ??
        "";

      if (isGitMutating(command)) {
        output.status = "deny";
        return;
      }

      // ── File lock enforcement ─────────────────────────────────────
      // Check write/edit tool calls for file conflicts
      if (input.type === "write" || input.type === "edit") {
        const filePath =
          (input.metadata?.path as string) ??
          (typeof input.pattern === "string" ? input.pattern : input.pattern?.[0]);

        if (filePath) {
          const result = fileLocks.tryAcquire(filePath, member.id, member.teamID);
          if (!result.ok) {
            output.status = "deny";
            return;
          }
        }
      }
    } catch (err) {
      // Never crash the host. Leave output.status alone — the default is
      // "ask", which is the safest fallback: never silently allow a denied
      // operation, never block legitimate ones either.
      logHookError(projectDir, "permission.ask", err);
    }
  };
}
