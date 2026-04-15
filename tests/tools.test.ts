// Integration tests for orch_* tools — exercise each tool's execute()
// against a real Store + TeamManager + (mocked) SDK client.

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { createHarness, makeToolContext, type Harness } from "./_harness.js";

// ─── orch_create ──────────────────────────────────────────────────────
describe("orch_create", () => {
  let h: Harness;
  beforeEach(async () => { h = await createHarness(); });
  afterEach(() => { h.cleanup(); });

  test("creates a team", async () => {
    const result = await h.tools.orch_create.execute(
      { name: "team-1" },
      makeToolContext("lead-session")
    );
    expect(result).toContain('Team "team-1" created');
    const team = h.store.getTeamByName("team-1");
    expect(team).toBeDefined();
    expect(team?.leadSessionID).toBe("lead-session");
  });

  test("honours workStealing, backpressureLimit, and budgetLimit config", async () => {
    await h.tools.orch_create.execute(
      {
        name: "team-cfg",
        workStealing: false,
        backpressureLimit: 10,
        budgetLimit: 5,
      },
      makeToolContext("lead-session")
    );
    const team = h.store.getTeamByName("team-cfg");
    expect(team?.config.workStealing).toBe(false);
    expect(team?.config.backpressureLimit).toBe(10);
    expect(team?.config.budgetLimit).toBe(5);
  });

  test("creates team with template and auto-spawns members", async () => {
    const result = await h.tools.orch_create.execute(
      { name: "cr-team", template: "code-review" },
      makeToolContext("lead-session")
    );
    expect(result).toContain("code-review");
    expect(result).toContain("reviewer");
    expect(result).toContain("fixer");

    const team = h.store.getTeamByName("cr-team")!;
    const members = h.store.listMembers(team.id);
    expect(members.map((m) => m.role).sort()).toEqual(["fixer", "reviewer"]);
    expect(h.client.callsFor("session.create")).toHaveLength(2);
  });

  test("returns note for unknown template (without spawning)", async () => {
    const result = await h.tools.orch_create.execute(
      { name: "bad-team", template: "no-such-template" },
      makeToolContext("lead-session")
    );
    expect(result).toContain("not found");
    const team = h.store.getTeamByName("bad-team")!;
    expect(h.store.listMembers(team.id)).toHaveLength(0);
  });

  test("rejects invalid escalation JSON", async () => {
    const result = await h.tools.orch_create.execute(
      { name: "bad-esc", escalation: "{not json" },
      makeToolContext("lead-session")
    );
    expect(result).toBe("Error: Invalid escalation JSON");
    expect(h.store.getTeamByName("bad-esc")).toBeUndefined();
  });

  test("parses valid escalation JSON", async () => {
    await h.tools.orch_create.execute(
      {
        name: "esc-team",
        escalation: '[{"providerID":"anthropic","modelID":"haiku"}]',
        maxRetries: 3,
      },
      makeToolContext("lead-session")
    );
    const team = h.store.getTeamByName("esc-team");
    expect(team?.config.escalation?.enabled).toBe(true);
    expect(team?.config.escalation?.maxRetries).toBe(3);
  });
});

// ─── orch_spawn ───────────────────────────────────────────────────────
describe("orch_spawn", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await createHarness();
    h.manager.createTeam("t1", "lead-session");
  });
  afterEach(() => { h.cleanup(); });

  test("spawns a member in the given team", async () => {
    const result = await h.tools.orch_spawn.execute(
      { team: "t1", role: "coder", instructions: "write code" },
      makeToolContext("lead-session")
    );
    expect(result).toContain('Spawned member "coder"');
    const team = h.store.getTeamByName("t1")!;
    const member = h.store.getMemberByRole(team.id, "coder");
    expect(member).toBeDefined();
    expect(member?.sessionID).toBe("mock-session-1");
    expect(h.client.callsFor("session.create")).toHaveLength(1);
    expect(h.client.callsFor("session.promptAsync")).toHaveLength(1);
  });

  test("rejects duplicate role in same team", async () => {
    await h.tools.orch_spawn.execute(
      { team: "t1", role: "coder", instructions: "first" },
      makeToolContext("lead-session")
    );
    const result = await h.tools.orch_spawn.execute(
      { team: "t1", role: "coder", instructions: "second" },
      makeToolContext("lead-session")
    );
    expect(result).toContain("Error:");
    expect(result).toContain("already exists");
  });

  test("pre-loads files into context via file.read + session.prompt", async () => {
    h.client.registerFile("src/foo.ts", "export const foo = 1;");
    h.client.registerFile("src/bar.ts", "export const bar = 2;");

    const result = await h.tools.orch_spawn.execute(
      {
        team: "t1",
        role: "reader",
        instructions: "read",
        files: "src/foo.ts, src/bar.ts",
      },
      makeToolContext("lead-session")
    );
    expect(result).toContain("Pre-loaded 2 file(s)");
    const reads = h.client.callsFor("file.read");
    expect(reads).toHaveLength(2);
    const paths = reads.map((r) => (r.args as { query: { path: string } }).query.path);
    expect(paths).toContain("src/foo.ts");
    expect(paths).toContain("src/bar.ts");

    // Files seed happens via session.prompt with noReply:true
    const prompts = h.client.callsFor("session.prompt");
    expect(prompts.length).toBeGreaterThanOrEqual(1);
    const seed = prompts[0].args as { body: { noReply: boolean; parts: Array<{ text: string }> } };
    expect(seed.body.noReply).toBe(true);
    expect(seed.body.parts.length).toBe(2);
  });

  test("forwards model and agent to session.promptAsync", async () => {
    const result = await h.tools.orch_spawn.execute(
      {
        team: "t1",
        role: "smart",
        instructions: "think",
        agent: "plan",
        providerID: "anthropic",
        modelID: "claude-opus-4-6",
      },
      makeToolContext("lead-session")
    );
    expect(result).toContain("anthropic/claude-opus-4-6");
    expect(result).toContain("Agent: plan");

    const calls = h.client.callsFor("session.promptAsync");
    expect(calls).toHaveLength(1);
    const body = (calls[0].args as { body: { agent: string; model: { modelID: string } } }).body;
    expect(body.agent).toBe("plan");
    expect(body.model.modelID).toBe("claude-opus-4-6");
  });
});

