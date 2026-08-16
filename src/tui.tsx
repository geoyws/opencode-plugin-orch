/** @jsxImportSource @opentui/solid */
import * as fs from "node:fs";
import * as path from "node:path";
import { createSignal, For, onCleanup, Show } from "solid-js";
import type { TuiPlugin, TuiPluginModule } from "@opencode-ai/plugin/tui";
import type { Snapshot, Run } from "./state/schemas.js";

function readSnapshot(directory: string): Snapshot | undefined {
  const storeDir = path.join(directory, ".opencode", "plugin-orch");
  for (const filename of ["view.json", "snapshot.json"]) {
    try {
      return JSON.parse(fs.readFileSync(path.join(storeDir, filename), "utf-8")) as Snapshot;
    } catch {
      // A missing/corrupt live view can still fall back to the compact snapshot.
    }
  }
  return undefined;
}

function createSnapshot(directory: string): () => Snapshot | undefined {
  const [snapshot, setSnapshot] = createSignal(readSnapshot(directory));
  const timer = setInterval(() => setSnapshot(readSnapshot(directory)), 2000);
  if (typeof timer.unref === "function") timer.unref();
  onCleanup(() => clearInterval(timer));
  return snapshot;
}

function runTokens(run: Run): string {
  let total = 0;
  let known = false;
  for (const step of Object.values(run.steps)) {
    if (!step.usage) continue;
    known = true;
    total +=
      step.usage.input +
      step.usage.output +
      step.usage.reasoning +
      step.usage.cacheWrite;
  }
  return known ? `${total}${run.config.maxTokens ? `/${run.config.maxTokens}` : ""}` : "unknown";
}

export function formatElapsed(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function runningAgents(run: Run): number {
  return Object.values(run.steps).filter(
    (step) => step.status === "running" && step.sessionID !== undefined
  ).length;
}

export function activityLines(
  snapshot: Snapshot | undefined,
  sessionID?: string,
  now = Date.now()
): string[] {
  const lines: string[] = [];
  const goal = sessionID ? snapshot?.goals?.[sessionID] : undefined;
  if (goal?.status === "active") {
    lines.push(
      `goal active ${goal.turns}/${goal.maxTurns} · ${goal.observedTokens ?? "?"}/${goal.maxTokens} tok`
    );
  }

  const activeRuns = Object.values(snapshot?.runs ?? {}).filter(
    (run) => run.status === "running" || run.status === "paused"
  ).sort((a, b) => a.createdAt - b.createdAt);
  let totalAgents = 0;
  for (const run of activeRuns) {
    const agents = runningAgents(run);
    totalAgents += agents;
    const tokens = runTokens(run);
    lines.push(
      `${run.workflow} · ${run.status} · ${formatElapsed(now - run.createdAt)} elapsed · ` +
        `${agents} ${agents === 1 ? "agent" : "agents"}` +
        `${tokens === "unknown" ? "" : ` · ${tokens} tok`}`
    );
  }
  if (activeRuns.length > 1) {
    lines.push(
      `${totalAgents} ${totalAgents === 1 ? "agent" : "agents"} running across ` +
        `${activeRuns.length} workflows`
    );
  }
  return lines;
}

export function activitySummary(
  snapshot: Snapshot | undefined,
  sessionID?: string,
  now = Date.now()
): string {
  return activityLines(snapshot, sessionID, now).join("\n");
}

function ActivityBadge(props: {
  directory: string;
  sessionID?: string;
  color: unknown;
}) {
  const snapshot = createSnapshot(props.directory);
  const lines = () => activityLines(snapshot(), props.sessionID);
  return (
    <Show when={lines().length > 0}>
      <box flexDirection="column">
        <For each={lines()}>
          {(line, index) => (
            <text fg={props.color as never}>
              {index() === 0 ? "◉ orch · " : "  ↳ "}{line}
            </text>
          )}
        </For>
      </box>
    </Show>
  );
}

function Dashboard(props: { directory: string; text: unknown; muted: unknown; accent: unknown }) {
  const snapshot = createSnapshot(props.directory);
  const runs = () =>
    Object.values(snapshot()?.runs ?? {}).sort((a, b) => b.createdAt - a.createdAt);
  const goals = () =>
    Object.values(snapshot()?.goals ?? {}).sort((a, b) => b.updatedAt - a.updatedAt);
  return (
    <scrollbox flexGrow={1} padding={1}>
      <box flexDirection="column" gap={1}>
        <text fg={props.accent as never}>Orch workflows and goals</text>
        <text fg={props.muted as never}>
          Durable read-only view · refreshes every 2s · controls remain available through orch_control
        </text>
        <text fg={props.text as never}>Goals</text>
        <Show when={goals().length > 0} fallback={<text fg={props.muted as never}>  none</text>}>
          <For each={goals()}>
            {(goal) => (
              <text fg={props.text as never}>
                [{goal.status}] {goal.condition} · turns {goal.turns}/{goal.maxTurns} · tokens {goal.observedTokens ?? "unknown"}/{goal.maxTokens}
              </text>
            )}
          </For>
        </Show>
        <text fg={props.text as never}>Runs</text>
        <Show when={runs().length > 0} fallback={<text fg={props.muted as never}>  none</text>}>
          <For each={runs()}>
            {(run) => (
              <box flexDirection="column">
                <text fg={props.text as never}>
                  [{run.status}] {run.id} · {run.workflow} · tokens {runTokens(run)}
                </text>
                <text fg={props.muted as never}>
                  {Object.values(run.steps).map((step) => `${step.id}:${step.status}`).join("  ") || "no steps started"}
                </text>
              </box>
            )}
          </For>
        </Show>
      </box>
    </scrollbox>
  );
}

const tui: TuiPlugin = async (api) => {
  api.keymap.registerLayer({
    commands: [
      {
        name: "orch.dashboard",
        title: "Orch: workflows and goals",
        description: "Inspect durable workflow and goal state",
        category: "Orch",
        slashName: "orch-dashboard",
        slashAliases: ["workflows"],
        run: () => api.route.navigate("orch-dashboard"),
      },
    ],
    bindings: [],
  });
  api.route.register([
    {
      name: "orch-dashboard",
      render: () => (
        <Dashboard
          directory={api.state.path.directory}
          text={api.theme.current.text}
          muted={api.theme.current.textMuted}
          accent={api.theme.current.accent}
        />
      ),
    },
  ]);
  api.slots.register({
    slots: {
      home_prompt_right: (_context, _props) => (
        <ActivityBadge
          directory={api.state.path.directory}
          color={api.theme.current.accent}
        />
      ),
      session_prompt_right: (_context, props) => (
        <ActivityBadge
          directory={api.state.path.directory}
          sessionID={props.session_id}
          color={api.theme.current.accent}
        />
      ),
    },
  });
};

const module: TuiPluginModule = { id: "opencode-plugin-orch", tui };
export default module;
