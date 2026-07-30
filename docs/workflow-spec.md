# orch 0.2.0 — Workflow Engine Spec

 orch stops being a "team of persistent members" plugin and becomes a **workflow
engine for opencode**, implementing the workflow patterns from Anthropic's
"Building effective agents" essay. No teams, no members, no message bus,
no task board, no file locks, no scratchpad, no cost tracker, no escalation,
no monitors, no CLI/tmux/Discord. A **run** executes a **workflow definition**
as a set of ephemeral opencode sessions (one per step invocation).

## Target dependency versions

- `@opencode-ai/plugin` ^1.18.7
- `@opencode-ai/sdk` ^1.18.7
- `zod` ^4.1.8 (unchanged)

Confirmed against the 1.18.7 type definitions: `PluginInput` (`client`,
`project`, `directory`, `worktree`, `serverUrl`, `$`), hook names `event`,
`tool`, `permission.ask`, `tool.execute.before/after`, `dispose` (new),
`tool()` helper with `tool.schema`, SDK `client.session.create` /
`session.promptAsync` / `session.prompt` / `session.abort` /
`session.messages`, and event type `session.idle` / `session.error` all
still exist. `PluginModule` shape (`{ id?, server }`) unchanged.

## Concepts

### Workflow definition

Zod-validated. Built-ins ship in `src/workflows/`; users can add custom ones
as JSON files in `<project>/.opencode/workflows/*.json`.

```ts
type ModelRef = { providerID: string; modelID: string };

type StepDef = {
  id: string;                    // unique within the workflow
  instructions: string;          // prompt template, see placeholders below
  agent?: string;                // opencode agent, default "build"
  model?: ModelRef;
};

type WorkflowDef = {
  name: string;                  // unique, kebab-case
  description: string;
  pattern: "chain" | "routing" | "parallel" | "orchestrator" | "evaluator";
  steps: StepDef[];
  routes?: Record<string, string[]>;  // routing only: label -> step ids
  aggregate?: StepDef;                // parallel/orchestrator: synthesis step
  maxIterations?: number;             // evaluator only, default 3
};
```

Prompt template placeholders (rendered before sending to a step session):

- `{{input}}` — the run's input text
- `{{output}}` — previous step's output (chain, evaluator loops)
- `{{steps.<id>.output}}` — output of any completed step (aggregate steps)
- `{{feedback}}` — evaluator's critique fed back to the generator

### Pattern semantics (runner)

- **chain**: `steps` run in array order. Step N gets `{{output}}` = step N-1's
  output. Final step's output = run output.
- **routing**: `steps[0]` is the classifier. Its output is matched against
  `routes` keys (case-insensitive, first route key that appears as a word in
  the classifier output wins; if none matches, run fails with a clear error).
  The route's step ids run as a chain. Run output = last routed step output.
- **parallel**: all `steps` run concurrently (bounded by `concurrency`,
  default 4). When all complete, `aggregate` (required) runs with access to
  every `{{steps.<id>.output}}`. Run output = aggregate output.
- **orchestrator**: `steps[0]` is the planner. It must output a JSON array of
  `{ "instructions": string }` objects (runner extracts the first JSON array
  in the output; parse failure = run failure). Each subtask runs as a worker
  session (bounded by `concurrency`), then `aggregate` (required) synthesizes
  with `{{steps.<id>.output}}` where worker step ids are `worker-1..N`.
- **evaluator**: `steps[0]` = generator, `steps[1]` = evaluator, loop:
  generator produces (`{{feedback}}` on iterations > 1), evaluator reviews.
  If evaluator output contains the token `PASS` (standalone word,
  case-insensitive) the run completes with the generator's last output;
  otherwise feedback loops back, up to `maxIterations` (default 3), after
  which the run completes with the last generator output and a note that the
  iteration budget was exhausted.

### Step execution

Each step invocation = one ephemeral opencode session:

1. `client.session.create({ path: { projectID? }, body: { title } })` — use
   the same call shape the old code used (`team-manager.ts`), title
   `orch/<run-id>/<step-id>`.
2. `client.session.promptAsync({ path: { id }, body: { parts: [{ type:
   "text", text }], agent?, model? } })`.
3. Runner marks the step `running` and returns; the `event` hook drives
   advancement on `session.idle` for that session id.
4. On idle: `client.session.messages({ path: { id } })`, take the last
   assistant message, concatenate its `text` parts → step output.
5. On `session.error` for a step session, or a per-step timeout (default
   10 min, unref'd timer), the step fails → run fails (parallel: a failed
   branch fails the run).

