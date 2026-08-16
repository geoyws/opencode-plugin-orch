# Changelog

All notable changes to this project will be documented in this file.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
This project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### v0.4 goal mode and dynamic workflows

- Added `/goal` and `orch_goal`: session-scoped durable conditions,
  evidence-only independent evaluation, automatic continuation on `not_met`,
  `met` / `impossible` outcomes, and turn/time/token/cost/no-progress limits.
- Added automatic goal-session compaction and deterministic workflow
  checkpoints. Provider usage remains `unknown` when not reported; raw outputs
  remain durable while later prompts receive bounded material. Goal accounting
  stays monotonic across transcript replacement when provider message IDs are
  available.
- Added version 1 validated workflow IR authoring through
  `/workflow-author`, `/workflow-run`, saved-workflow slash commands, and
  `orch_workflows validate|save`. Writes are atomic and symlink-refusing;
  shell/gate persistence requires explicit `allowShell` authorization.
- Added provider-neutral DeepSeek routing for workers, steps, goal evaluators,
  and summarizers through `{providerID, modelID}` references.
- Added `orch_control` pause/resume/retry/cancel. Interrupted runs recover as
  paused, abort orphaned sessions, reuse completed steps, and resume unfinished
  work.
- Added observed token/cost budgets (`maxTokens`, `softTokens`, `maxCost`),
  per-step usage receipts, compact checkpoint status, and the
  `budget_exhausted` terminal state.
- Added a separate `./tui` target with a session goal badge and read-only,
  auto-refreshing goal/workflow dashboard backed by an event-updated atomic
  read model.
- Added a persistent prompt-side Orch activity indicator showing the active
  goal plus running/paused workflow counts and documented the required
  `tui.json` registration.
- Added BRD, PRD, root epic, ADR-009 through ADR-013, and hermetic unit/server
  coverage for the new lifecycle paths.
- Live-validated all four paid workflow scenarios with
  `deepseek/deepseek-v4-pro` through the IFCA-scoped provider profile.

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
- fix: thread `query.directory` into every opencode SDK call (session
  create/prompt/promptAsync/abort/get, file.read, tool.ids) so sessions
  route to the plugin's project directory. Without it, opencode's server
  routed calls to a fallback project in git worktrees, which caused
  code-type members to spawn and immediately die with `state: "error"`
  (their custom `"code"` agent config lived in the worktree dir the
  server never looked at). Built-in agents like `"plan"` survived
  because they resolve regardless of the routed project. Adds
  `tests/directory-routing.test.ts` as a regression fence

## [0.3.0] - 2026-07-28

Worktree isolation for parallel workers, shell steps and programmatic
gates, adversarial review, and autonomous step-session permissions. See
[ADR-007](docs/adr/ADR-007-worktree-isolation-and-autonomy.md) and
[docs/spec-v0.3-addendum.md](docs/spec-v0.3-addendum.md).

### Added
- feat: worktree isolation — `isolation: "worktree"` on a workflow def or
  run config (run config wins) runs parallel/orchestrator fan-out steps in
  per-step git worktrees at
  `<project-parent>/.orch-worktrees/<project>/<run-id>/<step-id>`, copies
  changes back on success (last-finisher-wins, conflicts recorded in step
  metadata), and falls back to the main directory with
  `isolationFallback: true` when `git worktree add` fails. Worktree
  sessions use a 2s `session.messages` poll fallback for completion
  detection since cross-instance events aren't guaranteed
- feat: shell steps — a step may set `command` instead of `instructions`
  to run a shell command (`/bin/sh -c` in the project dir or the step's
  worktree, shares `stepTimeoutMs`, combined stdout+stderr is the step
  output, non-zero exit fails the step, no LLM session)
- feat: programmatic gates — evaluator workflows may set
  `gate: { command }`; the gate runs in the project dir after each
  generator iteration and exit 0 ends the loop, with the last ~4000 chars
  of failing output fed back as `{{feedback}}`. Run config `gateCommand`
  overrides the workflow's gate at run time
- feat: three new built-ins (now 8 total) — `adversarial-review`
  (evaluator; adversarial critic attacks the deliverable until it finds
  nothing, max 4 iterations), `author-tests` (orchestrator with
  `isolation: "worktree"`; planner splits disjoint test-authoring areas
  across workers), `test-fix-loop` (gate-only evaluator, default gate
  `npm test`, max 5 iterations)
- feat: run config `stepModels` — per-step model override; resolution
  `stepModels[step.id] ?? step.model ?? config.model ?? server default`
- feat: run config `maxStepOutputChars` (default 50000, min 1000) — caps
  step-output text injected into subsequent prompts with a
  `\n[... truncated N chars]` marker; full outputs stay in the store
- feat: autonomous step-session permissions — the `permission.ask` hook
  auto-allows runner-tracked step sessions except git-mutating bash
  commands (`commit` / `push` / `merge` / `rebase` / `reset --hard` /
  `clean` / `stash` / `cherry-pick` / `revert` / `branch -d/-D/-m/-M` /
  `tag -d` / `checkout` / `switch` / `restore` / `worktree remove`), which
  are denied. Non-step sessions are untouched; `ORCH_STEP_PERMISSIONS=ask`
  disables the auto-allow