// ─── orch_message ─────────────────────────────────────────────────────
describe("orch_message", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await createHarness();
    h.manager.createTeam("msg-team", "lead-session", { backpressureLimit: 2 });
    await h.tools.orch_spawn.execute(
      { team: "msg-team", role: "alpha", instructions: "x" },
      makeToolContext("lead-session")
    );
    await h.tools.orch_spawn.execute(
      { team: "msg-team", role: "beta", instructions: "x" },
      makeToolContext("lead-session")
    );
  });
  afterEach(() => { h.cleanup(); });

  test("sends a message from lead and records it in the store", async () => {
    const result = await h.tools.orch_message.execute(
      { team: "msg-team", to: "alpha", content: "hello" },
      makeToolContext("lead-session")
    );
    expect(result).toContain("Message sent");
    const team = h.store.getTeamByName("msg-team")!;
    const alpha = h.store.getMemberByRole(team.id, "alpha")!;
    const pending = h.store.getUndeliveredMessages(alpha.id);
    expect(pending).toHaveLength(1);
    expect(pending[0].content).toBe("hello");
    expect(pending[0].from).toBe("lead");
  });

  test("detects sender role when called from a member session", async () => {
    const team = h.store.getTeamByName("msg-team")!;
    const alpha = h.store.getMemberByRole(team.id, "alpha")!;
    await h.tools.orch_message.execute(
      { team: "msg-team", to: "beta", content: "hey beta" },
      makeToolContext(alpha.sessionID)
    );
    const beta = h.store.getMemberByRole(team.id, "beta")!;
    const pending = h.store.getUndeliveredMessages(beta.id);
    expect(pending).toHaveLength(1);
    expect(pending[0].from).toBe(alpha.id);
  });

  test("errors when backpressure limit reached", async () => {
    // limit is 2 — two messages fit, third returns an error string
    await h.tools.orch_message.execute(
      { team: "msg-team", to: "alpha", content: "1" },
      makeToolContext("lead-session")
    );
    await h.tools.orch_message.execute(
      { team: "msg-team", to: "alpha", content: "2" },
      makeToolContext("lead-session")
    );
    const result = await h.tools.orch_message.execute(
      { team: "msg-team", to: "alpha", content: "3" },
      makeToolContext("lead-session")
    );
    expect(result).toContain("Error:");
    expect(result).toContain("Backpressure limit");
  });
});

// ─── orch_broadcast ───────────────────────────────────────────────────
describe("orch_broadcast", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await createHarness();
    h.manager.createTeam("bt", "lead-session");
    for (const role of ["a", "b", "c"]) {
      await h.tools.orch_spawn.execute(
        { team: "bt", role, instructions: "x" },
        makeToolContext("lead-session")
      );
    }
  });
  afterEach(() => { h.cleanup(); });

  test("broadcasts to all members when lead is sender", async () => {
    const result = await h.tools.orch_broadcast.execute(
      { team: "bt", content: "attention all" },
      makeToolContext("lead-session")
    );
    expect(result).toContain("3 member");
  });

  test("skips sender when broadcast comes from a member", async () => {
    const team = h.store.getTeamByName("bt")!;
    const memberA = h.store.getMemberByRole(team.id, "a")!;
    const result = await h.tools.orch_broadcast.execute(
      { team: "bt", content: "hello team" },
      makeToolContext(memberA.sessionID)
    );
    expect(result).toContain("2 member");
    // a should have no pending (skipped), b and c should each have 1
    expect(h.store.getUndeliveredMessages(memberA.id)).toHaveLength(0);
    const b = h.store.getMemberByRole(team.id, "b")!;
    const c = h.store.getMemberByRole(team.id, "c")!;
    expect(h.store.getUndeliveredMessages(b.id)).toHaveLength(1);
    expect(h.store.getUndeliveredMessages(c.id)).toHaveLength(1);
  });

  test("skips shutdown members", async () => {
    const team = h.store.getTeamByName("bt")!;
    const b = h.store.getMemberByRole(team.id, "b")!;
    h.store.updateMember({ ...b, state: "shutdown" });

    const result = await h.tools.orch_broadcast.execute(
      { team: "bt", content: "ping" },
      makeToolContext("lead-session")
    );
    // a, c reached; b skipped
    expect(result).toContain("2 member");
    expect(h.store.getUndeliveredMessages(b.id)).toHaveLength(0);
  });
});

