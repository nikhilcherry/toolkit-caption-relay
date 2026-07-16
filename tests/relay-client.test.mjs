// Run with: node --test
//
// RelayClient constructs a real WebSocket the moment it's instantiated, so
// every test replaces globalThis.WebSocket with a small fake that records
// what's sent and lets the test drive open/message/close/error by hand --
// no real socket or server involved.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RelayClient } from '../relay-client.js';

class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  constructor(url) {
    this.url = url;
    this.readyState = FakeWebSocket.CONNECTING;
    this.sent = [];
    this._listeners = {};
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type, handler) {
    (this._listeners[type] ??= []).push(handler);
  }

  send(data) {
    this.sent.push(data);
  }

  close() {
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.readyState = FakeWebSocket.CLOSED;
    this._emit('close');
  }

  _emit(type, arg) {
    for (const h of this._listeners[type] || []) h(arg);
  }

  // --- test-only helpers simulating server-side events ---
  _open() {
    this.readyState = FakeWebSocket.OPEN;
    this._emit('open');
  }

  _receive(data) {
    this._emit('message', { data });
  }

  _serverClose() {
    this.readyState = FakeWebSocket.CLOSED;
    this._emit('close');
  }
}

async function withFakeWebSocket(fn) {
  const real = globalThis.WebSocket;
  FakeWebSocket.instances = [];
  globalThis.WebSocket = FakeWebSocket;
  try {
    // Must await here, not just return the promise: restoring the real
    // WebSocket has to happen strictly after fn()'s body (including any
    // internal awaits, e.g. waiting out a reconnect timer) finishes --
    // otherwise a reconnect firing after this returns would construct a
    // REAL WebSocket instead of the fake, silently breaking the test.
    return await fn();
  } finally {
    globalThis.WebSocket = real;
  }
}

// --- URL building ---

test('_fullUrl: default room appends nothing', () => withFakeWebSocket(() => {
  const relay = new RelayClient('ws://host:8787');
  assert.equal(relay._fullUrl(), 'ws://host:8787');
  relay.close();
}));

test('_fullUrl: room is appended as a path segment', () => withFakeWebSocket(() => {
  const relay = new RelayClient('ws://host:8787', { room: 'captions' });
  assert.equal(relay._fullUrl(), 'ws://host:8787/captions');
  relay.close();
}));

test('_fullUrl: trailing slash on base url and leading slash on room are both trimmed once', () => withFakeWebSocket(() => {
  const relay = new RelayClient('ws://host:8787/', { room: '/captions' });
  assert.equal(relay._fullUrl(), 'ws://host:8787/captions');
  relay.close();
}));

// --- sending while open vs. queued while not ---

test('send() writes immediately once the socket is open', () => withFakeWebSocket(() => {
  const relay = new RelayClient('ws://host:8787');
  relay._ws._open();
  relay.send({ text: 'hi' });
  assert.deepEqual(relay._ws.sent, [JSON.stringify({ text: 'hi' })]);
  relay.close();
}));

test('send() before the socket opens queues instead of throwing', () => withFakeWebSocket(() => {
  const relay = new RelayClient('ws://host:8787');
  relay.send({ text: 'queued' });
  assert.equal(relay._ws.sent.length, 0);
  assert.equal(relay._queue.length, 1);
  relay.close();
}));

test('queued messages flush in order the moment the socket opens', () => withFakeWebSocket(() => {
  const relay = new RelayClient('ws://host:8787');
  relay.send({ n: 1 });
  relay.send({ n: 2 });
  relay.send({ n: 3 });
  relay._ws._open();
  assert.deepEqual(relay._ws.sent, [
    JSON.stringify({ n: 1 }),
    JSON.stringify({ n: 2 }),
    JSON.stringify({ n: 3 }),
  ]);
  assert.equal(relay._queue.length, 0);
  relay.close();
}));

