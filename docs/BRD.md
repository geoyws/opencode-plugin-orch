# Business Requirements Document: OpenCode goals and dynamic workflows

**Status:** Approved, implemented, and live-validated for v0.4
**Date:** 2026-08-16
**Product:** opencode-plugin-orch

## Executive summary

Orch will turn OpenCode into a durable, provider-neutral autonomous-work
environment. Users will be able to set a measurable goal, leave the agent to
continue across turns, and use dynamically authored workflows for work that is
too large or repetitive for one context window. DeepSeek must work as a
first-class worker and evaluator model. Token use must be visible, bounded, and
reduced automatically through compact checkpoints.

## Business problem

Today Orch executes predefined workflow shapes, but users still have to prompt
the lead between turns and manually choose or author workflow definitions.
Long-running work can waste tokens by replaying large outputs, lose momentum
after context pressure, or incur uncontrolled multi-agent spend. The current
tool-only interface also makes active work harder to inspect than a dedicated
progress view.

## Business objectives

1. Remove per-turn supervision for work with a verifiable completion condition.
2. Make large multi-agent work repeatable and inspectable rather than dependent
   on an increasingly large lead context.
3. Let customers use DeepSeek and other OpenCode-supported providers without
   Anthropic lock-in.
4. Reduce avoidable token spend through cheaper evaluators, bounded prompt
   material, cached checkpoints, and explicit budgets.
5. Maintain user control through transparent plans, permissions, pause/resume,
   cancellation, and durable evidence.
6. Keep the runtime portable and operationally simple, optimizing measured
   bottlenecks without imposing an unproven native deployment burden.

## Stakeholders

- Operators running long autonomous coding, migration, review, or research work.
- Repository maintainers responsible for safety and reproducibility.
- Teams choosing DeepSeek for capability, locality, availability, or cost.
- OpenCode plugin users who need CLI/TUI parity and non-interactive automation.

## Business requirements

### BR-1: Goal-directed autonomy

The user can set one active completion condition per lead session. Orch performs
the work in a dedicated worker, independently evaluates its evidence after each
worker turn, and continues until the condition is met, impossible, stalled,
cleared, or budget-limited. The lead remains available for new instructions.

### BR-2: Dynamic and reusable workflows

The user can describe a large task, receive a validated execution plan, run it
in the background, inspect it, control it, and save it for future use.

### BR-3: Provider neutrality and DeepSeek

Every model-bearing operation accepts an OpenCode provider/model reference.
DeepSeek can run the lead, workflow nodes, evaluator, and summarizer. No core
feature may require a Claude-specific model name, API, or response shape.

### BR-4: Token and cost governance

The product provides visible soft/hard budgets, refuses to start work that would
violate a hard budget, and records whether usage is exact, estimated, or
unavailable. Compaction happens automatically before context pressure and must
not discard the durable raw evidence.

### BR-5: Safety and control

Generated workflows execute validated orchestration data, not arbitrary code.
Normal OpenCode permissions remain authoritative. Background auto-approval is
opt-in and clearly disclosed.

### BR-6: Durable continuity

Goals and workflows survive context compaction and process restart. Completed
nodes are not repeated. Recovery status is explicit; interrupted work is never
reported as complete merely because state exists.

### BR-7: Observable progress

Commands, tools, a live lead snapshot, and an optional multi-row TUI show
current work, elapsed time, worker/agent counts, nodes, tokens, budgets, compact
checkpoints, steering, failures, and resulting evidence. The operator can steer
or stop inner work without entering its transcript.

### BR-8: Runtime efficiency and portability

The production runtime remains TypeScript so every supported OpenCode
installation uses the same package and host ABI. Optimize measured hotspots in
TypeScript first. A bounded native implementation is considered only when
production-like profiling identifies material local resource cost, differential
fixtures prove parity, and release benchmarks prove at least 2x throughput or
50% lower CPU time after integration overhead.

### BR-9: Fast local iteration

Local plugin development supports atomic hot reload of both server and TUI code.
A failed build leaves the last working generation active, and reload does not
leak timers, listeners, or stale scoped UI registrations.

### BR-10: Deterministic data workflows

Users can fan a validated workflow out over literal JSON data without paying
for or trusting a planner step. The aggregate receives results in source-item
order even when workers finish out of order. Critical step outputs can declare
small local JSON Schema contracts; invalid model output is retried only within
an explicit bound, while command steps are never repeated for validation.
Existing v1 workflow definitions and persisted plans remain executable.

## Success measures

- A goal can reach a test-backed terminal verdict without manual continuation.
- Dynamic runs complete with bounded concurrency and no unvalidated code
  execution.
- Static map runs preserve source order, enforce agent caps, and recover
  without replaying completed items.
- Structured-output runs never complete a contracted step with invalid JSON.
- DeepSeek passes the opt-in live goal and workflow scenarios.
- Prompt-bound step output is measurably smaller than stored raw output.
- Recovery tests prove completed work is reused and interrupted work is
  truthfully resumed or failed.
- No regression in the existing hermetic test suite.

## Constraints

- OpenCode and provider APIs may change; pin and test supported versions.
- Provider token accounting is not uniform.
- TUI support ships as a separate target-specific plugin entrypoint.
- Paid/live tests remain opt-in and cannot be called ordinary E2E evidence.

## Non-goals

- Provider billing reconciliation.
- Unlimited unattended execution.
- Replacing OpenCode permissions or managed policy.
- Exact behavioral or visual cloning of proprietary implementations.
- Owning or integrating the separate DeepSeek Harness runtime; Orch uses only
  provider/model references that OpenCode already exposes.
