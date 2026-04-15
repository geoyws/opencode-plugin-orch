import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { Store } from "../src/state/store.js";
import type { Member, Task } from "../src/state/schemas.js";
import {
  canTransition,
  transitionMember,
  isActive,
  isIdle,
  isBusy,
  stateIcon,
} from "../src/core/member.js";
import { TaskBoard } from "../src/core/task-board.js";
import { FileLockManager } from "../src/core/file-locks.js";

// ── Helpers ──────────────────────────────────────────────────────────

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "orch-test-"));
}

function removeTmpDir(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

function makeMember(overrides: Partial<Member> = {}): Member {
  return {
    id: overrides.id ?? "member_test_1",
    teamID: overrides.teamID ?? "team_test_1",
    sessionID: overrides.sessionID ?? "sess_1",
    role: overrides.role ?? "backend",
    state: overrides.state ?? "ready",
    instructions: overrides.instructions ?? "do stuff",
    files: overrides.files ?? [],
    escalationLevel: overrides.escalationLevel ?? 0,
    retryCount: overrides.retryCount ?? 0,
    createdAt: overrides.createdAt ?? Date.now(),
  };
}

// ─────────────────────────────────────────────────────────────────────
// 1. Member State Machine
// ─────────────────────────────────────────────────────────────────────

describe("Member state machine", () => {
  describe("canTransition() — valid transitions", () => {
    const validPairs: [string, string][] = [
      ["initializing", "ready"],
      ["initializing", "error"],
      ["initializing", "shutdown"],
      ["ready", "busy"],
      ["ready", "shutdown_requested"],
      ["ready", "shutdown"],
      ["ready", "error"],
      ["busy", "ready"],
      ["busy", "error"],
      ["busy", "shutdown_requested"],
      ["shutdown_requested", "shutdown"],
      ["shutdown_requested", "ready"],
      ["error", "ready"],
      ["error", "shutdown"],
    ];

    for (const [from, to] of validPairs) {
      test(`${from} -> ${to}`, () => {
        expect(canTransition(from as any, to as any)).toBe(true);
      });
    }
  });

  describe("canTransition() — invalid transitions", () => {
    const invalidPairs: [string, string][] = [
      ["shutdown", "ready"],
      ["shutdown", "busy"],
      ["shutdown", "initializing"],
      ["shutdown", "error"],
      ["initializing", "busy"],
      ["initializing", "shutdown_requested"],
      ["busy", "initializing"],
      ["error", "busy"],
      ["error", "initializing"],
    ];

    for (const [from, to] of invalidPairs) {
      test(`${from} -> ${to} is rejected`, () => {
        expect(canTransition(from as any, to as any)).toBe(false);
      });
    }
  });

  describe("transitionMember()", () => {
    test("successful transition updates state", () => {
      const member = makeMember({ state: "ready" });
      const updated = transitionMember(member, "busy");
      expect(updated.state).toBe("busy");
      // Original is not mutated (spread copy)
      expect(member.state).toBe("ready");
    });

    test("preserves other member fields", () => {
      const member = makeMember({ state: "ready", role: "frontend" });
      const updated = transitionMember(member, "busy");
      expect(updated.role).toBe("frontend");
      expect(updated.id).toBe(member.id);
      expect(updated.teamID).toBe(member.teamID);
    });

    test("throws on invalid transition", () => {
      const member = makeMember({ state: "shutdown" });
      expect(() => transitionMember(member, "ready")).toThrow(
        /Invalid state transition/
      );
    });

    test("throws on initializing -> busy", () => {
      const member = makeMember({ state: "initializing" });
      expect(() => transitionMember(member, "busy")).toThrow(
        /Invalid state transition/
      );
    });
  });

  describe("isActive()", () => {
    test("returns true for active states", () => {
      for (const state of ["initializing", "ready", "busy", "shutdown_requested"] as const) {
        expect(isActive(makeMember({ state }))).toBe(true);
      }
    });

    test("returns false for shutdown and error", () => {
      expect(isActive(makeMember({ state: "shutdown" }))).toBe(false);
      expect(isActive(makeMember({ state: "error" }))).toBe(false);
    });
  });

  describe("isIdle()", () => {
    test("returns true only for ready", () => {
      expect(isIdle(makeMember({ state: "ready" }))).toBe(true);
    });

    test("returns false for non-ready states", () => {
      for (const state of ["initializing", "busy", "shutdown_requested", "shutdown", "error"] as const) {
        expect(isIdle(makeMember({ state }))).toBe(false);
      }
    });
  });

  describe("isBusy()", () => {
    test("returns true only for busy", () => {
      expect(isBusy(makeMember({ state: "busy" }))).toBe(true);
    });

    test("returns false for non-busy states", () => {
      for (const state of ["initializing", "ready", "shutdown_requested", "shutdown", "error"] as const) {
        expect(isBusy(makeMember({ state }))).toBe(false);
      }
    });
  });

  describe("stateIcon()", () => {
    test("returns correct icons", () => {
      expect(stateIcon("initializing")).toBe("~");
      expect(stateIcon("ready")).toBe("○");
      expect(stateIcon("busy")).toBe("●");
      expect(stateIcon("shutdown_requested")).toBe("⏻");
      expect(stateIcon("shutdown")).toBe("×");
      expect(stateIcon("error")).toBe("!");
    });
  });
});

// ─────────────────────────────────────────────────────────────────────
// 2. Task Board
// ─────────────────────────────────────────────────────────────────────

describe("TaskBoard", () => {
  let tmpDir: string;
  let store: Store;
  let board: TaskBoard;
  const teamID = "team_tb_1";
  const mockCtx = {} as any; // PluginInput — not used by TaskBoard directly

  beforeEach(async () => {
    tmpDir = makeTmpDir();
    store = new Store(tmpDir);
    await store.init();
    board = new TaskBoard(store, mockCtx);
  });

  afterEach(() => {
    store.destroy();
    removeTmpDir(tmpDir);
  });

  describe("addTask()", () => {
    test("creates task with available status", () => {
      const task = board.addTask(teamID, "Build API", "Create REST endpoints");
      expect(task.status).toBe("available");
      expect(task.title).toBe("Build API");
      expect(task.description).toBe("Create REST endpoints");
      expect(task.teamID).toBe(teamID);
      expect(task.id).toMatch(/^task_/);
      expect(task.dependsOn).toEqual([]);
      expect(task.tags).toEqual([]);
    });

    test("creates task with dependencies and tags", () => {
      // Create the dependency task first
      const dep = board.addTask(teamID, "Build", "Build step");
      const task = board.addTask(teamID, "Deploy", "Deploy to prod", {
        dependsOn: [dep.id],
        tags: ["devops", "backend"],
      });
      expect(task.dependsOn).toEqual([dep.id]);
      expect(task.tags).toEqual(["devops", "backend"]);
    });

    test("task is persisted in store", () => {
      const task = board.addTask(teamID, "Persist me", "check store");
      const fetched = store.getTask(task.id);
      expect(fetched).toBeDefined();
      expect(fetched!.title).toBe("Persist me");
    });

    test("tasks appear in listTasks()", () => {
      board.addTask(teamID, "T1", "d1");
      board.addTask(teamID, "T2", "d2");
      board.addTask("other_team", "T3", "d3");

      const tasks = board.listTasks(teamID);
      expect(tasks).toHaveLength(2);
      expect(tasks.map((t) => t.title).sort()).toEqual(["T1", "T2"]);
    });
  });

  describe("claim()", () => {
    test("transitions task to claimed with assignee", () => {
      const task = board.addTask(teamID, "Claim me", "desc");
      const claimed = board.claim(task.id, "member_1");
      expect(claimed.status).toBe("claimed");
      expect(claimed.assignee).toBe("member_1");
    });

    test("updates the persisted task", () => {
      const task = board.addTask(teamID, "Claim persist", "desc");
      board.claim(task.id, "member_1");
      const fetched = store.getTask(task.id);
      expect(fetched!.status).toBe("claimed");
      expect(fetched!.assignee).toBe("member_1");
    });

    test("throws if task is already claimed", () => {
      const task = board.addTask(teamID, "Double claim", "desc");
      board.claim(task.id, "member_1");
      expect(() => board.claim(task.id, "member_2")).toThrow(/is claimed/);
    });

    test("throws if task does not exist", () => {
      expect(() => board.claim("nonexistent_id", "member_1")).toThrow(
        /not found/
      );
    });

    test("throws if task has unmet dependencies", () => {
      const dep = board.addTask(teamID, "Dependency", "must finish first");
      const task = board.addTask(teamID, "Blocked", "waiting", {
        dependsOn: [dep.id],
      });
      expect(() => board.claim(task.id, "member_1")).toThrow(
        /unmet dependencies/
      );
    });

    test("succeeds when dependencies are completed", () => {
      const dep = board.addTask(teamID, "Dependency", "finish first");
      const task = board.addTask(teamID, "Dependent", "waiting", {
        dependsOn: [dep.id],
      });

      // Complete the dependency
      board.claim(dep.id, "member_1");
      board.complete(dep.id, "done");

      // Now claiming the dependent task should succeed
      const claimed = board.claim(task.id, "member_2");
      expect(claimed.status).toBe("claimed");
    });
  });

  describe("complete()", () => {
    test("transitions claimed task to completed", () => {
      const task = board.addTask(teamID, "Complete me", "desc");
      board.claim(task.id, "member_1");
      const completed = board.complete(task.id, "All done");
      expect(completed.status).toBe("completed");
      expect(completed.result).toBe("All done");
      expect(completed.completedAt).toBeDefined();
    });

    test("throws if task is not claimed", () => {
      const task = board.addTask(teamID, "Not claimed", "desc");
      expect(() => board.complete(task.id, "result")).toThrow(/is available/);
    });

    test("throws on already completed task", () => {
      const task = board.addTask(teamID, "Already done", "desc");
      board.claim(task.id, "member_1");
      board.complete(task.id, "done");
      expect(() => board.complete(task.id, "again")).toThrow(/is completed/);
    });
  });

  describe("fail()", () => {
    test("transitions task to failed", () => {
      const task = board.addTask(teamID, "Will fail", "desc");
      board.claim(task.id, "member_1");
      const failed = board.fail(task.id, "something broke");
      expect(failed.status).toBe("failed");
      expect(failed.result).toBe("FAILED: something broke");
      expect(failed.completedAt).toBeDefined();
    });

    test("can fail an available task", () => {
      const task = board.addTask(teamID, "Fail unclaimed", "desc");
      const failed = board.fail(task.id, "cancelled");
      expect(failed.status).toBe("failed");
    });

    test("throws if task does not exist", () => {
      expect(() => board.fail("nonexistent", "reason")).toThrow(/not found/);
    });
  });

  describe("listTasks() with filter", () => {
    test("filters by status", () => {
      const t1 = board.addTask(teamID, "T1", "d1");
      const t2 = board.addTask(teamID, "T2", "d2");
      board.addTask(teamID, "T3", "d3");
      board.claim(t1.id, "m1");
      board.claim(t2.id, "m2");
      board.complete(t2.id, "done");

      expect(board.listTasks(teamID, "available")).toHaveLength(1);
      expect(board.listTasks(teamID, "claimed")).toHaveLength(1);
      expect(board.listTasks(teamID, "completed")).toHaveLength(1);
      expect(board.listTasks(teamID, "failed")).toHaveLength(0);
    });
  });

  describe("Dependency checking", () => {
    test("areDependenciesMet returns true for no deps", () => {
      const task = board.addTask(teamID, "No deps", "desc");
      expect(board.areDependenciesMet(task)).toBe(true);
    });

    test("areDependenciesMet returns false when dep is not completed", () => {
      const dep = board.addTask(teamID, "Dep", "desc");
      const task = board.addTask(teamID, "Has dep", "desc", {
        dependsOn: [dep.id],
      });
      expect(board.areDependenciesMet(task)).toBe(false);
    });

    test("areDependenciesMet returns true when all deps completed", () => {
      const dep1 = board.addTask(teamID, "Dep1", "d");
      const dep2 = board.addTask(teamID, "Dep2", "d");
      const task = board.addTask(teamID, "Main", "d", {
        dependsOn: [dep1.id, dep2.id],
      });

      board.claim(dep1.id, "m1");
      board.complete(dep1.id, "ok");
      board.claim(dep2.id, "m2");
      board.complete(dep2.id, "ok");

      expect(board.areDependenciesMet(task)).toBe(true);
    });

    test("areDependenciesMet returns false when one dep incomplete", () => {
      const dep1 = board.addTask(teamID, "Dep1", "d");
      const dep2 = board.addTask(teamID, "Dep2", "d");
      const task = board.addTask(teamID, "Main", "d", {
        dependsOn: [dep1.id, dep2.id],
      });

      board.claim(dep1.id, "m1");
      board.complete(dep1.id, "ok");
      // dep2 not completed

      expect(board.areDependenciesMet(task)).toBe(false);
    });
  });

  describe("getAvailableForStealing()", () => {
    test("returns only available tasks with met dependencies", () => {
      const dep = board.addTask(teamID, "Dep", "d");
      board.addTask(teamID, "Free", "d"); // available, no deps
      board.addTask(teamID, "Blocked", "d", { dependsOn: [dep.id] }); // available but blocked
      const claimed = board.addTask(teamID, "Taken", "d");
      board.claim(claimed.id, "m1"); // claimed, not available
      // Claim "Dep" too so it is no longer available
      board.claim(dep.id, "m1");

      const stealable = board.getAvailableForStealing(teamID);
      expect(stealable).toHaveLength(1);
      expect(stealable[0].title).toBe("Free");
    });

    test("returns empty when no tasks are stealable", () => {
      const t = board.addTask(teamID, "Only", "d");
      board.claim(t.id, "m1");
      expect(board.getAvailableForStealing(teamID)).toHaveLength(0);
    });
  });

  describe("stealTask()", () => {
    test("claims highest scoring task for member role", () => {
      board.addTask(teamID, "Frontend work", "d", { tags: ["frontend"] });
      board.addTask(teamID, "Backend work", "d", { tags: ["backend"] });

      const stolen = board.stealTask(teamID, "m1", "backend");
      expect(stolen).not.toBeNull();
      expect(stolen!.title).toBe("Backend work");
      expect(stolen!.assignee).toBe("m1");
      expect(stolen!.status).toBe("claimed");
    });

    test("returns null when no tasks available", () => {
      const result = board.stealTask(teamID, "m1", "backend");
      expect(result).toBeNull();
    });

    test("picks any task when no tags match role", () => {
      board.addTask(teamID, "Generic task", "d");
      const stolen = board.stealTask(teamID, "m1", "backend");
      expect(stolen).not.toBeNull();
      expect(stolen!.status).toBe("claimed");
    });

    test("does not steal blocked tasks", () => {
      const dep = board.addTask(teamID, "Dep", "d");
      board.addTask(teamID, "Blocked", "d", { dependsOn: [dep.id] });
      // Claim "Dep" so the only remaining task is "Blocked" (which has unmet deps)
      board.claim(dep.id, "m1");

      const stolen = board.stealTask(teamID, "m2", "backend");
      expect(stolen).toBeNull();
    });
  });

  describe("scoreTaskForMember()", () => {
    test("base score is 1 with no matching tags", () => {
      const task = board.addTask(teamID, "T", "d", { tags: ["devops"] });
      expect(board.scoreTaskForMember(task, "frontend")).toBe(1);
    });

    test("boosts score when tag matches role", () => {
      const task = board.addTask(teamID, "T", "d", { tags: ["backend"] });
      expect(board.scoreTaskForMember(task, "backend")).toBeGreaterThan(1);
    });

    test("boosts score when role is substring of tag", () => {
      const task = board.addTask(teamID, "T", "d", {
        tags: ["backend-api"],
      });
      // "backend" is in "backend-api" so tag.includes(role) matches
      expect(board.scoreTaskForMember(task, "backend")).toBeGreaterThan(1);
    });

    test("accumulates score for multiple matching tags", () => {
      const task1 = board.addTask(teamID, "T1", "d", {
        tags: ["backend"],
      });
      const task2 = board.addTask(teamID, "T2", "d", {
        tags: ["backend", "backend-api"],
      });
      const score1 = board.scoreTaskForMember(task1, "backend");
      const score2 = board.scoreTaskForMember(task2, "backend");
      expect(score2).toBeGreaterThan(score1);
    });
  });

  describe("task priority", () => {
    test("addTask stores the provided priority", () => {
      const task = board.addTask(teamID, "Urgent", "d", { priority: 7 });
      expect(task.priority).toBe(7);
    });

    test("addTask defaults priority to 0", () => {
      const task = board.addTask(teamID, "Routine", "d");
      expect(task.priority).toBe(0);
    });

    test("getAvailableForStealing returns highest priority first", () => {
      board.addTask(teamID, "low", "d", { priority: 0 });
      board.addTask(teamID, "high", "d", { priority: 5 });
      board.addTask(teamID, "mid", "d", { priority: 2 });

      const order = board.getAvailableForStealing(teamID).map((t) => t.title);
      expect(order).toEqual(["high", "mid", "low"]);
    });

    test("ties in priority break by createdAt (older first)", async () => {
      const first = board.addTask(teamID, "first", "d", { priority: 3 });
      // Force a distinct createdAt to avoid same-ms collisions
      await new Promise((r) => setTimeout(r, 2));
      const second = board.addTask(teamID, "second", "d", { priority: 3 });

      const order = board.getAvailableForStealing(teamID);
      expect(order.map((t) => t.id)).toEqual([first.id, second.id]);
    });

    test("stealTask prefers high priority over role-matched low priority", () => {
      // A backend-tagged p=0 would normally beat a plain p=1, but priority
      // dominates so the plain p=1 should still be stolen first.
      board.addTask(teamID, "backend-but-routine", "d", {
        tags: ["backend"],
        priority: 0,
      });
      board.addTask(teamID, "urgent-generic", "d", { priority: 1 });

      const stolen = board.stealTask(teamID, "m1", "backend");
      expect(stolen).not.toBeNull();
      expect(stolen!.title).toBe("urgent-generic");
    });
  });
});

// ─────────────────────────────────────────────────────────────────────
// 3. File Locks
// ─────────────────────────────────────────────────────────────────────

describe("FileLockManager", () => {
  let tmpDir: string;
  let store: Store;
  let locks: FileLockManager;
  const teamID = "team_lock_1";

  beforeEach(async () => {
    tmpDir = makeTmpDir();
    store = new Store(tmpDir);
    await store.init();
    locks = new FileLockManager(store);
  });

  afterEach(() => {
    store.destroy();
    removeTmpDir(tmpDir);
  });

  describe("tryAcquire()", () => {
    test("succeeds when file is unlocked", () => {
      const result = locks.tryAcquire("src/main.ts", "m1", teamID);
      expect(result.ok).toBe(true);
      expect(result.holder).toBeUndefined();
    });

    test("same member can re-acquire the same lock", () => {
      locks.tryAcquire("src/main.ts", "m1", teamID);
      const result = locks.tryAcquire("src/main.ts", "m1", teamID);
      expect(result.ok).toBe(true);
    });

    test("fails when another member holds the lock", () => {
      locks.tryAcquire("src/main.ts", "m1", teamID);
      const result = locks.tryAcquire("src/main.ts", "m2", teamID);
      expect(result.ok).toBe(false);
      // holder is either the role or the memberID
      expect(result.holder).toBeDefined();
    });

    test("returns holder role if member exists in store", () => {
      const member = makeMember({ id: "m1", role: "backend" });
      store.createMember(member);

      locks.tryAcquire("src/main.ts", "m1", teamID);
      const result = locks.tryAcquire("src/main.ts", "m2", teamID);
      expect(result.ok).toBe(false);
      expect(result.holder).toBe("backend");
    });

    test("returns memberID as holder when member not in store", () => {
      locks.tryAcquire("src/main.ts", "m1", teamID);
      const result = locks.tryAcquire("src/main.ts", "m2", teamID);
      expect(result.ok).toBe(false);
      expect(result.holder).toBe("m1");
    });

    test("different files can be locked by different members", () => {
      const r1 = locks.tryAcquire("src/a.ts", "m1", teamID);
      const r2 = locks.tryAcquire("src/b.ts", "m2", teamID);
      expect(r1.ok).toBe(true);
      expect(r2.ok).toBe(true);
    });
  });

  describe("isLocked()", () => {
    test("returns false for unlocked file", () => {
      expect(locks.isLocked("src/main.ts")).toBe(false);
    });

    test("returns true for locked file", () => {
      locks.tryAcquire("src/main.ts", "m1", teamID);
      expect(locks.isLocked("src/main.ts")).toBe(true);
    });
  });

  describe("release()", () => {
    test("releases a held lock", () => {
      locks.tryAcquire("src/main.ts", "m1", teamID);
      locks.release("src/main.ts");
      expect(locks.isLocked("src/main.ts")).toBe(false);
    });

    test("allows another member to acquire after release", () => {
      locks.tryAcquire("src/main.ts", "m1", teamID);
      locks.release("src/main.ts");
      const result = locks.tryAcquire("src/main.ts", "m2", teamID);
      expect(result.ok).toBe(true);
    });

    test("releasing a non-existent lock does not throw", () => {
      expect(() => locks.release("nonexistent.ts")).not.toThrow();
    });
  });

  describe("releaseAll()", () => {
    test("releases all locks held by a member", () => {
      locks.tryAcquire("src/a.ts", "m1", teamID);
      locks.tryAcquire("src/b.ts", "m1", teamID);
      locks.tryAcquire("src/c.ts", "m2", teamID);

      locks.releaseAll("m1");

      expect(locks.isLocked("src/a.ts")).toBe(false);
      expect(locks.isLocked("src/b.ts")).toBe(false);
      // m2's lock should remain
      expect(locks.isLocked("src/c.ts")).toBe(true);
    });

    test("does nothing if member has no locks", () => {
      expect(() => locks.releaseAll("nonexistent")).not.toThrow();
    });
  });

  describe("getHolder()", () => {
    test("returns undefined for unlocked file", () => {
      expect(locks.getHolder("src/main.ts")).toBeUndefined();
    });

    test("returns member role when member exists", () => {
      store.createMember(makeMember({ id: "m1", role: "frontend" }));
      locks.tryAcquire("src/main.ts", "m1", teamID);
      expect(locks.getHolder("src/main.ts")).toBe("frontend");
    });

    test("returns memberID when member not in store", () => {
      locks.tryAcquire("src/main.ts", "m1", teamID);
      expect(locks.getHolder("src/main.ts")).toBe("m1");
    });
  });

  describe("getMemberLocks()", () => {
    test("returns all locks for a member", () => {
      locks.tryAcquire("src/a.ts", "m1", teamID);
      locks.tryAcquire("src/b.ts", "m1", teamID);
      locks.tryAcquire("src/c.ts", "m2", teamID);

      const m1Locks = locks.getMemberLocks("m1");
      expect(m1Locks).toHaveLength(2);
      expect(m1Locks.map((l) => l.path).sort()).toEqual(["src/a.ts", "src/b.ts"]);
    });

    test("returns empty array for member with no locks", () => {
      expect(locks.getMemberLocks("nobody")).toEqual([]);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────
// 4. Store (JSONL persistence)
// ─────────────────────────────────────────────────────────────────────

describe("Store", () => {
  let tmpDir: string;
  let store: Store;

  beforeEach(async () => {
    tmpDir = makeTmpDir();
    store = new Store(tmpDir);
    await store.init();
  });

  afterEach(() => {
    store.destroy();
    removeTmpDir(tmpDir);
  });

  describe("init()", () => {
    test("creates the .opencode/plugin-orch directory", () => {
      const orchDir = path.join(tmpDir, ".opencode", "plugin-orch");
      expect(fs.existsSync(orchDir)).toBe(true);
    });
  });

  describe("Team CRUD", () => {
    test("create and get team", () => {
      const team = {
        id: "team_1",
        name: "Alpha",
        leadSessionID: "sess_lead",
        config: { workStealing: true, backpressureLimit: 50 },
        createdAt: Date.now(),
      };
      store.createTeam(team);
      const fetched = store.getTeam("team_1");
      expect(fetched).toBeDefined();
      expect(fetched!.name).toBe("Alpha");
    });

    test("getTeamByName()", () => {
      store.createTeam({
        id: "team_1",
        name: "Alpha",
        leadSessionID: "s1",
        config: { workStealing: true, backpressureLimit: 50 },
        createdAt: Date.now(),
      });
      expect(store.getTeamByName("Alpha")).toBeDefined();
      expect(store.getTeamByName("Beta")).toBeUndefined();
    });

    test("listTeams()", () => {
      store.createTeam({
        id: "t1",
        name: "A",
        leadSessionID: "s1",
        config: { workStealing: true, backpressureLimit: 50 },
        createdAt: Date.now(),
      });
      store.createTeam({
        id: "t2",
        name: "B",
        leadSessionID: "s2",
        config: { workStealing: true, backpressureLimit: 50 },
        createdAt: Date.now(),
      });
      expect(store.listTeams()).toHaveLength(2);
    });

    test("updateTeam()", () => {
      const team = {
        id: "t1",
        name: "Old",
        leadSessionID: "s1",
        config: { workStealing: true, backpressureLimit: 50 },
        createdAt: Date.now(),
      };
      store.createTeam(team);
      store.updateTeam({ ...team, name: "New" });
      expect(store.getTeam("t1")!.name).toBe("New");
    });

    test("deleteTeam()", () => {
      store.createTeam({
        id: "t1",
        name: "A",
        leadSessionID: "s1",
        config: { workStealing: true, backpressureLimit: 50 },
        createdAt: Date.now(),
      });
      store.deleteTeam("t1");
      expect(store.getTeam("t1")).toBeUndefined();
    });
  });

  describe("Member CRUD", () => {
    test("create and get member", () => {
      const member = makeMember();
      store.createMember(member);
      const fetched = store.getMember(member.id);
      expect(fetched).toBeDefined();
      expect(fetched!.role).toBe("backend");
    });

    test("getMemberBySessionID()", () => {
      store.createMember(makeMember({ sessionID: "unique_sess" }));
      expect(store.getMemberBySessionID("unique_sess")).toBeDefined();
      expect(store.getMemberBySessionID("nonexistent")).toBeUndefined();
    });

    test("getMemberByRole()", () => {
      store.createMember(
        makeMember({ id: "m1", teamID: "t1", role: "frontend" })
      );
      store.createMember(
        makeMember({ id: "m2", teamID: "t1", role: "backend" })
      );
      expect(store.getMemberByRole("t1", "frontend")).toBeDefined();
      expect(store.getMemberByRole("t1", "devops")).toBeUndefined();
    });

    test("listMembers() filters by teamID", () => {
      store.createMember(makeMember({ id: "m1", teamID: "t1" }));
      store.createMember(makeMember({ id: "m2", teamID: "t1" }));
      store.createMember(makeMember({ id: "m3", teamID: "t2" }));
      expect(store.listMembers("t1")).toHaveLength(2);
      expect(store.listMembers("t2")).toHaveLength(1);
    });

    test("updateMember()", () => {
      const member = makeMember();
      store.createMember(member);
      store.updateMember({ ...member, state: "busy" });
      expect(store.getMember(member.id)!.state).toBe("busy");
    });

    test("deleteMember()", () => {
      const member = makeMember();
      store.createMember(member);
      store.deleteMember(member.id);
      expect(store.getMember(member.id)).toBeUndefined();
    });
  });

  describe("Task CRUD", () => {
    test("create and get task", () => {
      const task: Task = {
        id: "task_1",
        teamID: "t1",
        title: "Do thing",
        description: "desc",
        status: "available",
        dependsOn: [],
        tags: [],
        createdAt: Date.now(),
      };
      store.createTask(task);
      expect(store.getTask("task_1")).toBeDefined();
      expect(store.getTask("task_1")!.title).toBe("Do thing");
    });

    test("updateTask()", () => {
      const task: Task = {
        id: "task_1",
        teamID: "t1",
        title: "T",
        description: "d",
        status: "available",
        dependsOn: [],
        tags: [],
        createdAt: Date.now(),
      };
      store.createTask(task);
      store.updateTask({ ...task, status: "claimed", assignee: "m1" });
      const fetched = store.getTask("task_1")!;
      expect(fetched.status).toBe("claimed");
      expect(fetched.assignee).toBe("m1");
    });

    test("listTasks() filters by teamID", () => {
      store.createTask({
        id: "t1",
        teamID: "team_a",
        title: "A",
        description: "d",
        status: "available",
        dependsOn: [],
        tags: [],
        createdAt: Date.now(),
      });
      store.createTask({
        id: "t2",
        teamID: "team_b",
        title: "B",
        description: "d",
        status: "available",
        dependsOn: [],
        tags: [],
        createdAt: Date.now(),
      });
      expect(store.listTasks("team_a")).toHaveLength(1);
    });
  });

  describe("Messages", () => {
    test("addMessage and getTeamMessages()", () => {
      store.addMessage({
        id: "msg_1",
        teamID: "t1",
        from: "m1",
        to: "m2",
        content: "hello",
        delivered: false,
        createdAt: Date.now(),
      });
      const msgs = store.getTeamMessages("t1");
      expect(msgs).toHaveLength(1);
      expect(msgs[0].content).toBe("hello");
    });

    test("getUndeliveredMessages()", () => {
      store.addMessage({
        id: "msg_1",
        teamID: "t1",
        from: "m1",
        to: "m2",
        content: "unread",
        delivered: false,
        createdAt: Date.now(),
      });
      store.addMessage({
        id: "msg_2",
        teamID: "t1",
        from: "m1",
        to: "m2",
        content: "read",
        delivered: true,
        createdAt: Date.now(),
      });
      const undelivered = store.getUndeliveredMessages("m2");
      expect(undelivered).toHaveLength(1);
      expect(undelivered[0].content).toBe("unread");
    });

    test("markDelivered()", () => {
      store.addMessage({
        id: "msg_1",
        teamID: "t1",
        from: "m1",
        to: "m2",
        content: "pending",
        delivered: false,
        createdAt: Date.now(),
      });
      store.markDelivered("msg_1");
      expect(store.getUndeliveredMessages("m2")).toHaveLength(0);
    });
  });

  describe("Costs", () => {
    test("addCost and getMemberCost()", () => {
      store.addCost({
        memberID: "m1",
        teamID: "t1",
        sessionID: "s1",
        cost: 0.05,
        tokens: { input: 100, output: 50, reasoning: 10, cache: { read: 0, write: 0 } },
        timestamp: Date.now(),
      });
      store.addCost({
        memberID: "m1",
        teamID: "t1",
        sessionID: "s1",
        cost: 0.03,
        tokens: { input: 80, output: 40, reasoning: 5, cache: { read: 0, write: 0 } },
        timestamp: Date.now(),
      });
      expect(store.getMemberCost("m1")).toBeCloseTo(0.08);
    });

    test("getTeamCost()", () => {
      store.addCost({
        memberID: "m1",
        teamID: "t1",
        sessionID: "s1",
        cost: 0.05,
        tokens: { input: 100, output: 50, reasoning: 10, cache: { read: 0, write: 0 } },
        timestamp: Date.now(),
      });
      store.addCost({
        memberID: "m2",
        teamID: "t1",
        sessionID: "s2",
        cost: 0.10,
        tokens: { input: 200, output: 100, reasoning: 20, cache: { read: 0, write: 0 } },
        timestamp: Date.now(),
      });
      expect(store.getTeamCost("t1")).toBeCloseTo(0.15);
    });
  });

  describe("File locks (low-level)", () => {
    test("acquireLock() and getLock()", () => {
      const ok = store.acquireLock({
        path: "src/a.ts",
        memberID: "m1",
        teamID: "t1",
        acquiredAt: Date.now(),
      });
      expect(ok).toBe(true);
      expect(store.getLock("src/a.ts")).toBeDefined();
    });

    test("acquireLock() fails for different member", () => {
      store.acquireLock({
        path: "src/a.ts",
        memberID: "m1",
        teamID: "t1",
        acquiredAt: Date.now(),
      });
      const ok = store.acquireLock({
        path: "src/a.ts",
        memberID: "m2",
        teamID: "t1",
        acquiredAt: Date.now(),
      });
      expect(ok).toBe(false);
    });

    test("releaseLock()", () => {
      store.acquireLock({
        path: "src/a.ts",
        memberID: "m1",
        teamID: "t1",
        acquiredAt: Date.now(),
      });
      store.releaseLock("src/a.ts");
      expect(store.getLock("src/a.ts")).toBeUndefined();
    });

    test("releaseMemberLocks()", () => {
      store.acquireLock({ path: "a.ts", memberID: "m1", teamID: "t1", acquiredAt: Date.now() });
      store.acquireLock({ path: "b.ts", memberID: "m1", teamID: "t1", acquiredAt: Date.now() });
      store.acquireLock({ path: "c.ts", memberID: "m2", teamID: "t1", acquiredAt: Date.now() });
      store.releaseMemberLocks("m1");
      expect(store.getLock("a.ts")).toBeUndefined();
      expect(store.getLock("b.ts")).toBeUndefined();
      expect(store.getLock("c.ts")).toBeDefined();
    });

    test("getMemberLocks()", () => {
      store.acquireLock({ path: "a.ts", memberID: "m1", teamID: "t1", acquiredAt: Date.now() });
      store.acquireLock({ path: "b.ts", memberID: "m1", teamID: "t1", acquiredAt: Date.now() });
      expect(store.getMemberLocks("m1")).toHaveLength(2);
      expect(store.getMemberLocks("m2")).toHaveLength(0);
    });
  });

  describe("Scratchpad", () => {
    test("set and get", () => {
      store.scratchpadSet("t1", "notes", "hello world");
      expect(store.scratchpadGet("t1", "notes")).toBe("hello world");
    });

    test("returns undefined for missing key", () => {
      expect(store.scratchpadGet("t1", "nope")).toBeUndefined();
    });

    test("delete", () => {
      store.scratchpadSet("t1", "key", "val");
      store.scratchpadDelete("t1", "key");
      expect(store.scratchpadGet("t1", "key")).toBeUndefined();
    });

    test("list returns all entries", () => {
      store.scratchpadSet("t1", "a", "1");
      store.scratchpadSet("t1", "b", "2");
      const all = store.scratchpadList("t1");
      expect(all).toEqual({ a: "1", b: "2" });
    });

    test("list returns empty for unknown team", () => {
      expect(store.scratchpadList("unknown")).toEqual({});
    });
  });

  describe("Snapshot + replay", () => {
    test("data survives snapshot save + fresh store reload", async () => {
      // Populate state
      store.createTeam({
        id: "t1",
        name: "Alpha",
        leadSessionID: "s1",
        config: { workStealing: true, backpressureLimit: 50 },
        createdAt: Date.now(),
      });
      store.createMember(makeMember({ id: "m1", teamID: "t1", role: "backend" }));
      store.createTask({
        id: "task_1",
        teamID: "t1",
        title: "Persist",
        description: "d",
        status: "available",
        dependsOn: [],
        tags: [],
        createdAt: Date.now(),
      });
      store.acquireLock({ path: "x.ts", memberID: "m1", teamID: "t1", acquiredAt: Date.now() });
      store.scratchpadSet("t1", "key", "value");

      // Force a snapshot then destroy
      store.destroy();

      // Create a new store from the same dir
      const store2 = new Store(tmpDir);
      await store2.init();

      expect(store2.getTeam("t1")).toBeDefined();
      expect(store2.getTeam("t1")!.name).toBe("Alpha");
      expect(store2.getMember("m1")).toBeDefined();
      expect(store2.getMember("m1")!.role).toBe("backend");
      expect(store2.getTask("task_1")).toBeDefined();
      expect(store2.getTask("task_1")!.title).toBe("Persist");
      expect(store2.getLock("x.ts")).toBeDefined();
      expect(store2.scratchpadGet("t1", "key")).toBe("value");

      store2.destroy();
    });

    test("replays events written after snapshot timestamp", async () => {
      // Create initial data and snapshot
      store.createTeam({
        id: "t1",
        name: "Before",
        leadSessionID: "s1",
        config: { workStealing: true, backpressureLimit: 50 },
        createdAt: Date.now(),
      });
      store.destroy(); // saves snapshot

      // Now create a new store, add more data (events after snapshot)
      const store2 = new Store(tmpDir);
      await store2.init();

      // This will append to JSONL after the snapshot
      store2.createMember(makeMember({ id: "m_new", teamID: "t1", role: "new_role" }));
      store2.destroy(); // saves new snapshot

      // Third store should see everything
      const store3 = new Store(tmpDir);
      await store3.init();

      expect(store3.getTeam("t1")).toBeDefined();
      expect(store3.getMember("m_new")).toBeDefined();
      expect(store3.getMember("m_new")!.role).toBe("new_role");

      store3.destroy();
    });

    test("handles corrupt snapshot gracefully (starts fresh from JSONL)", async () => {
      // Create data — this writes to JSONL
      store.createTeam({
        id: "t1",
        name: "Good",
        leadSessionID: "s1",
        config: { workStealing: true, backpressureLimit: 50 },
        createdAt: Date.now(),
      });
      // Don't call destroy() — it would snapshot then compact JSONL.
      // Instead, write a corrupt snapshot directly alongside the existing JSONL.
      const snapPath = path.join(tmpDir, ".opencode", "plugin-orch", "snapshot.json");
      fs.writeFileSync(snapPath, "{bad json!!!}", "utf-8");

      // New store should skip corrupt snapshot and recover from JSONL
      const store2 = new Store(tmpDir);
      await store2.init();

      // Data was in JSONL, so it gets replayed (snapshot ts is 0 so all events replay)
      expect(store2.getTeam("t1")).toBeDefined();
      expect(store2.getTeam("t1")!.name).toBe("Good");

      store2.destroy();
    });

    test("handles empty snapshot file (zero bytes) gracefully", async () => {
      // Writes a zero-byte snapshot.json alongside a valid JSONL event —
      // simulates a crash during the very first saveSnapshot after the
      // tmp→rename fix was NOT in place. Loader must fall through to
      // replay instead of exploding on JSON.parse("").
      store.createTeam({
        id: "t1",
        name: "Empty",
        leadSessionID: "s1",
        config: { workStealing: true, backpressureLimit: 50 },
        createdAt: Date.now(),
      });
      const snapPath = path.join(tmpDir, ".opencode", "plugin-orch", "snapshot.json");
      fs.writeFileSync(snapPath, "", "utf-8");

      const store2 = new Store(tmpDir);
      await store2.init();

      expect(store2.getTeam("t1")).toBeDefined();
      expect(store2.getTeam("t1")!.name).toBe("Empty");
      store2.destroy();
    });

    test("migrates pre-feature snapshot members (lastActivityAt=0) to now", async () => {
      // Hand-write a snapshot with a member that predates the
      // lastActivityAt field. The loader should anchor it to Date.now()
      // so IdleMonitor's first sweep doesn't warn about every ready
      // member just because the field is missing.
      const snapPath = path.join(tmpDir, ".opencode", "plugin-orch", "snapshot.json");
      fs.mkdirSync(path.dirname(snapPath), { recursive: true });
      const ancientCreatedAt = Date.now() - 24 * 60 * 60 * 1000; // 1 day ago
      const snap = {
        timestamp: Date.now(),
        teams: {
          t1: {
            id: "t1",
            name: "Legacy",
            leadSessionID: "s1",
            config: { workStealing: true, backpressureLimit: 50 },
            createdAt: ancientCreatedAt,
          },
        },
        members: {
          m1: {
            id: "m1",
            teamID: "t1",
            sessionID: "sess_1",
            role: "worker",
            state: "ready",
            instructions: "legacy",
            files: [],
            escalationLevel: 0,
            retryCount: 0,
            createdAt: ancientCreatedAt,
            // lastActivityAt intentionally omitted — pre-feature snapshot
          },
        },
        tasks: {},
        messages: [],
        costs: {},
        locks: {},
        scratchpads: {},
      };
      fs.writeFileSync(snapPath, JSON.stringify(snap), "utf-8");

      const beforeLoad = Date.now();
      const store2 = new Store(tmpDir);
      await store2.init();
      const afterLoad = Date.now();

      const loaded = store2.getMember("m1");
      expect(loaded).toBeDefined();
      // lastActivityAt should be anchored to the load moment, not 0 or
      // the ancient createdAt.
      expect(loaded!.lastActivityAt).toBeGreaterThanOrEqual(beforeLoad);
      expect(loaded!.lastActivityAt).toBeLessThanOrEqual(afterLoad);
      // createdAt is preserved
      expect(loaded!.createdAt).toBe(ancientCreatedAt);

      store2.destroy();
    });

    test("migrates non-numeric lastActivityAt (e.g. corrupt string) to now", async () => {
      // A hand-edited / otherwise corrupt snapshot can land a non-number
      // in lastActivityAt. Falsy-only guard would miss this because a
      // truthy string is not falsy, and the loader would pass it through
      // — downstream `now - "bogus"` = NaN, and `NaN < timeout` is false,
      // so the idle monitor would silently never fire for this member.
      const snapPath = path.join(tmpDir, ".opencode", "plugin-orch", "snapshot.json");
      fs.mkdirSync(path.dirname(snapPath), { recursive: true });
      const now = Date.now();
      const snap = {
        timestamp: now,
        teams: {
          t1: {
            id: "t1",
            name: "Corrupt",
            leadSessionID: "s1",
            config: { workStealing: true, backpressureLimit: 50 },
            createdAt: now,
          },
        },
        members: {
          m1: {
            id: "m1",
            teamID: "t1",
            sessionID: "sess_1",
            role: "worker",
            state: "ready",
            instructions: "x",
            files: [],
            escalationLevel: 0,
            retryCount: 0,
            createdAt: now,
            lastActivityAt: "bogus" as unknown as number,
          },
        },
        tasks: {},
        messages: [],
        costs: {},
        locks: {},
        scratchpads: {},
      };
      fs.writeFileSync(snapPath, JSON.stringify(snap), "utf-8");

      const beforeLoad = Date.now();
      const store2 = new Store(tmpDir);
      await store2.init();
      const afterLoad = Date.now();

      const loaded = store2.getMember("m1");
      expect(loaded).toBeDefined();
      expect(typeof loaded!.lastActivityAt).toBe("number");
      expect(Number.isFinite(loaded!.lastActivityAt)).toBe(true);
      expect(loaded!.lastActivityAt).toBeGreaterThanOrEqual(beforeLoad);
      expect(loaded!.lastActivityAt).toBeLessThanOrEqual(afterLoad);

      store2.destroy();
    });

    test("handles snapshot with missing required fields gracefully", async () => {
      // Hand-edited / partially-written snapshot that parses as JSON but
      // is missing the maps loadSnapshot() destructures. Without the
      // state-reset in the catch block this leaves the store in a
      // half-populated state. Verify the event log still wins.
      store.createTeam({
        id: "t1",
        name: "Malformed",
        leadSessionID: "s1",
        config: { workStealing: true, backpressureLimit: 50 },
        createdAt: Date.now(),
      });
      const snapPath = path.join(tmpDir, ".opencode", "plugin-orch", "snapshot.json");
      fs.writeFileSync(snapPath, JSON.stringify({ timestamp: 1 }), "utf-8");

      const store2 = new Store(tmpDir);
      await store2.init();

      expect(store2.getTeam("t1")).toBeDefined();
      expect(store2.getTeam("t1")!.name).toBe("Malformed");
      expect(store2.listTeams()).toHaveLength(1);
      store2.destroy();
    });

    test("replay skips a truncated trailing JSONL line", async () => {
      // Write a valid event followed by a partial JSON line — simulates
      // a crash mid-appendFileSync. The per-line try/catch in
      // replayEvents() must skip the bad tail and still replay the
      // good head.
      const jsonlDir = path.join(tmpDir, ".opencode", "plugin-orch");
      fs.mkdirSync(jsonlDir, { recursive: true });
      const teamsPath = path.join(jsonlDir, "teams.jsonl");
      const goodEvent = JSON.stringify({
        type: "team.created",
        timestamp: Date.now(),
        data: {
          id: "t1",
          name: "Trunc",
          leadSessionID: "s1",
          config: { workStealing: true, backpressureLimit: 50 },
          createdAt: Date.now(),
        },
      });
      // Valid line + newline + partial (no newline, unterminated braces)
      fs.writeFileSync(teamsPath, `${goodEvent}\n{"type":"team.crea`, "utf-8");

      const store2 = new Store(tmpDir);
      await store2.init();
      expect(store2.getTeam("t1")).toBeDefined();
      expect(store2.getTeam("t1")!.name).toBe("Trunc");
      store2.destroy();
    });

    test("replay skips a mid-file corrupt JSONL line and keeps earlier+later lines", async () => {
      // Three events written to teams.jsonl: the middle one is garbage.
      // replayEvents() should skip the middle and apply the outer two.
      const jsonlDir = path.join(tmpDir, ".opencode", "plugin-orch");
      fs.mkdirSync(jsonlDir, { recursive: true });
      const teamsPath = path.join(jsonlDir, "teams.jsonl");
      const now = Date.now();
      const e1 = JSON.stringify({
        type: "team.created",
        timestamp: now,
        data: {
          id: "t_first",
          name: "First",
          leadSessionID: "s1",
          config: { workStealing: true, backpressureLimit: 50 },
          createdAt: now,
        },
      });
      const e3 = JSON.stringify({
        type: "team.created",
        timestamp: now + 2,
        data: {
          id: "t_third",
          name: "Third",
          leadSessionID: "s3",
          config: { workStealing: true, backpressureLimit: 50 },
          createdAt: now + 2,
        },
      });
      fs.writeFileSync(teamsPath, `${e1}\n{not json at all}\n${e3}\n`, "utf-8");

      const store2 = new Store(tmpDir);
      await store2.init();
      expect(store2.getTeam("t_first")).toBeDefined();
      expect(store2.getTeam("t_third")).toBeDefined();
      expect(store2.listTeams()).toHaveLength(2);
      store2.destroy();
    });

    test("saveSnapshot uses atomic tmp+rename (no partial file visible)", async () => {
      // Observability test for the tmp+rename fix: after a saveSnapshot,
      // there should be no lingering `snapshot.json.tmp` and the real
      // snapshot.json should be readable + valid JSON.
      store.createTeam({
        id: "t1",
        name: "Atomic",
        leadSessionID: "s1",
        config: { workStealing: true, backpressureLimit: 50 },
        createdAt: Date.now(),
      });
      store.destroy(); // triggers saveSnapshot

      const snapDir = path.join(tmpDir, ".opencode", "plugin-orch");
      const snapPath = path.join(snapDir, "snapshot.json");
      const tmpPath = path.join(snapDir, "snapshot.json.tmp");

      expect(fs.existsSync(snapPath)).toBe(true);
      expect(fs.existsSync(tmpPath)).toBe(false);
      const raw = fs.readFileSync(snapPath, "utf-8");
      const parsed = JSON.parse(raw);
      expect(parsed.teams.t1.name).toBe("Atomic");
    });
  });
});
