import { describe, it, expect, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  WorkflowDef,
  loadCustomWorkflows,
  renderTemplate,
} from "../src/workflows/loader.js";
import { WorkflowRegistry } from "../src/workflows/index.js";
import { tmpProject, rmrf } from "./_harness.js";

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmrf(d);
  dirs = [];
});

function tmp(): string {
  const d = tmpProject("orch-wf-test-");
  dirs.push(d);
  return d;
}

function writeCustom(dir: string, file: string, content: unknown): void {
  const wfDir = path.join(dir, ".opencode", "workflows");
  fs.mkdirSync(wfDir, { recursive: true });
  fs.writeFileSync(
    path.join(wfDir, file),
    typeof content === "string" ? content : JSON.stringify(content),
    "utf-8"
  );
}

const validChain = {
  name: "my-chain",
  description: "test chain",
  pattern: "chain",
  steps: [
    { id: "a", instructions: "do {{input}}" },
    { id: "b", instructions: "then {{output}}" },
  ],
};

describe("WorkflowDef zod validation", () => {
  it("accepts a valid definition", () => {
    const r = WorkflowDef.safeParse(validChain);
    expect(r.success).toBe(true);
  });

  it("rejects non-kebab-case names", () => {
    expect(WorkflowDef.safeParse({ ...validChain, name: "My_Chain" }).success).toBe(false);
  });

  it("rejects unknown patterns", () => {
    expect(WorkflowDef.safeParse({ ...validChain, pattern: "spiral" }).success).toBe(false);
  });

  it("rejects empty steps and duplicate step ids", () => {
    expect(WorkflowDef.safeParse({ ...validChain, steps: [] }).success).toBe(false);
    const dupe = {
      ...validChain,
      steps: [
        { id: "a", instructions: "x" },
        { id: "a", instructions: "y" },
      ],
    };
    const r = WorkflowDef.safeParse(dupe);
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues.map((i) => i.message).join(" ")).toContain("duplicate step ids");
    }
  });

  it("rejects routing without routes or with unknown route targets", () => {
    const noRoutes = { ...validChain, pattern: "routing" };
    expect(WorkflowDef.safeParse(noRoutes).success).toBe(false);

    const badTarget = {
      ...validChain,
      pattern: "routing",
      routes: { code: ["a", "nope"] },
    };
    const r = WorkflowDef.safeParse(badTarget);
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues.map((i) => i.message).join(" ")).toContain(
        'route "code" references unknown step "nope"'
      );
    }
  });

  it("rejects parallel/orchestrator without an aggregate step", () => {
    expect(WorkflowDef.safeParse({ ...validChain, pattern: "parallel" }).success).toBe(false);
    expect(
      WorkflowDef.safeParse({ ...validChain, pattern: "orchestrator" }).success
    ).toBe(false);
  });

  it("rejects evaluator with fewer than 2 steps", () => {
    const def = {
      ...validChain,
      pattern: "evaluator",
      steps: [{ id: "a", instructions: "x" }],
    };
    expect(WorkflowDef.safeParse(def).success).toBe(false);
  });

  it("rejects a step with neither instructions nor command", () => {
    const def = {
      ...validChain,
      steps: [{ id: "a" }, { id: "b", instructions: "x" }],
    };
    const r = WorkflowDef.safeParse(def);
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues.map((i) => i.message).join(" ")).toContain(
        "a step requires `instructions` or `command`"
      );
    }
  });

  it("accepts a command-only step", () => {
    const def = {
      ...validChain,
      steps: [
        { id: "a", command: "echo hi" },
        { id: "b", instructions: "got {{output}}" },
      ],
    };
    expect(WorkflowDef.safeParse(def).success).toBe(true);
  });

  it("accepts an evaluator with a gate but no critic step", () => {
    const def = {
      ...validChain,
      pattern: "evaluator",
      steps: [{ id: "a", instructions: "x" }],
      gate: { command: "npm test" },
    };
    expect(WorkflowDef.safeParse(def).success).toBe(true);
  });

  it("accepts IR v2 map and structured-output contracts", () => {
    const def = {
      version: 2,
      name: "map-records",
      description: "map records",
      pattern: "map",
      items: ["alpha", { id: 2 }],
      steps: [
        {
          id: "worker",
          instructions: "process {{index}} {{item}}",
          output: {
            schema: {
              type: "object",
              properties: { result: { type: "string" } },
              required: ["result"],
              additionalProperties: false,
            },
            retryCount: 2,
          },
        },
      ],
      aggregate: { id: "aggregate", instructions: "combine" },
    };
    const result = WorkflowDef.safeParse(def);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.steps[0].output?.retryCount).toBe(2);
  });

  it("keeps IR v2-only capabilities out of v1 definitions", () => {
    const structuredV1 = {
      ...validChain,
      version: 1,
      steps: [
        {
          id: "a",
          instructions: "x",
          output: { schema: { type: "string" }, retryCount: 0 },
        },
      ],
    };
    const result = WorkflowDef.safeParse(structuredV1);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((i) => i.message).join(" ")).toContain(
        "require workflow IR version 2"
      );
    }
  });

  it("requires map items, one worker template, and an aggregate", () => {
    const base = {
      version: 2,
      name: "bad-map",
      description: "bad map",
      pattern: "map",
      steps: [
        { id: "a", instructions: "a" },
        { id: "b", instructions: "b" },
      ],
    };
    const result = WorkflowDef.safeParse(base);
    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.error.issues.map((i) => i.message).join(" ");
      expect(messages).toContain("non-empty `items`");
      expect(messages).toContain("exactly one worker");
      expect(messages).toContain("require an `aggregate`");
    }
  });

  it("rejects aggregate ids that collide with static or dynamic workers", () => {
    const parallel = {
      ...validChain,
      pattern: "parallel",
      aggregate: { id: "a", instructions: "combine" },
    };
    const map = {
      version: 2,
      name: "colliding-map",
      description: "collision",
      pattern: "map",
      items: ["x"],
      steps: [{ id: "worker", instructions: "{{item}}" }],
      aggregate: { id: "worker-1", instructions: "combine" },
    };
    expect(WorkflowDef.safeParse(parallel).success).toBe(false);
    expect(WorkflowDef.safeParse(map).success).toBe(false);
  });

  it("rejects command map workers instead of interpolating data into a shell", () => {
    const result = WorkflowDef.safeParse({
      version: 2,
      name: "shell-map",
      description: "unsafe shell interpolation",
      pattern: "map",
      items: ["$(touch nope)"],
      steps: [{ id: "worker", command: "echo {{item}}" }],
      aggregate: { id: "aggregate", instructions: "combine" },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((i) => i.message).join(" ")).toContain(
        "shell interpolation of items is intentionally unsupported"
      );
    }
  });

  it("rejects unsupported schemas and command output retries", () => {
    const unsupported = {
      ...validChain,
      version: 2,
      steps: [
        {
          id: "a",
          instructions: "x",
          output: { schema: { $ref: "https://example.test/schema" }, retryCount: 0 },
        },
      ],
    };
    const commandRetry = {
      ...validChain,
      version: 2,
      steps: [
        {
          id: "a",
          command: "printf '{}'",
          output: { schema: { type: "object" } },
        },
      ],
    };
    expect(WorkflowDef.safeParse(unsupported).error?.issues[0]?.message).toContain("$ref");
    expect(WorkflowDef.safeParse(commandRetry).error?.issues[0]?.message).toContain(
      "cannot retry structured output"
    );
  });

  it("rejects an evaluator with neither a critic step nor a gate", () => {
    const def = {
      ...validChain,
      pattern: "evaluator",
      steps: [{ id: "a", instructions: "x" }],
    };
    const r = WorkflowDef.safeParse(def);
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues.map((i) => i.message).join(" ")).toContain(
        "critic step (steps[1]) or a `gate`"
      );
    }
  });
});

