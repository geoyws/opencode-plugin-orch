# Feature-build demo

An end-to-end walkthrough of using `opencode-plugin-orch` to coordinate a multi-member AI team building a single feature. This is a **narrative walkthrough**, not a runnable script — copy the prompts into your opencode lead session, read the expected responses, adapt to your own feature.

## Prerequisites

- `opencode-plugin-orch` installed (see [README.md](../README.md#installation)).
- `opencode` running with a working model (Claude, minimax, or whatever you've wired up).
- The 12 `orch_*` tools visible in your lead session. Verify with:

  ```
  opencode run "what orch_* tools do you have?"
  ```

  You should see `orch_create`, `orch_spawn`, `orch_message`, `orch_broadcast`, `orch_tasks`, `orch_memo`, `orch_status`, `orch_inbox`, `orch_team`, `orch_result`, `orch_shutdown`, `orch_log`. If fewer than 12 show up, see [Troubleshooting](#troubleshooting).

## Scenario

We're going to build a **"dark mode toggle"** feature for a hypothetical React app. The team will have:

- 1 **architect** (`plan` agent) — decomposes the feature into tasks, writes design decisions to the team memo.
- 2 **coders** (`code` agent) — claim tasks and implement them in parallel.
- 1 **tester** (`code` agent) — writes tests after implementation, files bug-fix tasks back to the board.

We'll use the built-in `feature-build` template so the lead doesn't have to spawn each member by hand.

## Step 1 — Create the team

**Prompt to the lead:**

> Create a `feature-build` team called `dark-mode-v1`. Pre-load `src/components/Header.tsx` and `src/theme.ts` into every member.

**Expected:** the lead calls `orch_create` with `template: "feature-build"`, and the plugin fires `orch_spawn` four times (architect, coder-1, coder-2, tester). You should see four `[orch] spawned member` toasts and a return like:

```
Created team "dark-mode-v1" from template feature-build.
  architect  (plan)  → mock-session-1
  coder-1    (code)  → mock-session-2
  coder-2    (code)  → mock-session-3
  tester     (code)  → mock-session-4
Files pre-loaded into each member: src/components/Header.tsx, src/theme.ts
```

## Step 2 — Brief the architect

The template's default instructions tell the architect to decompose and coordinate, but it doesn't know *what* feature. Give it the actual requirements:

**Prompt:**

> `orch_message` the architect on team `dark-mode-v1`: "Design a dark mode toggle for our React app. The toggle should live in the header, persist preference to `localStorage`, and flip a `data-theme` attribute on `<html>`. Decompose into tasks on the board via `orch_tasks`, and drop your design decisions into `orch_memo` under key `design` before the coders start claiming."

**Expected:** `orch_message` returns a delivery receipt. A moment later the architect's session wakes up and begins working. You won't see its output directly in your lead session — check Step 4 for how to monitor.

## Step 3 — Architect decomposes autonomously

While you wait, the architect is expected to:

1. Read the pre-loaded `Header.tsx` and `theme.ts` to understand the existing structure.
2. Write design decisions to `orch_memo` with `key: "design"` — e.g. "use `useEffect` + `localStorage` in a `ThemeProvider`, toggle CSS variables via `data-theme`".
3. Add 3–5 tasks via `orch_tasks add` — e.g. "add ThemeProvider to App.tsx", "add toggle button to Header", "wire localStorage persistence", "add CSS variables for dark palette".
4. Broadcast a heads-up to the coders via `orch_broadcast` so they know tasks are ready.

If you want to confirm, ask the lead:

> Show me the task board and memo for `dark-mode-v1`.

The lead will call `orch_tasks list` and `orch_memo list` on your behalf.

## Step 4 — Monitor with orch_status

At any point you can get a live snapshot of the team:

**Prompt:**

> Show `orch_status` for `dark-mode-v1`.

**Expected output** (powerline-style box):

```
┌─ dark-mode-v1 ────────────────────────────────────────┐
│  architect   plan  busy   memo.set design    $0.012  │
│  coder-1     code  busy   tasks.claim #t2     $0.008  │
│  coder-2     code  ready  -                   $0.004  │
│  tester      code  idle   -                   $0.000  │
│  tasks: 1 claimed, 2 available, 0 done                │
│  messages: 3 unread (lead inbox)                      │
└───────────────────────────────────────────────────────┘
```

The per-member `activity` column is fed by the activity tracker hook — it shows the last tool each member called plus its target, so you can see who's actually working vs. waiting.

## Step 5 — Inbox check

Peer DMs between team members are mirrored into the lead's inbox as a read-only feed (see [ADR-002](../docs/adr/ADR-002-three-tier-lead-visibility.md) for the why):

**Prompt:**

> Show `orch_inbox` for `dark-mode-v1`.

**Expected:** a list of recent `orch_message` and `orch_broadcast` traffic, most recent first, with unread ones highlighted. You'll typically see the architect broadcasting decomposition, the coders DM'ing each other to split files, and the tester reporting back.

## Step 6 — Aggregate results

Once the task board is empty and everyone is back to `ready`:

**Prompt:**

> Get `orch_result` for `dark-mode-v1` in `summary` format.

**Expected:** one-line result per member plus a team-level roll-up. For a detailed dump with per-task outputs and the memo contents, pass `format: "detailed"` instead.

## Step 7 — Shut the team down

**Prompt:**

> `orch_shutdown` `dark-mode-v1`.

**Expected:** each member session is aborted, any file locks they held are released, and a final snapshot is written. The team is marked shutdown in the store — its history stays queryable via `orch_team info dark-mode-v1` until you delete the project's `.opencode/plugin-orch` directory.

## Troubleshooting

- **Plugin didn't load.** Check `~/.local/share/opencode/log/` for `[orch] ready · 12 tools`. The fastest check is `orch_log` itself: `orch_log action=tail lines=30` (once the plugin is loaded). If missing, you'll also see `plugin has no server entrypoint` — rebuild via `pnpm run build` and verify `package.json` has a `./server` entry in `exports`. See [ADR-003](../docs/adr/ADR-003-plugin-entrypoint-discovery.md) for the full story.
- **Member stuck in `initializing`.** Open the member's underlying opencode session via the TUI switcher — it's probably hung on an LLM call. `orch_shutdown` the team and retry with a faster model.
- **Rate limit errors during Step 3.** The default per-tool rate limit is generous but the architect's decomposition burst can trip it. Raise it on the team at create time: `"Create a feature-build team dark-mode-v1 with rateLimit 120/60s"`.
- **Unknown `orch_frobnicate` tool warnings.** Shouldn't happen, but if you see one, check [ADR-004](../docs/adr/ADR-004-member-tool-scoping-semantics.md) — it's the allowlist closure doing its job.

## Related reading

- [ADR-001](../docs/adr/ADR-001-model-choice-for-live-testing.md) — why we smoke-test against minimax instead of production Claude.
- [ADR-002](../docs/adr/ADR-002-three-tier-lead-visibility.md) — how the lead sees peer DMs without being spammed.
- [ADR-003](../docs/adr/ADR-003-plugin-entrypoint-discovery.md) — the `./server` exports subpath and why your plugin silently fails without it.
- [ADR-004](../docs/adr/ADR-004-member-tool-scoping-semantics.md) — why members can't spawn sub-teams, and how `body.tools` is an override map, not a closed allowlist.