test('the queue drops the oldest message once maxQueue is exceeded', () => withFakeWebSocket(() => {
  const relay = new RelayClient('ws://host:8787', { maxQueue: 2 });
  relay.send({ n: 1 });
  relay.send({ n: 2 });
  relay.send({ n: 3 }); // over capacity -- {n:1} must be dropped
  assert.deepEqual(relay._queue, [
    JSON.stringify({ n: 2 }),
    JSON.stringify({ n: 3 }),
  ]);
  relay.close();
}));

// --- incoming messages ---

test('a valid JSON message is parsed and emitted', () => withFakeWebSocket(() => {
  const relay = new RelayClient('ws://host:8787');
  const received = [];
  relay.on('message', (obj) => received.push(obj));
  relay._ws._open();
  relay._ws._receive(JSON.stringify({ hello: 'world' }));
  assert.deepEqual(received, [{ hello: 'world' }]);
  relay.close();
}));

test('a non-JSON message is ignored, not thrown or emitted', () => withFakeWebSocket(() => {
  const relay = new RelayClient('ws://host:8787');
  const received = [];
  relay.on('message', (obj) => received.push(obj));
  relay._ws._open();
  assert.doesNotThrow(() => relay._ws._receive('not json{'));
  assert.deepEqual(received, []);
  relay.close();
}));

// --- status + open/close events ---

test('status transitions connecting -> open -> closed, and open/close events fire', () => withFakeWebSocket(() => {
  const relay = new RelayClient('ws://host:8787', { reconnectMs: 0 });
  assert.equal(relay.status, 'connecting');

  const opened = [];
  const closed = [];
  relay.on('open', () => opened.push(1));
  relay.on('close', () => closed.push(1));

  relay._ws._open();
  assert.equal(relay.status, 'open');
  assert.deepEqual(opened, [1]);

  relay._ws._serverClose();
  assert.equal(relay.status, 'closed');
  assert.deepEqual(closed, [1]);
}));

// --- reconnect ---

test('an unexpected close schedules a reconnect that opens a new socket', async () => {
  await withFakeWebSocket(async () => {
    const relay = new RelayClient('ws://host:8787', { reconnectMs: 15 });
    const first = relay._ws;
    first._open();
    first._serverClose(); // unexpected drop, not relay.close()

    assert.equal(relay.status, 'connecting');
    assert.equal(FakeWebSocket.instances.length, 1, 'reconnect must not fire synchronously');

    await new Promise((resolve) => setTimeout(resolve, 30));

    assert.equal(FakeWebSocket.instances.length, 2, 'a new socket must have been constructed');
    assert.notEqual(relay._ws, first);
    relay.close();
  });
});

test('reconnectMs: 0 disables auto-reconnect entirely', async () => {
  await withFakeWebSocket(async () => {
    const relay = new RelayClient('ws://host:8787', { reconnectMs: 0 });
    relay._ws._open();
    relay._ws._serverClose();

    await new Promise((resolve) => setTimeout(resolve, 30));

    assert.equal(FakeWebSocket.instances.length, 1);
    assert.equal(relay.status, 'closed');
  });
});

test('close() marks the disconnect intentional and suppresses reconnect', async () => {
  await withFakeWebSocket(async () => {
    const relay = new RelayClient('ws://host:8787', { reconnectMs: 15 });
    relay._ws._open();
    relay.close(); // triggers the fake's own close(), which fires 'close'

    await new Promise((resolve) => setTimeout(resolve, 30));

    assert.equal(FakeWebSocket.instances.length, 1, 'an intentional close must not reconnect');
    assert.equal(relay.status, 'closed');
  });
});

test('a message queued during a reconnect gap flushes once the new socket opens', async () => {
  await withFakeWebSocket(async () => {
    const relay = new RelayClient('ws://host:8787', { reconnectMs: 15 });
    relay._ws._open();
    relay._ws._serverClose();

    relay.send({ text: 'sent while reconnecting' });
    assert.equal(relay._queue.length, 1);

    await new Promise((resolve) => setTimeout(resolve, 30));
    relay._ws._open();

    assert.deepEqual(relay._ws.sent, [JSON.stringify({ text: 'sent while reconnecting' })]);
    assert.equal(relay._queue.length, 0);
    relay.close();
  });
});
