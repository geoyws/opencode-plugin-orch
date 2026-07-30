# orch 0.3.0 — Spec Addendum: isolation, gates, adversarial review, test authoring

Extends `docs/workflow-spec.md` (the 0.2.0 spec — still authoritative where
this addendum does not override it). Four additions, in priority order:

## 1. Worktree isolation for parallel workers

Problem: parallel/orchestrator workers share the project directory and stomp
on each other's writes.

Mechanism (runner-managed, NOT `experimental_workspace` — that API is a
TUI-facing workspace registry; raw git worktrees give the runner full
control):

- New optional field on WorkflowDef and RunConfig: `isolation?: "worktree"`.
  Effective when set on either (run config wins). Applies to the fan-out
  steps of `parallel` and `orchestrator` runs only (chain/routing/evaluator
  steps stay in the main directory).
- Per fan-out step: `git worktree add --detach <wtPath> HEAD` where
  `wtPath = <parent-of-project>/.orch-worktrees/<projectBasename>/<runID>/<stepID>`
  (sibling dir of the project — keeps the repo clean, no .gitignore edits).
  Requires the project to be a git repo; if `git worktree add` fails
  (not a repo, no commits), fall back to running in the main directory and
  record `isolationFallback: true` in step metadata.
- Worker session: `client.session.create({ query: { directory: wtPath },
  body: { title } })`; all subsequent calls for that session pass
  `query: { directory: wtPath }` (the codebase already threads
  `query.directory` through SDK calls).
