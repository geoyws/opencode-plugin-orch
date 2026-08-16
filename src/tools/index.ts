import type { ToolDefinition } from "@opencode-ai/plugin";
import type { Runner } from "../core/runner.js";
import type { Store } from "../state/store.js";
import type { WorkflowRegistry } from "../workflows/index.js";
import { createRunTool } from "./run.js";
import { createWorkflowsTool } from "./workflows.js";
import { createRunsTool } from "./runs.js";
import { createStatusTool } from "./status.js";
import { createResultTool } from "./result.js";
import { createCancelTool } from "./cancel.js";
import { createLogTool } from "./log.js";
import { createGoalTool } from "./goal.js";
import type { GoalController } from "../core/goal-controller.js";
import { createControlTool } from "./control.js";

export interface ToolDeps {
  runner: Runner;
  store: Store;
  workflows: WorkflowRegistry;
  goals: GoalController;
}

export function createTools(deps: ToolDeps): Record<string, ToolDefinition> {
  return {
    orch_run: createRunTool(deps.runner),
    orch_workflows: createWorkflowsTool(deps.workflows),
    orch_runs: createRunsTool(deps.store),
    orch_status: createStatusTool(deps.store, deps.workflows),
    orch_result: createResultTool(deps.store),
    orch_cancel: createCancelTool(deps.store, deps.runner),
    orch_log: createLogTool(),
    orch_goal: createGoalTool(deps.goals),
    orch_control: createControlTool(deps.store, deps.runner),
  };
}
