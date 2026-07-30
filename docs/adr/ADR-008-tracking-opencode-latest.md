# ADR-008: Track the latest opencode (experimental APIs included)

**Status:** Accepted
**Date:** 2026-07-28

## Context

opencode releases fast. orch has ridden `@opencode-ai/plugin` / `@opencode-ai/sdk` from 1.3 to 1.18 between 0.1.0 and 0.3.0, and not all of the surface orch depends on is stable:

- Several hooks are explicitly `experimental.*` — the chat-transform hooks, and the workspace API era we evaluated (and declined) in ADR-007.
- Others are de-facto-stable-but-unspecified: `permission.ask`, `tool.execute.*`. They work and have worked for many releases, but opencode has not committed to their shape.
- opencode core could absorb multi-agent orchestration upstream at any time, changing or obsoleting the ground orch builds on.

Every opencode upgrade is therefore a potential breaking event for the plugin, regardless of what the SDK packages' semver says. The question is whether we brace for that or pretend it away.

## Decision

**Track the latest opencode, and keep using experimental/unspecified APIs knowingly.** Concretely:

1. orch is built and tested against the latest opencode release. When a new opencode version breaks something, we **fix forward** and cut a new orch release — we do not pin to an old opencode, and we do not avoid an API merely because it is experimental.
2. Dependencies on `@opencode-ai/*` stay caret-ranged so users pick up compatible releases.
3. The tier-1/2 e2e suite (real opencode server, mock provider) is the **drift canary**: run it against each new opencode release to detect breakage. The `ORCH_LIVE=1` judged live suite is the **pre-release gate** before shipping an orch release.
4. Users on older opencode versions are unsupported. The README's compatibility section tells users to keep opencode and the plugin current together.

## Consequences

**Positive.**

- orch is always compatible with the opencode its users actually run — the latest one — instead of a version they have long since upgraded past.
- New platform capabilities are available to the plugin immediately; there is no lag waiting for APIs to be declared stable (which may never happen).
- Breakage becomes a routine, mechanical chore — run the e2e suite against the new opencode, fix what it flags, release — rather than a surprise discovered by users.

**Negative.**

- **Users on old opencode versions are unsupported.** If you cannot upgrade opencode, you cannot run a current orch.
- **Release treadmill.** Each opencode upgrade means: run the e2e suite, fix what breaks, release. Skipping the canary step means users find the breakage first.
- **Experimental APIs can change without notice**, so breakage can arrive between our releases no matter how disciplined the canary is. Caret deps mean the SDK moves under us too.

## Alternatives considered

- **Pin to a known-good opencode version.** Rejected: users upgrade opencode whether we like it or not — opencode is the host application and most setups track it closely. A pinned plugin just becomes a broken plugin with a support burden and a migration backlog when the pin finally moves.
- **Avoid experimental hooks entirely.** Partially rejected: the policy is to take experimental hooks only where the payoff is real, and we have declined experimental surface before — ADR-007 chose raw git worktrees over `experimental_workspace` because the runner needed lifecycle control a TUI-facing registry doesn't offer. But a blanket "stable APIs only" rule would cost capabilities the workflow engine genuinely needs (`permission.ask` for autonomous step sessions being the clearest case), in exchange for a stability promise the unspecified-but-stable hooks can't actually give either.

## References

- [ADR-007](ADR-007-worktree-isolation-and-autonomy.md) — raw git worktrees over `experimental_workspace`: the precedent for weighing experimental APIs case by case rather than categorically.
- [ADR-003](ADR-003-plugin-entrypoint-discovery.md) — plugin entrypoint discovery; the load path every opencode upgrade must keep working.
- **User-facing policy**: the Compatibility section of [`README.md`](../../README.md).
