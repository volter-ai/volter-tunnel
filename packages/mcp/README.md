# @volter/tunnel-mcp

An [MCP](https://modelcontextprotocol.io) server that exposes
volter-tunnel account/usage/abuse operations as tools, so AI
agents can manage a relay over the same SDK the CLI uses.

## Run

```bash
VOLTER_HOST=https://your-relay \
VOLTER_TOKEN=<token> \
  bunx @volter/tunnel-mcp        # stdio MCP server
```

- `VOLTER_TOKEN` is an **api/login token** for self-service tools (`whoami`,
  `usage`), or the **root token** (`vtr_…`) to enable the admin tools.
- `VOLTER_HOST` defaults to `https://voltertest.xyz`.

Example client config (Claude Desktop / any MCP host):

```json
{
  "mcpServers": {
    "volter-tunnel": {
      "command": "bunx",
      "args": ["@volter/tunnel-mcp"],
      "env": { "VOLTER_HOST": "https://your-relay", "VOLTER_TOKEN": "vtr_…" }
    }
  }
}
```

## Tools

`whoami`, `usage`, `reservations`, `release_reservation`, `tokens`,
`restore_token`, `revoke_token`, `account_list`, `account_usage`, `account_create`,
`account_limits`, `account_suspend`, `account_resume`, `reports`, `waitlist`,
`revoke_reservation`.

The tool layer (`src/tools.ts`) is transport-agnostic and held to **100%
coverage**; `src/server.ts` is the thin stdio wiring.

Licensed under Apache-2.0.
