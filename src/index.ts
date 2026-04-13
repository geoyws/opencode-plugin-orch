import type { PluginModule } from "@opencode-ai/plugin";
import { plugin } from "./plugin.js";

// Named export — opencode resolves `server` as a named export from the
// plugin module entrypoint.
export const server = plugin;

// Also export as a PluginModule object for the alternate registration shape.
const mod: PluginModule = {
  id: "opencode-plugin-orch",
  server: plugin,
};

export default mod;
