import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import tuiModule, { activityLines, activitySummary, formatElapsed, runTokens } from "../src/tui.js";
import pkg from "../package.json";
import type { Snapshot } from "../src/state/schemas.js";

describe("separate TUI entrypoint", () => {
  it("loads without the server plugin and is exported as ./tui", () => {
    expect(tuiModule.id).toBe("opencode-plugin-orch");
    expect(typeof tuiModule.tui).toBe("function");
    expect((tuiModule as { server?: unknown }).server).toBeUndefined();
    expect(pkg.exports["./tui"].import).toBe("./dist/tui-wrapper.js");
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
          workerSessionID: "goal_worker",
          workerStatus: "running",
          steering: [],
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
              usage: {
                input: 10,
                output: 20,
                reasoning: 5,
                cacheRead: 100,
                cacheWrite: 2,
              },
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
      "goal active 2/20 · worker running · 1 agent",
      "parallel-review · running · 2m 0s elapsed · 1 agent",
      "test-fix-loop · paused · 1m 0s elapsed · 0 agents",
      "1 agent running across 2 workflows",
    ]);
    expect(activitySummary(snapshot, "other", 130_000)).toBe(
      "parallel-review · running · 2m 0s elapsed · 1 agent\n" +
        "test-fix-loop · paused · 1m 0s elapsed · 0 agents\n" +
        "1 agent running across 2 workflows"
    );
    expect(activityLines(snapshot, undefined, 130_000)).not.toContain(
      "goal active 2/20 · worker running · 1 agent"
    );
    expect(activityLines(snapshot, "lead", 130_000, 60)).toEqual([
      "goal active · running · 1 agent",
      "2 workflows · 1 agent",
    ]);
    expect(activityLines(snapshot, "lead", 130_000).join(" ")).not.toContain("tok");
    expect(runTokens(snapshot.runs.run_1)).toBe("137");
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

  it("deactivates and reactivates the built TUI plugin after an atomic generation switch", async () => {
    const dist = path.resolve(import.meta.dir, "..", "dist");
    const wrapper = path.join(dist, "tui-wrapper.js");
    const hot = path.join(dist, ".hot");
    if (!fs.existsSync(wrapper) || !fs.existsSync(path.join(hot, "manifest.json"))) return;

    // Isolate the manifest so this lifecycle probe cannot reload a concurrently
    // running server E2E instance that uses the real dist/.hot generation.
    const probe = fs.mkdtempSync(path.join(dist, ".tui-wrapper-test-"));
    fs.copyFileSync(wrapper, path.join(probe, "tui-wrapper.js"));
    fs.cpSync(hot, path.join(probe, ".hot"), { recursive: true });
    const manifestPath = path.join(probe, ".hot", "manifest.json");
    const disposers: Array<() => void> = [];
    let deactivated = 0;
    let activated = 0;
    let slotsRegistered = 0;
    try {
      const built = await import(
        `${new URL(`file://${path.join(probe, "tui-wrapper.js")}`).href}?probe=${Date.now()}`
      );
      await built.default.tui(
        {
          keymap: { registerLayer: () => undefined },
          route: { register: () => undefined, navigate: () => undefined },
          slots: {
            register: () => {
              slotsRegistered += 1;
              return "orch-slots";
            },
          },
          state: { path: { directory: probe } },
          theme: { current: { text: "white", textMuted: "gray", accent: "blue" } },
          lifecycle: {
            signal: new AbortController().signal,
            onDispose: (dispose: () => void) => disposers.push(dispose),
          },
          plugins: {
            deactivate: async () => { deactivated += 1; },
            activate: async () => { activated += 1; },
          },
        },
        undefined,
        { id: "opencode-plugin-orch" }
      );

      const registrationDeadline = Date.now() + 1_500;
      while (slotsRegistered === 0 && Date.now() < registrationDeadline) {
        await Bun.sleep(10);
      }
      expect(slotsRegistered).toBe(1);

      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8")) as {
        version: string;
        server: string;
        tui: string;
      };
      const temporary = `${manifestPath}.tmp`;
      fs.writeFileSync(temporary, JSON.stringify({ ...manifest, version: `${manifest.version}-next` }));
      fs.renameSync(temporary, manifestPath);

      const deadline = Date.now() + 2_500;
      while (activated === 0 && Date.now() < deadline) {
        await Bun.sleep(50);
      }
      expect(deactivated).toBe(1);
      expect(activated).toBe(1);
    } finally {
      for (const dispose of disposers) dispose();
      fs.rmSync(probe, { recursive: true, force: true });
    }
  }, 5_000);

  it("returns built TUI activation before a slow implementation settles", async () => {
    const dist = path.resolve(import.meta.dir, "..", "dist");
    const wrapper = path.join(dist, "tui-wrapper.js");
    const hot = path.join(dist, ".hot");
    if (!fs.existsSync(wrapper) || !fs.existsSync(path.join(hot, "manifest.json"))) return;

    const probe = fs.mkdtempSync(path.join(dist, ".tui-startup-test-"));
    fs.copyFileSync(wrapper, path.join(probe, "tui-wrapper.js"));
    fs.mkdirSync(path.join(probe, ".hot"));
    fs.writeFileSync(
      path.join(probe, ".hot", "slow.js"),
      "export default { id: 'opencode-plugin-orch', tui: async () => new Promise(() => {}) };\n"
    );
    fs.writeFileSync(
      path.join(probe, ".hot", "manifest.json"),
      JSON.stringify({ version: "startup-probe", server: "unused.js", tui: "slow.js" })
    );
    const disposers: Array<() => void> = [];
    try {
      const built = await import(
        `${new URL(`file://${path.join(probe, "tui-wrapper.js")}`).href}?startup=${Date.now()}`
      );
      const activation = built.default.tui(
        {
          lifecycle: {
            signal: new AbortController().signal,
            onDispose: (dispose: () => void) => disposers.push(dispose),
          },
          plugins: { deactivate: async () => undefined, activate: async () => undefined },
        },
        undefined,
        { id: "opencode-plugin-orch" }
      );
      const result = await Promise.race([
        activation.then(() => "returned"),
        Bun.sleep(75).then(() => "blocked"),
      ]);
      expect(result).toBe("returned");
    } finally {
      for (const dispose of disposers) dispose();
      fs.rmSync(probe, { recursive: true, force: true });
    }
  });
});
