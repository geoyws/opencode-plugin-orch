# ADR-012: Separate server and TUI plugin entrypoints

**Status:** Accepted
**Date:** 2026-08-16
**Deciders:** Team

## Context

The workflow engine runs in OpenCode's server plugin target, while goal
indicators and a workflow progress screen belong in the TUI target. OpenCode
requires target-exclusive modules and the product must remain usable from
headless and non-interactive clients.

## Decision

Publish `./server` and `./tui` as separate modules in the same package. The
server remains authoritative for state and mutations. The TUI reads a durable
read model and invokes server-supported operations; it never edits event logs or
snapshots directly. Tools and slash commands provide full fallback operation
without the TUI target.

## Consequences

- OpenCode can show native goal and workflow UI without forking its TUI.
- Packaging and tests must cover two target-specific entrypoints.
- TUI API changes can be isolated from the workflow engine.
- Some controls may initially fall back to slash commands until a stable
  server/TUI control bridge is available.

## References

- `docs/PRD.md`
- OpenCode TUI plugin specification
- ADR-003 plugin entrypoint discovery
