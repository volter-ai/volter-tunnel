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
commit before requesting release authority. `publish` is created or advanced only on the
owner's explicit publication authorization; no other permission moves it. A relay release
is a limited release: it needs the manager's permission after review, goes out by
`wrangler deploy`, and never creates or advances `publish`. A documentation-site release
needs the owner's word. An npm release takes the manager's permission once a keys sweep
over the exact packed tarball, using gitleaks rules, custody values and
`@volter/teams/redact`, finds nothing (the owner's npm exception, 2026-10-21); it does not
create or advance `publish`. Never print, copy or commit custody.

After authorization, the operator reads the required credential in place, publishes
the prepared artifacts (core → client → mcp for npm; `wrangler deploy` for the relay),
records the resulting versions/deployment id, and reads back the released target.
Preserve existing relay bindings, routes, secrets and account authority.
The relay's `wrangler deploy` needs one credential with both Workers Scripts edit on the account and
Workers Routes edit on the relay's zone. A Workers-only credential uploads the script, which then
serves, and fails re-asserting the zone routes ("No access"), so the deploy exits non-zero after
the release has landed. Updating
account limits is an explicit authenticated admin operation; never rotate the root
credential merely to invoke that operation. No retrying workflow replaces an
operator's diagnosis of a failed operation.

### npm: prepare, authorize, publish

There is no npm publication workflow. The authority is the manager's permission after
the keys sweep (above); an npm release does not advance `publish`. The packages'
`prepublishOnly` hooks and `publish:packed` (DECISIONS D10) still refuse any HEAD other
than the actual `origin/publish` branch on GitHub. That guard predates the npm route and
contradicts it, so it is changed when the npm path is next used; it is not the rule.
`npm pack` and ordinary builds remain available on integration branches.

1. Prepare the reviewed release source and its final versions and dependency pins.
   Before installing dependencies, run the retained release scan against the last
   released source commit recorded on the release card:

   ```sh
   RELEASE_SCAN_SINCE=<last-released-source-sha> node .github/release-scan.mjs bun.lock
   bun install --frozen-lockfile
   bun run build
   ```

   Use the explicit source baseline; the retired Actions workflow no longer
   records releases. A scan failure stops preparation before installation.

2. Pack the built packages into a directory **outside the checkout**, core first,
   then client, then MCP. `--ignore-scripts` preserves the already built artifacts:

   ```sh
   npm pack ./packages/core --ignore-scripts --pack-destination "$artifact_dir"
   npm pack . --ignore-scripts --pack-destination "$artifact_dir"
   npm pack ./packages/mcp --ignore-scripts --pack-destination "$artifact_dir"
   ```

   Record the source SHA and each tarball's SHA-256. Sweep those exact tarballs
   with gitleaks' rules, custody values and `@volter/teams/redact`, without
   printing, copying or committing custody. Obtain the manager's permission once
   that sweep finds nothing. Permission names the exact source, target and tarball
   hashes; it is not implied by a merge, and it does not move `publish`.

3. Release from a clean checkout of that authorized source commit. Until the guard
   above is changed with the npm path, the next step's branch check refuses it.

4. From that checkout, publish the approved tarballs through the guarded door:

   ```sh
   bun run publish:packed "$artifact_dir/<core>.tgz" "$artifact_dir/<client>.tgz" "$artifact_dir/<mcp>.tgz"
   ```

   The command checks the branch on GitHub, prints each artifact's SHA-256 for
   comparison with the authorization, and publishes sequentially, stopping at
   the first npm failure. It accepts only existing `.tgz` files. It does not
   rebuild or change the tarballs. npm skips lifecycle hooks for tarball inputs,
   so use this command instead of calling `npm publish <tarball>` directly.
   Do not bypass the source hooks with `--ignore-scripts` when publishing a
   package directory. These guards prevent accidental publication; the operator
   still holds responsibility for the release authority and exact approved bytes.

5. Read back the versions and integrity from npm and retain the source, hashes,
   authorization and readback on the release card. No release step commits,
   rebases or pushes a version change back to main.
