/** @jsxImportSource @opentui/solid */
import * as fs from "node:fs";
import * as path from "node:path";
import { createSignal, For, onCleanup, Show } from "solid-js";
import type { TuiPlugin, TuiPluginModule } from "@opencode-ai/plugin/tui";
import type { Snapshot, Run } from "./state/schemas.js";
import { tokenTotal } from "./core/usage.js";

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

export function runTokens(run: Run): string {
  let total = 0;
  let known = false;
  for (const step of Object.values(run.steps)) {
    if (!step.usage) continue;
    known = true;
    total += tokenTotal(step.usage);
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

function plural(count: number, singular: string): string {
  return `${count} ${count === 1 ? singular : `${singular}s`}`;
}

function goalTurns(turns: number, maxTurns?: number): string {
  return maxTurns === undefined
    ? plural(turns, "goal turn")
    : `${turns}/${maxTurns} goal turns`;
}

function truncateLine(line: string, maxWidth: number): string {
  if (line.length <= maxWidth) return line;
  if (maxWidth <= 1) return "";
  return `${line.slice(0, maxWidth - 1)}…`;
}

export function activityLines(
  snapshot: Snapshot | undefined,
  sessionID?: string,
  now = Date.now(),
  terminalWidth = 120
): string[] {
  const lines: string[] = [];
  // Goals belong to the lead session that created them. The home/start view
  // has no session ID, so showing every durable project goal there falsely
  // makes a brand-new session look as though it owns old work.
  const goals = sessionID && snapshot?.goals?.[sessionID]
    ? [snapshot.goals[sessionID]]
    : [];
  for (const goal of goals) {
    if (goal.status !== "active" && goal.status !== "paused") continue;
    const goalAgents =
      goal.status === "active" &&
      (goal.workerStatus === "running" ||
        goal.workerStatus === "evaluating" ||
        goal.workerStatus === "compacting")
        ? 1
        : 0;
    const worker = goal.workerStatus ?? "unknown";
    lines.push(
      terminalWidth >= 100
        ? `goal ${goal.status} · ${goalTurns(goal.turns, goal.maxTurns)} · worker ${worker} · ${plural(goalAgents, "agent")}`
        : `goal ${goal.status} · ${worker} · ${plural(goalAgents, "agent")}`
    );
  }

  const activeRuns = Object.values(snapshot?.runs ?? {}).filter(
    (run) => run.status === "running" || run.status === "paused"
  ).sort((a, b) => a.createdAt - b.createdAt);
  const totalAgents = activeRuns.reduce((sum, run) => sum + runningAgents(run), 0);
  if (terminalWidth < 72 && activeRuns.length > 0) {
    lines.push(`${plural(activeRuns.length, "workflow")} · ${plural(totalAgents, "agent")}`);
  } else {
    for (const run of activeRuns) {
      const agents = runningAgents(run);
      lines.push(
        terminalWidth >= 100
          ? `${run.workflow} · ${run.status} · ${formatElapsed(now - run.createdAt)} elapsed · ${plural(agents, "agent")}`
          : `${run.workflow} · ${run.status} · ${plural(agents, "agent")}`
      );
    }
  }
  if (activeRuns.length > 1 && terminalWidth >= 72) {
    lines.push(
      `${plural(totalAgents, "agent")} running across ${plural(activeRuns.length, "workflow")}`
    );
  }
  // The right-hand prompt slot shares horizontal space with OpenCode itself.
  // Keep a conservative margin and truncate names only after optional details
  // have already been removed.
  const maxLineWidth = Math.max(16, Math.floor(terminalWidth * 0.55));
  return lines.map((line) => truncateLine(line, maxLineWidth));
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
  renderer: {
    width: number;
    on(event: "resize", listener: () => void): unknown;
    off(event: "resize", listener: () => void): unknown;
  };
}) {
  const snapshot = createSnapshot(props.directory);
  const [width, setWidth] = createSignal(props.renderer.width);
  const onResize = () => setWidth(props.renderer.width);
  props.renderer.on("resize", onResize);
  onCleanup(() => props.renderer.off("resize", onResize));
  const lines = () => activityLines(snapshot(), props.sessionID, Date.now(), width());
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
                [{goal.status}] {goal.condition} · worker {goal.workerStatus ?? "unknown"} · {goalTurns(goal.turns, goal.maxTurns)} · tokens {goal.observedTokens ?? "unknown"}/{goal.maxTokens}
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
          renderer={api.renderer}
        />
      ),
      session_prompt_right: (_context, props) => (
        <ActivityBadge
          directory={api.state.path.directory}
          sessionID={props.session_id}
          color={api.theme.current.accent}
          renderer={api.renderer}
        />
      ),
    },
  });
};

const module: TuiPluginModule = { id: "opencode-plugin-orch", tui };
export default module;