// ─── orch_tasks ───────────────────────────────────────────────────────
describe("orch_tasks", () => {
  let h: Harness;
  let teamID: string;
  let memberSessionID: string;
  let memberID: string;

  beforeEach(async () => {
    h = await createHarness();
    const team = h.manager.createTeam("tt", "lead-session");
    teamID = team.id;
    await h.tools.orch_spawn.execute(
      { team: "tt", role: "worker", instructions: "work" },
      makeToolContext("lead-session")
    );
    const m = h.store.getMemberByRole(teamID, "worker")!;
    memberSessionID = m.sessionID;
    memberID = m.id;
  });
  afterEach(() => { h.cleanup(); });

  test("add → list → claim → complete flow", async () => {
    const add = await h.tools.orch_tasks.execute(
      { team: "tt", action: "add", title: "fix bug", description: "do thing" },
      makeToolContext("lead-session")
    );
    expect(add).toContain('Task added: "fix bug"');

    const list = await h.tools.orch_tasks.execute(
      { team: "tt", action: "list" },
      makeToolContext("lead-session")
    );
    expect(list).toContain("fix bug");
    expect(list).toContain("[available]");

    const [task] = h.store.listTasks(teamID);
    const claim = await h.tools.orch_tasks.execute(
      { team: "tt", action: "claim", taskID: task.id },
      makeToolContext(memberSessionID)
    );
    expect(claim).toContain('Claimed task "fix bug"');
    expect(h.store.getTask(task.id)?.status).toBe("claimed");
    expect(h.store.getTask(task.id)?.assignee).toBe(memberID);

    const done = await h.tools.orch_tasks.execute(
      { team: "tt", action: "complete", taskID: task.id, result: "fixed" },
      makeToolContext(memberSessionID)
    );
    expect(done).toContain('Completed task "fix bug"');
    expect(h.store.getTask(task.id)?.status).toBe("completed");
    expect(h.store.getTask(task.id)?.result).toBe("fixed");
  });

  test("claim rejected when caller is not a team member", async () => {
    await h.tools.orch_tasks.execute(
      { team: "tt", action: "add", title: "t1" },
      makeToolContext("lead-session")
    );
    const [task] = h.store.listTasks(teamID);
    const result = await h.tools.orch_tasks.execute(
      { team: "tt", action: "claim", taskID: task.id },
      makeToolContext("lead-session")
    );
    expect(result).toBe("Error: Only team members can claim tasks");
    expect(h.store.getTask(task.id)?.status).toBe("available");
  });

  test("fail action", async () => {
    await h.tools.orch_tasks.execute(
      { team: "tt", action: "add", title: "flaky" },
      makeToolContext("lead-session")
    );
    const [task] = h.store.listTasks(teamID);
    await h.tools.orch_tasks.execute(
      { team: "tt", action: "claim", taskID: task.id },
      makeToolContext(memberSessionID)
    );
    const result = await h.tools.orch_tasks.execute(
      { team: "tt", action: "fail", taskID: task.id, result: "broken" },
      makeToolContext(memberSessionID)
    );
    expect(result).toContain('Failed task "flaky"');
    expect(h.store.getTask(task.id)?.status).toBe("failed");
  });

  test("filter by status (completed)", async () => {
    await h.tools.orch_tasks.execute(
      { team: "tt", action: "add", title: "todo" },
      makeToolContext("lead-session")
    );
    await h.tools.orch_tasks.execute(
      { team: "tt", action: "add", title: "done-task" },
      makeToolContext("lead-session")
    );
    const [, t2] = h.store.listTasks(teamID);
    await h.tools.orch_tasks.execute(
      { team: "tt", action: "claim", taskID: t2.id },
      makeToolContext(memberSessionID)
    );
    await h.tools.orch_tasks.execute(
      { team: "tt", action: "complete", taskID: t2.id, result: "ok" },
      makeToolContext(memberSessionID)
    );

    const list = await h.tools.orch_tasks.execute(
      { team: "tt", action: "list", filter: "completed" },
      makeToolContext("lead-session")
    );
    expect(list).toContain("done-task");
    expect(list).not.toContain("[available]  todo");
  });

  test("add with unknown dependency returns error string", async () => {
    const result = await h.tools.orch_tasks.execute(
      {
        team: "tt",
        action: "add",
        title: "dependent",
        dependsOn: "task_does_not_exist",
      },
      makeToolContext("lead-session")
    );
    expect(result).toBe(
      'Error: dependency "task_does_not_exist" not found (tried as both task ID and task title)'
    );
  });

  test("add resolves a single dependency by title", async () => {
    await h.tools.orch_tasks.execute(
      { team: "tt", action: "add", title: "Build step" },
      makeToolContext("lead-session")
    );
    const [buildStep] = h.store.listTasks(teamID);

    const result = await h.tools.orch_tasks.execute(
      {
        team: "tt",
        action: "add",
        title: "Deploy step",
        dependsOn: "Build step",
      },
      makeToolContext("lead-session")
    );
    expect(result).toContain('Task added: "Deploy step"');
    const deploy = h.store
      .listTasks(teamID)
      .find((t) => t.title === "Deploy step")!;
    expect(deploy.dependsOn).toEqual([buildStep.id]);
  });

  test("add resolves mixed ID and title dependencies", async () => {
    await h.tools.orch_tasks.execute(
      { team: "tt", action: "add", title: "Other Title" },
      makeToolContext("lead-session")
    );
    await h.tools.orch_tasks.execute(
      { team: "tt", action: "add", title: "First" },
      makeToolContext("lead-session")
    );
    const [otherTitle, first] = h.store.listTasks(teamID);

    const result = await h.tools.orch_tasks.execute(
      {
        team: "tt",
        action: "add",
        title: "Third",
        dependsOn: `${first.id},Other Title`,
      },
      makeToolContext("lead-session")
    );
    expect(result).toContain('Task added: "Third"');
    const third = h.store.listTasks(teamID).find((t) => t.title === "Third")!;
    expect(third.dependsOn).toContain(first.id);
    expect(third.dependsOn).toContain(otherTitle.id);
    expect(third.dependsOn).toHaveLength(2);
  });

  test("add title match is case-insensitive", async () => {
    await h.tools.orch_tasks.execute(
      { team: "tt", action: "add", title: "Build Step" },
      makeToolContext("lead-session")
    );
    const [build] = h.store.listTasks(teamID);

    const result = await h.tools.orch_tasks.execute(
      {
        team: "tt",
        action: "add",
        title: "Downstream",
        dependsOn: "build step", // lowercase
      },
      makeToolContext("lead-session")
    );
    expect(result).toContain('Task added: "Downstream"');
    const downstream = h.store
      .listTasks(teamID)
      .find((t) => t.title === "Downstream")!;
    expect(downstream.dependsOn).toEqual([build.id]);
  });

  test("add still accepts existing task IDs (backward compat)", async () => {
    await h.tools.orch_tasks.execute(
      { team: "tt", action: "add", title: "parent" },
      makeToolContext("lead-session")
    );
    const [parent] = h.store.listTasks(teamID);

    const result = await h.tools.orch_tasks.execute(
      {
        team: "tt",
        action: "add",
        title: "child",
        dependsOn: parent.id,
      },
      makeToolContext("lead-session")
    );
    expect(result).toContain('Task added: "child"');
    const child = h.store.listTasks(teamID).find((t) => t.title === "child")!;
    expect(child.dependsOn).toEqual([parent.id]);
  });

  test("add without title errors", async () => {
    const result = await h.tools.orch_tasks.execute(
      { team: "tt", action: "add" },
      makeToolContext("lead-session")
    );
    expect(result).toBe("Error: title is required for add");
  });

  test("list returns empty message when no tasks", async () => {
    const result = await h.tools.orch_tasks.execute(
      { team: "tt", action: "list" },
      makeToolContext("lead-session")
    );
    expect(result).toBe("No tasks found.");
  });
});

