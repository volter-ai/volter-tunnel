/**
 * Frame codec — how control messages are serialized onto the WebSocket. Today
 * that's newline-free JSON; isolating it here means the transport (binary,
 * compression, …) can change without touching call sites.
 */
import { type ControlMessage, isControlMessage } from './protocol';

/** Serialize a control message to its wire form. */
export function encodeFrame(msg: ControlMessage): string {
  return JSON.stringify(msg);
}

/**
 * Parse a wire frame back into a typed control message. Returns `null` for
 * anything that isn't valid JSON describing a known message type, so callers can
 * safely ignore garbage instead of throwing.
 */
export function decodeFrame(raw: string): ControlMessage | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return isControlMessage(parsed) ? parsed : null;
}
