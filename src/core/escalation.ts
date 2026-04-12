import type { PluginInput } from "@opencode-ai/plugin";
import type { Store } from "../state/store.js";
import type { TeamManager } from "./team-manager.js";
import type { Member, EscalationConfig, ModelRef } from "../state/schemas.js";

export class EscalationManager {
  constructor(
    private store: Store,
    private manager: TeamManager,
    private ctx: PluginInput
  ) {}

  async handleError(memberID: string): Promise<{ retried: boolean; escalated: boolean }> {
    const member = this.store.getMember(memberID);
    if (!member) return { retried: false, escalated: false };

    const team = this.store.getTeam(member.teamID);
    if (!team?.config.escalation?.enabled) return { retried: false, escalated: false };

    const config = team.config.escalation;
    const chain = config.chain;

    // Try retry at current level first
    if (member.retryCount < config.maxRetries) {
      const updated: Member = { ...member, retryCount: member.retryCount + 1, state: "ready" };
      this.store.updateMember(updated);

      // Re-send the original instructions
      await this.respawnMember(updated);
      return { retried: true, escalated: false };
    }

    // Escalate to next model in chain
    if (member.escalationLevel < chain.length - 1) {
      const nextLevel = member.escalationLevel + 1;
      const nextModel = chain[nextLevel];

      const updated: Member = {
        ...member,
        escalationLevel: nextLevel,
        retryCount: 0,
        model: nextModel,
        state: "ready",
      };
      this.store.updateMember(updated);

      // Spawn new session with escalated model
      await this.respawnMember(updated);
      return { retried: false, escalated: true };
    }

    // Chain exhausted — mark as failed permanently
    return { retried: false, escalated: false };
  }

  private async respawnMember(member: Member): Promise<void> {
    try {
      // Create new session for the escalated attempt
      const team = this.store.getTeam(member.teamID)!;
      const session = await this.ctx.client.session.create({
        body: {
          parentID: team.leadSessionID,
          title: `[orch] ${team.name} | ${member.role} (retry)`,
        },
      });
      const sessionID = (session.data as { id: string }).id;

      const updated: Member = { ...member, sessionID };
      this.store.updateMember(updated);

      // Re-send instructions
      const body: {
        parts: Array<{ type: "text"; text: string }>;
        agent?: string;
        model?: { providerID: string; modelID: string };
      } = {
        parts: [{ type: "text", text: member.instructions }],
      };
      if (member.agent) body.agent = member.agent;
      if (member.model) body.model = member.model;

      await this.ctx.client.session.promptAsync({
        path: { id: sessionID },
        body,
      });
    } catch {
      // Failed to respawn — leave in error state
      this.store.updateMember({ ...member, state: "error" });
    }
  }

  getModelLabel(model: ModelRef | undefined): string {
    if (!model) return "default";
    return `${model.providerID}/${model.modelID}`;
  }
}
