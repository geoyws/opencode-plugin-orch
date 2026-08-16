// LIVE e2e suite — real provider, real tokens, LLM-as-judge.
//
// EVERYTHING in this file is gated behind ORCH_LIVE=1 and costs real money
// (a few cents per full run). It boots a real opencode server with the real
// HOME, so the global config's default model drives both the workflow steps
// and the judge. Override with ORCH_LIVE_MODEL="providerID/modelID".
// Manual pre-release runs only, mirroring ADR-001's live-testing practice:
//     pnpm run test:e2e:live        (= ORCH_LIVE=1 bun test tests/e2e-live.test.ts)
//
// Five scenarios. The first four have an OBJECTIVE assertion (store / git /
// exit codes)
// AND a JUDGE verdict (an LLM grades output quality against a rubric; the
// judge's rationale is printed and embedded in the failure message):
//
//   1. chain-draft-refine  — tagline quality (concise, on-topic, non-generic)
//   2. adversarial-review  — finds a planted off-by-one; critique names the
//      defect category; final output actually fixed
//   3. test-fix-loop       — real repo with a failing test; gate `npm test`
//      goes green; tests untouched; fix is genuine (judged on the diff)
//   4. author-tests        — real repo, worktree-isolated workers; generated
//      tests exist and pass; coverage is meaningful (judged)
//   5. goal compaction     — real provider worker/evaluator/summarizer; forces
//      automatic compaction and proves the persisted continuation runs
//
// The judge is itself an LLM and can be wrong — rubrics are written to be
// explicit and demanding. If a verdict fails on a genuinely good artifact,
// tune the rubric, not the artifact.

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import type { OpencodeClient } from "@opencode-ai/sdk";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  DIST_EXISTS,
  bootLiveServer,
  liveModel,
  runLeadPrompt,
  judge,
  waitFor,
  waitForRunCreated,
  waitForTerminalRun,
  type Verdict,
} from "./_live-harness.js";
import { isPassVerdict } from "../src/core/runner.js";

const LIVE = process.env.ORCH_LIVE === "1";
const SKIP = !LIVE || !DIST_EXISTS;

const BOOT_TIMEOUT_MS = 180_000;

const tmpDirs: string[] = [];

function makeProject(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `orch-e2e-live-${name}-`));
  tmpDirs.push(dir);
  return dir;
}

