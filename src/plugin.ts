import type { PluginInput, PluginOptions, Hooks } from "@opencode-ai/plugin";
import { Store } from "./state/store.js";
import { TeamManager } from "./core/team-manager.js";
import { MessageBus } from "./core/message-bus.js";
import { TaskBoard } from "./core/task-board.js";
import { Scratchpad } from "./core/scratchpad.js";
import { CostTracker } from "./core/cost-tracker.js";
import { FileLockManager } from "./core/file-locks.js";
import { EscalationManager } from "./core/escalation.js";
import { ActivityTracker } from "./core/activity.js";
import { TemplateRegistry } from "./templates/index.js";
import { createTools } from "./tools/index.js";
import { createEventHook } from "./hooks/events.js";
import { createPermissionHook } from "./hooks/permissions.js";
import { createActivityHook } from "./hooks/activity-tracker.js";

export async function plugin(
  input: PluginInput,
  _options?: PluginOptions
): Promise<Hooks> {
  // ── Initialize state store ──────────────────────────────────────
  const store = new Store(input.directory);
  await store.init();

  // ── Core modules ────────────────────────────────────────────────
  const manager = new TeamManager(store, input);
  const bus = new MessageBus(store, manager, input);
  const board = new TaskBoard(store, input);
  const pad = new Scratchpad(store);
  const costs = new CostTracker(store);
  const fileLocks = new FileLockManager(store);
  const escalation = new EscalationManager(store, manager, input);
  const activity = new ActivityTracker();

  // ── Templates ───────────────────────────────────────────────────
  const templates = new TemplateRegistry();
  await templates.loadCustomTemplates(input.directory);

  // ── Build hooks ─────────────────────────────────────────────────
  const hooks: Hooks = {
    tool: createTools({
      manager,
      bus,
      board,
      pad,
      costs,
      activity,
      store,
      templates,
    }),

    event: createEventHook({
      store,
      manager,
      bus,
      board,
      costs,
      fileLocks,
      escalation,
      ctx: input,
    }),

    "permission.ask": createPermissionHook(manager, fileLocks),

    "tool.execute.after": createActivityHook(manager, activity),
  };

  // Log startup
  try {
    await input.client.app.log({
      body: {
        service: "opencode-plugin-orch",
        level: "info",
        message: "[orch] Plugin initialized",
      },
    });
  } catch {
    // Non-critical
  }

  return hooks;
}
