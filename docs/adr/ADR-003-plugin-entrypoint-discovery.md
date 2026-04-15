# ADR-003: Plugin entrypoint discovery via the `./server` exports subpath

**Status:** Accepted
**Date:** 2026-04-14

## Context

For several debugging rounds, `opencode-plugin-orch` looked broken under `opencode run` on the dev box even though the in-process test suite (333+ tests at the time) was entirely green. Every live run produced the same symptom: none of the `orch_*` tools were registered, no `[orch]` log lines appeared, and the only breadcrumb was a single WARN line buried in the opencode log:

```
WARN service=plugin path=file://<checkout-path>
     message=Plugin ... does not expose a server entrypoint plugin has no server entrypoint
```

The opencode process itself kept running as if nothing was wrong — no crash, no error toast, no non-zero exit. A user running the command would simply see their model ignore the `orch_*` tools, with no indication of *why*. The plugin was completely dead, and yet everything that a plugin author would normally check looked fine:

- `dist/index.js` existed and had a named `export const server = plugin`.
- `package.json` had an `exports` map with `"."` pointing at `./dist/index.js`.
- Importing the plugin directly in a Bun test (`import { server } from "../dist/index.js"`) returned the fully-formed plugin object.
- The same `package.json` had been working fine as a local-directory plugin weeks earlier (pre-publish).

What we *hadn't* done was read the opencode binary to see what it was actually looking for. Once we did, the problem became obvious: opencode's plugin loader calls a helper named `resolvePackageEntrypoint(spec, "server", pkg)` that walks `pkg.exports["./server"]` first, then falls back to the legacy `pkg.main` field. Our `package.json` had `"."` and `"./tui"` subpaths and no `main`, so the loader resolved `undefined` and silently refused to import `dist/index.js` at all. The named `export const server = plugin` in the source file was irrelevant — opencode never reached the point of importing the file, so it never saw the export.

Unit tests and the entire 333-test suite passed throughout this period because they `import` modules directly from `dist/`, completely bypassing opencode's loader. The loader is the only layer that cares about the exports map. Tests that exercise plugin internals cannot detect a discovery failure because discovery already happened — the tests wrote the import path by hand.

## Decision

Add a `"./server"` subpath entry to `package.json` `exports` that points at the same file as `"."`. This is a one-line addition; no code changes:

```json
{
  "exports": {
    ".": { "import": "./dist/index.js", "types": "./dist/index.d.ts" },
    "./server": { "import": "./dist/index.js", "types": "./dist/index.d.ts" }
  }
}
```

We pick the `exports["./server"]` path over the legacy `main` path because:

1. It is the modern ESM subpath mechanism that opencode's resolver tries *first*. Using `main` would work but ties us to a legacy field that future versions of opencode may stop reading.
2. It keeps the plugin in a clean ESM-only shape — no CommonJS ambient assumptions — and matches what published opencode plugins already do.
3. It is orthogonal to the `"."` entry, so consumers that do `import pkg from "opencode-plugin-orch"` still get the same module, and opencode itself gets a dedicated subpath to resolve.

In addition, we document the discovery mechanism here so the next plugin author (or future-us) does not spend a day trying to figure out why opencode silently swallowed their plugin.

## Consequences

**Positive.**

- After the fix, the full load path is proven end-to-end on the dev box: opencode resolves `./server` → imports `dist/index.js` → reads `export const server = plugin` → calls `plugin({ app, client })` → init runs → tool registry fires → all 11 `orch_*` tools appear in the model's toolbelt. This is now captured in ADR-001's smoke-test procedure.
- Every consumer path works: `pnpm add opencode-plugin-orch`, a local relative path in `opencode.json`, a `file://` URL, and a symlinked checkout all resolve through the same `./server` subpath.
- Future plugin authors reading this repo have a concrete example of the discovery contract, rather than having to re-derive it from reading the opencode binary.

**Negative.**

- **The underlying loader behavior is still silent-fail.** Our fix makes *this* plugin work, but the next plugin author who forgets `./server` will hit the same WARN-only failure mode. Short of patching opencode upstream, there's nothing this repo can do about that; the best we can do is call it out in ADR-003 and in the README's "Verifying it works" section, which now lists "zero `plugin has no server entrypoint` warnings" as a required signal.
- **`dist/` must exist before opencode is launched.** The `./server` subpath points at `./dist/index.js`, which is produced by `tsc`. If a fresh clone is used without `pnpm install && pnpm run build`, the path resolves but the file is missing and opencode fails with a different (still silent) error. The `prepare` script in `package.json` runs `tsc` automatically on `pnpm install`, which mitigates this for the common case.
- **Two subpaths point at the same file.** That's intentional — `"."` is for direct importers, `"./server"` is for opencode's loader — but it does mean the `types` field is duplicated. If we add a types-only entry for one, we need to remember the other.

## References

- **Pre-fix evidence**: a local opencode log captured on the dev box during the initial smoke-test attempt — contained the bare `WARN ... plugin has no server entrypoint` line before the root cause was known.
- **Wrong-fix attempt**: commit `75ba706` — "fix: export server as named export for opencode plugin discovery". This commit added the named `export const server = plugin` to `dist/index.js` under the assumption that the plugin just needed a named export. It did not fix the load failure because opencode was never importing the file.
- **Actual fix**: commit `0b68d76` — "fix: add ./server exports subpath + live-test ADR-001". Adds the one-line `exports["./server"]` entry and ships ADR-001 capturing the live-test verification.
- **Loader function in opencode**: `resolvePackageEntrypoint(spec, "server", pkg)` — reads `pkg.exports["./server"]` then falls back to `pkg.main`. Found by reading the opencode binary; if the function is renamed in a future release this ADR should be updated.
- **Related ADR**: [ADR-001](ADR-001-model-choice-for-live-testing.md) — documents the live-test procedure that exists *because* this discovery bug motivated building one. Without a real `opencode run` smoke test, this class of bug is invisible.
