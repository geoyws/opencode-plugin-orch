# ADR-004: Member tool-scoping semantics — `body.tools` is an override map, not a closed allowlist

**Status:** Accepted
**Date:** 2026-04-15

## Context

[ADR-002](ADR-002-three-tier-lead-visibility.md) established that spawned team members must be tool-scoped so they cannot, for example, recursively create sub-teams (`orch_create`/`orch_spawn`) or read the lead's inbox (`orch_inbox`). The implementation in `src/core/team-manager.ts` passes a per-member record to `session.promptAsync` via `body.tools`:

```ts
const toolsAllowed = computeMemberToolsAllowed(opts.toolsAllowed);
// ...
await this.ctx.client.session.promptAsync({
  path: { id: sessionID },
  body: { parts: [...], tools: toolsAllowed, ... },
});
```

`computeMemberToolsAllowed` starts from a hand-maintained `MEMBER_TOOL_DEFAULTS` object listing explicit `true`/`false` decisions for every `orch_*` tool plus the baseline filesystem/shell tools:

```ts
export const MEMBER_TOOL_DEFAULTS: Record<string, boolean> = {
  read: true, write: true, edit: true, glob: true, grep: true, bash: true,
  webfetch: false,
  orch_message: true, orch_broadcast: true, orch_tasks: true,
  orch_memo: true, orch_status: true, orch_result: true,
  orch_inbox: false, orch_team: false,
  orch_create: false, orch_spawn: false, orch_shutdown: false,
};
```

During review of the Task 6 rename (`DEFAULT_MEMBER_TOOLS` → `MEMBER_TOOL_DEFAULTS` + helper), a reviewer raised a sharp question: the helper's doc comment claimed that any `orch_*` tool **not** listed in `MEMBER_TOOL_DEFAULTS` would be implicitly denied, on the reasoning that "unlisted" tools would fall through to session-level scoping. But that guarantee only holds if opencode treats `body.tools` as a *closed allowlist* (unlisted = deny). If `body.tools` is instead an *open override map* (unlisted = allow), then a future contributor who ships, say, `orch_frobnicate` without remembering to register it in `MEMBER_TOOL_DEFAULTS` would silently expose that tool to every spawned member — the exact failure mode the allowlist was supposed to prevent.

The behavior is not documented on the opencode side. The only source of truth is the opencode binary itself.

## Investigation

opencode is distributed as a single Bun-compiled binary (installed under `~/.opencode/bin/opencode` on the dev box, ~166 MB). Using `strings` on the binary and grepping for the `body.tools` handling surfaced four code paths that together pin down the semantics:

**1. `body.tools` → `session.permission` translation** (inside the session-prompt handler). Each entry is converted into one permission rule with `pattern: "*"`, and the resulting rule array **replaces** `session.permission` wholesale — it is not merged with the prior session-level rules:

```js
yield* sessions.touch(input.sessionID);
const permissions = [];
for (const [t3, enabled] of Object.entries(input.tools ?? {})) {
  permissions.push({
    permission: t3,
    action: enabled ? "allow" : "deny",
    pattern: "*",
  });
}
if (permissions.length > 0) {
  session.permission = permissions;
  yield* sessions.setPermission({
    sessionID: session.id,
    permission: permissions,
  });
}
```

**2. Effective ruleset assembly.** At tool-check time, opencode flattens the agent's permission rules with the session's permission rules. `Permission.merge` is a plain `flat()`, not a dedupe or override — agent rules come first, session rules after:

```js
function merge12(...rulesets) { return rulesets.flat(); }
const ruleset = Permission.merge(agent.permission, session.permission ?? []);
```

**3. `disabled(tools, ruleset)` uses `findLast`.** This is the critical piece. For each tool, opencode looks up the **last** matching rule in the combined ruleset. If `findLast` returns `undefined`, it `continue`s without disabling the tool — i.e. "no rule found" does NOT mean denied, it means *not in the disabled set*:

