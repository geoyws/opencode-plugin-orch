// permission.ask hook: auto-allow runner-tracked step sessions, deny
// git-mutating bash commands, leave everything else untouched.
import { describe, it, expect, afterEach } from "bun:test";
import { createPermissionHook, isGitMutating } from "../src/hooks/permissions.js";
import { makeEnv, waitFor, rmrf, type Env } from "./_harness.js";

let envs: Env[] = [];

afterEach(async () => {
  delete process.env.ORCH_STEP_PERMISSIONS;
  for (const e of envs) {
    e.destroy();
    // Let the runner's background execute() settle (it writes a failRun
    // event for the still-running chain) before removing the store dir.
    await new Promise((r) => setTimeout(r, 20));
    rmrf(e.projectDir);
  }
  envs = [];
});

// Start a chain run and return the hook plus the tracked step session id.
async function setup() {
  const e = await makeEnv();
  envs.push(e);
  await e.runner.startRun("chain-draft-refine", "x");
  await waitFor(() => e.client.prompts.length === 1, "step session");
  const sessionID = e.client.prompts[0].sessionID;
  const hook = createPermissionHook({ runner: e.runner, directory: e.projectDir });
  return { e, hook, sessionID };
}

type Hook = ReturnType<typeof createPermissionHook>;

async function askBash(hook: Hook, sessionID: string, command: string) {
  const output: { status?: string } = {};
  await hook({ sessionID, metadata: { command } } as never, output as never);
  return output.status;
}

describe("isGitMutating", () => {
  it("flags git-mutating commands", () => {
    for (const cmd of [
      "git commit -m x",
      "git push origin main",
      "git merge feature",
      "git rebase main",
      "git reset --hard HEAD~1",
      "git clean -fd",
      "git stash",
      "git cherry-pick abc123",
      "git revert HEAD",
      "git branch -d old",
      "git branch -D old",
      "git branch -m new",
      "git tag -d v1",
      "git checkout main",
      "git switch main",
      "git restore src/a.ts",
      "git worktree remove wt",
      "cd sub && git commit -m x",
      // Conservative substring matching: a git-mutating substring anywhere
      // in the command is denied, even when git isn't the invoked program.
      "echo git commit",
    ]) {
      expect(isGitMutating(cmd), cmd).toBe(true);
    }
  });

  it("passes read-only git and non-git commands", () => {
    for (const cmd of [
      "git status",
      "git log --oneline",
      "git diff HEAD",
      "git show HEAD",
      "git blame src/a.ts",
      "git branch",
      "git branch -a",
      "git tag",
      "git tag -l",
      "git ls-files",
      "git rev-parse HEAD",
      "npm test",
    ]) {
      expect(isGitMutating(cmd), cmd).toBe(false);
    }
  });
});

describe("permission.ask hook", () => {
  it("denies git-mutating commands for tracked step sessions", async () => {
    const { hook, sessionID } = await setup();
    expect(await askBash(hook, sessionID, "git commit -m wip")).toBe("deny");
    expect(await askBash(hook, sessionID, "git push origin main")).toBe("deny");
    expect(await askBash(hook, sessionID, "git checkout main")).toBe("deny");
  });

  it("allows read-only git and non-git commands for tracked step sessions", async () => {
    const { hook, sessionID } = await setup();
    expect(await askBash(hook, sessionID, "git status")).toBe("allow");
    expect(await askBash(hook, sessionID, "npm test")).toBe("allow");
  });

  it("allows non-bash tool types (edit/write) for tracked step sessions", async () => {
    const { hook, sessionID } = await setup();
    const output: { status?: string } = {};
    await hook(
      { sessionID, metadata: {}, title: "edit src/a.ts" } as never,
      output as never
    );
    expect(output.status).toBe("allow");
  });

  it("leaves untracked sessions completely untouched", async () => {
    const { hook } = await setup();
    expect(await askBash(hook, "sess_not_tracked", "git commit -m x")).toBeUndefined();
    expect(await askBash(hook, "sess_not_tracked", "npm test")).toBeUndefined();
  });

  it("ORCH_STEP_PERMISSIONS=ask disables the hook entirely", async () => {
    const { hook, sessionID } = await setup();
    process.env.ORCH_STEP_PERMISSIONS = "ask";
    expect(await askBash(hook, sessionID, "npm test")).toBeUndefined();
    expect(await askBash(hook, sessionID, "git commit -m x")).toBeUndefined();
  });

  it('stepPermissions: "ask" disables the hook like the env var', async () => {
    const e = await makeEnv();
    envs.push(e);
    await e.runner.startRun("chain-draft-refine", "x");
    await waitFor(() => e.client.prompts.length === 1, "step session");
    const sessionID = e.client.prompts[0].sessionID;
    const hook = createPermissionHook({
      runner: e.runner,
      directory: e.projectDir,
      stepPermissions: "ask",
    });
    expect(await askBash(hook, sessionID, "npm test")).toBeUndefined();
    expect(await askBash(hook, sessionID, "git commit -m x")).toBeUndefined();
  });

  it('stepPermissions: "auto" (or absent) keeps the auto-allow', async () => {
    const e = await makeEnv();
    envs.push(e);
    await e.runner.startRun("chain-draft-refine", "x");
    await waitFor(() => e.client.prompts.length === 1, "step session");
    const sessionID = e.client.prompts[0].sessionID;
    const auto = createPermissionHook({
      runner: e.runner,
      directory: e.projectDir,
      stepPermissions: "auto",
    });
    const absent = createPermissionHook({ runner: e.runner, directory: e.projectDir });
    expect(await askBash(auto, sessionID, "npm test")).toBe("allow");
    expect(await askBash(absent, sessionID, "npm test")).toBe("allow");
    expect(await askBash(absent, sessionID, "git commit -m x")).toBe("deny");
  });
});
