// Centralized error/event reporting for the plugin.
//
// Surfaces issues in three places, in order of preference:
//   1. opencode TUI toast (immediately visible to the user)
//   2. opencode app.log (persisted to ~/.local/share/opencode/log/*.log)
//   3. local file at .opencode/plugin-orch/init.log (last resort, survives
//      even if opencode can't accept HTTP requests yet)
//
// All methods are fire-and-forget — they swallow their own errors so the
// reporter itself can never crash the host plugin.

import * as fs from "node:fs";
import * as path from "node:path";

type Variant = "info" | "success" | "warning" | "error";

interface ReporterClient {
  tui: {
    showToast(params: {
      body?: { title?: string; message: string; variant: Variant; duration?: number };
    }): unknown;
  };
  app: {
    log(params: {
      body?: { service: string; level: "debug" | "info" | "error" | "warn"; message: string };
    }): unknown;
  };
}

export class Reporter {
  private logPath: string;

  constructor(
    private client: ReporterClient,
    projectDir: string
  ) {
    this.logPath = path.join(projectDir, ".opencode", "plugin-orch", "init.log");
  }

  /** Report a normal informational event. */
  info(title: string, message: string): void {
    this.toast(title, message, "info");
    this.appLog("info", `${title} ${message}`);
    this.fileLog("INFO", title, message);
  }

  /** Report a positive event (e.g. successful init). */
  success(title: string, message: string): void {
    this.toast(title, message, "success");
    this.appLog("info", `${title} ${message}`);
    this.fileLog("OK", title, message);
  }

  /** Report a non-fatal warning. */
  warn(title: string, message: string): void {
    this.toast(title, message, "warning");
    this.appLog("warn", `${title} ${message}`);
    this.fileLog("WARN", title, message);
  }

  /** Report a failure. The user should see this. */
  error(title: string, error: unknown): void {
    const message = formatError(error);
    this.toast(title, message, "error");
    this.appLog("error", `${title} ${message}`);
    this.fileLog("ERROR", title, message);
  }

  // ── Internal sinks ─────────────────────────────────────────────
  private toast(title: string, message: string, variant: Variant): void {
    try {
      const result = this.client.tui.showToast({
        body: { title, message, variant, duration: variant === "error" ? 8000 : 3000 },
      });
      // showToast returns a thenable — swallow rejections
      if (result && typeof (result as Promise<unknown>).catch === "function") {
        (result as Promise<unknown>).catch(() => {});
      }
    } catch {
      // TUI not available — fall through to the other sinks
    }
  }

  private appLog(level: "info" | "warn" | "error", message: string): void {
    try {
      const result = this.client.app.log({
        body: { service: "opencode-plugin-orch", level, message },
      });
      if (result && typeof (result as Promise<unknown>).catch === "function") {
        (result as Promise<unknown>).catch(() => {});
      }
    } catch {
      // app.log not available
    }
  }

  private fileLog(level: string, title: string, message: string): void {
    try {
      fs.mkdirSync(path.dirname(this.logPath), { recursive: true });
      const ts = new Date().toISOString();
      fs.appendFileSync(this.logPath, `[${ts}] ${level} ${title}: ${message}\n`, "utf-8");
    } catch {
      // Disk write failed — nothing more we can do
    }
  }
}

export function formatError(err: unknown): string {
  if (err instanceof Error) {
    // Use the message; truncate stacks to avoid wall-of-text in toasts
    return err.message;
  }
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

/** Wrap an async function so any throw is caught and logged via the reporter. */
export function safeAsync<T>(
  reporter: Reporter,
  context: string,
  fn: () => Promise<T>
): () => Promise<T | undefined> {
  return async () => {
    try {
      return await fn();
    } catch (err) {
      reporter.error(`[orch] ${context}`, err);
      return undefined;
    }
  };
}
