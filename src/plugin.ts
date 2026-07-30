import type { PluginInput, PluginOptions, Hooks } from "@opencode-ai/plugin";
import { Store } from "./state/store.js";
import { Runner, type RunnerClient } from "./core/runner.js";
import { WorkflowRegistry } from "./workflows/index.js";
import { createTools } from "./tools/index.js";
import { createEventHook } from "./hooks/events.js";
import { createPermissionHook } from "./hooks/permissions.js";
import { Reporter } from "./core/reporter.js";

const INIT_TIMEOUT_MS = 5000;

export async function plugin(
  input: PluginInput,
  options?: PluginOptions
): Promise<Hooks> {
  // Dormant inside runner-managed worktrees: a worktree's own opencode
  // instance also loads this plugin (the project's opencode.json registers
  // it), but there it is useless and noisy — its Store would write into the
  // worktree and crash with ENOENT once the runner removes it. The lead
  // instance drives worktree sessions via the API, so they need nothing
  // from us: no store, no tools, no hooks.
  if (input.directory.split(/[\\/]/).includes(".orch-worktrees")) {
    return {};
  }

  // Reporter is the FIRST thing constructed — if anything else fails, we can
  // still surface the error to the user via TUI toast + app.log + file log.
  const reporter = new Reporter(input.client, input.directory);

  // Plugin option `stepPermissions`: "auto" (default) or "ask". "ask"
  // disables the step-session auto-allow, exactly like the
  // ORCH_STEP_PERMISSIONS=ask env var (either one wins). Unknown values
  // warn and fall back to "auto".
  let stepPermissions: "auto" | "ask" = "auto";
  const rawStepPermissions: unknown = options?.stepPermissions;
  if (rawStepPermissions !== undefined) {
    if (rawStepPermissions === "auto" || rawStepPermissions === "ask") {
      stepPermissions = rawStepPermissions;
    } else {
      reporter.warn(
        "[orch]",
        `unknown stepPermissions value ${JSON.stringify(rawStepPermissions)} — falling back to "auto"`
      );
    }
  }

  let initPromise: Promise<{ hooks: Hooks; cleanup: () => void }> | null = null;

  try {
    initPromise = doInit(input, reporter, stepPermissions);
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
    // it created (snapshot timer, step timers) so they don't leak for the
    // lifetime of the process.
    if (initPromise) {
      initPromise
        .then(({ cleanup }) => cleanup())
        .catch(() => {});
    }
    // Return empty hooks so opencode keeps working without our tools.
    return {};
  }
}

async function doInit(
  input: PluginInput,
  reporter: Reporter,
  stepPermissions: "auto" | "ask"
): Promise<{ hooks: Hooks; cleanup: () => void }> {
  // ── State store (replay marks interrupted runs failed) ────────────
  const store = new Store(input.directory);
  await store.init();

  // ── Workflow definitions (built-ins + custom) ─────────────────────
  const workflows = new WorkflowRegistry();
  workflows.loadCustom(input.directory);
  for (const err of workflows.errors) {
    reporter.warn("[orch]", `workflow load: ${err}`);
  }

  // ── Runner ────────────────────────────────────────────────────────
  const runner = new Runner({
    store,
    workflows,
    client: input.client as unknown as RunnerClient,
    directory: input.directory,
    reporter,
  });
  // Kill zombie step sessions from runs a previous process left `running`.
  runner.sweepInterruptedSessions();

  const cleanup = () => {
    runner.destroy();
    store.destroy();
  };

  // ── Build hooks ───────────────────────────────────────────────────
  const hooks: Hooks = {
    tool: createTools({ runner, store, workflows }),
    event: createEventHook({ runner, directory: input.directory }),
    "permission.ask": createPermissionHook({
      runner,
      directory: input.directory,
      stepPermissions,
    }),
    dispose: async () => cleanup(),
  };

  // Graceful shutdown — flush state on process exit
  process.on("beforeExit", cleanup);
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);

  const toolCount = Object.keys(hooks.tool ?? {}).length;
  reporter.success("[orch]", `ready · ${toolCount} tools`);

  return { hooks, cleanup };
}
