# DeepSeek v0.4 live receipt

- **Date:** 2026-08-16
- **Model:** `deepseek/deepseek-v4-pro`
- **Billing route:** IFCA-scoped OpenCode profile using the environment variable
name `DEEPSEEK_API_KEY_IFCA`; no secret value was printed or persisted.

## Command

```bash
OPENCODE_CONFIG=~/.config/opencode/opencode-deepseek-ifca.json \
ORCH_LIVE=1 \
ORCH_LIVE_MODEL=deepseek/deepseek-v4-pro \
pnpm run test:e2e:live
```

## Results

| Scenario | Objective evidence | Independent judge |
|---|---|---|
| `chain-draft-refine` | One nine-word, single-sentence tagline | PASS after tightening the reusable refinement constraint and adding an objective 12-word ceiling |
| `adversarial-review` | Corrected `return lo + 1` to `return lo` without rewriting the algorithm | PASS |
| `test-fix-loop` | Fixed the even-length median formula; real gate reported three passing tests and no test-file changes | PASS |
| `author-tests` | Generated meaningful cart tests across normal, zero, fractional, empty, and discount-boundary behavior | PASS |

The first tagline attempt was topical but rejected by the judge as an
explanatory product description. The workflow prompt and test were made more
objective: short-form requests must remain conventionally concise, and this
scenario now requires at most 12 words. Its paid rerun passed. The other three
scenarios passed on the full live invocation. Together these executions provide
a passing receipt for every paid scenario; none were skipped.

The live tier remains opt-in because it consumes provider tokens and its judge
is probabilistic. The hermetic suite remains the deterministic ordinary gate.
