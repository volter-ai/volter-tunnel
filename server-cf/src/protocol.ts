/**
 * Relay-side access to the shared @volter/tunnel-core protocol contract.
 *
 * server-cf builds via wrangler/esbuild and tests via vitest — both transpile
 * TypeScript — so we import the core source directly. The single cross-package
 * relative path is isolated to this file; the rest of the relay imports
 * './protocol', and every outbound control frame goes through the typed
 * `sendFrame`, so the relay can no longer drift from the contract.
 */
export * from '../../packages/core/src/index';
import { encodeFrame, type RelayToClient } from '../../packages/core/src/index';

/** Anything a control frame can be written to (the Cloudflare control WebSocket). */
export interface FrameSink {
  send(data: string): void;
}

/** Send a typed relay→client control frame (compile-time checked vs the contract). */
export function sendFrame(ws: FrameSink, msg: RelayToClient): void {
  ws.send(encodeFrame(msg));
}
