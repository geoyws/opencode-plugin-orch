# Product Requirements Document: Goal mode and dynamic workflows

**Status:** v0.6 lead-control and local-reload hardening
**Date:** 2026-08-16
**Target release:** v0.6.0

## Product definition

Orch adds two related control planes to OpenCode:

- **Goal mode:** a session-scoped lead/control plane backed by a dedicated
  completion worker that is evaluated independently after each worker turn.
- **Dynamic workflows:** durable, validated orchestration plans that coordinate
  background agent sessions without placing every intermediate result into the
  lead conversation.

Both are provider-neutral, DeepSeek-compatible, budgeted, resumable, and
observable through tools, slash commands, and an optional TUI.

## Functional requirements

### Goal commands and tool

- Register `/goal $ARGUMENTS` through the OpenCode config hook.
- Expose `orch_goal` with `set`, `status`, `pause`, `resume`, `steer`, and
  `clear` actions for models and non-TUI clients.
- A condition is 1-4,000 characters.
- One active goal is allowed per session; setting another replaces it.
- `clear`, `stop`, `off`, `reset`, `none`, and `cancel` clear the goal.
- With no condition, return current or most recently resolved goal status.

### Lead/control-plane and goal evaluation

- Keep the initiating session free for operator conversation, state inspection,
  steering, pausing, resuming, and stopping delegated work.
- Run substantive goal work in one dedicated persisted worker session.
- Evaluate only the goal worker after its `session.idle`; never evaluate a lead,
  evaluator, or workflow-step session.
- Build an evidence packet from bounded recent assistant output plus the latest
  compact checkpoint.
- Ask the configured evaluator for strict JSON:
  `{ "verdict": "met|not_met|impossible", "reason": "..." }`.
- On `not_met`, append the evaluator reason and condition to a new prompt in
  the dedicated worker session.
- On `met` or `impossible`, resolve the goal and do not continue.
- After repeated turns without tool activity, pause with the goal still active.
- Inject a fresh bounded system snapshot into each lead turn with active goals,
  workflows, elapsed time, worker/agent counts, tokens, steps, verdicts, and
  latest steering. Do not add snapshot messages to the transcript.
- Persist steering and deliver it to an active worker when possible; every
  later worker prompt must include the durable direction.

### Goal budgets

- Defaults: 20 turns, 4 hours, 250,000 observed tokens, three no-progress turns.
- Every default is configurable through plugin options and per-goal tool input.
- A hard limit stops automatic continuation before the next turn.
- A soft limit triggers a compact checkpoint and warning.
- Unknown provider usage is reported as unknown, never zero.

### Dynamic workflow definition

- Versioned schema with metadata, inputs, nodes, limits, and result mapping.
- Initial patterns: `chain`, `routing`, `parallel`, `orchestrator`, and
  `evaluator`; steps may be model prompts or explicitly authorized shell
  commands, with optional aggregate and programmatic gate steps.
- Each model step supports an agent name, provider/model, and prompt template.
  Run configuration supplies timeouts, transient retries, worktree isolation,
  total-agent/concurrency limits, and prompt-output caps.
- Evaluator loops and fan-out are explicitly bounded; unbounded loops are
  invalid.
- References use the restricted `{{input}}`, `{{output}}`, `{{feedback}}`, and
  `{{steps.<id>.output}}` template vocabulary, not executable code.

### Authoring and validation

- `orch_workflow_author` accepts a task and asks a planner model for the IR.
- The planner output is parsed and validated before persistence or execution.
- Validation reports actionable schema and cross-reference errors.
- `orch_workflows action=save` writes only validated definitions under
  `.opencode/workflows/` using atomic writes and symlink refusal.
- Saved workflow names are kebab-case and cannot shadow built-ins without an
  explicit replace option.

### Run lifecycle

- Statuses: `running`, `paused`, `completed`, `failed`, `cancelled`,
  `budget_exhausted`.
- Store the resolved plan, input, step attempts, outputs, usage, checkpoints,
  and terminal reason.
- Pause prevents new nodes from starting and lets an in-flight invocation reach
  a safe boundary unless force-cancelled.
- Resume starts only unfinished/interrupted work and reuses completed steps.
- Retry reopens a terminal failed/cancelled run while preserving completed
  steps; the runtime resumes at its first unfinished boundary.
- Cancel aborts active sessions/commands and retains completed evidence.
- Steer persists operator direction, delivers it to active model steps when
  possible, and injects it into every later model step. Shell steps apply it at
  the next model boundary; cancellation is the immediate-stop control.

### Token-aware prompt assembly

- Raw outputs remain in the store and are never silently overwritten by their
  summaries.
- Downstream prompts receive only referenced outputs, each capped independently.
- When a referenced output exceeds the cap, use a persisted deterministic
  head/tail checkpoint with an explicit truncation marker.
