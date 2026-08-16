import { describe, expect, it } from "bun:test";
import tuiModule, { activitySummary } from "../src/tui.js";
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
      timestamp: Date.now(),
      goals: {
        lead: {
          sessionID: "lead",
          condition: "ship it",
          status: "active",
          createdAt: Date.now(),
          updatedAt: Date.now(),
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
          steps: {},
          iteration: 0,
          createdAt: Date.now(),
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
          createdAt: Date.now(),
        },
      },
    } satisfies Snapshot;

    expect(activitySummary(snapshot, "lead")).toBe(
      "goal active 2/20 · 120/1000 tok  │  workflows 1 running, 1 paused"
    );
    expect(activitySummary(snapshot, "other")).toBe(
      "workflows 1 running, 1 paused"
    );
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
