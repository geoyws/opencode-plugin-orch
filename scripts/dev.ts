import * as fs from "node:fs";
import * as path from "node:path";

const root = path.resolve(import.meta.dir, "..");
let building = false;
let dirty = true;
let timer: ReturnType<typeof setTimeout> | undefined;

async function build(): Promise<void> {
  if (building) {
    dirty = true;
    return;
  }
  building = true;
  do {
    dirty = false;
    const started = Date.now();
    const child = Bun.spawn([process.execPath, path.join(root, "scripts", "build.ts")], {
      cwd: root,
      stdout: "inherit",
      stderr: "inherit",
    });
    const code = await child.exited;
    if (code === 0) {
      console.log(`[orch] reload generation ready in ${Date.now() - started}ms`);
    } else {
      console.error(`[orch] build failed with exit ${code}; keeping the previous generation`);
    }
  } while (dirty);
  building = false;
}

await build();
console.log("[orch] watching src/; server instances and the TUI reload after each successful build");

const watcher = fs.watch(path.join(root, "src"), { recursive: true }, () => {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => void build(), 120);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    watcher.close();
    process.exit(0);
  });
}
