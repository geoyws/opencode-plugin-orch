import * as fs from "node:fs";
import * as path from "node:path";
import type {
  GoalState,
  Run,
  StepState,
  Snapshot,
  StoreEvent,
} from "./schemas.js";

const SNAPSHOT_INTERVAL_MS = 30_000;
const EVENTS_FILE = "runs.jsonl";

let idCounter = 0;
export function genID(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${(++idCounter).toString(36)}`;
}

// Event-sourced run/step state. One JSONL log (runs.jsonl) holds all seven
// event types; snapshot.json is a fast-path compacted view. The log is the
// source of truth — a corrupt snapshot is never fatal.
export class Store {
  private dir: string;
  private runs = new Map<string, Run>();
  private goals = new Map<string, GoalState>();
  private snapshotTimer: ReturnType<typeof setInterval> | null = null;
  private lastSnapshotTs = 0;
  // Step sessions of runs that were left `running` across a restart,
  // collected by init() before those runs are marked failed. The plugin
  // aborts + deletes them best-effort (they may still be burning tokens).
  readonly interruptedSessions: Array<{ sessionID: string }> = [];

  constructor(projectDir: string) {
    this.dir = path.join(projectDir, ".opencode", "plugin-orch");
  }

  // ── Init & Recovery ───────────────────────────────────────────────
  async init(): Promise<void> {
    fs.mkdirSync(this.dir, { recursive: true });

    // Try to load snapshot. Falls back to fresh state on any failure
    // (empty file, invalid JSON, missing fields) — the JSONL event log is
    // the source of truth and the snapshot is just a fast-path. A corrupt
    // snapshot is never fatal, but we log it so operators know their
    // fast-path is broken.
    const snapPath = path.join(this.dir, "snapshot.json");
    if (fs.existsSync(snapPath)) {
      try {
        const raw = fs.readFileSync(snapPath, "utf-8");
        if (raw.length === 0) throw new Error("snapshot is empty");
        const snap = JSON.parse(raw) as Snapshot;
        this.runs = new Map(Object.entries(snap.runs));
        this.goals = new Map(Object.entries(snap.goals ?? {}));
        this.lastSnapshotTs = snap.timestamp ?? 0;
      } catch (err) {
        console.error(
          `[orch] snapshot.json at ${snapPath} is corrupt, starting fresh: ${
            (err as Error).message
          }`
        );
        // Reset partial state in case the load threw mid-assignment.
        this.runs = new Map();
        this.goals = new Map();
        this.lastSnapshotTs = 0;
      }
    }

    // Replay JSONL events after snapshot timestamp
    await this.replayEvents();

    // Interrupted runs recover as paused. Completed steps remain authoritative;
    // only in-flight steps become cancelled and can be retried by Runner.resume.
    // This creates a safe, explicit restart boundary and avoids spending tokens
    // until an operator/model resumes the run.
    for (const run of [...this.runs.values()]) {
      if (run.status === "running" || run.status === "paused") {
        for (const step of Object.values(run.steps)) {
          if (step.sessionID) {
            this.interruptedSessions.push({ sessionID: step.sessionID });
          }
          if (step.status === "running") {
            this.failStep(run.id, {
              ...step,
              status: "cancelled",
              error: "plugin restarted before step completion",
              completedAt: Date.now(),
            });
          }
        }
        if (run.status === "running") this.pauseRun(run.id);
      }
    }

    // Keep the operator-facing view current even when no recovery event was
    // emitted. Unlike snapshot.json, this does not compact the event log.
    this.saveReadModel();

    // Start periodic snapshot
    this.snapshotTimer = setInterval(() => this.saveSnapshot(), SNAPSHOT_INTERVAL_MS);
  }

  destroy(): void {
    if (this.snapshotTimer) {
      clearInterval(this.snapshotTimer);
      this.snapshotTimer = null;
    }
    this.saveSnapshot();
  }

  private saveSnapshot(): void {
    const snap = this.currentSnapshot();
    // Atomic snapshot write: write to a temp file then rename. If the
    // process dies mid-write, the old snapshot.json is untouched and
    // the next init reads it cleanly. Without this, a crash during
    // writeFileSync could leave snapshot.json truncated/empty and the
    // loader would silently start fresh — losing everything the JSONL
    // log had already compacted away on the previous saveSnapshot.
    const snapPath = path.join(this.dir, "snapshot.json");
    const tmpPath = `${snapPath}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(snap), "utf-8");
    fs.renameSync(tmpPath, snapPath);
    this.lastSnapshotTs = snap.timestamp;
    this.compactLogs();
  }

  private currentSnapshot(): Snapshot {
    return {
      timestamp: Date.now(),
      runs: Object.fromEntries(this.runs),
      goals: Object.fromEntries(this.goals),
    };
  }

  private saveReadModel(): void {
    const viewPath = path.join(this.dir, "view.json");
    const tmpPath = `${viewPath}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(this.currentSnapshot()), "utf-8");
    fs.renameSync(tmpPath, viewPath);
  }

  private compactLogs(): void {
    const fp = path.join(this.dir, EVENTS_FILE);
    if (fs.existsSync(fp)) {
      fs.writeFileSync(fp, "", "utf-8");
    }
  }

  private async replayEvents(): Promise<void> {
    const fp = path.join(this.dir, EVENTS_FILE);
    if (!fs.existsSync(fp)) return;
    const events: StoreEvent[] = [];
    const lines = fs.readFileSync(fp, "utf-8").split("\n").filter(Boolean);
    for (const line of lines) {
      try {
        const evt: StoreEvent = JSON.parse(line);
        if (evt.timestamp > this.lastSnapshotTs) {
          events.push(evt);
        }
      } catch {
        // skip malformed lines
      }
    }
    // Sort by timestamp and replay
    events.sort((a, b) => a.timestamp - b.timestamp);
    for (const evt of events) {
      this.applyEvent(evt);
    }
  }

  private applyEvent(evt: StoreEvent): void {
    const d = evt.data as Record<string, unknown>;
    switch (evt.type) {
      case "run_created": {
        const run = d as unknown as Run;
        this.runs.set(run.id, run);
        break;
      }
      case "step_started":
      case "step_completed":
      case "step_failed": {
        const run = this.runs.get(d.runID as string);
        // Steps of a finished/cancelled run are ignored — a parallel branch
        // or timed-out session may still report after the run ended.
        if (!run || !this.runAcceptsStepEvents(run)) break;
        const step = d.step as StepState;
        const updated: Run = {
          ...run,
          steps: { ...run.steps, [step.id]: step },
          iteration:
            typeof d.iteration === "number" ? (d.iteration as number) : run.iteration,
        };
        this.runs.set(run.id, updated);
        break;
      }
      case "run_completed": {
        const run = this.runs.get(d.runID as string);
        if (!run || !this.runAcceptsStepEvents(run)) break;
        this.runs.set(run.id, {
          ...run,
          status: "completed",
          output: d.output as string,
          note: (d.note as string | undefined) ?? run.note,
          completedAt: d.completedAt as number,
        });
        break;
      }
      case "run_failed": {
        const run = this.runs.get(d.runID as string);
        if (!run || !this.runAcceptsStepEvents(run)) break;
        this.runs.set(run.id, {
          ...run,
          status: "failed",
          error: d.error as string,
          completedAt: d.completedAt as number,
        });
        break;
      }
      case "run_cancelled": {
        const run = this.runs.get(d.runID as string);
        if (!run || !this.runAcceptsStepEvents(run)) break;
        this.runs.set(run.id, {
          ...run,
          status: "cancelled",
          completedAt: d.completedAt as number,
        });
        break;
      }
      case "run_paused": {
        const run = this.runs.get(d.runID as string);
        if (!run || run.status !== "running") break;
        this.runs.set(run.id, { ...run, status: "paused" });
        break;
      }
      case "run_resumed": {
        const run = this.runs.get(d.runID as string);
        if (!run || run.status !== "paused") break;
        this.runs.set(run.id, { ...run, status: "running" });
        break;
      }
      case "run_budget_exhausted": {
        const run = this.runs.get(d.runID as string);
        if (!run || !this.runAcceptsStepEvents(run)) break;
        this.runs.set(run.id, {
          ...run,
          status: "budget_exhausted",
          error: d.reason as string,
          completedAt: d.completedAt as number,
        });
        break;
      }
      case "run_retrying": {
        const run = this.runs.get(d.runID as string);
        if (
          !run ||
          !["failed", "cancelled"].includes(run.status)
        ) break;
        this.runs.set(run.id, {
          ...run,
          status: "paused",
          error: undefined,
          completedAt: undefined,
        });
        break;
      }
      case "goal_set":
      case "goal_updated":
      case "goal_resolved": {
        const goal = d.goal as unknown as GoalState;
        this.goals.set(goal.sessionID, goal);
        break;
      }
    }
  }

  private runAcceptsStepEvents(run: Run): boolean {
    return run.status === "running" || run.status === "paused";
  }

  // ── Event Persistence ─────────────────────────────────────────────
  private appendEvent(type: string, data: unknown): void {
    const evt: StoreEvent = { type, timestamp: Date.now(), data };
    const fp = path.join(this.dir, EVENTS_FILE);
    fs.appendFileSync(fp, JSON.stringify(evt) + "\n", "utf-8");
    this.applyEvent(evt);
    this.saveReadModel();
  }

  // ── Run mutations ─────────────────────────────────────────────────
  createRun(run: Run): void {
    this.appendEvent("run_created", run);
  }

  startStep(runID: string, step: StepState, iteration?: number): void {
    this.appendEvent("step_started", { runID, step, iteration });
  }

  completeStep(runID: string, step: StepState): void {
    this.appendEvent("step_completed", { runID, step });
  }

  failStep(runID: string, step: StepState): void {
    this.appendEvent("step_failed", { runID, step });
  }

  completeRun(runID: string, output: string, note?: string): void {
    this.appendEvent("run_completed", { runID, output, note, completedAt: Date.now() });
  }

  failRun(runID: string, error: string): void {
    this.appendEvent("run_failed", { runID, error, completedAt: Date.now() });
  }

  cancelRun(runID: string): void {
    this.appendEvent("run_cancelled", { runID, completedAt: Date.now() });
  }

  pauseRun(runID: string): void {
    this.appendEvent("run_paused", { runID });
  }

  resumeRun(runID: string): void {
    this.appendEvent("run_resumed", { runID });
  }

  exhaustRunBudget(runID: string, reason: string): void {
    this.appendEvent("run_budget_exhausted", {
      runID,
      reason,
      completedAt: Date.now(),
    });
  }

  retryRun(runID: string): void {
    this.appendEvent("run_retrying", { runID });
  }

  setGoal(goal: GoalState): void {
    this.appendEvent("goal_set", { goal });
  }

  updateGoal(goal: GoalState): void {
    this.appendEvent("goal_updated", { goal });
  }

  resolveGoal(goal: GoalState): void {
    this.appendEvent("goal_resolved", { goal });
  }

  // ── Queries ───────────────────────────────────────────────────────
  getRun(id: string): Run | undefined {
    return this.runs.get(id);
  }

  // Resolve a run by exact id or unique id prefix. Throws on ambiguity so
  // the caller can show the candidate ids.
  findRun(idOrPrefix: string): Run | undefined {
    const exact = this.runs.get(idOrPrefix);
    if (exact) return exact;
    const matches = [...this.runs.values()].filter((r) => r.id.startsWith(idOrPrefix));
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) {
      const ids = matches
        .sort((a, b) => b.createdAt - a.createdAt)
        .map((r) => r.id)
        .join(", ");
      throw new Error(`run id prefix "${idOrPrefix}" is ambiguous (matches: ${ids})`);
    }
    return undefined;
  }

  listRuns(): Run[] {
    return [...this.runs.values()].sort((a, b) => b.createdAt - a.createdAt);
  }

  getGoal(sessionID: string): GoalState | undefined {
    return this.goals.get(sessionID);
  }

  listGoals(): GoalState[] {
    return [...this.goals.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  }
}
