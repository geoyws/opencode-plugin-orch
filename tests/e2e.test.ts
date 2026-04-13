// True end-to-end tests: spawn a real `opencode serve` process via
// @opencode-ai/sdk's createOpencode(), load this plugin via config, and
// verify tool registration, session creation, and event subscription
// against the real HTTP API. Complements the in-process integration tests
// that drive the plugin with a mock SDK client.
//
// The plugin must be BUILT before these tests run (dist/ must exist).
// `package.json` has a `prepare` script that runs `tsc`, and dist/ is
// checked before the suite starts.

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { createOpencode } from "@opencode-ai/sdk";
import type { OpencodeClient } from "@opencode-ai/sdk";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const PROJECT_ROOT = path.resolve(__dirname, "..");
const PLUGIN_PATH = path.join(PROJECT_ROOT, "dist", "index.js");
const DIST_EXISTS = fs.existsSync(PLUGIN_PATH);

// Plugin install + first-request bootstrap can easily exceed 60s on a cold
// cache (opencode installs peer plugins listed in the global user config
// the first time the server handles a request for a new project dir).
const BOOT_TIMEOUT_MS = 120_000;

const ORCH_TOOL_IDS = [
  "orch_create",
  "orch_spawn",
  "orch_message",
  "orch_broadcast",
  "orch_tasks",
  "orch_memo",
  "orch_status",
  "orch_shutdown",
  "orch_result",
] as const;

describe.skipIf(!DIST_EXISTS)("e2e: real opencode server with plugin loaded", () => {
  let server: { url: string; close(): void } | undefined;
  let client: OpencodeClient;
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-e2e-real-"));

    const result = await createOpencode({
      hostname: "127.0.0.1",
      port: 0,
      timeout: 30_000,
      config: {
        plugin: [PLUGIN_PATH],
      },
    });
    client = result.client;
    server = result.server;
  }, BOOT_TIMEOUT_MS);

  afterAll(() => {
    server?.close();
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("server exposes a reachable URL", () => {
    expect(server).toBeDefined();
    expect(server!.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });

  test(
    "orch_* tools are registered (plugin loaded into real server)",
    async () => {
      const res = await client.tool.ids({ query: { directory: tmpDir } });
      const ids = (res.data ?? []) as string[];

      for (const id of ORCH_TOOL_IDS) {
        expect(ids).toContain(id);
      }

      // Built-in tools should still be present alongside plugin tools.
      expect(ids).toContain("bash");
      expect(ids).toContain("read");
    },
    BOOT_TIMEOUT_MS,
  );

  test(
    "session.create round-trips through the real HTTP API",
    async () => {
      const res = await client.session.create({
        query: { directory: tmpDir },
        body: { title: "e2e-test-session" },
      });
      expect(res.data).toBeDefined();
      const session = res.data as { id?: string; title?: string };
      expect(session.id).toBeTruthy();
    },
    BOOT_TIMEOUT_MS,
  );

  test(
    "event stream endpoint is subscribable",
    async () => {
      // We don't need to consume events here — just confirm the endpoint
      // responds with an SSE stream and the connection can be torn down
      // cleanly. Using fetch directly keeps this test independent of
      // whatever SSE helper the SDK exposes.
      const controller = new AbortController();
      const res = await fetch(`${server!.url}/event`, {
        signal: controller.signal,
      });
      expect(res.ok).toBe(true);
      expect(res.headers.get("content-type") ?? "").toContain("text/event-stream");
      controller.abort();
      try {
        await res.body?.cancel();
      } catch {
        // aborted
      }
    },
    BOOT_TIMEOUT_MS,
  );
});