describe("v0.3 built-in workflows", () => {
  const reg = new WorkflowRegistry();

  it("adversarial-review: evaluator, generator + critic, maxIterations 4, no gate", () => {
    const def = reg.require("adversarial-review");
    expect(WorkflowDef.safeParse(def).success).toBe(true);
    expect(def.pattern).toBe("evaluator");
    expect(def.maxIterations).toBe(4);
    expect(def.gate).toBeUndefined();
    expect(def.steps.map((s) => s.id)).toEqual(["generator", "critic"]);
  });

  it("author-tests: orchestrator with worktree isolation and an aggregate step", () => {
    const def = reg.require("author-tests");
    expect(WorkflowDef.safeParse(def).success).toBe(true);
    expect(def.pattern).toBe("orchestrator");
    expect(def.isolation).toBe("worktree");
    expect(def.steps.map((s) => s.id)).toEqual(["planner"]);
    expect(def.aggregate).toBeDefined();
    expect(def.steps[0].instructions).toContain("Forbid tautologies");
  });

  it("test-fix-loop: gate-only evaluator, gate `npm test`, maxIterations 5", () => {
    const def = reg.require("test-fix-loop");
    expect(WorkflowDef.safeParse(def).success).toBe(true);
    expect(def.pattern).toBe("evaluator");
    expect(def.gate).toEqual({ command: "npm test" });
    expect(def.maxIterations).toBe(5);
    expect(def.steps.map((s) => s.id)).toEqual(["generator"]);
  });
});

