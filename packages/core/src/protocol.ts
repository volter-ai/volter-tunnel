/**
 * The volter-tunnel control-channel wire protocol — the single source of truth
 * for the messages exchanged over the control WebSocket between a client and the
 * relay. Both the client and the relay import these types; a change here is a
 * change to the contract, type-checked on both sides.
 */
import type { AccountSnapshot, HeaderMap, RateWindow, UsageLevel } from './dto';

// ── client → relay ────────────────────────────────────────────────────────────

/** First frame the client sends; reserves a tunnel id and sets auth options. */
export interface RegisterMsg {
  type: 'register';
  /** Requested tunnel id; the relay generates one if omitted. */
  tunnelId?: string;
  /** Shared secret or api/login token authenticating the client. */
  secret?: string;
  /** Replace an existing live registration for this id (reconnect). */
  replace?: boolean;
  /** Whether inbound requests must pass the relay's JWT/cookie auth layer. */
  authRequired: boolean;
  /** Optional HTTP basic-auth gate applied to every inbound request. */
  basicAuth?: { user: string; pass: string };
}

/** A complete (buffered) response — used for relay-visible errors like 502. */
export interface ResponseMsg {
  type: 'response';
  reqId: number;
  status: number;
  headers: HeaderMap;
  /** base64-encoded body. */
  body: string;
}

/** Start of a streamed response (status + headers, body follows in chunks). */
export interface ResponseStartMsg {
  type: 'response-start';
  reqId: number;
  status: number;
  headers: HeaderMap;
}

/** One streamed response body chunk. */
export interface ResponseChunkMsg {
  type: 'response-chunk';
  reqId: number;
  /** base64-encoded chunk. */
  data: string;
}

/** End of a streamed response. */
export interface ResponseEndMsg {
  type: 'response-end';
  reqId: number;
}

/** The client connected to the local WebSocket and is ready to relay frames. */
export interface WsReadyMsg {
  type: 'ws-ready';
  connId: number;
}

/** The client failed to establish/maintain the local WebSocket. */
export interface WsErrorMsg {
  type: 'ws-error';
  connId: number;
  error: string;
}

// ── relay → client ────────────────────────────────────────────────────────────

/** Acknowledges a successful registration; carries the public URL + usage. */
export interface RegisteredMsg {
  type: 'registered';
  tunnelId: string;
  url: string;
  /** Present when the relay meters usage for this account. */
  account?: AccountSnapshot;
}

/** An inbound HTTP request to forward to the local server. */
export interface RequestMsg {
  type: 'request';
  reqId: number;
  method: string;
  path: string;
  headers: HeaderMap;
  /** base64-encoded body, or null for bodyless methods. */
  body: string | null;
}

/** The relay asks the client to abort an in-flight request. */
export interface RequestAbortMsg {
  type: 'request-abort';
  reqId: number;
}

/** An inbound browser WebSocket upgrade to bridge to the local server. */
export interface WsUpgradeMsg {
  type: 'ws-upgrade';
  connId: number;
  path: string;
  headers: HeaderMap;
}

/** Account usage level changed (ok ↔ warn ↔ exceeded). */
export interface QuotaMsg {
  type: 'quota';
  level: UsageLevel;
  day: RateWindow;
  month: RateWindow;
}

/** A terminal protocol/registration error from the relay. */
export interface ErrorMsg {
  type: 'error';
  message: string;
}

// ── bidirectional (same shape both ways) ──────────────────────────────────────

/** A WebSocket data frame relayed in either direction. */
export interface WsMessageMsg {
  type: 'ws-message';
  connId: number;
  /** base64-encoded frame payload. */
  data: string;
  binary: boolean;
}

/** A WebSocket close relayed in either direction. */
export interface WsCloseMsg {
  type: 'ws-close';
  connId: number;
  code?: number;
  reason?: string;
}

// ── unions ────────────────────────────────────────────────────────────────────

/** Frames a client sends to the relay. */
export type ClientToRelay =
  | RegisterMsg
  | ResponseMsg
  | ResponseStartMsg
  | ResponseChunkMsg
  | ResponseEndMsg
  | WsReadyMsg
  | WsErrorMsg
  | WsMessageMsg
  | WsCloseMsg;

/** Frames the relay sends to a client. */
export type RelayToClient =
  | RegisteredMsg
  | RequestMsg
  | RequestAbortMsg
  | WsUpgradeMsg
  | QuotaMsg
  | ErrorMsg
  | WsMessageMsg
  | WsCloseMsg;

/** Any control-channel message. */
export type ControlMessage = ClientToRelay | RelayToClient;

/** Every valid `type` discriminator, the authoritative registry. */
export const MESSAGE_TYPES = [
  'register',
  'response',
  'response-start',
  'response-chunk',
  'response-end',
  'ws-ready',
  'ws-error',
  'ws-message',
  'ws-close',
  'registered',
  'request',
  'request-abort',
  'ws-upgrade',
  'quota',
  'error',
] as const;

export type MessageType = (typeof MESSAGE_TYPES)[number];

const MESSAGE_TYPE_SET: ReadonlySet<string> = new Set(MESSAGE_TYPES);

/** True if `x` is an object with a known control-message `type` discriminator. */
export function isControlMessage(x: unknown): x is ControlMessage {
  return (
    typeof x === 'object' &&
    x !== null &&
    !Array.isArray(x) &&
    typeof (x as { type?: unknown }).type === 'string' &&
    MESSAGE_TYPE_SET.has((x as { type: string }).type)
  );
}
