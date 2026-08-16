# ADR-006: Rebuild orch as a workflow engine (supersedes ADR-002/004/005)

**Status:** Accepted
**Date:** 2026-07-28

## Context

orch 0.1.x was a "team of persistent members" plugin: a lead session spawned long-lived member sessions and coordinated them through a message bus, a shared task board, soft file locks, a scratchpad, cost tracking with budget enforcement, model-escalation chains, idle/whip monitors, and a durable lead inbox for peer DMs. By 0.1.1 the plugin had grown to 12 tools (`orch_create`, `orch_spawn`, `orch_message`, `orch_broadcast`, `orch_tasks`, `orch_memo`, `orch_status`, `orch_shutdown`, `orch_result`, `orch_inbox`, `orch_team`, `orch_log`) backed by a dozen core modules, plus a `bin` CLI driving tmux layouts and Discord webhooks.

That model had real costs that kept compounding:

- **Too many interacting subsystems.** Every coordination concern (messaging, task claiming, locking, budgeting, escalation, monitoring) was its own state machine with its own failure modes, and they all touched each other. Reasoning about any one behavior meant holding the whole graph in your head.
- **Persistent members are hard to keep honest.** Member sessions lived across events, so the plugin needed cross-restart session revalidation, work-stealing, backpressure, and inbox cursors just to keep the illusion of a "team" coherent. A large fraction of the codebase existed to recover from the persistence model itself.
- **The interesting part was small.** What users actually wanted — "run these steps as separate agent sessions, in this shape, and give me the combined result" — is exactly the workflow patterns from Anthropic's *Building effective agents* essay (prompt chaining, routing, parallelization, orchestrator-workers, evaluator-optimizer). None of that needs teams, a bus, or a task board.

ADR-002 (three-tier lead visibility), ADR-004 (member tool scoping), and ADR-005 (rate limiting) all exist to patch problems that only exist because of the team model. If the team model goes away, they go away with it.

## Decision

Rebuild orch from scratch as a **stateless workflow engine for opencode** (version 0.2.0), specified in [`docs/workflow-spec.md`](../workflow-spec.md):

1. **A run executes a workflow definition as a set of ephemeral opencode sessions** — one session per step invocation, created on demand, titled `orch/<run-id>/<step-id>`, and discarded. There are no persistent members; the only state that outlives a step is the run record in the store.
2. **Five built-in patterns**, matching the Anthropic essay: `chain` (`chain-draft-refine`), `routing` (`route-by-intent`), `parallel` (`parallel-review`), `orchestrator` (`orchestrate-tasks`), `evaluator` (`evaluator-loop`). Users add custom definitions as JSON in `.opencode/workflows/*.json`, validated by the same Zod schema as the built-ins.
3. **Event-driven advancement with an attached default.** The `event` hook
   drives runs forward on `session.idle` (collect the last assistant message as
   the step output, start the next step) and fails runs on `session.error`.
   `orch_run` keeps its initiating tool call attached until settlement by
   default because a one-shot `opencode run` process otherwise disposes and
   aborts its child sessions. Persistent TUI/server callers may explicitly set
   `background: true`. Steps carry a 10-minute timeout.
4. **Event-sourced run store.** The existing JSONL + snapshot + replay `Store` design is kept, with new event types only: `run_created`, `step_started`, `step_completed`, `step_failed`, `run_completed`, `run_failed`, `run_cancelled`.
5. **Runs are not resumed across restarts in 0.2.0.** On plugin init, replay marks any run left in `running` as `failed` with reason "plugin restarted". There is no cross-restart session revalidation — with ephemeral sessions there is nothing meaningful to reattach to.
6. **Tool surface drops from 12 to 7:** `orch_run`, `orch_workflows`, `orch_runs`, `orch_status`, `orch_result`, `orch_cancel`, `orch_log`. `orch_status` / `orch_result` keep their names and prefix-matching but now report on runs instead of teams; `orch_log` is reused as-is; `orch_cancel` replaces `orch_shutdown`.
7. **Everything team-specific is deleted**: `src/cli.ts`, the core modules (`member`, `team-manager`, `message-bus`, `task-board`, `file-locks`, `scratchpad`, `cost-tracker`, `escalation`, `activity`, `revalidate`, `rate-limit`, `idle-monitor`, `whip-monitor`, `discord-notifier`), the permission/activity hooks, `src/templates/`, nine team tools, the `bin` entry, and the `peerDependencies` on `@opentui`. ADR-002, ADR-004, and ADR-005 are superseded and removed along with their evidence logs. The hardened init/error-reporting shell (`plugin.ts` timeout + Reporter, `_safe.ts`) survives unchanged because it was never team-specific.

