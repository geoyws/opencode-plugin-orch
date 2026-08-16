# ADR-011: Provider-neutral model routing with DeepSeek support

**Status:** Accepted
**Date:** 2026-08-16
**Deciders:** Team

## Context

OpenCode exposes models through provider/model pairs. Users want DeepSeek for
workflow work and goal evaluation, but DeepSeek can be exposed under different
provider IDs and model names depending on local OpenCode configuration.

## Decision

Persist and accept only OpenCode `{ providerID, modelID }` references. Apply
documented precedence at node, workflow, run, plugin, and server-default levels.
Do not hard-code an Anthropic or DeepSeek provider identifier. Examples may show
DeepSeek-shaped references, but operators select the actual entry listed by
their OpenCode model picker.

Evaluator and summarizer models are independently configurable so a cheaper
DeepSeek model can govern expensive worker turns. Missing or unavailable models
fail explicitly or fall back only when the user selected an allowed fallback.

## Consequences

- Orch works with DeepSeek and any other OpenCode-supported provider.
- Model availability remains an environment concern and needs live verification.
- Pricing and token metadata may vary by provider.

## Live receipt

The v0.4 paid live tier ran on 2026-08-16 with
`deepseek/deepseek-v4-pro` through the IFCA-scoped OpenCode provider profile.
All four workflow scenarios passed their objective assertions and independent
LLM-as-judge rubrics. See `docs/evidence/deepseek-v0.4-live.md`.

## References

- `docs/PRD.md`
- ADR-001 model choice for live testing
- ADR-008 tracking OpenCode latest
