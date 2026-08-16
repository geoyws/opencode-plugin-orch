import { describe, expect, it } from "bun:test";
import tuiModule, { activityLines, activitySummary, formatElapsed } from "../src/tui.js";
import pkg from "../package.json";
import type { Snapshot } from "../src/state/schemas.js";

describe("separate TUI entrypoint", () => {
  it("loads without the server plugin and is exported as ./tui", () => {
    expect(tuiModule.id).toBe("opencode-plugin-orch");
    expect(typeof tuiModule.tui).toBe("function");
    expect((tuiModule as { server?: unknown }).server).toBeUndefined();
    expect(pkg.exports["./tui"].import).toBe("./dist/tui.js");
  });

  it("summarizes active goals and workflow execution for the prompt indicator", () => {
    const snapshot = {
      timestamp: 130_000,
      goals: {
        lead: {
          sessionID: "lead",
          condition: "ship it",
          status: "active",
          createdAt: 1_000,
          updatedAt: 2_000,
          turns: 2,
          maxTurns: 20,
          maxDurationMs: 1000,
          maxTokens: 1000,
          softTokens: 700,
          noProgressLimit: 3,
          noProgressTurns: 0,
          observedTokens: 120,
          accountedMessageIDs: [],
        },
      },
      runs: {
        run_1: {
          id: "run_1",
          workflow: "parallel-review",
          pattern: "parallel",
          input: "review",
          status: "running",
          config: {
            maxIterations: 3,
            concurrency: 4,
            stepTimeoutMs: 1000,
            maxStepOutputChars: 50000,
            keepSessions: false,
            stepRetries: 1,
            maxAgents: 20,
            permissionMode: "auto",
          },
          steps: {
            reviewer: {
              id: "reviewer",
              status: "running",
              sessionID: "sess_reviewer",
              startedAt: 10_000,
            },
          },
          iteration: 0,
          createdAt: 10_000,
        },
        run_2: {
          id: "run_2",
          workflow: "test-fix-loop",
          pattern: "evaluator",
          input: "fix",
          status: "paused",
          config: {
            maxIterations: 3,
            concurrency: 4,
            stepTimeoutMs: 1000,
            maxStepOutputChars: 50000,
            keepSessions: false,
            stepRetries: 1,
            maxAgents: 20,
            permissionMode: "auto",
          },
          steps: {},
          iteration: 0,
          createdAt: 70_000,
        },
      },
    } satisfies Snapshot;

    expect(activityLines(snapshot, "lead", 130_000)).toEqual([
      "goal active 2/20 · 120/1000 tok",
      "parallel-review · running · 2m 0s elapsed · 1 agent",
      "test-fix-loop · paused · 1m 0s elapsed · 0 agents",
      "1 agent running across 2 workflows",
    ]);
    expect(activitySummary(snapshot, "other", 130_000)).toBe(
      "parallel-review · running · 2m 0s elapsed · 1 agent\n" +
        "test-fix-loop · paused · 1m 0s elapsed · 0 agents\n" +
        "1 agent running across 2 workflows"
    );
    expect(formatElapsed(3_661_900)).toBe("1h 1m 1s");
  });

  it("registers activity indicators on home and session prompts", async () => {
    let registered: { slots?: Record<string, unknown> } | undefined;
    await tuiModule.tui(
      {
        keymap: { registerLayer: () => undefined },
        route: { register: () => undefined },
        slots: {
          register: (plugin: { slots?: Record<string, unknown> }) => {
            registered = plugin;
            return "orch-slots";
          },
        },
      } as never,
      undefined,
      {} as never
    );
    expect(typeof registered?.slots?.home_prompt_right).toBe("function");
    expect(typeof registered?.slots?.session_prompt_right).toBe("function");
  });
});