// ─── orch_memo ────────────────────────────────────────────────────────
describe("orch_memo", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await createHarness();
    h.manager.createTeam("mt", "lead-session");
  });
  afterEach(() => { h.cleanup(); });

  test("set, get, list, delete round-trip", async () => {
    const set = await h.tools.orch_memo.execute(
      { team: "mt", action: "set", key: "finding-1", value: "bug in X" },
      makeToolContext("lead-session")
    );
    expect(set).toBe("Memo set: finding-1");

    const get = await h.tools.orch_memo.execute(
      { team: "mt", action: "get", key: "finding-1" },
      makeToolContext("lead-session")
    );
    expect(get).toBe("finding-1: bug in X");

    await h.tools.orch_memo.execute(
      { team: "mt", action: "set", key: "finding-2", value: "also this" },
      makeToolContext("lead-session")
    );
    const list = await h.tools.orch_memo.execute(
      { team: "mt", action: "list" },
      makeToolContext("lead-session")
    );
    expect(list).toContain("finding-1");
    expect(list).toContain("finding-2");

    const del = await h.tools.orch_memo.execute(
      { team: "mt", action: "delete", key: "finding-1" },
      makeToolContext("lead-session")
    );
    expect(del).toBe("Memo deleted: finding-1");

    const getGone = await h.tools.orch_memo.execute(
      { team: "mt", action: "get", key: "finding-1" },
      makeToolContext("lead-session")
    );
    expect(getGone).toContain("not found");
  });

  test("list returns empty message when pad is empty", async () => {
    const result = await h.tools.orch_memo.execute(
      { team: "mt", action: "list" },
      makeToolContext("lead-session")
    );
    expect(result).toBe("Scratchpad is empty.");
  });

  test("set without key/value errors", async () => {
    const noKey = await h.tools.orch_memo.execute(
      { team: "mt", action: "set", value: "v" },
      makeToolContext("lead-session")
    );
    expect(noKey).toBe("Error: key is required for set");

    const noVal = await h.tools.orch_memo.execute(
      { team: "mt", action: "set", key: "k" },
      makeToolContext("lead-session")
    );
    expect(noVal).toBe("Error: value is required for set");
  });
});

