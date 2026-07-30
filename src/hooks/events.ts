import type { Event } from "@opencode-ai/sdk";
import type { Runner } from "../core/runner.js";
import { logHookError } from "./_safe.js";

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
export function createEventHook(deps: { runner: Runner; directory: string }) {
  const { runner, directory } = deps;

  return async ({ event }: { event: Event }): Promise<void> => {
    try {
      switch (event.type) {
        case "session.idle":
          await runner.onSessionIdle(event.properties.sessionID);
          break;
        case "session.error": {
          const sessionID = event.properties.sessionID;
          if (!sessionID) return;
          await runner.onSessionError(
            sessionID,
            formatSessionError(event.properties.error)
          );
          break;
        }
      }
    } catch (err) {
      logHookError(directory, "event", err);
    }
  };
}
