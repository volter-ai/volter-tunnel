# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- **`@volter/tunnel-core`** — the shared wire-protocol contract (message union,
  frame codec, DTOs). Pure, 100% covered, consumed by both client and relay.
- **`@volter/tunnel-mcp`** — an MCP server exposing account/usage/abuse tools for
  AI agents.
- **`VolterClient`** SDK (`@volter/tunnel/client`) — typed self-service +
  admin client over the relay API.
- **CLI subcommands** — `volter-tunnel whoami | usage | account <…>`.
- **Relay `GET /me`** — a service/api token can read its own account + usage.
- Monorepo tooling: bun workspaces, Biome lint/format, GitHub Actions CI, Apache
  LICENSE + NOTICE, CONTRIBUTING + CODE_OF_CONDUCT, issue/PR templates, examples.

### Changed

- Client refactored into layers: **core → transport → sdk → cli**.
- Relay emits every control frame through a typed `sendFrame` bound to the shared
  contract (was untyped object literals).

### Security

- Signup **fails closed**: an unset/empty `SIGNUP_ALLOWED_USERS` no longer means
  open signup — open mode requires an explicit `SIGNUP_OPEN=true`.
- `GET /me` rejects tokens of **suspended** accounts.
- Removed the hardcoded gist-nonce HMAC fallback (`'volter-signup'`); the gist
  endpoints fail closed when no signup secret is configured.

### Fixed

- `reqId`/`connId` were typed `number` but the Cloudflare relay emits UUID
  **strings**; corrected to a `CorrelationId = string | number` union across the
  protocol, client, and tests.
- Deduplicated DTOs into `@volter/tunnel-core`: removed a dead/divergent
  `Reservation` type and unified the `AccountUsage`/usage-window shape (was
  triplicated across client + relay).
- Default relay host is now the public demo (`voltertest.xyz`) instead of a
  personal `workers.dev` URL.
- CI relay job uses a frozen `bun install` (was unpinned `npm install`); removed
  the broken CI badge / fabricated repo references; corrected stale test counts
  and the internal-vs-free limit docs.

### License

- Project relicensed to **Apache-2.0** (was UNLICENSED).
