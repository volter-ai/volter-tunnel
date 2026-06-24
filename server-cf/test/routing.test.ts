/**
 * Unit tests for getTunnelIdFromHost — host→tunnelId routing, including wildcard
 * subdomains (P1 #9). Pure; no Worker needed.
 */
import { describe, expect, test } from 'vitest';
import { getTunnelIdFromHost } from '../src/auth';

const D = 'tunnel.test';

describe('getTunnelIdFromHost', () => {
  test('single-label subdomain → that id', () => {
    expect(getTunnelIdFromHost('app.tunnel.test', D)).toBe('app');
  });

  test('wildcard: multi-label subdomain → the label adjacent to the base domain', () => {
    expect(getTunnelIdFromHost('preview.app.tunnel.test', D)).toBe('app');
    expect(getTunnelIdFromHost('a.b.app.tunnel.test', D)).toBe('app');
  });

  test('port-tolerant', () => {
    expect(getTunnelIdFromHost('app.tunnel.test:8787', D)).toBe('app');
    expect(getTunnelIdFromHost('x.app.tunnel.test:443', D)).toBe('app');
  });

  test('apex, non-matching host, or null → null', () => {
    expect(getTunnelIdFromHost('tunnel.test', D)).toBe(null);
    expect(getTunnelIdFromHost('evil.example.com', D)).toBe(null);
    expect(getTunnelIdFromHost(null, D)).toBe(null);
  });
});
