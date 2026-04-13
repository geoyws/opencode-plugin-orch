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
import { Reporter } from "./core/reporter.js";

const INIT_TIMEOUT_MS = 5000;

export async function plugin(
  input: PluginInput,
  _options?: PluginOptions
): Promise<Hooks> {
  // Reporter is the FIRST thing constructed — if anything else fails, we can
  // still surface the error to the user via TUI toast + app.log + file log.
  const reporter = new Reporter(input.client, input.directory);

  try {
    return await Promise.race([
      doInit(input, reporter),
      new Promise<Hooks>((_, reject) =>
        setTimeout(
          () => reject(new Error(`plugin init timed out after ${INIT_TIMEOUT_MS}ms`)),
          INIT_TIMEOUT_MS
        )
      ),
    ]);
  } catch (err) {
    reporter.error("[orch] init failed", err);
    // Return empty hooks so opencode keeps working without our tools.
    return {};
  }
}

async function doInit(input: PluginInput, reporter: Reporter): Promise<Hooks> {
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
      reporter,
    }),

    "permission.ask": createPermissionHook(manager, fileLocks),

    "tool.execute.after": createActivityHook(manager, activity),
  };

  // Graceful shutdown — flush state on process exit
  const cleanup = () => { store.destroy(); };
  process.on("beforeExit", cleanup);
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);

  const toolCount = Object.keys(hooks.tool ?? {}).length;
  reporter.success("[orch]", `ready · ${toolCount} tools`);

  return hooks;
}
