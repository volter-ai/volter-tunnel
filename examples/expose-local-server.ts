/**
 * Expose a local HTTP server through a volter-tunnel.
 *
 *   bun run examples/expose-local-server.ts
 *
 * Starts a tiny demo server, opens a tunnel to it, and prints the public URL.
 * In your own project, import from the published package:
 *   import { createTunnel } from '@volter/tunnel/client';
 */
import http from 'node:http';
import { createTunnel } from '../client/tunnel-client';

const PORT = 8787;
const HOST = process.env.VOLTER_HOST ?? 'https://voltertest.xyz';

// A demo origin to expose.
const server = http.createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/plain' });
  res.end('hello from your local server, tunneled by volter-tunnel\n');
});
await new Promise<void>((r) => server.listen(PORT, '127.0.0.1', r));
console.log(`local demo server on http://127.0.0.1:${PORT}`);

const tunnel = await createTunnel({
  port: PORT,
  host: HOST,
  tunnelId: 'example-app', // omit for a random id; needs an account to reserve
  authRequired: false,
  logger: { info() {}, warn() {}, debug() {} },
});

console.log(`\npublic URL:  ${tunnel.url}`);
console.log('Ctrl+C to stop.\n');

const shutdown = () => {
  tunnel.close();
  server.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
