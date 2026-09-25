# @volter/tunnel — Roadmap

A public free-tier tunnel (an ngrok/Cloudflare-Tunnel alternative whose headline differentiator is a
free, stable, reservable tunnel ID). The free tier is built and deployed on `voltertest.xyz` (signup, reserved IDs, idle reclaim and the owner-gated
inspector; persisted replay is a paid switch, `INSPECT_REPLAY`), and bandwidth and concurrency tiers are per-account configuration; the
rationale behind every item is [DECISIONS.md](./DECISIONS.md), whose D6 holds the policy defaults.

The open work, each item with what unblocks it, is [FUTURE.md](./FUTURE.md): BYO custom hostnames,
TCP/UDP tunnels, an OAuth-gating variant of the tunnel's access form, and the smaller items it lists.
