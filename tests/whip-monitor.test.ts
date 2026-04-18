// Unit tests for WhipMonitor — verifies timer reset/arm behaviour, prompt
// injection via promptAsync, and the self-inject suppression flag.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { WhipMonitor } from "../src/core/whip-monitor.js";
import { Reporter } from "../src/core/reporter.js";
import { MockClient } from "./_harness.js";

function makePromptFile(content = "WHIP: continue the work."): string {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "whip-"));
  const p = path.join(tmp, "whip-prompt.md");
  fs.writeFileSync(p, content, "utf-8");
  return p;
}

describe("WhipMonitor", () => {
  let client: MockClient;
  let reporter: Reporter;
  let tmpDir: string;

  beforeEach(() => {
    client = new MockClient();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "whip-reporter-"));
    reporter = new Reporter(client, tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("fires after delay and injects the shared prompt", async () => {
    const promptPath = makePromptFile("WHIP: hello world");
    const mon = new WhipMonitor(client, reporter, { delayMs: 20, promptPath });

    mon.onAssistantIdle("lead-1");

    await new Promise((r) => setTimeout(r, 60));

    const calls = client.callsFor("session.promptAsync");
    expect(calls.length).toBe(1);
    const args = calls[0]!.args as {
      path: { id: string };
      body: { parts: Array<{ type: string; text: string }> };
    };
    expect(args.path.id).toBe("lead-1");
    expect(args.body.parts[0]!.text).toContain("WHIP: hello world");

    mon.stop();
  });

  test("user message resets the timer", async () => {
    const promptPath = makePromptFile();
    const mon = new WhipMonitor(client, reporter, { delayMs: 40, promptPath });

    mon.onUserMessage("lead-1");
    await new Promise((r) => setTimeout(r, 20));
    // Reset before firing
    mon.onUserMessage("lead-1");
    await new Promise((r) => setTimeout(r, 25));

    // 45ms elapsed since second reset, but delay is 40ms from second reset —
    // might have fired. Use shorter delays for a deterministic check.
    // Instead, reset and verify the prior timer never fired.
    const firedBefore = client.callsFor("session.promptAsync").length;
    // Wait long enough for any earlier timer to have fired had it not been cleared.
    await new Promise((r) => setTimeout(r, 30));
    const firedAfter = client.callsFor("session.promptAsync").length;

    // Total elapsed from first reset: ~75ms (≫ 40ms).
    // If resets didn't work, we'd see ≥2 calls. With correct reset, we see 1.
    expect(firedAfter).toBe(1);
    expect(firedBefore).toBeLessThanOrEqual(firedAfter);

    mon.stop();
  });

  test("injected prompt does NOT reset the timer (suppression flag)", async () => {
    const promptPath = makePromptFile();
    const mon = new WhipMonitor(client, reporter, { delayMs: 30, promptPath });

    mon.onAssistantIdle("lead-1");
    await new Promise((r) => setTimeout(r, 60));
    expect(client.callsFor("session.promptAsync").length).toBe(1);

    // Simulate the injected prompt arriving back as a user message event.
    // This should be suppressed (no timer re-arm).
    mon.onUserMessage("lead-1");
    // No new timer should be running — verify by letting time pass without
    // a fresh arm.
    await new Promise((r) => setTimeout(r, 60));
    expect(client.callsFor("session.promptAsync").length).toBe(1);

    // Now a REAL user message should reset/arm the timer as usual.
    mon.onUserMessage("lead-1");
    await new Promise((r) => setTimeout(r, 60));
    expect(client.callsFor("session.promptAsync").length).toBe(2);

    mon.stop();
  });

  test("multiple lead sessions are tracked independently", async () => {
    const promptPath = makePromptFile();
    const mon = new WhipMonitor(client, reporter, { delayMs: 20, promptPath });

    mon.onAssistantIdle("lead-A");
    mon.onAssistantIdle("lead-B");
    await new Promise((r) => setTimeout(r, 60));

    const calls = client.callsFor("session.promptAsync");
    const ids = calls.map((c) => (c.args as { path: { id: string } }).path.id).sort();
    expect(ids).toEqual(["lead-A", "lead-B"]);

    mon.stop();
  });

  test("onAssistantIdle is a no-op when a timer is already armed", async () => {
    const promptPath = makePromptFile();
    const mon = new WhipMonitor(client, reporter, { delayMs: 40, promptPath });

    mon.onUserMessage("lead-1"); // arm
    await new Promise((r) => setTimeout(r, 20));
    mon.onAssistantIdle("lead-1"); // should NOT re-arm (extending delay)
    await new Promise((r) => setTimeout(r, 30));

    // At ~50ms elapsed since user message, >40ms delay → timer should have fired.
    expect(client.callsFor("session.promptAsync").length).toBe(1);

    mon.stop();
  });

  test("missing prompt file → graceful no-op, warns once", async () => {
    const mon = new WhipMonitor(client, reporter, {
      delayMs: 10,
      promptPath: "/nonexistent/whip-prompt.md",
    });

    mon.onAssistantIdle("lead-1");
    mon.onAssistantIdle("lead-2");
    await new Promise((r) => setTimeout(r, 40));

    // No prompt injected because the file can't be read.
    expect(client.callsFor("session.promptAsync").length).toBe(0);
    // Reporter should have warned (at least once).
    const warns = client.toasts.filter((t) => t.variant === "warning");
    expect(warns.length).toBeGreaterThanOrEqual(1);
    expect(warns[0]!.message).toContain("prompt not found");

    mon.stop();
  });

  test("stop() clears all armed timers", async () => {
    const promptPath = makePromptFile();
    const mon = new WhipMonitor(client, reporter, { delayMs: 20, promptPath });

    mon.onAssistantIdle("lead-1");
    mon.onAssistantIdle("lead-2");
    mon.stop();

    await new Promise((r) => setTimeout(r, 60));
    expect(client.callsFor("session.promptAsync").length).toBe(0);
  });

  test("promptAsync failure clears suppression flag so real input still resets", async () => {
    const promptPath = makePromptFile();
    const mon = new WhipMonitor(client, reporter, { delayMs: 10, promptPath });

    // Force promptAsync to throw.
    const original = client.session.promptAsync;
    client.session.promptAsync = async () => {
      throw new Error("synthetic failure");
    };

    mon.onAssistantIdle("lead-1");
    await new Promise((r) => setTimeout(r, 40));

    // Restore so subsequent calls work.
    client.session.promptAsync = original;

    // The injection failed — the next user message should NOT be suppressed.
    mon.onUserMessage("lead-1");
    await new Promise((r) => setTimeout(r, 30));

    // A fresh timer should have fired via the restored promptAsync.
    expect(client.callsFor("session.promptAsync").length).toBeGreaterThanOrEqual(1);

    mon.stop();
  });
});
