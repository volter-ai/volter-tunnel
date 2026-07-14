/**
 * Unit tests for response-header handling (P1 #7): the always-on iframe strip
 * (CSP frame-ancestors / X-Frame-Options) plus the operator-configurable
 * set/remove rule list. Pure — no Worker needed.
 */
import { describe, expect, test } from 'vitest';
import { buildResponseHeaders, corsHeaders, parseHeaderRules } from '../src/auth';

const req = (origin?: string) =>
  new Request('https://app.tunnel.test/', origin ? { headers: { origin } } : undefined);

describe('buildResponseHeaders — built-in iframe strip (always on)', () => {
  test('removes x-frame-options and the frame-ancestors directive, keeps the rest of the CSP', () => {
    const h = buildResponseHeaders(
      {
        'x-frame-options': 'DENY',
        'content-security-policy': "default-src 'self'; frame-ancestors 'none'",
        'content-type': 'text/html',
      },
      req()
    );
    expect(h.get('x-frame-options')).toBeNull();
    expect(h.get('content-security-policy')).toBe("default-src 'self'");
    expect(h.get('content-type')).toBe('text/html');
  });

  test('drops the CSP header entirely when frame-ancestors was its only directive', () => {
    const h = buildResponseHeaders({ 'content-security-policy': "frame-ancestors 'none'" }, req());
    expect(h.get('content-security-policy')).toBeNull();
  });

  test('re-applies our CORS for the request origin', () => {
    const h = buildResponseHeaders({}, req('https://parent.example'));
    expect(h.get('access-control-allow-origin')).toBe('https://parent.example');
    expect(h.get('access-control-allow-credentials')).toBe('true');
  });
});

describe('buildResponseHeaders — operator rules', () => {
  test('set overrides downstream; remove deletes', () => {
    const rules = parseHeaderRules('{"set":{"X-Foo":"bar"},"remove":["x-powered-by"]}');
    const h = buildResponseHeaders(
      { 'x-powered-by': 'Express', 'x-foo': 'old' },
      req(),
      null,
      rules
    );
    expect(h.get('x-powered-by')).toBeNull();
    expect(h.get('x-foo')).toBe('bar');
  });

  test('rules cannot un-strip frame-ancestors — the built-in strip runs first', () => {
    // Even if an operator tries to re-assert X-Frame-Options via set, that is their
    // explicit choice; but a downstream frame-ancestors is still gone by default.
    const h = buildResponseHeaders(
      { 'content-security-policy': "frame-ancestors 'none'; default-src *" },
      req(),
      null,
      parseHeaderRules('{"set":{}}')
    );
    expect(h.get('content-security-policy')).toBe('default-src *');
  });
});

describe('parseHeaderRules — tolerant parsing', () => {
  test('undefined / malformed JSON → empty rules', () => {
    expect(parseHeaderRules(undefined)).toEqual({});
    expect(parseHeaderRules('not json')).toEqual({});
    expect(parseHeaderRules('[]')).toEqual({});
  });

  test('lower-cases header names and drops non-string values', () => {
    expect(parseHeaderRules('{"set":{"X-A":"1","X-B":2},"remove":["X-C",3]}')).toEqual({
      set: { 'x-a': '1' },
      remove: ['x-c'],
    });
  });
});

describe('corsHeaders — preflight allow-headers reflection', () => {
  const preflight = (requested?: string) =>
    new Request('https://app.tunnel.test/', {
      method: 'OPTIONS',
      headers: {
        origin: 'https://runhuman.example',
        ...(requested ? { 'access-control-request-headers': requested } : {}),
      },
    });

  test('reflects Access-Control-Request-Headers verbatim (custom app headers pass preflight)', () => {
    const h = corsHeaders(preflight('content-type, authorization, x-active-tenant-id'));
    expect(h['access-control-allow-headers']).toBe('content-type, authorization, x-active-tenant-id');
    expect(h['access-control-allow-origin']).toBe('https://runhuman.example');
    expect(h['access-control-allow-credentials']).toBe('true');
  });

  test('falls back to the fixed list when no request-headers hint is present', () => {
    const h = corsHeaders(preflight());
    expect(h['access-control-allow-headers']).toBe('Content-Type, Authorization, X-Sandbox-Id');
  });

  test('no origin → no CORS headers at all', () => {
    expect(corsHeaders(new Request('https://app.tunnel.test/'))).toEqual({});
  });
});
