/**
 * Pure helpers pulled out of relay-server.js so they're testable without
 * starting a real WebSocketServer/http.Server -- importing relay-server.js
 * itself binds real ports as a side effect of module load, which a test
 * runner should never trigger.
 */

import path from 'node:path';

const DEFAULT_ROOM = 'default';

/**
 * Extracts the room name from a WebSocket connection's request URL.
 * @param {string} [url] - the raw request URL, e.g. "/captions".
 * @returns {string} the room name, or "default" when no path is given.
 */
export function getRoomFromUrl(url) {
  const cleaned = (url || '/').split('?')[0].replace(/^\/+|\/+$/g, '');
  return cleaned.length > 0 ? decodeURIComponent(cleaned) : DEFAULT_ROOM;
}

/**
 * Resolves a request URL to a file under rootDir, preventing path
 * traversal (e.g. "/../../etc/passwd" or an encoded equivalent).
 * @param {string} url - the raw request URL.
 * @param {string} rootDir - absolute directory requests are served from.
 * @returns {string} an absolute path guaranteed to live inside rootDir.
 */
export function resolveSafePath(url, rootDir) {
  const decoded = decodeURIComponent((url || '/').split('?')[0]);
  const normalized = path.normalize(decoded).replace(/^(\.\.[/\\])+/, '');
  return path.join(rootDir, normalized);
}

/**
 * Forwards raw data to every OTHER open socket in the same room.
 * @param {Map<string, Set<any>>} rooms - room name -> set of sockets.
 * @param {string} room - the room to broadcast within.
 * @param {any} sender - the socket the message came from (excluded).
 * @param {any} data - the raw message payload, forwarded verbatim.
 * @param {boolean} isBinary - whether the original frame was binary.
 * @returns {void}
 */
export function broadcast(rooms, room, sender, data, isBinary) {
  const peers = rooms.get(room);
  if (!peers) return;
  for (const peer of peers) {
    if (peer !== sender && peer.readyState === peer.OPEN) {
      peer.send(data, { binary: isBinary });
    }
  }
}
