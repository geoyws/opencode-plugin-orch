# ADR-019: IR v2 static map and structured outputs

**Status:** Accepted
**Date:** 2026-08-21
**Deciders:** Team

## Context

Workflow IR v1 deliberately deferred two capabilities: a deterministic map
that does not ask a planner model to invent tasks, and machine-checkable step
outputs. Both are needed for repeatable data pipelines and for safely passing
model results into later workflow nodes.

OpenCode SDK 1.18.18 exposes `format: { type: "json_schema", ... }` on its v2
prompt client, but the server-plugin `PluginInput.client` remains the v1 client
whose prompt body has no portable `format` field. Sending an undocumented field
would make Orch dependent on an implementation accident and would not work
across the OpenCode versions the plugin currently supports.

## Decision

Introduce workflow IR version 2 while continuing to parse and execute version
1 definitions unchanged.

IR v2 adds:

- a `map` pattern with a literal JSON `items` array, exactly one model-worker
  template step, and a required aggregate step;
- `{{item}}` and `{{index}}` restricted template placeholders;
- an optional per-step `output` contract containing a JSON Schema and a
  bounded `retryCount`.

Static map items are validated data in the immutable resolved plan. Orch
creates one ephemeral worker per item, bounds them with the existing
`concurrency` and `maxAgents` limits, preserves input order, supports the
existing worktree-isolation policy, and appends named results to the aggregate
prompt. No planner session is involved.

Map worker templates use `instructions`, not shell `command`. Orch does not
interpolate item data into `/bin/sh -c`; a future command map would require a
typed argv/environment boundary rather than textual shell substitution.

Structured output remains provider-neutral. Orch appends the schema and a
JSON-only instruction to the prompt, parses the returned text as JSON, and
validates it locally with Zod's JSON-Schema converter before completing the
step. Invalid model output may be retried only up to the step's declared
`retryCount`; command steps are validated once and are never rerun merely for a
schema mismatch. Schemas are bounded to 32 KiB and may not use `$ref`; Orch
never fetches remote schemas. Raw valid JSON text remains the stored step
output.

When `PluginInput.client` exposes the same documented structured-format
contract as the v2 client, Orch may additionally pass the schema provider-side
behind a capability check. Local validation remains authoritative.

## Consequences

- Fixed fan-out jobs no longer spend a model call or accept planner drift.
- Downstream steps can rely on validated JSON instead of prompt conventions.
- Existing v1 workflows and snapshots remain valid without migration.
- A model may spend extra bounded attempts correcting invalid JSON.
- The supported JSON-Schema subset is intentionally smaller than the complete
  specification because references and remote resolution are excluded.
- Provider-side token ceilings and provider-side schema enforcement remain
  unavailable through the current server-plugin client.

## References

- `EPIC.md`
- `docs/PRD.md`
- `docs/workflow-spec.md`
- ADR-010 validated workflow IR
- ADR-011 provider-neutral routing
- OpenCode SDK 1.18.18 v1 and v2 generated prompt types
