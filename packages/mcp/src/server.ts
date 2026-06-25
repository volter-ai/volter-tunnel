#!/usr/bin/env node
/**
 * volter-tunnel MCP server (stdio). Wires the SDK-backed tools onto an McpServer
 * so an AI agent can manage accounts, read usage, and act on abuse reports.
 *
 * Config via env:
 *   VOLTER_HOST   relay base URL (default https://voltertest.xyz)
 *   VOLTER_TOKEN  bearer token — an api/login token for self-service, or the
 *                 root token (vtr_…) to enable the account_* / abuse tools.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { VolterClient } from '../../../client/api';
import { buildTools } from './tools';

const host = process.env.VOLTER_HOST ?? 'https://voltertest.xyz';
const token = process.env.VOLTER_TOKEN;
if (!token) {
  console.error('VOLTER_TOKEN is required (an api/login token, or the root token for admin tools).');
  process.exit(1);
}

const client = new VolterClient({ host, token });
const server = new McpServer({ name: 'volter-tunnel', version: '0.1.0' });

// The SDK's registerTool is generic over the (dynamic) input schema, which trips
// "excessively deep" inference here. Bind it through a narrow signature — the
// runtime contract is unchanged; only the call-site types are relaxed.
type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };
const register = server.registerTool.bind(server) as unknown as (
  name: string,
  config: { description: string; inputSchema: unknown },
  handler: (args: Record<string, unknown>) => Promise<ToolResult>
) => void;

for (const tool of buildTools(client)) {
  register(tool.name, { description: tool.description, inputSchema: tool.inputSchema }, async (args) => {
    try {
      return { content: [{ type: 'text', text: await tool.run(args) }] };
    } catch (e) {
      return { isError: true, content: [{ type: 'text', text: e instanceof Error ? e.message : String(e) }] };
    }
  });
}

await server.connect(new StdioServerTransport());
console.error(`volter-tunnel MCP server ready (host ${host})`);
