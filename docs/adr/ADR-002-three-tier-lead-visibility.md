# ADR-002: Three-tier lead visibility for peer DMs

**Status:** Accepted
**Date:** 2026-04-14

## Context

`opencode-plugin-orch` gives every team member a direct message channel to every other member via `orch_message` and `orch_broadcast`. Members use this to coordinate — the investigator hands the fixer a root-cause writeup, the fixer pings the verifier when a patch lands, etc. The original implementation routed these peer messages through `MessageBus.send` / `MessageBus.broadcast`, which delivered them to the recipient's inbox but left the **team lead** entirely blind: the lead had no signal that peer coordination was even happening, let alone what was being said. In practice that meant a lead orchestrating a long-running team would watch `orch_status` go quiet for minutes while members conversed behind its back, and then be surprised by the final result.

Three constraints shaped the fix:

1. **Different leads have different interaction patterns.** An interactive lead driving the TUI wants to see messages as they happen. A lead that's been doing other work for five minutes wants to pull a snapshot when it comes back. A lead whose session was restarted wants to catch up on messages it missed while offline. One signal channel cannot serve all three.
2. **Not everything is a peer DM.** Messages where the lead itself is the sender (wake-up pings, broadcast commands) should *not* surface to the lead as "new peer activity" — that would be a feedback loop and pure noise. The filter is simply `m.from !== "lead"`.
3. **Noise budget.** A busy team can produce dozens of peer messages per minute. Any channel that shows them all verbatim would drown the lead. Previews must be short and counts must be bounded.

## Decision

Surface peer DMs to the lead through **three coordinated tiers**, each with a different delivery model, and let the lead pick whichever fits its current interaction pattern.

### Tier 1 — Push (TUI toast)

`MessageBus.send` and `MessageBus.broadcast` fire a toast via the Reporter whenever `m.from !== "lead"`. The toast shows `<team> · <from> → <to>: <preview>` with the preview hard-truncated to 60 characters so a paragraph-long DM doesn't blow up the TUI. Delivery is fire-and-forget — failures are swallowed inside `_safe.ts` so a broken reporter can't back-pressure the bus.

**When it helps.** An interactive lead watching the session: messages appear the moment they're sent, no polling.

### Tier 2 — Pull (`orch_status` Recent messages section)

The `orch_status` tool renders a `Recent messages:` section at the bottom of its powerline output. It pulls the most recent peer messages from the store (filtered `m.from !== "lead"`), showing the last 5 in normal mode and the last 20 in verbose mode, each line as `<age> <from> → <to>: <preview>`. Empty state renders as `Recent messages: (none)`.

**When it helps.** A lead that has been doing other work and wants a quick snapshot — "anything happen while I was gone?" — without committing to a durable read-receipt.

### Tier 3 — Durable (`orch_inbox` tool)

`orch_inbox` is a dedicated tool with actions `list`, `count`, and `mark_read`. It reads peer messages from the event-sourced store and tracks a `leadInboxLastSeenAt` cursor **per team**. `list` returns unread messages by default (pass `all=true` to include already-read), `count` returns just the unread count, and `mark_read` advances the cursor to "now", clearing the inbox. The cursor lives in the JSONL event log, so it survives process restarts and snapshot+replay.

**When it helps.** A lead resuming a session after a crash or restart, or any lead that wants at-least-once delivery semantics instead of "whatever happens to be on screen."

### Why three, not one

Collapsing these would break at least one use case:

- **Push only** misses leads that are away from the TUI; toasts scroll off.
- **Pull only** means the lead has to remember to poll, and misses messages it didn't happen to catch in the last-5 window.
- **Durable only** has no latency story — the lead only sees messages when it asks.

Each tier has a different cost/benefit curve (push is lowest-latency but ephemeral; durable has highest overhead but is lossless), and the lead model picks based on context. Toasts cost roughly zero; the `orch_status` section costs one store scan per call; the inbox cursor costs one extra event per `mark_read`.

## Consequences

**Positive.**

- Leads are no longer blind to peer coordination. The common "what did I miss?" question has an authoritative answer (`orch_inbox list`) and a quick-look answer (`orch_status`) and a real-time answer (toasts).
- The three paths reuse the same source of truth — the event-sourced message log — so they cannot disagree about *what* the messages were, only about *which subset* each chooses to show.
- The `m.from !== "lead"` filter is applied identically in all three tiers, so the lead never sees its own messages echoed back.

**Negative.**

- **Three code paths to keep in sync.** If the filter predicate, the preview format, or the "peer DM" definition changes, all three tiers must be updated together. A drift here would be a subtle bug — a message showing in toasts but not in `orch_inbox` would look like a lost message.
- **Noise budget is mitigated but not solved.** The 60-char preview truncation bounds per-message cost, but a team that fires 50 messages/minute will still flood the TUI with toasts. If this becomes painful, the fix is a rate-limit in Tier 1 only — the other tiers are unaffected because they aggregate.
- **Cursor semantics surprise.** `mark_read` clears *current* unread, not "up to this specific message id." A message that arrives during the same tick as `mark_read` will show up in the next `list` call. This matches typical inbox semantics but is worth flagging if a lead writes automation around it.

## References

- **Tier 1 + Tier 2 + README initial draft**: commit `adbbf40` — "feat: surface peer DMs to team lead + add README". Adds the toast in `MessageBus.send` / `MessageBus.broadcast` and the `Recent messages:` section in `orch_status`.
- **Tier 3**: commit `66827e6` — "feat: add orch_inbox tool for team lead peer-DM inbox". Adds `orch_inbox` with the `leadInboxLastSeenAt` cursor per team.
- **Live evidence**: `docs/adr/evidence-live-spawn-e2e.log` — the captured `orch_status` output includes the `Recent messages: (none)` line, confirming Tier 2 renders in the live tool-use path (not just in unit tests).
- **Filter definition**: `m.from !== "lead"` — applied in `src/core/message-bus.ts` (Tier 1), `src/tools/status.ts` (Tier 2), and `src/tools/inbox.ts` (Tier 3). If this predicate changes, all three must change together.
