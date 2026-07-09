#!/usr/bin/env node
/**
 * CaptionRelay server — a tiny WebSocket fan-out broadcaster plus a static
 * file server for the demo pages. Any message a client sends is forwarded
 * verbatim to every OTHER client connected to the same room (the sender
 * never receives its own message back).
 *
 * Rooms are just the WebSocket connection path: ws://host:8787/my-room
 * puts a client in room "my-room". Connecting to ws://host:8787/ (no path)
 * puts a client in the "default" room.
 *
 * Usage:
 *   node relay-server.js
 *   PORT=9000 node relay-server.js        # override the WebSocket port
 *   HTTP_PORT=9001 node relay-server.js   # override the static HTTP port
 */

import { WebSocketServer } from 'ws';
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const WS_PORT = Number(process.env.PORT) || 8787;
const HTTP_PORT = Number(process.env.HTTP_PORT) || 8788;
const DEFAULT_ROOM = 'default';

const ROOT_DIR = path.dirname(fileURLToPath(import.meta.url));

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

/** @type {Map<string, Set<import('ws').WebSocket>>} room name -> set of sockets in that room */
const rooms = new Map();

/**
 * Extracts the room name from a WebSocket connection's request URL.
 * @param {string} [url] - the raw request URL, e.g. "/captions".
 * @returns {string} the room name, or "default" when no path is given.
 */
function getRoomFromUrl(url) {
  const cleaned = (url || '/').split('?')[0].replace(/^\/+|\/+$/g, '');
  return cleaned.length > 0 ? decodeURIComponent(cleaned) : DEFAULT_ROOM;
}

/**
 * Forwards raw data to every OTHER open socket in the same room.
 * @param {string} room - the room to broadcast within.
 * @param {import('ws').WebSocket} sender - the socket the message came from (excluded).
 * @param {import('ws').RawData} data - the raw message payload, forwarded verbatim.
 * @param {boolean} isBinary - whether the original frame was binary.
 * @returns {void}
 */
function broadcast(room, sender, data, isBinary) {
  const peers = rooms.get(room);
  if (!peers) return;
  for (const peer of peers) {
    if (peer !== sender && peer.readyState === peer.OPEN) {
      peer.send(data, { binary: isBinary });
    }
  }
}

const wss = new WebSocketServer({ port: WS_PORT });

wss.on('connection', (ws, req) => {
  const room = getRoomFromUrl(req.url);
  if (!rooms.has(room)) rooms.set(room, new Set());
  const peers = rooms.get(room);
  peers.add(ws);
  console.log(`[connect]    room="${room}" clients=${peers.size}`);

  ws.on('message', (data, isBinary) => {
    broadcast(room, ws, data, isBinary);
  });

  ws.on('close', () => {
    peers.delete(ws);
    if (peers.size === 0) rooms.delete(room);
    console.log(`[disconnect] room="${room}" clients=${peers.size}`);
  });

  ws.on('error', (err) => {
    console.warn(`[error]      room="${room}" ${err.message}`);
  });
});

/**
 * Resolves a request URL to a file under ROOT_DIR, preventing path traversal.
 * @param {string} url - the raw request URL.
 * @returns {string} an absolute path guaranteed to live inside ROOT_DIR.
 */
function resolveSafePath(url) {
  const decoded = decodeURIComponent((url || '/').split('?')[0]);
  const normalized = path.normalize(decoded).replace(/^(\.\.[/\\])+/, '');
  return path.join(ROOT_DIR, normalized);
}

const httpServer = createServer(async (req, res) => {
  try {
    let filePath = resolveSafePath(req.url);
    let stats = await stat(filePath).catch(() => null);

    if (stats?.isDirectory()) {
      filePath = path.join(filePath, 'index.html');
      stats = await stat(filePath).catch(() => null);
    }

    if (!stats || !stats.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const body = await readFile(filePath);
    res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' });
    res.end(body);
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end('Internal server error');
  }
});

httpServer.listen(HTTP_PORT);

/**
 * Enumerates LAN-reachable IPv4 addresses (192.168.* / 10.*) across all
 * network interfaces, so the demo can print a URL a phone can actually use.
 * @returns {string[]} list of LAN IPv4 addresses.
 */
function getLanIps() {
  const nets = networkInterfaces();
  const ips = [];
  for (const iface of Object.values(nets)) {
    for (const addr of iface || []) {
      if (
        addr.family === 'IPv4' &&
        !addr.internal &&
        (addr.address.startsWith('192.168.') || addr.address.startsWith('10.'))
      ) {
        ips.push(addr.address);
      }
    }
  }
  return ips;
}

const lanIps = getLanIps();

console.log('CaptionRelay server running');
console.log(`  WebSocket : ws://localhost:${WS_PORT}`);
console.log(`  HTTP      : http://localhost:${HTTP_PORT}`);
if (lanIps.length === 0) {
  console.log('  LAN IPs   : none found (are you on a hotspot/Wi-Fi?)');
} else {
  console.log('  LAN IPs:');
  for (const ip of lanIps) {
    console.log(`    ws://${ip}:${WS_PORT}`);
    console.log(`    http://${ip}:${HTTP_PORT}/demo/sender.html`);
    console.log(`    http://${ip}:${HTTP_PORT}/demo/receiver.html   <- open this on the phone`);
  }
}
