import * as fs from "node:fs";
import type {
  TuiPlugin,
  TuiPluginModule,
} from "@opencode-ai/plugin/tui";

type HotManifest = { version: string; server: string; tui: string };
const TUI_ACTIVATION_DELAY_MS = 500;
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
  let activationTimer: ReturnType<typeof setTimeout> | undefined;
  let reloadTimer: ReturnType<typeof setInterval> | undefined;
  let disposed = api.lifecycle.signal.aborted;
  let reloading = false;

  // Importing @opentui/solid costs materially more than Orch's server init.
  // Do it after OpenCode has had a chance to paint its prompt: a zero-delay
  // timer still runs during renderer setup and blocks that first frame. The
  // badge and dashboard may appear a fraction later, but never hold startup.
  activationTimer = setTimeout(() => {
    activationTimer = undefined;
    if (disposed || api.lifecycle.signal.aborted) return;
    void (async () => {
      await (await loadTui())(api, options, meta);
      if (!loadedVersion || disposed || api.lifecycle.signal.aborted) return;

      reloadTimer = setInterval(() => {
        const next = readManifest()?.version;
        if (!next || next === loadedVersion || reloading || disposed) return;
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
      if (typeof reloadTimer.unref === "function") reloadTimer.unref();
    })().catch((err) => {
      console.error(`[orch] deferred TUI activation failed: ${(err as Error).message}`);
    });
  }, TUI_ACTIVATION_DELAY_MS);
  if (typeof activationTimer.unref === "function") activationTimer.unref();

  api.lifecycle.onDispose(() => {
    disposed = true;
    if (activationTimer) clearTimeout(activationTimer);
    if (reloadTimer) clearInterval(reloadTimer);
  });
};

const module: TuiPluginModule = { id: "opencode-plugin-orch", tui };
export default module;
