import { tool, type ToolDefinition } from "@opencode-ai/plugin";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// Resolve opencode's log directory given an explicit homedir + platform.
// Split from defaultFindLogDir so tests can drive it against a tmp home
// without monkey-patching the `os` module. Checks the platform-native
// path first so a dotfiles setup with both trees present (e.g. a Mac
// mirroring an XDG-style Linux layout) still picks the one opencode
// actually writes to.
export function resolveLogDir(
  homedir: string,
  platform: NodeJS.Platform
): string | undefined {
  const linuxPath = path.join(homedir, ".local/share/opencode/log");
  const macPath = path.join(
    homedir,
    "Library/Application Support/opencode/log"
  );
  const candidates =
    platform === "darwin" ? [macPath, linuxPath] : [linuxPath, macPath];
  for (const dir of candidates) {
    if (fs.existsSync(dir)) return dir;
  }
  return undefined;
}

// Default opencode log directory on Linux / macOS. Thin wrapper around
// resolveLogDir that injects the current process's homedir + platform.
export function defaultFindLogDir(): string | undefined {
  return resolveLogDir(os.homedir(), os.platform());
}

export interface LogToolOptions {
  // Dependency injection for tests: override the log-dir lookup so the
  // tool reads from a temp dir instead of the user's real opencode log.
  findLogDir?: () => string | undefined;
}

export function createLogTool(opts: LogToolOptions = {}): ToolDefinition {
  const findLogDir = opts.findLogDir ?? defaultFindLogDir;
  return tool({
    description:
      "Inspect opencode-plugin-orch log output from the current opencode " +
      "run. Reads the most recent log file and filters to lines mentioning " +
      "the plugin. Actions: tail (last N matching lines, default 20, max " +
      "200), errors (plugin ERROR-level lines only), stats (INFO/WARN/" +
      "ERROR line counts).",
    args: {
      action: tool.schema
        .enum(["tail", "errors", "stats"])
        .describe("tail | errors | stats"),
      lines: tool.schema
        .number()
        .optional()
        .describe("Lines to return for `tail` (default 20, max 200)"),
    },
    async execute(args) {
      try {
        const logDir = findLogDir();
        if (!logDir) {
          return "Error: could not locate opencode log directory (tried ~/.local/share/opencode/log and ~/Library/Application Support/opencode/log)";
        }

        // Pick the most recently modified .log file by mtime, not
        // lexical name. opencode's own log files are ISO-timestamp
        // named so lexical sort used to work, but a sibling file like
        // `latest.log` or `archive.log` would beat a digit-prefixed
        // timestamp name (letters > digits in ASCII). mtime is robust
        // to whatever naming convention opencode lands on.
        let files: Array<{ name: string; fullPath: string; mtime: number }>;
        try {
          files = fs
            .readdirSync(logDir)
            .filter((f) => f.endsWith(".log"))
            .map((name) => {
              const fullPath = path.join(logDir, name);
              try {
                return { name, fullPath, mtime: fs.statSync(fullPath).mtimeMs };
              } catch {
                return null;
              }
            })
            .filter(
              (x): x is { name: string; fullPath: string; mtime: number } =>
                x !== null
            )
            .sort((a, b) => b.mtime - a.mtime);
        } catch (err) {
          return `Error reading log directory ${logDir}: ${
            err instanceof Error ? err.message : String(err)
          }`;
        }
        if (files.length === 0) return `No log files found in ${logDir}`;

        const latest = files[0];
        const content = fs.readFileSync(latest.fullPath, "utf-8");
        const allLines = content.split("\n");

        // Match the two prefixes the plugin uses: [orch] for the
        // human-friendly toast/log lines from hooks + reporter, and
        // `opencode-plugin-orch` for the service field that opencode's
        // own logger stamps onto plugin warnings (ADR-003 "plugin has
        // no server entrypoint" etc.).
        const pluginLines = allLines.filter(
          (l) => l.includes("opencode-plugin-orch") || l.includes("[orch]")
        );

        switch (args.action) {
          case "tail": {
            const n = Math.min(Math.max(args.lines ?? 20, 1), 200);
            const last = pluginLines.slice(-n);
            return last.length === 0
              ? `No plugin lines in ${latest.name}`
              : `Last ${last.length} plugin line(s) from ${latest.name}:\n${last.join("\n")}`;
          }
          case "errors": {
            const errors = pluginLines.filter((l) => l.includes("ERROR"));
            return errors.length === 0
              ? `No plugin errors in ${latest.name}`
              : `${errors.length} plugin error line(s) in ${latest.name}:\n${errors.join("\n")}`;
          }
          case "stats": {
            const info = pluginLines.filter((l) => l.includes("INFO")).length;
            const warn = pluginLines.filter((l) => l.includes("WARN")).length;
            const error = pluginLines.filter((l) => l.includes("ERROR")).length;
            return `Plugin log stats from ${latest.name}: ${info} INFO, ${warn} WARN, ${error} ERROR`;
          }
        }
        return "Error: unknown action";
      } catch (err) {
        return `Error: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  });
}