## Consequences

**Positive.**

- The mental model collapses to one sentence: a run is a workflow definition executed as ephemeral sessions. New contributors read `runner.ts` (~600 lines, one file) and understand the engine.
- Whole classes of bugs disappear with the deleted subsystems: message-bus backpressure, lock leaks, work-stealing races, budget shutdown edge cases, cross-restart member revalidation, inbox cursors. You cannot have a stale-member bug when there are no members.
- The five patterns cover the use cases the team model was reaching for (fan-out review, plan-then-delegate, draft-then-critique) with far less machinery, and custom JSON workflows make the engine extensible without new code.
- The test strategy gets simpler and stronger: a fake opencode client that records `session.create` / `promptAsync` and lets tests fire `session.idle` / `session.error` exercises all five patterns end-to-end without a live server.

**Negative.**

- **Breaking change with no migration path.** 0.1.x teams, members, task boards, and inboxes are gone; existing `.opencode/plugin-orch/` state from 0.1.x is not read by the new store. Anyone relying on the team tools must stay on 0.1.x.
- **No run resumption.** A crash or restart mid-run fails the run; the user restarts it from scratch. For long orchestrator runs this wastes completed worker output. Acceptable for 0.2.0 because the store already records every step output, but it is the most likely reason for a 0.3.0.
- **ADR-001's live evidence is now historical.** The MiniMax M2.7 end-to-end logs verified the old team model's load path and tool-call loop. The load path itself (`./server` entrypoint, ADR-003) is unchanged and still covered, but the 0.2.0 engine has no equivalent live evidence yet — the README is careful not to claim otherwise.
- **Reduced feature surface.** Budget enforcement, escalation chains, git-safety permission hooks, and file locks were genuinely useful to some workflows. They can return later as per-step or per-run options if demand shows up, but 0.2.0 ships without them.

## Alternatives considered

- **Keep the team model and simplify incrementally.** Rejected: the complexity was load-bearing — each subsystem existed to paper over persistence — so incremental deletion would have left a long tail of half-coherent states. A clean rebuild on the workflow spec was cheaper than untangling the graph.
- **Resume-able runs across restarts** (reattach to or re-drive interrupted steps on init). Deferred, not rejected: the event-sourced store already has everything needed (per-step outputs, run config), but session reattachment semantics in opencode are murky and the failure mode ("plugin restarted" is honest and immediate) is fine for 0.2.0. Revisit if long-running orchestrator runs become common.

## References

- **Design spec**: [`docs/workflow-spec.md`](../workflow-spec.md) — the authoritative 0.2.0 contract this ADR summarizes.
- **Kept decisions**: [ADR-003](ADR-003-plugin-entrypoint-discovery.md) (entrypoint discovery — unaffected) and [ADR-001](ADR-001-model-choice-for-live-testing.md) (kept for the smoke-test procedure; its live evidence covers the 0.1.x team model).
- **Superseded and deleted**: ADR-002 (three-tier lead visibility), ADR-004 (member tool scoping), ADR-005 (rate limiting) — all team-model concerns.
- **Inspiration**: Anthropic, [*Building effective agents*](https://www.anthropic.com/research/building-effective-agents) — the five workflow patterns the engine implements.
