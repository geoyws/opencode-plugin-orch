# Epic: Goal mode and dynamic workflows for OpenCode

**Status:** Complete
**Owner:** Orch maintainers
**Target:** v0.4.0
**Started:** 2026-08-16

## Outcome

OpenCode users can run long-lived, token-aware goals and safe dynamic workflows
with any configured provider, including DeepSeek. Orch keeps the work moving,
evaluates completion independently, compacts context before it becomes wasteful,
and exposes durable progress and controls after the initiating turn ends.

## User journeys

1. Run `/goal all tests pass and typecheck is clean` and let OpenCode continue
   until an independent evaluator returns `met`, `impossible`, or a configured
   budget is exhausted.
2. Run DeepSeek as the worker, evaluator, or both without Anthropic-specific
   assumptions: for example `deepseek/deepseek-chat` or any provider/model pair
   OpenCode exposes.
3. Ask the lead to author a workflow, inspect the validated plan, run it in the
   background, pause/resume/cancel it, and save it for reuse.
4. Run `/workflows` to inspect active and historical runs, token use, compact
   checkpoints, agent status, and terminal evidence.
5. Resume after OpenCode restarts from durable state without replaying already
   completed workflow nodes or injecting full historical outputs into prompts.

## Scope

### Goal lifecycle

- [x] Register `/goal [condition]`, `/goal`, and `/goal clear`.
- [x] Persist at most one active goal per OpenCode session.
- [x] Evaluate after each eligible `session.idle` event with a separately
      configurable model.
- [x] Support `met`, `not_met`, and `impossible` verdicts with short reasons.
- [x] Automatically continue the original session on `not_met`.
- [x] Preserve the original session permission policy.
- [x] Stop or pause safely on turn, elapsed-time, token, cost, or no-progress
      limits.
- [x] Restore active goals when the same OpenCode session is resumed.

### Dynamic workflow authoring and execution

- [x] Add a strict, versioned workflow IR; never execute model-authored code
      with `eval`, `Function`, `vm`, or an unrestricted subprocess.
- [x] Support chain/sequence, routing, parallel fan-out, evaluator loops,
      orchestrator-planned map/fan-out, explicit shell gates, and aggregation.
- [x] Add author, validate, save, run, list, inspect, pause, resume, retry,
      cancel, and result operations.
- [x] Persist an immutable resolved plan with every run.
- [x] Bound concurrency, total agents, iterations, elapsed time, output size,
      tokens, and estimated cost.
- [x] Default dynamic runs to permission prompting; autonomous permission mode
      must be an explicit run option.
- [x] Support per-run and per-node provider/model routing, including DeepSeek.
- [ ] Add first-class structured output schemas and a non-planner static `map`
      node in a later IR revision; v1 covers these jobs through orchestrator
      fan-out and evaluator validation.

### Token management and compaction

- [x] Track input, output, reasoning, cache-read, and cache-write tokens when
      OpenCode reports them.
- [x] Keep goal usage monotonic across automatic session summarization by
      durably recording accounted provider message IDs when available.
- [x] Enforce soft and hard token/cost budgets at goal and run boundaries.
- [x] Keep full outputs in the durable store while injecting only bounded
      summaries and relevant excerpts into later prompts.
- [x] Generate deterministic checkpoint summaries before configurable context pressure.
- [x] Reuse checkpoint summaries after restart/resume instead of replaying the
      transcript.
- [x] Prefer a configured cheap evaluator/summarizer model.
- [x] Surface budget, compaction, truncation, and cache behavior in status.
- [ ] Add provider-side per-invocation token ceilings when OpenCode exposes a
      portable API; v1 can stop only at completed step/turn boundaries.

### OpenCode interface

- [x] Ship separate server and TUI plugin entrypoints.
- [x] Show a session goal indicator with turns and token budget.
- [x] Show running and paused workflow activity beside the home/session prompt.
- [x] Provide a workflow route with run/node state and token drill-down.
- [x] Refresh the TUI from an event-updated `view.json` read model while
      retaining `snapshot.json` as the compacted recovery fast path.