```js
const EDIT_TOOLS = ["edit", "write", "apply_patch", "multiedit"];
function disabled(tools, ruleset) {
  const result6 = new Set();
  for (const tool2 of tools) {
    const permission = EDIT_TOOLS.includes(tool2) ? "edit" : tool2;
    const rule = ruleset.findLast(
      (rule2) => Wildcard.match(permission, rule2.permission)
    );
    if (!rule) continue;
    if (rule.pattern === "*" && rule.action === "deny") result6.add(tool2);
  }
  return result6;
}
```

**4. Root default is `"*": "allow"`.** opencode bootstraps a baseline ruleset (`defaults3`) that contains a wildcard allow at the root, plus narrower rules for sensitive categories (`question`, `plan_enter`, `external_directory`, `read` → `*.env`, etc.):

```js
const defaults3 = Permission.fromConfig({
  "*": "allow",
  doom_loop: "ask",
  external_directory: { "*": "ask", ... },
  question: "deny", plan_enter: "deny", plan_exit: "deny",
  read: { "*": "allow", "*.env": "ask", ... }
});
```

Putting these together: when a member's session is prompted with `body.tools = MEMBER_TOOL_DEFAULTS` and a future `orch_frobnicate` tool is **not** in that record, the tool-check for `orch_frobnicate` walks the merged ruleset looking for a rule whose `permission` wildcard-matches `"orch_frobnicate"`. There is no such rule in `session.permission` (we didn't add one), no such rule in the agent's permission, but the `defaults3` entry `"*": "allow"` matches every tool. `findLast` returns that rule, its action is `allow`, it is not added to the `disabled` set, and `orch_frobnicate` is callable.

**Therefore: unlisted = ALLOW.** The reviewer's concern was correct and the old doc comment was wrong.

## Decision

1. **Document the semantics.** `body.tools` in opencode is an *override map*: it sets per-session rules for exactly the keys it names, leaving everything else to fall through to `defaults3`. Anyone reading `computeMemberToolsAllowed` needs to understand this before touching the allowlist or adding a new `orch_*` tool.

2. **Close the hole at spawn time.** `computeMemberToolsAllowed` now accepts a second parameter, `knownToolIds?: string[]`, representing the live tool registry. For each id in that list that begins with `orch_` and is **not** already in `MEMBER_TOOL_DEFAULTS`, the helper inserts `false` into the result before the user-provided `additional` merge runs. This promotes an *implicit* unlisted-allow into an *explicit* unlisted-deny, so the hardcoded deny list auto-extends every time a new `orch_*` tool ships.

3. **Query the registry best-effort.** `TeamManager.spawnMember` calls `this.ctx.client.tool.ids()` (the experimental `/experimental/tool/ids` endpoint exposed on the plugin client) right before computing the allowlist and feeds the result into the helper. The call is wrapped in try/catch with an empty-array fallback so a transient registry failure never blocks spawning — in the worst case the member gets `MEMBER_TOOL_DEFAULTS` only, which is the pre-ADR-004 behavior.

4. **Preserve the escape hatch.** The `additional` merge still runs *after* the knownToolIds closure, so a caller who deliberately wants to opt a member into `orch_frobnicate` can pass it in `toolsAllowed` and it still wins. The closure only affects tools the caller has *not* explicitly asked for.

5. **Narrow the closure to `orch_*` only.** The registry surfaces every tool opencode knows about, including baseline tools like `read`/`write`/`edit`/`bash` and provider-specific additions. We deliberately do not close down non-`orch_*` tools: those are governed by opencode's own `defaults3` (which already handles things like `*.env` reads and plan mode) and by the per-member `toolsAllowed`/baseline entries, and closing them wholesale would break reasonable spawn configurations. The hardening here targets the narrow "forgotten `orch_*` tool" class of bug.

## Consequences

**Positive.**

