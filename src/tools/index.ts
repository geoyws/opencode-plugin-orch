import type { ToolDefinition } from "@opencode-ai/plugin";
import type { TeamManager } from "../core/team-manager.js";
import type { MessageBus } from "../core/message-bus.js";
import type { TaskBoard } from "../core/task-board.js";
import type { Scratchpad } from "../core/scratchpad.js";
import type { CostTracker } from "../core/cost-tracker.js";
import type { ActivityTracker } from "../core/activity.js";
import type { Store } from "../state/store.js";
import type { TemplateRegistry } from "../templates/index.js";
import { createCreateTool } from "./create.js";
import { createSpawnTool } from "./spawn.js";
import { createMessageTool } from "./message.js";
import { createBroadcastTool } from "./broadcast.js";
import { createTasksTool } from "./tasks.js";
import { createMemoTool } from "./memo.js";
import { createStatusTool } from "./status.js";
import { createShutdownTool } from "./shutdown.js";
import { createResultTool } from "./result.js";

export interface ToolDeps {
  manager: TeamManager;
  bus: MessageBus;
  board: TaskBoard;
  pad: Scratchpad;
  costs: CostTracker;
  activity: ActivityTracker;
  store: Store;
  templates: TemplateRegistry;
}

export function createTools(deps: ToolDeps): Record<string, ToolDefinition> {
  return {
    orch_create: createCreateTool(deps.manager, deps.templates),
    orch_spawn: createSpawnTool(deps.manager),
    orch_message: createMessageTool(deps.manager, deps.bus),
    orch_broadcast: createBroadcastTool(deps.manager, deps.bus),
    orch_tasks: createTasksTool(deps.manager, deps.board, deps.store),
    orch_memo: createMemoTool(deps.manager, deps.pad),
    orch_status: createStatusTool(deps.manager, deps.costs, deps.activity, deps.board, deps.store),
    orch_shutdown: createShutdownTool(deps.manager),
    orch_result: createResultTool(deps.manager, deps.board, deps.costs, deps.store),
  };
}