function git(project: string, args: string[]): string {
  const r = Bun.spawnSync(["git", ...args], {
    cwd: project,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (r.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${r.stderr.toString()}`);
  }
  return r.stdout.toString();
}

function initRepo(project: string): void {
  git(project, ["init", "-q"]);
  git(project, [
    "-c",
    "user.email=e2e@example.com",
    "-c",
    "user.name=e2e",
    "add",
    "-A",
  ]);
  git(project, [
    "-c",
    "user.email=e2e@example.com",
    "-c",
    "user.name=e2e",
    "commit",
    "-q",
    "-m",
    "init",
  ]);
}

function writeFile(project: string, rel: string, content: string): void {
  const fp = path.join(project, rel);
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(fp, content);
}

// Assert a judge verdict, always logging the rationale (it is the useful
// part when a live test fails) and embedding it in the failure message.
function expectVerdict(verdict: Verdict): void {
  console.log(`\n[judge] ${verdict.pass ? "PASS" : "FAIL"}\n${verdict.raw}\n`);
  expect(verdict.pass, verdict.rationale).toBe(true);
}

type GoalView = {
  sessionID: string;
  status: string;
  turns: number;
  workerSessionID?: string;
  workerStatus?: string;
  observedTokens?: number;
  lastCompactedTokens?: number;
  pendingContinuation?: string;
  lastVerdict?: string;
  lastReason?: string;
};

function readGoal(project: string, sessionID: string): GoalView | undefined {
  const fp = path.join(project, ".opencode", "plugin-orch", "view.json");
  if (!fs.existsSync(fp)) return undefined;
  try {
    const view = JSON.parse(fs.readFileSync(fp, "utf-8")) as {
      goals?: Record<string, GoalView>;
    };
    return view.goals?.[sessionID];
  } catch {
    // view.json is atomically replaced, but tolerate a concurrent filesystem
    // observer and let waitFor retry.
    return undefined;
  }
}

// ── Planted-bug fixtures ────────────────────────────────────────────────

// Scenario 2: off-by-one — returns one past the lower bound.
const LOWER_BOUND_BUGGY = `// Returns the index of the first element >= target, or arr.length
// when every element is smaller.
function lowerBound(arr, target) {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (arr[mid] < target) lo = mid + 1;
    else hi = mid;
  }
  return lo + 1; // BUG: off-by-one — should return lo
}`;

const LOWER_BOUND_BUG_DESC =
  "The function lowerBound(arr, target) should return the index of the first " +
  "element >= target (or arr.length if none). The planted defect is an " +
  "off-by-one: it returns lo + 1 instead of lo, so every result is one too " +
  "high.";

// Scenario 3: even-length median returns the lower middle value instead of
// the average of the two middle values.
const STATS_BUGGY = `// Median of a numeric array.
function median(numbers) {
  if (numbers.length === 0) throw new Error("median of empty array");
  const sorted = [...numbers].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : sorted[mid - 1];
}

module.exports = { median };
`;

const STATS_TEST = `const test = require("node:test");
const assert = require("node:assert/strict");
const { median } = require("../src/stats.js");

test("odd-length arrays return the middle value", () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([5]), 5);
});

test("even-length arrays average the two middle values", () => {
  assert.equal(median([1, 2, 3, 4]), 2.5);
  assert.equal(median([10, 20]), 15);
});

test("empty array throws", () => {
  assert.throws(() => median([]));
});
`;

const STATS_BUG_DESC =
  "median() must average the two middle values for even-length arrays " +
  "(median([1,2,3,4]) === 2.5). The planted bug returns the lower middle " +
  "value (sorted[mid - 1]) instead.";

// Scenario 4: two small, correct CommonJS modules to be tested.
const CART_SRC = `// Shopping cart totals with a bulk discount.
function lineTotal(item) {
  return item.price * item.quantity;
}

// 10% discount on orders of 100 or more.
function cartTotal(items) {
  const subtotal = items.reduce((sum, item) => sum + lineTotal(item), 0);
  return subtotal >= 100 ? subtotal * 0.9 : subtotal;
}

module.exports = { lineTotal, cartTotal };
`;

const TEXT_SRC = `// Small text helpers.
function slugify(text) {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function wordCount(text) {
  const words = text.trim().split(/\\s+/).filter(Boolean);
  return words.length;
}

module.exports = { slugify, wordCount };
`;

// ── Suite ───────────────────────────────────────────────────────────────
describe.skipIf(SKIP)("e2e live: LLM-as-judge (ORCH_LIVE=1, costs real tokens)", () => {
  let server: { url: string; close(): void } | undefined;
  let client: OpencodeClient;

  beforeAll(async () => {
    const probe = makeProject("probe");
    const model = liveModel();
    const booted = await bootLiveServer(probe, BOOT_TIMEOUT_MS, {
      goalSoftTokens: 1,
      goalMaxTokens: 250_000,
      ...(model
        ? { goalEvaluatorModel: model, goalSummarizerModel: model }
        : {}),
    });
    client = booted.client;
    server = booted.server;
  }, BOOT_TIMEOUT_MS + 60_000);

  afterAll(() => {
    server?.close();
    for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
  });

  test(
    "live 1: chain-draft-refine produces a good tagline",
    async () => {
      const project = makeProject("chain");
      await runLeadPrompt(
        client,
        project,
        'Call the orch_run tool ONCE with workflow "chain-draft-refine" and input ' +
          '"Write a one-sentence tagline for a workflow engine that runs AI coding ' +
          "agents. Make it concrete: evoke orchestrating agents through proven " +
          'workflow patterns, not generic productivity slogans. Use 12 words or fewer." ' +
          "After the tool returns, confirm the run id in one short sentence and stop. " +
          "Do not call any other tool."
      );

      await waitForRunCreated(project);
      const run = await waitForTerminalRun(project, 4 * 60_000);
      expect(run.status, run.error ?? "").toBe("completed");
      const output = (run.output ?? "").trim();
      expect(output.length).toBeGreaterThan(0);

      // Objective: at most two sentences (tagline, not an essay).
      const cleaned = output.replace(/^["']+|["']+$/g, "").trim();
      const sentences = cleaned
        .split(/(?<=[.!?…])(?:\s+|$)/)
        .filter((s) => s.trim().length > 0);
      expect(sentences.length, `output: ${output}`).toBeLessThanOrEqual(2);
      expect(sentences.length).toBeGreaterThanOrEqual(1);
      expect(cleaned.split(/\s+/).filter(Boolean).length, `output: ${output}`).toBeLessThanOrEqual(12);

      // Judge: is it actually a good tagline?
      const verdict = await judge(
        client,
        project,
        [
          "The artifact is a single sentence (not a paragraph, list, or explanation).",
          "It contains 12 words or fewer.",
          "It reads as a tagline — a concise, memorable product line, not a description of what a tagline would say.",
          "It references workflows and/or AI coding agents (the product's actual subject).",
          "It is anchored to the product (workflows / AI coding agents) rather than pure interchangeable filler — a common tagline-style turn of phrase is acceptable when the line as a whole is clearly about this product.",
        ],
        output
      );
      expectVerdict(verdict);
    },
    6 * 60_000
  );

  test(
    "live 2: adversarial-review finds the planted off-by-one",
    async () => {
      const project = makeProject("adversarial");
      const input =
        "The JavaScript function below has a subtle defect. Produce a corrected " +
        "implementation (code only, plus one line naming the defect you fixed).\n\n" +
        LOWER_BOUND_BUGGY;
      await runLeadPrompt(
        client,
        project,
        'Call the orch_run tool ONCE with workflow "adversarial-review" and this ' +
          "exact input text:\n\n" +
          input +
          "\n\nAfter the tool returns, confirm the run id in one short sentence " +
          "and stop. Do not call any other tool."
      );

      await waitForRunCreated(project);
      const run = await waitForTerminalRun(project, 8 * 60_000);
      expect(run.status, run.error ?? "").toBe("completed");

      // Objective: the corrected CODE drops the buggy line and contains the
      // obvious fix. Check only the fenced code block — the one-line defect
      // explanation legitimately names the buggy pattern in prose
      // ("`return lo + 1` → `return lo`").
      const raw = run.output ?? "";
      const fenced = /```(?:\w*)\n([\s\S]*?)```/.exec(raw);
      const code = (fenced ? fenced[1] : raw).replace(/\s+/g, "");
      expect(code).not.toContain("returnlo+1");
      expect(code).toContain("returnlo");

      // Judge the critic's critiques when at least one non-PASS critique
      // exists; if the generator fixed the bug in its first draft and the
      // critic passed immediately, judge the final fix instead.
      const critiques = [...run.steps.values()]
        .filter((s) => s.id.startsWith("critic") && s.output && !isPassVerdict(s.output))
        .map((s) => `## Critique (step ${s.id})\n${s.output}`)
        .join("\n\n");
      let verdict: Verdict;
      if (critiques.length > 0) {
        verdict = await judge(
          client,
          project,
          [
            "The critique identifies the actual defect category: an off-by-one / boundary error in the returned index.",
            "The critique points at the correct location (the final `return lo + 1` line) rather than inventing unrelated problems.",
            "The critique explains why the defect matters (every result is one too high) or how to fix it (return lo).",
          ],
          `## Actual defect\n${LOWER_BOUND_BUG_DESC}\n\n${critiques}`
        );
      } else {
        verdict = await judge(
          client,
          project,
          [
            "The corrected implementation returns lo (not lo + 1) from lowerBound.",
            "The correction is otherwise equivalent to the original binary search — a minimal fix, not a rewrite with different behavior.",
            "The response names the defect (off-by-one) or makes it identifiable.",
          ],
          `## Actual defect\n${LOWER_BOUND_BUG_DESC}\n\n## Buggy original\n${LOWER_BOUND_BUGGY}\n\n## Final generator output\n${run.output ?? ""}`
        );
      }
      expectVerdict(verdict);
    },
    10 * 60_000
  );

  test(
    "live 3: test-fix-loop fixes the source, not the tests",
    async () => {
      const project = makeProject("tfl");
      writeFile(
        project,
        "package.json",
        JSON.stringify({
          name: "e2e-tfl",
          private: true,
          scripts: { test: "node --test tests/" },
        })
      );
      writeFile(project, "src/stats.js", STATS_BUGGY);
      writeFile(project, "tests/stats.test.js", STATS_TEST);
      initRepo(project);

      const input =
        "The test suite in this repository is failing. Run `npm test` to see the " +
        "failures, then fix the SOURCE code so all tests pass. IMPORTANT: do not " +
        "create, modify, or delete any files under tests/ — the existing tests are " +
        "the specification and are correct. Only change source files. Verify with " +
        "`npm test` before you finish.";
      await runLeadPrompt(
        client,
        project,
        'Call the orch_run tool ONCE with workflow "test-fix-loop" and this exact ' +
          "input text:\n\n" +
          input +
          "\n\nAfter the tool returns, confirm the run id in one short sentence " +
          "and stop. Do not call any other tool."
      );

      await waitForRunCreated(project);
      const run = await waitForTerminalRun(project, 10 * 60_000);
      expect(run.status, run.error ?? "").toBe("completed");

      // Objective (strong): the gate really is green in the repo now.
      const npmTest = Bun.spawnSync(["npm", "test"], {
        cwd: project,
        stdout: "pipe",
        stderr: "pipe",
        timeout: 120_000,
      });
      expect(
        npmTest.exitCode,
        `npm test failed:\n${npmTest.stdout.toString()}\n${npmTest.stderr.toString()}`
      ).toBe(0);

      // Tests untouched (tracked changes AND new files under tests/).
      const porcelain = git(project, ["status", "--porcelain"]);
      const touched = porcelain.split("\n").filter(Boolean);
      expect(
        touched.some((l) => l.includes("tests/")),
        `tests/ was touched:\n${porcelain}`
      ).toBe(false);

      // The source fix is small.
      const numstat = git(project, ["diff", "--numstat"]);
      const changedLines = numstat
        .split("\n")
        .filter(Boolean)
        .reduce((sum, l) => {
          const [a, d] = l.split("\t");
          return sum + (parseInt(a, 10) || 0) + (parseInt(d, 10) || 0);
        }, 0);
      expect(changedLines, `git diff --numstat:\n${numstat}`).toBeLessThan(20);

      // Judge: is the fix genuine rather than a hack?
      const diff = git(project, ["diff"]);
      const verdict = await judge(
        client,
        project,
        [
          "The fix addresses the actual root cause (even-length median must average the two middle values).",
          "No test file was modified, added, or deleted.",
          "No assertions were deleted or weakened, and no tests were skipped.",
          "The fix does not hardcode expected values or special-case the exact inputs used by the tests — it is a general correction.",
        ],
        `## Bug description\n${STATS_BUG_DESC}\n\n## git status --porcelain\n${porcelain}\n\n## git diff\n${diff}`
      );
      expectVerdict(verdict);
    },
    12 * 60_000
  );

  test(
    "live 4: author-tests writes meaningful, passing tests",
    async () => {
      const project = makeProject("author");
      writeFile(project, "src/cart.js", CART_SRC);
      writeFile(project, "src/text.js", TEXT_SRC);
      initRepo(project);

      const input =
        "Author unit tests with node:test and node:assert/strict for the two " +
        "source modules src/cart.js and src/text.js. Write one test file per " +
        "module: tests/cart.test.js and tests/text.test.js. The repo is plain " +
        "CommonJS — use require(), not import. Cover normal behavior AND edge " +
        "cases (empty inputs, the 100-unit discount boundary in cartTotal). " +
        "Do not modify any files under src/.";
      await runLeadPrompt(
        client,
        project,
        'Call the orch_run tool ONCE with workflow "author-tests" and this exact ' +
          "input text:\n\n" +
          input +
          "\n\nAfter the tool returns, confirm the run id in one short sentence " +
          "and stop. Do not call any other tool."
      );

      await waitForRunCreated(project);
      const run = await waitForTerminalRun(project, 10 * 60_000);
      expect(run.status, run.error ?? "").toBe("completed");

      // Objective: test files were copied back and they pass.
      const testsDir = path.join(project, "tests");
      const testFiles = fs.existsSync(testsDir)
        ? fs.readdirSync(testsDir).filter((f) => f.endsWith(".js"))
        : [];
      expect(
        testFiles.length,
        `no test files copied back; run output:\n${run.output ?? ""}`
      ).toBeGreaterThan(0);

      // Explicit file list — `node --test tests/` mis-resolves the directory
      // as an entry module on Node 22.22.
      const nodeTest = Bun.spawnSync(
        ["node", "--test", ...testFiles.map((f) => path.join("tests", f))],
        {
          cwd: project,
          stdout: "pipe",
          stderr: "pipe",
          timeout: 120_000,
        }
      );
      expect(
        nodeTest.exitCode,
        `node --test failed:\n${nodeTest.stdout.toString()}\n${nodeTest.stderr.toString()}`
      ).toBe(0);

      // Judge: are the tests meaningful? (sources + the first generated file)
      const firstTest = testFiles.sort()[0];
      const artifact =
        "## src/cart.js\n" +
        CART_SRC +
        "\n## src/text.js\n" +
        TEXT_SRC +
        `\n## tests/${firstTest}\n` +
        fs.readFileSync(path.join(testsDir, firstTest), "utf-8");
      const verdict = await judge(
        client,
        project,
        [
          "The tests cover more than one behavior of the module under test (not a single happy-path case).",
          "At least one edge case is exercised (empty input, boundary value, or similar).",
          "The assertions match the actual semantics of the source — expected values are correct, not reversed or copied from a buggy reading.",
          "No tautological assertions (e.g. assert(true), asserting a value equals itself) and no tests that would pass for any implementation.",
        ],
        artifact
      );
      expectVerdict(verdict);
    },
    12 * 60_000
  );

  test(
    "live 5: goal continues after automatic compaction",
    async () => {
      const project = makeProject("goal-compaction");
      const model = liveModel();
      const condition =
        "Follow this two-turn evidence protocol exactly. On the first goal-worker " +
        "turn, output PHASE_ONE_RECORDED and explicitly say PHASE_TWO_PENDING; do " +
        "not output ORCH_LIVE_GOAL_DONE. The goal is not met at that point. Only " +
        "after the independent evaluator asks you to continue, output " +
        "ORCH_LIVE_GOAL_DONE and state that phase one preceded phase two. The goal " +
        "is met only when that later completion marker is present.";

      const goalArgs = {
        action: "set",
        condition,
        maxTurns: 5,
        maxTokens: 250_000,
        softTokens: 1,
        noProgressLimit: 3,
        ...(model
          ? {
              evaluatorProvider: model.providerID,
              evaluatorModel: model.modelID,
            }
          : {}),
      };
      const sessionID = await runLeadPrompt(
        client,
        project,
        "Call the orch_goal tool exactly once with these exact JSON arguments: " +
          JSON.stringify(goalArgs) +
          ". After the tool returns, report only that the dedicated goal worker " +
          "was launched, then stop. Do not perform the goal work in this lead session."
      );

      await waitFor(
        () => {
          const goal = readGoal(project, sessionID);
          return goal?.status === "achieved" ||
            ["impossible", "paused", "budget_exhausted"].includes(goal?.status ?? "");
        },
        "live goal to settle after automatic compaction",
        8 * 60_000
      );

      const goal = readGoal(project, sessionID)!;
      console.log(
        `\n[goal-compaction] status=${goal.status} turns=${goal.turns} ` +
          `tokens=${goal.observedTokens ?? "unknown"} ` +
          `compactedAt=${goal.lastCompactedTokens ?? "none"}\n`
      );
      expect(goal.status, goal.lastReason ?? "goal did not achieve").toBe("achieved");
      expect(goal.turns).toBeGreaterThanOrEqual(2);
      expect(goal.lastVerdict).toBe("met");
      expect(goal.lastCompactedTokens).toBeGreaterThan(0);
      expect(goal.pendingContinuation).toBeUndefined();
      expect(goal.workerSessionID).toBeDefined();
    },
    10 * 60_000
  );
});
