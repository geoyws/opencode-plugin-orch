import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { createPermissionHook } from "../src/hooks/permissions.js";
import { createActivityHook } from "../src/hooks/activity-tracker.js";
import { TemplateRegistry } from "../src/templates/index.js";
import type { Member } from "../src/state/schemas.js";

// ── Helpers ──────────────────────────────────────────────────────────────

const fakeMember: Member = {
  id: "member-1",
  teamID: "team-1",
  sessionID: "member-session-1",
  role: "coder",
  state: "busy",
  instructions: "do stuff",
  files: [],
  escalationLevel: 0,
  retryCount: 0,
  createdAt: Date.now(),
};

function makePermission(overrides: Partial<{
  id: string;
  type: string;
  pattern: string | string[];
  sessionID: string;
  messageID: string;
  callID: string;
  title: string;
  metadata: Record<string, unknown>;
  time: { created: number };
}> = {}) {
  return {
    id: overrides.id ?? "perm-1",
    type: overrides.type ?? "bash",
    pattern: overrides.pattern ?? "",
    sessionID: overrides.sessionID ?? "member-session-1",
    messageID: overrides.messageID ?? "msg-1",
    title: overrides.title ?? "",
    metadata: overrides.metadata ?? {},
    time: overrides.time ?? { created: Date.now() },
  };
}

// ═════════════════════════════════════════════════════════════════════════
// 1. Permission hook — git safety
// ═════════════════════════════════════════════════════════════════════════

