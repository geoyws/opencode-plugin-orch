# ADR-020: Use Orch instead of DeepSeek Harness for goals and workflows

**Status:** Accepted
**Date:** 2026-08-21
**Deciders:** Operator, Team

## Context

The operator needs autonomous goals and multi-agent workflows in OpenCode while
keeping token consumption bounded and the lead conversation available for
steering. In local use, the official DeepSeek Harness consumed substantially
more tokens than was acceptable for this control-plane role. Its orchestration
also duplicates capabilities that Orch already owns: durable goals, validated
workflows, compact checkpoints, explicit budgets, delegated worker sessions,
and live operator steering.

This observation is an operational reason for the product decision, not a
provider benchmark. DeepSeek models remain useful workers, evaluators, and
summarizers when OpenCode exposes them through ordinary provider/model
references.

## Decision

Use Orch as the OpenCode goal and workflow orchestration layer. Do not use or
embed the official DeepSeek Harness to implement `/goal`, workflow execution,
continuation, compaction, or the lead control plane.

Orch remains provider-neutral. It may route work to any model already
configured in OpenCode, including DeepSeek, but it must do so through
OpenCode's provider/model interface and its own token-governed runtime.

Any future DeepSeek Harness integration belongs in a separate optional OpenCode
plugin with separate installation, lifecycle, tests, budgets, and release
artifacts. Orch must not depend on that plugin. Adoption of such a plugin
requires new measured evidence that its additional capability justifies its
token overhead; it cannot silently become the goal or workflow engine.

## Consequences

- OpenCode goals and workflows use Orch's persisted budgets, compact
  checkpoints, bounded prompt assembly, and dedicated workers.
- The main conversation stays a compact control plane instead of inheriting a
  second orchestration transcript.
- Users can still choose DeepSeek for every model role without installing the
  DeepSeek Harness.
- Orch does not gain DeepSeek-Harness-specific runtime or protocol features.
- A separate harness plugin, if built, has an explicit integration and token
  cost that must be evaluated independently.
- The token-efficiency claim must continue to be protected by accounting,
  compaction, budget, and end-to-end regression tests rather than assumed from
  architecture alone.

## References

- `docs/PRD.md`
- `docs/BRD.md`
- `EPIC.md`
- ADR-011 provider-neutral model routing with DeepSeek support
- ADR-013 token budgets and compact checkpoints
- ADR-016 lead control plane and dedicated goal workers

