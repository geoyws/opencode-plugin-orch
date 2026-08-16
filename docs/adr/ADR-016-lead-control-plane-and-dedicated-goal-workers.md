# ADR-016: Lead control plane and dedicated goal workers

**Status:** Accepted
**Date:** 2026-08-16
**Deciders:** Team
**Supersedes:** ADR-009 continuation in the initiating session

## Context

Continuing a goal in the initiating OpenCode session made that conversation do
two incompatible jobs: long-running implementation and low-latency operator
control. Tool traces, intermediate evidence, compaction, and retries crowded out
new instructions. The lead also lacked a fresh view of workflow state, so it
could neither explain what its inner agents were doing nor reliably steer them.

## Decision

Treat the initiating OpenCode session as an Orch lead/control plane. Substantive
goal work runs in a dedicated persisted worker session. Only the worker's idle
event triggers independent evaluation; lead idle events never advance a goal.
On `not_met`, the evaluator reason is sent back to the worker, not the lead.

Inject a compact dynamic system snapshot on every lead turn. It includes active
goals and workflows, elapsed time, worker state, active-agent counts, tokens,
steps, the last verdict, and latest steering. Workflow-step, goal-worker, and
evaluator sessions are excluded from this lead instruction.

Persist operator steering in goal and run state. Deliver it immediately to
active model sessions when possible and include it in future worker prompts.
Expose goal pause/resume/steer/clear and workflow pause/resume/steer/cancel
through the existing tools. Clearing a goal aborts and deletes its worker.

Orch tracks only sessions that it owns. The lead delegates open-ended work with
`orch_goal action=set` and structured work with `orch_run`; arbitrary OpenCode
task sessions are outside Orch's durable control surface.

## Consequences

- The main conversation remains responsive to status questions and redirection.
- A restart or compaction does not erase steering or delegated-work awareness.
- Goal lifecycle now owns an additional session and must handle abort, error,
  evaluation, and replacement races explicitly.
- Dynamic system injection depends on OpenCode's experimental system-transform
  hook and follows ADR-008's fix-forward compatibility policy.
- In-flight shell commands cannot consume a textual steering message; the note
  applies at the next model boundary. Cancellation remains the immediate stop.

## References

- `docs/PRD.md`
- `docs/BRD.md`
- `EPIC.md`
- ADR-008 tracking OpenCode latest
- ADR-009 session-scoped goal controller
- ADR-013 token budgets and compact checkpoints
