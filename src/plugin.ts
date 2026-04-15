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
import { revalidateMemberSessions } from "./core/revalidate.js";
import { RateLimiterRegistry } from "./core/rate-limit.js";

const INIT_TIMEOUT_MS = 5000;

function parsePositiveInt(v: string | undefined, fallback: number): number {
  if (!v) return fallback;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function parseRateLimitEnv(env: NodeJS.ProcessEnv = process.env): {
  windowMs: number;
  maxCalls: number;
} {
  return {
    windowMs: parsePositiveInt(env.ORCH_RATE_LIMIT_WINDOW_MS, 60_000),
    maxCalls: parsePositiveInt(env.ORCH_RATE_LIMIT_MAX_CALLS, 60),
  };
}

export async function plugin(
  input: PluginInput,
  _options?: PluginOptions
): Promise<Hooks> {
  // Reporter is the FIRST thing constructed — if anything else fails, we can
  // still surface the error to the user via TUI toast + app.log + file log.
  const reporter = new Reporter(input.client, input.directory);

  let initPromise: Promise<{ hooks: Hooks; store: Store }> | null = null;

  try {
    initPromise = doInit(input, reporter);
    const { hooks } = await Promise.race([
      initPromise,
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error(`plugin init timed out after ${INIT_TIMEOUT_MS}ms`)),
          INIT_TIMEOUT_MS
        )
      ),
    ]);
    return hooks;
  } catch (err) {
    reporter.error("[orch] init failed", err);
    // If init eventually completes after the timeout, tear down the resources
    // it created (snapshot timer, signal handlers) so they don't leak for the
    // lifetime of the process.
    if (initPromise) {
      initPromise
        .then(({ store }) => store.destroy())
        .catch(() => {});
    }
    // Return empty hooks so opencode keeps working without our tools.
    return {};
  }
}

async function doInit(
  input: PluginInput,
  reporter: Reporter
): Promise<{ hooks: Hooks; store: Store }> {
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

  // ── Rate limiter ────────────────────────────────────────────────
  // Default: 60 orch_* tool calls per 60-second sliding window per member.
  // Overrideable globally via ORCH_RATE_LIMIT_WINDOW_MS /
  // ORCH_RATE_LIMIT_MAX_CALLS env vars, or per-team via TeamConfig.rateLimit.
  // Lead sessions are exempt.
  const rateLimiter = new RateLimiterRegistry(parseRateLimitEnv());

  // ── Session revalidation ────────────────────────────────────────
  // Members recovered from snapshot/JSONL may reference opencode sessions
  // that no longer exist. Walk them now and force-shutdown the dead ones
  // so we don't try to wake zombies on the next idle event.
  await revalidateMemberSessions(store, fileLocks, input, reporter);

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
      rateLimiter,
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

    "permission.ask": createPermissionHook(manager, fileLocks, input.directory),

    "tool.execute.after": createActivityHook(manager, activity, input.directory),
  };

  // Graceful shutdown — flush state on process exit
  const cleanup = () => { store.destroy(); };
  process.on("beforeExit", cleanup);
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);

  const toolCount = Object.keys(hooks.tool ?? {}).length;
  reporter.success("[orch]", `ready · ${toolCount} tools`);

  return { hooks, store };
}
