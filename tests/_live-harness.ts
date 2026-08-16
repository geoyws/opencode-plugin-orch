// Shared harness for the LIVE e2e suite (tests/e2e-live.test.ts).
//
// Everything here talks to a real opencode server booted with the real HOME
// (global config provides the default model) and costs REAL TOKENS. It is
// only used behind ORCH_LIVE=1 — never import it from the hermetic suites.
//
// Provides:
//   - bootLiveServer()  — createOpencode with the plugin injected
//   - liveModel()       — ORCH_LIVE_MODEL override ("providerID/modelID")
//   - runLeadPrompt()   — drive a lead session into calling orch_run
//   - judge()           — LLM-as-judge with a rubric + verdict protocol
//   - store helpers     — replay <project>/.opencode/plugin-orch/runs.jsonl

import { createOpencode, type OpencodeClient } from "@opencode-ai/sdk";
import * as fs from "node:fs";
import * as path from "node:path";

export const PROJECT_ROOT = path.resolve(__dirname, "..");
export const PLUGIN_PATH = path.join(PROJECT_ROOT, "dist", "index.js");
export const DIST_EXISTS = fs.existsSync(PLUGIN_PATH);

// ── Model selection ─────────────────────────────────────────────────────
// Default: the server's configured default model (global config). Override
// with ORCH_LIVE_MODEL="providerID/modelID" (modelID may contain "/").
export function liveModel(): { providerID: string; modelID: string } | undefined {
  const raw = process.env.ORCH_LIVE_MODEL;
  if (!raw) return undefined;
  const slash = raw.indexOf("/");
  if (slash <= 0 || slash === raw.length - 1) {
    throw new Error(`ORCH_LIVE_MODEL must be "providerID/modelID", got "${raw}"`);
  }
  return { providerID: raw.slice(0, slash), modelID: raw.slice(slash + 1) };
}

// ── Server boot ─────────────────────────────────────────────────────────
export interface LiveServer {
  client: OpencodeClient;
  server: { url: string; close(): void };
}

export async function bootLiveServer(
  probeDir: string,
  timeoutMs = 180_000,
  pluginOptions?: Record<string, unknown>
): Promise<LiveServer> {
  const result = await createOpencode({
    hostname: "127.0.0.1",
    port: 0,
    timeout: 60_000,
    config: {
      plugin: pluginOptions ? [[PLUGIN_PATH, pluginOptions]] : [PLUGIN_PATH],
    } as never,
  });
  // Wait until the server actually answers — createOpencode resolves on the
  // listening line, but provider/plugin init happens on first requests.
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await result.client.tool.ids({
        query: { directory: probeDir },
      });
      if ((res.data ?? []).includes("orch_run")) return result;
    } catch {
      // not ready yet
    }
    if (Date.now() > deadline) {
      result.server.close();
      throw new Error("live server did not become ready (orch_run not registered)");
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
}

// ── Lead driver ─────────────────────────────────────────────────────────
// Prompts a fresh lead session (blocking until the lead's turn ends). The
// prompt must instruct the model to call orch_run and then stop; the run
// itself proceeds in the background and is tracked via the store helpers.
export async function runLeadPrompt(
  client: OpencodeClient,
  project: string,
  text: string
): Promise<string> {
  const sess = await client.session.create({
    query: { directory: project },
    body: { title: "e2e-live-lead" },
  });
  const id = (sess.data as { id: string }).id;
  const model = liveModel();
  await client.session.prompt({
    path: { id },
    query: { directory: project },
    body: {
      parts: [{ type: "text", text }],
      ...(model ? { model } : {}),
    },
  });
  return id;
}

// ── LLM-as-judge ────────────────────────────────────────────────────────
export interface Verdict {
  pass: boolean;
  rationale: string;
  /** Raw judge output (both attempts, if a nudge was needed). */
  raw: string;
}

function extractText(res: unknown): string {
  const data = (res as { data?: { parts?: Array<{ type: string; text?: string }> } })
    ?.data;
  return (data?.parts ?? [])
    .filter((p) => p.type === "text")
    .map((p) => p.text ?? "")
    .join("")
    .trim();
}

function parseVerdict(text: string): { pass: boolean; rationale: string } | undefined {
  const lines = text.split("\n").map((l) => l.trim());
  // Strict: verdict on the first non-empty line.
  const first = lines.find((l) => l.length > 0) ?? "";
  const strict = /^VERDICT:\s*(PASS|FAIL)\b/i.exec(first);
  const hit =
    strict ?? (() => {
      // Lenient: some line contains the verdict (models love preamble).
      for (const l of lines) {
        const m = /\bVERDICT:\s*(PASS|FAIL)\b/i.exec(l);
        if (m) return m;
      }
      return null;
    })();
  if (!hit) return undefined;
  return {
    pass: hit[1].toUpperCase() === "PASS",
    rationale: text,
  };
}

