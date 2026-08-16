# opencode-plugin-orch

Provider-neutral goal and workflow engine for [OpenCode](https://opencode.ai). It runs Claude-workflow-style patterns as ephemeral OpenCode sessions and adds an independently evaluated `/goal` loop. Any OpenCode model reference works, including DeepSeek.

## What it does

Adds 9 tools to your opencode session:

| Tool | Purpose |
|---|---|
| `orch_run` | Run a workflow as ephemeral opencode sessions (one per step invocation). Attached until settlement by default so one-shot CLI runs cannot abort their children; set `background: true` only in a persistent TUI/server. Optional JSON `config` string — see [run configuration](#run-configuration) for model routing, limits, isolation, retries, permissions, and token/cost budgets |
| `orch_workflows` | List, inspect, validate, and atomically save versioned workflow IR (`list` / `info` / `validate` / `save`) |
| `orch_runs` | List workflow runs, newest first. Optional `status` filter and `limit` |
| `orch_status` | Run detail: pattern, status, per-step state, current iteration (evaluator), timing. Accepts a run id or unique id prefix |
| `orch_result` | Final output of a run. `summary` (default), `detailed` (every step output), or `json` (raw run record) |
| `orch_cancel` | Cancel a running run: aborts in-flight step sessions and marks the run cancelled |
| `orch_log` | Inspect the current opencode log for plugin output — `tail` / `errors` / `stats` |
| `orch_goal` | Set, inspect, pause, resume, steer, or clear a lead session's autonomous completion condition; work runs in a dedicated worker session |
| `orch_control` | Pause at a safe boundary, resume, steer active/future workflow agents, retry a terminal failed/cancelled run, or cancel it |

Eight built-in workflows:

| Workflow | Pattern | Steps |
|---|---|---|
| `chain-draft-refine` | chain | `draft` → `refine` |
| `route-by-intent` | routing | classifier routes to `code` / `docs` / `other` handler |
| `parallel-review` | parallel | `security`, `performance`, `style` reviewers concurrently + `aggregate` synthesis |
| `orchestrate-tasks` | orchestrator | `planner` breaks the task into subtasks → `worker-1..N` sessions + `aggregate` |
| `evaluator-loop` | evaluator | `generator` + `critic` loop until the critic replies `PASS` (max 3 iterations) |
| `adversarial-review` | evaluator | `generator` + adversarial `critic` that attacks the deliverable until it finds nothing (max 4 iterations) |
| `author-tests` | orchestrator | `planner` picks the areas most needing tests → `worker-1..N` author them in isolated git worktrees + `aggregate` summary |
| `test-fix-loop` | evaluator + gate | `generator` writes/fixes tests and code until the gate command passes (default `npm test`, max 5 iterations) |

Features:

- **CLI-safe event-driven runs** — the `event` hook drives each run forward on `session.idle` (collect the step output, start the next step) and fails the run on `session.error`. `orch_run` stays attached by default because a one-shot `opencode run` process would otherwise dispose active child sessions; persistent interactive sessions can opt into `background: true`. Steps also have a 10-minute timeout.
- **Lead/control-plane goal mode** — `/goal <condition>` launches a dedicated worker, independently evaluates that worker's bounded evidence, and continues the worker on `not_met`. The initiating conversation stays clear for `/goal`, `/goal steer ...`, `/goal pause`, `/goal resume`, and `/goal clear`.
- **Live delegated-work awareness** — every lead turn receives a compact system snapshot of active goals/workflows, elapsed time, worker state, active agents, tokens, steps, last verdict, and latest steering. Worker/evaluator/step sessions do not receive the lead instruction.
- **Automatic token economy** — provider-reported input, output, reasoning, cache-read, cache-write, and cost are persisted. Soft thresholds compact goal workers asynchronously, show a `compacting` state, and release the durable evaluator continuation exactly once after OpenCode returns idle; reload recovery resumes an already-settled compaction. Hard token/cost limits stop before another step or turn. Unknown usage remains explicitly unknown.
- **Ephemeral step sessions** — every step invocation is one throwaway opencode session titled `orch/<run-id>/<step-id>`. No persistent members, no shared state between steps except what the runner passes via prompt templates.
- **Session teardown** — step sessions are deleted when their step settles (success, failure, cancel, timeout), and orphaned sessions from runs interrupted by a restart are aborted and deleted on plugin init. Set `keepSessions: true` in the run config to keep them for debugging.
- **Event-sourced run store** — run/step state is a JSONL event log (`run_created`, `step_started`, `step_completed`, `step_failed`, `run_completed`, `run_failed`, `run_cancelled`) with a periodic atomic snapshot, persisted under `.opencode/plugin-orch/` in your project.
- **Restart-safe resume** — interrupted runs recover as `paused`; completed steps are reused, the interrupted invocation is cancelled, and `orch_control resume` continues from the first unfinished step.
- **Hardened init + error reporting** — plugin init is wrapped in a 5-second timeout with a multi-sink Reporter (TUI toast → opencode app.log → local `.opencode/plugin-orch/init.log`). All hooks and tools are wrapped so throws can't break opencode; every tool returns `Error: <msg>` strings on failure. On startup you see `[orch] ready · 9 tools` as a success toast.
- **Separate TUI target** — `opencode-plugin-orch/tui` adds a responsive multi-row prompt-side activity badge for the current session's goal worker and active workflows. It drops optional detail and collapses workflow rows on narrow terminals; token/cost detail remains available through Orch tools, while the read-only dashboard retains token drill-down. The home/start view never adopts goals from other sessions.
- **Atomic hot reload** — each build publishes uniquely named bundled server/TUI generations behind an atomic manifest. `pnpm dev` watches `src/`; the server disposes/recreates the project instance and the TUI deactivates/reactivates scoped registrations without restarting OpenCode. Failed builds leave the last good generation active.
- **Portable TypeScript runtime** — workflows, goals, persistence, compaction, budgets, and projections stay in TypeScript across all OpenCode installations. The slower Rust activity prototype remains an unlinked benchmark fixture; ADR-015 requires profiling and a material measured win before any bounded native production proposal.
- **Worktree isolation** — parallel/orchestrator fan-out steps can run in per-step git worktrees (sibling dir `.orch-worktrees/`) with copy-back on success, so concurrent writers don't stomp on each other. See [Worktree isolation](#worktree-isolation).
- **Shell steps and gates** — steps can be plain shell commands, and evaluator loops can gate on a real command (e.g. `npm test`) instead of only a critic model. See [Shell steps and gates](#shell-steps-and-gates).
- **Per-step models and output caps** — `stepModels` pins any step to its own model; `maxStepOutputChars` caps how much step output feeds later prompts. See [choosing models](#choosing-models) and [run configuration](#run-configuration).
- **Autonomous step sessions** — runner step sessions are auto-allowed all permissions except git-mutating commands, which are denied. See [Autonomous permissions for step sessions](#autonomous-permissions-for-step-sessions).
- **Transient-error retry** — an LLM step whose session fails with a transient error (rate limit / 429 / overload / network / 502–504 class) is retried with a fresh session (5s backoff, `stepRetries` attempts, default 1). Command steps, gates, timeouts, and cancels are never retried.

## Getting started

A five-minute path from zero to your first workflow run.

### 1. Prerequisites

- **opencode** (>= 1.18) installed. See [opencode.ai](https://opencode.ai) for install instructions.
- **[pnpm](https://pnpm.io)** and **[bun](https://bun.sh)** on your PATH (`pnpm` for installing, `bun` for the test runner).
- **git**, **node 22+**.
- An opencode-supported model. See [choosing models](#choosing-models) below.

### 2. Install the plugin

```bash
mkdir -p ~/work/src
git clone https://github.com/geoyws/opencode-plugin-orch.git ~/work/src/opencode-plugin-orch
cd ~/work/src/opencode-plugin-orch
pnpm install        # `prepare` typechecks and publishes an atomic dist/ generation
```

Then register the plugin in your opencode config at `~/.config/opencode/opencode.json`:

```json
{
  "plugin": ["../../work/src/opencode-plugin-orch"]
}
```

OpenCode loads visual plugins from a separate `~/.config/opencode/tui.json`.
Register the same package there to enable the persistent goal/workflow badge
and `/orch-dashboard`:

```json
{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": ["../../work/src/opencode-plugin-orch"]
}
```

The path is **relative on purpose** so the same config works across machines. See [Installation](#installation) below for the full explanation.

### 3. Choosing models

Each workflow step runs in its own opencode session, and you can pick the model per step (`model` in the workflow definition) or override it for a whole run (`orch_run`'s `config`). A reasonable split:

- **Cheap/fast models for simple steps** — classifiers (`route-by-intent`), single-purpose reviewers, formatters. These are short, well-scoped prompts where a budget model does fine and keeps multi-step runs inexpensive.
- **Stronger models for orchestration steps** — the `orchestrate-tasks` planner (it must emit valid JSON), `aggregate` synthesis steps, and the `evaluator-loop` critic. A weak planner or critic is the most common way a run goes sideways.

```json
{
  "model": "minimax-coding-plan/MiniMax-M2.7-highspeed",
  "plugin": ["../../work/src/opencode-plugin-orch"]
}
```

For per-step control, `orch_run`'s config takes `stepModels` — a map of step id to model that wins over both the step's own `model` and the run-wide `model` (resolution: `stepModels[step.id] ?? step.model ?? config.model ?? server default`). The canonical use is `adversarial-review`: pin the critic to a different, ideally stronger model than the generator so it isn't grading its own homework:

```json
{"stepModels": {"critic": {"providerID": "...", "modelID": "..."}}}
```

Related knob: `maxStepOutputChars` (default 50000, minimum 1000) caps how much of a step's output is injected into subsequent prompts. Full outputs stay in the run store; the prompt-bound copy keeps bounded head and tail evidence with an explicit compaction marker. Gate feedback is separately capped at 4000 chars.

A note on evidence: the live-test logs in [ADR-001](docs/adr/ADR-001-model-choice-for-live-testing.md) were captured with MiniMax M2.7 driving the **old team-orchestration model (0.1.x)**. They prove the plugin load path and the LLM tool-call loop work end-to-end with that model, but they predate the 0.2.0 workflow engine — don't read them as end-to-end verification of the new engine. Any opencode-supported provider can drive the plugin.

DeepSeek needs no adapter or hard-coded provider name. Use the provider/model identifiers shown by your OpenCode model picker. A typical run override is:

```json
{
  "model": { "providerID": "deepseek", "modelID": "deepseek-chat" },
  "stepModels": {
    "critic": { "providerID": "deepseek", "modelID": "deepseek-reasoner" }
  },
  "maxTokens": 120000,
  "softTokens": 80000
}
```

The goal evaluator and automatic summarizer can use a cheaper DeepSeek model independently:

```json
{
  "plugin": [["../../work/src/opencode-plugin-orch", {
    "goalEvaluatorModel": { "providerID": "deepseek", "modelID": "deepseek-chat" },
    "goalSummarizerModel": { "providerID": "deepseek", "modelID": "deepseek-chat" },
    "goalSoftTokens": 80000,
    "goalMaxTokens": 120000
  }]]
}
```

### 4. Verify it loads

From any directory:

```bash
opencode run "What orch_* tools do you have available?"
```

The model should list all 9 tools, including `orch_goal` and `orch_control`.

Check the plugin loaded cleanly:

```bash
# Linux:
LOG_DIR="$HOME/.local/share/opencode/log"
# macOS:
LOG_DIR="$HOME/Library/Application Support/opencode/log"

ls -t "$LOG_DIR" | head -1 | xargs -I{} grep -E "orch|plugin" "$LOG_DIR/{}"
```

You want to see **`[orch] ready · 9 tools`** and **zero `plugin has no server entrypoint` warnings**. If something's off, see [Troubleshooting](#troubleshooting) below.

### 5. Your first run

Open opencode interactively and paste this prompt:

> Run the `chain-draft-refine` workflow with input "Write a short README section explaining how to run this project's tests." Then show me the status of the run.

The model fires `orch_run` (which returns a run id immediately), then `orch_status` shows the `draft` and `refine` steps progressing. When it's done:

> Get the result of that run in detailed format.

For a full walkthrough of the built-in workflows, see [`examples/workflow-demo.md`](examples/workflow-demo.md).

### Troubleshooting

- **No `orch_*` tools visible**: `dist/index.js` wasn't built. Run `pnpm install && pnpm run build` again. The `prepare` script in `package.json` should handle this automatically on install, but a stale checkout can miss it.
- **`plugin has no server entrypoint` warning in logs**: your `package.json` might be missing the `./server` exports subpath. See [ADR-003](docs/adr/ADR-003-plugin-entrypoint-discovery.md) for the root cause; pulling the latest master fixes it.
- **Plugin never loads**: check `orch_log action=tail` (once the plugin is minimally loaded) or grep the newest file in your opencode log dir for `service=plugin path=file://` to see which plugin path opencode tried to resolve. Make sure `dist/index.js` exists at that path.
- **Goal/workflow tools load but no activity badge appears**: server plugins and visual plugins use different config files. Add the package to `~/.config/opencode/tui.json`, restart the TUI, and check the TUI plugin manager for `opencode-plugin-orch`. The badge is intentionally hidden when there is no active goal and no running/paused workflow.
- **`ConnectionRefused http://localhost:11434`** spam in logs: your opencode config has a `small_model` pointing at a non-running ollama. Change it to your primary model or remove the `small_model` line entirely.

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

Add the visual entrypoint separately in `~/.config/opencode/tui.json`:

```json
{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": ["../../work/src/opencode-plugin-orch"]
}
```

Restart OpenCode after changing `tui.json`; TUI plugins are loaded at startup.

**Important**: the path is relative, not absolute. Opencode resolves it against the config file's own dirname (`~/.config/opencode/`), which gives `$HOME/work/src/opencode-plugin-orch` on both macOS and Linux. An absolute path would only work on one machine.

### Option 2: npm (not published yet)

`pnpm add opencode-plugin-orch` would normally be the way, but this package is not published to npm yet. Use Option 1.

## Compatibility

orch is built and tested against the **latest opencode** (currently 1.18.x) and tracks latest as opencode releases. Several plugin APIs orch relies on are experimental or de-facto-stable-but-unspecified, and we use them knowingly — the policy is to fix forward as opencode evolves rather than pin to old versions (see [ADR-008](docs/adr/ADR-008-tracking-opencode-latest.md)). Users on older opencode versions are unsupported.

If a new opencode release breaks orch:

1. Update to the latest plugin — the fix may already be released.
2. Run `pnpm run test:e2e` from the plugin checkout against your opencode to confirm where it breaks.
3. File an issue with the output.

## Cross-machine setup

The plugin config lives in opencode's global config file. If you sync dotfiles between machines (as I do between macOS and a Linux server), the relative path `../../work/src/opencode-plugin-orch` keeps the plugin working on both sides as long as:

1. The repo is cloned at `~/work/src/opencode-plugin-orch` on both machines.
2. `pnpm install && pnpm run build` has been run on both machines to produce `dist/`.
3. `~/.config/opencode/opencode.json` is the same file (or symlink) on both machines.

There is no platform-specific code path — the resolved absolute path just happens to be `/Users/<you>/work/src/...` on macOS and `/root/work/src/...` on Linux, but both point at a valid checkout.

## Using it

Use `/goal all tests pass and the built artifact loads` to launch a dedicated autonomous worker. `/goal` reports its worker, turns, elapsed time, observed usage, evaluator, compaction state, and last verdict. `/goal steer run the browser test`, `/goal pause`, `/goal resume`, and `/goal clear` control it without moving implementation traces into the lead conversation. The worker inherits the lead's selected model and agent when OpenCode reports them. A continuation pending behind compaction is durable across hot reload and is sent only after the worker is idle.

Orch is deliberately not a DeepSeek Harness integration. It accepts any
provider/model reference already exposed by OpenCode; a separate plugin owns
any DeepSeek Harness runtime or protocol integration.

Use `/workflow-author <task>` to have the current model—including DeepSeek—produce strict version 1 IR, validate it, and save it under `.opencode/workflows/`. `/workflow-run <name> <input>` starts it, while `/workflows` shows definitions and runs. Saved workflow names are also registered as slash commands.

Or talk to your model in natural language—the 9 `orch_*` tools are in its toolbelt. One example per built-in workflow:

### chain-draft-refine

> "Run the `chain-draft-refine` workflow with input: 'Write a short README section explaining how to run this project's tests.'"

The `draft` step's output feeds the `refine` step via `{{output}}`; the refined version is the run output.

### route-by-intent

> "Run `route-by-intent` on: 'Add a --verbose flag to the build script and document it.'"

The classifier replies with one of `code` / `docs` / `other`; the matching route's steps run as a chain. If the classifier output matches no route, the run fails with a clear error.

### parallel-review

> "Run `parallel-review` on src/core/runner.ts, then show me the detailed result."

`security`, `performance`, and `style` reviewers run concurrently (bounded by `concurrency`, default 4); the `aggregate` step synthesizes their findings into one report. A failed branch fails the run.

### orchestrate-tasks

> "Run `orchestrate-tasks` with input: 'Migrate the config loader from JSON to TOML across the repo.'"

The planner must output a JSON array of `{"instructions": "..."}` subtasks; each becomes a `worker-N` session running concurrently; `aggregate` synthesizes the results. A planner that doesn't emit a parseable JSON array fails the run.

### evaluator-loop

> "Run `evaluator-loop` with input: 'Write a one-paragraph product tagline for a workflow engine plugin.'"

The generator produces, the critic reviews; feedback loops back until the critic replies with the standalone token `PASS` or the iteration budget (default 3) is exhausted — in which case the run completes with the last generator output and a note that the budget ran out.

### adversarial-review

> "Run `adversarial-review` with input: 'Write a retry-with-backoff helper for the HTTP client.' Pin the critic to a stronger model."

The `generator` produces the deliverable; the `critic` attacks it — correctness bugs, security holes, unhandled edge cases, spec violations — and replies `PASS` only when a genuine attempt to find defects turns up nothing. Max 4 iterations. Use `stepModels` to give the critic a different/stronger model than the generator.

### author-tests

> "Run `author-tests` with input: 'the src/core runner and store modules.'"

The `planner` identifies the areas most needing tests (unit / integration / e2e) and splits them into disjoint subtasks; each `worker-N` authors its tests in an isolated git worktree (changes are copied back on success); `aggregate` summarizes what was written. It deliberately doesn't run the suite — follow up with `test-fix-loop` to make it green.

### test-fix-loop

> "Run `test-fix-loop` with input: 'Make the store tests pass', overriding the gate to `bun test`."

A gate-only evaluator: the `generator` writes or fixes tests AND the code under test, and after each iteration the gate command (default `npm test`, overridable via `gateCommand`) runs in the project dir. Exit 0 ends the loop; on failure the last ~4000 chars of gate output feed back as `{{feedback}}`. Max 5 iterations.

## Run configuration

`orch_run`'s optional `config` argument is a JSON string. All keys are optional; where both the workflow definition and the run config set a key, the run config wins.

| Key | Type | Default | Purpose |
|---|---|---|---|
| `model` | `{ "providerID": "...", "modelID": "..." }` | server default | model for every step (lowest precedence — see `stepModels`) |
| `maxIterations` | integer ≥ 1 | workflow def's `maxIterations`, else 3 | evaluator loop budget |
| `concurrency` | integer ≥ 1 | 4 | max concurrent fan-out steps (parallel/orchestrator) |
| `stepTimeoutMs` | integer ≥ 1 | 600000 (10 min) | per-step timeout; also the timeout for shell steps and gate commands |
| `isolation` | `"worktree"` | unset | run parallel/orchestrator fan-out steps in per-step git worktrees — see [Worktree isolation](#worktree-isolation) |
| `gateCommand` | string | workflow def's `gate.command` | override the evaluator gate command at run time (e.g. point `test-fix-loop` at `bun test`) |
| `stepModels` | `{ "<step-id>": { "providerID": "...", "modelID": "..." } }` | unset | per-step model override (highest precedence) — see [choosing models](#choosing-models) |
| `maxStepOutputChars` | integer ≥ 1000 | 50000 | cap on step-output text injected into later prompts; full outputs stay in the store |
| `keepSessions` | boolean | false | keep step sessions after their step settles (debugging); by default they are deleted on settle |
| `stepRetries` | integer 0–3 | 1 | retries an LLM step when its session fails with a transient error (rate limit / 429 / overload / network / 502–504 class): 5s backoff, fresh session per attempt. Command steps, gates, timeouts, and cancels are never retried |
| `maxTokens` | positive integer | unset | hard provider-reported token budget; prevents the next unfinished step after the limit is reached |
| `softTokens` | positive integer | 75% of `maxTokens` | switch downstream prompt assembly to persisted compact checkpoints |
| `maxCost` | positive number | unset | hard provider-reported cost budget; unknown provider costs are never treated as zero |
| `maxAgents` | positive integer | 20 | maximum parallel workers or planner-emitted subtasks |
| `maxDurationMs` | positive integer | unset | wall-clock run budget checked before each unfinished step |
| `permissionMode` | `"ask"` or `"auto"` | custom: `ask`; built-in: `auto` | custom/model-authored workflows require normal prompts unless autonomous mode is explicitly selected |

## Custom workflows

Drop your own definitions into `.opencode/workflows/*.json` in your project — they're validated against the same Zod schema as the built-ins and listed by `orch_workflows`. Invalid files are skipped with a load error surfaced by `orch_workflows list`; a bad custom def never breaks plugin init. Custom names may not shadow a built-in.

```json
{
  "version": 1,
  "name": "my-chain",
  "description": "Summarize, then translate to German.",
  "pattern": "chain",
  "steps": [
    { "id": "summarize", "instructions": "Summarize in three sentences:\n\n{{input}}" },
    { "id": "translate", "instructions": "Translate to German:\n\n{{output}}" }
  ]
}
```

Schema:

- `version` — currently `1` (legacy definitions without it are normalized to version 1)
- `name` — unique, kebab-case
- `pattern` — `chain` | `routing` | `parallel` | `orchestrator` | `evaluator`
- `steps[]` — `{ id, instructions?, command?, agent?, model? }` (`agent` defaults to `build`; `model` is `{ "providerID": "...", "modelID": "..." }`). Every step needs `instructions` (an LLM step) or `command` (a shell step — see [Shell steps and gates](#shell-steps-and-gates)); if both are set, `command` wins
- `routes` — routing only: label → step ids. `steps[0]` is the classifier; the first route key appearing as a standalone word in its output wins
- `aggregate` — required for parallel/orchestrator: the synthesis step
- `maxIterations` — evaluator only, default 3
- `isolation` — `"worktree"`: run parallel/orchestrator fan-out steps in per-step git worktrees — see [Worktree isolation](#worktree-isolation)
- `gate` — evaluator only: `{ "command": "..." }`, a shell command run in the project dir after each generator iteration; exit 0 passes. Evaluator workflows need a critic step (`steps[1]`) or a `gate` — or both

Prompt-template placeholders, rendered before each step session is prompted:

- `{{input}}` — the run's input text
- `{{output}}` — previous step's output (chain, evaluator loops)
- `{{steps.<id>.output}}` — output of any completed step (aggregate steps)
- `{{feedback}}` — the critic's last critique, fed back to the generator (evaluator)

One orchestrator caveat: worker step ids are dynamic (`worker-1..N`), so they can't be named in a static aggregate template. The runner appends each worker's bounded output to the aggregate prompt as a `## Result of worker-N` section instead.

`orch_workflows action=save` performs an atomic write and refuses symlinked workflow directories/files. Model-authored shell steps and gates are rejected unless the caller explicitly sets `allowShell: true`; generated JavaScript is never evaluated.

## Worktree isolation

Set `isolation: "worktree"` on a workflow definition or in the run config (`{"isolation": "worktree"}` — run config wins) and the fan-out steps of `parallel` and `orchestrator` runs each execute in their own git worktree instead of sharing the project directory. Chain, routing, and evaluator steps always run in the main directory.

- Each step gets `git worktree add --detach <path> HEAD` at `<project-parent>/.orch-worktrees/<project-basename>/<run-id>/<step-id>` — a sibling directory of the project, so the repo stays clean and no `.gitignore` edits are needed.
- Requires the project to be a git repo with at least one commit. If worktree creation fails for any reason, the step runs in the main directory instead and records `isolationFallback: true` in its step metadata — isolation problems never fail the run.
- Completion detection for worktree steps uses a 2-second poll of the step session's messages: a worktree is its own git project (its own opencode instance), so `session.idle` events from it are not guaranteed to reach the lead instance. Same-directory steps keep the event-driven path.
- On success the runner copies the step's changes back: added/modified files are copied into the project dir and deletions applied (collected via `git status --porcelain=v1 --untracked-files=all` in the worktree), then the worktree is removed. If two steps of the same run touch the same file, **last finisher wins** and the conflict is recorded in the step's `conflicts` metadata; `copiedFiles` lists what was applied. Symlinks are never copied back (they can point into the removed worktree or outside the repo) — skipped ones are recorded in the step's `skippedSymlinks` metadata. On cancel or failure the worktree is removed with no copy-back.

Gate and shell-step commands (below) run via `/bin/sh -c` with the plugin process's environment — whatever opencode itself was started with (PATH, env vars, and anything in them).

## Shell steps and gates

A step can be a shell command instead of an LLM session: set `command` instead of `instructions` in a workflow definition. The command runs via `/bin/sh -c` in the project dir (or the step's worktree, when isolated), shares the step timeout (`stepTimeoutMs`, default 10 minutes), captures combined stdout+stderr as the step output, and fails the step on non-zero exit. No LLM session is created — handy for setup or verification steps that shouldn't burn tokens.

Evaluator workflows can also declare a programmatic gate:

```json
{
  "name": "my-loop",
  "description": "Fix the code until the tests pass.",
  "pattern": "evaluator",
  "gate": { "command": "npm test" },
  "steps": [
    { "id": "generator", "instructions": "Work on:\n\n{{input}}\n\nFailing gate output:\n{{feedback}}" }
  ]
}
```

After each generator iteration the gate command runs in the project dir; exit 0 passes. The loop ends when the gate passes — and, if a critic step (`steps[1]`) exists, it must also reply `PASS`. An evaluator needs at least one of critic or gate. On failure the last ~4000 characters of gate output become the next iteration's `{{feedback}}` (joined with the critic's critique when both are present). Override the gate at run time with `gateCommand` in the run config — e.g. point `test-fix-loop` at `bun test` or `pytest` without editing the definition.

## Autonomous permissions for step sessions

Built-in workflow steps run as background sessions with nobody watching, so a permission prompt would stall the run. Their default `permissionMode` is `auto`, and the plugin's `permission.ask` hook decides permissions as follows:

- **Auto-allowed**: everything else — file edits, arbitrary bash, fetches — without prompting.
- **Denied**: git-mutating bash commands, because only the lead should change repository state — `git commit`, `push`, `merge`, `rebase`, `reset --hard`, `clean`, `stash`, `cherry-pick`, `revert`, `branch -d/-D/-m/-M`, `tag -d`, `checkout`, `switch`, `restore`, and `worktree remove`. Read-only git commands (`status`, `log`, `diff`, `show`, `blame`, `branch`/`tag` listing, `ls-files`, `rev-parse`) are never denied.
- **Untouched**: sessions the runner isn't tracking (including your own interactive session) keep opencode's normal prompting — the hook doesn't set an output at all.

Two switches disable the auto-allow and get normal prompts back — either one is enough:

- Set `ORCH_STEP_PERMISSIONS=ask` in the environment, or
- set the `stepPermissions` plugin option to `"ask"` via a tuple-form plugin entry in `~/.config/opencode/opencode.json`:

```json
{
  "plugin": [["../../work/src/opencode-plugin-orch", { "stepPermissions": "ask" }]]
}
```

`stepPermissions` accepts `"auto"` (the default — the behavior described above) or `"ask"`; unknown values log a warning and fall back to `"auto"`.

Saved/model-authored custom workflows default to `permissionMode: "ask"`. To run one unattended, the caller must explicitly pass `{"permissionMode":"auto"}` in `orch_run` config; the Git-mutation denylist still applies. The global `stepPermissions: "ask"` and `ORCH_STEP_PERMISSIONS=ask` switches always win.

Be honest with yourself about the blast radius: an auto-allowed step session can run arbitrary bash without prompting — the denylist only covers git state, not `rm`, network calls, or package installs. Only run workflows you trust, in repositories where uncommitted work is expendable.

## Monitoring + teardown

> "List my recent runs" — `orch_runs`, newest first
> "Show `orch_status` for run `run_m…`" — id prefixes work; per-step state, iteration, timing
> "Get `orch_result` for that run in detailed format" — final output plus every step output
> "Cancel that run" — aborts in-flight step sessions and marks the run cancelled
> "Pause that run" — lets an in-flight invocation settle, then starts no new steps
> "Resume that run" — reuses completed steps, including after an OpenCode restart
> "Steer that run toward the browser regression" — persists direction and sends it to active model agents

Run history survives restarts. A run interrupted while `running` comes back `paused`; its old live session is aborted/deleted, and resume starts at the first unfinished step. The event log remains authoritative, `snapshot.json` is the periodically compacted recovery fast path, and `view.json` is updated atomically after each event so the TUI does not wait for the snapshot interval.

## Development

```bash
pnpm install            # install deps
pnpm run build          # compile + publish one atomic server/TUI generation
pnpm dev                # watch src/ and hot-reload successful generations
pnpm test               # run the test suite (bun test)
pnpm run typecheck      # tsc --noEmit
```

The test suite is at `tests/`, driven by `bun test` with a fake opencode client (records `session.create` / `promptAsync`, lets the test fire `session.idle` / `session.error` with canned assistant messages):

- `store.test.ts` — event append, snapshot, replay, and running → paused recovery
- `workflows.test.ts` — Zod validation (bad defs rejected), custom loader, placeholder rendering
- `runner.test.ts` — all 5 patterns end-to-end against the fake client: chain ordering, routing label matching, parallel concurrency + aggregate, orchestrator planner JSON parsing + workers, evaluator PASS loop and budget exhaustion, gate pass/fail feedback, command steps, cancel, step timeout
- `worktree.test.ts` — porcelain parsing, the add/copy-back/remove lifecycle against real git repos in temp dirs, and worktree-isolated runs (poll fallback, conflicts, `isolationFallback`)
- `permissions.test.ts` — the git-mutation matcher (mutating denied, read-only allowed) and the `permission.ask` hook policy (step sessions auto-allowed, non-step sessions untouched, `ORCH_STEP_PERMISSIONS=ask` escape hatch)
- `goal.test.ts` — dedicated worker isolation, independent verdicts, steering,
  automatic worker continuation, non-blocking compaction, reload recovery,
  monotonic usage, and budgets
- `control-plane.test.ts` — bounded live lead snapshots and control guidance
- `usage.test.ts` — complete category accounting, including cache reads/writes
- `tools.test.ts` — all 9 tools with the same fake-client harness
- `plugin.test.ts` — init wires hooks/commands, returns 9 tools, init failure returns `{}` without throwing
- `tui.test.ts` — separate target load smoke test

`tests/e2e.test.ts` runs against a **real in-process opencode server** (spawned via `createOpencode()`, plugin injected through config — no fake client). It has two tiers: **tier 1** boots the server and verifies plugin load (tool registration, init log, SSE endpoint); **tier 2** drives full workflow and `/goal` runs through the real stack against a mock LLM — a tiny in-process OpenAI-compatible chat-completions server scripted to make the lead session call Orch tools and to answer delegated prompts — asserting on the plugin's own store (`runs.jsonl`) and the mock's request log. The goal scenario forces the soft-token boundary, exercises OpenCode's actual compaction endpoint, and proves one post-compaction continuation. Both tiers are hermetic (redirected `HOME`, seeded opencode caches, dead external proxy; requires the `opencode` binary on PATH and a built `dist/`) and run as part of plain `bun test`; `pnpm run test:e2e` runs just this file.

`tests/e2e-live.test.ts` is the **live tier** (`pnpm run test:e2e:live`, i.e. `ORCH_LIVE=1` — costs real tokens, manual pre-release runs only). Four real workflow runs use the configured model (override with `ORCH_LIVE_MODEL=providerID/modelID`), objective assertions (store state, `git diff`, gate exit codes), and an **LLM-as-judge** verdict on output quality: chain-draft-refine tagline quality, adversarial-review finding a planted off-by-one, test-fix-loop fixing a planted bug without touching the tests (gate `npm test`), and author-tests writing meaningful passing tests. A fifth live scenario runs the provider as goal worker, evaluator, and summarizer, forces the automatic soft-token compaction boundary, and asserts that the durable continuation reaches a later `met` verdict.

## Architecture

```
src/
├── plugin.ts                  # implementation — init timeout + error boundary
├── index.ts                   # stable server wrapper + generation reload
├── tui-wrapper.ts             # stable TUI wrapper + scoped generation reload
├── tui.tsx                    # separate OpenTUI target: badge + durable dashboard
├── core/
│   ├── runner.ts              # workflow engine — pattern dispatch, step sessions, cancel
│   ├── goal-controller.ts     # lead/worker goal, evaluator, budgets, steering
│   ├── control-plane.ts       # compact dynamic lead snapshot
│   ├── usage.ts               # complete normalized token accounting
│   ├── worktree.ts            # git worktree lifecycle — add/remove, porcelain parse, copy-back
│   ├── exec.ts                # /bin/sh -c + execFile helpers (shell steps, gates, git)
│   └── reporter.ts            # multi-sink error/status reporter
├── hooks/
│   ├── events.ts              # session.idle / session.error → runner
│   ├── permissions.ts         # permission.ask — auto-allow step sessions, deny git mutations
│   └── _safe.ts               # shared hook-throw logger
├── state/
│   ├── store.ts               # JSONL event log + atomic snapshot + replay
│   └── schemas.ts             # Zod schemas (run, step, config, events)
├── tools/
│   ├── run.ts / workflows.ts / runs.ts / status.ts / result.ts / cancel.ts
│   ├── goal.ts / control.ts   # goal and pause/resume/cancel lifecycle tools
│   ├── log.ts                 # opencode log inspector (tail / errors / stats)
│   └── index.ts               # tool registry (9 tools)
└── workflows/
    ├── index.ts               # registry: built-ins + custom defs
    ├── loader.ts              # def schema, template rendering, .opencode/workflows loader
    ├── chain-draft-refine.ts  # chain built-in
    ├── route-by-intent.ts     # routing built-in
    ├── parallel-review.ts     # parallel built-in
    ├── orchestrate-tasks.ts   # orchestrator built-in
    ├── evaluator-loop.ts      # evaluator built-in
    ├── adversarial-review.ts  # evaluator built-in (adversarial critic)
    ├── author-tests.ts        # orchestrator built-in (worktree-isolated test authoring)
    └── test-fix-loop.ts       # evaluator built-in (gate: npm test)

docs/
├── BRD.md / PRD.md            # business and product requirements
├── ../EPIC.md                 # implementation epic and acceptance criteria
├── workflow-spec.md           # authoritative spec for the 0.2.0 design
├── spec-v0.3-addendum.md      # 0.3.0 additions: isolation, gates, stepModels, permissions
└── adr/                       # architecture decision records (ADR-001, 003, 006, 007)
```

## Decisions

See [`docs/adr/`](docs/adr/) for architecture decision records:

- [ADR-001](docs/adr/ADR-001-model-choice-for-live-testing.md) — Model choice for live testing (evidence covers the 0.1.x team model)
- [ADR-003](docs/adr/ADR-003-plugin-entrypoint-discovery.md) — Plugin entrypoint discovery (`./server` exports subpath)
- [ADR-006](docs/adr/ADR-006-workflows-redesign.md) — Rebuild as a workflow engine (supersedes ADR-002/004/005)
- [ADR-007](docs/adr/ADR-007-worktree-isolation-and-autonomy.md) — Worktree isolation, programmatic gates, and autonomous step-session permissions
- [ADR-008](docs/adr/ADR-008-tracking-opencode-latest.md) — Track the latest opencode, experimental APIs included (fix-forward policy)
- [ADR-009](docs/adr/ADR-009-session-scoped-goal-controller.md) — Session-scoped goal controller
- [ADR-010](docs/adr/ADR-010-validated-workflow-ir.md) — Validated dynamic workflow IR
- [ADR-011](docs/adr/ADR-011-provider-neutral-deepseek-routing.md) — Provider-neutral DeepSeek routing
- [ADR-012](docs/adr/ADR-012-separate-server-and-tui-entrypoints.md) — Separate server and TUI entrypoints
- [ADR-013](docs/adr/ADR-013-token-budgets-and-compact-checkpoints.md) — Token budgets and compact checkpoints
- [ADR-014](docs/adr/ADR-014-rust-kernel-with-typescript-opencode-adapters.md) — Superseded Rust-kernel migration proposal
- [ADR-015](docs/adr/ADR-015-typescript-first-runtime-with-profile-guided-native-optimization.md) — TypeScript-first runtime with profile-guided native optimization
- [ADR-016](docs/adr/ADR-016-lead-control-plane-and-dedicated-goal-workers.md) — Lead control plane and dedicated goal workers (supersedes ADR-009 continuation)
- [ADR-017](docs/adr/ADR-017-atomic-generation-hot-reload.md) — Atomic generation hot reload for server and TUI
- [ADR-018](docs/adr/ADR-018-event-bound-goal-continuation-after-compaction.md) — Event-bound goal continuation after compaction

## License

MIT
