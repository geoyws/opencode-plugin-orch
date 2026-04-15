import type { PluginInput } from "@opencode-ai/plugin";
import type { Team, Member, TeamConfig } from "../state/schemas.js";
import { transitionMember, isActive } from "./member.js";
import type { Store } from "../state/store.js";

let idCounter = 0;
export function genID(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${(++idCounter).toString(36)}`;
}

// Default tool allowlist for spawned members. This is the hand-maintained
// map of explicit true/false decisions. Do NOT consume this directly when
// spawning — use `computeMemberToolsAllowed()` so newly-added orch_* tools
// that were forgotten here still default to deny.
//
// orch_create / orch_spawn are denied to prevent recursive team creation;
// orch_inbox / orch_team / orch_shutdown are lead-only; webfetch is opt-in.
export const MEMBER_TOOL_DEFAULTS: Record<string, boolean> = {
  read: true,
  write: true,
  edit: true,
  glob: true,
  grep: true,
  bash: true,
  webfetch: false,
  orch_message: true,
  orch_broadcast: true,
  orch_tasks: true,
  orch_memo: true,
  orch_status: true,
  orch_result: true,
  orch_inbox: false,
  orch_team: false,
  orch_create: false,
  orch_spawn: false,
  orch_shutdown: false,
};

/**
 * Compute the final tools allowlist for a new member.
 *
 * IMPORTANT — opencode's `body.tools` semantics (see ADR-004): the record
 * passed to `session.promptAsync` is an OVERRIDE MAP, not a closed
 * allowlist. opencode translates each entry into a session-level
 * permission rule (`{ permission, action: allow|deny, pattern: "*" }`),
 * appends those to the agent's ruleset, and uses `findLast` to resolve
 * the effective rule per tool. Tools NOT listed in `body.tools` fall
 * through to the root default `"*": "allow"` in opencode's `defaults3`
 * — i.e. **unlisted = ALLOW**. Naively passing MEMBER_TOOL_DEFAULTS alone
 * would leave any future `orch_*` tool that a contributor forgets to
 * register here silently accessible to members.
 *
 * To close that hole we need to explicitly deny any orch_* tool that
 * exists at runtime but is not in MEMBER_TOOL_DEFAULTS. The caller
 * (spawnMember) queries the live tool registry via `ctx.client.tool.ids()`
 * and passes the result as `knownToolIds`.
 *
 * Order of operations:
 *   1. Start with MEMBER_TOOL_DEFAULTS.
 *   2. For each id in `knownToolIds` that starts with `orch_` and is NOT
 *      already in MEMBER_TOOL_DEFAULTS, set it to `false` (implicit deny
 *      becomes explicit deny).
 *   3. Merge any user-provided `additional` tool names as `true` — this
 *      is the escape hatch, so a caller who knows what they're doing can
 *      still opt a specific member into an otherwise-denied tool.
 */
export function computeMemberToolsAllowed(
  additional?: string[],
  knownToolIds?: string[]
): Record<string, boolean> {
  const result: Record<string, boolean> = { ...MEMBER_TOOL_DEFAULTS };
  if (knownToolIds) {
    for (const id of knownToolIds) {
      if (id.startsWith("orch_") && !(id in MEMBER_TOOL_DEFAULTS)) {
        result[id] = false;
      }
    }
  }
  if (additional) {
    for (const name of additional) {
      const trimmed = name.trim();
      if (trimmed) result[trimmed] = true;
    }
  }
  return result;
}

export class TeamManager {
  constructor(
    private store: Store,
    private ctx: PluginInput
  ) {}

  // ── Team lifecycle ────────────────────────────────────────────────
  createTeam(name: string, leadSessionID: string, config: Partial<TeamConfig> = {}): Team {
    if (this.store.getTeamByName(name)) {
      throw new Error(`Team "${name}" already exists`);
    }
    const now = Date.now();
    const team: Team = {
      id: genID("team"),
      name,
      leadSessionID,
      config: {
        workStealing: config.workStealing ?? true,
        backpressureLimit: config.backpressureLimit ?? 50,
        budgetLimit: config.budgetLimit,
        escalation: config.escalation,
        rateLimit: config.rateLimit,
        idleTimeoutMs: config.idleTimeoutMs,
      },
      createdAt: now,
      // Start the lead's inbox cursor at creation time — any peer message
      // that arrives after this counts as unread.
      leadInboxLastSeenAt: now,
    };
    this.store.createTeam(team);
    return team;
  }

  getTeam(name: string): Team | undefined {
    return this.store.getTeamByName(name);
  }

  getTeamById(teamID: string): Team | undefined {
    return this.store.getTeam(teamID);
  }

  requireTeam(name: string): Team {
    const team = this.store.getTeamByName(name);
    if (!team) throw new Error(`Team "${name}" not found`);
    return team;
  }

  // ── Member lifecycle ──────────────────────────────────────────────
  async spawnMember(opts: {
    teamID: string;
    role: string;
    instructions: string;
    agent?: string;
    model?: { providerID: string; modelID: string };
    files?: string[];
    toolsAllowed?: string[];
  }): Promise<Member> {
    const team = this.store.getTeam(opts.teamID);
    if (!team) throw new Error(`Team ${opts.teamID} not found`);

    // Check for duplicate role
    if (this.store.getMemberByRole(opts.teamID, opts.role)) {
      throw new Error(`Role "${opts.role}" already exists in team "${team.name}"`);
    }

    // Create session
    const session = await this.ctx.client.session.create({
      body: {
        parentID: team.leadSessionID,
        title: `[orch] ${team.name} | ${opts.role}`,
      },
    });
    const sessionID = (session.data as { id: string }).id;

    // Best-effort fetch of the live tool registry so computeMemberToolsAllowed
    // can explicitly deny any orch_* tool a contributor forgot to register in
    // MEMBER_TOOL_DEFAULTS. See ADR-004 for why this matters: opencode's
    // body.tools is an override map, not a closed allowlist, so unlisted
    // tools fall through to the root `"*": "allow"` default. Endpoint is
    // experimental (`/experimental/tool/ids`) — swallow failures and fall
    // back to an empty list rather than blocking spawn.
    // 500ms budget: /experimental/tool/ids is a tiny local HTTP call. If it
    // takes longer than half a second something is wrong (endpoint hung,
    // opencode crashed, network stack broken) and blocking every spawn on
    // it would make a dead endpoint look like a frozen plugin. On timeout
    // or error, fall back to an empty list — MEMBER_TOOL_DEFAULTS still
    // covers every orch_* tool we know about at write time, so the only
    // thing we lose in the fallback path is closed-allowlist semantics
    // for *future* orch_* tools the caller forgot to register here.
    let knownToolIds: string[] = [];
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("tool.ids timeout")), 500);
      });
      const toolIdsRes = await Promise.race([
        this.ctx.client.tool.ids(),
        timeout,
      ]);
      const data = (toolIdsRes as { data?: unknown }).data;
      if (Array.isArray(data)) knownToolIds = data as string[];
    } catch {
      // Network error, timeout, or unexpected shape — fall back to empty.
    } finally {
      if (timer) clearTimeout(timer);
    }

    const toolsAllowed = computeMemberToolsAllowed(opts.toolsAllowed, knownToolIds);

    const now = Date.now();
    const member: Member = {
      id: genID("member"),
      teamID: opts.teamID,
      sessionID,
      role: opts.role,
      agent: opts.agent,
      model: opts.model,
      state: "initializing",
      instructions: opts.instructions,
      files: opts.files ?? [],
      escalationLevel: 0,
      retryCount: 0,
      createdAt: now,
      toolsAllowed,
      lastActivityAt: now,
    };
    this.store.createMember(member);

    // Seed file context if files specified
    if (opts.files && opts.files.length > 0) {
      const fileParts: Array<{ type: "text"; text: string }> = [];
      for (const filePath of opts.files) {
        try {
          const result = await this.ctx.client.file.read({ query: { path: filePath } });
          const content = (result.data as { content?: string })?.content ?? "";
          fileParts.push({ type: "text", text: `[File: ${filePath}]\n${content}` });
        } catch {
          fileParts.push({ type: "text", text: `[File: ${filePath}] (could not read)` });
        }
      }
      if (fileParts.length > 0) {
        await this.ctx.client.session.prompt({
          path: { id: sessionID },
          body: {
            noReply: true,
            parts: fileParts,
          },
        });
      }
    }

    // Build context prompt with team tools instruction
    const teamTools = [
      "orch_message — send a message to a specific team member",
      "orch_broadcast — broadcast a message to all team members",
      "orch_tasks — manage the task board (list/add/claim/complete/fail)",
      "orch_memo — shared scratchpad (set/get/list/delete)",
    ].join("\n  ");

    const contextPrompt = [
      `You are a team member with role "${opts.role}" in team "${team.name}".`,
      "",
      "## Your Instructions",
      opts.instructions,
      "",
      "## Team Coordination Tools",
      `You have access to these tools for team coordination:`,
      `  ${teamTools}`,
      "",
      "## Important Rules",
      "- You CANNOT run git-mutating commands (commit, push, merge, rebase, etc.)",
      "- You CAN use git read commands (status, log, diff, show, blame)",
      "- Use orch_memo to share findings with teammates and avoid duplicate work",
      "- Use orch_tasks to claim and complete tasks from the board",
      "- Use orch_message to coordinate with specific teammates",
      "- When you complete your assigned work, use orch_tasks to mark it complete with results",
    ].join("\n");

    // Send initial instructions (non-blocking). Pass the tool allowlist as
    // `body.tools` so the child session only sees the tools we want.
    const body: Record<string, unknown> = {
      parts: [{ type: "text", text: contextPrompt }],
      tools: toolsAllowed,
    };
    if (opts.agent) body.agent = opts.agent;
    if (opts.model) body.model = opts.model;

    await this.ctx.client.session.promptAsync({
      path: { id: sessionID },
      body: body as {
        parts: Array<{ type: "text"; text: string }>;
        agent?: string;
        model?: { providerID: string; modelID: string };
        tools?: Record<string, boolean>;
      },
    });

    return member;
  }

  transitionMember(memberID: string, to: Member["state"]): Member {
    const member = this.store.getMember(memberID);
    if (!member) throw new Error(`Member ${memberID} not found`);
    let updated = transitionMember(member, to);
    // Stamp activity on entry to ready/busy so the idle monitor has a
    // fresh baseline. Terminal states (shutdown/error) don't need it.
    if (to === "ready" || to === "busy") {
      updated = { ...updated, lastActivityAt: Date.now() };
    }
    this.store.updateMember(updated);
    return updated;
  }

  /** Bump the member's lastActivityAt without changing state. */
  touchMember(memberID: string): void {
    const member = this.store.getMember(memberID);
    if (!member) return;
    this.store.updateMember({ ...member, lastActivityAt: Date.now() });
  }

  async shutdownMember(memberID: string): Promise<void> {
    const member = this.store.getMember(memberID);
    if (!member) return;

    if (isActive(member)) {
      // Try to transition to shutdown_requested first, then abort
      try {
        this.transitionMember(memberID, "shutdown_requested");
      } catch {
        // Already in a terminal state
      }
      try {
        await this.ctx.client.session.abort({ path: { id: member.sessionID } });
      } catch {
        // Session may already be gone
      }
    }

    // Release file locks
    this.store.releaseMemberLocks(memberID);

    // Force to shutdown state
    const current = this.store.getMember(memberID)!;
    if (current.state !== "shutdown") {
      this.store.updateMember({ ...current, state: "shutdown" });
    }
  }

  async shutdownTeam(teamName: string): Promise<void> {
    const team = this.requireTeam(teamName);
    const members = this.store.listMembers(team.id);
    await Promise.all(members.map((m) => this.shutdownMember(m.id)));
  }

  getMember(id: string): Member | undefined {
    return this.store.getMember(id);
  }

  getMemberBySession(sessionID: string): Member | undefined {
    return this.store.getMemberBySessionID(sessionID);
  }

  getMemberByRole(teamID: string, role: string): Member | undefined {
    return this.store.getMemberByRole(teamID, role);
  }

  listMembers(teamID: string): Member[] {
    return this.store.listMembers(teamID);
  }

  // ── Session tracking ──────────────────────────────────────────────
  isMemberSession(sessionID: string): boolean {
    return this.store.getMemberBySessionID(sessionID) !== undefined;
  }

  isLeadSession(sessionID: string): boolean {
    for (const team of this.store.listTeams()) {
      if (team.leadSessionID === sessionID) return true;
    }
    return false;
  }
}
