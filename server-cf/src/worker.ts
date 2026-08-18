/**
 * Worker entry — routes every request to the Durable Object for its tunnelId.
 *
 * - Control channel: `…/ws?id=<tunnelId>` (WS upgrade) → DO(idFromName(id)).
 * - Data (HTTP or browser WS): `Host: <tunnelId>.<domain>` → DO(idFromName(tunnelId)).
 * - Apex (no subdomain): /api/status and the /__volter_auth cookie bootstrap.
 *
 * State is sharded per tunnel by construction: both the client's control socket
 * and inbound requests for a tunnel deterministically map to the same DO.
 */
import { type Env, getTunnelIdFromHost, handleCookieBootstrap } from './auth';
import { TunnelDO } from './tunnel-do';
import { AccountDO } from './account-do';
import { RegistryDO } from './registry-do';
import { docsPage, htmlResponse, landingPage } from './pages';

export { TunnelDO, AccountDO, RegistryDO };

function routeToDO(env: Env, name: string, request: Request): Promise<Response> {
  const id = env.TUNNEL.idFromName(name);
  return env.TUNNEL.get(id).fetch(request);
}

/** Subdomain labels that are NOT tunnels — they serve the apex front door /
 *  management plane instead (so `www.<domain>` shows the landing page rather
 *  than being a tunnel named "www", and nobody can reserve a tunnel that shadows
 *  them). Override via RESERVED_HOSTS (comma-separated); default `www`. */
function isReservedHost(env: Env, label: string): boolean {
  const raw = (env.RESERVED_HOSTS ?? 'www').toLowerCase();
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .includes(label.toLowerCase());
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Control channel — host-independent; the client names its DO via ?id=.
    if (url.pathname === '/ws') {
      const id = url.searchParams.get('id');
      if (!id) return new Response('missing tunnel id', { status: 400 });
      return routeToDO(env, id, request);
    }

    // Direct tunnel addressing for hosts without a per-tunnel subdomain — e.g.
    // *.workers.dev (Cloudflare rejects a foreign Host) or local testing.
    // `?__tunnel=<id>` is stripped before the request is forwarded downstream.
    // Gated to direct hosts only: on the production wildcard domain, tunnels must
    // be reached by their own subdomain so per-tunnel cookie/host isolation holds.
    const host = request.headers.get('host') || '';
    const isDirectHost =
      host.endsWith('.workers.dev') ||
      host.startsWith('127.0.0.1') ||
      host.startsWith('localhost') ||
      host.startsWith('0.0.0.0');
    const override = url.searchParams.get('__tunnel');
    if (override && isDirectHost) return routeToDO(env, override, request);

    const tunnelId = getTunnelIdFromHost(request.headers.get('host'), env.TUNNEL_DOMAIN);

    // On a tunnel subdomain EVERYTHING forwards to the tunnel — paths like
    // /admin, /signup, /report are management routes only on the apex, never on a
    // tunnel host (otherwise a tunneled app's own /signup page would be hijacked).
    // Reserved labels (e.g. `www`) are NOT tunnels — they fall through to the apex
    // front door below so `www.<domain>` serves the landing page.
    if (tunnelId && !isReservedHost(env, tunnelId)) return routeToDO(env, tunnelId, request);

    // Apex (no subdomain) or a reserved host: management plane (admin), self-serve
    // signup (#2,
    // unauthenticated — identity via GitHub), and abuse reports (#3). All share
    // the single RegistryDO.
    if (
      url.pathname === '/admin' ||
      url.pathname.startsWith('/admin/') ||
      url.pathname === '/signup' ||
      url.pathname.startsWith('/signup/') ||
      url.pathname === '/waitlist' ||
      url.pathname === '/report' ||
      url.pathname === '/me' ||
      url.pathname.startsWith('/me/')
    ) {
      const id = env.REGISTRY.idFromName('registry');
      return env.REGISTRY.get(id).fetch(request);
    }
    if (url.pathname.startsWith('/__volter_auth')) {
      return handleCookieBootstrap(request, url, env);
    }
    if (url.pathname === '/api/status') {
      return Response.json({ ok: true, relay: 'cloudflare-do' });
    }
    // Public front door (apex only): marketing landing + waitlist form, and docs.
    if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '')) {
      return htmlResponse(landingPage(env.TUNNEL_DOMAIN));
    }
    if (request.method === 'GET' && (url.pathname === '/docs' || url.pathname === '/docs/')) {
      return htmlResponse(docsPage(env.TUNNEL_DOMAIN));
    }
    return new Response('volter-tunnel (cloudflare)', { status: 200 });
  },
};
