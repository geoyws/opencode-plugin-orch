// True end-to-end tests: spawn a real `opencode serve` process via
// @opencode-ai/sdk's createOpencode(), load the built plugin (dist/) through
// injected config, and drive full workflow runs through the real HTTP/SSE
// stack — no fake client anywhere in this file.
//
// Two tiers (the live tier moved to tests/e2e-live.test.ts):
//
//   Tier 1 — real server boot + plugin load, no model calls.
//     Tool registration, plugin init evidence (init.log in the project store
//     dir), SSE event endpoint. Custom-workflow loading is asserted in the
//     first Tier 2 test instead (it is only observable through a model-driven
//     tool call; there is no API surface for it otherwise).
//
//   Tier 2 — full workflow runs against a MOCK LLM provider.
//     A tiny in-process HTTP server (Bun.serve on 127.0.0.1) implements just
//     enough of the OpenAI chat-completions streaming API for opencode's
//     bundled @ai-sdk/openai-compatible provider. The mock is scripted per
//     scenario: the LEAD session gets tool_calls (orch_run / orch_cancel /
//     orch_workflows), STEP sessions (identified by E2E-* markers the test
//     workflows embed in their step instructions) get plain assistant text.
//     Runs are asserted against the plugin's own store
//     (<project>/.opencode/plugin-orch/runs.jsonl) — the source of truth —
//     plus the mock's request log (prompt contents, model routing).
//
// Hermeticity:
//   - The server boots with HOME redirected to a temp dir, so the global
//     user config (real providers, MCP servers, plugins) is invisible.
//   - Two caches the server would otherwise fetch at boot are pre-seeded
//     from the local opencode installation: the models.dev cache
//     (~/.cache/opencode/models.json) and the @opencode-ai/plugin runtime
//     install (~/.config/opencode/node_modules, symlinked). The provider
//     package @ai-sdk/openai-compatible itself is bundled in the opencode
//     binary — verified: a boot with dead proxies (below) succeeds without
//     either seed being refetched.
//   - HTTPS_PROXY/HTTP_PROXY point at a dead address for the spawned server
//     (NO_PROXY keeps 127.0.0.1 open for the mock), so any unexpected
//     external fetch fails the suite loudly instead of silently using the
//     network. No real model calls are possible: the only configured model
//     is the mock.
//   If the seed caches are absent (fresh machine), the suite skips like it
//   does in CI or without a built dist/.
//
// Requires: dist/ built (`pnpm run build`), the `opencode` binary on PATH.
// Boot can take up to ~2 min on a cold cache; per-test timeouts are generous.

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { createOpencode, type OpencodeClient } from "@opencode-ai/sdk";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const PROJECT_ROOT = path.resolve(__dirname, "..");
const PLUGIN_PATH = path.join(PROJECT_ROOT, "dist", "index.js");
const DIST_EXISTS = fs.existsSync(PLUGIN_PATH);
const OPENCODE_BIN = Bun.which("opencode");

const REAL_HOME = os.homedir();
const SEED_MODELS = path.join(REAL_HOME, ".cache", "opencode", "models.json");
const SEED_CONFIG_DIR = path.join(REAL_HOME, ".config", "opencode");
const SEED_PLUGIN_PKG = path.join(
  SEED_CONFIG_DIR,
  "node_modules",
  "@opencode-ai",
  "plugin",
  "package.json"
);
const SEEDS_AVAILABLE = fs.existsSync(SEED_MODELS) && fs.existsSync(SEED_PLUGIN_PKG);

const SKIP_E2E =
  !DIST_EXISTS || !OPENCODE_BIN || !SEEDS_AVAILABLE || process.env.CI === "true";

const BOOT_TIMEOUT_MS = 120_000;
const TEST_TIMEOUT_MS = 90_000;

const ORCH_TOOL_IDS = [
  "orch_run",
  "orch_workflows",
  "orch_runs",
  "orch_status",
  "orch_result",
  "orch_cancel",
  "orch_control",
  "orch_goal",
  "orch_log",
] as const;

