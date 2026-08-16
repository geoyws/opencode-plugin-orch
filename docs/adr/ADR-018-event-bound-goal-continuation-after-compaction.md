# ADR-018: Event-bound goal continuation after compaction

**Status:** Accepted
**Date:** 2026-08-16
**Deciders:** Team

## Context

OpenCode compaction is a model turn with its own busy/idle lifecycle. Its
`session.summarize` request can remain pending until that lifecycle settles. If
Orch awaits the request inside the worker's idle hook, the hook cannot return
to process the post-compaction idle event and the goal's `not_met`
continuation can be stranded.

Hot reload adds a second race: the compaction turn may finish after the old
plugin instance is disposed but before the new instance subscribes to session
events. Relying only on an in-memory callback therefore cannot guarantee goal
continuation.

## Decision

Before requesting compaction, Orch durably stores the evaluator continuation,
the observed token boundary, and `workerStatus: "compacting"`. It then releases
the idle-hook evaluation guard and starts `session.summarize` without awaiting
that request in the hook.

The next idle event for that worker atomically consumes the persisted
continuation, records the compaction token boundary, and starts exactly one new
worker turn. A compaction error pauses the goal with an explicit reason instead
of silently continuing against an uncertain session.

On plugin initialization, Orch queries OpenCode's session-status registry for
persisted compacting goals. Busy or retrying workers remain untouched. An idle
worker, represented by an explicit idle status or absence from OpenCode's
non-idle status map, consumes the pending continuation. A status-query failure
leaves the durable continuation intact and defers recovery rather than risking
a concurrent prompt.

Steering remains durable during compaction and is included in the released
continuation. It is not injected as a concurrent model turn.

## Consequences

- Compaction cannot deadlock the callback required to continue a goal.
- Goal continuation survives plugin hot reload and process restart at the
  compaction boundary.
- The TUI can truthfully display a distinct `compacting` worker state.
- Continuation is delayed until OpenCode reports the worker idle; this is an
  intentional ordering guarantee, not extra latency to optimize away.
- Correct recovery depends on OpenCode's session-status and idle-event
  contracts, which remain covered by real-server E2E tests under the project's
  fix-forward compatibility policy.

## References

- `docs/PRD.md`
- `EPIC.md`
- ADR-008 tracking OpenCode latest
- ADR-013 token budgets and compact checkpoints
- ADR-016 lead control plane and dedicated goal workers
- [OpenCode issue 5449: `session.summarize` may hang from a plugin](https://github.com/anomalyco/opencode/issues/5449)
- [OpenCode compaction implementation](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/session/compaction.ts)
- [OpenCode session-status implementation](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/session/status.ts)
