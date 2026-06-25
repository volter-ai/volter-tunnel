/**
 * @volter/tunnel-core — the shared wire-protocol contract for volter-tunnel.
 *
 * Pure, dependency-free, runtime-agnostic: types + a frame codec + DTOs that the
 * client SDK and the relay both import, so the two sides can never drift.
 */
export * from './dto';
export * from './protocol';
export * from './frame';
