import type { Event } from "@opencode-ai/sdk";
import type { Runner } from "../core/runner.js";
import { logHookError } from "./_safe.js";
import type { GoalController } from "../core/goal-controller.js";

// Format the error payload of a session.error event into a readable string.
function formatSessionError(error: unknown): string {
  if (!error) return "session error";
  const data = (error as { data?: { message?: string } }).data;
  if (data?.message) return data.message;
  const name = (error as { name?: string }).name;
  return name ?? "session error";
}

// Drives the workflow runner: a step session going idle means its output is
// ready to collect; a session error fails the step (and therefore the run).
// Wrapped so a throw can never propagate into opencode.
export function createEventHook(deps: {
  runner: Runner;
  goals: GoalController;
  directory: string;
}) {
  const { runner, goals, directory } = deps;

  return async ({ event }: { event: Event }): Promise<void> => {
    try {
      switch (event.type) {
        case "session.idle": {
          const sessionID = event.properties.sessionID;
          // Capture before runner settlement removes the step from its map.
          const wasStep = runner.isStepSession(sessionID);
          await runner.onSessionIdle(sessionID);
          if (!wasStep && !goals.isEvaluatorSession(sessionID)) {
            await goals.onSessionIdle(sessionID);
          }
          break;
        }
        case "session.error": {
          const sessionID = event.properties.sessionID;
          if (!sessionID) return;
          const message = formatSessionError(event.properties.error);
          await runner.onSessionError(
            sessionID,
            message
          );
          await goals.onSessionError(sessionID, message);
          break;
        }
      }
    } catch (err) {
      logHookError(directory, "event", err);
    }
  };
}
