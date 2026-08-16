import * as fs from "node:fs";
import type { Hooks, Plugin, PluginModule } from "@opencode-ai/plugin";

type HotManifest = { version: string; server: string; tui: string };

const manifestURL = new URL("./.hot/manifest.json", import.meta.url);

function readManifest(): HotManifest | undefined {
  try {
    const value = JSON.parse(fs.readFileSync(manifestURL, "utf-8")) as HotManifest;
    if (!value.version || !value.server) return undefined;
    return value;
  } catch {
    return undefined;
  }
}

async function loadServer(): Promise<Plugin> {
  const manifest = readManifest();
  if (!manifest) return (await import("./plugin.js")).plugin;
  const moduleURL = new URL(`./.hot/${manifest.server}`, import.meta.url);
  const loaded = (await import(moduleURL.href)) as { plugin?: Plugin };
  if (!loaded.plugin) throw new Error(`hot server bundle ${manifest.server} has no plugin export`);
  return loaded.plugin;
}

export const server: Plugin = async (input, options): Promise<Hooks> => {
  const loadedVersion = readManifest()?.version;
  const implementation = await loadServer();
  const hooks = await implementation(input, options);
  if (!loadedVersion) return hooks;

  let disposed = false;
  let reloading = false;
  const timer = setInterval(() => {
    const next = readManifest()?.version;
    if (!next || next === loadedVersion || reloading || disposed) return;
    reloading = true;
    void Promise.resolve(
      input.client.instance.dispose({ query: { directory: input.directory } })
    ).catch(() => {
      reloading = false;
    });
  }, 500);
  if (typeof timer.unref === "function") timer.unref();

  const implementationDispose = hooks.dispose;
  hooks.dispose = async () => {
    if (disposed) return;
    disposed = true;
    clearInterval(timer);
    await implementationDispose?.();
  };
  return hooks;
};

const mod: PluginModule = {
  id: "opencode-plugin-orch",
  server,
};

export default mod;
