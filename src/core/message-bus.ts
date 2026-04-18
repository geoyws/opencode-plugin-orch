import type { PluginInput } from "@opencode-ai/plugin";
import type { Store } from "../state/store.js";
import type { TeamManager } from "./team-manager.js";
import { genID } from "./team-manager.js";

export class MessageBus {
  constructor(
    private store: Store,
    private manager: TeamManager,
    private ctx: PluginInput
  ) {}

  send(teamID: string, fromRole: string, toRole: string, content: string): string {
    const team = this.store.getTeamByName(teamID) ?? this.store.getTeam(teamID);
    if (!team) throw new Error(`Team not found: ${teamID}`);

    const fromMember = this.store.getMemberByRole(team.id, fromRole);
    const toMember = this.store.getMemberByRole(team.id, toRole);
    if (!toMember) throw new Error(`Member with role "${toRole}" not found in team`);

    // Backpressure check
    const pending = this.store.getUndeliveredMessages(toMember.id);
    if (pending.length >= team.config.backpressureLimit) {
      throw new Error(
        `Backpressure limit reached for "${toRole}" (${pending.length}/${team.config.backpressureLimit} pending messages)`
      );
    }

    const msg = {
      id: genID("msg"),
      teamID: team.id,
      from: fromMember?.id ?? "lead",
      to: toMember.id,
      content,
      delivered: false,
      createdAt: Date.now(),
    };
    this.store.addMessage(msg);

    // Peer DM visibility: surface member→member traffic to the lead via a
    // fire-and-forget toast. Lead-originated sends are skipped — the lead
    // already knows what they just sent.
    if (fromMember) {
      const preview = content.length > 60 ? content.slice(0, 57) + "..." : content;
      this.ctx.client.tui
        .showToast({
          body: {
            title: "[orch]",
            message: `${fromMember.role} → ${toMember.role}: ${preview}`,
            variant: "info",
            duration: 4000,
          },
        })
        .catch(() => {});
    }

    // If member is ready (idle), auto-wake
    if (toMember.state === "ready") {
      this.deliverMessages(toMember.id).catch(() => {});
    }

    return msg.id;
  }

  broadcast(
    teamID: string,
    fromRole: string,
    content: string,
    filter?: (role: string) => boolean
  ): string[] {
    const team = this.store.getTeamByName(teamID) ?? this.store.getTeam(teamID);
    if (!team) throw new Error(`Team not found: ${teamID}`);

    // Resolve sender once so the stored `from` field matches send()'s format
    // (member id, or the literal "lead" when the lead originates the broadcast).
    const fromMember = this.store.getMemberByRole(team.id, fromRole);
    const members = this.store.listMembers(team.id);
    const ids: string[] = [];

    for (const member of members) {
      if (member.role === fromRole) continue; // Don't send to self
      if (["shutdown", "shutdown_requested"].includes(member.state)) continue;
      if (filter && !filter(member.role)) continue;

      const pending = this.store.getUndeliveredMessages(member.id);
      if (pending.length >= team.config.backpressureLimit) continue; // Skip if at limit

      const msg = {
        id: genID("msg"),
        teamID: team.id,
        from: fromMember?.id ?? "lead",
        to: member.id,
        content,
        delivered: false,
        createdAt: Date.now(),
      };
      this.store.addMessage(msg);
      ids.push(msg.id);

      if (member.state === "ready") {
        this.deliverMessages(member.id).catch(() => {});
      }
    }

    // Peer broadcast visibility — one toast per broadcast call, not per
    // recipient. Lead-originated broadcasts are skipped (lead already knows).
    if (ids.length > 0 && fromMember) {
      const preview = content.length > 60 ? content.slice(0, 57) + "..." : content;
      this.ctx.client.tui
        .showToast({
          body: {
            title: "[orch]",
            message: `${fromRole} → all (${ids.length}): ${preview}`,
            variant: "info",
            duration: 4000,
          },
        })
        .catch(() => {});
    }

    return ids;
  }

  async deliverMessages(memberID: string): Promise<number> {
    const member = this.store.getMember(memberID);
    if (!member || member.state !== "ready") return 0;

    const pending = this.store.getUndeliveredMessages(memberID);
    if (pending.length === 0) return 0;

    // Batch all pending messages into one prompt
    const parts = pending.map((msg) => {
      const fromMember = this.store.getMember(msg.from);
      const senderName = fromMember?.role ?? "lead";
      return {
        type: "text" as const,
        text: `[Team message from ${senderName}]: ${msg.content}`,
      };
    });

    try {
      const body: {
        parts: Array<{ type: "text"; text: string }>;
        tools?: Record<string, boolean>;
      } = { parts };
      if (member.toolsAllowed) body.tools = member.toolsAllowed;

      await this.ctx.client.session.promptAsync({
        path: { id: member.sessionID },
        body,
        query: { directory: this.ctx.directory },
      });

      // Mark all as delivered
      for (const msg of pending) {
        this.store.markDelivered(msg.id);
      }

      return pending.length;
    } catch {
      return 0;
    }
  }
}
