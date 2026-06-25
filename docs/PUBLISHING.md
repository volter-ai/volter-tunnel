# Publishing — current state & what's required

**Status: not yet published to npm.** Today the packages are consumed from source
within this monorepo, under **Bun** (which imports `.ts` directly). Before these
can be `npm install`-ed by an external, non-Bun consumer, the items below must be
addressed. This file is the honest checklist (surfaced by a packaging review).

## What works today

- Local/monorepo use under **Bun**: `bun add`/workspace links resolve the `.ts`
  source; `client/cli.ts` and `packages/mcp/src/server.ts` run via their
  `#!/usr/bin/env bun` shebang.
- The CF relay (`server-cf`, `private`) ships via `wrangler` (esbuild bundles the
  TS, including the relative `@volter/tunnel-core` import) — this is unaffected by
  npm packaging and is already deployed.

## Blockers for an npm release (not done)

1. **No build step.** All packages point `main`/`types`/`exports` at `.ts` source.
   Plain Node can't import `.ts`. A release needs a build (e.g. `tsup`) emitting
   `.js` + `.d.ts` to `dist/`, with `main`/`types`/`exports`/`bin` repointed and a
   `#!/usr/bin/env node` shebang on the built bins.
2. **`workspace:*` dependency.** Root `@volter/tunnel` depends on
   `@volter/tunnel-core` via `workspace:*`. `npm publish` does not rewrite that —
   publish with a tool that does (`bun publish`) or a prepublish rewrite to a real
   semver, and publish `@volter/tunnel-core` **first**.
3. **MCP cross-package imports.** `packages/mcp` imports `../../../client/*`
   (outside its own package). For a published package it must depend on
   `@volter/tunnel` and import `VolterClient`/formatters via the package name.
4. **Runtime model.** Decide & document: ship built JS for Node, or stay Bun-only
   (then declare `engines.bun` — already set — and state it loudly). The READMEs
   currently say `bun add` / `bunx`, consistent with Bun-only.

## Suggested release order (once built)

`@volter/tunnel-core` → `@volter/tunnel` → `@volter/tunnel-mcp`, gated by a
tag-triggered release workflow with `prepublishOnly` that fails if `dist/` is
missing. `server-cf` and `server` stay `private` / unpublished.
