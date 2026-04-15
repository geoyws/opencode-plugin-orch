# Changelog

All notable changes to this project will be documented in this file.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
This project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- feat: `orch_inbox` tool — durable peer-DM inbox for the team lead, backed
  by a `leadInboxLastSeenAt` cursor on the team record so messages aren't
  lost when the toast scrolls off (66827e6)
- feat: `orch_team` tool — `list` shows all teams with active/total member
  counts and task totals; `info` shows a detailed block for one team
  including members, tasks, and recent messages (aa5e177)
- feat: `orch_log` tool — inspect the current opencode log for plugin
  output. Actions: `tail` (last N matching lines, default 20, max 200),
  `errors` (ERROR-level lines only), `stats` (INFO/WARN/ERROR counts).
  Filters lines containing `[orch]` or `opencode-plugin-orch` (9782410)
- feat: per-team rate limits, `orch_tasks add_many` (sequential,
  partial-success), `reassign` same-member no-op detection, and ADR-004
  closed-allowlist member tool scoping via `client.tool.ids()` lookup
  (90edec4)
- feat: round 7 — snapshot corruption recovery, idle-member monitor,
  broadcast `rolePattern` glob filter, task priority field,
  `orch_result` progress bar (20-char █/░ renderer + JSON progress
  object with `percent` / `completed` / `failed` / `remaining` / `total`),
  `orch_memo append` + `prepend` actions, `orch_tasks add_many` atomic
  mode (two-pass validate-then-commit), and
  `examples/feature-build-demo.md` getting-started walkthrough (a2a1396)
- feat: round 9 — platform-aware log-dir lookup (`resolveLogDir`),
  `tool.execute.before` activity hook, snapshot migration for pre-feature
  members missing `lastActivityAt`, and task dependency visualizer
  (269ce36)
- feat: `orch_tasks add` now accepts task **titles** in `dependsOn`, not
  just IDs. Each entry is tried as an ID first, then as a
  case-insensitive exact title match in the same team. Raw IDs still work
  (aa5e177)
- feat: session revalidation on plugin init — walks non-terminal members
  recovered from snapshot, probes each session via `session.get` with a
  500ms timeout, force-shuts-down dead ones and releases their file locks.
  Optimistic on timeout (treat slow opencode as "alive") (aa5e177)
- feat: peer DM visibility for the team lead. `MessageBus.send` fires a
  TUI toast on member→member DMs (`<from> → <to>: <preview>`); broadcast
  fires one toast per call (`<from> → all (N): <preview>`). Lead-originated
  sends skip the toast (adbbf40)
- feat: `orch_status` gains a "Recent messages:" section — 5 newest peer
  messages by default, 20 untruncated in verbose mode, `(none)` when empty
  (adbbf40)
- feat: `README.md` with install, usage, and tool reference (adbbf40)
- feat: member tool scoping defaults + per-tool rate limiting +
  `orch_tasks unblock` action + `orch_result` JSON schema docs (b8f413a)
- docs: ADR-001 (live-test model choice) and full evidence log of
  `orch_create` / spawn / status / shutdown against a live opencode run
  (0b68d76, 877d2c0)
- ci: GitHub Actions workflow `.github/workflows/test.yml` runs typecheck
  and `bun test` on push + PR to master (aa5e177)
- test: new `tests/revalidation.test.ts` — 4 tests covering dead-session
  cleanup, live-session preservation, timeout fallback, and
  terminal-member skip (aa5e177)

### Changed
- refactor: `MessageBus.broadcast` now stores `from: fromMember?.id ?? "lead"`,
  matching `MessageBus.send`. Previously broadcast stored the role string
  while send stored the member id, making downstream display logic work
  by accident. `orch_status` now resolves the sender by design (adbbf40)
- refactor: removed the `./tui` exports subpath and `src/tui.ts` stub —
  the placeholder confused the plugin-entrypoint story (aa5e177)
- chore: ollama log-noise cleanup so the plugin doesn't spam idle
  ollama models on every event (aa5e177)
- refactor: round 6 — strict-parse tightening on tool inputs after
  reviewer findings (d33a3fa)