const MOCK_PROVIDER = "mockllm";
const MOCK_MODEL_ID = "mock-1";
const MOCK_MODEL = { providerID: MOCK_PROVIDER, modelID: MOCK_MODEL_ID };

// ── Mock LLM ────────────────────────────────────────────────────────────
// Every scenario installs a script: what the lead's first request should do
// (a tool call), and how to answer step prompts (matched by marker).
interface MockScript {
  leadTool?: { name: string; args: Record<string, unknown> };
  /** When the orch_run tool result comes back, call orch_cancel with the run id. */
  cancelOnRunStart?: boolean;
  steps: Array<{ marker: string; reply: string }>;
  goalVerdicts?: Array<{ verdict: "met" | "not_met" | "impossible"; reason: string }>;
  goalReplies?: string[];
}

interface MockCall {
  /** Last user message text. */
  text: string;
  /** Concatenated tool-result message contents ("" when this request has none). */
  toolText: string;
  roles: string[];
  toolCount: number;
  /** What the mock answered: "text" or a tool name. */
  answered: string;
}

const mockCalls: MockCall[] = [];
let mockScript: MockScript | null = null;
let cancelIssued = false;
let mockCallCounter = 0;
let goalVerdictCounter = 0;
let goalReplyCounter = 0;

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => (typeof p === "object" && p !== null ? String((p as { text?: unknown }).text ?? "") : ""))
      .join("");
  }
  return "";
}

interface ChatMessage {
  role: string;
  content?: unknown;
  tool_calls?: unknown;
}

function lastUserText(messages: ChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") return contentText(messages[i].content);
  }
  return "";
}

function toolResultText(messages: ChatMessage[]): string {
  return messages
    .filter((m) => m.role === "tool")
    .map((m) => contentText(m.content))
    .join("\n");
}

function sseChunk(delta: object, finish: string | null = null): object {
  return {
    id: "chatcmpl-mock",
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: MOCK_MODEL_ID,
    choices: [{ index: 0, delta, finish_reason: finish }],
  };
}

const USAGE_CHUNK = {
  id: "chatcmpl-mock",
  object: "chat.completion.chunk",
  created: Math.floor(Date.now() / 1000),
  model: MOCK_MODEL_ID,
  choices: [],
  usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
};

function sseResponse(chunks: object[]): Response {
  const body =
    chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n";
  return new Response(body, {
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
  });
}

function textChunks(text: string): object[] {
  return [sseChunk({ role: "assistant", content: text }), sseChunk({}, "stop")];
}

function toolCallChunks(name: string, args: Record<string, unknown>): object[] {
  return [
    sseChunk({
      role: "assistant",
      tool_calls: [
        {
          index: 0,
          id: `call_${++mockCallCounter}`,
          type: "function",
          function: { name, arguments: JSON.stringify(args) },
        },
      ],
    }),
    sseChunk({}, "tool_calls"),
  ];
}

