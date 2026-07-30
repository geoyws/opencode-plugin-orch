import { z } from "zod";

// ── Model reference ───────────────────────────────────────────────────
export const ModelRef = z.object({
  providerID: z.string(),
  modelID: z.string(),
});
export type ModelRef = z.infer<typeof ModelRef>;

// ── Workflow pattern ──────────────────────────────────────────────────
export const Pattern = z.enum([
  "chain",
  "routing",
  "parallel",
  "orchestrator",
  "evaluator",
]);
export type Pattern = z.infer<typeof Pattern>;

// ── Run / step status ─────────────────────────────────────────────────
export const RunStatus = z.enum(["running", "completed", "failed", "cancelled"]);
export type RunStatus = z.infer<typeof RunStatus>;

export const StepStatus = z.enum(["running", "completed", "failed", "cancelled"]);
export type StepStatus = z.infer<typeof StepStatus>;

// ── Resolved per-run configuration ────────────────────────────────────
export const RunConfig = z.object({
  model: ModelRef.optional(),
  maxIterations: z.number().int().min(1).default(3),
  concurrency: z.number().int().min(1).default(4),
  stepTimeoutMs: z.number().int().min(1).default(600_000),
  // Run parallel/orchestrator fan-out steps in per-step git worktrees.
  isolation: z.enum(["worktree"]).optional(),
  // Evaluator gate: shell command run in the project dir after each
  // generator iteration; exit 0 = pass.
  gateCommand: z.string().min(1).optional(),
  // Per-step model override: stepModels[step.id] ?? step.model ?? model.
  stepModels: z.record(z.string(), ModelRef).optional(),
  // Cap on step-output text injected into subsequent prompts (full outputs
  // stay in the store). Gate feedback is separately capped at 4000 chars.
  maxStepOutputChars: z.number().int().min(1000).default(50_000),
  // Keep ephemeral step sessions after their step settles (debugging).
  // Default false: sessions are deleted on settle.
  keepSessions: z.boolean().default(false),
  // Max retries per LLM step for transient provider errors (session.error
  // matching the transient classifier). 0 disables retries.
  stepRetries: z.number().int().min(0).max(3).default(1),
});
export type RunConfig = z.infer<typeof RunConfig>;

// ── Step state (one record per step invocation) ───────────────────────
export const StepState = z.object({
  id: z.string(),
  status: StepStatus,
  sessionID: z.string().optional(),
  output: z.string().optional(),
  error: z.string().optional(),
  startedAt: z.number().optional(),
  completedAt: z.number().optional(),
  // Worktree isolation bookkeeping (parallel/orchestrator fan-out steps).
  copiedFiles: z.array(z.string()).optional(),
  conflicts: z.array(z.string()).optional(),
  // Symlinks found in the worktree at copy-back time — skipped, not copied
  // (they can dangle into the removed worktree or escape the repo).
  skippedSymlinks: z.array(z.string()).optional(),
  // Set when worktree creation failed and the step ran in the main directory.
  isolationFallback: z.boolean().optional(),
  // LLM step attempt counter (present only once a transient-error retry
  // re-started the step; rides the step_started event).
  attempts: z.number().int().min(1).optional(),
});
export type StepState = z.infer<typeof StepState>;

// ── Run ───────────────────────────────────────────────────────────────
export const Run = z.object({
  id: z.string(),
  workflow: z.string(),
  pattern: Pattern,
  input: z.string(),
  status: RunStatus,
  config: RunConfig,
  // Steps appear when they start (keyed by step id, insertion-ordered).
  // Evaluator iterations beyond the first use "<step-id>#<n>" ids.
  steps: z.record(z.string(), StepState).default({}),
  // Evaluator pattern: current loop iteration (1-based). 0 for other patterns.
  iteration: z.number().int().default(0),
  output: z.string().optional(),
  error: z.string().optional(),
  // Set when the run completed but with a caveat (evaluator budget exhausted).
  note: z.string().optional(),
  createdAt: z.number(),
  completedAt: z.number().optional(),
});
export type Run = z.infer<typeof Run>;

// ── JSONL event wrapper ───────────────────────────────────────────────
// Event types: run_created, step_started, step_completed, step_failed,
// run_completed, run_failed, run_cancelled.
export const StoreEvent = z.object({
  type: z.string(),
  timestamp: z.number(),
  data: z.unknown(),
});
export type StoreEvent = z.infer<typeof StoreEvent>;

// ── Snapshot ──────────────────────────────────────────────────────────
export const Snapshot = z.object({
  timestamp: z.number(),
  runs: z.record(z.string(), Run),
});
export type Snapshot = z.infer<typeof Snapshot>;
