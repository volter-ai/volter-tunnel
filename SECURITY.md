# Security Policy

## Reporting a vulnerability

Please report security issues privately to **security@volter.ai** rather than
opening a public issue. Include steps to reproduce and the affected component
(client, relay, or a package). We aim to acknowledge reports within a few
business days.

## Scope notes

- The relay's threat model and hardening notes live in
  [docs/SECURITY.md](docs/SECURITY.md).
- `JWT_SECRET` is intentionally optional; with it unset, tunnels are publicly
  shareable and the inspector is independently owner-gated.
- GitHub tokens used for signup are verified once and discarded — never stored.
