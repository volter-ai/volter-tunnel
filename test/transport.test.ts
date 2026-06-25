/**
 * safeClose state-machine tests — the RST-avoidance logic that monkey-patches the
 * `ws` library. Driven against a fake socket so each readyState branch is
 * exercised without real network I/O.
 */
import { describe, expect, test } from 'bun:test';
import { safeClose } from '../client/transport.ts';

// ws readyState constants: CONNECTING=0, OPEN=1, CLOSING=2, CLOSED=3
class FakeWs {
  readyState: number;
  closed: { code?: number; reason?: string } | null = null;
  removed: string[] = [];
  handlers: Record<string, Array<() => void>> = {};
  terminated = false;
  _socket: undefined = undefined;
  _closeTimer: undefined = undefined;
  constructor(readyState: number) {
    this.readyState = readyState;
  }
  close(code?: number, reason?: string) {
    this.closed = { code, reason };
  }
  removeAllListeners(ev: string) {
    this.removed.push(ev);
  }
  on(ev: string, cb: () => void) {
    (this.handlers[ev] ??= []).push(cb);
    return this;
  }
  terminate() {
    this.terminated = true;
  }
  emit(ev: string) {
    for (const cb of this.handlers[ev] ?? []) cb();
  }
}

const sc = (ws: FakeWs, code?: number, reason?: string) => safeClose(ws as unknown as never, code, reason);

describe('safeClose', () => {
  test('CLOSED is a no-op', () => {
    const ws = new FakeWs(3);
    sc(ws);
    expect(ws.closed).toBeNull();
    expect(ws.terminated).toBe(false);
  });

  test('CLOSING does not call close() (only patches the error handler)', () => {
    const ws = new FakeWs(2);
    sc(ws);
    expect(ws.closed).toBeNull();
  });

  test('OPEN closes gracefully with the given code/reason', () => {
    const ws = new FakeWs(1);
    sc(ws, 1000, 'bye');
    expect(ws.closed).toEqual({ code: 1000, reason: 'bye' });
  });

  test('OPEN defaults to code 1000 / empty reason', () => {
    const ws = new FakeWs(1);
    sc(ws);
    expect(ws.closed).toEqual({ code: 1000, reason: '' });
  });

  test('CONNECTING strips relay listeners and arms open/error handlers (no RST)', () => {
    const ws = new FakeWs(0);
    sc(ws, 1000, 'x');
    // does NOT call close() while connecting (that would abortHandshake → RST)
    expect(ws.closed).toBeNull();
    // removes the message + open relay listeners
    expect(ws.removed).toContain('message');
    expect(ws.removed).toContain('open');
    // arms deferred open + error handlers
    expect(ws.handlers.open?.length).toBeGreaterThan(0);
    expect(ws.handlers.error?.length).toBeGreaterThan(0);
    // fire 'error' to clear the zombie timer so the test process can exit
    ws.emit('error');
  });

  test('CONNECTING → later open triggers a graceful close', () => {
    const ws = new FakeWs(0);
    sc(ws, 1001, 'later');
    ws.readyState = 1; // it opened
    ws.emit('open'); // deferred handler runs safeCloseOpen
    expect(ws.closed).toEqual({ code: 1001, reason: 'later' });
    ws.emit('error');
  });
});