// The mock's whole brain: decide the next completion from the request.
function planCompletion(
  messages: ChatMessage[]
): { chunks: object[]; answered: string } {
  const toolText = toolResultText(messages);
  const text = lastUserText(messages);

  if (mockScript?.goalVerdicts && text.includes("Evaluate whether the goal is met")) {
    const verdict =
      mockScript.goalVerdicts[
        Math.min(goalVerdictCounter++, mockScript.goalVerdicts.length - 1)
      ];
    return { chunks: textChunks(JSON.stringify(verdict)), answered: "goal-verdict" };
  }
  if (
    mockScript?.goalReplies &&
    (text.includes("Work autonomously toward this active Orch goal") ||
      text.includes("Continue working autonomously toward the active goal"))
  ) {
    const reply =
      mockScript.goalReplies[Math.min(goalReplyCounter++, mockScript.goalReplies.length - 1)];
    return { chunks: textChunks(reply), answered: "goal-worker" };
  }

  // Follow-up after a tool executed.
  if (toolText.length > 0) {
    if (mockScript?.cancelOnRunStart && !cancelIssued) {
      const m = /Run (run_[A-Za-z0-9_]+) started/.exec(toolText);
      if (m) {
        cancelIssued = true;
        return { chunks: toolCallChunks("orch_cancel", { run: m[1] }), answered: "orch_cancel" };
      }
    }
    return { chunks: textChunks("LEAD-FINAL"), answered: "text" };
  }

  // Step session: step prompts carry the scenario's E2E-* markers.
  if (mockScript?.leadTool) {
    for (const route of mockScript.steps) {
      if (text.includes(route.marker)) {
        return { chunks: textChunks(route.reply), answered: "text" };
      }
    }
  }

  // Otherwise this is the lead's first request.
  if (mockScript) {
    return {
      chunks: toolCallChunks(mockScript.leadTool.name, mockScript.leadTool.args),
      answered: mockScript.leadTool.name,
    };
  }
  return { chunks: textChunks("MOCK-IDLE"), answered: "text" };
}

function startMockLlm() {
  return Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (req.method === "POST" && url.pathname.endsWith("/chat/completions")) {
        const body = (await req.json()) as {
          messages?: ChatMessage[];
          tools?: unknown[];
          stream?: boolean;
        };
        const messages = body.messages ?? [];
        const plan = planCompletion(messages);
        mockCalls.push({
          text: lastUserText(messages),
          toolText: toolResultText(messages),
          roles: messages.map((m) => m.role),
          toolCount: (body.tools ?? []).length,
          answered: plan.answered,
        });
        const chunks = [...plan.chunks, USAGE_CHUNK];
        if (body.stream !== false) return sseResponse(chunks);
        // Non-streaming fallback (opencode always streams, but stay polite).
        return Response.json({
          id: "chatcmpl-mock",
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model: MOCK_MODEL_ID,
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "MOCK-NONSTREAM" },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        });
      }
      return new Response("not found", { status: 404 });
    },
  });
}

// ── Store reading (the plugin's runs.jsonl is the source of truth) ──────
interface StepView {
  id: string;
  status: string;
  output?: string;
  error?: string;
  sessionID?: string;
  copiedFiles?: string[];
  conflicts?: string[];
  isolationFallback?: boolean;
}

interface RunView {
  id: string;
  workflow: string;
  status: string;
  output?: string;
  error?: string;
  iteration: number;
  steps: Map<string, StepView>;
}

function replayRuns(project: string): RunView[] {
  const fp = path.join(project, ".opencode", "plugin-orch", "runs.jsonl");
  if (!fs.existsSync(fp)) return [];
  const runs = new Map<string, RunView>();
  for (const line of fs.readFileSync(fp, "utf-8").split("\n")) {
    if (!line) continue;
    let evt: { type: string; data: Record<string, unknown> };
    try {
      evt = JSON.parse(line);
    } catch {
      continue;
    }
    const d = evt.data;
    switch (evt.type) {
      case "run_created": {
        const r = d as unknown as { id: string; workflow: string };
        runs.set(r.id, {
          id: r.id,
          workflow: r.workflow,
          status: "running",
          iteration: 0,
          steps: new Map(),
        });
        break;
      }
      case "step_started":
      case "step_completed":
      case "step_failed": {
        const run = runs.get(d.runID as string);
        if (!run) break;
        run.steps.set((d.step as StepView).id, d.step as StepView);
        if (typeof d.iteration === "number") run.iteration = d.iteration;
        break;
      }
      case "run_completed": {
        const run = runs.get(d.runID as string);
        if (run) {
          run.status = "completed";
          run.output = d.output as string;
        }
        break;
      }
      case "run_failed": {
        const run = runs.get(d.runID as string);
        if (run) {
          run.status = "failed";
          run.error = d.error as string;
        }
        break;
      }
      case "run_cancelled": {
        const run = runs.get(d.runID as string);
        if (run) run.status = "cancelled";
        break;
      }
    }
  }
  return [...runs.values()];
}

