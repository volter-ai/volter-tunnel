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

export { TunnelDO };

function routeToDO(env: Env, name: string, request: Request): Promise<Response> {
  const id = env.TUNNEL.idFromName(name);
  return env.TUNNEL.get(id).fetch(request);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Control channel — the client tells us which DO it belongs to via ?id=.
    if (url.pathname === '/ws') {
      const id = url.searchParams.get('id');
      if (!id) return new Response('missing tunnel id', { status: 400 });
      return routeToDO(env, id, request);
    }

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
