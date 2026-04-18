// Autonomous-work whip for the OpenCode harness.
//
// Counterpart of the Claude Code /whip skill — when a lead session has been
// quiet for ~15 min, inject the shared whip-prompt.md so the lead continues
// working (re-check team, dispatch work, escalate blockers) without the user
// having to re-prompt.
//
// Shared prompt file: /root/.claude/skills/whip/whip-prompt.md — single
// source of truth across both harnesses.
//
// Wiring (see src/hooks/events.ts):
//   - message.updated with role="user"  → onUserMessage(sessionID)
//   - session.idle on a lead session    → onAssistantIdle(sessionID)
//
// Timer behaviour:
//   - Fresh 15-min setTimeout on every user message (reset on input).
//   - When assistant goes idle and no timer is armed, arm one (covers the
//     case where the lead ends its own turn with no user input).
//   - When the timer fires, inject the whip prompt via promptAsync and
//     set a suppression flag so the synthetic user message we just sent
//     doesn't reset the next timer.
//
// Graceful degradation:
//   - Missing whip-prompt.md → logs once, then no-ops.
//   - promptAsync failure → logged, timer re-arms on next idle.

import * as fs from "node:fs";
import type { Reporter } from "./reporter.js";

const DEFAULT_DELAY_MS = 15 * 60 * 1000;
const DEFAULT_PROMPT_PATH = "/root/.claude/skills/whip/whip-prompt.md";

interface WhipClient {
  session: {
    promptAsync(params: {
      path: { id: string };
      body: { parts: Array<{ type: "text"; text: string }> };
    }): Promise<unknown>;
  };
}

interface SessionState {
  timer: NodeJS.Timeout | undefined;
  // Set when we inject our own prompt so the next inbound user message on
  // this session (which IS our injected prompt, replayed as a user turn)
  // doesn't count as real user input and reset the timer.
  suppressNextUserReset: boolean;
}

export class WhipMonitor {
  private sessions = new Map<string, SessionState>();
  private promptCache: string | undefined;
  private promptMissingWarned = false;

  constructor(
    private client: WhipClient,
    private reporter: Reporter,
    private opts: {
      delayMs?: number;
      promptPath?: string;
    } = {}
  ) {}

  /** Reset the 15-min timer for a lead session. Called on every user message. */
  onUserMessage(sessionID: string): void {
    const state = this.getState(sessionID);
    if (state.suppressNextUserReset) {
      // The message we're seeing is our own injected whip prompt replayed as
      // a user turn — don't reset on it, but DO clear the flag so the NEXT
      // real user input resets the timer.
      state.suppressNextUserReset = false;
      return;
    }
    this.arm(sessionID);
  }

  /** Ensure a timer is armed when the assistant goes idle. */
  onAssistantIdle(sessionID: string): void {
    const state = this.sessions.get(sessionID);
    if (state?.timer) return;
    this.arm(sessionID);
  }

  /** Clear the timer for a session (e.g. team shutdown). */
  clear(sessionID: string): void {
    const state = this.sessions.get(sessionID);
    if (state?.timer) {
      clearTimeout(state.timer);
      state.timer = undefined;
    }
  }

  /** Tear down — called from plugin cleanup. */
  stop(): void {
    for (const state of this.sessions.values()) {
      if (state.timer) clearTimeout(state.timer);
    }
    this.sessions.clear();
  }

  /** Test hook — force-fire the timer for a session. */
  async fireNow(sessionID: string): Promise<void> {
    await this.fire(sessionID);
  }

  // ── internals ─────────────────────────────────────────────────

  private getState(sessionID: string): SessionState {
    let s = this.sessions.get(sessionID);
    if (!s) {
      s = { timer: undefined, suppressNextUserReset: false };
      this.sessions.set(sessionID, s);
    }
    return s;
  }

  private arm(sessionID: string): void {
    const state = this.getState(sessionID);
    if (state.timer) clearTimeout(state.timer);
    const delay = this.opts.delayMs ?? DEFAULT_DELAY_MS;
    state.timer = setTimeout(() => {
      // Fire-and-forget — any throw is swallowed inside fire().
      void this.fire(sessionID);
    }, delay);
    state.timer.unref?.();
  }

  private async fire(sessionID: string): Promise<void> {
    const state = this.getState(sessionID);
    state.timer = undefined;

    const prompt = this.loadPrompt();
    if (!prompt) return;

    state.suppressNextUserReset = true;
    try {
      await this.client.session.promptAsync({
        path: { id: sessionID },
        body: { parts: [{ type: "text", text: prompt }] },
      });
    } catch (err) {
      // Injection failed — clear the suppression flag so we don't swallow a
      // real user input that happens to arrive next. Timer will re-arm on
      // the next session.idle.
      state.suppressNextUserReset = false;
      this.reporter.warn("[orch] whip", `promptAsync failed: ${formatErr(err)}`);
    }
  }

  private loadPrompt(): string | undefined {
    if (this.promptCache !== undefined) return this.promptCache;
    const p = this.opts.promptPath ?? DEFAULT_PROMPT_PATH;
    try {
      this.promptCache = fs.readFileSync(p, "utf-8");
      return this.promptCache;
    } catch {
      if (!this.promptMissingWarned) {
        this.promptMissingWarned = true;
        this.reporter.warn("[orch] whip", `prompt not found at ${p} — whip disabled`);
      }
      return undefined;
    }
  }
}

function formatErr(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
