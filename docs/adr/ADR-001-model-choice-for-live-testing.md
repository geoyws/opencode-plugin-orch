# ADR-001: Model choice for opencode-plugin-orch live testing

**Status:** Accepted
**Date:** 2026-04-14
**Deciders:** George Yong, hook-hardener agent

## Context

`opencode-plugin-orch` ships 9 orchestration tools (`orch_create`, `orch_spawn`, `orch_message`, `orch_broadcast`, `orch_tasks`, `orch_memo`, `orch_status`, `orch_shutdown`, `orch_result`). The test suite verifies the plugin in isolation by importing modules directly, but that path does not exercise the real opencode plugin loader, the LLM-driven tool invocation path, or the streaming response cycle. We need a repeatable way to smoke-test the plugin end-to-end on the hax development box against a real opencode CLI session.

The goal set for this decision: pick a provider/model combination that (a) is available on hax today, (b) can be driven via `opencode run` without manual credential wrangling, and (c) will actually invoke our tools so the full pipeline is exercised.

### Candidates evaluated on hax

| Candidate | Configured? | Authenticated? | Reachable? | Live-test verdict |
|---|---|---|---|---|
| `minimax-coding-plan/MiniMax-M2.7-highspeed` | yes (primary `model`) | yes (API key in `~/.local/share/opencode/auth.json`) | yes | **Works.** Plugin loads, all 9 tools register, `orch_create` is actually invoked via LLM tool-use event, returns `Team "lead-smoke-1" created (id: team_mny1dyap_1)`, model echoes it back. See `evidence-live-smoke-test.log` in this directory for the captured run. |
| `ollama/qwen2.5-coder:7b` | yes (set as `small_model`) | n/a | **no** — no daemon on `:11434`, no binary on PATH | Unusable. Every `opencode run` now bleeds a ConnectionRefused stream error from the title-generator (visible in the evidence log as an `AI_RetryError` with `maxRetriesExceeded`), but the main tool-call path on the primary model still works. |
| `mlx-community/*` at `localhost:8080` | yes (provider block) | n/a | **no** — port 8080 is traefik, not an MLX server | Unusable. |
| `openrouter/google/gemma-4-26b-a4b-it:free` (Gemma 4 MoE, active-4B variant) | no (not in config) | no (no openrouter key in `auth.json`) | endpoint reachable | **Not verified.** Attempted during task #3 but no test run produced conclusive in-log evidence on this box — runs stalled or were killed before a usable response came back. OpenRouter's `:free` tier is known to rate-limit without a key, which is the most likely cause, but we cannot claim this was directly observed. |
| `openrouter/google/gemma-4-31b-it` (dense) | no | no | endpoint reachable | Not tested (same auth gap; would cost credits anyway). |

### Blocker uncovered during testing

Before any model test could succeed, the plugin was not actually loading in opencode. The log showed:

```
WARN service=plugin path=file:///root/work/src/opencode-plugin-orch
     message=Plugin ... does not expose a server entrypoint plugin has no server entrypoint
```

Reading the opencode binary revealed that `resolvePluginEntrypoint(spec, "server", pkg)` looks for `pkg.json.exports["./server"]` first, then falls back to legacy `pkg.json.main`. Our `package.json` had `"."` and `"./tui"` subpath exports and no `main`, so opencode resolved `undefined` and silently refused to import `dist/index.js`. A named `export const server = plugin` in `dist/index.js` alone is not sufficient — opencode must first be able to resolve the entrypoint path from `package.json` before it can even read the named exports.

**Fix:** add a `"./server"` subpath to `exports` pointing at `./dist/index.js` (same file as `"."`). This is a one-line `package.json` change with no code or type changes required.

This issue is the real reason the plugin appeared broken under `opencode run`. Every live-run attempt — regardless of model — failed to register any `orch_*` tool until this was fixed. Unit/integration tests passed throughout because they import modules directly, bypassing opencode's loader.

## Decision

