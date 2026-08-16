import { activityLines } from "../src/tui.js";
import type { Snapshot } from "../src/state/schemas.js";

const runs = Object.fromEntries(
  Array.from({ length: 64 }, (_, index) => [
    `run_${index}`,
    {
      id: `run_${index}`,
      workflow: `workflow-${index}`,
      pattern: "parallel" as const,
      input: "benchmark",
      status: "running" as const,
      config: {
        maxIterations: 3,
        concurrency: 4,
        stepTimeoutMs: 600_000,
        maxStepOutputChars: 50_000,
        keepSessions: false,
        stepRetries: 1,
        maxAgents: 20,
        permissionMode: "auto" as const,
      },
      steps: Object.fromEntries(
        Array.from({ length: 4 }, (_, worker) => [
          `worker-${worker}`,
          {
            id: `worker-${worker}`,
            status: "running" as const,
            sessionID: `sess_${index}_${worker}`,
          },
        ])
      ),
      iteration: 0,
      createdAt: index * 1_000,
    },
  ])
);
const snapshot = { timestamp: 120_000, runs, goals: {} } satisfies Snapshot;
const iterations = 100_000;
const started = Bun.nanoseconds();
for (let index = 0; index < iterations; index++) {
  activityLines(snapshot, undefined, 120_000);
}
const elapsed = Bun.nanoseconds() - started;
console.log(
  `typescript activity projection: ${iterations} iterations in ${(elapsed / 1e9).toFixed(3)}s ` +
    `(${(elapsed / iterations).toFixed(0)} ns/op)`
);
