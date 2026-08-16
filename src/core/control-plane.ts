import type { Store } from "../state/store.js";
import { tokenTotal } from "./usage.js";

function compact(text: string, max = 240): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max - 1)}…`;
}

function elapsed(createdAt: number): string {
  const seconds = Math.max(0, Math.floor((Date.now() - createdAt) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export function controlPlaneSnapshot(store: Store, sessionID?: string): string {
  const goals = store
    .listGoals()
    .filter((goal) => goal.status === "active" || goal.status === "paused");
  const runs = store
    .listRuns()
    .filter((run) => run.status === "running" || run.status === "paused");
  const lines = [
    "Orch lead/control-plane mode is active.",
    "Keep this conversation available for the operator. Delegate substantive implementation to a dedicated goal worker with orch_goal action=set, or to a workflow with orch_run. Do not duplicate delegated implementation in this lead session.",
    "Use orch_status/orch_goal status to inspect, orch_control or orch_goal steer to redirect, pause/resume for safe suspension, and cancel/clear to stop work.",
  ];
  if (goals.length === 0 && runs.length === 0) {
    lines.push("Current delegated work: none.");
    return lines.join("\n");
  }
  lines.push("Current delegated work (live durable snapshot):");
  for (const goal of goals) {
    lines.push(
      `- goal${goal.sessionID === sessionID ? " (this lead)" : ""}: ${goal.status}; ` +
        `worker=${goal.workerStatus ?? "unknown"}; turns=${goal.turns}/${goal.maxTurns}; ` +
        `tokens=${goal.observedTokens ?? "unknown"}/${goal.maxTokens}; elapsed=${elapsed(goal.createdAt)}; ` +
        `condition=${compact(goal.condition)}`
    );
    if (goal.lastReason) lines.push(`  last=${compact(goal.lastReason)}`);
    const steering = goal.steering?.at(-1);
    if (steering) lines.push(`  latest steering=${compact(steering.text)}`);
  }
  for (const run of runs) {
    const running = Object.values(run.steps).filter((step) => step.status === "running");
    const knownUsage = Object.values(run.steps).filter((step) => step.usage);
    const tokens = knownUsage.length
      ? knownUsage.reduce((sum, step) => sum + tokenTotal(step.usage!), 0)
      : "unknown";
    const steps = Object.values(run.steps)
      .map((step) => `${step.id}:${step.status}`)
      .join(", ") || "none started";
    lines.push(
      `- workflow ${run.id}: ${run.workflow}; status=${run.status}; agents=${running.length}; ` +
        `tokens=${tokens}${run.config.maxTokens ? `/${run.config.maxTokens}` : ""}; ` +
        `elapsed=${elapsed(run.createdAt)}; input=${compact(run.input)}; steps=${compact(steps, 320)}`
    );
    const steering = run.steering?.at(-1);
    if (steering) lines.push(`  latest steering=${compact(steering.text)}`);
  }
  return lines.join("\n");
}
