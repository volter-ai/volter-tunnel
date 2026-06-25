/**
 * Read your volter-tunnel account + usage via the SDK.
 *
 *   VOLTER_HOST=https://your-relay VOLTER_TOKEN=<api-token> \
 *     bun run examples/account-usage.ts
 *
 * In your own project: import { VolterClient } from '@volter/tunnel/client';
 */
import { VolterClient } from '../client/api';
import { formatWhoami } from '../client/format';

const host = process.env.VOLTER_HOST ?? 'https://voltertest.xyz';
const token = process.env.VOLTER_TOKEN;
if (!token) {
  console.error('Set VOLTER_TOKEN (an api/login token).');
  process.exit(1);
}

const client = new VolterClient({ host, token });
const me = await client.whoami();
console.log(formatWhoami(me));
