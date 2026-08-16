import type { PluginInput, PluginOptions, Hooks } from "@opencode-ai/plugin";
import { Store } from "./state/store.js";
import { Runner, type RunnerClient } from "./core/runner.js";
import { WorkflowRegistry } from "./workflows/index.js";
import { createTools } from "./tools/index.js";
import { createEventHook } from "./hooks/events.js";
import { createPermissionHook } from "./hooks/permissions.js";
import { Reporter } from "./core/reporter.js";
import {
  GoalController,
  type GoalClient,
  type GoalOptions,
} from "./core/goal-controller.js";
import type { ModelRef } from "./state/schemas.js";
import { controlPlaneSnapshot } from "./core/control-plane.js";

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
    initPromise = doInit(input, reporter, stepPermissions, options);
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
  stepPermissions: "auto" | "ask",
  options?: PluginOptions
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

  const goals = new GoalController({
    store,
    client: input.client as unknown as GoalClient,
    directory: input.directory,
    reporter,
    options: goalOptions(options, reporter),
  });

  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    process.off("beforeExit", cleanup);
    process.off("SIGINT", cleanup);
    process.off("SIGTERM", cleanup);
    runner.destroy();
    store.destroy();
  };

  // ── Build hooks ───────────────────────────────────────────────────
  const hooks: Hooks = {
    tool: createTools({ runner, store, workflows, goals }),
    event: createEventHook({ runner, goals, directory: input.directory }),
    config: async (config) => {
      config.command ??= {};
      config.command.goal = {
        template: "$ARGUMENTS",
        description: "Set, inspect, or clear an autonomous completion goal",
      };
      config.command.workflows = {
        template:
          "Call orch_workflows with action=list, then call orch_runs. If an id or name is supplied, inspect it using orch_status or orch_workflows action=info: $ARGUMENTS",
        description: "List and inspect Orch workflows and runs",
      };
      config.command["workflow-author"] ??= {
        template:
          "Design a reusable version 1 workflow IR for this task, using only the documented chain, routing, parallel, orchestrator, or evaluator patterns. Use provider-neutral {providerID,modelID} references when a model is requested. Call orch_workflows action=validate, correct every validation error, then call action=save. Do not include shell or gate commands unless the user explicitly requested them. Task: $ARGUMENTS",
        description: "Author, validate, and save a safe workflow",
      };
      config.command["workflow-run"] ??= {
        template:
          "Run the named workflow using orch_run. Parse the first word as the workflow name and the remainder as input. If ambiguous, call orch_workflows action=list first. Request: $ARGUMENTS",
        description: "Start a saved Orch workflow",
      };
      for (const { def } of workflows.list()) {
        config.command[def.name] ??= {
          template: `Call orch_run with workflow=${def.name} and input exactly as follows: $ARGUMENTS`,
          description: `Run Orch workflow: ${def.description}`,
        };
      }
    },
    "command.execute.before": async (command, output) => {
      if (command.command !== "goal") return;
      const handled = await goals.handleGoalCommand(command.sessionID, command.arguments);
      const firstText = output.parts.find((part) => part.type === "text") as
        | { type: "text"; text: string }
        | undefined;
      if (firstText) firstText.text = handled.prompt;
      else output.parts.push({ type: "text", text: handled.prompt } as never);
    },
    "chat.message": async (message) => {
      goals.noteSession(message.sessionID, {
        model: message.model,
        agent: message.agent,
      });
    },
    "experimental.chat.system.transform": async (context, output) => {
      const sessionID = context.sessionID;
      if (
        sessionID &&
        (runner.isStepSession(sessionID) ||
          goals.isEvaluatorSession(sessionID) ||
          goals.isWorkerSession(sessionID))
      ) {
        return;
      }
      output.system.push(controlPlaneSnapshot(store, sessionID));
    },
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

  // Hooks must be returned before a recovered worker is prompted so its next
  // turn can see the complete Orch tool surface. Recovery itself verifies the
  // worker is idle and consumes the durable continuation exactly once.
  setTimeout(() => void goals.recover(), 0);

  return { hooks, cleanup };
}

function modelOption(value: unknown, key: string, reporter: Reporter): ModelRef | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Record<string, unknown>).providerID === "string" &&
    typeof (value as Record<string, unknown>).modelID === "string"
  ) {
    return {
      providerID: (value as Record<string, string>).providerID,
      modelID: (value as Record<string, string>).modelID,
    };
  }
  reporter.warn("[orch]", `${key} must be {providerID, modelID}; using session default`);
  return undefined;
}

function positiveInt(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : fallback;
}

function positiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : undefined;
}

function goalOptions(options: PluginOptions | undefined, reporter: Reporter): GoalOptions {
  const maxTokens = positiveInt(options?.goalMaxTokens, 250_000);
  return {
    evaluatorModel: modelOption(options?.goalEvaluatorModel, "goalEvaluatorModel", reporter),
    summarizerModel: modelOption(options?.goalSummarizerModel, "goalSummarizerModel", reporter),
    maxTurns: positiveInt(options?.goalMaxTurns, 20),
    maxDurationMs: positiveInt(options?.goalMaxDurationMs, 14_400_000),
    maxTokens,
    softTokens: Math.min(positiveInt(options?.goalSoftTokens, 180_000), maxTokens),
    noProgressLimit: positiveInt(options?.goalNoProgressTurns, 3),
    evidenceChars: positiveInt(options?.goalEvidenceChars, 12_000),
    maxCost: positiveNumber(options?.goalMaxCost),
  };
}
