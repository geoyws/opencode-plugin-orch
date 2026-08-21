# Epic: Goal mode and dynamic workflows for OpenCode

**Status:** Complete
**Owner:** Orch maintainers
**Target:** v0.6.0
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
- [x] Persist evaluator continuation before compaction, release it exactly once
      on the post-compaction idle event, and recover it after plugin reload.

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
- [x] Keep compaction asynchronous from the idle hook and surface a truthful
      `compacting` worker state while continuation is pending.
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
- [x] Paid-live test DeepSeek as goal worker, evaluator, and summarizer across
      an automatic compaction followed by successful continuation.

## Acceptance criteria

- `/goal` starts, reports, clears, independently evaluates, and automatically
  continues a session across forced compaction in a real OpenCode server test.
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

## Follow-on epic: CLI parity, observability, and runtime efficiency (v0.5)

- [x] Reproduce the installed `opencode run` teardown abort with IFCA DeepSeek.
- [x] Add an actual-binary E2E covering planner, two workers, aggregation,
      process exit, snapshot recovery, and final output.
- [x] Keep `orch_run` attached by default; retain explicit background mode for
      persistent TUI/server sessions.
- [x] Show goal, per-workflow elapsed time, per-workflow active agents, and
      total active agents in a compact multi-row prompt indicator.
- [x] Establish `crates/orch-core` with native activity projection, tests, and
      a release benchmark.
- [x] Reject the activity-projection cutover because the Rust prototype was
      slower than Bun/TypeScript on the agreed fixture.
- [x] Keep TypeScript as the complete production runtime and supersede the
      broad Rust migration in ADR-015.
- [x] Retain the Rust crate and comparison benchmark as reproducible research,
      without adding an N-API bridge, native artifact matrix, or runtime
      fallback.

## Follow-on epic: Lead control plane, steering, and hot reload (v0.6)

- [x] Move goal execution out of the lead conversation into a dedicated worker.
- [x] Route worker idle/error events without letting lead idle advance goals.
- [x] Add persisted goal and workflow steering with immediate best-effort delivery.
- [x] Add goal pause/resume/steer/clear and workflow steer controls.
- [x] Inject a bounded live control snapshot into lead system context only.
- [x] Show goal worker state and agent count in the multi-row prompt indicator.
- [x] Count all disjoint token categories, including cache reads and writes.
- [x] Publish atomic bundled generations and reload server/TUI lifecycles.
- [x] Prove the installed server, TUI statusline, reload, steering, recovery,
      and paid/live provider paths end to end.
- [x] Fence the compaction deadlock and reload race with unit and real-server
      E2E coverage, and record the event-ordering contract in ADR-018.
- [x] Rebuild local installations, commit, and push the verified release.

Future native work is not part of this epic. It requires production-like
profiling, a bounded hotspot, a new ADR, full behavioral parity, portable
installation, and a measured win that clears ADR-015's release gate.

## Follow-on epic: Deterministic data workflows (v0.7)

**Status:** Complete

- [x] Add backward-compatible workflow IR v2.
- [x] Add literal-item static `map` fan-out without a planner model.
- [x] Add `{{item}}` and `{{index}}` template bindings.
- [x] Add bounded per-step JSON Schema contracts and local validation.
- [x] Retry invalid model JSON only within an explicit schema retry budget.
- [x] Validate command-step JSON once without rerunning commands.
- [x] Preserve pause, resume, cancellation, recovery, isolation, token, cost,
      duration, concurrency, and agent caps for the new pattern.
- [x] Prove v1 compatibility, v2 validation, map ordering, schema failure and
      retry behavior, real-OpenCode execution, and local hot deployment.
- [x] Record the compatibility boundary in ADR-019 and update BRD, PRD,
      workflow spec, README, and changelog.
