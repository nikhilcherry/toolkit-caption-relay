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
  if (cleaned.length === 0) return DEFAULT_ROOM;
  try {
    return decodeURIComponent(cleaned);
  } catch {
    // Malformed percent-encoding (e.g. "/%"): fall back to the raw path
    // rather than letting a URIError crash the connection handler.
    return cleaned;
  }
}

/**
 * Resolves a request URL to a file under rootDir, preventing path
 * traversal (e.g. "/../../etc/passwd" or an encoded equivalent).
 * @param {string} url - the raw request URL.
 * @param {string} rootDir - absolute directory requests are served from.
 * @returns {string|null} an absolute path guaranteed to live inside rootDir,
 *   or null when the URL is malformed or resolves outside rootDir.
 */
export function resolveSafePath(url, rootDir) {
  let decoded;
  try {
    decoded = decodeURIComponent((url || '/').split('?')[0]);
  } catch {
    return null; // malformed percent-encoding
  }
  if (decoded.includes('\0')) return null;
  const normalized = path.normalize(decoded).replace(/^(\.\.[/\\])+/, '');
  const resolved = path.join(rootDir, normalized);
  // Belt and braces: the stripping above should already keep us inside
  // rootDir, but never return a path outside it no matter what.
  if (resolved !== rootDir && !resolved.startsWith(path.normalize(rootDir + path.sep))) {
    return null;
  }
  return resolved;
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