// ─── orch_status ──────────────────────────────────────────────────────
describe("orch_status", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await createHarness();
    h.manager.createTeam("st", "lead-session", { budgetLimit: 1 });
    for (const role of ["reviewer", "coder"]) {
      await h.tools.orch_spawn.execute(
        { team: "st", role, instructions: "x" },
        makeToolContext("lead-session")
      );
    }
  });
  afterEach(() => { h.cleanup(); });

  test("powerline output contains team name, member roles, and costs", async () => {
    const team = h.store.getTeamByName("st")!;
    const reviewer = h.store.getMemberByRole(team.id, "reviewer")!;
    h.costs.record({
      teamID: team.id,
      memberID: reviewer.id,
      messageID: "m1",
      cost: 0.25,
      providerID: "anthropic",
      modelID: "sonnet",
    });

    const result = await h.tools.orch_status.execute(
      { team: "st" },
      makeToolContext("lead-session")
    );
    expect(result).toContain("st");
    expect(result).toContain("reviewer");
    expect(result).toContain("coder");
    expect(result).toContain("$0.2500");
    expect(result).toContain("2/2 active");
  });

  test("verbose flag includes task list", async () => {
    await h.tools.orch_tasks.execute(
      { team: "st", action: "add", title: "doc-it" },
      makeToolContext("lead-session")
    );
    const result = await h.tools.orch_status.execute(
      { team: "st", verbose: true },
      makeToolContext("lead-session")
    );
    expect(result).toContain("Tasks:");
    expect(result).toContain("doc-it");
  });

  test("emits budget warning when cost exceeds 80% of limit", async () => {
    const team = h.store.getTeamByName("st")!;
    const coder = h.store.getMemberByRole(team.id, "coder")!;
    h.costs.record({
      teamID: team.id,
      memberID: coder.id,
      messageID: "m2",
      cost: 0.95,
      providerID: "anthropic",
      modelID: "sonnet",
    });
    const result = await h.tools.orch_status.execute(
      { team: "st" },
      makeToolContext("lead-session")
    );
    expect(result).toContain("Budget");
    expect(result).toContain("95%");
  });

  test("surfaces recent peer messages in output", async () => {
    const team = h.store.getTeamByName("st")!;
    const reviewer = h.store.getMemberByRole(team.id, "reviewer")!;
    await h.tools.orch_message.execute(
      { team: "st", to: "coder", content: "please refactor this" },
      makeToolContext(reviewer.sessionID)
    );
    const result = await h.tools.orch_status.execute(
      { team: "st" },
      makeToolContext("lead-session")
    );
    expect(result).toContain("Recent messages:");
    expect(result).toContain("reviewer → coder");
    expect(result).toContain("please refactor this");
  });

  test("lead→member messages are NOT shown in Recent messages", async () => {
    await h.tools.orch_message.execute(
      { team: "st", to: "coder", content: "lead-says-hi" },
      makeToolContext("lead-session")
    );
    const result = await h.tools.orch_status.execute(
      { team: "st" },
      makeToolContext("lead-session")
    );
    expect(result).toContain("Recent messages: (none)");
    expect(result).not.toContain("lead-says-hi");
  });

  test("verbose shows untruncated content, non-verbose truncates", async () => {
    const team = h.store.getTeamByName("st")!;
    const reviewer = h.store.getMemberByRole(team.id, "reviewer")!;
    const long = "x".repeat(120);
    await h.tools.orch_message.execute(
      { team: "st", to: "coder", content: `big-${long}` },
      makeToolContext(reviewer.sessionID)
    );

    // Short mode: content is truncated with ellipsis, full long string absent
    const short = await h.tools.orch_status.execute(
      { team: "st" },
      makeToolContext("lead-session")
    );
    expect(short).toContain("Recent messages:");
    expect(short).toContain("…");
    expect(short).not.toContain(long);

    // Verbose mode: full content present, no ellipsis on this line
    const verbose = await h.tools.orch_status.execute(
      { team: "st", verbose: true },
      makeToolContext("lead-session")
    );
    expect(verbose).toContain("Recent messages:");
    expect(verbose).toContain(`big-${long}`);
  });

  test("Recent messages shows broadcast sender by role (not raw id)", async () => {
    const team = h.store.getTeamByName("st")!;
    const reviewer = h.store.getMemberByRole(team.id, "reviewer")!;
    await h.tools.orch_broadcast.execute(
      { team: "st", content: "team, please review" },
      makeToolContext(reviewer.sessionID)
    );
    const result = await h.tools.orch_status.execute(
      { team: "st" },
      makeToolContext("lead-session")
    );
    expect(result).toContain("Recent messages:");
    expect(result).toContain("reviewer →");
    expect(result).toContain("team, please review");
    // The raw member id must NOT leak into the rendered line
    expect(result).not.toContain(reviewer.id);
  });

  test("Recent messages shows (none) when no peer traffic", async () => {
    const result = await h.tools.orch_status.execute(
      { team: "st" },
      makeToolContext("lead-session")
    );
    expect(result).toContain("Recent messages: (none)");
  });
});

// ─── orch_shutdown ────────────────────────────────────────────────────
describe("orch_shutdown", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await createHarness();
    h.manager.createTeam("sd", "lead-session");
    for (const role of ["a", "b"]) {
      await h.tools.orch_spawn.execute(
        { team: "sd", role, instructions: "x" },
        makeToolContext("lead-session")
      );
    }
  });
  afterEach(() => { h.cleanup(); });

  test("shuts down a single member and calls session.abort", async () => {
    const team = h.store.getTeamByName("sd")!;
    const a = h.store.getMemberByRole(team.id, "a")!;
    h.store.updateMember({ ...a, state: "ready" });

    const result = await h.tools.orch_shutdown.execute(
      { team: "sd", member: "a" },
      makeToolContext("lead-session")
    );
    expect(result).toBe('Member "a" shut down');
    expect(h.store.getMember(a.id)?.state).toBe("shutdown");

    const aborts = h.client.callsFor("session.abort");
    expect(aborts.length).toBe(1);
    expect((aborts[0].args as { path: { id: string } }).path.id).toBe(a.sessionID);
  });

  test("returns not-found message for unknown member", async () => {
    const result = await h.tools.orch_shutdown.execute(
      { team: "sd", member: "ghost" },
      makeToolContext("lead-session")
    );
    expect(result).toContain('"ghost" not found');
  });

  test("shuts down entire team when no member specified", async () => {
    const team = h.store.getTeamByName("sd")!;
    for (const role of ["a", "b"]) {
      const m = h.store.getMemberByRole(team.id, role)!;
      h.store.updateMember({ ...m, state: "ready" });
    }

    const result = await h.tools.orch_shutdown.execute(
      { team: "sd" },
      makeToolContext("lead-session")
    );
    expect(result).toContain("shut down");
    expect(result).toContain("all members terminated");
    for (const role of ["a", "b"]) {
      const m = h.store.getMemberByRole(team.id, role)!;
      expect(m.state).toBe("shutdown");
    }
    expect(h.client.callsFor("session.abort").length).toBe(2);
  });
});

