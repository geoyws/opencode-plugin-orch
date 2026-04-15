import { tool, type ToolDefinition } from "@opencode-ai/plugin";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// Default opencode log directory on Linux / macOS. Exported so tests and
// tooling can reference the lookup order without re-deriving it.
export function defaultFindLogDir(): string | undefined {
  const candidates = [
    path.join(os.homedir(), ".local/share/opencode/log"),
    path.join(os.homedir(), "Library/Application Support/opencode/log"),
  ];
  for (const dir of candidates) {
    if (fs.existsSync(dir)) return dir;
  }
  return undefined;
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

        let files: string[];
        try {
          files = fs
            .readdirSync(logDir)
            .filter((f) => f.endsWith(".log"))
            .sort();
        } catch (err) {
          return `Error reading log directory ${logDir}: ${
            err instanceof Error ? err.message : String(err)
          }`;
        }
        if (files.length === 0) return `No log files found in ${logDir}`;

        // Most recent log file. Names are timestamped (e.g.
        // 2026-04-15T093000.log) so lexical sort = chronological sort.
        const latest = path.join(logDir, files[files.length - 1]);
        const content = fs.readFileSync(latest, "utf-8");
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
              ? `No plugin lines in ${path.basename(latest)}`
              : `Last ${last.length} plugin line(s) from ${path.basename(latest)}:\n${last.join("\n")}`;
          }
          case "errors": {
            const errors = pluginLines.filter((l) => l.includes("ERROR"));
            return errors.length === 0
              ? `No plugin errors in ${path.basename(latest)}`
              : `${errors.length} plugin error line(s) in ${path.basename(latest)}:\n${errors.join("\n")}`;
          }
          case "stats": {
            const info = pluginLines.filter((l) => l.includes("INFO")).length;
            const warn = pluginLines.filter((l) => l.includes("WARN")).length;
            const error = pluginLines.filter((l) => l.includes("ERROR")).length;
            return `Plugin log stats from ${path.basename(latest)}: ${info} INFO, ${warn} WARN, ${error} ERROR`;
          }
        }
        return "Error: unknown action";
      } catch (err) {
        return `Error: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  });
}
