import type { PluginInput } from "@opencode-ai/plugin";
import type { Team, Member, TeamConfig } from "../state/schemas.js";
import { transitionMember, isActive } from "./member.js";
import type { Store } from "../state/store.js";

let idCounter = 0;
export function genID(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${(++idCounter).toString(36)}`;
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
    const team: Team = {
      id: genID("team"),
      name,
      leadSessionID,
      config: {
        workStealing: config.workStealing ?? true,
        backpressureLimit: config.backpressureLimit ?? 50,
        budgetLimit: config.budgetLimit,
        escalation: config.escalation,
      },
      createdAt: Date.now(),
    };
    this.store.createTeam(team);
    return team;
  }

  getTeam(name: string): Team | undefined {
    return this.store.getTeamByName(name);
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
      createdAt: Date.now(),
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

    // Send initial instructions (non-blocking)
    const body: Record<string, unknown> = {
      parts: [{ type: "text", text: contextPrompt }],
    };
    if (opts.agent) body.agent = opts.agent;
    if (opts.model) body.model = opts.model;

    await this.ctx.client.session.promptAsync({
      path: { id: sessionID },
      body: body as { parts: Array<{ type: "text"; text: string }>; agent?: string; model?: { providerID: string; modelID: string } },
    });

    return member;
  }

  transitionMember(memberID: string, to: Member["state"]): Member {
    const member = this.store.getMember(memberID);
    if (!member) throw new Error(`Member ${memberID} not found`);
    const updated = transitionMember(member, to);
    this.store.updateMember(updated);
    return updated;
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