// Judge an artifact against a rubric (short checklist of demanding items).
// A fresh session per call; on unparseable output, one nudge in the same
// session ("reply with the verdict only"). The judge is told to check every
// rubric item explicitly so the rationale shows per-item reasoning.
export async function judge(
  client: OpencodeClient,
  directory: string,
  rubric: string[],
  artifact: string
): Promise<Verdict> {
  const checklist = rubric.map((item, i) => `${i + 1}. ${item}`).join("\n");
  const promptText = [
    "You are a strict, demanding reviewer. Evaluate the artifact below against",
    "EVERY item in the rubric. Do not give the benefit of the doubt.",
    "",
    "## Rubric",
    checklist,
    "",
    "## Artifact",
    artifact,
    "",
    "Check each rubric item explicitly, one line per item",
    '("1. PASS — <why>" or "1. FAIL — <why>", etc.). Then give the overall',
    "verdict: the FIRST line of your reply must be exactly `VERDICT: PASS`",
    "(only if EVERY rubric item passes) or `VERDICT: FAIL` (otherwise),",
    "followed by a one-paragraph rationale.",
  ].join("\n");

  const sess = await client.session.create({
    query: { directory },
    body: { title: "e2e-live-judge" },
  });
  const id = (sess.data as { id: string }).id;
  const model = liveModel();
  const prompt = async (text: string) =>
    extractText(
      await client.session.prompt({
        path: { id },
        query: { directory },
        body: {
          parts: [{ type: "text", text }],
          ...(model ? { model } : {}),
        },
      })
    );

  const first = await prompt(promptText);
  let verdict = parseVerdict(first);
  if (verdict) return { ...verdict, raw: first };

  const nudged = await prompt(
    "Your reply did not follow the required format. Reply with the verdict " +
      "only — exactly one line: `VERDICT: PASS` or `VERDICT: FAIL`."
  );
  verdict = parseVerdict(nudged);
  if (verdict) return { ...verdict, raw: `${first}\n\n--- after nudge ---\n\n${nudged}` };

  return {
    pass: false,
    rationale: `judge output unparseable (even after nudge): ${nudged.slice(0, 300)}`,
    raw: `${first}\n\n--- after nudge ---\n\n${nudged}`,
  };
}

// ── Store reading (the plugin's runs.jsonl is the source of truth) ──────
export interface StepView {
  id: string;
  status: string;
  output?: string;
  error?: string;
  sessionID?: string;
  copiedFiles?: string[];
  isolationFallback?: boolean;
}

export interface RunView {
  id: string;
  workflow: string;
  status: string;
  output?: string;
  error?: string;
  iteration: number;
  steps: Map<string, StepView>;
}

// The store is event-sourced with a 30s snapshot compaction: saveSnapshot()
// writes snapshot.json and then TRUNCATES runs.jsonl. Reading only the JSONL
// therefore loses every event older than the last snapshot — any run that
// lives longer than ~30s (i.e. every live run) becomes invisible. Mirror
// Store.init: seed from snapshot.json, then apply the (post-snapshot) JSONL
// events on top.
export function replayRuns(project: string): RunView[] {
  const dir = path.join(project, ".opencode", "plugin-orch");
  const runs = new Map<string, RunView>();

  const snapPath = path.join(dir, "snapshot.json");
  if (fs.existsSync(snapPath)) {
    try {
      const snap = JSON.parse(fs.readFileSync(snapPath, "utf-8")) as {
        runs?: Record<string, Record<string, unknown>>;
      };
      for (const r of Object.values(snap.runs ?? {})) {
        runs.set(r.id as string, {
          id: r.id as string,
          workflow: r.workflow as string,
          status: r.status as string,
          output: r.output as string | undefined,
          error: r.error as string | undefined,
          iteration: (r.iteration as number) ?? 0,
          steps: new Map(
            Object.values((r.steps as Record<string, StepView>) ?? {}).map((s) => [s.id, s])
          ),
        });
      }
    } catch {
      // Corrupt snapshot — the JSONL log is the source of truth; replay only.
    }
  }

  const fp = path.join(dir, "runs.jsonl");
  if (!fs.existsSync(fp)) return [...runs.values()];
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

export async function waitFor(
  cond: () => boolean,
  what: string,
  timeoutMs: number
): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`);
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
}

/** Wait until at least one run exists in the project's store, then return it. */
export async function waitForRunCreated(project: string, timeoutMs = 120_000): Promise<RunView> {
  await waitFor(() => replayRuns(project).length > 0, "lead to start a run", timeoutMs);
  return replayRuns(project)[0];
}

/** Wait until the run reaches a terminal state (completed/failed/cancelled). */
export async function waitForTerminalRun(project: string, timeoutMs: number): Promise<RunView> {
  await waitFor(
    () => replayRuns(project).some((r) => r.status !== "running"),
    "run to reach a terminal state",
    timeoutMs
  );
  return replayRuns(project).find((r) => r.status !== "running")!;
}
