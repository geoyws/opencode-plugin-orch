import * as fs from "node:fs";
import * as path from "node:path";

export function logHookError(hookName: string, err: unknown): void {
  try {
    const message = err instanceof Error ? err.stack ?? err.message : String(err);
    const logPath = path.join(process.cwd(), ".opencode", "plugin-orch", "hooks.log");
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.appendFileSync(logPath, `[${new Date().toISOString()}] ${hookName} ${message}\n`);
  } catch {
    // Even file logging failed — give up
  }
}
