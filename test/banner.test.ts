/**
 * Unit test for the CLI connection banner (P1 #8). The QR itself is a best-effort
 * visual side-effect (optional dependency + TTY), so only the pure banner string
 * is asserted here.
 */
import { describe, expect, test } from 'bun:test';
import { formatConnectBanner } from '../client/cli.ts';

describe('formatConnectBanner', () => {
  test('shows the public URL and the forwarded local port', () => {
    const banner = formatConnectBanner('https://my-app.tunnel.dev', 3000);
    expect(banner).toContain('https://my-app.tunnel.dev');
    expect(banner).toContain('localhost:3000');
    expect(banner).toContain('Tunnel live');
  });

  test('puts the URL on its own line for easy copy', () => {
    const banner = formatConnectBanner('https://x.tunnel.dev', 8080);
    const urlLine = banner.split('\n').find((l) => l.includes('https://x.tunnel.dev'));
    expect(urlLine?.trim()).toBe('https://x.tunnel.dev');
  });
});
