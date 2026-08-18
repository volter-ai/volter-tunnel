/**
 * wireTools tests — every tool registers, and a thrown handler becomes an MCP
 * error result instead of crashing. Fake register + stub client; no transport.
 */
import { describe, expect, test } from 'bun:test';
import type { VolterClient } from '../../../client/api';
import { type RegisterFn, type ToolResult, wireTools } from '../src/wire';

const usage = {
  slug: 'gh-1',
  status: 'active' as const,
  day: { used: 0, leased: 0, limit: 1, remaining: 1, pct: 0 },
  month: { used: 0, leased: 0, limit: 1, remaining: 1, pct: 0 },
  openTunnels: 0,
  concurrentMax: 1,
  reservedTunnels: [],
  reservedMax: 3,
  resetAt: { day: 'd', month: 'm' },
  usd: { dayUsed: 0, dayLimit: 0, monthUsed: 0, monthLimit: 0 },
};

function fakeRegister(): {
  register: RegisterFn;
  handlers: Map<string, (a: Record<string, unknown>) => Promise<ToolResult>>;
} {
  const handlers = new Map<string, (a: Record<string, unknown>) => Promise<ToolResult>>();
  const register: RegisterFn = (name, _config, handler) => {
    handlers.set(name, handler);
  };
  return { register, handlers };
}

describe('wireTools', () => {
  test('registers every tool', () => {
    const { register, handlers } = fakeRegister();
    wireTools(register, { whoami: () => Promise.resolve({ slug: 'gh-1', usage }) } as unknown as VolterClient);
    expect(handlers.has('whoami')).toBe(true);
    expect(handlers.size).toBe(16);
  });

  test('a successful handler returns a text content result', async () => {
    const { register, handlers } = fakeRegister();
    wireTools(register, {
      whoami: () => Promise.resolve({ slug: 'gh-1', name: 'github:octocat', usage }),
    } as unknown as VolterClient);
    const res = await handlers.get('whoami')!({});
    expect(res.isError).toBeUndefined();
    expect(res.content[0].text).toContain('Logged in as github:octocat');
  });

  test('a thrown handler becomes an MCP error result, not a crash', async () => {
    const { register, handlers } = fakeRegister();
    wireTools(register, {
      whoami: () => Promise.reject(new Error('boom')),
    } as unknown as VolterClient);
    const res = await handlers.get('usage')!({});
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toBe('boom');
  });
});
