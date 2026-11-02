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
import { type RegisterFn, wireTools } from './wire';

const host = process.env.VOLTER_HOST ?? 'https://voltertest.xyz';
const token = process.env.VOLTER_TOKEN;
if (!token) {
  console.error('VOLTER_TOKEN is required (an api/login token, or the root token for admin tools).');
  process.exit(1);
}

const server = new McpServer({ name: 'volter-tunnel', version: '0.1.0' });
// The SDK's registerTool is generic over the (dynamic) schema, which trips
// "excessively deep" inference; bind it through the narrow RegisterFn signature.
wireTools(server.registerTool.bind(server) as unknown as RegisterFn, new VolterClient({ host, token }));

await server.connect(new StdioServerTransport());
console.error(`volter-tunnel MCP server ready (host ${host})`);
