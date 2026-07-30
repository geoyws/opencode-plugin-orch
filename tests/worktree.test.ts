// Worktree isolation tests. Uses the real `git` binary in temp repos —
// `git init`, one commit, then runner-managed `git worktree add --detach`.
import { describe, it, expect, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import {
  parsePorcelain,
  collectChanges,
  copyBack,
  addWorktree,
  removeWorktree,
  worktreePath,
  isExcludedFromCopyBack,
} from "../src/core/worktree.js";
import {
  makeEnv,
  completePrompt,
  waitForRun,
  waitFor,
  tmpProject,
  rmrf,
  type Env,
} from "./_harness.js";

let envs: Env[] = [];
let dirs: string[] = [];

afterEach(() => {
  for (const e of envs) e.destroy();
  envs = [];
  for (const d of dirs) {
    rmrf(d);
    // Worktrees live in a sibling dir of the project.
    rmrf(path.join(path.dirname(d), ".orch-worktrees", path.basename(d)));
  }
  dirs = [];
});

function git(args: string[], cwd: string): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

function repo(): string {
  const dir = tmpProject("orch-wt-test-");
  dirs.push(dir);
  git(["init", "-q", "-b", "main"], dir);
  git(["config", "user.email", "test@example.com"], dir);
  git(["config", "user.name", "Test"], dir);
  fs.writeFileSync(path.join(dir, "README.md"), "# test\n");
  fs.writeFileSync(path.join(dir, "gone.txt"), "to be deleted\n");
  git(["add", "."], dir);
  git(["-c", "commit.gpgsign=false", "commit", "-q", "-m", "init"], dir);
  return dir;
}

function plainDir(): string {
  const dir = tmpProject("orch-wt-nogit-");
  dirs.push(dir);
  return dir;
}

function writeWorkflow(dir: string, def: object): void {
  const wfDir = path.join(dir, ".opencode", "workflows");
  fs.mkdirSync(wfDir, { recursive: true });
  fs.writeFileSync(path.join(wfDir, "wf.json"), JSON.stringify(def), "utf-8");
}

const aggregate = { id: "aggregate", instructions: "summarize {{input}}" };

function isoParallel(steps: object[]): object {
  return {
    name: "wt-parallel",
    description: "isolated parallel test workflow",
    pattern: "parallel",
    isolation: "worktree",
    steps,
    aggregate,
  };
}

describe("parsePorcelain", () => {
  it("parses untracked, modified, deleted, quoted and renamed entries", () => {
    const text = [
      " M src/modified.ts",
      "M  src/staged.ts",
      " D src/deleted.ts",
      "?? src/new-file.ts",
      // Snowman U+2603 = UTF-8 E2 98 83, octal-escaped by git.
      '?? "src/\\342\\230\\203.ts"',
      'R  "old name.ts" -> "new name.ts"',
      "",
    ].join("\n");
    const changes = parsePorcelain(text);
    expect(changes.upserts).toContain("src/modified.ts");
    expect(changes.upserts).toContain("src/staged.ts");
    expect(changes.upserts).toContain("src/new-file.ts");
    expect(changes.upserts).toContain("src/☃.ts");
    // Staged rename takes the new (quoted) path.
    expect(changes.upserts).toContain("new name.ts");
    expect(changes.deletes).toEqual(["src/deleted.ts"]);
  });

  it("a path both deleted and re-added ends up as an upsert", () => {
    const changes = parsePorcelain(" D same.ts\n?? same.ts");
    expect(changes.upserts).toEqual(["same.ts"]);
    expect(changes.deletes).toEqual([]);
  });
});

describe("copy-back exclusion", () => {
  it("isExcludedFromCopyBack matches only paths under .opencode/plugin-orch/", () => {
    expect(isExcludedFromCopyBack(".opencode/plugin-orch/init.log")).toBe(true);
    expect(isExcludedFromCopyBack(".opencode/plugin-orch")).toBe(true);
    expect(
      isExcludedFromCopyBack(path.join(".opencode", "plugin-orch", "runs.jsonl"))
    ).toBe(true);
    expect(isExcludedFromCopyBack(".opencode/plugin-orchish/x")).toBe(false);
    expect(isExcludedFromCopyBack(".opencode/workflows/wf.json")).toBe(false);
    expect(isExcludedFromCopyBack("src/index.ts")).toBe(false);
  });

  it("collectChanges drops plugin-state upserts and deletes", async () => {
    const dir = repo();
    const wt = worktreePath(dir, "run_excl", "s1");
    await addWorktree(dir, wt);

    fs.writeFileSync(path.join(wt, "real.txt"), "work\n");
    fs.mkdirSync(path.join(wt, ".opencode", "plugin-orch"), { recursive: true });
    fs.writeFileSync(path.join(wt, ".opencode", "plugin-orch", "init.log"), "noise\n");
    fs.rmSync(path.join(wt, "gone.txt"));

    const changes = await collectChanges(wt);
    expect(changes.upserts).toEqual(["real.txt"]);
    expect(changes.deletes).toEqual(["gone.txt"]);

    await removeWorktree(dir, wt);
  });

  it("collectChanges skips symlink upserts (lstat) and deletes (index mode)", async () => {
    const dir = repo();
    // A symlink tracked at HEAD: deleted in the worktree below.
    fs.symlinkSync("README.md", path.join(dir, "tracked-link"));
    git(["add", "."], dir);
    git(["-c", "commit.gpgsign=false", "commit", "-q", "-m", "add link"], dir);

    const wt = worktreePath(dir, "run_sym", "s1");
    await addWorktree(dir, wt);
    fs.writeFileSync(path.join(wt, "real.txt"), "x\n");
    // Untracked symlink pointing INTO the worktree (dangles after removal).
    fs.symlinkSync(path.join(wt, "real.txt"), path.join(wt, "new-link"));
    fs.rmSync(path.join(wt, "tracked-link")); // delete the tracked symlink

    const changes = await collectChanges(wt);
    expect(changes.upserts).toEqual(["real.txt"]);
    expect(changes.deletes).toEqual([]);
    expect([...changes.skippedSymlinks].sort()).toEqual(["new-link", "tracked-link"]);

    await removeWorktree(dir, wt);
  });
});

describe("worktree lifecycle", () => {
  it("worktreePath nests under <parent>/.orch-worktrees/<basename>/<runID>/<stepID>", () => {
    const dir = "/tmp/proj-xyz";
    expect(worktreePath(dir, "run_1", "s1")).toBe(
      path.join("/tmp", ".orch-worktrees", "proj-xyz", "run_1", "s1")
    );
  });

  it("addWorktree/removeWorktree round-trip; removal is idempotent", async () => {
    const dir = repo();
    const wt = worktreePath(dir, "run_life", "s1");
    await addWorktree(dir, wt);
    expect(fs.existsSync(path.join(wt, "README.md"))).toBe(true);
    await removeWorktree(dir, wt);
    expect(fs.existsSync(wt)).toBe(false);
    await removeWorktree(dir, wt); // already gone — must not throw
  });

  it("addWorktree rejects outside a git repo (drives isolationFallback)", async () => {
    const dir = plainDir();
    await expect(addWorktree(dir, path.join(dir, "wt"))).rejects.toThrow();
  });

  it("removeWorktree prunes empty run/project dirs, preserves non-empty ones", async () => {
    const dir = repo();
    const wt1 = worktreePath(dir, "run_prune", "s1");
    const wt2 = worktreePath(dir, "run_prune", "s2");
    await addWorktree(dir, wt1);
    await addWorktree(dir, wt2);
    const runDir = path.dirname(wt1);
    const projWtDir = path.dirname(runDir);

    // s2 still owns the run dir — removing s1 prunes nothing.
    await removeWorktree(dir, wt1);
    expect(fs.existsSync(runDir)).toBe(true);

    // Last worktree of the run gone: run dir and project dir are pruned.
    await removeWorktree(dir, wt2);
    expect(fs.existsSync(runDir)).toBe(false);
    expect(fs.existsSync(projWtDir)).toBe(false);

    // A leftover file keeps both dirs in place.
    const wt3 = worktreePath(dir, "run_keep", "s1");
    await addWorktree(dir, wt3);
    const keepRunDir = path.dirname(wt3);
    fs.writeFileSync(path.join(keepRunDir, "leftover.txt"), "x");
    await removeWorktree(dir, wt3);
    expect(fs.existsSync(path.join(keepRunDir, "leftover.txt"))).toBe(true);
  });

  it("collectChanges sees adds, modifications, deletions and UTF-8 paths; copyBack applies them", async () => {
    const dir = repo();
    const wt = worktreePath(dir, "run_collect", "s1");
    await addWorktree(dir, wt);

    fs.writeFileSync(path.join(wt, "README.md"), "# changed\n"); // modify
    fs.rmSync(path.join(wt, "gone.txt")); // delete
    fs.mkdirSync(path.join(wt, "sub"), { recursive: true });
    fs.writeFileSync(path.join(wt, "sub", "new.txt"), "new\n"); // add
    fs.writeFileSync(path.join(wt, "☃.txt"), "snow\n"); // UTF-8 add

    const changes = await collectChanges(wt);
    expect(changes.upserts).toContain("README.md");
    expect(changes.upserts).toContain("sub/new.txt");
    expect(changes.upserts).toContain("☃.txt");
    expect(changes.deletes).toEqual(["gone.txt"]);

    const applied = await copyBack(wt, dir, changes);
    expect(applied.sort()).toEqual(["README.md", "gone.txt", "sub/new.txt", "☃.txt"].sort());
    expect(fs.readFileSync(path.join(dir, "README.md"), "utf-8")).toBe("# changed\n");
    expect(fs.existsSync(path.join(dir, "gone.txt"))).toBe(false);
    expect(fs.readFileSync(path.join(dir, "sub", "new.txt"), "utf-8")).toBe("new\n");
    expect(fs.readFileSync(path.join(dir, "☃.txt"), "utf-8")).toBe("snow\n");

    await removeWorktree(dir, wt);
  });
});

describe("worktree-isolated runs", () => {
  it("copies back different files from two workers and removes the worktrees", async () => {
    const dir = repo();
    writeWorkflow(
      dir,
      isoParallel([
        { id: "w1", command: "echo aaa > file-a.txt" },
        { id: "w2", command: "mkdir -p sub && echo bbb > sub/file-b.txt" },
      ])
    );
    const e = await makeEnv(dir);
    envs.push(e);
    const run = await e.runner.startRun("wt-parallel", "go", { concurrency: 2 });

    // Command steps create no LLM sessions — the first prompt is the aggregate.
    const agg = await completePrompt(e, "summary");
    expect(agg.stepID).toBe("aggregate");

    const done = await waitForRun(e, run.id);
    expect(done.status).toBe("completed");
    expect(fs.readFileSync(path.join(dir, "file-a.txt"), "utf-8")).toBe("aaa\n");
    expect(fs.readFileSync(path.join(dir, "sub", "file-b.txt"), "utf-8")).toBe("bbb\n");
    expect(done.steps.w1.copiedFiles).toEqual(["file-a.txt"]);
    expect(done.steps.w2.copiedFiles).toEqual(["sub/file-b.txt"]);
    expect(done.steps.w1.conflicts).toBeUndefined();
    expect(done.steps.w2.conflicts).toBeUndefined();
    expect(fs.existsSync(worktreePath(dir, run.id, "w1"))).toBe(false);
    expect(fs.existsSync(worktreePath(dir, run.id, "w2"))).toBe(false);
  });

  it("records a conflict on the later finisher when both workers touch the same file", async () => {
    const dir = repo();
    writeWorkflow(
      dir,
      isoParallel([
        { id: "w1", command: "echo one > shared.txt" },
        { id: "w2", command: "echo two > shared.txt" },
      ])
    );
    const e = await makeEnv(dir);
    envs.push(e);
    // Concurrency 1 makes w1 finish strictly before w2 — w2 is the later finisher.
    const run = await e.runner.startRun("wt-parallel", "go", { concurrency: 1 });

    await completePrompt(e, "summary");
    const done = await waitForRun(e, run.id);
    expect(done.status).toBe("completed");
    // Last finisher wins.
    expect(fs.readFileSync(path.join(dir, "shared.txt"), "utf-8")).toBe("two\n");
    expect(done.steps.w1.copiedFiles).toEqual(["shared.txt"]);
    expect(done.steps.w1.conflicts).toBeUndefined();
    expect(done.steps.w2.copiedFiles).toEqual(["shared.txt"]);
    expect(done.steps.w2.conflicts).toEqual(["shared.txt"]);
  });

  it("plugin state written in the worktree is not copied back and never conflicts", async () => {
    const dir = repo();
    const pluginLog = "mkdir -p .opencode/plugin-orch && echo log > .opencode/plugin-orch/init.log";
    writeWorkflow(
      dir,
      isoParallel([
        { id: "w1", command: `${pluginLog} && echo aaa > real-a.txt` },
        { id: "w2", command: `${pluginLog} && echo bbb > real-b.txt` },
      ])
    );
    const e = await makeEnv(dir);
    envs.push(e);
    // Concurrency 1: both workers write the same plugin-state path — without
    // the exclusion w2 would record a bogus conflict on it.
    const run = await e.runner.startRun("wt-parallel", "go", { concurrency: 1 });

    await completePrompt(e, "summary");
    const done = await waitForRun(e, run.id);
    expect(done.status).toBe("completed");
    expect(done.steps.w1.copiedFiles).toEqual(["real-a.txt"]);
    expect(done.steps.w2.copiedFiles).toEqual(["real-b.txt"]);
    expect(done.steps.w1.conflicts).toBeUndefined();
    expect(done.steps.w2.conflicts).toBeUndefined();
    expect(fs.readFileSync(path.join(dir, "real-a.txt"), "utf-8")).toBe("aaa\n");
    expect(fs.readFileSync(path.join(dir, "real-b.txt"), "utf-8")).toBe("bbb\n");
    // Plugin internals never land in the user's repo.
    expect(fs.existsSync(path.join(dir, ".opencode", "plugin-orch", "init.log"))).toBe(false);
  });

  it("a symlink into the worktree is skipped in copy-back and recorded in skippedSymlinks", async () => {
    const dir = repo();
    writeWorkflow(
      dir,
      isoParallel([
        // The link points INTO the worktree — it would dangle after removal.
        { id: "w1", command: 'echo real > real.txt && ln -s "$PWD/real.txt" link.txt' },
      ])
    );
    const e = await makeEnv(dir);
    envs.push(e);
    const run = await e.runner.startRun("wt-parallel", "go");

    await completePrompt(e, "summary");
    const done = await waitForRun(e, run.id);
    expect(done.status).toBe("completed");
    expect(done.steps.w1.copiedFiles).toEqual(["real.txt"]);
    expect(done.steps.w1.skippedSymlinks).toEqual(["link.txt"]);
    expect(fs.readFileSync(path.join(dir, "real.txt"), "utf-8")).toBe("real\n");
    // Neither the link nor its target content leaked into the main repo.
    expect(fs.existsSync(path.join(dir, "link.txt"))).toBe(false);
  });

  it("falls back to the main directory (isolationFallback) outside a git repo", async () => {
    const dir = plainDir();
    writeWorkflow(dir, isoParallel([{ id: "w1", command: "echo hi > out.txt" }]));
    const e = await makeEnv(dir);
    envs.push(e);
    const run = await e.runner.startRun("wt-parallel", "go");

    await completePrompt(e, "summary");
    const done = await waitForRun(e, run.id);
    expect(done.status).toBe("completed");
    expect(fs.readFileSync(path.join(dir, "out.txt"), "utf-8")).toBe("hi\n");
    expect(done.steps.w1.isolationFallback).toBe(true);
    expect(done.steps.w1.copiedFiles).toBeUndefined();
  });

  it("settles a worktree LLM step via the 2s poll fallback (no session.idle)", async () => {
    const dir = repo();
    writeWorkflow(dir, isoParallel([{ id: "w1", instructions: "write stuff for {{input}}" }]));
    const e = await makeEnv(dir);
    envs.push(e);
    const run = await e.runner.startRun("wt-parallel", "go");

    await waitFor(() => e.client.prompts.length === 1, "worker prompt");
    const rec = e.client.prompts[0];
    // Assistant message with time.completed set — but no onSessionIdle call:
    // only the (hardcoded 2s, unref'd) worktree poll can settle this step.
    e.client.setOutput(rec.sessionID, "worker done", { completed: true });
    await waitFor(
      () => e.store.getRun(run.id)?.steps.w1?.status === "completed",
      "worktree poll to settle the step",
      5000
    );

    const agg = await completePrompt(e, "summary", 1);
    expect(agg.stepID).toBe("aggregate");
    const done = await waitForRun(e, run.id);
    expect(done.status).toBe("completed");
    expect(done.steps.w1.output).toBe("worker done");
    expect(fs.existsSync(worktreePath(dir, run.id, "w1"))).toBe(false);
  });

  it("cancel during a worktree step removes the worktree without copy-back", async () => {
    const dir = repo();
    writeWorkflow(dir, isoParallel([{ id: "w1", instructions: "long task" }]));
    const e = await makeEnv(dir);
    envs.push(e);
    const run = await e.runner.startRun("wt-parallel", "go");

    await waitFor(() => e.client.prompts.length === 1, "worker prompt");
    const sid = e.client.prompts[0].sessionID;
    const wt = worktreePath(dir, run.id, "w1");
    await waitFor(() => fs.existsSync(wt), "worktree to be created");
    // Simulate the worker mid-write.
    fs.writeFileSync(path.join(wt, "wip.txt"), "wip");

    await e.runner.cancel(run.id);
    expect(e.client.aborts).toContain(sid);
    const done = await waitForRun(e, run.id);
    expect(done.status).toBe("cancelled");
    expect(fs.existsSync(wt)).toBe(false);
    expect(fs.existsSync(path.join(dir, "wip.txt"))).toBe(false);
  });
});
