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

### Fixed

- `reqId`/`connId` were typed `number` but the Cloudflare relay emits UUID
  **strings**; corrected to a `CorrelationId = string | number` union across the
  protocol, client, and tests.

### License

- Project relicensed to **Apache-2.0** (was UNLICENSED).
