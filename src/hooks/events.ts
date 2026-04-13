import type { Event } from "@opencode-ai/sdk";
import type { PluginInput } from "@opencode-ai/plugin";
import type { TeamManager } from "../core/team-manager.js";
import type { MessageBus } from "../core/message-bus.js";
import type { TaskBoard } from "../core/task-board.js";
import type { CostTracker } from "../core/cost-tracker.js";
import type { FileLockManager } from "../core/file-locks.js";
import type { EscalationManager } from "../core/escalation.js";
import type { Store } from "../state/store.js";
import type { Reporter } from "../core/reporter.js";

interface EventDeps {
  store: Store;
  manager: TeamManager;
  bus: MessageBus;
  board: TaskBoard;
  costs: CostTracker;
  fileLocks: FileLockManager;
  escalation: EscalationManager;
  ctx: PluginInput;
  reporter: Reporter;
}

export function createEventHook(deps: EventDeps) {
  const { store, manager, bus, board, costs, fileLocks, escalation, ctx, reporter } = deps;

  return async ({ event }: { event: Event }): Promise<void> => {
    try {
    switch (event.type) {
      // ── Session became idle ───────────────────────────────────
      case "session.idle": {
        const sessionID = event.properties.sessionID;
        const member = manager.getMemberBySession(sessionID);
        if (!member) return;

        // Transition to ready
        if (member.state === "initializing" || member.state === "busy") {
          try {
            manager.transitionMember(member.id, "ready");
          } catch {
            return;
          }

          // Toast notification
          try {
            await ctx.client.tui.showToast({
              body: {
                title: "[orch]",
                message: `${member.role} → ready`,
                variant: "info",
                duration: 3000,
              },
            });
          } catch {
            // TUI not available
          }
        }

        // Handle shutdown_requested
        if (member.state === "shutdown_requested") {
          manager.transitionMember(member.id, "shutdown");
          fileLocks.releaseAll(member.id);
          return;
        }

        // Release file locks on idle
        fileLocks.releaseAll(member.id);

        // Deliver pending messages
        const delivered = await bus.deliverMessages(member.id);
        if (delivered > 0) return; // Messages will make it busy

        // Work stealing if enabled
        const team = store.getTeam(member.teamID);
        if (team?.config.workStealing) {
          const stolen = board.stealTask(team.id, member.id, member.role);
          if (stolen) {
            try {
              await ctx.client.session.promptAsync({
                path: { id: member.sessionID },
                body: {
                  parts: [
                    {
                      type: "text",
                      text: [
                        `[Work stolen] You've been assigned task "${stolen.title}":`,
                        stolen.description,
                        "",
                        `Task ID: ${stolen.id}`,
                        "When done, use orch_tasks to complete it with your results.",
                      ].join("\n"),
                    },
                  ],
                },
              });
              await ctx.client.tui.showToast({
                body: {
                  title: "[orch]",
                  message: `${member.role} claimed task: ${stolen.title}`,
                  variant: "info",
                  duration: 3000,
                },
              });
            } catch {
              // Failed to wake — task will stay claimed
            }
          }
        }
        break;
      }

      // ── Session status change ─────────────────────────────────
      case "session.status": {
        const props = event.properties as { sessionID: string; status: { type: string } };
        const member = manager.getMemberBySession(props.sessionID);
        if (!member) return;

        if (props.status.type === "busy" && member.state === "ready") {
          try {
            manager.transitionMember(member.id, "busy");
          } catch {
            // Already in expected state
          }
        }
        break;
      }

      // ── Session error ─────────────────────────────────────────
      case "session.error": {
        const props = event.properties as { sessionID?: string };
        if (!props.sessionID) return;

        const member = manager.getMemberBySession(props.sessionID);
        if (!member) return;

        try {
          manager.transitionMember(member.id, "error");
        } catch {
          // Already in terminal state
        }

        // Release locks
        fileLocks.releaseAll(member.id);

        // Try escalation
        const result = await escalation.handleError(member.id);

        const action = result.escalated
          ? "escalated to next model"
          : result.retried
            ? "retrying"
            : "failed (escalation exhausted)";

        try {
          await ctx.client.tui.showToast({
            body: {
              title: "[orch]",
              message: `${member.role} error — ${action}`,
              variant: result.retried || result.escalated ? "warning" : "error",
              duration: 5000,
            },
          });
        } catch {
          // TUI not available
        }
        break;
      }

      // ── Message updated (cost tracking) ───────────────────────
      case "message.updated": {
        const props = event.properties as {
          info: {
            role: string;
            sessionID: string;
            cost?: number;
            tokens?: {
              input: number;
              output: number;
              reasoning: number;
              cache: { read: number; write: number };
            };
          };
        };

        if (props.info.role !== "assistant") return;

        const member = manager.getMemberBySession(props.info.sessionID);
        if (!member) return;
        if (props.info.cost === undefined) return;

        costs.record({
          memberID: member.id,
          teamID: member.teamID,
          sessionID: member.sessionID,
          cost: props.info.cost,
          tokens: props.info.tokens ?? {
            input: 0,
            output: 0,
            reasoning: 0,
            cache: { read: 0, write: 0 },
          },
        });

        // Budget check
        const team = store.getTeam(member.teamID);
        if (team && costs.isOverBudget(team.id, team.config.budgetLimit)) {
          // Shut down all active members
          const members = store.listMembers(team.id);
          for (const m of members) {
            if (!["shutdown", "error"].includes(m.state)) {
              try {
                await manager.shutdownMember(m.id);
              } catch {
                // Best effort
              }
            }
          }

          try {
            await ctx.client.tui.showToast({
              body: {
                title: "[orch]",
                message: `Team "${team.name}" exceeded budget limit!`,
                variant: "warning",
                duration: 5000,
              },
            });
          } catch {
            // TUI not available
          }
        }
        break;
      }
    }
    } catch (err) {
      reporter.error("[orch] event hook error", err);
    }
  };
}
