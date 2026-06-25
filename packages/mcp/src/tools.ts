/**
 * MCP tool definitions for volter-tunnel — transport-agnostic so they're unit
 * testable. Each tool is `{ name, description, inputSchema (zod shape), run }`;
 * `run(args)` returns the text an agent sees. server.ts maps these onto an
 * McpServer. All logic delegates to the SDK (VolterClient).
 */
import { z } from 'zod';
import type { VolterClient } from '../../../client/api';
import { formatUsage, formatWhoami } from '../../../client/format';

export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: z.ZodRawShape;
  run(args: Record<string, unknown>): Promise<string>;
}

const pretty = (v: unknown): string => JSON.stringify(v, null, 2);

/** Build the tool set bound to a configured client. Self-service tools work with
 *  an api/login token; the account_* and abuse tools need the root token. */
export function buildTools(client: VolterClient): ToolSpec[] {
  const slug = { slug: z.string().describe('Account slug, e.g. gh-12345') };
  const usd = {
    dayUsd: z.number().optional().describe('Daily spend cap in USD'),
    monthUsd: z.number().optional().describe('Monthly spend cap in USD'),
  };
  const usdBody = (a: Record<string, unknown>): Record<string, number> => {
    const b: Record<string, number> = {};
    if (typeof a.dayUsd === 'number') b.dayUsd = a.dayUsd;
    if (typeof a.monthUsd === 'number') b.monthUsd = a.monthUsd;
    return b;
  };

  return [
    {
      name: 'whoami',
      description: "Show the caller's own volter-tunnel account and usage.",
      inputSchema: {},
      run: async () => formatWhoami(await client.whoami()),
    },
    {
      name: 'usage',
      description: "Show the caller's current usage (credits/dollars, today and this month).",
      inputSchema: {},
      run: async () => formatUsage((await client.whoami()).usage),
    },
    {
      name: 'account_list',
      description: 'List all accounts with their usage and dollar spend (root).',
      inputSchema: {},
      run: async () => pretty(await client.usageSummary()),
    },
    {
      name: 'account_usage',
      description: "Get one account's detailed usage (root).",
      inputSchema: { ...slug },
      run: async (a) => pretty(await client.accountUsage(String(a.slug))),
    },
    {
      name: 'account_create',
      description: 'Create a free-tier-style account with optional dollar limits (root).',
      inputSchema: { ...slug, ...usd },
      run: async (a) => pretty(await client.createAccount({ slug: String(a.slug), ...usdBody(a) })),
    },
    {
      name: 'account_limits',
      description: "Update an account's daily/monthly dollar limits (root).",
      inputSchema: { ...slug, ...usd },
      run: async (a) => pretty(await client.patchLimits(String(a.slug), usdBody(a))),
    },
    {
      name: 'account_suspend',
      description: 'Suspend an account (root).',
      inputSchema: { ...slug },
      run: async (a) => pretty(await client.setStatus(String(a.slug), 'suspended')),
    },
    {
      name: 'account_resume',
      description: 'Resume a suspended account (root).',
      inputSchema: { ...slug },
      run: async (a) => pretty(await client.setStatus(String(a.slug), 'active')),
    },
    {
      name: 'reports',
      description: 'List user-submitted abuse reports (root).',
      inputSchema: {},
      run: async () => pretty(await client.reports()),
    },
    {
      name: 'waitlist',
      description: 'List pending signup waitlist requests (root).',
      inputSchema: {},
      run: async () => pretty(await client.waitlist()),
    },
    {
      name: 'revoke_reservation',
      description: 'Revoke a reserved tunnel id, freeing it and disconnecting any client (root).',
      inputSchema: { tunnelId: z.string().describe('The reserved tunnel id to revoke') },
      run: async (a) => pretty(await client.revokeReservation(String(a.tunnelId))),
    },
  ];
}
