# ADR-009: Session-scoped goal controller

**Status:** Accepted
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
A `not_met` verdict submits a bounded continuation prompt to the original
session. Goal continuation does not change that session's permission policy.

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