- feat: session teardown — ephemeral step sessions are deleted
  (`session.delete`, best-effort) when their step settles (success, failure,
  cancel, timeout, `session.error`), after the output was extracted. Runs
  left `running` across a restart get their orphaned step sessions aborted
  and deleted on plugin init. Run config `keepSessions: true` (default
  false) opts out of deletion for debugging
- feat: run config `stepRetries` (int 0–3, default 1) — retries an LLM
  step when its session fails with a transient error (rate limit / 429 /
  overload / network / 502–504 class), with 5s backoff and a fresh session
  per attempt. Command steps, gates, timeouts, cancels, and non-transient
  errors are never retried; after exhaustion the failure message reads
  "…after N attempts". Step records gain `attempts`
- feat: `stepPermissions` plugin option — the opencode.json plugin entry
  accepts tuple form
  `["../../work/src/opencode-plugin-orch", { "stepPermissions": "ask" }]`.
  `"ask"` disables the step-session auto-allow (same effect as
  `ORCH_STEP_PERMISSIONS=ask`; either one disables), `"auto"` (default)
  keeps the current behavior, unknown values warn and fall back to auto

### Changed
- refactor: evaluator critic step (`steps[1]`) is now optional when a
  `gate` is configured — gate-only evaluators are valid
- feat: `step_completed` step records gain optional `copiedFiles`,
  `conflicts`, and `isolationFallback` fields

## [0.2.0] - 2026-07-28

Breaking redesign: orch stops being a "team of persistent members" plugin and
becomes a workflow engine implementing the patterns from Anthropic's
"Building effective agents" essay. See
[ADR-006](docs/adr/ADR-006-workflows-redesign.md) and
[docs/workflow-spec.md](docs/workflow-spec.md).

### Added
- feat: workflow engine — a run executes a workflow definition as a set of
  ephemeral opencode sessions (one per step invocation), driven by the
  `session.idle` / `session.error` event hook. Five built-in workflows:
  `chain-draft-refine` (chain), `route-by-intent` (routing),
  `parallel-review` (parallel), `orchestrate-tasks` (orchestrator-workers),
  `evaluator-loop` (evaluator-optimizer)
- feat: custom workflow definitions as JSON in `.opencode/workflows/*.json`,
  validated by the same Zod schema as the built-ins; prompt templates support
  `{{input}}`, `{{output}}`, `{{steps.<id>.output}}`, `{{feedback}}`
- feat: four new tools — `orch_run` (start a run, optional JSON `config`
  override: model / maxIterations / concurrency), `orch_workflows` (list /
  info definitions), `orch_runs` (list runs newest-first), `orch_cancel`
  (abort in-flight step sessions, replaces `orch_shutdown`)
- feat: event-sourced run store — new event types (`run_created`,
  `step_started`, `step_completed`, `step_failed`, `run_completed`,
  `run_failed`, `run_cancelled`) over the existing JSONL + atomic snapshot +
  replay design. On plugin init, runs left `running` are marked failed
  ("plugin restarted"); runs are not resumed across restarts in 0.2.0

### Changed
- refactor: `orch_status` and `orch_result` keep their names and run-id
  prefix matching but now report on workflow runs instead of teams
- chore: bump `@opencode-ai/plugin` and `@opencode-ai/sdk` to ^1.18.7
- chore: package cleanup — remove `bin` (no more CLI/tmux/Discord), remove
  `peerDependencies`/`peerDependenciesMeta` (@opentui unused); description
  now reflects the workflow engine

### Removed
- refactor!: the entire team-orchestration model — persistent members,
  message bus, task board, file locks, scratchpad, cost tracker, escalation
  chains, activity tracking, session revalidation, rate limiting, idle/whip
  monitors, Discord notifier, and the `orch` CLI
- refactor!: nine team tools — `orch_create`, `orch_spawn`, `orch_message`,
  `orch_broadcast`, `orch_tasks`, `orch_memo`, `orch_shutdown`,
  `orch_inbox`, `orch_team`. Tool surface drops from 12 to 7
- refactor!: built-in team templates (`code-review`, `feature-build`,
  `debug-squad`) and the custom-template loader
- docs: ADR-002 (lead visibility), ADR-004 (member tool scoping), ADR-005
  (rate limiting) — superseded by the redesign, deleted with their evidence
  logs

### Kept
- `orch_log` tool (unchanged), the hardened plugin init (5s timeout +
  multi-sink Reporter + wrapped hooks/tools), and the `./server` entrypoint
  exports subpath (ADR-003)

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

[Unreleased]: https://github.com/geoyws/opencode-plugin-orch/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/geoyws/opencode-plugin-orch/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/geoyws/opencode-plugin-orch/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/geoyws/opencode-plugin-orch/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/geoyws/opencode-plugin-orch/releases/tag/v0.1.0
