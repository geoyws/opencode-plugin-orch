# Workflow demo

A walkthrough of orch's built-in workflows — the five classic patterns
plus the 0.3.0 additions (worktree-isolated test authoring, programmatic
gates, adversarial review). Everything runs through the `orch_*` tools
inside an opencode session.

## Goal mode with automatic compaction

```text
/goal make typecheck and the full non-live test suite pass
/goal
/goal clear
```

The first command activates an independently evaluated loop. A `not_met`
verdict continues the original session automatically; turn, time, token, cost,
and no-progress budgets stop runaway work. Configure a cheap DeepSeek evaluator
and summarizer in the plugin options, or use `orch_goal` for per-goal budgets.

## Author and run a reusable DeepSeek workflow

```text
/workflow-author review input in parallel for security and performance, then synthesize; use deepseek/deepseek-chat
/workflow-run my-review src/core/runner.ts
/workflows
```

The current model writes version 1 JSON IR, then Orch validates and atomically
saves it. Generated JavaScript is never executed. Custom workflows default to
permission prompting; explicitly pass `{"permissionMode":"auto"}` only when
unattended execution is intended.

## 1. Discover the workflows

```
orch_workflows { action: "list" }
orch_workflows { action: "info", name: "parallel-review" }
```

## 2. Chain — draft → refine

```
orch_run {
  workflow: "chain-draft-refine",
  input: "Write a short README section explaining how to run this project's tests."
}
```

The `draft` step's output feeds the `refine` step via `{{output}}`.

## 3. Routing — classify, then handle

```
orch_run {
  workflow: "route-by-intent",
  input: "Add a --verbose flag to the build script and document it."
}
```

The classifier replies with one of `code` / `docs` / `other`; the matching
route's steps run as a chain.

## 4. Parallel — fan out reviews, then synthesize

```
orch_run {
  workflow: "parallel-review",
  input: "Review src/core/runner.ts",
  config: "{\"concurrency\": 3}"
}
```

`security`, `performance`, and `style` run concurrently; `aggregate`
receives every `{{steps.<id>.output}}`.

## 5. Orchestrator — plan, fan out workers, synthesize

```
orch_run {
  workflow: "orchestrate-tasks",
  input: "Migrate the config loader from JSON to TOML across the repo."
}
```

The planner emits a JSON array of subtasks; each becomes a `worker-N`
session; `aggregate` synthesizes the results. Because worker ids are
dynamic, their outputs can't be named in the aggregate template — the runner
appends them as `## Result of worker-N` sections instead.

## 6. Evaluator — generate, critique, repeat

```
orch_run {
  workflow: "evaluator-loop",
  input: "Write a one-paragraph product tagline for a workflow engine plugin.",
  config: "{\"maxIterations\": 3}"
}
```

The critic loops feedback to the generator until it replies `PASS` or the
iteration budget is exhausted (the final output then carries a note).

## 7. Evaluator + gate — test-fix-loop

```
orch_run {
  workflow: "test-fix-loop",
  input: "Add tests for src/core/worktree.ts and make the suite green.",
  config: "{\"gateCommand\": \"bun test\"}"
}
```

The generator writes or fixes tests AND the code under test; after each
iteration the gate command runs in the project dir (default `npm test` —
overridden here via `gateCommand`). Exit 0 ends the loop; otherwise the
last ~4000 chars of gate output feed back to the generator as
`{{feedback}}`. Budget: 5 iterations. There is no critic step — the gate
is the only judge.

## 8. Adversarial review — critic pinned to a stronger model

```
orch_run {
  workflow: "adversarial-review",
  input: "Write a design doc for the plugin's worktree copy-back mechanism.",
  config: "{\"stepModels\": {\"critic\": {\"providerID\": \"...\", \"modelID\": \"...\"}}}"
}
```

The generator produces the deliverable; the critic attacks it
(correctness bugs, security holes, edge cases, spec violations) and
replies `PASS` only when a genuine attempt to find defects turns up
nothing, up to 4 iterations. `stepModels` pins the critic to a
different/stronger model than the generator so it isn't grading its own
homework.

## Track and collect

```
orch_runs {}
orch_status { run: "run_m..." }        # id prefixes work
orch_result { run: "run_m...", format: "detailed" }
orch_cancel { run: "run_m..." }        # aborts in-flight step sessions
orch_control { action: "pause", run: "run_m..." }
orch_control { action: "resume", run: "run_m..." }
orch_control { action: "retry", run: "run_m..." }
```

For token-aware runs, add a config such as
`{"maxTokens":120000,"softTokens":80000,"maxAgents":12}`. Full outputs remain
available through `orch_result`; downstream prompts switch to persisted compact
checkpoints after the soft threshold.

## Custom workflows

Drop your own definitions into `.opencode/workflows/*.json` — they are
validated against the same schema as the built-ins:

```json
{
  "name": "my-chain",
  "description": "Summarize, then translate to German.",
  "pattern": "chain",
  "steps": [
    { "id": "summarize", "instructions": "Summarize in three sentences:\n\n{{input}}" },
    { "id": "translate", "instructions": "Translate to German:\n\n{{output}}" }
  ]
}
```