1. **Live testing uses `minimax-coding-plan/MiniMax-M2.7-highspeed`** as the canonical smoke-test model on hax. It is the only provider with working auth on this box. After the package.json `./server` fix, the full load path is proven: plugin init → tool registry (all 9 tools) → LLM `tool_use` event → tool response → model response. The smoke test exercises `orch_create` directly; the other 8 tools are verified as registered but not individually invoked through the LLM path — they are covered by the 333-test unit/integration/e2e suite which drives each tool's `execute()` function directly.

2. **Gemma 4 MoE (`openrouter/google/gemma-4-26b-a4b-it:free`) is not a supported live-test target on hax at this time.** Requires an OpenRouter API key to escape free-tier rate limiting. If the user adds an OpenRouter credential, it becomes usable; until then it is documented here but not exercised.

3. **Ollama and MLX provider entries in `opencode.json` are aspirational on hax and must not be used as live-test targets.** They remain in config for local-Mac use. Fixing them is out of scope for this ADR.

4. **Smoke test procedure** (use this when verifying any change that touches the plugin loader, tool registry, hook wiring, or reporter):
   ```bash
   cd /tmp && mkdir -p oc-smoke && cd oc-smoke && rm -rf .opencode
   /root/.opencode/bin/opencode run \
     --model minimax-coding-plan/MiniMax-M2.7-highspeed \
     "Call orch_create with name='smoke'. Report the tool response."
   grep -E "orch|plugin" ~/.local/share/opencode/log/$(ls -t ~/.local/share/opencode/log/ | head -1)
   ```
   Required signals in the log:
   - `service=plugin path=file:///root/work/src/opencode-plugin-orch loading plugin`
   - `service=opencode-plugin-orch [orch] ready · 9 tools`
   - `service=tool.registry status=completed duration=<n> orch_create`
   - **Zero** `plugin has no server entrypoint` warnings.

## Consequences

**Positive.** We now have a repeatable smoke test that proves the full load path — package → opencode loader → plugin init → tool registry → LLM tool call → tool response. The package.json fix also makes the plugin portable: any consumer that installs via npm or points `plugin` at the directory will get working tool loading, not just the one-off local path on hax.

**Negative.** Our live-test coverage on hax is single-provider. A class of bugs that might only surface under a different tool-call format (e.g., Anthropic vs OpenAI function-calling shape) won't be caught here. Mitigation: the existing integration tests stub both shapes, and when the user brings the work back to local Mac, Claude models cover the other shape.

**Ollama/MLX config cruft.** The `small_model` misconfiguration (pointing at non-existent ollama) causes a noisy ConnectionRefused error on every `opencode run`. It does not break tool calls but pollutes logs and adds latency. Worth raising with the user to remove or point at a working provider, but not blocking.

**Gemma 4 MoE gap.** The original task was specifically to live-test against Gemma 4 MoE. That target is unreachable on hax without adding an openrouter key. If/when Gemma verification becomes a hard requirement, either (a) the user supplies an OpenRouter API key and we re-run, or (b) we retest on a local machine that has a different gateway to Gemma.

## References

- **Plugin loader bug evidence**: `~/.local/share/opencode/log/2026-04-14T020438.log` — contains `WARN ... plugin has no server entrypoint`.
- **Passing minimax smoke test evidence**: `docs/adr/evidence-live-smoke-test.log` (captured `opencode run --model minimax-coding-plan/MiniMax-M2.7-highspeed --print-logs --format json` at 2026-04-14T03:02:54, exit 0). Key lines:
  - `INFO [orch] ready · 9 tools`
  - `{"type":"tool_use", "tool":"orch_create", "state":{"status":"completed", "output":"Team \"lead-smoke-1\" created (id: team_mny1dyap_1)"}}`
  - `{"type":"text", "text":"Team \"lead-smoke-1\" created (id: team_mny1dyap_1)"}`
- **Gemma 4 MoE**: no positive or negative log evidence captured on this box. Runs during task #3 were inconclusive. The openrouter `:free` 429 hypothesis is not directly observed — if verification becomes a hard requirement, re-run with `--print-logs` and capture the raw output.
- **Fix commit**: adds `"./server"` subpath to `package.json` `exports`.
- **Memory entry**: `/root/.claude/projects/-root-work-src/memory/project_model_choices.md`.
