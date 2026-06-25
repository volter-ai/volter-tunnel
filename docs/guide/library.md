# Library

`@volter/tunnel` is an embeddable library, not just a CLI. Use it to open a
tunnel programmatically, or to drive the relay's management/self-service API.

## `createTunnel`

```ts
import { createTunnel } from '@volter/tunnel/client'

const tunnel = await createTunnel({
  port: 3000,
  host: 'https://your-relay',
  tunnelId: 'my-app', // → https://my-app.your-relay
})

console.log(tunnel.url)
// … later
tunnel.close()
```

`createTunnel` resolves once the tunnel is registered and serving. The returned
handle exposes the public `url` and a `close()` to tear it down.

## `VolterClient`

A typed client for the relay's management/self-service API:

```ts
import { VolterClient } from '@volter/tunnel/client'

const client = new VolterClient({ host: 'https://your-relay', token })

const me = await client.whoami() // { slug, name, usage }

// root-token operations:
await client.createAccount({ slug: 'x', dayUsd: 10 })
```

## Resolution: Bun vs Node

The package ships dual `exports`:

- **Bun / TypeScript** resolve the `.ts` source directly.
- **Node** resolves the built ESM in `dist/`.

Either way the public surface is the same — `createTunnel` and `VolterClient`
from `@volter/tunnel/client`.

## The protocol contract

The wire protocol (message union, frame codec, DTOs) lives in its own package,
[`@volter/tunnel-core`](https://www.npmjs.com/package/@volter/tunnel-core), and
is consumed by both the client and the relay so the two can't drift. You
generally don't need it directly unless you're building against the protocol.
