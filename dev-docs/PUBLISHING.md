# Publishing

The three packages build to Node-consumable JS and are wired for npm release.

## Packages

| Package | Notes |
|---|---|
| `@volter/tunnel-core` | the wire protocol; no deps |
| `@volter/tunnel` | the client lib (`createTunnel`) + CLI (`volter-tunnel`) + `VolterClient`; depends on core |
| `@volter/tunnel-mcp` | MCP server (`volter-tunnel-mcp`); bundles the client SDK in, so it's self-contained |

`server-cf` (the relay) is `private` and deploys via `wrangler`, not npm.

## How the dual source/dist resolution works

Each package's `exports` serve **source** to Bun/TypeScript and **built JS** to
Node:

```jsonc
"exports": { ".": { "bun": "./src/index.ts", "types": "./src/index.ts", "import": "./dist/index.js" } }
```

- **Bun dev / tests** resolve the `bun` condition → `.ts` source (no build needed).
- **TypeScript** resolves `types` → `.ts` source (so dev typecheck needs no build,
  and TS consumers get types straight from source — shipped in `files`).
- **Node consumers** resolve `import` → `dist/*.js` (emitted by `tsup`).

`bun run build` emits `dist/` for all three (core → client → mcp); bins carry a
`#!/usr/bin/env node` shebang and a portable entry guard (works on Bun and Node).
CI builds and Node-smoke-tests the artifacts on every PR.

## Releasing

Tag a version and let `.github/workflows/release.yml` publish (needs an
`NPM_TOKEN` secret). It builds, then publishes **core → client → mcp** in order
with `bun publish`, which rewrites the `workspace:*` dependency to the real
version.

```bash
npm version <patch|minor|major> --workspaces false   # or bump manually
git tag vX.Y.Z && git push --tags
```

Locally you can dry-run with `bun pm pack` / `npm pack --dry-run` in each package
to inspect the tarball before tagging.
