import * as path from "node:path";
import { buildHot } from "./hot-build.js";

const root = path.resolve(import.meta.dir, "..");
const tsc = Bun.spawn([path.join(root, "node_modules", ".bin", "tsc")], {
  cwd: root,
  stdout: "inherit",
  stderr: "inherit",
});
const code = await tsc.exited;
if (code !== 0) process.exit(code);

const manifest = await buildHot(root);
console.log(`[orch] built hot-reload generation ${manifest.version}`);
