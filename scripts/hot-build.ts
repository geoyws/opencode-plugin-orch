import * as fs from "node:fs";
import * as path from "node:path";

export type HotManifest = { version: string; server: string; tui: string };

async function bundle(
  root: string,
  entrypoint: string,
  name: string
): Promise<string> {
  const result = await Bun.build({
    entrypoints: [path.join(root, entrypoint)],
    outdir: path.join(root, "dist", ".hot"),
    naming: name,
    target: "bun",
    format: "esm",
    packages: "external",
    sourcemap: "external",
  });
  if (!result.success) {
    throw new AggregateError(result.logs, `failed to bundle ${entrypoint}`);
  }
  return name.replace("[ext]", "js");
}

export async function buildHot(root = path.resolve(import.meta.dir, "..")): Promise<HotManifest> {
  const hotDir = path.join(root, "dist", ".hot");
  fs.mkdirSync(hotDir, { recursive: true });
  const manifestPath = path.join(hotDir, "manifest.json");
  let previous: HotManifest | undefined;
  try {
    previous = JSON.parse(fs.readFileSync(manifestPath, "utf-8")) as HotManifest;
  } catch {
    // The first generation has nothing to retain.
  }
  const version = `${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`;
  const server = await bundle(root, "src/plugin.ts", `server-${version}.[ext]`);
  const tui = await bundle(root, "src/tui.tsx", `tui-${version}.[ext]`);
  const manifest: HotManifest = { version, server, tui };
  const temporary = `${manifestPath}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(manifest), "utf-8");
  fs.renameSync(temporary, manifestPath);

  // Retain both current and previous generations. A reader can capture the old
  // manifest immediately before the atomic switch and import its bundle after
  // the switch; keeping one generation closes that read/import race.
  const retained = new Set([
    server,
    `${server}.map`,
    tui,
    `${tui}.map`,
    previous?.server,
    previous?.server ? `${previous.server}.map` : undefined,
    previous?.tui,
    previous?.tui ? `${previous.tui}.map` : undefined,
  ]);
  for (const filename of fs.readdirSync(hotDir)) {
    if (filename === "manifest.json" || retained.has(filename)) {
      continue;
    }
    if (/^(server|tui)-[a-z0-9-]+\.js(?:\.map)?$/.test(filename)) {
      fs.unlinkSync(path.join(hotDir, filename));
    }
  }
  return manifest;
}
