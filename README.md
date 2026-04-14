# opencode-plugin-orch

Agent team orchestration plugin for [OpenCode](https://opencode.ai). Lets a lead AI session spawn parallel teammates, coordinate via message passing, share a task board, and synthesize the results — without forking opencode.

## What it does

Adds 9 tools to your opencode session:

| Tool | Purpose |
|---|---|
| `orch_create` | Create a new team, optionally from a built-in template |
| `orch_spawn` | Spawn a member in its own opencode session, with optional file-context seeding |
| `orch_message` | Send a message to a specific member (auto-wakes them if idle) |
| `orch_broadcast` | Send a message to every active member |
| `orch_tasks` | Manage the task board — list, add, claim, complete, fail, with deps |
| `orch_memo` | Shared scratchpad — key/value notes members share to avoid duplicate work |
| `orch_status` | Powerline-formatted team overview (state, activity, cost) |
| `orch_shutdown` | Abort a single member or the whole team |
| `orch_result` | Aggregate completed-task outputs in summary / detailed / json format |

Features:

- **Event-driven coordination** — `session.idle` auto-delivers pending messages, runs work-stealing, releases file locks.
- **Git safety** — the `permission.ask` hook hard-denies all git-mutating commands (commit, push, merge, rebase, reset, clean, stash, cherry-pick, revert, branch -d/-D/-m, tag -d, checkout, switch, restore) from member sessions. Only the lead commits. Read-only git is allowed.
- **Soft file locks** — members can't stomp on each other's edits; locks release automatically on idle.
- **Work stealing** — idle members auto-claim available tasks (configurable).
- **Cost tracking + budget enforcement** — per-member/per-team spend tracked from assistant messages; budget overrun auto-shuts the team down.
- **Model escalation** — configurable retry chain (e.g. haiku → sonnet → opus) on member errors.
- **Crash recovery** — event-sourced JSONL store with periodic snapshot + replay.
- **Hardened error surfacing** — plugin init is wrapped in a 5-second timeout with a multi-sink Reporter (TUI toast → opencode app.log → local `init.log`). All hooks and tools are wrapped so throws can't break opencode. On startup you see `[orch] ready · 9 tools` as a success toast.

## Installation

### Option 1: Local checkout (current recommended)

Clone the repo to a path under `$HOME`, build, and reference it from your opencode config.

```bash
mkdir -p ~/work/src
git clone git@github.com:geoyws/opencode-plugin-orch.git ~/work/src/opencode-plugin-orch
cd ~/work/src/opencode-plugin-orch
pnpm install
pnpm run build
```

Then add to `~/.config/opencode/opencode.json`:

```json
{
  "plugin": ["../../work/src/opencode-plugin-orch"]
}
```

**Important**: the path is relative, not absolute. Opencode resolves it against the config file's own dirname (`~/.config/opencode/`), which gives `$HOME/work/src/opencode-plugin-orch` on both macOS and Linux. An absolute path would only work on one machine.

### Option 2: npm (not published yet)

`pnpm add opencode-plugin-orch` would normally be the way, but this package is not published to npm yet. Use Option 1.

## Cross-machine setup

The plugin config lives in opencode's global config file. If you sync dotfiles between machines (as I do between macOS and a Linux server), the relative path `../../work/src/opencode-plugin-orch` keeps the plugin working on both sides as long as:

1. The repo is cloned at `~/work/src/opencode-plugin-orch` on both machines.
2. `pnpm install && pnpm run build` has been run on both machines to produce `dist/`.
3. `~/.config/opencode/opencode.json` is the same file (or symlink) on both machines.

There is no platform-specific code path — the resolved absolute path just happens to be `/Users/<you>/work/src/...` on macOS and `/root/work/src/...` on Linux, but both point at a valid checkout.

## Verifying it works

After installing, run a one-shot opencode command from any directory:

```bash
opencode run --model <your-model> "Call orch_create with name='smoke-test'. Report the tool response."
```

You should see the tool-use chain resolve to:

```
Team "smoke-test" created (id: team_xxxxx)
```

Check the newest opencode log for startup confirmation:

```bash
# macOS:   ~/Library/Application Support/opencode/log
# Linux:   ~/.local/share/opencode/log
LOG_DIR="$HOME/.local/share/opencode/log"  # or the macOS path
ls -t "$LOG_DIR" | head -1 | xargs -I{} grep -E "orch|plugin" "$LOG_DIR/{}"
```

Required signals:

- `service=plugin path=file:///…/opencode-plugin-orch loading plugin`
- `service=opencode-plugin-orch [orch] ready · 9 tools`
- **Zero** `plugin has no server entrypoint` warnings.

If you see `plugin has no server entrypoint`, `dist/` is either missing or stale — re-run `pnpm install && pnpm run build`.

## Using it

Just talk to your lead model in natural language — the 9 `orch_*` tools are in its toolbelt. Some things to try:

### Manual team with two members

> "Create a team called `bug-hunt`. Spawn an investigator (agent: plan) to trace why `src/auth.ts` is failing tests, and a fixer (agent: code) to implement fixes once the investigator finds the root cause. Pre-load `src/auth.ts` and `tests/auth.test.ts` into both their contexts."

### Template-based team

> "Create a `code-review` team called `pr-review` to review the current git diff."

Built-in templates:

| Template | Members | Purpose |
|---|---|---|
| `code-review` | reviewer (plan) + fixer (code) | Review a diff, file fix tasks, apply them |
| `feature-build` | architect (plan) + 2 coders + tester | Design and implement a feature end to end |
| `debug-squad` | investigator + fixer + verifier | Trace a bug, fix it, verify the fix |

### Monitoring + teardown

> "Show orch_status for `pr-review`" — powerline view with member state, activity, cost
> "Get orch_result for `pr-review` in detailed format" — aggregated task outputs
> "Shut down the pr-review team"

### Advanced: budget cap + escalation chain

```
"Create a team called `safe-explore` with a budget limit of $0.50 and escalation
 chain anthropic/haiku → anthropic/sonnet → anthropic/opus, maxRetries 1."
```

Budget overruns auto-shut the team down. Member errors retry with increasingly capable models.

## Development

```bash
pnpm install            # install deps
pnpm run build          # compile to dist/
pnpm test               # run the 334-test suite
pnpm run typecheck      # tsc --noEmit
```

The test suite is at `tests/`:

- `core.test.ts` — pure logic (state machine, task board, file locks, store persistence)
- `communication.test.ts` — bus, scratchpad, cost tracker, escalation, activity
- `hooks-templates.test.ts` — permission hook (git safety), activity hook, templates
- `tools.test.ts` — integration tests for all 9 `orch_*` tools
- `events.test.ts` — event hook integration (session.idle, session.error, budget)
- `e2e.test.ts` — true end-to-end against a real in-process opencode server via `createOpencode()`

Coverage is ~98% lines, ~99% functions.

## Architecture

```
src/
├── plugin.ts                  # entry point — wraps init in a 5s timeout + error boundary
├── index.ts                   # exports the plugin module (named `server` export)
├── core/
│   ├── team-manager.ts        # team + member lifecycle
│   ├── member.ts              # state machine (initializing → ready → busy → ready)
│   ├── message-bus.ts         # inter-member messaging with backpressure
│   ├── task-board.ts          # task CRUD with deps, CAS claiming, work stealing
│   ├── file-locks.ts          # soft file locking
│   ├── scratchpad.ts          # key-value memo store
│   ├── cost-tracker.ts        # per-member spend tracking
│   ├── escalation.ts          # model retry chain
│   ├── activity.ts            # in-memory tool-activity tracking
│   └── reporter.ts            # multi-sink error/status reporter
├── hooks/
│   ├── events.ts              # session.idle / session.error / message.updated
│   ├── permissions.ts         # git safety + file lock enforcement
│   ├── activity-tracker.ts    # tool.execute.after
│   └── _safe.ts               # shared hook-throw logger
├── state/
│   ├── store.ts               # JSONL event log + snapshot + replay
│   └── schemas.ts             # Zod schemas
├── tools/
│   ├── create.ts / spawn.ts / message.ts / broadcast.ts
│   ├── tasks.ts / memo.ts / status.ts / shutdown.ts / result.ts
│   └── index.ts               # tool registry
└── templates/
    ├── code-review.ts / feature-build.ts / debug-squad.ts
    └── index.ts               # registry + custom-template loader
```

## Decisions

See [`docs/adr/`](docs/adr/) for architecture decision records:

- [ADR-001](docs/adr/ADR-001-model-choice-for-live-testing.md) — Model choice for live testing

## License

MIT