describe("createPermissionHook — git safety", () => {
  let hook: ReturnType<typeof createPermissionHook>;

  beforeEach(() => {
    const mockManager = {
      isMemberSession: (id: string) => id === "member-session-1",
      getMemberBySession: (id: string) =>
        id === "member-session-1" ? fakeMember : undefined,
    } as any;

    const mockFileLocks = {
      tryAcquire: () => ({ ok: true }),
    } as any;

    hook = createPermissionHook(mockManager, mockFileLocks);
  });

  // ── Mutating commands — DENY ───────────────────────────────────────

  const mutatingCommands = [
    "git commit -m 'test'",
    "git push origin main",
    "git push",
    "git pull",
    "git merge feature-branch",
    "git rebase main",
    "git checkout main",
    "git switch main",
    "git restore file.ts",
    "git reset --hard HEAD",
    "git reset HEAD~1",
    "git clean -fd",
    "git stash",
    "git stash pop",
    "git cherry-pick abc123",
    "git revert abc123",
    "git am 0001-patch.patch",
    "git apply patch.diff",
    "git branch -d feature",
    "git branch -D feature",
    "git branch -m old new",
    "git branch -M old new",
    "git tag -d v1.0",
  ];

  for (const cmd of mutatingCommands) {
    test(`DENY: ${cmd}`, async () => {
      const input = makePermission({
        title: cmd,
        metadata: { command: cmd },
      });
      const output = { status: "ask" as const };
      await hook(input, output);
      expect(output.status).toBe("deny");
    });
  }

  // ── Read-only commands — ALLOW ─────────────────────────────────────

  const readOnlyCommands = [
    "git status",
    "git log",
    "git log --oneline -20",
    "git diff",
    "git diff HEAD~1",
    "git show abc123",
    "git blame src/main.ts",
    "git branch",
    "git branch -a",
    "git branch -v",
    "git branch -r",
    "git tag",
    "git tag -l 'v*'",
    "git ls-files",
    "git rev-parse HEAD",
  ];

  for (const cmd of readOnlyCommands) {
    test(`ALLOW: ${cmd}`, async () => {
      const input = makePermission({
        title: cmd,
        metadata: { command: cmd },
      });
      const output = { status: "ask" as const };
      await hook(input, output);
      // Status should NOT be changed to "deny" — remains "ask"
      expect(output.status).toBe("ask");
    });
  }

  // ── Non-member sessions — NOT AFFECTED ─────────────────────────────

  test("non-member session: output is NOT modified", async () => {
    const input = makePermission({
      sessionID: "lead-session-99",
      title: "git push origin main",
      metadata: { command: "git push origin main" },
    });
    const output = { status: "ask" as const };
    await hook(input, output);
    expect(output.status).toBe("ask");
  });

  test("non-member session: git commit is allowed", async () => {
    const input = makePermission({
      sessionID: "external-session",
      title: "git commit -m 'deploy'",
      metadata: { command: "git commit -m 'deploy'" },
    });
    const output = { status: "allow" as const };
    await hook(input, output);
    expect(output.status).toBe("allow");
  });

  // ── Edge cases ─────────────────────────────────────────────────────

  test("command extracted from metadata.bash when metadata.command is absent", async () => {
    const input = makePermission({
      metadata: { bash: "git push origin main" },
    });
    const output = { status: "ask" as const };
    await hook(input, output);
    expect(output.status).toBe("deny");
  });

  test("command extracted from pattern when metadata is empty", async () => {
    const input = makePermission({
      pattern: "git commit -m 'hello'",
      metadata: {},
    });
    const output = { status: "ask" as const };
    await hook(input, output);
    expect(output.status).toBe("deny");
  });

  test("command extracted from pattern array", async () => {
    const input = makePermission({
      pattern: ["git merge dev", "other"],
      metadata: {},
    });
    const output = { status: "ask" as const };
    await hook(input, output);
    expect(output.status).toBe("deny");
  });

  test("command falls back to title when metadata is empty and pattern is undefined", async () => {
    // NOTE: nullish coalescing (??) only skips null/undefined, not empty string.
    // So pattern must be undefined (not "") for the title fallback to activate.
    const input = makePermission({
      title: "git rebase main",
      metadata: {},
    });
    // Override pattern to undefined so ?? falls through to title
    (input as any).pattern = undefined;
    const output = { status: "ask" as const };
    await hook(input, output);
    expect(output.status).toBe("deny");
  });

  test("empty string pattern does NOT fall through to title (nullish coalescing)", async () => {
    const input = makePermission({
      title: "git rebase main",
      pattern: "",
      metadata: {},
    });
    const output = { status: "ask" as const };
    await hook(input, output);
    // Empty string pattern is used as command (not null/undefined), so title is not checked
    expect(output.status).toBe("ask");
  });

  test("non-git command is not denied", async () => {
    const input = makePermission({
      title: "rm -rf /tmp/test",
      metadata: { command: "rm -rf /tmp/test" },
    });
    const output = { status: "ask" as const };
    await hook(input, output);
    expect(output.status).toBe("ask");
  });

  test("partial git word does not trigger deny (e.g. 'gitter commit')", async () => {
    const input = makePermission({
      metadata: { command: "gitter commit" },
    });
    const output = { status: "ask" as const };
    await hook(input, output);
    expect(output.status).toBe("ask");
  });

  test("git branch (list, no flags) is allowed", async () => {
    // The regex /\bgit\s+branch\s*$/ should match "git branch" exactly
    const input = makePermission({
      metadata: { command: "git branch" },
    });
    const output = { status: "ask" as const };
    await hook(input, output);
    expect(output.status).toBe("ask");
  });

  test("git tag (list, no flags) is allowed", async () => {
    const input = makePermission({
      metadata: { command: "git tag" },
    });
    const output = { status: "ask" as const };
    await hook(input, output);
    expect(output.status).toBe("ask");
  });
});

// ═════════════════════════════════════════════════════════════════════════
// 2. Permission hook — file lock enforcement
// ═════════════════════════════════════════════════════════════════════════

