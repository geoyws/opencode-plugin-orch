# ADR-013: Token budgets and compact checkpoints

**Status:** Accepted
**Date:** 2026-08-16
**Deciders:** Team

## Context

Autonomous goals and multi-agent workflows can spend tokens indefinitely and
repeatedly inject large intermediate outputs. Context compaction that exists
only inside a provider conversation is not sufficient for durable restart or
cross-session workflow execution.

## Decision

Track observed token usage at goal, run, node, and model levels. Support soft
and hard budgets. A soft threshold creates a compact checkpoint; a hard
threshold prevents new work and records a budget-exhausted outcome.

Persist raw outputs separately from prompt-bound summaries. Later prompts use
only explicitly referenced, size-capped material. Compact checkpoints record
objective, decisions, evidence, completed work, blockers, next work, repository
state, and usage. Prefer a separately configurable low-cost summarizer/evaluator
model. Mark usage as unknown when the provider does not report it.

For session goals, retain a bounded set of accounted assistant-message IDs and
add only newly observed usage. This keeps totals monotonic when OpenCode
summarization replaces older transcript messages. If a provider omits stable
message IDs, retain the maximum visible transcript total rather than claiming
precise incremental accounting.

## Consequences

- Runaway spend is bounded and visible.
- Recovery needs far fewer tokens than transcript replay.
- Summaries can omit details, so raw evidence must remain inspectable.
- Token counts are exact only where OpenCode/provider metadata supplies them.

## References

- `docs/PRD.md`
- `EPIC.md`
- ADR-006 workflow redesign
