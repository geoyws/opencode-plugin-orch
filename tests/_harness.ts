// Shared test harness for integration/e2e tests.
// Provides a mock SDK client and helpers to wire up the full plugin
// (Store + TeamManager + MessageBus + TaskBoard + hooks + tools)
// so tests can drive end-to-end flows without a real opencode server.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { PluginInput } from "@opencode-ai/plugin";
import type { Event } from "@opencode-ai/sdk";
import { Store } from "../src/state/store.js";
import { TeamManager } from "../src/core/team-manager.js";
import { MessageBus } from "../src/core/message-bus.js";
import { TaskBoard } from "../src/core/task-board.js";
import { Scratchpad } from "../src/core/scratchpad.js";
import { CostTracker } from "../src/core/cost-tracker.js";
import { FileLockManager } from "../src/core/file-locks.js";
import { EscalationManager } from "../src/core/escalation.js";
import { ActivityTracker } from "../src/core/activity.js";
import { TemplateRegistry } from "../src/templates/index.js";
import { createTools } from "../src/tools/index.js";
import { createEventHook } from "../src/hooks/events.js";
import { createPermissionHook } from "../src/hooks/permissions.js";
import { createActivityHook } from "../src/hooks/activity-tracker.js";
import { Reporter } from "../src/core/reporter.js";

// ── Recorded SDK calls ──────────────────────────────────────────────
export interface RecordedCall {
  method: string;
  args: unknown;
  timestamp: number;
}

// ── Mock SDK Client ─────────────────────────────────────────────────
// Tracks every call so tests can assert on what the plugin sent to opencode.
// Returns realistic shapes for methods that the plugin reads from.
export class MockClient {
  public calls: RecordedCall[] = [];
  public sessions = new Map<string, { id: string; title?: string; parentID?: string }>();
  public files = new Map<string, string>();
  public toasts: Array<{ title?: string; message: string; variant: string }> = [];
  public logs: Array<{ level: string; message: string }> = [];
  public sessionCounter = 0;

  private record(method: string, args: unknown): void {
    this.calls.push({ method, args, timestamp: Date.now() });
  }

  reset(): void {
    this.calls = [];
    this.sessions.clear();
    this.files.clear();
    this.toasts = [];
    this.logs = [];
    this.sessionCounter = 0;
  }

  callsFor(method: string): RecordedCall[] {
    return this.calls.filter((c) => c.method === method);
  }

  registerFile(filePath: string, content: string): void {
    this.files.set(filePath, content);
  }

  // ── Mock SDK methods ─────────────────────────────────────────
  session = {
    create: async (params: { body?: { parentID?: string; title?: string } }) => {
      this.record("session.create", params);
      const id = `mock-session-${++this.sessionCounter}`;
      const sess = { id, title: params.body?.title, parentID: params.body?.parentID };
      this.sessions.set(id, sess);
      return { data: sess };
    },
    prompt: async (params: {
      path: { id: string };
      body?: { parts?: unknown[]; noReply?: boolean };
    }) => {
      this.record("session.prompt", params);
      return { data: { info: { id: "msg-1" }, parts: [] } };
    },
    promptAsync: async (params: {
      path: { id: string };
      body?: { parts?: unknown[]; agent?: string; model?: unknown };
    }) => {
      this.record("session.promptAsync", params);
      return { data: { info: { id: "msg-1" }, parts: [] } };
    },
    abort: async (params: { path: { id: string } }) => {
      this.record("session.abort", params);
      return { data: true };
    },
  };

  file = {
    read: async (params: { query: { path: string } }) => {
      this.record("file.read", params);
      const content = this.files.get(params.query.path) ?? "";
      return { data: { content } };
    },
  };

  tui = {
    showToast: async (params: {
      body?: { title?: string; message: string; variant: string; duration?: number };
    }) => {
      this.record("tui.showToast", params);
      if (params.body) {
        this.toasts.push({
          title: params.body.title,
          message: params.body.message,
          variant: params.body.variant,
        });
      }
      return { data: true };
    },
  };

  app = {
    log: async (params: { body?: { service: string; level: string; message: string } }) => {
      this.record("app.log", params);
      if (params.body) {
        this.logs.push({ level: params.body.level, message: params.body.message });
      }
      return { data: true };
    },
  };
}

