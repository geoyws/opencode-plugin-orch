import { describe, expect, it } from "bun:test";
import tuiModule from "../src/tui.js";
import pkg from "../package.json";

describe("separate TUI entrypoint", () => {
  it("loads without the server plugin and is exported as ./tui", () => {
    expect(tuiModule.id).toBe("opencode-plugin-orch");
    expect(typeof tuiModule.tui).toBe("function");
    expect((tuiModule as { server?: unknown }).server).toBeUndefined();
    expect(pkg.exports["./tui"].import).toBe("./dist/tui.js");
  });
});