// ─── orch_result ──────────────────────────────────────────────────────
describe("orch_result", () => {
  let h: Harness;
  let teamID: string;
  let memberSessionID: string;

  beforeEach(async () => {
    h = await createHarness();
    const team = h.manager.createTeam("rt", "lead-session");
    teamID = team.id;
    await h.tools.orch_spawn.execute(
      { team: "rt", role: "worker", instructions: "x" },
      makeToolContext("lead-session")
    );
    memberSessionID = h.store.getMemberByRole(teamID, "worker")!.sessionID;

    // Seed: one completed, one failed, one pending
    await h.tools.orch_tasks.execute(
      { team: "rt", action: "add", title: "done-one" },
      makeToolContext("lead-session")
    );
    await h.tools.orch_tasks.execute(
      { team: "rt", action: "add", title: "broken-one" },
      makeToolContext("lead-session")
    );
    await h.tools.orch_tasks.execute(
      { team: "rt", action: "add", title: "pending-one" },
      makeToolContext("lead-session")
    );

    const [t1, t2] = h.store.listTasks(teamID);
    await h.tools.orch_tasks.execute(
      { team: "rt", action: "claim", taskID: t1.id },
      makeToolContext(memberSessionID)
    );
    await h.tools.orch_tasks.execute(
      { team: "rt", action: "complete", taskID: t1.id, result: "line1\nline2" },
      makeToolContext(memberSessionID)
    );
    await h.tools.orch_tasks.execute(
      { team: "rt", action: "claim", taskID: t2.id },
      makeToolContext(memberSessionID)
    );
    await h.tools.orch_tasks.execute(
      { team: "rt", action: "fail", taskID: t2.id, result: "it-broke" },
      makeToolContext(memberSessionID)
    );
  });
  afterEach(() => { h.cleanup(); });

  test("summary format shows only first line of result", async () => {
    const result = await h.tools.orch_result.execute(
      { team: "rt" },
      makeToolContext("lead-session")
    );
    expect(result).toContain("# Results for team");
    expect(result).toContain("1 completed");
    expect(result).toContain("1 failed");
    expect(result).toContain("1 remaining");
    expect(result).toContain("done-one");
    expect(result).toContain("line1");
    expect(result).not.toContain("line2");
    expect(result).toContain("broken-one");
    expect(result).toContain("FAILED: it-broke");
  });

  test("detailed format shows full multi-line result", async () => {
    const result = await h.tools.orch_result.execute(
      { team: "rt", format: "detailed" },
      makeToolContext("lead-session")
    );
    expect(result).toContain("line1");
    expect(result).toContain("line2");
  });

  test("json format returns valid JSON with task breakdown", async () => {
    const result = await h.tools.orch_result.execute(
      { team: "rt", format: "json" },
      makeToolContext("lead-session")
    );
    const parsed = JSON.parse(result) as {
      team: string;
      tasks: { total: number; completed: number; failed: number; pending: number };
      results: Array<{ title: string; assignee: string | null }>;
      failures: Array<{ title: string; reason: string }>;
    };
    expect(parsed.team).toBe("rt");
    expect(parsed.tasks.total).toBe(3);
    expect(parsed.tasks.completed).toBe(1);
    expect(parsed.tasks.failed).toBe(1);
    expect(parsed.tasks.pending).toBe(1);
    expect(parsed.results[0].title).toBe("done-one");
    expect(parsed.results[0].assignee).toBe("worker");
    expect(parsed.failures[0].title).toBe("broken-one");
  });
});

// ─── error-string contract ───────────────────────────────────────────
// Internal failures should be returned to the caller as "Error: ..."
// strings rather than thrown, so the LLM can read and react.
describe("error-string contract", () => {
  let h: Harness;
  beforeEach(async () => { h = await createHarness(); });
  afterEach(() => { h.cleanup(); });

  test("orch_message returns error when recipient role is unknown", async () => {
    h.manager.createTeam("eteam", "lead-session");
    const result = await h.tools.orch_message.execute(
      { team: "eteam", to: "ghost", content: "hi" },
      makeToolContext("lead-session")
    );
    expect(result).toMatch(/^Error:/);
    expect(result).toContain("ghost");
  });

  test("orch_message returns error when team does not exist", async () => {
    const result = await h.tools.orch_message.execute(
      { team: "nope", to: "x", content: "hi" },
      makeToolContext("lead-session")
    );
    expect(result).toMatch(/^Error:/);
  });

  test("orch_broadcast returns error when team does not exist", async () => {
    const result = await h.tools.orch_broadcast.execute(
      { team: "nope", content: "hi" },
      makeToolContext("lead-session")
    );
    expect(result).toMatch(/^Error:/);
  });

  test("orch_status returns error when team does not exist", async () => {
    const result = await h.tools.orch_status.execute(
      { team: "nope" },
      makeToolContext("lead-session")
    );
    expect(result).toMatch(/^Error:/);
  });

  test("orch_shutdown returns error when team does not exist", async () => {
    const result = await h.tools.orch_shutdown.execute(
      { team: "nope" },
      makeToolContext("lead-session")
    );
    expect(result).toMatch(/^Error:/);
  });

  test("orch_tasks claim from non-member returns error string", async () => {
    const team = h.manager.createTeam("etasks", "lead-session");
    await h.tools.orch_spawn.execute(
      { team: "etasks", role: "worker", instructions: "x" },
      makeToolContext("lead-session")
    );
    await h.tools.orch_tasks.execute(
      { team: "etasks", action: "add", title: "t" },
      makeToolContext("lead-session")
    );
    const [task] = h.store.listTasks(team.id);
    const result = await h.tools.orch_tasks.execute(
      { team: "etasks", action: "claim", taskID: task.id },
      makeToolContext("lead-session")
    );
    expect(result).toBe("Error: Only team members can claim tasks");
  });
});

