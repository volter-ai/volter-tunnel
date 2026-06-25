---
layout: home

hero:
  name: volter-tunnel
  text: Free, stable, reservable tunnels
  tagline: An open-source HTTP/WebSocket reverse tunnel — an ngrok / Cloudflare-Tunnel alternative whose headline feature is a free, stable, reservable subdomain that survives reconnects.
  actions:
    - theme: brand
      text: Get started
      link: /guide/getting-started
    - theme: alt
      text: Self-host a relay
      link: /self-hosting/deploy
    - theme: alt
      text: View on GitHub
      link: https://github.com/volter-ai/volter-tunnel

features:
  - title: Reservable subdomains
    details: Reserve a friendly subdomain once and keep it. It persists across reconnects, so your URL never changes.
  - title: Idle = free
    details: Built on Cloudflare Workers + Durable Objects with WebSocket Hibernation — one DO per tunnel, so idle tunnels cost ~nothing.
  - title: HTTP, streaming & WebSocket
    details: Relays plain HTTP, streamed responses, and full WebSocket traffic through the same tunnel.
  - title: Auth built in
    details: Gate a tunnel with basic-auth or JWT/cookie, or leave it open — your choice per tunnel.
  - title: Iframe-embeddable
    details: Strips frame-ancestors / X-Frame-Options so the tunneled app can be embedded in your own UI — no other OSS tunnel does this.
  - title: Live request inspector
    details: Watch every request flowing through your tunnel in real time.
---