- A future contributor who adds `orch_frobnicate` and forgets to register it in `MEMBER_TOOL_DEFAULTS` gets an explicit `orch_frobnicate: false` at spawn time, not a silent allow. The failure mode is "member can't use the new tool" (visible, fixable by adding one line to `MEMBER_TOOL_DEFAULTS`) rather than "every spawned member silently inherits it" (invisible, only caught by review of a diff that might not exist).
- The doc comment on `computeMemberToolsAllowed` now accurately describes opencode's semantics, so the next person who touches this helper does not have to re-derive the behavior from the binary.
- Tests in `tests/member-tools.test.ts` now cover the `knownToolIds` closure explicitly, including the escape-hatch interaction with `additional`.

**Negative.**

- **`/experimental/tool/ids` is experimental.** The endpoint name literally starts with `experimental/`. If a future opencode release renames it, changes its response shape, or removes it entirely, our registry fetch will fail, the try/catch will swallow the error, and `knownToolIds` will fall back to `[]`. That silently restores the pre-ADR-004 behavior (unlisted = allow). Until opencode stabilizes the endpoint, anyone upgrading the SDK version should smoke-test that `ctx.client.tool.ids()` still returns a string array or this ADR's guarantee silently weakens.
- **We bind to `findLast` + `"*": "allow"` behavior.** This ADR assumes opencode's resolver keeps using `findLast` against a ruleset whose root default is `"*": "allow"`. If opencode switches to a *closed-allowlist* semantics upstream (which would actually be the safer shape), our explicit-deny closure becomes redundant but not harmful — it just adds rules that were already implied. If they switch to something else (e.g. "first match wins"), the semantics of `body.tools` change and this ADR needs to be revisited.
- **One extra HTTP round-trip per spawn.** The `tool.ids()` call adds latency to every `spawnMember`. In practice the session is being created via a second network call anyway and the registry query is tiny, so the overhead is negligible, but it is non-zero and happens on the hot path.
- **The doc comment is load-bearing documentation.** The `IMPORTANT — opencode's body.tools semantics` block in `computeMemberToolsAllowed` is the only in-code reminder of why `knownToolIds` exists. If a future refactor "simplifies" the helper by dropping that parameter because it looks unused in unit tests that don't pass it, the hole reopens. This ADR is the backstop.

## References

- **Opencode binary**: `~/.opencode/bin/opencode` on the dev box. All four code snippets in the Investigation section were extracted via `strings` against this binary. If opencode ships a new release the strings may move; re-run with `strings "$HOME/.opencode/bin/opencode" | grep 'input.tools'` and `| grep 'EDIT_TOOLS'` to relocate them.
- **SDK method**: `OpencodeClient.tool.ids()` → `Array<string>` wrapped in `{ data }` by the hey-api client. Declared in `node_modules/@opencode-ai/sdk/dist/gen/sdk.gen.d.ts:82` (class `Tool`, method `ids`) and `node_modules/@opencode-ai/sdk/dist/gen/types.gen.d.ts:1215` (`ToolIds = Array<string>`) / `:1702` (`ToolIdsData` with `url: "/experimental/tool/ids"`).
- **Implementation**: `src/core/team-manager.ts` — `computeMemberToolsAllowed` (helper) and `spawnMember` (registry fetch + call site).
- **Tests**: `tests/member-tools.test.ts` — the `computeMemberToolsAllowed knownToolIds closure (ADR-004)` describe block covers the five closure behaviors (unknown `orch_*` denied, non-orch ignored, known `orch_*` defaults preserved, `additional` escape hatch wins, null-case parity).
- **Related ADR**: [ADR-002](ADR-002-three-tier-lead-visibility.md) — establishes *why* members are tool-scoped in the first place (lead-only `orch_inbox`/`orch_team`/`orch_shutdown`, recursion-prevention denies on `orch_create`/`orch_spawn`). ADR-004 is the semantics-level follow-up that makes ADR-002's guarantees robust against future tool additions.
