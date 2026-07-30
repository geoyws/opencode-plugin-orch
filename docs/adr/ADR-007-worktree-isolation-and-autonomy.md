# ADR-007: Worktree isolation, programmatic gates, and autonomous step sessions

**Status:** Accepted
**Date:** 2026-07-28

## Context

0.2.0 ran every step session in the project directory. That worked for the read-mostly built-ins (review, classify, draft) but breaks down for the 0.3.0 use cases:

- **Parallel writers collide.** `parallel` and `orchestrator` fan-out steps that edit files share one working tree and stomp on each other's writes. `author-tests` — several workers writing test files concurrently — is dead on arrival without isolation.
- **No programmatic definition of "done".** The evaluator pattern ended when a critic LLM replied `PASS`. For test-authoring work the honest signal is whether the test suite actually passes, not whether a model says it does.
- **Step sessions can't answer permission prompts.** Steps are background sessions with no human at the wheel; a workflow step that edits files and runs commands would stall forever on the first `permission.ask` prompt.

## Decision

1. **Raw git worktrees, not `experimental_workspace`.** Fan-out steps of `parallel`/`orchestrator` runs with `isolation: "worktree"` each get `git worktree add --detach <path> HEAD`. The opencode `experimental_workspace` plugin API was considered and rejected: it is a TUI-facing workspace registry — workspaces a user browses and switches between in the interface — not a lifecycle the runner can drive. The runner needs to create, poll, copy back from, and destroy the workspace on its own schedule; raw worktrees give it exactly that, with no dependency on an experimental API.
2. **Worktrees live in a sibling directory**: `<project-parent>/.orch-worktrees/<project-basename>/<run-id>/<step-id>`. Keeping them outside the repo means no `.gitignore` edits and no chance of the main tree accidentally tracking worktree contents. If `git worktree add` fails (not a git repo, no commits), the step runs in the main directory instead and records `isolationFallback: true` in its step metadata — isolation problems never fail the run.
3. **2-second poll fallback for completion detection.** A worktree is its own git project, so opencode treats it as a separate instance, and `session.idle` events from the worktree's instance are not guaranteed to reach the lead instance's `event` hook. Rather than depend on cross-instance event delivery, the runner polls `session.messages` every 2s (unref'd interval) for worktree sessions and treats the step as complete when the newest assistant message has `time.completed` set. Same-directory sessions keep the existing event-driven path.
4. **Copy-back with last-finisher-wins.** On successful completion the runner collects changes via `git -C <worktree> status --porcelain=v1 --untracked-files=all`, copies added/modified files into the project dir, applies deletions, then runs `git worktree remove --force`. If two steps of the same run touch the same file, the last finisher wins and the conflict is recorded in step metadata (`conflicts`), alongside `copiedFiles`. On cancel/fail the worktree is removed and nothing is copied back.
5. **Auto-allow permissions for step sessions, with a git-mutation denylist.** The `permission.ask` hook returns `allow` for permissions requested by a runner-tracked step session — background steps cannot answer prompts, so asking means hanging — except git-mutating bash commands (`git commit`, `push`, `merge`, `rebase`, `reset --hard`, `clean`, `stash`, `cherry-pick`, `revert`, `branch -d/-D/-m/-M`, `tag -d`, `checkout`/`switch`/`restore`, `worktree remove`), which get `deny`: only the lead changes repository state. Sessions the runner isn't tracking are left completely untouched. `ORCH_STEP_PERMISSIONS=ask` disables the auto-allow entirely.
6. **Programmatic gates for evaluator runs, not stored as events.** A workflow may declare `gate: { command }`; after each generator iteration the command runs in the project dir and exit 0 ends the loop (a critic step, if present, must also reply `PASS`). Gate runs are intentionally **not** written to the event store: the gate is a runner-internal predicate, not an agent step — it has no session, and its output only matters as the next iteration's `{{feedback}}` (last ~4000 chars). Recording it as a step would pollute `orch_status` with session-less phantom steps.

## Consequences

**Positive.**

- Write-heavy fan-out (`author-tests`, any parallel editing) can run concurrently without workers colliding; same-file conflicts that do happen are recorded per step, not silently lost to a race.
- Evaluator loops can verify against ground truth — a real test command — instead of a model's say-so. `gateCommand`, `stepModels`, and `maxStepOutputChars` make runs tunable without editing workflow definitions.
- Background step sessions never stall on a permission prompt, and the git-mutation denylist keeps step sessions from rewriting repository state (commits, branches, worktrees) out from under the lead.

**Negative.**

- **Blast radius.** An auto-allowed step session can run arbitrary non-git-mutating bash without prompting — `rm`, network calls, package installs, whatever the model decides. The denylist only covers git state. Only run workflows you trust, and treat `ORCH_STEP_PERMISSIONS=ask` as the way back to full prompting.
- **Last-finisher-wins loses work.** When two steps write the same file, the earlier finisher's version of that file is overwritten (recorded in `conflicts`, not prevented). No merging is attempted.
- **Copy-back is file-level, not git-level.** Copied-back changes land in the main working tree uncommitted; the worktree (and any history the worker made) is removed after copy-back.
- **Silent degradation outside git.** Non-git projects (or repos with no commits) fall back to shared-directory execution with `isolationFallback: true` — the collision problem remains there, just made visible in step metadata.

## Alternatives considered

- **opencode `experimental_workspace` API.** Rejected: it is a TUI-facing workspace registry, and the runner needs full lifecycle control (create/poll/copy-back/remove) that a user-facing registry doesn't offer.
- **Refuse on conflict** — fail the run when two steps touch the same file. Rejected: too brittle for real fan-out work, where workers legitimately touch shared files; recording the conflict with last-finisher-wins keeps runs useful while staying honest about what happened.
- **Per-step branches with real merges.** Rejected: three-way merges and conflict resolution are a complexity cliff that the essay-scale workflows here don't justify. Copy-back of file-level changes is the 80% solution.
- **Trust the `session.idle` event for worktree sessions.** Rejected: cross-instance event delivery isn't guaranteed, and a missed event would hang every isolated step until the 10-minute timeout. A 2s unref'd poll is cheap insurance; the event path still serves same-directory steps.
- **Broader bash denylist** (`rm -rf`, network egress, ...). Rejected as security theater: pattern-matching shell text cannot contain a motivated model, and false confidence is worse than the honest guidance — only run workflows you trust.

## References

- **Spec**: [`docs/spec-v0.3-addendum.md`](../spec-v0.3-addendum.md) — the authoritative 0.3.0 contract this ADR summarizes; extends [`docs/workflow-spec.md`](../workflow-spec.md).
- **Builds on**: [ADR-006](ADR-006-workflows-redesign.md) — the workflow-engine redesign these features extend.
- **Denylist origin**: the pre-0.2.0 `permission.ask` git-safety matcher (git history, commit 8b63ef3), resurrected and aligned with the 0.3.0 addendum's list.
