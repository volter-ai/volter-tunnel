/**
 * Wires the SDK-backed tools onto an MCP-server-like `register` function. Kept
 * separate from server.ts (which owns the stdio transport) so the registration +
 * error-wrapping is unit-testable without a real McpServer.
 */
import type { VolterClient } from '../../../client/api';
import { buildTools } from './tools';

export type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };

/** A minimal view of McpServer.registerTool (the SDK's is too generic to call
 *  with a dynamic schema without tripping "excessively deep" inference). */
export type RegisterFn = (
  name: string,
  config: { description: string; inputSchema: unknown },
  handler: (args: Record<string, unknown>) => Promise<ToolResult>
) => void;

/** Register every tool, wrapping each handler so a thrown error becomes an MCP
 *  error result (`isError: true`) rather than crashing the server. */
export function wireTools(register: RegisterFn, client: VolterClient): void {
  for (const tool of buildTools(client)) {
    register(tool.name, { description: tool.description, inputSchema: tool.inputSchema }, async (args) => {
      try {
        return { content: [{ type: 'text', text: await tool.run(args) }] };
      } catch (e) {
        return { isError: true, content: [{ type: 'text', text: e instanceof Error ? e.message : String(e) }] };
      }
    });
  }
}
