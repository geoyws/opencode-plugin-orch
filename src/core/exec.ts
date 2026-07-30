import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

// Node child_process APIs (not Bun-only) so the same code runs under the
// opencode plugin host and under `bun test`. Always execFile with arg
// arrays — never shell string interpolation for paths.
export const execFileP = promisify(execFile);

export interface ShellResult {
  /** Process exit code; 1 for spawn errors, 124 for timeouts, 137 when killed. */
  code: number;
  /** Combined stdout + stderr (stream interleaving not preserved). */
  output: string;
}

export interface ShellHandle {
  /** Resolves on process exit. Never rejects for non-zero exits. */
  done: Promise<ShellResult>;
  /** SIGKILL the command's whole process group; no-op once it has exited. */
  kill: () => void;
}

// Run a shell command via /bin/sh -c. Never rejects for non-zero exits —
// the caller decides what a failure means (command step vs. gate). Only
// genuinely unexpected runtime errors propagate.
//
// Unix-only, like the rest of the plugin (/bin/sh, git worktrees): the
// shell runs in its own process group (detached) and both the timeout and
// kill() SIGKILL the whole group. Killing only the direct child would
// orphan grandchildren (e.g. `sleep 30`) on timeout/cancel.
export function runShell(command: string, cwd: string, timeoutMs: number): ShellHandle {
  const MAX_OUTPUT = 64 * 1024 * 1024;
  let killed = false;
  let timedOut = false;
  let pid: number | undefined;
  const kill = () => {
    killed = true;
    if (pid === undefined) return;
    try {
      // Negative pid: the process group, so shell children die too.
      process.kill(-pid, "SIGKILL");
    } catch {
      // Already exited (ESRCH) — nothing to do.
    }
  };
  const done = new Promise<ShellResult>((resolve) => {
    let output = "";
    const append = (chunk: Buffer) => {
      if (output.length < MAX_OUTPUT) output += chunk.toString();
    };
    const child = spawn("/bin/sh", ["-c", command], { cwd, detached: true });
    pid = child.pid;
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, timeoutMs);
    if (typeof timer.unref === "function") timer.unref();
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    child.on("error", (err) => {
      // Spawn-level failure (bad cwd, missing shell, ...).
      clearTimeout(timer);
      resolve({ code: 1, output: output + `\n[orch] ${err.message}` });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (timedOut) {
        output += `\n[orch] command timed out after ${Math.round(timeoutMs / 1000)}s`;
        return resolve({ code: 124, output });
      }
      if (killed) return resolve({ code: 137, output }); // 128 + SIGKILL
      if (signal) return resolve({ code: signal === "SIGKILL" ? 137 : 1, output });
      resolve({ code: code ?? 1, output });
    });
  });
  return { done, kill };
}