// ── Test harness — the full plugin wired up with a mock client ───
export interface Harness {
  tmpDir: string;
  client: MockClient;
  store: Store;
  manager: TeamManager;
  bus: MessageBus;
  board: TaskBoard;
  pad: Scratchpad;
  costs: CostTracker;
  fileLocks: FileLockManager;
  escalation: EscalationManager;
  activity: ActivityTracker;
  templates: TemplateRegistry;
  reporter: Reporter;
  tools: ReturnType<typeof createTools>;
  fireEvent: (event: Event) => Promise<void>;
  permissionHook: ReturnType<typeof createPermissionHook>;
  activityHook: ReturnType<typeof createActivityHook>;
  cleanup: () => void;
}

export async function createHarness(): Promise<Harness> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-e2e-"));
  const client = new MockClient();
  const ctx = {
    client,
    project: { id: "test-project" },
    directory: tmpDir,
    worktree: tmpDir,
    serverUrl: new URL("http://localhost:0"),
    $: null,
  } as unknown as PluginInput;

  const store = new Store(tmpDir);
  await store.init();

  const manager = new TeamManager(store, ctx);
  const bus = new MessageBus(store, manager, ctx);
  const board = new TaskBoard(store, ctx);
  const pad = new Scratchpad(store);
  const costs = new CostTracker(store);
  const fileLocks = new FileLockManager(store);
  const escalation = new EscalationManager(store, manager, ctx);
  const activity = new ActivityTracker();
  const templates = new TemplateRegistry();
  const reporter = new Reporter(client, tmpDir);

  const tools = createTools({
    manager,
    bus,
    board,
    pad,
    costs,
    activity,
    store,
    templates,
  });

  const eventHook = createEventHook({
    store,
    manager,
    bus,
    board,
    costs,
    fileLocks,
    escalation,
    ctx,
    reporter,
  });

  const permissionHook = createPermissionHook(manager, fileLocks, tmpDir);
  const activityHook = createActivityHook(manager, activity, tmpDir);

  return {
    tmpDir,
    client,
    store,
    manager,
    bus,
    board,
    pad,
    costs,
    fileLocks,
    escalation,
    activity,
    templates,
    reporter,
    tools,
    fireEvent: (event: Event) => eventHook({ event }),
    permissionHook,
    activityHook,
    cleanup: () => {
      store.destroy();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    },
  };
}

// ── Helpers to invoke tools as the LLM would ────────────────────
// Tool execution requires a ToolContext — this builds a minimal one.
export function makeToolContext(sessionID: string, opts?: { messageID?: string; agent?: string }): {
  sessionID: string;
  messageID: string;
  agent: string;
  directory: string;
  worktree: string;
  abort: AbortSignal;
  metadata: (input: { title?: string; metadata?: Record<string, unknown> }) => void;
  ask: (input: unknown) => Promise<void>;
} {
  return {
    sessionID,
    messageID: opts?.messageID ?? "test-message",
    agent: opts?.agent ?? "build",
    directory: "/tmp",
    worktree: "/tmp",
    abort: new AbortController().signal,
    metadata: () => {},
    ask: async () => {},
  };
}

// ── Event factories ─────────────────────────────────────────────
export function sessionIdleEvent(sessionID: string): Event {
  return {
    type: "session.idle",
    properties: { sessionID },
  } as Event;
}

export function sessionStatusEvent(sessionID: string, status: "idle" | "busy" | "retry"): Event {
  return {
    type: "session.status",
    properties: {
      sessionID,
      status: status === "retry"
        ? { type: "retry", attempt: 1, message: "retrying", next: 0 }
        : { type: status },
    },
  } as Event;
}

export function sessionErrorEvent(sessionID: string): Event {
  return {
    type: "session.error",
    properties: {
      sessionID,
      error: { name: "UnknownError", data: { message: "test error" } },
    },
  } as Event;
}

export function messageUpdatedEvent(sessionID: string, cost: number): Event {
  return {
    type: "message.updated",
    properties: {
      info: {
        id: "msg-1",
        sessionID,
        role: "assistant",
        cost,
        tokens: { input: 100, output: 50, reasoning: 0, cache: { read: 0, write: 0 } },
      } as unknown,
    },
  } as Event;
}
