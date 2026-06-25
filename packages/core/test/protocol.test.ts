/**
 * Protocol contract — the single source of truth for the volter-tunnel wire
 * protocol. Written test-first: these assertions define the codec + type
 * registry that both the client and the relay must agree on.
 */
import { describe, expect, test } from 'bun:test';
import {
  decodeFrame,
  encodeFrame,
  isControlMessage,
  MESSAGE_TYPES,
  type ControlMessage,
} from '../src/index';

// One representative value for every message in the protocol, both directions.
const samples: ControlMessage[] = [
  // client → relay
  { type: 'register', tunnelId: 'my-app', secret: 's', replace: true, authRequired: true },
  { type: 'register', authRequired: false, basicAuth: { user: 'u', pass: 'p' } },
  { type: 'response', reqId: 1, status: 200, headers: { 'content-type': 'text/plain' }, body: 'AAAA' },
  { type: 'response-start', reqId: 2, status: 201, headers: { 'x-a': 'b' } },
  { type: 'response-chunk', reqId: 2, data: 'AAAA' },
  { type: 'response-end', reqId: 2 },
  { type: 'ws-ready', connId: 7 },
  { type: 'ws-message', connId: 7, data: 'AAAA', binary: false },
  { type: 'ws-close', connId: 7, code: 1000, reason: 'bye' },
  { type: 'ws-error', connId: 7, error: 'boom' },
  // relay → client
  {
    type: 'registered',
    tunnelId: 'my-app',
    url: 'https://my-app.example.com',
    account: {
      slug: 'gh-1',
      day: { limit: 10, remaining: 9, reset: 1 },
      month: { limit: 100, remaining: 90, reset: 2 },
      level: 'ok',
    },
  },
  { type: 'request', reqId: 3, method: 'GET', path: '/', headers: { host: 'x' }, body: null },
  { type: 'request-abort', reqId: 3 },
  // CorrelationId is a union: the Cloudflare relay uses UUID strings.
  { type: 'request', reqId: 'a1b2-uuid', method: 'POST', path: '/x', headers: {}, body: 'AAAA' },
  { type: 'response-end', reqId: 'a1b2-uuid' },
  { type: 'ws-message', connId: 'c-uuid', data: 'AAAA', binary: true },
  { type: 'ws-upgrade', connId: 8, path: '/socket', headers: { 'sec-websocket-protocol': 'vite-hmr' } },
  {
    type: 'quota',
    level: 'warn',
    day: { limit: 10, remaining: 1, reset: 1 },
    month: { limit: 100, remaining: 50, reset: 2 },
  },
  { type: 'error', message: 'nope' },
];

describe('frame codec', () => {
  test('round-trips every control message', () => {
    for (const m of samples) {
      expect(decodeFrame(encodeFrame(m))).toEqual(m);
    }
  });

  test('decodeFrame returns null on invalid input', () => {
    expect(decodeFrame('not json at all')).toBeNull();
    expect(decodeFrame('{"type":"bogus"}')).toBeNull();
    expect(decodeFrame('{"no":"type"}')).toBeNull();
    expect(decodeFrame('123')).toBeNull();
    expect(decodeFrame('null')).toBeNull();
    expect(decodeFrame('[]')).toBeNull();
  });

  test('encodeFrame produces parseable JSON', () => {
    const raw = encodeFrame({ type: 'response-end', reqId: 9 });
    expect(typeof raw).toBe('string');
    expect(JSON.parse(raw)).toEqual({ type: 'response-end', reqId: 9 });
  });
});

describe('type registry + guards', () => {
  test('MESSAGE_TYPES contains every sample type', () => {
    for (const m of samples) {
      expect(MESSAGE_TYPES).toContain(m.type);
    }
  });

  test('every MESSAGE_TYPES entry is unique', () => {
    expect(new Set(MESSAGE_TYPES).size).toBe(MESSAGE_TYPES.length);
  });

  test('isControlMessage narrows valid messages and rejects junk', () => {
    expect(isControlMessage({ type: 'request', reqId: 1, method: 'GET', path: '/', headers: {}, body: null })).toBe(true);
    expect(isControlMessage({ type: 'bogus' })).toBe(false);
    expect(isControlMessage(null)).toBe(false);
    expect(isControlMessage('x')).toBe(false);
    expect(isControlMessage(42)).toBe(false);
    expect(isControlMessage({})).toBe(false);
  });
});
