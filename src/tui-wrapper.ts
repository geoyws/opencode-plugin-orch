import * as fs from "node:fs";
import type {
  TuiPlugin,
  TuiPluginModule,
} from "@opencode-ai/plugin/tui";

type HotManifest = { version: string; server: string; tui: string };
const manifestURL = new URL("./.hot/manifest.json", import.meta.url);

function readManifest(): HotManifest | undefined {
  try {
    const value = JSON.parse(fs.readFileSync(manifestURL, "utf-8")) as HotManifest;
    if (!value.version || !value.tui) return undefined;
    return value;
  } catch {
    return undefined;
  }
}

async function loadTui(): Promise<TuiPlugin> {
  const manifest = readManifest();
  const loaded = manifest
    ? await import(new URL(`./.hot/${manifest.tui}`, import.meta.url).href)
    : await import("./tui.js");
  const module = loaded.default as TuiPluginModule | undefined;
  if (!module?.tui) throw new Error("Orch TUI implementation has no tui export");
  return module.tui;
}

const tui: TuiPlugin = async (api, options, meta) => {
  const loadedVersion = readManifest()?.version;
  await (await loadTui())(api, options, meta);
  if (!loadedVersion) return;

  let reloading = false;
  const timer = setInterval(() => {
    const next = readManifest()?.version;
    if (!next || next === loadedVersion || reloading || api.lifecycle.signal.aborted) return;
    reloading = true;
    void (async () => {
      try {
        await api.plugins.deactivate(meta.id);
        await api.plugins.activate(meta.id);
      } catch {
        reloading = false;
      }
    })();
  }, 500);
  if (typeof timer.unref === "function") timer.unref();
  api.lifecycle.onDispose(() => clearInterval(timer));
};

const module: TuiPluginModule = { id: "opencode-plugin-orch", tui };
export default module;
