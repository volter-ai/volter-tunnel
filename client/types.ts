/**
 * Public types for the volter-tunnel client library: the logger contract and the
 * createTunnel options/handle shapes. Re-exported from ./tunnel-client.
 */

export interface TunnelLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  debug(obj: Record<string, unknown>, msg: string): void;
}

export interface TunnelOptions {
  /** Local port to expose */
  port: number;
  /** Tunnel server URL (e.g., "https://vgit-tunnels.volterapp.com") */
  host: string;
  /** Requested tunnel ID (optional — server generates one if omitted) */
  tunnelId?: string;
  /** Shared secret for tunnel server authentication */
  secret?: string;
  /** Whether the tunnel requires JWT auth for incoming requests (default: true) */
  authRequired?: boolean;
  /** Optional HTTP Basic Auth gate: every inbound request must present these
   *  credentials (independent of the JWT layer). Handy for protecting a shared
   *  dev tunnel without wiring JWTs. */
  basicAuth?: { user: string; pass: string };
  /** Logger instance (defaults to console-based logger) */
  logger?: TunnelLogger;
}

export interface TunnelHandle {
  /** Public tunnel URL (e.g., "https://quick-fox-123.vgit-tunnels.volterapp.com") */
  url: string;
  /** Assigned tunnel ID */
  tunnelId: string;
  /** Close the tunnel connection */
  close: () => void;
}
