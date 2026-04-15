// Unit tests for the member tool-allowlist defaults and the
// computeMemberToolsAllowed() helper.

import { describe, test, expect } from "bun:test";
import {
  MEMBER_TOOL_DEFAULTS,
  computeMemberToolsAllowed,
} from "../src/core/team-manager.js";

describe("MEMBER_TOOL_DEFAULTS", () => {
  test("allows the baseline file/edit/shell tools", () => {
    expect(MEMBER_TOOL_DEFAULTS.read).toBe(true);
    expect(MEMBER_TOOL_DEFAULTS.write).toBe(true);
    expect(MEMBER_TOOL_DEFAULTS.edit).toBe(true);
    expect(MEMBER_TOOL_DEFAULTS.glob).toBe(true);
    expect(MEMBER_TOOL_DEFAULTS.grep).toBe(true);
    expect(MEMBER_TOOL_DEFAULTS.bash).toBe(true);
  });

  test("denies webfetch by default (opt-in via toolsAllowed)", () => {
    expect(MEMBER_TOOL_DEFAULTS.webfetch).toBe(false);
  });

  test("allows peer-coordination orch tools", () => {
    expect(MEMBER_TOOL_DEFAULTS.orch_message).toBe(true);
    expect(MEMBER_TOOL_DEFAULTS.orch_broadcast).toBe(true);
    expect(MEMBER_TOOL_DEFAULTS.orch_tasks).toBe(true);
    expect(MEMBER_TOOL_DEFAULTS.orch_memo).toBe(true);
    expect(MEMBER_TOOL_DEFAULTS.orch_status).toBe(true);
    expect(MEMBER_TOOL_DEFAULTS.orch_result).toBe(true);
  });

  test("denies lead-only and recursion-risk orch tools", () => {
    expect(MEMBER_TOOL_DEFAULTS.orch_inbox).toBe(false);
    expect(MEMBER_TOOL_DEFAULTS.orch_team).toBe(false);
    expect(MEMBER_TOOL_DEFAULTS.orch_create).toBe(false);
    expect(MEMBER_TOOL_DEFAULTS.orch_spawn).toBe(false);
    expect(MEMBER_TOOL_DEFAULTS.orch_shutdown).toBe(false);
  });
});

describe("computeMemberToolsAllowed", () => {
  test("returns a copy of the defaults when called with no additions", () => {
    const result = computeMemberToolsAllowed();
    expect(result).toEqual(MEMBER_TOOL_DEFAULTS);
    // Not the same reference — callers can mutate safely
    expect(result).not.toBe(MEMBER_TOOL_DEFAULTS);
  });

  test("default result denies webfetch", () => {
    const result = computeMemberToolsAllowed();
    expect(result.webfetch).toBe(false);
  });

  test("default result denies orch_create", () => {
    const result = computeMemberToolsAllowed();
    expect(result.orch_create).toBe(false);
  });

  test("default result denies orch_inbox", () => {
    const result = computeMemberToolsAllowed();
    expect(result.orch_inbox).toBe(false);
  });

  test("user opt-in of webfetch flips it to true", () => {
    const result = computeMemberToolsAllowed(["webfetch"]);
    expect(result.webfetch).toBe(true);
    // Unrelated defaults are untouched
    expect(result.orch_create).toBe(false);
    expect(result.read).toBe(true);
  });

  test("additional args are merged on top of defaults (multiple names)", () => {
    const result = computeMemberToolsAllowed(["webfetch", "bash"]);
    expect(result.webfetch).toBe(true);
    expect(result.bash).toBe(true);
  });

  test("whitespace in additional args is trimmed; empty entries ignored", () => {
    const result = computeMemberToolsAllowed(["  webfetch  ", "", "   "]);
    expect(result.webfetch).toBe(true);
    // Empty/whitespace entries shouldn't leak as keys
    expect(Object.keys(result)).not.toContain("");
    expect(Object.keys(result)).not.toContain("  ");
  });

  test("user can unblock a normally-denied orch tool via additional (escape hatch)", () => {
    // Task-lead spec: user-provided names always get true. This means a
    // caller who knows what they're doing can re-enable a default-denied
    // orch tool for a specific member. Document the behavior.
    const result = computeMemberToolsAllowed(["orch_create"]);
    expect(result.orch_create).toBe(true);
  });

  test("unknown orch_* tool not in defaults is absent from the allowlist when knownToolIds is empty", () => {
    // Without a knownToolIds list, the helper cannot know about a
    // future `orch_frobnicate` — it simply isn't in the result.
    const result = computeMemberToolsAllowed();
    expect(result.orch_frobnicate).toBeUndefined();
    expect("orch_frobnicate" in result).toBe(false);
  });
});

describe("computeMemberToolsAllowed knownToolIds closure (ADR-004)", () => {
  test("unknown orch_* id in knownToolIds is explicitly denied", () => {
    // The whole point: opencode's body.tools is an override map, so
    // unlisted = allow. If a future contributor ships orch_frobnicate
    // without registering it in MEMBER_TOOL_DEFAULTS, the live tool
    // registry will surface it and this helper must set it to false.
    const result = computeMemberToolsAllowed(undefined, ["orch_frobnicate"]);
    expect(result.orch_frobnicate).toBe(false);
  });

  test("non-orch ids in knownToolIds do not get implicit denies", () => {
    // We deliberately only close the hole for orch_* — baseline tools
    // like read/write/edit/bash that are already `true` in defaults
    // must stay true, and any other non-orch id from the registry is
    // ignored (opencode's own defaults govern it).
    const result = computeMemberToolsAllowed(undefined, [
      "read",
      "bash",
      "some_future_builtin",
    ]);
    expect(result.read).toBe(true);
    expect(result.bash).toBe(true);
    expect(result.some_future_builtin).toBeUndefined();
  });

  test("orch_* ids already in MEMBER_TOOL_DEFAULTS keep their default value", () => {
    // knownToolIds closure must not clobber explicit defaults — both
    // allowed (orch_message=true) and denied (orch_create=false)
    // defaults must survive even if the registry surfaces them.
    const result = computeMemberToolsAllowed(undefined, [
      "orch_message",
      "orch_create",
    ]);
    expect(result.orch_message).toBe(true);
    expect(result.orch_create).toBe(false);
  });

  test("additional arg escape hatch beats knownToolIds implicit deny", () => {
    // A caller who knows about orch_frobnicate can still opt a specific
    // member into it by passing it in `additional`. The closure runs
    // before the additional merge so additional wins.
    const result = computeMemberToolsAllowed(
      ["orch_frobnicate"],
      ["orch_frobnicate"]
    );
    expect(result.orch_frobnicate).toBe(true);
  });

  test("knownToolIds with only known-and-listed ids leaves result identical to defaults", () => {
    // Null case: if the registry only ever surfaces tools we already
    // registered, the helper returns MEMBER_TOOL_DEFAULTS (plus merged
    // additions) unchanged.
    const result = computeMemberToolsAllowed(undefined, [
      "read",
      "orch_message",
      "orch_create",
    ]);
    expect(result).toEqual(MEMBER_TOOL_DEFAULTS);
  });
});
