import { afterEach, describe, expect, it } from "bun:test";
import { controlPlaneSnapshot } from "../src/core/control-plane.js";
import { makeEnv, rmrf, waitFor, type Env } from "./_harness.js";

const envs: Env[] = [];
afterEach(() => {
  for (const env of envs.splice(0)) {
    env.destroy();
    rmrf(env.projectDir);
  }
});

describe("lead control-plane snapshot", () => {
  it("keeps the lead aware of goal workers, workflow agents, usage, and controls", async () => {
    const env = await makeEnv();
    envs.push(env);
    const goal = await env.goals.start("lead", "finish the release safely");
    await env.goals.steer("lead", "include the browser receipt");
    const run = await env.runner.startRun("chain-draft-refine", "prepare release notes");
    await waitFor(() => env.client.prompts.some((prompt) => prompt.title.includes(run.id)));

    const snapshot = controlPlaneSnapshot(env.store, "lead");
    expect(snapshot).toContain("Orch lead/control-plane mode is active");
    expect(snapshot).toContain("goal (this lead): active");
    expect(snapshot).toContain(`worker=${goal.workerStatus}`);
    expect(snapshot).toContain("latest steering=include the browser receipt");
    expect(snapshot).toContain(`workflow ${run.id}: chain-draft-refine`);
    expect(snapshot).toContain("agents=1");
    expect(snapshot).toContain("orch_control or orch_goal steer");

    await env.runner.cancel(run.id);
  });

  it("reports no delegated work but still enforces delegation at the lead", async () => {
    const env = await makeEnv();
    envs.push(env);
    expect(controlPlaneSnapshot(env.store, "lead")).toContain(
      "Current delegated work: none."
    );
  });
});
