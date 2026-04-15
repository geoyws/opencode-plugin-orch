import { z } from "zod";

// ── Member state machine ──────────────────────────────────────────────
export const MemberState = z.enum([
  "initializing",
  "ready",
  "busy",
  "shutdown_requested",
  "shutdown",
  "error",
]);
export type MemberState = z.infer<typeof MemberState>;

// ── Task status ───────────────────────────────────────────────────────
export const TaskStatus = z.enum([
  "available",
  "claimed",
  "completed",
  "failed",
]);
export type TaskStatus = z.infer<typeof TaskStatus>;

// ── Model reference ───────────────────────────────────────────────────
export const ModelRef = z.object({
  providerID: z.string(),
  modelID: z.string(),
});
export type ModelRef = z.infer<typeof ModelRef>;

// ── Escalation config ─────────────────────────────────────────────────
export const EscalationConfig = z.object({
  enabled: z.boolean(),
  chain: z.array(ModelRef),
  maxRetries: z.number().int().min(0),
});
export type EscalationConfig = z.infer<typeof EscalationConfig>;

// ── Rate limit config ─────────────────────────────────────────────────
export const RateLimitConfig = z.object({
  windowMs: z.number().int().min(1).default(60_000),
  maxCalls: z.number().int().min(1).default(60),
});
export type RateLimitConfig = z.infer<typeof RateLimitConfig>;

// ── Team config ───────────────────────────────────────────────────────
export const TeamConfig = z.object({
  workStealing: z.boolean().default(true),
  backpressureLimit: z.number().int().min(1).default(50),
  budgetLimit: z.number().optional(),
  escalation: EscalationConfig.optional(),
  rateLimit: RateLimitConfig.optional(),
});
export type TeamConfig = z.infer<typeof TeamConfig>;

// ── Team ──────────────────────────────────────────────────────────────
export const Team = z.object({
  id: z.string(),
  name: z.string(),
  leadSessionID: z.string(),
  config: TeamConfig,
  createdAt: z.number(),
  // Lead's orch_inbox read cursor. Peer messages with createdAt greater than
  // this are unread. Defaults to 0 so teams stored before this field existed
  // still load — loadSnapshot bypasses Zod, so the default applies only to
  // new Team() paths; tool code must still tolerate undefined.
  leadInboxLastSeenAt: z.number().default(0),
});
export type Team = z.infer<typeof Team>;

// ── Member ────────────────────────────────────────────────────────────
export const Member = z.object({
  id: z.string(),
  teamID: z.string(),
  sessionID: z.string(),
  role: z.string(),
  agent: z.string().optional(),
  model: ModelRef.optional(),
  state: MemberState,
  instructions: z.string(),
  files: z.array(z.string()).default([]),
  escalationLevel: z.number().int().default(0),
  retryCount: z.number().int().default(0),
  createdAt: z.number(),
  // Per-member tool allowlist passed to session.promptAsync as `body.tools`.
  // undefined = no restriction (backwards-compat for members stored before
  // this field existed). Populated by spawnMember via
  // computeMemberToolsAllowed() — MEMBER_TOOL_DEFAULTS merged with the
  // optional toolsAllowed arg.
  toolsAllowed: z.record(z.string(), z.boolean()).optional(),
});
export type Member = z.infer<typeof Member>;

// ── Task ──────────────────────────────────────────────────────────────
export const Task = z.object({
  id: z.string(),
  teamID: z.string(),
  title: z.string(),
  description: z.string(),
  status: TaskStatus,
  assignee: z.string().optional(),
  dependsOn: z.array(z.string()).default([]),
  result: z.string().optional(),
  tags: z.array(z.string()).default([]),
  version: z.number().int().default(0),
  createdAt: z.number(),
  completedAt: z.number().optional(),
});
export type Task = z.infer<typeof Task>;

// ── Message (inter-member) ────────────────────────────────────────────
export const TeamMessage = z.object({
  id: z.string(),
  teamID: z.string(),
  from: z.string(),
  to: z.string(),
  content: z.string(),
  delivered: z.boolean().default(false),
  createdAt: z.number(),
});
export type TeamMessage = z.infer<typeof TeamMessage>;

// ── Cost entry ────────────────────────────────────────────────────────
export const CostEntry = z.object({
  memberID: z.string(),
  teamID: z.string(),
  sessionID: z.string(),
  cost: z.number(),
  tokens: z.object({
    input: z.number(),
    output: z.number(),
    reasoning: z.number(),
    cache: z.object({ read: z.number(), write: z.number() }),
  }),
  timestamp: z.number(),
});
export type CostEntry = z.infer<typeof CostEntry>;

// ── File lock ─────────────────────────────────────────────────────────
export const FileLock = z.object({
  path: z.string(),
  memberID: z.string(),
  teamID: z.string(),
  acquiredAt: z.number(),
});
export type FileLock = z.infer<typeof FileLock>;

// ── Activity entry ────────────────────────────────────────────────────
export const Activity = z.object({
  memberID: z.string(),
  tool: z.string(),
  target: z.string(),
  timestamp: z.number(),
});
export type Activity = z.infer<typeof Activity>;

// ── JSONL event wrapper ───────────────────────────────────────────────
export const StoreEvent = z.object({
  type: z.string(),
  timestamp: z.number(),
  data: z.unknown(),
});
export type StoreEvent = z.infer<typeof StoreEvent>;

// ── Snapshot ──────────────────────────────────────────────────────────
export const Snapshot = z.object({
  timestamp: z.number(),
  teams: z.record(z.string(), Team),
  members: z.record(z.string(), Member),
  tasks: z.record(z.string(), Task),
  messages: z.array(TeamMessage),
  costs: z.array(CostEntry),
  locks: z.record(z.string(), FileLock),
  scratchpads: z.record(z.string(), z.record(z.string(), z.string())),
});
export type Snapshot = z.infer<typeof Snapshot>;
