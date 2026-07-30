import * as fs from "node:fs";
import * as path from "node:path";
import { execFileP } from "./exec.js";

// Raw git worktrees (not `experimental_workspace` — that API is a TUI-facing
// workspace registry; worktrees give the runner full control). Worktrees
// live in a sibling directory of the project so the repo stays clean:
//   <parent-of-project>/.orch-worktrees/<projectBasename>/<runID>/<stepID>

export function worktreePath(projectDir: string, runID: string, stepID: string): string {
  return path.join(
    path.dirname(projectDir),
    ".orch-worktrees",
    path.basename(projectDir),
    runID,
    stepID
  );
}

async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileP("git", args, {
    cwd,
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout;
}

// Throws when the project is not a git repo or has no commits — the caller
// falls back to running in the main directory (isolationFallback).
export async function addWorktree(projectDir: string, wtPath: string): Promise<void> {
  await git(["worktree", "add", "--detach", wtPath, "HEAD"], projectDir);
}

// Best-effort removal; never throws.
export async function removeWorktree(projectDir: string, wtPath: string): Promise<void> {
  try {
    await git(["worktree", "remove", "--force", wtPath], projectDir);
  } catch {
    // Already gone or never created — nothing to do.
    return;
  }
  // Prune the now-empty per-run dir `.orch-worktrees/<basename>/<runID>/`
  // and the per-project dir above it when this was its last worktree.
  // ENOTEMPTY (another step of the run still owns it) and ENOENT (already
  // pruned) are both fine. Guarded to the managed layout so a stray wtPath
  // can never rmdir arbitrary parents.
  const runDir = path.dirname(wtPath);
  const projectWtDir = path.dirname(runDir);
  if (path.basename(path.dirname(projectWtDir)) !== ".orch-worktrees") return;
  for (const dir of [runDir, projectWtDir]) {
    try {
      await fs.promises.rmdir(dir);
    } catch {
      // Not empty or already gone — leave it.
    }
  }
}

export interface WorktreeChanges {
  /** Added/modified files (relative paths) to copy into the project dir. */
  upserts: string[];
  /** Deleted files (relative paths) to remove from the project dir. */
  deletes: string[];
  /** Symlink entries skipped by copy-back (never copied, never deleted). */
  skippedSymlinks: string[];
}

// The plugin's own state dir is never worker work-product: the worktree's
// own opencode instance also loads this plugin, and its Store/reporter may
// write there (e.g. init.log) before the runner removes the worktree.
// Excluded from copy-back so plugin internals never land in the user's repo
// or show up as bogus copy-back conflicts.
export const COPYBACK_EXCLUDE_PREFIX = ".opencode/plugin-orch/";

/** True when a worktree-relative path is plugin-internal state, not worker output. */
export function isExcludedFromCopyBack(rel: string): boolean {
  const norm = rel.split(path.sep).join("/");
  return (
    norm === COPYBACK_EXCLUDE_PREFIX.slice(0, -1) || norm.startsWith(COPYBACK_EXCLUDE_PREFIX)
  );
}

// Unquote a C-style quoted path from git porcelain output. Non-ASCII bytes
// are octal-escaped UTF-8 (\344\270\255), so decode through a byte buffer.
function unquote(p: string): string {
  if (p.length < 2 || !p.startsWith('"') || !p.endsWith('"')) return p;
  const body = p.slice(1, -1);
  let out = "";
  let bytes: number[] = [];
  const flush = () => {
    if (bytes.length > 0) {
      out += Buffer.from(bytes).toString("utf-8");
      bytes = [];
    }
  };
  for (let i = 0; i < body.length; i++) {
    if (body[i] !== "\\") {
      flush();
      out += body[i];
      continue;
    }
    const n = body[++i];
    if (n >= "0" && n <= "7") {
      bytes.push(parseInt(body.slice(i, i + 3), 8));
      i += 2;
    } else {
      flush();
      out += n === "n" ? "\n" : n === "t" ? "\t" : n;
    }
  }
  flush();
  return out;
}

// Parse `git status --porcelain=v1 --untracked-files=all` output. With
// -uall every entry is a single file (untracked dirs are expanded). Workers
// never stage, so renames surface as `D old` + `?? new` — but handle the
// staged `R old -> new` form anyway by taking the new path.
export function parsePorcelain(text: string): Pick<WorktreeChanges, "upserts" | "deletes"> {
  const upserts = new Set<string>();
  const deletes = new Set<string>();
  for (const line of text.split("\n")) {
    if (line.length < 4) continue;
    const x = line[0];
    const y = line[1];
    let p = line.slice(3);
    const arrow = p.indexOf(" -> ");
    if ((x === "R" || y === "R") && arrow !== -1) {
      p = p.slice(arrow + 4);
    }
    p = unquote(p);
    if (!p) continue;
    if (x === "?" && y === "?") {
      upserts.add(p);
    } else if (x === "D" || y === "D") {
      deletes.add(p);
    } else {
      upserts.add(p); // modified / added / typechange
    }
  }
  for (const u of upserts) deletes.delete(u);
  return { upserts: [...upserts], deletes: [...deletes] };
}

export async function collectChanges(wtPath: string): Promise<WorktreeChanges> {
  const changes = parsePorcelain(
    await git(["status", "--porcelain=v1", "--untracked-files=all"], wtPath)
  );
  const upserts: string[] = [];
  const deletes: string[] = [];
  const skippedSymlinks: string[] = [];
  // Symlink entries are skipped: a link can point inside the (soon-removed)
  // worktree — dangling after cleanup — or outside the repo entirely, so
  // copy-back must never recreate it in the project dir nor delete a
  // same-named counterpart there.
  for (const rel of changes.upserts) {
    if (isExcludedFromCopyBack(rel)) continue;
    const src = safeJoin(wtPath, rel);
    let isLink = false;
    if (src) {
      try {
        isLink = (await fs.promises.lstat(src)).isSymbolicLink();
      } catch {
        // Raced with removal — treat as a regular file.
      }
    }
    if (isLink) skippedSymlinks.push(rel);
    else upserts.push(rel);
  }
  for (const rel of changes.deletes) {
    if (isExcludedFromCopyBack(rel)) continue;
    // Deleted entries have no file left to lstat; the git index mode
    // (120000 = symlink) tells us what the path was.
    if (await isTrackedSymlink(wtPath, rel)) skippedSymlinks.push(rel);
    else deletes.push(rel);
  }
  return { upserts, deletes, skippedSymlinks };
}

// True when HEAD tracks `rel` as a symlink (index mode 120000).
async function isTrackedSymlink(wtPath: string, rel: string): Promise<boolean> {
  try {
    const out = await git(["ls-files", "-s", "--", rel], wtPath);
    return out.split("\n").some((line) => line.startsWith("120000 "));
  } catch {
    return false;
  }
}

// Guard against a crafted porcelain path escaping the target directory.
function safeJoin(root: string, rel: string): string | undefined {
  const abs = path.resolve(root, rel);
  return abs.startsWith(root + path.sep) ? abs : undefined;
}

// Apply the worktree's changes to the main project dir: copy added/modified
// files, delete removed ones. Returns every applied path (copies + deletes).
export async function copyBack(
  wtPath: string,
  projectDir: string,
  changes: WorktreeChanges
): Promise<string[]> {
  const applied: string[] = [];
  for (const rel of changes.upserts) {
    const src = safeJoin(wtPath, rel);
    const dst = safeJoin(projectDir, rel);
    if (!src || !dst) continue;
    await fs.promises.mkdir(path.dirname(dst), { recursive: true });
    await fs.promises.cp(src, dst, { recursive: true });
    applied.push(rel);
  }
  for (const rel of changes.deletes) {
    const dst = safeJoin(projectDir, rel);
    if (!dst) continue;
    await fs.promises.rm(dst, { recursive: true, force: true });
    applied.push(rel);
  }
  return applied;
}