describe("custom workflow loader", () => {
  it("loads valid JSON definitions from .opencode/workflows/", () => {
    const dir = tmp();
    writeCustom(dir, "mine.json", validChain);
    const { workflows, errors } = loadCustomWorkflows(dir);
    expect(errors).toEqual([]);
    expect(workflows.map((w) => w.name)).toEqual(["my-chain"]);
  });

  it("reports and skips invalid JSON and schema-invalid files", () => {
    const dir = tmp();
    writeCustom(dir, "broken.json", "{not json");
    writeCustom(dir, "bad-schema.json", { name: "BAD NAME", pattern: "chain", steps: [] });
    writeCustom(dir, "good.json", validChain);
    const { workflows, errors } = loadCustomWorkflows(dir);
    expect(workflows.map((w) => w.name)).toEqual(["my-chain"]);
    expect(errors.length).toBe(2);
    expect(errors[0]).toStartWith("bad-schema.json:");
    expect(errors[1]).toStartWith("broken.json:");
  });

  it("returns empty when the workflows dir does not exist", () => {
    const dir = tmp();
    const { workflows, errors } = loadCustomWorkflows(dir);
    expect(workflows).toEqual([]);
    expect(errors).toEqual([]);
  });

  it("validates and atomically saves versioned IR, with explicit shell opt-in", () => {
    const dir = tmp();
    const registry = new WorkflowRegistry();
    registry.loadCustom(dir);
    const saved = registry.save(validChain);
    expect(saved.def.version).toBe(1);
    expect(JSON.parse(fs.readFileSync(saved.path, "utf-8")).version).toBe(1);
    expect(registry.require("my-chain").version).toBe(1);
    expect(() => registry.save(validChain)).toThrow(/already exists/);

    const shell = {
      ...validChain,
      name: "shell-plan",
      steps: [{ id: "a", command: "echo safe" }],
    };
    expect(() => registry.save(shell)).toThrow(/allowShell=true/);
    expect(registry.save(shell, { allowShell: true }).def.name).toBe("shell-plan");
  });

  it("refuses symlinked workflow directories and files", () => {
    const dir = tmp();
    const elsewhere = tmp();
    fs.mkdirSync(path.join(dir, ".opencode"), { recursive: true });
    fs.symlinkSync(elsewhere, path.join(dir, ".opencode", "workflows"));
    const registry = new WorkflowRegistry();
    registry.loadCustom(dir);
    expect(registry.errors.join(" ")).toContain("symlinked workflow directories");
    expect(() => registry.save(validChain)).toThrow(/symlinked workflow directory/);
  });

  it("registry refuses custom defs that shadow a built-in name", () => {
    const dir = tmp();
    writeCustom(dir, "shadow.json", { ...validChain, name: "chain-draft-refine" });
    const reg = new WorkflowRegistry();
    reg.loadCustom(dir);
    expect(reg.errors.length).toBe(1);
    expect(reg.errors[0]).toContain("conflicts");
    // Built-in still intact.
    expect(reg.get("chain-draft-refine")!.description).toContain("prompt chain");
  });

  it("registry lists the 8 built-ins plus custom defs", () => {
    const dir = tmp();
    writeCustom(dir, "mine.json", validChain);
    const reg = new WorkflowRegistry();
    reg.loadCustom(dir);
    const names = reg.list().map((w) => w.def.name);
    expect(names).toContain("chain-draft-refine");
    expect(names).toContain("route-by-intent");
    expect(names).toContain("parallel-review");
    expect(names).toContain("orchestrate-tasks");
    expect(names).toContain("evaluator-loop");
    expect(names).toContain("adversarial-review");
    expect(names).toContain("author-tests");
    expect(names).toContain("test-fix-loop");
    expect(names).toContain("my-chain");
    expect(names.length).toBe(9);
    expect(reg.list().find((w) => w.def.name === "my-chain")!.custom).toBe(true);
    expect(() => reg.require("nope")).toThrow(/Workflow "nope" not found/);
  });
});

describe("renderTemplate", () => {
  it("renders {{input}}, {{output}}, {{feedback}}", () => {
    const out = renderTemplate("in={{input}} out={{output}} fb={{feedback}}", {
      input: "I",
      output: "O",
      feedback: "F",
    });
    expect(out).toBe("in=I out=O fb=F");
  });

  it("renders {{steps.<id>.output}} and empty string for unknown placeholders", () => {
    const out = renderTemplate(
      "a={{steps.a.output}} b={{steps.b.output}} miss={{output}}/{{feedback}}",
      { input: "", steps: { a: { output: "A" }, b: {} } }
    );
    expect(out).toBe("a=A b= miss=/");
  });

  it("replaces repeated occurrences", () => {
    expect(renderTemplate("{{input}} {{input}}", { input: "x" })).toBe("x x");
  });

  it("renders map item JSON and zero-based index", () => {
    expect(
      renderTemplate("{{index}}={{item}}", { input: "", index: 0, item: { id: 7 } })
    ).toBe('0={"id":7}');
    expect(renderTemplate("{{index}}={{item}}", { input: "", index: 1, item: "x" })).toBe(
      "1=x"
    );
  });
});
