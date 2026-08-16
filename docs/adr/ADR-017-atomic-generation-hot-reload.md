# ADR-017: Atomic generation hot reload

**Status:** Accepted
**Date:** 2026-08-16
**Deciders:** Team

## Context

OpenCode caches imported plugin modules. Rebuilding `dist/` in place and
disposing an instance therefore reloads a cached module graph, not necessarily
the new code. Server and TUI plugins also have separate lifecycles: the server
can dispose a project instance, while the TUI must deactivate its scoped
registrations before activation.

## Decision

Compile declarations and normal JavaScript with TypeScript, then bundle the
server and TUI implementations into uniquely named generation artifacts under
`dist/.hot/`. Atomically rename a manifest only after both bundles succeed.
Stable package entrypoints read that manifest and dynamically import the named
generation, avoiding stale transitive imports.

`pnpm dev` watches `src/`, debounces changes, and publishes only successful
generations. A loaded server wrapper watches the manifest and asks OpenCode to
dispose its project instance; the next request recreates it from the new
generation. The TUI wrapper watches the same manifest, deactivates its scoped
registrations, and reactivates itself. Cleanup is idempotent and removes signal
listeners and timers so repeated reloads do not accumulate resources.

The last successful generation remains active when typecheck or bundling fails.
The builder retains the current and immediately previous generations. This
closes the race where a reader captures the old manifest just before the atomic
switch and imports its bundle just afterward; older generations are pruned.

## Consequences

- Server logic and statusline/TUI changes reload without restarting OpenCode.
- Hot reload uses public instance disposal and TUI lifecycle APIs, but still
  depends on their current OpenCode behavior and requires E2E coverage.
- Every package build produces bundled generation artifacts in addition to the
  normal TypeScript output.
- Active workflows recover at a safe paused boundary on server disposal; hot
  reload does not pretend in-flight model work completed.

## References

- `docs/PRD.md`
- `EPIC.md`
- ADR-003 plugin entrypoint discovery
- ADR-008 tracking OpenCode latest
- ADR-012 separate server and TUI entrypoints
