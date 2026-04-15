# Contributing

Thanks for hacking on `opencode-plugin-orch`. This guide covers setup,
the local dev loop, and expectations for PRs.

## Setup

```bash
git clone https://github.com/geoyws/opencode-plugin-orch.git
cd opencode-plugin-orch
pnpm install
pnpm run build
```

`pnpm install` runs the `prepare` script which builds `dist/` automatically,
so you normally don't need the explicit `build` step after the first install.

## Tests

```bash
bun test                          # full suite
bun test tests/tools.test.ts      # one file
bun test --coverage | tail -20    # coverage summary
```

Test files live under `tests/`:

| File | What it covers |
|---|---|
| `tests/core.test.ts` | `Store`, `TeamManager`, `TaskBoard`, `Scratchpad`, state machine |
| `tests/communication.test.ts` | `MessageBus` send/broadcast, backpressure, peer DM toast shape |
| `tests/hooks-templates.test.ts` | `permission.ask` + `tool.execute.after` hooks, `TemplateRegistry` |
| `tests/tools.test.ts` | The nine `orch_*` tools end-to-end against the mock client |
| `tests/events.test.ts` | `event` hook dispatch + plugin init failure modes |
| `tests/e2e.test.ts` | Full lead → spawn → message → result flows (skipped in CI — needs the real opencode binary) |
| `tests/revalidation.test.ts` | Session revalidation on init (dead / live / timeout / terminal) |

The mock SDK client and shared harness live in `tests/_harness.ts`. When
adding tests that need an SDK endpoint the mock doesn't implement yet,
extend `MockClient` there — the fields are instance fields so tests can
monkey-patch a single method per instance.

## Typecheck

```bash
pnpm run typecheck    # or: npx tsc --noEmit
```

Strict mode is on. `any` is allowed in test files for mock shapes but
avoid it in `src/`.

## Running opencode with the plugin

See the README's install section for the relative-path config trick — in
short, point `~/.config/opencode/opencode.json` at your checkout and let
`exports["./server"]` do its job.

## Making changes

Read the relevant Architecture Decision Record before touching the parts
it covers. Existing ADRs live in [`docs/adr/`](docs/adr/):

- [ADR-001](docs/adr/ADR-001-model-choice-for-live-testing.md) — model
  choice for live smoke tests (why we use `minimax-coding-plan/MiniMax-M2.7-highspeed`
  on the hax box)

New ADRs land in the same directory with the next sequential number.
Check `docs/adr/` for anything newer before you start.

## Live smoke test

Before committing a plugin-loader change or anything that touches
`src/plugin.ts` / `doInit`, run the live smoke from ADR-001's appendix:

```bash
opencode run --model minimax-coding-plan/MiniMax-M2.7-highspeed \
  "Call orch_create with name='smoke' and return the team id"
```

Check the latest log under `~/.local/share/opencode/log/` for
`[orch] ready · N tools` — that confirms the plugin loaded and all tools
registered. If it's missing, the plugin silently failed to import; look
for a `plugin has no server entrypoint` WARN on the same line.

## Commit style

Conventional commits (`feat:`, `fix:`, `docs:`, `test:`, `chore:`,
`refactor:`, `ci:`). Scopes are optional but useful — e.g. `fix(ci):`.

Keep the subject line under ~72 chars; put the rationale in the body.
Add a `Co-Authored-By:` trailer if an LLM meaningfully helped.

## Pull requests

CI runs typecheck + `bun test` on every push and pull request to `master`
via [.github/workflows/test.yml](.github/workflows/test.yml). Both must
pass before merge. If you can't run the live smoke locally (no opencode
binary, no model access), say so in the PR description and flag the
risk — don't silently skip it.
