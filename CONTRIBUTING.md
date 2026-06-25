# Contributing to volter-tunnel

Thanks for your interest! This is a small, well-tested codebase and we'd like to
keep it that way.

## Layout (monorepo)

```
packages/core/   @volter/tunnel-core — the wire-protocol contract (types + codec).
                 Pure, dependency-free, 100% covered. Both sides import it.
client/          @volter/tunnel — the client: core ← transport ← sdk (createTunnel
                 + VolterClient) ← cli (the bin). Also the api/format SDK helpers.
packages/mcp/    @volter/tunnel-mcp — an MCP server exposing account/usage tools.
server-cf/       the Cloudflare Workers + Durable Objects relay (primary).
server/          a legacy single-process Fly relay (same protocol).
```

The protocol is defined **once** in `packages/core`; the client and the relay
both consume it, so they can't drift. Don't re-declare message shapes elsewhere.

## Development

Prereqs: [Bun](https://bun.sh) and Node 22.

```bash
bun install
bun run typecheck                 # client + core + mcp
cd packages/core && bun test      # protocol contract (100% gate)
cd packages/mcp  && bun test      # MCP tools (coverage gate)
bun test ./test                   # client SDK + CLI
cd server-cf && npm install && npx vitest run   # relay (real workerd)
```

CI (`.github/workflows/ci.yml`) runs all of the above on every PR.

## Ground rules

- **Test-first.** New behavior comes with tests. Pure modules (`core`, the SDK
  `api`/`format`, MCP `tools`) are held to **100% coverage** via `bunfig.toml`
  gates — keep them there.
- **Behavior-preserving refactors stay green.** The relay suite runs the real
  `createTunnel` client against `workerd` end-to-end; treat it as the safety net.
- **One protocol source.** Wire-format changes go in `packages/core` and nowhere
  else; the typechecker will flag any divergence on either side.
- **Don't break the deploy.** `server-cf` ships via `wrangler`; run
  `npx wrangler deploy --dry-run` if you touch the bundle/imports.
- Conventional-commit style messages (`feat:`, `fix:`, `refactor:`, `test:`…).

## Reporting security issues

See [docs/SECURITY.md](docs/SECURITY.md). Please do not open public issues for
vulnerabilities.
