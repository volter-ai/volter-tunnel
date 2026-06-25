# MCP server

[`@volter/tunnel-mcp`](https://www.npmjs.com/package/@volter/tunnel-mcp) is an
[MCP](https://modelcontextprotocol.io) server that exposes volter-tunnel
account/usage/abuse operations as tools, so AI agents can manage a relay over the
same SDK the CLI uses.

## Run

```bash
VOLTER_HOST=https://your-relay \
VOLTER_TOKEN=<token> \
  bunx @volter/tunnel-mcp        # stdio MCP server
```

- `VOLTER_TOKEN` is an **api/login token** for the self-service tools (`whoami`,
  `usage`), or the **root token** (`vtr_…`) to enable the admin tools.
- `VOLTER_HOST` defaults to `https://voltertest.xyz`.

## Client config

Example for an MCP host (e.g. Claude Desktop):

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

`whoami`, `usage`, `account_list`, `account_usage`, `account_create`,
`account_limits`, `account_suspend`, `account_resume`, `reports`, `waitlist`,
`revoke_reservation`.

The admin tools (`account_*`, `reports`, `waitlist`, `revoke_reservation`)
require the root token; the self-service tools work with any api token.
