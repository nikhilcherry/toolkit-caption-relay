# CaptionRelay

A tiny WebSocket broadcast server plus a reconnecting browser client, for
pushing JSON events from a laptop to phones/tablets on the same network.
Built for demos where a phone acts as a second screen, controller, or
smart-glasses stand-in.

## Quick start

```bash
npm install
node relay-server.js
```

Then, on the same Wi-Fi/hotspot:

- On the laptop, open `http://localhost:8788/demo/sender.html`.
- On the phone, open the URL the server prints on startup —
  `http://<your-lan-ip>:8788/demo/receiver.html`.

Type a caption and hit send, or toggle "send a test caption every 2s" — it
should show up on the phone within a second.

## Rooms

Any client connecting to `ws://host:8787/some-name` only exchanges messages
with other clients on that same path; clients that connect with no path land
in a shared `default` room.

## Reconnect & queueing

The client (`RelayClient`) auto-reconnects on a fixed interval whenever the
connection drops, until `close()` is called explicitly. While disconnected,
calls to `send()` are buffered (oldest messages dropped once the queue
exceeds `maxQueue`) and are flushed automatically the moment the connection
reopens — so killing and restarting the server mid-demo doesn't lose
captions, it just delays them.

## Composes with

Any app that wants a phone as a second display or controller — live
captions, dashboards, game controllers, remote triggers, or a stand-in for
smart glasses.
