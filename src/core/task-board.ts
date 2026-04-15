import type { PluginInput } from "@opencode-ai/plugin";
import type { Store } from "../state/store.js";
import type { Task, TaskStatus } from "../state/schemas.js";
import { genID } from "./team-manager.js";

export class TaskBoard {
  constructor(
    private store: Store,
    private ctx: PluginInput
  ) {}

  addTask(teamID: string, title: string, description: string, opts?: {
    dependsOn?: string[];
    tags?: string[];
    priority?: number;
  }): Task {
    // Validate that all dependency IDs reference existing tasks
    if (opts?.dependsOn) {
      for (const depID of opts.dependsOn) {
        if (!this.store.getTask(depID)) {
          throw new Error(`Dependency task "${depID}" does not exist`);
        }
      }
    }

    const task: Task = {
      id: genID("task"),
      teamID,
      title,
      description,
      status: "available",
      dependsOn: opts?.dependsOn ?? [],
      tags: opts?.tags ?? [],
      priority: opts?.priority ?? 0,
      version: 0,
      createdAt: Date.now(),
    };

    // Check for circular dependencies before persisting
    if (opts?.dependsOn && opts.dependsOn.length > 0) {
      if (this.detectCycle(task.id, opts.dependsOn)) {
        throw new Error(`Adding task "${title}" would create a circular dependency`);
      }
    }

    this.store.createTask(task);
    return task;
  }

  claim(taskID: string, memberID: string): Task {
    const task = this.store.getTask(taskID);
    if (!task) throw new Error(`Task ${taskID} not found`);
    if (task.status !== "available") {
      throw new Error(`Task "${task.title}" is ${task.status}, cannot claim`);
    }

    // Check dependencies are met
    if (!this.areDependenciesMet(task)) {
      throw new Error(
        `Task "${task.title}" has unmet dependencies: ${task.dependsOn.join(", ")}`
      );
    }

    // CAS: atomically check version and update
    const updated: Task = { ...task, status: "claimed", assignee: memberID, version: task.version + 1 };
    if (!this.store.compareAndUpdateTask(task.id, task.version, updated)) {
      throw new Error(`Task "${task.title}" was modified concurrently`);
    }
    return updated;
  }

  complete(taskID: string, result: string): Task {
    const task = this.store.getTask(taskID);
    if (!task) throw new Error(`Task ${taskID} not found`);
    if (task.status !== "claimed") {
      throw new Error(`Task "${task.title}" is ${task.status}, cannot complete`);
    }

    // CAS: atomically check version and update
    const updated: Task = {
      ...task,
      status: "completed",
      result,
      version: task.version + 1,
      completedAt: Date.now(),
    };
    if (!this.store.compareAndUpdateTask(task.id, task.version, updated)) {
      throw new Error(`Task "${task.title}" was modified concurrently`);
    }

    // Auto-unblock dependents
    this.unblockDependents(task.id);

    return updated;
  }

  reassign(taskID: string, memberID: string): Task {
    const task = this.store.getTask(taskID);
    if (!task) throw new Error(`Task ${taskID} not found`);
    if (task.status !== "claimed") {
      throw new Error(
        `Task "${task.title}" is ${task.status}, only claimed tasks can be reassigned`
      );
    }
    const updated: Task = { ...task, assignee: memberID, version: task.version + 1 };
    if (!this.store.compareAndUpdateTask(task.id, task.version, updated)) {
      throw new Error(`Task "${task.title}" was modified concurrently`);
    }
    return updated;
  }

  unblock(taskID: string): { task: Task; cleared: number } {
    const task = this.store.getTask(taskID);
    if (!task) throw new Error(`Task ${taskID} not found`);
    if (task.status !== "available") {
      throw new Error(
        `Task "${task.title}" is ${task.status}, only available tasks can be unblocked`
      );
    }
    const cleared = task.dependsOn.length;
    const updated: Task = { ...task, dependsOn: [], version: task.version + 1 };
    if (!this.store.compareAndUpdateTask(task.id, task.version, updated)) {
      throw new Error(`Task "${task.title}" was modified concurrently`);
    }
    return { task: updated, cleared };
  }

  fail(taskID: string, reason: string): Task {
    const task = this.store.getTask(taskID);
    if (!task) throw new Error(`Task ${taskID} not found`);

    // CAS: atomically check version and update
    const updated: Task = {
      ...task,
      status: "failed",
      result: `FAILED: ${reason}`,
      version: task.version + 1,
      completedAt: Date.now(),
    };
    if (!this.store.compareAndUpdateTask(task.id, task.version, updated)) {
      throw new Error(`Task "${task.title}" was modified concurrently`);
    }
    return updated;
  }

  listTasks(teamID: string, filter?: TaskStatus): Task[] {
    const tasks = this.store.listTasks(teamID);
    if (filter) return tasks.filter((t) => t.status === filter);
    return tasks;
  }

  // ── Cycle detection ───────────────────────────────────────────────
  private detectCycle(taskID: string, dependsOn: string[]): boolean {
    const visited = new Set<string>();
    const stack = [...dependsOn];
    while (stack.length > 0) {
      const current = stack.pop()!;
      if (current === taskID) return true;
      if (visited.has(current)) continue;
      visited.add(current);
      const task = this.store.getTask(current);
      if (task) {
        stack.push(...task.dependsOn);
      }
    }
    return false;
  }

  // ── Dependency resolution ─────────────────────────────────────────
  areDependenciesMet(task: Task): boolean {
    if (task.dependsOn.length === 0) return true;
    return task.dependsOn.every((depID) => {
      const dep = this.store.getTask(depID);
      return dep?.status === "completed";
    });
  }

  private unblockDependents(completedTaskID: string): void {
    // Nothing to actively do — tasks check deps at claim time
    // This is a hook point for future notifications
  }

  // ── Work stealing ─────────────────────────────────────────────────
  getAvailableForStealing(teamID: string): Task[] {
    return this.store
      .listTasks(teamID)
      .filter((t) => t.status === "available" && this.areDependenciesMet(t))
      .sort((a, b) => {
        const pa = a.priority ?? 0;
        const pb = b.priority ?? 0;
        if (pa !== pb) return pb - pa;
        return a.createdAt - b.createdAt;
      });
  }

  scoreTaskForMember(task: Task, memberRole: string): number {
    let score = 1;
    // Boost if task tags match role keywords
    for (const tag of task.tags) {
      if (memberRole.toLowerCase().includes(tag.toLowerCase())) score += 2;
      if (tag.toLowerCase().includes(memberRole.toLowerCase())) score += 2;
    }
    // Priority dominates role-match so a p=1 task always outranks a p=0 task.
    score += (task.priority ?? 0) * 1000;
    return score;
  }

  stealTask(teamID: string, memberID: string, memberRole: string): Task | null {
    const available = this.getAvailableForStealing(teamID);
    if (available.length === 0) return null;

    // Score and pick best match
    const scored = available
      .map((t) => ({ task: t, score: this.scoreTaskForMember(t, memberRole) }))
      .sort((a, b) => b.score - a.score);

    try {
      return this.claim(scored[0].task.id, memberID);
    } catch {
      return null;
    }
  }
}
