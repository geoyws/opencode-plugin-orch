# ADR-010: Execute validated workflow IR instead of generated JavaScript

**Status:** Accepted
**Date:** 2026-08-16
**Deciders:** Team

## Context

Dynamic workflows need branches, fan-out, maps, evaluator loops, and reusable
plans. Evaluating model-generated JavaScript in the OpenCode process would grant
ambient filesystem, process, environment, and network access and make resource
limits difficult to prove.

## Decision

Models author a strict, versioned workflow intermediate representation. Orch
validates it, resolves bounded control nodes, persists the immutable plan, and
executes it through the existing runner. Templates and data references use a
restricted language. Arbitrary JavaScript, imports, `eval`, `Function`, `vm`,
and unbounded loops are forbidden.

A human-readable JavaScript-like rendering may be produced for explanation, but
it is not executable authority. Saved workflows persist the validated IR.

## Consequences

- Generated plans cannot escape through the orchestration layer.
- Agent count, concurrency, and iteration limits are statically enforceable.
- The IR is less expressive than general JavaScript and requires explicit node
  types for new patterns.
- Migrations are needed when the IR schema changes.

## References

- `docs/PRD.md`
- ADR-006 workflow redesign
- ADR-007 worktree isolation
