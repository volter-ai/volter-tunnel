## What & why

<!-- What does this change and why? Link any issue. -->

## Checklist

- [ ] Tests added/updated (pure modules stay at 100% coverage)
- [ ] `bun run typecheck` passes
- [ ] Relevant suites pass (`packages/core`, `packages/mcp`, `./test`, `server-cf`)
- [ ] Wire-protocol changes (if any) live in `packages/core` only
- [ ] If `server-cf` changed: `npx wrangler deploy --dry-run` builds