// ─── orch_inbox ───────────────────────────────────────────────────────
describe("orch_inbox", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await createHarness();
    h.manager.createTeam("ib", "lead-session");
    for (const role of ["alpha", "beta", "gamma"]) {
      await h.tools.orch_spawn.execute(
        { team: "ib", role, instructions: "x" },
        makeToolContext("lead-session")
      );
    }
    // Nudge the clock past createdAt so subsequent peer messages register
    // as "after" the initial lastSeen cursor on every platform.
    await new Promise((r) => setTimeout(r, 2));
  });
  afterEach(() => { h.cleanup(); });

  test("new team starts with 0 unread peer messages", async () => {
    const result = await h.tools.orch_inbox.execute(
      { team: "ib", action: "count" },
      makeToolContext("lead-session")
    );
    expect(result).toBe("0 unread peer messages");
  });

  test("member→member DM shows as 1 unread peer message (singular)", async () => {
    const team = h.store.getTeamByName("ib")!;
    const alpha = h.store.getMemberByRole(team.id, "alpha")!;
    await h.tools.orch_message.execute(
      { team: "ib", to: "beta", content: "hi beta" },
      makeToolContext(alpha.sessionID)
    );
    const result = await h.tools.orch_inbox.execute(
      { team: "ib", action: "count" },
      makeToolContext("lead-session")
    );
    expect(result).toBe("1 unread peer message");
  });

  test("list returns unread messages in from → to format with age", async () => {
    const team = h.store.getTeamByName("ib")!;
    const alpha = h.store.getMemberByRole(team.id, "alpha")!;
    await h.tools.orch_message.execute(
      { team: "ib", to: "beta", content: "hello beta" },
      makeToolContext(alpha.sessionID)
    );
    const result = await h.tools.orch_inbox.execute(
      { team: "ib", action: "list" },
      makeToolContext("lead-session")
    );
    expect(result).toContain('Inbox for "ib" (1 unread)');
    expect(result).toContain("alpha → beta: hello beta");
    expect(result).toMatch(/\[\d+[smhd] ago\]/);
  });

  test("list --all returns the same messages after mark_read", async () => {
    const team = h.store.getTeamByName("ib")!;
    const alpha = h.store.getMemberByRole(team.id, "alpha")!;
    await h.tools.orch_message.execute(
      { team: "ib", to: "beta", content: "historic" },
      makeToolContext(alpha.sessionID)
    );
    await h.tools.orch_inbox.execute(
      { team: "ib", action: "mark_read" },
      makeToolContext("lead-session")
    );

    // Default list → nothing unread
    const unread = await h.tools.orch_inbox.execute(
      { team: "ib", action: "list" },
      makeToolContext("lead-session")
    );
    expect(unread).toContain("No unread peer messages");

    // list with all=true → historic message is still visible
    const all = await h.tools.orch_inbox.execute(
      { team: "ib", action: "list", all: true },
      makeToolContext("lead-session")
    );
    expect(all).toContain('Inbox for "ib" (1 total)');
    expect(all).toContain("alpha → beta: historic");
  });

  test("mark_read clears unread count and list reports empty", async () => {
    const team = h.store.getTeamByName("ib")!;
    const alpha = h.store.getMemberByRole(team.id, "alpha")!;
    await h.tools.orch_message.execute(
      { team: "ib", to: "beta", content: "m1" },
      makeToolContext(alpha.sessionID)
    );
    await h.tools.orch_message.execute(
      { team: "ib", to: "gamma", content: "m2" },
      makeToolContext(alpha.sessionID)
    );

    const marked = await h.tools.orch_inbox.execute(
      { team: "ib", action: "mark_read" },
      makeToolContext("lead-session")
    );
    expect(marked).toBe("Marked 2 messages as read");

    const count = await h.tools.orch_inbox.execute(
      { team: "ib", action: "count" },
      makeToolContext("lead-session")
    );
    expect(count).toBe("0 unread peer messages");

    const list = await h.tools.orch_inbox.execute(
      { team: "ib", action: "list" },
      makeToolContext("lead-session")
    );
    expect(list).toContain("No unread peer messages");
  });

  test("lead-originated DMs never appear in the inbox", async () => {
    // lead → alpha (not a peer message)
    await h.tools.orch_message.execute(
      { team: "ib", to: "alpha", content: "from the lead" },
      makeToolContext("lead-session")
    );
    const count = await h.tools.orch_inbox.execute(
      { team: "ib", action: "count" },
      makeToolContext("lead-session")
    );
    expect(count).toBe("0 unread peer messages");

    const list = await h.tools.orch_inbox.execute(
      { team: "ib", action: "list", all: true },
      makeToolContext("lead-session")
    );
    expect(list).toContain("Inbox is empty");
    expect(list).not.toContain("from the lead");
  });

  test("list with limit caps the result size", async () => {
    const team = h.store.getTeamByName("ib")!;
    const alpha = h.store.getMemberByRole(team.id, "alpha")!;
    for (const c of ["m1", "m2", "m3", "m4"]) {
      await h.tools.orch_message.execute(
        { team: "ib", to: "beta", content: c },
        makeToolContext(alpha.sessionID)
      );
    }
    const result = await h.tools.orch_inbox.execute(
      { team: "ib", action: "list", limit: 2 },
      makeToolContext("lead-session")
    );
    // Header reports 2 unread (the capped size), body has exactly 2 message rows
    expect(result).toContain("(2 unread)");
    const bodyLines = result.split("\n").filter((l) => l.trim().startsWith("["));
    expect(bodyLines).toHaveLength(2);
  });

  test("returns Error for non-existent team", async () => {
    const result = await h.tools.orch_inbox.execute(
      { team: "ghost", action: "count" },
      makeToolContext("lead-session")
    );
    expect(result).toBe('Error: Team "ghost" not found');
  });
});