describe("createPermissionHook — file lock enforcement", () => {
  test("DENY write when another member holds the lock", async () => {
    const mockManager = {
      isMemberSession: (id: string) => id === "member-session-1",
      getMemberBySession: (id: string) =>
        id === "member-session-1" ? fakeMember : undefined,
    } as any;

    const mockFileLocks = {
      tryAcquire: (_path: string, _memberID: string, _teamID: string) => ({
        ok: false,
        holder: "other-coder",
      }),
    } as any;

    const hook = createPermissionHook(mockManager, mockFileLocks);

    const input = makePermission({
      type: "write",
      metadata: { path: "/src/index.ts" },
    });
    const output = { status: "ask" as const };
    await hook(input, output);
    expect(output.status).toBe("deny");
  });

  test("ALLOW write when no lock conflict", async () => {
    const mockManager = {
      isMemberSession: (id: string) => id === "member-session-1",
      getMemberBySession: (id: string) =>
        id === "member-session-1" ? fakeMember : undefined,
    } as any;

    const mockFileLocks = {
      tryAcquire: () => ({ ok: true }),
    } as any;

    const hook = createPermissionHook(mockManager, mockFileLocks);

    const input = makePermission({
      type: "write",
      metadata: { path: "/src/index.ts" },
    });
    const output = { status: "ask" as const };
    await hook(input, output);
    expect(output.status).toBe("ask");
  });

  test("DENY edit when another member holds the lock", async () => {
    const mockManager = {
      isMemberSession: (id: string) => id === "member-session-1",
      getMemberBySession: (id: string) =>
        id === "member-session-1" ? fakeMember : undefined,
    } as any;

    const mockFileLocks = {
      tryAcquire: () => ({ ok: false, holder: "architect" }),
    } as any;

    const hook = createPermissionHook(mockManager, mockFileLocks);

    const input = makePermission({
      type: "edit",
      metadata: { path: "/src/utils.ts" },
    });
    const output = { status: "ask" as const };
    await hook(input, output);
    expect(output.status).toBe("deny");
  });

  test("ALLOW edit when lock acquired successfully", async () => {
    const mockManager = {
      isMemberSession: (id: string) => id === "member-session-1",
      getMemberBySession: (id: string) =>
        id === "member-session-1" ? fakeMember : undefined,
    } as any;

    const mockFileLocks = {
      tryAcquire: () => ({ ok: true }),
    } as any;

    const hook = createPermissionHook(mockManager, mockFileLocks);

    const input = makePermission({
      type: "edit",
      metadata: { path: "/src/utils.ts" },
    });
    const output = { status: "ask" as const };
    await hook(input, output);
    expect(output.status).toBe("ask");
  });

  test("file path extracted from pattern when metadata.path is absent", async () => {
    const mockManager = {
      isMemberSession: (id: string) => id === "member-session-1",
      getMemberBySession: (id: string) =>
        id === "member-session-1" ? fakeMember : undefined,
    } as any;

    const mockFileLocks = {
      tryAcquire: () => ({ ok: false, holder: "reviewer" }),
    } as any;

    const hook = createPermissionHook(mockManager, mockFileLocks);

    const input = makePermission({
      type: "write",
      pattern: "/src/main.ts",
      metadata: {},
    });
    const output = { status: "ask" as const };
    await hook(input, output);
    expect(output.status).toBe("deny");
  });

  test("tryAcquire receives correct memberID and teamID", async () => {
    let capturedArgs: { path: string; memberID: string; teamID: string } | null = null;

    const mockManager = {
      isMemberSession: (id: string) => id === "member-session-1",
      getMemberBySession: (id: string) =>
        id === "member-session-1" ? fakeMember : undefined,
    } as any;

    const mockFileLocks = {
      tryAcquire: (filePath: string, memberID: string, teamID: string) => {
        capturedArgs = { path: filePath, memberID, teamID };
        return { ok: true };
      },
    } as any;

    const hook = createPermissionHook(mockManager, mockFileLocks);

    const input = makePermission({
      type: "write",
      metadata: { path: "/src/foo.ts" },
    });
    const output = { status: "ask" as const };
    await hook(input, output);

    expect(capturedArgs).not.toBeNull();
    expect(capturedArgs!.path).toBe("/src/foo.ts");
    expect(capturedArgs!.memberID).toBe("member-1");
    expect(capturedArgs!.teamID).toBe("team-1");
  });

  test("non-write/edit type does NOT check file locks", async () => {
    let lockCalled = false;

    const mockManager = {
      isMemberSession: (id: string) => id === "member-session-1",
      getMemberBySession: (id: string) =>
        id === "member-session-1" ? fakeMember : undefined,
    } as any;

    const mockFileLocks = {
      tryAcquire: () => {
        lockCalled = true;
        return { ok: false, holder: "someone" };
      },
    } as any;

    const hook = createPermissionHook(mockManager, mockFileLocks);

    const input = makePermission({
      type: "read",
      metadata: { path: "/src/foo.ts" },
    });
    const output = { status: "ask" as const };
    await hook(input, output);

    expect(lockCalled).toBe(false);
    expect(output.status).toBe("ask");
  });

  test("write with no file path does NOT check file locks", async () => {
    let lockCalled = false;

    const mockManager = {
      isMemberSession: (id: string) => id === "member-session-1",
      getMemberBySession: (id: string) =>
        id === "member-session-1" ? fakeMember : undefined,
    } as any;

    const mockFileLocks = {
      tryAcquire: () => {
        lockCalled = true;
        return { ok: false, holder: "someone" };
      },
    } as any;

    const hook = createPermissionHook(mockManager, mockFileLocks);

    const input = makePermission({
      type: "write",
      pattern: "",
      metadata: {},
    });
    const output = { status: "ask" as const };
    await hook(input, output);

    expect(lockCalled).toBe(false);
    expect(output.status).toBe("ask");
  });
});

