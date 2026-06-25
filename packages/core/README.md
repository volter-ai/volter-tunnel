# @volter/tunnel-core

The shared **wire-protocol contract** for volter-tunnel: the
control-channel message types, a frame codec, and the DTOs that cross the wire.

Pure, dependency-free, and runtime-agnostic — imported by **both** the client and
the relay so the two sides can never drift. Held to **100% test coverage**.

```ts
import {
  type ControlMessage,
  type RelayToClient,
  encodeFrame,
  decodeFrame,
  isControlMessage,
  MESSAGE_TYPES,
} from '@volter/tunnel-core';

const raw = encodeFrame({ type: 'response-end', reqId: 'abc' });
const msg = decodeFrame(raw); // ControlMessage | null (null on junk/unknown type)
```

## What's in here

- **`protocol.ts`** — every control message as a discriminated union
  (`ClientToRelay`, `RelayToClient`, `ControlMessage`), the `MESSAGE_TYPES`
  registry, and the `isControlMessage` guard.
- **`frame.ts`** — `encodeFrame` / `decodeFrame` (JSON framing today; isolated so
  the transport can evolve without touching call sites).
- **`dto.ts`** — `RateWindow`, `UsageLevel`, `AccountSnapshot`, `Reservation`, and
  `CorrelationId` (`string | number` — the CF relay uses UUID strings, the Fly
  relay numeric counters; clients treat it opaquely).

## Develop

```bash
cd packages/core && bun test   # runs the 100% coverage gate (bunfig.toml)
```

Licensed under Apache-2.0.
