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
export const RunStatus = z.enum([
  "running",
  "paused",
  "completed",
  "failed",
  "cancelled",
  "budget_exhausted",
]);
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
  // Provider-reported aggregate token budget. A run is stopped before the
  // next step once completed-step usage reaches the hard limit.
  maxTokens: z.number().int().positive().optional(),
  // Context compaction threshold. Completed outputs are reduced to their
  // deterministic checkpoints once aggregate usage crosses this value.
  softTokens: z.number().int().positive().optional(),
  maxCost: z.number().positive().optional(),
  maxAgents: z.number().int().positive().default(20),
  maxDurationMs: z.number().int().positive().optional(),
  permissionMode: z.enum(["ask", "auto"]).default("auto"),
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
  // Provider-reported usage. Missing means the provider/session did not
  // expose usage; it must never be interpreted as zero.
  usage: z
    .object({
      // Provider total when available. Category accounting remains the
      // portable fallback and guards against incomplete provider totals.
      total: z.number().nonnegative().optional(),
      input: z.number().nonnegative().default(0),
      output: z.number().nonnegative().default(0),
      reasoning: z.number().nonnegative().default(0),
      cacheRead: z.number().nonnegative().default(0),
      cacheWrite: z.number().nonnegative().default(0),
      cost: z.number().nonnegative().optional(),
    })
    .optional(),
  // Deterministic compact checkpoint retained alongside the raw output.
  summary: z.string().optional(),
});
export type StepState = z.infer<typeof StepState>;

export const SteeringNote = z.object({
  text: z.string().min(1).max(4000),
  createdAt: z.number(),
  // Sessions that received the note immediately. Future steps still receive
  // the durable run-level direction as part of their initial prompt.
  deliveredTo: z.array(z.string()).default([]),
});
export type SteeringNote = z.infer<typeof SteeringNote>;

// ── Run ───────────────────────────────────────────────────────────────
export const Run = z.object({
  id: z.string(),
  workflow: z.string(),
  pattern: Pattern,
  input: z.string(),
  status: RunStatus,
  config: RunConfig,
  // Immutable validated definition resolved at run creation. Recovery uses
  // this copy even if the saved workflow file changes later.
  plan: z.unknown().optional(),
  // Steps appear when they start (keyed by step id, insertion-ordered).
  // Evaluator iterations beyond the first use "<step-id>#<n>" ids.
  steps: z.record(z.string(), StepState).default({}),
  // Operator direction applied while the run is in flight. This is persisted
  // so later steps and restart recovery see the same steering context.
  steering: z.array(SteeringNote).default([]),
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

// ── Session-scoped goals ─────────────────────────────────────────────
export const GoalStatus = z.enum([
  "active",
  "achieved",
  "impossible",
  "cleared",
  "paused",
  "budget_exhausted",
]);
export type GoalStatus = z.infer<typeof GoalStatus>;

export const GoalState = z.object({
  sessionID: z.string(),
  condition: z.string().min(1).max(4000),
  status: GoalStatus,
  createdAt: z.number(),
  updatedAt: z.number(),
  completedAt: z.number().optional(),
  turns: z.number().int().nonnegative().default(0),
  observedTokens: z.number().int().nonnegative().optional(),
  observedCost: z.number().nonnegative().optional(),
  maxTurns: z.number().int().positive().default(20),
  maxDurationMs: z.number().int().positive().default(14_400_000),
  maxTokens: z.number().int().positive().default(250_000),
  softTokens: z.number().int().positive().default(180_000),
  maxCost: z.number().positive().optional(),
  noProgressLimit: z.number().int().positive().default(3),
  noProgressTurns: z.number().int().nonnegative().default(0),
  evaluatorModel: ModelRef.optional(),
  workerModel: ModelRef.optional(),
  workerAgent: z.string().optional(),
  workerSessionID: z.string().optional(),
  workerStatus: z
    .enum(["starting", "running", "evaluating", "idle", "stopped"])
    .optional(),
  steering: z.array(SteeringNote).default([]),
  lastVerdict: z.enum(["met", "not_met", "impossible"]).optional(),
  lastReason: z.string().optional(),
  checkpoint: z.string().optional(),
  lastCompactedTokens: z.number().int().nonnegative().optional(),
  // Provider message IDs already included in observedTokens/observedCost.
  // This keeps accounting monotonic when session summarization removes old
  // messages from the visible transcript.
  accountedMessageIDs: z.array(z.string()).default([]),
});
export type GoalState = z.infer<typeof GoalState>;

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
  goals: z.record(z.string(), GoalState).default({}),
});
export type Snapshot = z.infer<typeof Snapshot>;