- Checkpoints preserve the step identity, total length, and bounded head/tail
  evidence; complete raw output remains retrievable.
- Summarizer model precedence:
  node override, run override, plugin option, evaluator model, server default.

### Model routing and DeepSeek

- Model references are `{ providerID, modelID }` throughout persisted state.
- Resolution precedence:
  node override, workflow default, run override, plugin default, OpenCode
  session/server default.
- Document examples for DeepSeek provider IDs but do not assume one canonical
  provider name; users choose entries exposed by their OpenCode model picker.
- Structured output parsing tolerates fenced JSON and explanatory prefixes but
  rejects missing required fields.

### Permissions

- `permissionMode: "ask"` is the default for dynamic workflows.
- `permissionMode: "auto"` is an explicit opt-in for unattended custom runs;
  tracked step sessions still deny Git mutation through the permission hook.
- Built-in workflows retain their existing unattended `auto` default. Global
  `stepPermissions: "ask"` or `ORCH_STEP_PERMISSIONS=ask` always wins.

### Commands and TUI

- Commands: `/goal`, `/workflows`, `/workflow-run`, `/workflow-author`.
- The server entrypoint remains functional without a TUI plugin.
- The TUI entrypoint adds a goal indicator and a workflow route with filters,
  node details, tokens, elapsed time, and controls.
- The prompt indicator uses multiple rows and shows goal-worker state, goal
  agent count, per-workflow active agents, elapsed wall time, and truthful token
  totals including cache reads and writes.
- Server/TUI communication uses durable read models and authenticated OpenCode
  operations; the TUI must not mutate snapshot files directly.

## Data and persistence

- Continue event-sourced JSONL with atomic compact snapshots for v0.4.
- Write an atomic `view.json` read model on each event for the TUI without
  compacting the authoritative event log.
- Persist versioned workflow plans plus goal, usage, and checkpoint state;
  schema defaults preserve compatibility with older records.
- Never store provider credentials, access tokens, cookies, or environment
  values.
- Store state below `.opencode/plugin-orch/`; exclude it from worktree copy-back.

## Quality requirements

- Unit coverage for every state transition and budget boundary.
- Hermetic real-server coverage for command registration, evaluator continuation,
  dynamic run controls, recovery, and token accounting.
- Opt-in `ORCH_LIVE=1 ORCH_LIVE_MODEL=<provider>/<model>` scenarios for
  DeepSeek and other real models.
- Typecheck and build must pass with strict TypeScript.
- A TUI load smoke test must verify the separate target entrypoint.
- E2E must prove lead/worker isolation, dynamic control snapshots, steering,
  cancellation, restart recovery, and the installed statusline token display.

## Local development and hot reload

- Every successful build publishes uniquely named bundled server and TUI
  generations behind one atomically switched manifest.
- `pnpm dev` watches source and retains the last good generation after a failed
  typecheck or bundle.
- Server reload disposes the project instance; TUI reload deactivates and
  reactivates scoped registrations. Timers, process listeners, and stores must
  not leak across reloads.
- A plain in-place rebuild is not accepted as hot reload because OpenCode and
  Bun cache imported module graphs.

## Release gates

- All non-live tests pass.
- No known path executes generated code.
- Safety review covers permission defaults, symlink handling, command execution,
  budgets, and restart recovery.
- README describes limitations and differentiates hermetic E2E from live model
  receipts.

## v0.5 runtime and lifecycle requirements

- Keep workflow execution, goal control, persistence, compaction, budgets, and
  TUI projections in the portable TypeScript production runtime.
- Keep `crates/orch-core` as an unlinked experimental benchmark fixture; it is
  not a production dependency and does not require an N-API bridge or native
  artifact matrix.
- Optimize TypeScript algorithms and I/O first when profiling identifies a
  material local bottleneck.
- Require a new ADR before introducing any native production slice. It must
  include production-like profiling, golden parity fixtures, portable install
  design, and a release benchmark proving at least 2x throughput or 50% lower
  CPU time after boundary overhead.
- `orch_run` waits for a terminal/paused outcome by default so `opencode run`
  cannot dispose active child agents. `background: true` is restricted to
  persistent interactive/server sessions.
- The prompt indicator uses multiple rows when needed: goal state, one row per
  active workflow with elapsed wall time and per-run active-agent count, plus a
  total-agent row for concurrent workflows.
- Measure local runtime time separately from model/network/command time. Do not
  infer end-to-end workflow improvement from a language or microbenchmark alone.
- Required E2E boundaries are: SDK-hosted real OpenCode server, actual installed
  `opencode run --command` process lifecycle, restart/replay, TUI projection,
  and opt-in paid IFCA DeepSeek workflows including an orchestrator fan-out.
