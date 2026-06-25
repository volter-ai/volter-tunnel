# Examples

Runnable from the repo root with [Bun](https://bun.sh):

```bash
# 1) Expose a local HTTP server through a tunnel (starts a demo server for you)
bun run examples/expose-local-server.ts

# 2) Read your account + usage via the SDK (needs a token)
VOLTER_HOST=https://your-relay VOLTER_TOKEN=<api-token> \
  bun run examples/account-usage.ts
```

In your own project these import from the published package instead:

```ts
import { createTunnel, VolterClient } from '@volter/tunnel/client';
```
