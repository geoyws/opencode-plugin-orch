# ADR-009: Session-scoped goal controller

**Status:** Superseded by ADR-016
**Date:** 2026-08-16
**Deciders:** Team

## Context

OpenCode normally returns control after an assistant turn. Long tasks therefore
need repeated user prompts even when a measurable completion condition already
exists. Workflow evaluator loops operate in child sessions and cannot directly
manage the lifecycle of the initiating OpenCode session.

## Decision

Add a goal controller keyed by OpenCode session ID. It registers `/goal` and
`orch_goal`, persists one active goal per session, observes `session.idle`, and
uses an ephemeral evaluator session to return `met`, `not_met`, or `impossible`.
A `not_met` verdict originally submitted a bounded continuation prompt to the
original session. ADR-016 replaces that behavior with a dedicated worker while
retaining this ADR's independent evaluator and bounded lifecycle.

A goal turn is one completed worker-idle to independent-evaluator cycle, not a
raw model loop or streaming step. Productive goals have no hard turn ceiling by
default. The primary loop bound is three consecutive `not_met` goal turns with
no fresh assistant tool activity since the prior evaluation, with the wall-clock
budget as a backstop. Message IDs identify fresh activity across transcript
growth and compaction; when a provider omits them, only the latest assistant
response is attributable to the completed turn. `maxTurns` remains an explicit
optional compatibility ceiling and stops before another worker continuation.

The controller enforces turn, time, token, cost, and no-progress limits. It
ignores evaluator and workflow-step sessions and will not evaluate while tracked
child work remains active.

## Consequences

- Users no longer need to prompt between goal turns.
- Completion is judged by a separate context rather than the worker itself.
- Goal state and evaluator sessions add lifecycle and recovery complexity.
- Permission prompts can still pause unattended work by design.

## References

- `docs/PRD.md`
- `EPIC.md`
- OpenCode session and command plugin APIs
