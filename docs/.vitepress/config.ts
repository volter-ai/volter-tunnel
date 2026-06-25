import { defineConfig } from 'vitepress'

// User-facing documentation site for volter-tunnel.
// Internal development docs (decisions, roadmap, backlog, publishing) live in
// /dev-docs and are intentionally NOT part of this site.
export default defineConfig({
  title: 'volter-tunnel',
  description:
    'Open-source HTTP/WebSocket reverse tunnel with free, stable, reservable subdomains. Built on Cloudflare Workers + Durable Objects.',
  // Project page served at https://volter-ai.github.io/volter-tunnel/
  base: '/volter-tunnel/',
  cleanUrls: true,
  lastUpdated: true,
  themeConfig: {
    nav: [
      { text: 'Guide', link: '/guide/getting-started' },
      { text: 'Self-hosting', link: '/self-hosting/deploy' },
      { text: 'Reference', link: '/reference/security' },
      {
        text: 'npm',
        items: [
          { text: '@volter/tunnel', link: 'https://www.npmjs.com/package/@volter/tunnel' },
          { text: '@volter/tunnel-core', link: 'https://www.npmjs.com/package/@volter/tunnel-core' },
          { text: '@volter/tunnel-mcp', link: 'https://www.npmjs.com/package/@volter/tunnel-mcp' },
        ],
      },
    ],
    sidebar: [
      {
        text: 'Guide',
        items: [
          { text: 'Getting started', link: '/guide/getting-started' },
          { text: 'CLI', link: '/guide/cli' },
          { text: 'Library', link: '/guide/library' },
          { text: 'MCP server', link: '/guide/mcp' },
        ],
      },
      {
        text: 'Self-hosting',
        items: [
          { text: 'Deploy a relay', link: '/self-hosting/deploy' },
          { text: 'Metering & accounts', link: '/self-hosting/metering' },
        ],
      },
      {
        text: 'Reference',
        items: [{ text: 'Security model', link: '/reference/security' }],
      },
    ],
    socialLinks: [{ icon: 'github', link: 'https://github.com/volter-ai/volter-tunnel' }],
    search: { provider: 'local' },
    editLink: {
      pattern: 'https://github.com/volter-ai/volter-tunnel/edit/main/docs/:path',
      text: 'Edit this page on GitHub',
    },
    footer: {
      message: 'Apache-2.0 licensed.',
      copyright: 'Copyright © 2026 Volter',
    },
  },
})