### Fixed
- fix: `package.json` `./server` exports subpath so opencode's plugin
  discovery actually resolves the entry. Without it, opencode logged
  `plugin has no server entrypoint` and the 12 `orch_*` tools never
  registered (0b68d76)
- fix: hardening pass from reviewer nits — orphaned init leak,
  `_safe.ts` cwd bug, stack stripping in error reporter (3e7f325)
- fix: round 5 nit fixes — `client.tool.ids()` 500ms timeout to keep a
  hung opencode from blocking spawn, plus a follow-up closed-allowlist
  end-to-end test (7e1c108)
- fix: round 8 nits + `orch_log` initial implementation (9782410)
- fix(ci): skip `tests/e2e.test.ts` in CI where the `opencode` binary
  isn't available (8245a86)

## [0.1.1] - 2026-04-13

### Added
- feat: multi-layer error surfacing so plugin failures are visible and
  never crash the host (84a622f)
  - `Reporter` (src/core/reporter.ts): three-sink reporter — TUI toast,
    opencode `app.log`, and local file at `.opencode/plugin-orch/init.log`.
    Fire-and-forget, can never throw.
  - Plugin init now wraps the full init in a 5-second `Promise.race`
    against a timeout. On failure: error toast + empty hooks so opencode
    keeps working. On success: `[orch] ready · N tools` toast.
  - Hook hardening: `permission.ask` and `tool.execute.after` wrap their
    bodies in try/catch; `permission.ask` leaves status at `"ask"` on
    throw (never silently upgrades to `"allow"`).
  - Tool hardening: every `orch_*` tool returns an `Error: <message>`
    string on throw instead of bubbling.

### Fixed
- fix: address reviewer findings on the hardening pass (3e7f325)
  - Orphaned init leak: late-resolving `doInit()` now calls
    `store.destroy()` via a `.then()` chain on the in-flight promise so
    snapshot timers and signal handlers don't leak past a timeout.
  - `_safe.ts` cwd bug: `logHookError` used `process.cwd()`; now takes a
    `projectDir` arg threaded through the hook factories from
    `input.directory`.
  - Stack stripping: `Reporter.error` now preserves stacks in `app.log`
    and the file log; only the toast gets the short message.
- fix: export `server` as a named export so opencode's plugin discovery
  can resolve it (75ba706)
- fix: don't `await` `app.log` during plugin init — a blocking log call
  could wedge startup (1ea88b4)

### Testing
- test: add 62 integration + e2e tests, pushing coverage to ~98%. Covers
  permission-hook denial paths, tool error-string contract, message-bus
  backpressure, and cross-module e2e flows (6fb465a)

### Chore
- chore: bump version to 0.1.1 (9bb6097)

## [0.1.0] - 2026-04-12

### Added
- feat: initial implementation of opencode-plugin-orch (d7f0173). Foundation:
  - Nine `orch_*` tools: `orch_create`, `orch_spawn`, `orch_message`,
    `orch_broadcast`, `orch_tasks`, `orch_memo`, `orch_status`,
    `orch_shutdown`, `orch_result`
  - Core modules: `Store` (snapshot + JSONL event log), `TeamManager`,
    `MessageBus`, `TaskBoard`, `Scratchpad`, `CostTracker`,
    `FileLockManager`, `EscalationManager`, `ActivityTracker`
  - Hook wiring: `event`, `permission.ask`, `tool.execute.after`
  - Template registry for built-in team templates

### Fixed
- fix: robustness, concurrency, and validation (1f2e8a7)
  - Store: JSONL compaction after snapshot, persist `markDelivered` via
    event log, top-level error boundary in event hook, graceful shutdown
    on process exit
  - Concurrency: CAS for task claim/complete/fail; budget enforcement
    now shuts down members instead of warning; atomic file lock
    acquisition to close a TOCTOU race
  - Validation: `dependsOn` must reference existing task IDs; circular
    dependency detection on add
  - Build: `prepare` script compiles `dist/` on install

### Testing
- test: 258 unit tests across core, communication, hooks, and templates
  (186db70)

[Unreleased]: https://github.com/geoyws/opencode-plugin-orch/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/geoyws/opencode-plugin-orch/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/geoyws/opencode-plugin-orch/releases/tag/v0.1.0
