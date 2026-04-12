import type { PluginModule } from "@opencode-ai/plugin";
import { plugin } from "./plugin.js";

const mod: PluginModule = {
  id: "opencode-plugin-orch",
  server: plugin,
};

export default mod;