// ═════════════════════════════════════════════════════════════════════════
// 3. Permission hook — combined: git check runs before file lock check
// ═════════════════════════════════════════════════════════════════════════

describe("createPermissionHook — ordering", () => {
  test("git mutating command is denied even for write type (git check runs first)", async () => {
    const mockManager = {
      isMemberSession: (id: string) => id === "member-session-1",
      getMemberBySession: (id: string) =>
        id === "member-session-1" ? fakeMember : undefined,
    } as any;

    const mockFileLocks = {
      tryAcquire: () => ({ ok: true }),
    } as any;

    const hook = createPermissionHook(mockManager, mockFileLocks);

    const input = makePermission({
      type: "bash",
      metadata: { command: "git push origin main" },
    });
    const output = { status: "ask" as const };
    await hook(input, output);
    expect(output.status).toBe("deny");
  });

  test("getMemberBySession returning undefined short-circuits (no error)", async () => {
    const mockManager = {
      isMemberSession: (id: string) => id === "member-session-1",
      getMemberBySession: () => undefined,
    } as any;

    const mockFileLocks = {
      tryAcquire: () => ({ ok: true }),
    } as any;

    const hook = createPermissionHook(mockManager, mockFileLocks);

    const input = makePermission({
      metadata: { command: "git push" },
    });
    const output = { status: "ask" as const };
    await hook(input, output);
    // isMemberSession returns true but getMemberBySession returns undefined,
    // so the hook returns early without modifying output
    expect(output.status).toBe("ask");
  });
});

// ═════════════════════════════════════════════════════════════════════════
// 3b. Permission hook — safety: internal throws must never crash
// ═════════════════════════════════════════════════════════════════════════

