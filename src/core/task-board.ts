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
  }): Task {
    const task: Task = {
      id: genID("task"),
      teamID,
      title,
      description,
      status: "available",
      dependsOn: opts?.dependsOn ?? [],
      tags: opts?.tags ?? [],
      createdAt: Date.now(),
    };
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

    const updated: Task = { ...task, status: "claimed", assignee: memberID };
    this.store.updateTask(updated);
    return updated;
  }

  complete(taskID: string, result: string): Task {
    const task = this.store.getTask(taskID);
    if (!task) throw new Error(`Task ${taskID} not found`);
    if (task.status !== "claimed") {
      throw new Error(`Task "${task.title}" is ${task.status}, cannot complete`);
    }

    const updated: Task = {
      ...task,
      status: "completed",
      result,
      completedAt: Date.now(),
    };
    this.store.updateTask(updated);

    // Auto-unblock dependents
    this.unblockDependents(task.id);

    return updated;
  }

  fail(taskID: string, reason: string): Task {
    const task = this.store.getTask(taskID);
    if (!task) throw new Error(`Task ${taskID} not found`);

    const updated: Task = {
      ...task,
      status: "failed",
      result: `FAILED: ${reason}`,
      completedAt: Date.now(),
    };
    this.store.updateTask(updated);
    return updated;
  }

  listTasks(teamID: string, filter?: TaskStatus): Task[] {
    const tasks = this.store.listTasks(teamID);
    if (filter) return tasks.filter((t) => t.status === filter);
    return tasks;
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
      .filter((t) => t.status === "available" && this.areDependenciesMet(t));
  }

  scoreTaskForMember(task: Task, memberRole: string): number {
    let score = 1;
    // Boost if task tags match role keywords
    for (const tag of task.tags) {
      if (memberRole.toLowerCase().includes(tag.toLowerCase())) score += 2;
      if (tag.toLowerCase().includes(memberRole.toLowerCase())) score += 2;
    }
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