async function waitFor(cond: () => boolean, what: string, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`);
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}

function terminalRun(project: string): RunView | undefined {
  return replayRuns(project).find((r) => r.status !== "running");
}

async function waitForTerminalRun(project: string, timeoutMs = 60_000): Promise<RunView> {
  await waitFor(() => terminalRun(project) !== undefined, "run to reach a terminal state", timeoutMs);
  return terminalRun(project)!;
}

// ── Scaffolding ─────────────────────────────────────────────────────────
const tmpDirs: string[] = [];

function makeProject(name: string, workflows: Record<string, unknown> = {}): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `orch-e2e-${name}-`));
  tmpDirs.push(dir);
  const entries = Object.entries(workflows);
  if (entries.length > 0) {
    const wfDir = path.join(dir, ".opencode", "workflows");
    fs.mkdirSync(wfDir, { recursive: true });
    for (const [file, def] of entries) {
      fs.writeFileSync(path.join(wfDir, file), JSON.stringify(def));
    }
  }
  return dir;
}

/** Install a script on the mock, reset its log, and prompt a fresh lead session. */
async function driveLead(
  client: OpencodeClient,
  project: string,
  script: MockScript,
  prompt: string
): Promise<void> {
  mockScript = script;
  mockCalls.length = 0;
  cancelIssued = false;
  goalVerdictCounter = 0;
  goalReplyCounter = 0;

  const sess = await client.session.create({
    query: { directory: project },
    body: { title: "e2e-lead" },
  });
  const id = (sess.data as { id: string }).id;
  await client.session.promptAsync({
    path: { id },
    query: { directory: project },
    body: {
      parts: [{ type: "text", text: prompt }],
      model: MOCK_MODEL,
    },
  });
}

function latestGoal(project: string, sessionID: string): Record<string, unknown> | undefined {
  const fp = path.join(project, ".opencode", "plugin-orch", "runs.jsonl");
  if (!fs.existsSync(fp)) return undefined;
  let latest: Record<string, unknown> | undefined;
  for (const line of fs.readFileSync(fp, "utf-8").split("\n")) {
    if (!line) continue;
    try {
      const event = JSON.parse(line) as {
        type: string;
        data?: { goal?: Record<string, unknown> };
      };
      const goal = event.data?.goal;
      if (event.type.startsWith("goal_") && goal?.sessionID === sessionID) latest = goal;
    } catch {
      // Ignore a partial tail line exactly like Store replay.
    }
  }
  return latest;
}

async function driveGoal(client: OpencodeClient, project: string): Promise<string> {
  mockScript = {
    steps: [],
    goalReplies: ["FIRST-EVIDENCE", "FINAL-EVIDENCE"],
    goalVerdicts: [
      { verdict: "not_met", reason: "need final evidence" },
      { verdict: "met", reason: "final evidence observed" },
    ],
  };
  mockCalls.length = 0;
  goalVerdictCounter = 0;
  goalReplyCounter = 0;
  const created = await client.session.create({
    query: { directory: project },
    body: { title: "e2e-goal-lead" },
  });
  const sessionID = (created.data as { id: string }).id;
  await client.session.command({
    path: { id: sessionID },
    query: { directory: project },
    body: {
      command: "goal",
      arguments: "produce final evidence",
      agent: "build",
      model: `${MOCK_PROVIDER}/${MOCK_MODEL_ID}`,
    },
  } as never);
  return sessionID;
}

// ── Tier 1 + 2 ──────────────────────────────────────────────────────────
describe.skipIf(SKIP_E2E)("e2e: real opencode server (tier 1: boot, tier 2: mock LLM)", () => {
  let server: { url: string; close(): void } | undefined;
  let client: OpencodeClient;
  let mock: ReturnType<typeof startMockLlm>;
  let fakeHome = "";

  // Saved env, restored in afterAll so later test files see a pristine env.
  const savedEnv: Record<string, string | undefined> = {};
  const ENV_KEYS = [
    "HOME",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "XDG_CACHE_HOME",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "NO_PROXY",
  ];

  beforeAll(async () => {
    for (const k of ENV_KEYS) savedEnv[k] = process.env[k];

    // Hermetic HOME: no global config, no real providers, no MCP servers.
    fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "orch-e2e-home-"));
    tmpDirs.push(fakeHome);

    // Seed the models.dev cache and the @opencode-ai/plugin runtime install
    // so the boot needs no network (see file header).
    fs.mkdirSync(path.join(fakeHome, ".cache", "opencode"), { recursive: true });
    fs.copyFileSync(SEED_MODELS, path.join(fakeHome, ".cache", "opencode", "models.json"));
    const fakeCfgDir = path.join(fakeHome, ".config", "opencode");
    fs.mkdirSync(fakeCfgDir, { recursive: true });
    const pluginPkg = JSON.parse(fs.readFileSync(SEED_PLUGIN_PKG, "utf-8")) as {
      version: string;
    };
    fs.writeFileSync(
      path.join(fakeCfgDir, "package.json"),
      JSON.stringify({ dependencies: { "@opencode-ai/plugin": pluginPkg.version } })
    );
    fs.symlinkSync(path.join(SEED_CONFIG_DIR, "node_modules"), path.join(fakeCfgDir, "node_modules"));

    process.env.HOME = fakeHome;
    delete process.env.XDG_CONFIG_HOME;
    delete process.env.XDG_DATA_HOME;
    delete process.env.XDG_CACHE_HOME;
    // Fail loudly on any external fetch; loopback (the mock) stays open.
    process.env.HTTP_PROXY = "http://127.0.0.1:1";
    process.env.HTTPS_PROXY = "http://127.0.0.1:1";
    process.env.NO_PROXY = "127.0.0.1,localhost";

    mock = startMockLlm();

    const result = await createOpencode({
      hostname: "127.0.0.1",
      port: 0,
      timeout: 60_000,
      config: {
        autoupdate: false,
        plugin: [PLUGIN_PATH],
        model: `${MOCK_PROVIDER}/${MOCK_MODEL_ID}`,
        provider: {
          [MOCK_PROVIDER]: {
            npm: "@ai-sdk/openai-compatible",
            name: "Mock LLM",
            options: { baseURL: `http://127.0.0.1:${mock.port}/v1`, apiKey: "dummy" },
            models: { [MOCK_MODEL_ID]: { name: "Mock 1" } },
          },
        },
      } as never,
    });
    client = result.client;
    server = result.server;
  }, BOOT_TIMEOUT_MS);

  afterAll(async () => {
    server?.close();
    await mock?.stop(true);
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
    for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
  });

  // ── Tier 1 ────────────────────────────────────────────────────────────
  const tier1Project = () => {
    // Lazily created once; the tool.ids request triggers plugin init in it.
    if (!tier1Dir) tier1Dir = makeProject("boot");
    return tier1Dir;
  };
  let tier1Dir = "";

  test("t1: server exposes a reachable URL", () => {
    expect(server).toBeDefined();
    expect(server!.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });

  test(
    "t1: exactly the 9 orch_* tools are registered alongside built-ins",
    async () => {
      const res = await client.tool.ids({ query: { directory: tier1Project() } });
      const ids = (res.data ?? []) as string[];
      const orchIds = ids.filter((t) => t.startsWith("orch_")).sort();
      expect(orchIds).toEqual([...ORCH_TOOL_IDS].sort());
      expect(ids).toContain("bash");
      expect(ids).toContain("read");
    },
    TEST_TIMEOUT_MS
  );

  test(
    "t1: plugin init succeeded (init.log reports ready, no errors)",
    async () => {
      const initLog = path.join(tier1Project(), ".opencode", "plugin-orch", "init.log");
      await waitFor(() => fs.existsSync(initLog), "plugin init.log", 15_000);
      const content = fs.readFileSync(initLog, "utf-8");
      expect(content).toContain("ready · 9 tools");
      expect(content).not.toContain("ERROR");
    },
    TEST_TIMEOUT_MS
  );

  test(
    "t1: SSE event endpoint is subscribable",
    async () => {
      const controller = new AbortController();
      const res = await fetch(`${server!.url}/event`, { signal: controller.signal });
      expect(res.ok).toBe(true);
      expect(res.headers.get("content-type") ?? "").toContain("text/event-stream");
      controller.abort();
      try {
        await res.body?.cancel();
      } catch {
        // aborted
      }
    },
    TEST_TIMEOUT_MS
  );

  // ── Tier 2 ────────────────────────────────────────────────────────────
  test(
    "t2: /goal independently evaluates, auto-continues, and resolves",
    async () => {
      const project = makeProject("goal");
      const sessionID = await driveGoal(client, project);
      await waitFor(
        () => latestGoal(project, sessionID)?.status === "achieved",
        "goal to resolve as achieved",
        45_000
      );
      const goal = latestGoal(project, sessionID)!;
      expect(goal.status).toBe("achieved");
      expect(goal.turns).toBe(2);
      expect(goal.lastVerdict).toBe("met");
      expect(mockCalls.filter((call) => call.answered === "goal-worker")).toHaveLength(2);
      expect(mockCalls.filter((call) => call.answered === "goal-verdict")).toHaveLength(2);
      const secondWorker = mockCalls.find((call) =>
        call.text.includes("need final evidence")
      );
      expect(secondWorker).toBeDefined();
    },
    TEST_TIMEOUT_MS
  );

  test(
    "t2: custom workflow JSON is loaded and listed through the real stack",
    async () => {
      const project = makeProject("wflist", {
        "e2e-chain.json": {
          name: "e2e-chain",
          description: "e2e custom chain",
          pattern: "chain",
          steps: [{ id: "only", instructions: "E2E-STEP-WFLIST. Say {{input}}" }],
        },
      });
      // The lead calls orch_workflows; the tool result comes back to the mock
      // in the follow-up request — that is how the list becomes observable.
      await driveLead(
        client,
        project,
        { leadTool: { name: "orch_workflows", args: { action: "list" } }, steps: [] },
        "List the available workflows."
      );
      await waitFor(
        () => mockCalls.some((c) => c.toolText.includes("e2e-chain")),
        "orch_workflows tool result to reach the mock",
        30_000
      );
      const toolText = mockCalls.find((c) => c.toolText.includes("e2e-chain"))!.toolText;
      expect(toolText).toContain("e2e-chain (custom) [chain]");
      expect(toolText).toContain("chain-draft-refine"); // built-ins still there
    },
    TEST_TIMEOUT_MS
  );

  test(
    "t2: chain run with LLM steps completes; output chains between steps",
    async () => {
      const project = makeProject("chain", {
        "e2e-chain.json": {
          name: "e2e-chain",
          description: "e2e custom chain",
          pattern: "chain",
          steps: [
            { id: "one", instructions: "E2E-STEP-CHAIN-ONE. Input: {{input}}" },
            { id: "two", instructions: "E2E-STEP-CHAIN-TWO. Previous output: {{output}}" },
          ],
        },
      });
      await driveLead(
        client,
        project,
        {
          leadTool: {
            name: "orch_run",
            args: { workflow: "e2e-chain", input: "E2E-CHAIN-INPUT" },
          },
          steps: [
            { marker: "E2E-STEP-CHAIN-ONE", reply: "ALPHA-OUTPUT" },
            { marker: "E2E-STEP-CHAIN-TWO", reply: "OMEGA-FINAL" },
          ],
        },
        "Start the e2e-chain workflow."
      );

      const run = await waitForTerminalRun(project);
      expect(run.status).toBe("completed");
      expect(run.output).toBe("OMEGA-FINAL");
      expect(run.steps.get("one")?.status).toBe("completed");
      expect(run.steps.get("one")?.output).toBe("ALPHA-OUTPUT");
      expect(run.steps.get("two")?.status).toBe("completed");
      expect(run.steps.get("two")?.output).toBe("OMEGA-FINAL");

      // Step prompts actually flowed through the mock: step 2's prompt must
      // contain step 1's output (template chaining through the real stack).
      const stepTwoReq = mockCalls.find((c) => c.text.includes("E2E-STEP-CHAIN-TWO"));
      expect(stepTwoReq).toBeDefined();
      expect(stepTwoReq!.text).toContain("ALPHA-OUTPUT");
      // And the input reached step 1.
      expect(mockCalls.find((c) => c.text.includes("E2E-STEP-CHAIN-ONE"))!.text).toContain(
        "E2E-CHAIN-INPUT"
      );
    },
    TEST_TIMEOUT_MS
  );

  test(
    "t2: evaluator gate loop iterates until the gate passes",
    async () => {
      const project = makeProject("gate", {
        "e2e-gate.json": {
          name: "e2e-gate",
          description: "e2e gate loop",
          pattern: "evaluator",
          maxIterations: 5,
          // Pure shell: fails on the first iteration, passes on the second.
          // The echo becomes the feedback text for the next generator prompt.
          gate: {
            command:
              "n=$(cat .gate-count 2>/dev/null || echo 0); echo $((n+1)) > .gate-count; " +
              'echo "GATE-CHECK-n=$n"; test "$n" -ge 1',
          },
          steps: [
            {
              id: "gen",
              instructions: "E2E-STEP-GATE-GEN. Input: {{input}}. Feedback so far: {{feedback}}",
            },
          ],
        },
      });
      await driveLead(
        client,
        project,
        {
          leadTool: { name: "orch_run", args: { workflow: "e2e-gate", input: "E2E-GATE-INPUT" } },
          steps: [{ marker: "E2E-STEP-GATE-GEN", reply: "DRAFT-BODY" }],
        },
        "Start the e2e-gate workflow."
      );

      const run = await waitForTerminalRun(project);
      expect(run.status).toBe("completed");
      expect(run.output).toBe("DRAFT-BODY");
      // Two generator iterations: `gen` then `gen#2`.
      expect(run.iteration).toBe(2);
      expect(run.steps.get("gen")?.status).toBe("completed");
      expect(run.steps.get("gen#2")?.status).toBe("completed");

      // The gate's failure output reached the generator's second prompt.
      const genReqs = mockCalls.filter((c) => c.text.includes("E2E-STEP-GATE-GEN"));
      expect(genReqs.length).toBe(2);
      expect(genReqs[0].text).not.toContain("GATE-CHECK");
      expect(genReqs[1].text).toContain("GATE-CHECK-n=0");
    },
    TEST_TIMEOUT_MS
  );

  test(
    "t2: worktree-isolated parallel run copies files back and cleans up",
    async () => {
      const project = makeProject("wt", {
        "e2e-wt.json": {
          name: "e2e-wt",
          description: "e2e worktree fan-out",
          pattern: "parallel",
          isolation: "worktree",
          steps: [
            { id: "w1", command: "echo W1-CONTENT > wt-one.txt" },
            { id: "w2", command: "echo W2-CONTENT > wt-two.txt" },
          ],
          // Runs in the project dir after copy-back, so it sees both files.
          aggregate: { id: "agg", command: "cat wt-one.txt wt-two.txt" },
        },
      });
      // Worktree isolation needs a git repo with at least one commit.
      const git = (args: string[]) =>
        Bun.spawnSync(["git", ...args], { cwd: project, stdout: "pipe", stderr: "pipe" });
      expect(git(["init", "-q"]).exitCode).toBe(0);
      expect(
        git(["-c", "user.email=e2e@example.com", "-c", "user.name=e2e", "commit", "-q", "--allow-empty", "-m", "init"]).exitCode
      ).toBe(0);

      await driveLead(
        client,
        project,
        {
          leadTool: { name: "orch_run", args: { workflow: "e2e-wt", input: "E2E-WT-INPUT" } },
          steps: [], // command steps only — the mock never sees a step prompt
        },
        "Start the e2e-wt workflow."
      );

      const run = await waitForTerminalRun(project);
      expect(run.status).toBe("completed");
      // Aggregate ran in the project dir over the copied-back files.
      expect(run.output).toContain("W1-CONTENT");
      expect(run.output).toContain("W2-CONTENT");

      // Files landed in the real repo.
      expect(fs.readFileSync(path.join(project, "wt-one.txt"), "utf-8").trim()).toBe("W1-CONTENT");
      expect(fs.readFileSync(path.join(project, "wt-two.txt"), "utf-8").trim()).toBe("W2-CONTENT");

      // Step records show real worktree isolation + copy-back.
      const w1 = run.steps.get("w1");
      const w2 = run.steps.get("w2");
      expect(w1?.status).toBe("completed");
      expect(w2?.status).toBe("completed");
      expect(w1?.isolationFallback).toBeUndefined();
      expect(w2?.isolationFallback).toBeUndefined();
      expect(w1?.copiedFiles ?? []).toContain("wt-one.txt");
      expect(w2?.copiedFiles ?? []).toContain("wt-two.txt");

      // Worktrees removed and the per-project .orch-worktrees dir pruned.
      const projectWtDir = path.join(
        path.dirname(project),
        ".orch-worktrees",
        path.basename(project)
      );
      expect(fs.existsSync(projectWtDir)).toBe(false);
      expect(Bun.spawnSync(["git", "worktree", "list", "--porcelain"], { cwd: project }).stdout.toString()).not.toContain(".orch-worktrees");
    },
    TEST_TIMEOUT_MS
  );

  test(
    "t2: orch_cancel through the real stack cancels a running run",
    async () => {
      const project = makeProject("cancel", {
        "e2e-hang.json": {
          name: "e2e-hang",
          description: "e2e hanging step",
          pattern: "chain",
          // The command step is killed with its process group on cancel, so
          // nothing of the sleep survives — and the run must flip to
          // cancelled at once (the assertion budget is far below the sleep
          // length).
          steps: [{ id: "hang", command: "sleep 30" }],
        },
      });
      const started = Date.now();
      await driveLead(
        client,
        project,
        {
          leadTool: { name: "orch_run", args: { workflow: "e2e-hang", input: "E2E-HANG-INPUT" } },
          cancelOnRunStart: true,
          steps: [],
        },
        "Start the e2e-hang workflow, then cancel it."
      );

      const run = await waitForTerminalRun(project);
      expect(run.status).toBe("cancelled");
      // The mock actually issued orch_cancel (parsed the run id out of the
      // orch_run tool result), and the cancel did not wait out the sleep.
      expect(mockCalls.some((c) => c.answered === "orch_cancel")).toBe(true);
      expect(Date.now() - started).toBeLessThan(25_000);
    },
    TEST_TIMEOUT_MS
  );

  // Skipped on purpose — scenario (e) from the design: permission auto-allow
  // for step sessions through the real stack. It would need the mock to make
  // a STEP session issue bash/edit tool calls and then observe the
  // permission.ask hook decision, which requires scripting multi-turn tool
  // use inside step sessions. The hook itself is unit-tested in
  // permissions.test.ts; wiring it through a scripted LLM here is too
  // fiddly to keep stable.
});

// Tier 3 (live provider, LLM-as-judge, ORCH_LIVE=1) lives in
// tests/e2e-live.test.ts — it costs real tokens and never runs as part of
// the default suite.
