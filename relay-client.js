/**
 * CaptionRelay browser client — a zero-dependency ES module that connects
 * to a CaptionRelay server, auto-reconnects when the connection drops, and
 * queues outgoing messages while disconnected so a flaky demo network
 * never loses a message on the floor.
 *
 * @example
 * import { RelayClient } from './relay-client.js';
 *
 * const relay = new RelayClient('ws://192.168.1.5:8787', {
 *   room: 'captions',
 *   reconnectMs: 1500,
 *   maxQueue: 50,
 * });
 *
 * relay.on('open', () => console.log('connected'));
 * relay.on('message', (obj) => console.log('got', obj));
 * relay.send({ who: 'Speaker 1', text: 'hello' });
 */

/**
 * Minimal inline event emitter — just enough for on/off/emit.
 */
class EventEmitter {
  constructor() {
    /** @type {Map<string, Set<Function>>} */
    this._listeners = new Map();
  }

  /**
   * Registers a listener for an event.
   * @param {string} event - event name, e.g. "open", "close", "message".
   * @param {Function} handler - callback invoked when the event fires.
   * @returns {void}
   */
  on(event, handler) {
    if (!this._listeners.has(event)) this._listeners.set(event, new Set());
    this._listeners.get(event).add(handler);
  }

  /**
   * Removes a previously registered listener.
   * @param {string} event - event name.
   * @param {Function} handler - the exact handler reference passed to on().
   * @returns {void}
   */
  off(event, handler) {
    this._listeners.get(event)?.delete(handler);
  }

  /**
   * Invokes all listeners registered for an event.
   * @param {string} event - event name.
   * @param {...*} args - arguments passed through to each handler.
   * @returns {void}
   */
  emit(event, ...args) {
    for (const handler of this._listeners.get(event) || []) {
      handler(...args);
    }
  }
}

/**
 * A reconnecting WebSocket client for pushing/receiving JSON events.
 */
export class RelayClient extends EventEmitter {
  /**
   * @param {string} url - base WebSocket URL, e.g. "ws://192.168.1.5:8787".
   * @param {Object} [options]
   * @param {string} [options.room] - room name appended as the URL path. Omit for the default room.
   * @param {number} [options.reconnectMs=1500] - auto-reconnect interval in ms. 0 disables reconnect.
   * @param {number} [options.maxQueue=50] - max messages buffered while disconnected (oldest dropped beyond this).
   */
  constructor(url, options = {}) {
    super();
    this.baseUrl = url.replace(/\/+$/, '');
    this.room = options.room ?? '';
    this.reconnectMs = options.reconnectMs ?? 1500;
    this.maxQueue = options.maxQueue ?? 50;

    /** @type {'connecting'|'open'|'closed'} */
    this.status = 'connecting';

    /** @type {string[]} */
    this._queue = [];

    /** @type {WebSocket|null} */
    this._ws = null;

    /** @type {ReturnType<typeof setTimeout>|null} */
    this._reconnectTimer = null;

    this._intentionallyClosed = false;

    this._connect();
  }

  /**
   * Builds the full WebSocket URL, including the room path when set.
   * @returns {string}
   */
  _fullUrl() {
    const room = this.room ? `/${this.room.replace(/^\/+/, '')}` : '';
    return `${this.baseUrl}${room}`;
  }

  /**
   * Opens the underlying WebSocket connection and wires up its handlers.
   * @returns {void}
   */
  _connect() {
    this.status = 'connecting';
    const ws = new WebSocket(this._fullUrl());
    this._ws = ws;

    ws.addEventListener('open', () => {
      this.status = 'open';
      this._flushQueue();
      this.emit('open');
    });

    ws.addEventListener('message', (event) => {
      let parsed;
      try {
        parsed = JSON.parse(event.data);
      } catch (err) {
        console.warn('[RelayClient] ignoring non-JSON message:', event.data);
        return;
      }
      this.emit('message', parsed);
    });

    ws.addEventListener('close', () => {
      this.status = 'closed';
      this.emit('close');
      if (!this._intentionallyClosed && this.reconnectMs > 0) {
        this._scheduleReconnect();
      }
    });

    // A "close" event always follows "error" per the WebSocket spec, so the
    // reconnect logic lives entirely in the close handler above. Calling
    // ws.close() here would recurse: close() re-triggers the failure path,
    // which fires another "error" event.
    ws.addEventListener('error', () => {});
  }

  /**
   * Schedules a single reconnect attempt after reconnectMs.
   * @returns {void}
   */
  _scheduleReconnect() {
    if (this._reconnectTimer) return;
    this.status = 'connecting';
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      this._connect();
    }, this.reconnectMs);
  }

  /**
   * Sends everything currently queued, then clears the queue.
   * @returns {void}
   */
  _flushQueue() {
    while (this._queue.length > 0 && this._ws?.readyState === WebSocket.OPEN) {
      this._ws.send(this._queue.shift());
    }
  }

  /**
   * Sends a JSON-serializable object to every other connected client in
   * the room. If disconnected, the message is queued (oldest dropped
   * beyond maxQueue) and flushed automatically on reconnect.
   * @param {Object} obj - a JSON-serializable payload.
   * @returns {void}
   */
  send(obj) {
    const data = JSON.stringify(obj);
    if (this._ws?.readyState === WebSocket.OPEN) {
      this._ws.send(data);
      return;
    }
    this._queue.push(data);
    while (this._queue.length > this.maxQueue) {
      this._queue.shift();
    }
  }

  /**
   * Intentionally closes the connection and disables auto-reconnect.
   * @returns {void}
   */
  close() {
    this._intentionallyClosed = true;
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    this.status = 'closed';
    this._ws?.close();
  }
}
