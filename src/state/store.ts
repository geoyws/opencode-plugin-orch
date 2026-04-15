import * as fs from "node:fs";
import * as path from "node:path";
import type {
  Team,
  Member,
  Task,
  TeamMessage,
  CostEntry,
  FileLock,
  Snapshot,
  StoreEvent,
} from "./schemas.js";

const SNAPSHOT_INTERVAL_MS = 30_000;

export class Store {
  private dir: string;
  private teams = new Map<string, Team>();
  private members = new Map<string, Member>();
  private tasks = new Map<string, Task>();
  private messages: TeamMessage[] = [];
  private costs: CostEntry[] = [];
  private locks = new Map<string, FileLock>();
  private scratchpads = new Map<string, Map<string, string>>();
  private snapshotTimer: ReturnType<typeof setInterval> | null = null;
  private lastSnapshotTs = 0;

  constructor(projectDir: string) {
    this.dir = path.join(projectDir, ".opencode", "plugin-orch");
  }

  // ── Init & Recovery ───────────────────────────────────────────────
  async init(): Promise<void> {
    fs.mkdirSync(this.dir, { recursive: true });

    // Try to load snapshot. Falls back to fresh state on any failure
    // (empty file, invalid JSON, missing required fields, etc.) — the
    // JSONL event logs are the source of truth and the snapshot is just
    // a fast-path. A corrupt snapshot is never fatal, but we log it so
    // operators know their fast-path is broken.
    const snapPath = path.join(this.dir, "snapshot.json");
    if (fs.existsSync(snapPath)) {
      try {
        const raw = fs.readFileSync(snapPath, "utf-8");
        if (raw.length === 0) throw new Error("snapshot is empty");
        const snap: Snapshot = JSON.parse(raw);
        this.loadSnapshot(snap);
        this.lastSnapshotTs = snap.timestamp ?? 0;
      } catch (err) {
        console.error(
          `[orch] snapshot.json at ${snapPath} is corrupt, starting fresh: ${
            (err as Error).message
          }`
        );
        // Reset partial state in case loadSnapshot threw mid-assignment.
        this.teams = new Map();
        this.members = new Map();
        this.tasks = new Map();
        this.messages = [];
        this.costs = [];
        this.locks = new Map();
        this.scratchpads = new Map();
        this.lastSnapshotTs = 0;
      }
    }

    // Replay JSONL events after snapshot timestamp
    await this.replayEvents();

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

  private loadSnapshot(snap: Snapshot): void {
    this.teams = new Map(Object.entries(snap.teams));
    // One-shot migration: pre-feature snapshots have members without a
    // lastActivityAt field. Anchor them to "now" on load so the idle
    // monitor's first sweep doesn't warn about every ready member just
    // because their activity timestamp is missing.
    const nowTs = Date.now();
    this.members = new Map(
      Object.entries(snap.members).map(([id, m]) => {
        if (!m.lastActivityAt || m.lastActivityAt === 0) {
          return [id, { ...m, lastActivityAt: nowTs }];
        }
        return [id, m];
      })
    );
    this.tasks = new Map(Object.entries(snap.tasks));
    this.messages = snap.messages;
    this.costs = snap.costs;
    this.locks = new Map(Object.entries(snap.locks));
    this.scratchpads = new Map(
      Object.entries(snap.scratchpads).map(([k, v]) => [k, new Map(Object.entries(v))])
    );
  }

  private saveSnapshot(): void {
    const snap: Snapshot = {
      timestamp: Date.now(),
      teams: Object.fromEntries(this.teams),
      members: Object.fromEntries(this.members),
      tasks: Object.fromEntries(this.tasks),
      messages: this.messages,
      costs: this.costs,
      locks: Object.fromEntries(this.locks),
      scratchpads: Object.fromEntries(
        [...this.scratchpads.entries()].map(([k, v]) => [k, Object.fromEntries(v)])
      ),
    };
    // Atomic snapshot write: write to a temp file then rename. If the
    // process dies mid-write, the old snapshot.json is untouched and
    // the next init reads it cleanly. Without this, a crash during
    // writeFileSync could leave snapshot.json truncated/empty and the
    // loader would silently start fresh — losing everything the JSONL
    // logs had already compacted away on the previous saveSnapshot.
    const snapPath = path.join(this.dir, "snapshot.json");
    const tmpPath = `${snapPath}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(snap), "utf-8");
    fs.renameSync(tmpPath, snapPath);
    this.lastSnapshotTs = snap.timestamp;
    this.compactLogs();
  }

  private compactLogs(): void {
    const files = ["teams.jsonl", "members.jsonl", "tasks.jsonl", "messages.jsonl", "costs.jsonl", "locks.jsonl"];
    for (const file of files) {
      const fp = path.join(this.dir, file);
      if (fs.existsSync(fp)) {
        fs.writeFileSync(fp, "", "utf-8");
      }
    }
  }

  private async replayEvents(): Promise<void> {
    const files = [
      "teams.jsonl",
      "members.jsonl",
      "tasks.jsonl",
      "messages.jsonl",
      "costs.jsonl",
      "locks.jsonl",
    ];
    const events: StoreEvent[] = [];
    for (const file of files) {
      const fp = path.join(this.dir, file);
      if (!fs.existsSync(fp)) continue;
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
      case "team.created":
      case "team.updated":
        this.teams.set((d as Team).id, d as Team);
        break;
      case "team.deleted":
        this.teams.delete(d.id as string);
        break;
      case "member.created":
      case "member.updated":
        this.members.set((d as Member).id, d as Member);
        break;
      case "member.deleted":
        this.members.delete(d.id as string);
        break;
      case "task.created":
      case "task.updated":
        this.tasks.set((d as Task).id, d as Task);
        break;
      case "task.deleted":
        this.tasks.delete(d.id as string);
        break;
      case "message.created":
        this.messages.push(d as TeamMessage);
        break;
      case "message.delivered": {
        const msg = this.messages.find((m) => m.id === (d.id as string));
        if (msg) msg.delivered = true;
        break;
      }
      case "cost.added":
        this.costs.push(d as CostEntry);
        break;
      case "lock.acquired":
        this.locks.set((d as FileLock).path, d as FileLock);
        break;
      case "lock.released":
        this.locks.delete(d.path as string);
        break;
      case "scratchpad.set": {
        const teamID = d.teamID as string;
        const key = d.key as string;
        const value = d.value as string;
        if (!this.scratchpads.has(teamID)) this.scratchpads.set(teamID, new Map());
        this.scratchpads.get(teamID)!.set(key, value);
        break;
      }
      case "scratchpad.delete": {
        const teamID = d.teamID as string;
        const key = d.key as string;
        this.scratchpads.get(teamID)?.delete(key);
        break;
      }
    }
  }

  // ── Event Persistence ─────────────────────────────────────────────
  private appendEvent(file: string, type: string, data: unknown): void {
    const evt: StoreEvent = { type, timestamp: Date.now(), data };
    const fp = path.join(this.dir, file);
    fs.appendFileSync(fp, JSON.stringify(evt) + "\n", "utf-8");
    this.applyEvent(evt);
  }

  // ── Team CRUD ─────────────────────────────────────────────────────
  createTeam(team: Team): void {
    this.appendEvent("teams.jsonl", "team.created", team);
  }

  updateTeam(team: Team): void {
    this.appendEvent("teams.jsonl", "team.updated", team);
  }

  deleteTeam(id: string): void {
    this.appendEvent("teams.jsonl", "team.deleted", { id });
  }

  updateTeamInboxSeen(teamID: string, timestamp: number): void {
    const team = this.teams.get(teamID);
    if (!team) return;
    const updated: Team = { ...team, leadInboxLastSeenAt: timestamp };
    this.appendEvent("teams.jsonl", "team.updated", updated);
  }

  getTeam(id: string): Team | undefined {
    return this.teams.get(id);
  }

  getTeamByName(name: string): Team | undefined {
    for (const t of this.teams.values()) {
      if (t.name === name) return t;
    }
    return undefined;
  }

  listTeams(): Team[] {
    return [...this.teams.values()];
  }

  // ── Member CRUD ───────────────────────────────────────────────────
  createMember(member: Member): void {
    this.appendEvent("members.jsonl", "member.created", member);
  }

  updateMember(member: Member): void {
    this.appendEvent("members.jsonl", "member.updated", member);
  }

  deleteMember(id: string): void {
    this.appendEvent("members.jsonl", "member.deleted", { id });
  }

  getMember(id: string): Member | undefined {
    return this.members.get(id);
  }

  getMemberBySessionID(sessionID: string): Member | undefined {
    for (const m of this.members.values()) {
      if (m.sessionID === sessionID) return m;
    }
    return undefined;
  }

  getMemberByRole(teamID: string, role: string): Member | undefined {
    for (const m of this.members.values()) {
      if (m.teamID === teamID && m.role === role) return m;
    }
    return undefined;
  }

  listMembers(teamID: string): Member[] {
    return [...this.members.values()].filter((m) => m.teamID === teamID);
  }

  // ── Task CRUD ─────────────────────────────────────────────────────
  createTask(task: Task): void {
    this.appendEvent("tasks.jsonl", "task.created", task);
  }

  updateTask(task: Task): void {
    this.appendEvent("tasks.jsonl", "task.updated", task);
  }

  compareAndUpdateTask(id: string, expectedVersion: number, updated: Task): boolean {
    const current = this.tasks.get(id);
    if (!current || current.version !== expectedVersion) return false;
    this.appendEvent("tasks.jsonl", "task.updated", updated);
    return true;
  }

  getTask(id: string): Task | undefined {
    return this.tasks.get(id);
  }

  listTasks(teamID: string): Task[] {
    return [...this.tasks.values()].filter((t) => t.teamID === teamID);
  }

  // ── Messages ──────────────────────────────────────────────────────
  addMessage(msg: TeamMessage): void {
    this.appendEvent("messages.jsonl", "message.created", msg);
  }

  getUndeliveredMessages(memberID: string): TeamMessage[] {
    return this.messages.filter((m) => m.to === memberID && !m.delivered);
  }

  markDelivered(messageID: string): void {
    this.appendEvent("messages.jsonl", "message.delivered", { id: messageID });
  }

  getTeamMessages(teamID: string): TeamMessage[] {
    return this.messages.filter((m) => m.teamID === teamID);
  }

  // ── Costs ─────────────────────────────────────────────────────────
  addCost(entry: CostEntry): void {
    this.appendEvent("costs.jsonl", "cost.added", entry);
  }

  getMemberCost(memberID: string): number {
    return this.costs
      .filter((c) => c.memberID === memberID)
      .reduce((sum, c) => sum + c.cost, 0);
  }

  getTeamCost(teamID: string): number {
    return this.costs
      .filter((c) => c.teamID === teamID)
      .reduce((sum, c) => sum + c.cost, 0);
  }

  // ── File Locks ────────────────────────────────────────────────────
  acquireLock(lock: FileLock): boolean {
    const existing = this.locks.get(lock.path);
    if (existing && existing.memberID !== lock.memberID) return false;
    this.appendEvent("locks.jsonl", "lock.acquired", lock);
    return true;
  }

  releaseLock(filePath: string): void {
    if (this.locks.has(filePath)) {
      this.appendEvent("locks.jsonl", "lock.released", { path: filePath });
    }
  }

  releaseMemberLocks(memberID: string): void {
    for (const [filePath, lock] of this.locks) {
      if (lock.memberID === memberID) {
        this.releaseLock(filePath);
      }
    }
  }

  getLock(filePath: string): FileLock | undefined {
    return this.locks.get(filePath);
  }

  getMemberLocks(memberID: string): FileLock[] {
    return [...this.locks.values()].filter((l) => l.memberID === memberID);
  }

  // ── Scratchpad ────────────────────────────────────────────────────
  scratchpadSet(teamID: string, key: string, value: string): void {
    this.appendEvent("teams.jsonl", "scratchpad.set", { teamID, key, value });
  }

  scratchpadGet(teamID: string, key: string): string | undefined {
    return this.scratchpads.get(teamID)?.get(key);
  }

  scratchpadDelete(teamID: string, key: string): void {
    this.appendEvent("teams.jsonl", "scratchpad.delete", { teamID, key });
  }

  scratchpadList(teamID: string): Record<string, string> {
    const pad = this.scratchpads.get(teamID);
    if (!pad) return {};
    return Object.fromEntries(pad);
  }
}