// ─── orch_team ────────────────────────────────────────────────────────
describe("orch_team", () => {
  let h: Harness;
  beforeEach(async () => { h = await createHarness(); });
  afterEach(() => { h.cleanup(); });

  test("list returns sentinel string when there are no teams", async () => {
    const result = await h.tools.orch_team.execute(
      { action: "list" },
      makeToolContext("lead-session")
    );
    expect(result).toBe("No teams exist.");
  });

  test("list shows multiple teams with active/total and task counts", async () => {
    // Team A: 2 members, one shutdown, 2 tasks with 1 completed
    const teamA = h.manager.createTeam("alpha", "lead-session");
    await h.tools.orch_spawn.execute(
      { team: "alpha", role: "a1", instructions: "x" },
      makeToolContext("lead-session")
    );
    await h.tools.orch_spawn.execute(
      { team: "alpha", role: "a2", instructions: "x" },
      makeToolContext("lead-session")
    );
    const a2 = h.store.getMemberByRole(teamA.id, "a2")!;
    h.store.updateMember({ ...a2, state: "shutdown" });
    await h.tools.orch_tasks.execute(
      { team: "alpha", action: "add", title: "t1" },
      makeToolContext("lead-session")
    );
    await h.tools.orch_tasks.execute(
      { team: "alpha", action: "add", title: "t2" },
      makeToolContext("lead-session")
    );
    const [t1] = h.store.listTasks(teamA.id);
    const a1 = h.store.getMemberByRole(teamA.id, "a1")!;
    await h.tools.orch_tasks.execute(
      { team: "alpha", action: "claim", taskID: t1.id },
      makeToolContext(a1.sessionID)
    );
    await h.tools.orch_tasks.execute(
      { team: "alpha", action: "complete", taskID: t1.id, result: "ok" },
      makeToolContext(a1.sessionID)
    );

    // Team B: empty
    h.manager.createTeam("beta", "lead-session");

    const result = await h.tools.orch_team.execute(
      { action: "list" },
      makeToolContext("lead-session")
    );
    expect(result).toContain("2 teams:");
    expect(result).toContain("alpha  1/2 active  1/2 tasks done");
    expect(result).toContain("beta  0/0 active  0/0 tasks done");
  });

  test("list uses singular when there is exactly one team", async () => {
    h.manager.createTeam("only", "lead-session");
    const result = await h.tools.orch_team.execute(
      { action: "list" },
      makeToolContext("lead-session")
    );
    expect(result).toContain("1 team:");
    expect(result).not.toContain("1 teams:");
  });

  test("info shows id, lead session, created, config, members, tasks, messages", async () => {
    h.manager.createTeam("info-team", "lead-sess-xyz", { budgetLimit: 7.5 });
    await h.tools.orch_spawn.execute(
      { team: "info-team", role: "worker", instructions: "x" },
      makeToolContext("lead-sess-xyz")
    );
    await h.tools.orch_tasks.execute(
      { team: "info-team", action: "add", title: "t" },
      makeToolContext("lead-sess-xyz")
    );
    // Lead-to-member DM so total messages = 1, peer messages = 0
    await h.tools.orch_message.execute(
      { team: "info-team", to: "worker", content: "hi" },
      makeToolContext("lead-sess-xyz")
    );

    const result = await h.tools.orch_team.execute(
      { action: "info", team: "info-team" },
      makeToolContext("lead-sess-xyz")
    );
    expect(result).toContain("Team: info-team");
    expect(result).toMatch(/ID: team_/);
    expect(result).toContain("Lead session: lead-sess-xyz");
    expect(result).toMatch(/Created: \d{4}-\d{2}-\d{2}T/);
    expect(result).toContain("workStealing=true");
    expect(result).toContain("backpressure=50");
    expect(result).toContain("budget=$7.5");
    expect(result).toContain("Members: 1 (worker:initializing)");
    expect(result).toContain("Tasks: 1 (0 completed, 0 failed)");
    expect(result).toContain("Messages: 1 (0 peer)");
  });

  test("info without team arg returns error", async () => {
    const result = await h.tools.orch_team.execute(
      { action: "info" },
      makeToolContext("lead-session")
    );
    expect(result).toBe("Error: team is required for info action");
  });

  test("info with non-existent team returns error", async () => {
    const result = await h.tools.orch_team.execute(
      { action: "info", team: "ghost" },
      makeToolContext("lead-session")
    );
    expect(result).toBe('Error: Team "ghost" not found');
  });
});
