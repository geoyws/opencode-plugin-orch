# ADR-014: Rust kernel with TypeScript OpenCode adapters

**Status:** Accepted
**Date:** 2026-08-16
**Deciders:** Orch maintainers and operator

## Context

Orch's deterministic scheduler, state transitions, JSONL projection, budget
checks, template evaluation, and status projection are currently TypeScript.
The operator has directed that Orch be rewritten in Rust for lower CPU and
memory overhead and stronger state-machine correctness.

OpenCode's current plugin ABI loads JavaScript or TypeScript modules and its TUI
plugin ABI renders through OpenTUI/Solid. A pure Rust package therefore cannot
replace either entrypoint. End-to-end workflow latency is also dominated by
provider calls and repository commands, so a language rewrite must demonstrate
native-kernel gains rather than claim that model responses become faster.

The installed CLI E2E additionally proved that process lifetime, not compute
performance, caused workflows to abort: a detached `orch_run` returned, the
one-shot OpenCode process disposed, and the child session failed with
`Aborted`.

## Decision

Retain minimal TypeScript adapters for the OpenCode server hooks/tools and the
OpenTUI/Solid view. Migrate Orch's deterministic kernel to a Rust workspace in
parity-gated slices:

1. shared activity/duration/agent projections and workflow IR validation;
2. event application, snapshots, replay, compaction, and queries;
3. scheduler patterns, budgets, retry decisions, and recovery;
4. goal state machine and evidence-packet construction.

The target integration is an in-process N-API boundary. TypeScript owns SDK
callbacks that create, prompt, inspect, abort, and delete OpenCode sessions;
Rust owns orchestration decisions and durable state. A long-lived sidecar is a
fallback only if Bun/OpenCode N-API compatibility fails. Spawning a new binary
per event is prohibited because its process and JSON overhead would defeat the
performance goal.

Until native parity is proven, the TypeScript implementation remains an
explicit fallback selected at initialization. Each slice requires:

- golden state/event fixtures producing identical Rust and TypeScript output;
- mutation-sensitive unit and actual installed-CLI E2E coverage;
- restart/replay compatibility with existing `.opencode/plugin-orch` data;
- release-mode benchmarks showing at least 2x throughput or 50% lower CPU time
  on the migrated deterministic workload, with no material memory regression;
- all paid DeepSeek workflow receipts remaining green.

`orch_run` is attached by default. It returns only after the run settles so a
one-shot CLI cannot tear down active children. `background: true` remains an
explicit option for persistent TUI/server sessions.

The first 64-run activity-projection prototype did **not** pass the cutover
gate on 2026-08-16: the tracked release build measured roughly 13.5 microseconds
per operation versus 11.7 microseconds for Bun/TypeScript. The production TUI
projection therefore remains TypeScript. This fixture is retained as a warning
against assumed language-level wins; scheduler and persistence slices must be
benchmarked on their own workloads.

## Consequences

- OpenCode and OpenTUI compatibility is preserved through small TypeScript
  entrypoints; "Rust rewrite" refers to the product kernel, not an impossible
  removal of the host ABI adapters.
- Existing state remains readable throughout migration and rollback is a
  configuration change, not a data conversion.
- Native builds must be produced and tested for every supported OS/architecture.
- Performance claims become benchmark-backed. Provider/network latency is
  reported separately from kernel latency.
- Native prototypes that lose their benchmark remain experimental and do not
  add a runtime boundary to production.
- During migration there are two implementations to keep in parity; golden
  fixtures and differential tests are mandatory before deleting TypeScript.

## References

- `docs/PRD.md`
- `EPIC.md`
- `crates/orch-core/`
- ADR-006 workflow redesign
- ADR-012 separate server and TUI entrypoints
- OpenCode plugin and custom-tool documentation