- Completion detection: the cross-instance event question (worktree = own
  git project = own opencode instance, events may not reach the lead
  instance's `event` hook) is sidestepped by a **poll fallback**: for
  worktree sessions the runner polls `client.session.messages({ path: { id },
  query: { directory } })` every 2s (unref'd interval) and treats the step
  as complete when the newest assistant message has `time.completed` set.
  Same-dir sessions keep the existing `session.idle` event path.
- Copy-back: on successful step completion, collect changes via
  `git -C <wtPath> status --porcelain=v1 --untracked-files=all` and copy
  added/modified files (and apply deletions) into the main project dir.
  If two steps of the same run touch the same file: last finisher wins and
  the conflict is recorded in step metadata (`conflicts: string[]`).
  Then `git worktree remove --force <wtPath>`.
- On cancel/fail: abort session, remove worktree, no copy-back.
- `step_completed` payload gains optional `copiedFiles: string[]`,
  `conflicts: string[]`, `isolationFallback?: boolean`.

## 2. Shell steps and programmatic gates

- StepDef gains `command?: string`. A command step runs the shell command
  (`/bin/sh -c`, cwd = project dir or the step's worktree, 10-min default
  timeout shared with `stepTimeoutMs`), captures combined stdout+stderr as
  the step output, and fails the step on non-zero exit. No LLM session is
  created. Mutually exclusive with `instructions` being required: a step
  must have `instructions` or `command` (zod-refined).
- WorkflowDef gains `gate?: { command: string }` — **evaluator pattern
  only**. After the generator step each iteration, the gate command runs in
  the project dir; exit 0 = pass. Loop ends when the gate passes (and the
  critic, if `steps[1]` exists, also replies PASS). At least one of critic /
  gate required for evaluator workflows. On failure the last ~4000 chars of
  gate output become `{{feedback}}` (plus the critic's critique when both
  are present).
- RunConfig gains `gateCommand?: string` to override the workflow's gate
  command at run time (e.g. point `test-fix-loop` at a different test
  command).

## 3. Adversarial review + model pinning + output caps

- New built-in `adversarial-review` (evaluator): generator produces the
  deliverable; critic is prompted to attack it adversarially (correctness
  bugs, security holes, edge cases, spec violations) and reply PASS only
  when nothing is found. maxIterations 4.
- RunConfig gains `stepModels?: Record<string, ModelRef>` — per-step model
  override. Resolution order: `stepModels[step.id]` ?? `step.model` ??
  `config.model` ?? server default. Documented use: pin
  `{"critic": {"providerID": "...", "modelID": "..."}}` so the adversary is
  a different/stronger model than the generator.
- RunConfig gains `maxStepOutputChars?: number` (default 50_000, min 1000).
  Full outputs stay in the store; only the text injected into subsequent
  prompts is truncated with a `\n[... truncated N chars]` marker. Gate
  feedback tail is separately capped at 4000 chars.

## 4. Autonomous test authoring

- Auto-permissions: the plugin re-adds a `permission.ask` hook. If
  `input.sessionID` belongs to a runner-tracked step session, output
  `status = "allow"` — EXCEPT git-mutating bash commands (commit, push,
  merge, rebase, reset --hard, clean, stash, cherry-pick, revert,
  `branch -d/-D/-m`, `tag -d`, checkout/switch/restore, worktree remove)
  which get `"deny"` (only the lead commits; resurrect the matcher from the
  deleted `src/hooks/permissions.ts` in git history, commit 8b63ef3).
  Everything else (non-step sessions) is left untouched — do not set the
  output at all. Escape hatch: env `ORCH_STEP_PERMISSIONS=ask` disables the
  auto-allow.
- New built-ins:
  - `author-tests` (orchestrator, `isolation: "worktree"`): planner
    identifies the areas most needing tests (unit / integration / e2e) from
    `{{input}}` + repo layout; workers author the tests (each worker owns a
    disjoint area); aggregate step summarizes what was written. A final
    chain-style verification is NOT in this workflow — see `test-fix-loop`.
  - `test-fix-loop` (evaluator with `gate.command`, default `"npm test"`,
    overridable via run config `gateCommand`):
    generator writes or fixes tests AND the code under test until the gate
    passes; on failure the gate output tail is the feedback. maxIterations 5.
    Critic step omitted by default (gate-only evaluator).

## 5. Session teardown

- Step sessions are ephemeral and must not linger in opencode storage. When
  a step reaches a terminal state (success, failure, cancel, timeout,
  `session.error` — including worktree steps and their poll fallback), the
  runner deletes the session: extract the output (`session.messages`) FIRST,
  settle the step, then `session.delete({ path: { id }, query: { directory } })`
  fire-and-forget with `.catch(() => {})` — a delete failure must never
  affect the run. Command steps have no session and are exempt.
- RunConfig gains `keepSessions?: boolean` (default false = delete). When
  true, deletion is skipped so settled sessions can be inspected while
  debugging.
- Restart sweep: Store.init already marks runs left `running` as failed
  ("plugin restarted"); it now also collects those runs' step sessionIDs.
  On plugin init the runner aborts + deletes each of them best-effort
  (they may still be burning tokens). `keepSessions` does not apply — those
  runs are dead.

## 6. Step retry and permission configuration

- RunConfig gains `stepRetries?: number` (int 0–3, default 1). When an LLM
  step's session fails with a transient error (rate limit / 429 /
  overload / network / 502–504 class), the runner retries it: 5s backoff,
  a fresh session per attempt. Command steps, gates, step timeouts,
  cancels, and non-transient errors are never retried. After the attempts
  are exhausted the step failure message reads "…after N attempts". Step
  records gain `attempts`.
- Plugin option `stepPermissions`: the opencode.json plugin entry may use
  tuple form — `"plugin": [["../../work/src/opencode-plugin-orch",
  { "stepPermissions": "ask" }]]`. `"ask"` disables the step-session
  auto-allow (same effect as the `ORCH_STEP_PERMISSIONS=ask` env var;
  either one disables it). `"auto"` is the default and keeps the current
  behavior. Unknown values warn and fall back to auto.

## Housekeeping

- Version 0.3.0 in package.json + CHANGELOG.
- README: new sections for worktree isolation, shell steps/gates,
  adversarial review with stepModels, autonomous test authoring + the
  permission policy (what's auto-allowed, what's denied, the env escape
  hatch).
- New ADR-007 covering: raw git worktrees over `experimental_workspace`
  (why), poll fallback for cross-instance completion, copy-back conflict
  policy, auto-allow permission policy and its blast radius.
- Tests for all of the above (fake git repos in temp dirs for worktree
  logic — real `git` binary is fine in tests).
