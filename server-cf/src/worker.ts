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

export { TunnelDO, AccountDO, RegistryDO };

function routeToDO(env: Env, name: string, request: Request): Promise<Response> {
  const id = env.TUNNEL.idFromName(name);
  return env.TUNNEL.get(id).fetch(request);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Management plane — token/account/usage admin. Routed to the single
    // RegistryDO, which authenticates (root or service token) and coordinates.
    // Self-serve signup (#2) is unauthenticated by design — it establishes
    // identity via GitHub — and shares the same RegistryDO.
    if (
      url.pathname === '/admin' ||
      url.pathname.startsWith('/admin/') ||
      url.pathname === '/signup' ||
      url.pathname.startsWith('/signup/')
    ) {
      const id = env.REGISTRY.idFromName('registry');
      return env.REGISTRY.get(id).fetch(request);
    }

    // Control channel — the client tells us which DO it belongs to via ?id=.
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

    if (!tunnelId) {
      if (url.pathname.startsWith('/__volter_auth')) {
        return handleCookieBootstrap(request, url, env);
      }
      if (url.pathname === '/api/status') {
        return Response.json({ ok: true, relay: 'cloudflare-do' });
      }
      return new Response('volter-tunnel (cloudflare)', { status: 200 });
    }

    return routeToDO(env, tunnelId, request);
  },
};