- [x] Provide pause/resume/retry/cancel controls through `orch_control`.
- [x] Keep all functionality available through tools and commands when the TUI
      plugin is not installed.

### Documentation and release evidence

- [x] Write BRD and PRD.
- [x] Record architecture decisions for goal lifecycle, safe workflow IR,
      provider-neutral routing, TUI split, and token compaction.
- [x] Update README and CHANGELOG (the existing workflow demo remains valid).
- [x] Unit-test state machines, schemas, budgets, compaction, recovery, and TUI loading.
- [x] Exercise a real OpenCode server against the hermetic mock provider,
      including the `/goal` continuation lifecycle.
- [x] Capture opt-in live DeepSeek receipts; never run them in ordinary CI.

## Acceptance criteria

- `/goal` starts, reports, clears, independently evaluates, and automatically
  continues a session in a real OpenCode server test.
- A DeepSeek model reference can be selected for goal evaluation and every
  workflow node without special casing.
- A dynamic workflow can be authored from validated JSON, executed, paused,
  resumed, cancelled, and saved as a reusable definition.
- Restart recovery never marks recoverable workflow state complete and never
  reruns a completed node.
- A hard token budget prevents a new agent invocation and records a truthful
  budget-exhausted terminal state.
- Prompt-bound outputs are capped and checkpoint summaries are persisted while
  complete raw outputs remain available through `orch_result`.
- No generated JavaScript is executed in the OpenCode process.
- Existing tests remain green and new non-live tests require no network or
  paid model access.

## Out of scope for this epic

- Reproducing Anthropic-only prompt-cache internals or pricing.
- Bypassing provider quotas, OpenCode permissions, or managed policy.
- Claiming exact token counts when a provider does not report usage.
- Automatic commit, push, deployment, or destructive repository operations.

## Delivery slices

1. **Goal core:** durable goal store, command/tool, evaluator loop, budgets.
2. **Workflow IR:** schema, resolved plans, runtime controls, recovery.
3. **Token economy:** accounting, summaries, compact checkpoints, routing.
4. **Authoring and reuse:** validation, saving, command discovery.
5. **TUI:** goal indicator, workflow progress route, operator controls.
6. **Receipts:** hermetic server E2E, opt-in DeepSeek live test, documentation.

## Risks and mitigations

- **Runaway spend:** hard budgets, agent caps, iteration caps, and explicit
  terminal reasons.
- **Generated-code execution:** validated data IR only.
- **False goal completion:** independent evaluator, evidence-only prompt, and
  `impossible`/stalled outcomes.
- **Context bloat:** bounded excerpts, checkpoint summaries, and relevance-led
  prompt assembly.
- **Permission escalation:** prompting by default and no goal-specific
  auto-approval.
- **Provider drift:** model references remain provider-neutral and live tests
  are opt-in.

## Follow-on epic: Rust kernel and real CLI parity (v0.5)

- [x] Reproduce the installed `opencode run` teardown abort with IFCA DeepSeek.
- [x] Add an actual-binary E2E covering planner, two workers, aggregation,
      process exit, snapshot recovery, and final output.
- [x] Keep `orch_run` attached by default; retain explicit background mode for
      persistent TUI/server sessions.
- [x] Show goal, per-workflow elapsed time, per-workflow active agents, and
      total active agents in a compact multi-row prompt indicator.
- [x] Establish `crates/orch-core` with native activity projection, tests, and
      a release benchmark.
- [ ] Cut over activity projection only if it clears the native performance
      gate; the initial Rust prototype was slower than Bun and remains unused.
- [ ] Add the N-API bridge and cross-platform native artifact build matrix.
- [ ] Migrate workflow IR validation and event-store transitions with golden
      TypeScript/Rust differential fixtures.
- [ ] Migrate scheduler patterns, budget/retry decisions, recovery, and goal
      evaluation after each parity gate passes.
- [ ] Remove the TypeScript kernel fallback only after restart, installed-CLI,
      TUI, and paid DeepSeek parity receipts pass on supported platforms.
