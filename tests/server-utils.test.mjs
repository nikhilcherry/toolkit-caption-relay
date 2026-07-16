// Run with: node --test
//
// Pulled out of relay-server.js because importing that file starts a real
// WebSocketServer + http.Server as a side effect of module load -- never
// something a test should trigger. These are the server's pure decision
// logic: which room a connection lands in, which peers a message
// broadcasts to, and -- the one genuine security boundary in this repo --
// which filesystem path a request is allowed to read.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { getRoomFromUrl, resolveSafePath, broadcast } from '../server-utils.js';

const ROOT = '/srv/caption-relay';

// --- getRoomFromUrl ---

test('no path -> default room', () => {
  assert.equal(getRoomFromUrl('/'), 'default');
  assert.equal(getRoomFromUrl(''), 'default');
  assert.equal(getRoomFromUrl(undefined), 'default');
});

test('a named path -> that room, slashes trimmed', () => {
  assert.equal(getRoomFromUrl('/captions'), 'captions');
  assert.equal(getRoomFromUrl('/captions/'), 'captions');
});

test('a query string is ignored', () => {
  assert.equal(getRoomFromUrl('/captions?foo=bar'), 'captions');
});

test('a percent-encoded room name is decoded', () => {
  assert.equal(getRoomFromUrl('/team%20alpha'), 'team alpha');
});

// --- resolveSafePath: the security boundary ---

test('a normal file path resolves under root', () => {
  assert.equal(resolveSafePath('/demo/sender.html', ROOT), path.join(ROOT, 'demo/sender.html'));
});

test('the root path resolves to root itself', () => {
  // path.join(ROOT, '/') keeps a trailing separator -- compare normalized.
  assert.equal(path.normalize(resolveSafePath('/', ROOT)), path.normalize(ROOT + path.sep));
});

test('a query string does not leak into the resolved path', () => {
  assert.equal(resolveSafePath('/demo/sender.html?x=1', ROOT), path.join(ROOT, 'demo/sender.html'));
});

test('a plain ../ traversal is stripped, staying inside root', () => {
  const resolved = resolveSafePath('/../../../etc/passwd', ROOT);
  assert.ok(
    resolved.startsWith(ROOT + path.sep) || resolved === ROOT,
    `expected ${resolved} to stay inside ${ROOT}`,
  );
  assert.ok(!resolved.includes('etc' + path.sep + 'passwd') || resolved.startsWith(ROOT));
});

test('a deeply nested ../ traversal cannot escape root', () => {
  const resolved = resolveSafePath('/a/b/c/../../../../../../etc/passwd', ROOT);
  assert.ok(resolved.startsWith(ROOT + path.sep));
});

test('a percent-encoded ../ traversal is decoded then stripped', () => {
  // %2e%2e%2f = "../" -- decodeURIComponent happens before path.normalize,
  // so this must be caught the same as a literal "../".
  const resolved = resolveSafePath('/%2e%2e%2f%2e%2e%2fetc%2fpasswd', ROOT);
  assert.ok(resolved.startsWith(ROOT + path.sep));
});

test('a traversal that would land exactly on root does not escape to the parent', () => {
  const resolved = resolveSafePath('/..', ROOT);
  assert.ok(resolved === ROOT || resolved.startsWith(ROOT + path.sep));
});

test('every resolved path stays a descendant of root for a battery of attack strings', () => {
  const attacks = [
    '/../',
    '/../../',
    '/....//....//etc/passwd',
    '/demo/../../../../etc/passwd',
    '/%2e%2e/%2e%2e/etc/passwd',
    '/a/../../../b',
  ];
  for (const attack of attacks) {
    const resolved = resolveSafePath(attack, ROOT);
    assert.ok(
      resolved === ROOT || resolved.startsWith(ROOT + path.sep),
      `attack string ${JSON.stringify(attack)} escaped root: got ${resolved}`,
    );
  }
});

// --- broadcast ---

function fakeSocket(readyState = 1 /* OPEN */) {
  return { readyState, OPEN: 1, sent: [], send(data, opts) { this.sent.push({ data, opts }); } };
}

test('broadcast forwards to every other peer in the room, not the sender', () => {
  const sender = fakeSocket();
  const peerA = fakeSocket();
  const peerB = fakeSocket();
  const rooms = new Map([['captions', new Set([sender, peerA, peerB])]]);

  broadcast(rooms, 'captions', sender, 'hello', false);

  assert.equal(sender.sent.length, 0, 'the sender must never receive its own message back');
  assert.deepEqual(peerA.sent, [{ data: 'hello', opts: { binary: false } }]);
  assert.deepEqual(peerB.sent, [{ data: 'hello', opts: { binary: false } }]);
});

test('broadcast skips peers that are not OPEN', () => {
  const sender = fakeSocket();
  const closingPeer = fakeSocket(2 /* CLOSING, != OPEN(1) */);
  const rooms = new Map([['captions', new Set([sender, closingPeer])]]);

  broadcast(rooms, 'captions', sender, 'hello', false);

  assert.equal(closingPeer.sent.length, 0);
});

test('broadcast to an unknown room is a no-op, not a throw', () => {
  const rooms = new Map();
  assert.doesNotThrow(() => broadcast(rooms, 'nonexistent', fakeSocket(), 'hello', false));
});

test('broadcast never crosses rooms', () => {
  const senderA = fakeSocket();
  const peerA = fakeSocket();
  const peerB = fakeSocket(); // different room
  const rooms = new Map([
    ['room-a', new Set([senderA, peerA])],
    ['room-b', new Set([peerB])],
  ]);

  broadcast(rooms, 'room-a', senderA, 'hello', false);

  assert.equal(peerA.sent.length, 1);
  assert.equal(peerB.sent.length, 0);
});

test('broadcast passes the binary flag through unchanged', () => {
  const sender = fakeSocket();
  const peer = fakeSocket();
  const rooms = new Map([['r', new Set([sender, peer])]]);

  broadcast(rooms, 'r', sender, new Uint8Array([1, 2, 3]), true);

  assert.equal(peer.sent[0].opts.binary, true);
});
