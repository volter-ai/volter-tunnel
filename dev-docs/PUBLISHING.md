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
Build the exact release source locally before publication.

## Releasing

`main` is an autonomous integration branch and never publishes. The former main/tag
publication, relay deployment, Pages build/deployment and account-limit rotation
workflows are retired (DECISIONS D9). No merge or tag starts a release.

Prepare the exact reviewed source, build the artifacts, and identify the target and
commit before requesting release authority. Only advance `publish` after explicit
owner authorization. A public relay or documentation release needs the owner's word;
a limited release needs the manager's permission. An npm release needs the manager's
permission after a key sweep over the exact packed tarball using gitleaks rules,
custody values and `@volter/teams/redact`. Never print, copy or commit custody.

After authorization, the operator reads the required credential in place, publishes
the prepared artifacts (core → client → mcp for npm; `wrangler deploy` for the relay),
records the resulting versions/deployment id, and reads back the released target.
Preserve existing relay bindings, routes, secrets and account authority. Updating
account limits is an explicit authenticated admin operation; never rotate the root
credential merely to invoke that operation. No retrying workflow replaces an
operator's diagnosis of a failed operation.