describe("createPermissionHook — safety wrapper", () => {
  let tmpDir: string;
  let origCwd: string;

  beforeEach(() => {
    origCwd = process.cwd();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-safe-perm-"));
    process.chdir(tmpDir);
  });

  afterEach(() => {
    process.chdir(origCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("throwing getMemberBySession does NOT throw out of the hook and leaves status unchanged", async () => {
    const mockManager = {
      isMemberSession: () => true,
      getMemberBySession: () => {
        throw new Error("boom manager");
      },
    } as any;
    const mockFileLocks = { tryAcquire: () => ({ ok: true }) } as any;
    const hook = createPermissionHook(mockManager, mockFileLocks);

    const input = makePermission({ metadata: { command: "git push" } });
    const output = { status: "ask" as const };

    // Must not throw
    await hook(input, output);
    // Status unchanged — default "ask" is the safe fallback
    expect(output.status).toBe("ask");
  });

  test("throwing fileLocks.tryAcquire does NOT throw and leaves status unchanged", async () => {
    const mockManager = {
      isMemberSession: () => true,
      getMemberBySession: () => fakeMember,
    } as any;
    const mockFileLocks = {
      tryAcquire: () => {
        throw new Error("lock explode");
      },
    } as any;
    const hook = createPermissionHook(mockManager, mockFileLocks);

    const input = makePermission({
      type: "write",
      metadata: { path: "/src/index.ts" },
    });
    const output = { status: "ask" as const };

    await hook(input, output);
    expect(output.status).toBe("ask");
  });

  test("an internal throw writes to .opencode/plugin-orch/hooks.log", async () => {
    const mockManager = {
      isMemberSession: () => true,
      getMemberBySession: () => {
        throw new Error("boom for log");
      },
    } as any;
    const mockFileLocks = { tryAcquire: () => ({ ok: true }) } as any;
    const hook = createPermissionHook(mockManager, mockFileLocks);

    await hook(makePermission({ metadata: { command: "git push" } }), {
      status: "ask",
    });

    const logPath = path.join(tmpDir, ".opencode", "plugin-orch", "hooks.log");
    expect(fs.existsSync(logPath)).toBe(true);
    const contents = fs.readFileSync(logPath, "utf8");
    expect(contents).toContain("permission.ask");
    expect(contents).toContain("boom for log");
  });

  test("a denied git push is NOT silently allowed after a throw (status stays 'ask', never 'allow')", async () => {
    // Throw *before* the git check runs, to simulate an unexpected error.
    const mockManager = {
      isMemberSession: () => {
        throw new Error("isMemberSession exploded");
      },
      getMemberBySession: () => fakeMember,
    } as any;
    const mockFileLocks = { tryAcquire: () => ({ ok: true }) } as any;
    const hook = createPermissionHook(mockManager, mockFileLocks);

    const input = makePermission({ metadata: { command: "git push origin main" } });
    const output: { status: "ask" | "deny" | "allow" } = { status: "ask" };
    await hook(input, output);

    // Crucially — we must NOT have upgraded status to "allow"
    expect(output.status).not.toBe("allow");
    expect(output.status).toBe("ask");
  });
});

// ═════════════════════════════════════════════════════════════════════════
// 4. Template registry
// ═════════════════════════════════════════════════════════════════════════

describe("TemplateRegistry", () => {
  let registry: TemplateRegistry;

  beforeEach(() => {
    registry = new TemplateRegistry();
  });

  test("built-in templates are loaded on construction", () => {
    const names = registry.list();
    expect(names).toContain("code-review");
    expect(names).toContain("feature-build");
    expect(names).toContain("debug-squad");
  });

  test("list() returns exactly 3 built-in templates", () => {
    expect(registry.list().length).toBe(3);
  });

  test("get() returns code-review template with correct structure", () => {
    const tmpl = registry.get("code-review");
    expect(tmpl).toBeDefined();
    expect(tmpl!.name).toBe("code-review");
    expect(tmpl!.description).toContain("Review");
    expect(tmpl!.members.length).toBe(2);
    expect(tmpl!.members[0].role).toBe("reviewer");
    expect(tmpl!.members[1].role).toBe("fixer");
  });

  test("get() returns feature-build template with correct member count", () => {
    const tmpl = registry.get("feature-build");
    expect(tmpl).toBeDefined();
    expect(tmpl!.name).toBe("feature-build");
    expect(tmpl!.members.length).toBe(4);
    const roles = tmpl!.members.map((m) => m.role);
    expect(roles).toContain("architect");
    expect(roles).toContain("coder-1");
    expect(roles).toContain("coder-2");
    expect(roles).toContain("tester");
  });

  test("get() returns debug-squad template with correct member count", () => {
    const tmpl = registry.get("debug-squad");
    expect(tmpl).toBeDefined();
    expect(tmpl!.name).toBe("debug-squad");
    expect(tmpl!.members.length).toBe(3);
    const roles = tmpl!.members.map((m) => m.role);
    expect(roles).toContain("investigator");
    expect(roles).toContain("fixer");
    expect(roles).toContain("verifier");
  });

  test("get() returns undefined for unknown template", () => {
    expect(registry.get("nonexistent")).toBeUndefined();
    expect(registry.get("")).toBeUndefined();
  });

  test("register() adds a custom template", () => {
    registry.register({
      name: "my-custom",
      description: "A custom template",
      members: [
        { role: "lead", instructions: "Lead the work" },
        { role: "worker", instructions: "Do the work" },
      ],
    });

    expect(registry.list()).toContain("my-custom");
    expect(registry.list().length).toBe(4);

    const tmpl = registry.get("my-custom");
    expect(tmpl).toBeDefined();
    expect(tmpl!.members.length).toBe(2);
    expect(tmpl!.members[0].role).toBe("lead");
  });

  test("register() overwrites existing template with same name", () => {
    registry.register({
      name: "code-review",
      description: "Overwritten template",
      members: [{ role: "solo-reviewer", instructions: "Review alone" }],
    });

    const tmpl = registry.get("code-review");
    expect(tmpl!.description).toBe("Overwritten template");
    expect(tmpl!.members.length).toBe(1);
    // Total count should stay the same
    expect(registry.list().length).toBe(3);
  });

  test("template members have agent field set", () => {
    const cr = registry.get("code-review")!;
    expect(cr.members[0].agent).toBe("plan");
    expect(cr.members[1].agent).toBe("code");

    const fb = registry.get("feature-build")!;
    expect(fb.members[0].agent).toBe("plan");
    expect(fb.members[1].agent).toBe("code");
  });
});

// ═════════════════════════════════════════════════════════════════════════
// 5. Template registry — loadCustomTemplates
// ═════════════════════════════════════════════════════════════════════════

describe("TemplateRegistry.loadCustomTemplates", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("loads JSON template from custom directory", async () => {
    const templatesDir = path.join(tmpDir, ".opencode", "plugin-orch", "templates");
    fs.mkdirSync(templatesDir, { recursive: true });

    const customTemplate = {
      name: "custom-deploy",
      description: "Deployment pipeline",
      members: [
        { role: "deployer", instructions: "Deploy the app" },
        { role: "monitor", instructions: "Monitor the deploy" },
      ],
    };
    fs.writeFileSync(
      path.join(templatesDir, "deploy.json"),
      JSON.stringify(customTemplate)
    );

    const registry = new TemplateRegistry();
    await registry.loadCustomTemplates(tmpDir);

    expect(registry.list()).toContain("custom-deploy");
    const tmpl = registry.get("custom-deploy");
    expect(tmpl).toBeDefined();
    expect(tmpl!.members.length).toBe(2);
    expect(tmpl!.members[0].role).toBe("deployer");
  });

  test("loads multiple JSON templates from custom directory", async () => {
    const templatesDir = path.join(tmpDir, ".opencode", "plugin-orch", "templates");
    fs.mkdirSync(templatesDir, { recursive: true });

    fs.writeFileSync(
      path.join(templatesDir, "a.json"),
      JSON.stringify({ name: "tmpl-a", description: "A", members: [{ role: "r", instructions: "i" }] })
    );
    fs.writeFileSync(
      path.join(templatesDir, "b.json"),
      JSON.stringify({ name: "tmpl-b", description: "B", members: [{ role: "r", instructions: "i" }] })
    );

    const registry = new TemplateRegistry();
    await registry.loadCustomTemplates(tmpDir);

    expect(registry.list()).toContain("tmpl-a");
    expect(registry.list()).toContain("tmpl-b");
    // 3 built-in + 2 custom
    expect(registry.list().length).toBe(5);
  });

  test("skips invalid JSON files gracefully", async () => {
    const templatesDir = path.join(tmpDir, ".opencode", "plugin-orch", "templates");
    fs.mkdirSync(templatesDir, { recursive: true });

    fs.writeFileSync(path.join(templatesDir, "bad.json"), "not valid json!!!");
    fs.writeFileSync(
      path.join(templatesDir, "good.json"),
      JSON.stringify({ name: "good-tmpl", description: "G", members: [{ role: "r", instructions: "i" }] })
    );

    const registry = new TemplateRegistry();
    await registry.loadCustomTemplates(tmpDir);

    expect(registry.list()).toContain("good-tmpl");
    expect(registry.get("bad")).toBeUndefined();
  });

  test("skips JSON files missing required fields (name or members)", async () => {
    const templatesDir = path.join(tmpDir, ".opencode", "plugin-orch", "templates");
    fs.mkdirSync(templatesDir, { recursive: true });

    // Missing members
    fs.writeFileSync(
      path.join(templatesDir, "no-members.json"),
      JSON.stringify({ name: "no-members", description: "D" })
    );
    // Missing name
    fs.writeFileSync(
      path.join(templatesDir, "no-name.json"),
      JSON.stringify({ description: "D", members: [] })
    );

    const registry = new TemplateRegistry();
    await registry.loadCustomTemplates(tmpDir);

    expect(registry.get("no-members")).toBeUndefined();
    // 3 built-in only
    expect(registry.list().length).toBe(3);
  });

  test("does nothing when templates directory does not exist", async () => {
    const registry = new TemplateRegistry();
    // tmpDir exists but .opencode/plugin-orch/templates does not
    await registry.loadCustomTemplates(tmpDir);
    expect(registry.list().length).toBe(3);
  });

  test("ignores non-JSON files in templates directory", async () => {
    const templatesDir = path.join(tmpDir, ".opencode", "plugin-orch", "templates");
    fs.mkdirSync(templatesDir, { recursive: true });

    fs.writeFileSync(path.join(templatesDir, "readme.txt"), "not a template");
    fs.writeFileSync(path.join(templatesDir, "template.yaml"), "name: yaml-tmpl");

    const registry = new TemplateRegistry();
    await registry.loadCustomTemplates(tmpDir);

    expect(registry.list().length).toBe(3);
  });
});

// ═════════════════════════════════════════════════════════════════════════
// 6. Activity tracker hook
// ═════════════════════════════════════════════════════════════════════════

describe("createActivityHook", () => {
  test("records activity for member session tool call", async () => {
    let recorded: { memberID: string; tool: string; target: string } | null = null;

    const mockManager = {
      getMemberBySession: (id: string) =>
        id === "member-session-1" ? fakeMember : undefined,
    } as any;

    const mockTracker = {
      record: (memberID: string, tool: string, target: string) => {
        recorded = { memberID, tool, target };
      },
    } as any;

    const hook = createActivityHook(mockManager, mockTracker);

    const input = {
      tool: "bash",
      sessionID: "member-session-1",
      callID: "call-1",
      args: { command: "ls -la" },
    };
    const output = { title: "bash", output: "file list", metadata: {} };

    await hook(input, output);

    expect(recorded).not.toBeNull();
    expect(recorded!.memberID).toBe("member-1");
    expect(recorded!.tool).toBe("bash");
    expect(recorded!.target).toBe("ls -la");
  });

  test("does NOT record activity for non-member session", async () => {
    let recorded = false;

    const mockManager = {
      getMemberBySession: () => undefined,
    } as any;

    const mockTracker = {
      record: () => {
        recorded = true;
      },
    } as any;

    const hook = createActivityHook(mockManager, mockTracker);

    await hook(
      { tool: "bash", sessionID: "external-session", callID: "call-2", args: { command: "pwd" } },
      { title: "bash", output: "/home", metadata: {} }
    );

    expect(recorded).toBe(false);
  });

  test("extracts file_path from args", async () => {
    let capturedTarget = "";

    const mockManager = {
      getMemberBySession: (id: string) =>
        id === "member-session-1" ? fakeMember : undefined,
    } as any;

    const mockTracker = {
      record: (_id: string, _tool: string, target: string) => {
        capturedTarget = target;
      },
    } as any;

    const hook = createActivityHook(mockManager, mockTracker);

    await hook(
      { tool: "write", sessionID: "member-session-1", callID: "call-3", args: { file_path: "/src/index.ts" } },
      { title: "write", output: "ok", metadata: {} }
    );

    expect(capturedTarget).toBe("/src/index.ts");
  });

  test("extracts path from args when file_path is absent", async () => {
    let capturedTarget = "";

    const mockManager = {
      getMemberBySession: (id: string) =>
        id === "member-session-1" ? fakeMember : undefined,
    } as any;

    const mockTracker = {
      record: (_id: string, _tool: string, target: string) => {
        capturedTarget = target;
      },
    } as any;

    const hook = createActivityHook(mockManager, mockTracker);

    await hook(
      { tool: "read", sessionID: "member-session-1", callID: "call-4", args: { path: "/src/config.ts" } },
      { title: "read", output: "file content", metadata: {} }
    );

    expect(capturedTarget).toBe("/src/config.ts");
  });

  test("extracts pattern from args as fallback", async () => {
    let capturedTarget = "";

    const mockManager = {
      getMemberBySession: (id: string) =>
        id === "member-session-1" ? fakeMember : undefined,
    } as any;

    const mockTracker = {
      record: (_id: string, _tool: string, target: string) => {
        capturedTarget = target;
      },
    } as any;

    const hook = createActivityHook(mockManager, mockTracker);

    await hook(
      { tool: "grep", sessionID: "member-session-1", callID: "call-5", args: { pattern: "TODO" } },
      { title: "grep", output: "matches", metadata: {} }
    );

    expect(capturedTarget).toBe("TODO");
  });

  test("truncates long bash commands to 40 chars (37 + ...)", async () => {
    let capturedTarget = "";

    const mockManager = {
      getMemberBySession: (id: string) =>
        id === "member-session-1" ? fakeMember : undefined,
    } as any;

    const mockTracker = {
      record: (_id: string, _tool: string, target: string) => {
        capturedTarget = target;
      },
    } as any;

    const hook = createActivityHook(mockManager, mockTracker);

    const longCommand = "find /root/work/src -name '*.ts' -exec grep -l 'TODO' {} +";
    await hook(
      { tool: "bash", sessionID: "member-session-1", callID: "call-6", args: { command: longCommand } },
      { title: "bash", output: "results", metadata: {} }
    );

    expect(capturedTarget.length).toBe(40);
    expect(capturedTarget.endsWith("...")).toBe(true);
    expect(capturedTarget).toBe(longCommand.slice(0, 37) + "...");
  });

  test("does NOT truncate short bash commands", async () => {
    let capturedTarget = "";

    const mockManager = {
      getMemberBySession: (id: string) =>
        id === "member-session-1" ? fakeMember : undefined,
    } as any;

    const mockTracker = {
      record: (_id: string, _tool: string, target: string) => {
        capturedTarget = target;
      },
    } as any;

    const hook = createActivityHook(mockManager, mockTracker);

    await hook(
      { tool: "bash", sessionID: "member-session-1", callID: "call-7", args: { command: "ls -la" } },
      { title: "bash", output: "output", metadata: {} }
    );

    expect(capturedTarget).toBe("ls -la");
  });

  test("does NOT truncate long commands for non-bash tools", async () => {
    let capturedTarget = "";

    const mockManager = {
      getMemberBySession: (id: string) =>
        id === "member-session-1" ? fakeMember : undefined,
    } as any;

    const mockTracker = {
      record: (_id: string, _tool: string, target: string) => {
        capturedTarget = target;
      },
    } as any;

    const hook = createActivityHook(mockManager, mockTracker);

    const longPath = "/very/long/path/that/exceeds/forty/characters/src/index.ts";
    await hook(
      { tool: "write", sessionID: "member-session-1", callID: "call-8", args: { file_path: longPath } },
      { title: "write", output: "ok", metadata: {} }
    );

    expect(capturedTarget).toBe(longPath);
  });

  test("handles null args gracefully", async () => {
    let capturedTarget = "";

    const mockManager = {
      getMemberBySession: (id: string) =>
        id === "member-session-1" ? fakeMember : undefined,
    } as any;

    const mockTracker = {
      record: (_id: string, _tool: string, target: string) => {
        capturedTarget = target;
      },
    } as any;

    const hook = createActivityHook(mockManager, mockTracker);

    await hook(
      { tool: "unknown", sessionID: "member-session-1", callID: "call-9", args: null },
      { title: "unknown", output: "", metadata: {} }
    );

    expect(capturedTarget).toBe("");
  });

  test("swallows internal errors and logs to hooks.log", async () => {
    const origCwd = process.cwd();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "orch-safe-act-"));
    process.chdir(tmp);
    try {
      const mockManager = {
        getMemberBySession: () => {
          throw new Error("boom activity");
        },
      } as any;

      const mockTracker = {
        record: () => {
          throw new Error("should not be called");
        },
      } as any;

      const hook = createActivityHook(mockManager, mockTracker);

      // Must not throw
      await hook(
        { tool: "bash", sessionID: "s", callID: "c", args: { command: "ls" } },
        { title: "bash", output: "", metadata: {} }
      );

      const logPath = path.join(tmp, ".opencode", "plugin-orch", "hooks.log");
      expect(fs.existsSync(logPath)).toBe(true);
      const contents = fs.readFileSync(logPath, "utf8");
      expect(contents).toContain("tool.execute.after");
      expect(contents).toContain("boom activity");
    } finally {
      process.chdir(origCwd);
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("handles empty args object gracefully", async () => {
    let capturedTarget = "";

    const mockManager = {
      getMemberBySession: (id: string) =>
        id === "member-session-1" ? fakeMember : undefined,
    } as any;

    const mockTracker = {
      record: (_id: string, _tool: string, target: string) => {
        capturedTarget = target;
      },
    } as any;

    const hook = createActivityHook(mockManager, mockTracker);

    await hook(
      { tool: "unknown", sessionID: "member-session-1", callID: "call-10", args: {} },
      { title: "unknown", output: "", metadata: {} }
    );

    expect(capturedTarget).toBe("");
  });
});
