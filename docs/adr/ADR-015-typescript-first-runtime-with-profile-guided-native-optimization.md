# ADR-015: TypeScript-first runtime with profile-guided native optimization

**Status:** Accepted
**Date:** 2026-08-16
**Deciders:** Orch maintainers and operator
**Supersedes:** ADR-014

## Context

ADR-014 proposed moving Orch's deterministic kernel to Rust while retaining
TypeScript adapters for OpenCode and OpenTUI. The proposal was deliberately
gated on behavioral parity and a measured native performance win.

The first comparable activity-projection benchmark did not pass that gate. A
fresh 100,000-iteration run on the tracked 64-run fixture measured approximately
13.7 microseconds per operation for the Rust release build and 10.3 microseconds
for Bun/TypeScript. Adding an N-API boundary, native artifact matrix, and second
production implementation would therefore increase build, distribution, and
maintenance cost without improving this workload.

OpenCode loads JavaScript or TypeScript plugin entrypoints and the optional TUI
is implemented against OpenTUI/Solid. TypeScript is unavoidable at both host
boundaries. Real workflow latency is primarily provider, network, session, and
repository-command time; changing the scheduler language does not make those
operations faster. Orch is also expected to work consistently across all of an
operator's OpenCode installations, which favors a portable package without
platform-specific native artifacts.

## Decision

Keep the complete production runtime in TypeScript. This includes workflow IR
validation, scheduling, event application, snapshots, replay, compaction,
budgets, goal evaluation, and TUI projections.

Retain `crates/orch-core`, its tests, and the TypeScript comparison benchmark as
an experimental performance fixture. The crate is not linked, loaded, or
shipped as a production runtime dependency. Do not build an N-API bridge,
sidecar protocol, native release matrix, or TypeScript/Rust production fallback
unless profiling first identifies a qualifying hotspot.

A future ADR may propose moving one bounded operation to Rust only when all of
the following are available:

- production-like profiling shows the operation consumes material local CPU or
  memory, separately from model, network, and command time;
- a representative release benchmark demonstrates at least 2x throughput or
  50% lower CPU time, with no material memory regression;
- golden differential tests prove behavioral and persisted-state compatibility;
- installed-CLI, restart/replay, TUI, and paid DeepSeek receipts remain green;
- the measured benefit exceeds the installation, artifact, security, and
  maintenance cost of introducing a native boundary.

Optimize TypeScript first through better algorithms, bounded data, fewer
allocations, incremental projections, and reduced I/O. Language migration is
not itself a performance objective.

## Consequences

- Every supported OpenCode installation uses the same portable TypeScript
  runtime and existing package installation path.
- Goal mode, workflows, compaction, and observability can evolve without
  cross-language parity work or native release coordination.
- The failed Rust cutover remains reproducible evidence rather than being
  deleted or presented as production progress.
- Rust remains available for a narrowly measured future hotspot, but there is
  no standing Rust rewrite or native-kernel migration.
- Performance claims require end-to-end profiling and workload-specific
  benchmarks; language-level expectations are insufficient.

## References

- ADR-012 separate server and TUI entrypoints
- ADR-014 Rust kernel with TypeScript OpenCode adapters
- `bench/activity.ts`
- `crates/orch-core/`
- `docs/PRD.md`
- `EPIC.md`