Run/step state is event-sourced through the existing `Store` (keep the
JSONL + snapshot + replay design, new event types only):

`run_created`, `step_started`, `step_completed`, `step_failed`,
`run_completed`, `run_failed`, `run_cancelled`.

On plugin init, replay marks any run left in `running` as `failed`
(reason: "plugin restarted") — no cross-restart session revalidation;
runs are not resumed across restarts in 0.2.0.

### Tools (7)

Prefix `orch_` unchanged. Every tool catches errors and returns
`Error: <msg>` strings like the old ones.

- `orch_run { workflow, input, config? }` — start a run. `config` is a JSON
  string: `{ model?: ModelRef, maxIterations?: number, concurrency?: number }`
  (`model` overrides the default model for every step).
- `orch_workflows { action: "list" | "info", name? }` — list built-in +
  custom workflow definitions, or show one in detail.
- `orch_runs { status?, limit? }` — list runs newest-first.
- `orch_status { run }` — run detail: pattern, per-step state, current
  iteration, timing. Accepts run id prefix like the old `orch_status`.
- `orch_result { run, format?: "summary" | "detailed" | "json" }` — final
  output; detailed includes every step output.
- `orch_cancel { run }` — abort in-flight step sessions
  (`client.session.abort`) and mark cancelled.
- `orch_log { action: "tail" | "errors" | "stats", lines? }` — unchanged
  behavior, reuse the old implementation as-is if practical.

### Built-in workflows (`src/workflows/`)

- `chain-draft-refine` — chain: `draft` → `refine`
- `route-by-intent` — routing: classifier + routes `code` / `docs` / `other`
- `parallel-review` — parallel: `security`, `performance`, `style` reviewers
  + `aggregate`
- `orchestrate-tasks` — orchestrator: planner → workers → `aggregate`
- `evaluator-loop` — evaluator: generator + critic, maxIterations 3

## Files

Keep (adapt): `src/plugin.ts` (init timeout + error boundary — update wiring),
`src/index.ts` (unchanged), `src/state/store.ts` (adapt event types),
`src/core/reporter.ts` (as-is), `src/hooks/_safe.ts` (as-is),
`src/tools/log.ts` (as-is if practical).

New: `src/state/schemas.ts` (rewrite), `src/core/runner.ts`,
`src/core/run-store.ts` (fold into store if simpler — one file is fine),
`src/workflows/{index,loader,<5 builtins>}.ts`, `src/hooks/events.ts`
(rewrite: session.idle/session.error → runner), `src/tools/{run,workflows,
runs,status,result,cancel,index}.ts`.

Delete: `src/cli.ts`, `src/core/{member,team-manager,message-bus,task-board,
file-locks,scratchpad,cost-tracker,escalation,activity,revalidate,rate-limit,
idle-monitor,whip-monitor,discord-notifier}.ts`,
`src/hooks/{permissions,activity-tracker}.ts`,
`src/templates/`, `src/tools/{create,spawn,message,broadcast,tasks,memo,
shutdown,inbox,team,_rate}.ts`, `examples/feature-build-demo.md` (replace
with a workflow demo), ADRs 002/004/005 + their evidence logs (superseded).

`package.json`: version 0.2.0, description "Workflow engine plugin for
OpenCode — Anthropic-style agentic workflows (chain, routing, parallel,
orchestrator-workers, evaluator-optimizer)", remove `bin`, remove
`peerDependencies`/`peerDependenciesMeta` (@opentui is unused), bump
`@opencode-ai/*` to ^1.18.7.

## Tests (bun test, in `tests/`)

- `store.test.ts` — event append, snapshot, replay; running→failed on reload.
- `workflows.test.ts` — zod validation (bad defs rejected), custom loader,
  placeholder rendering.
- `runner.test.ts` — each of the 5 patterns end-to-end against a **fake
  client** (records `session.create`/`promptAsync`, lets the test fire
  `session.idle`/`session.error` with canned assistant messages): ordering
  for chain, label matching for routing, concurrency + aggregate for
  parallel, planner JSON parsing + workers for orchestrator, PASS loop and
  maxIterations exhaustion for evaluator, cancel aborts sessions, step
  timeout fails the run.
- `tools.test.ts` — all 7 tools with the same fake-client harness.
- `plugin.test.ts` — init wires hooks, returns 7 tools, init failure returns
  `{}` without throwing.

Old test files are all deleted. `tests/_harness.ts` may be rewritten as the
fake-client harness.

Startup toast: `[orch] ready · 7 tools`.
