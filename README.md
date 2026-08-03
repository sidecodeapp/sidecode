# Thinkite

> Spin up and drive Claude Code sessions on your Mac — from your phone, peer-to-peer.

https://github.com/user-attachments/assets/2c0ddbf5-c364-4b09-a652-70e64ad2fbcf

<p align="center">
  <a href="https://thinkite.dev/mac"><img alt="Download for macOS" src="https://img.shields.io/badge/Download-macOS-000000?style=for-the-badge&logo=apple&logoColor=white" /></a>
  <a href="https://thinkite.dev/ios"><img alt="iOS via TestFlight" src="https://img.shields.io/badge/iOS-TestFlight-0D96F6?style=for-the-badge&logo=apple&logoColor=white" /></a>
</p>

<p align="center">
  <img alt="platform: macOS + iOS" src="https://img.shields.io/badge/platform-macOS%20%2B%20iOS-black" />
  <img alt="license: Apache-2.0" src="https://img.shields.io/badge/license-Apache--2.0-blue" />
  <img alt="status: early / V0" src="https://img.shields.io/badge/status-V0-orange" />
</p>

**Thinkite lets you start, stream, and steer Claude Code sessions on your Mac from your phone.**
A lightweight daemon on your Mac orchestrates the sessions; the iOS app connects to it **directly,
peer-to-peer** over a WebRTC link, so your prompts, responses, and diffs stream straight between
your own devices — no third-party server can read your session data.

---

## Features

- **Start sessions from your phone** — pick any folder on your Mac and kick off a fresh
  Claude Code session remotely. You don't have to be at your desk to begin.
- **Peer-to-peer & private** — session traffic flows device-to-device over a DTLS-encrypted
  WebRTC DataChannel. A Cloudflare TURN relay is used only as a NAT fallback, and even then
  it only ever forwards already-encrypted bytes.
- **Bridge to the cloud, on demand** — keep a session private P2P, or flip a single session to
  also mirror onto **claude.ai and Claude Desktop** for cross-client control — then flip it back.
  Your choice, per session.
- **Resilient streaming** — drop your connection mid-response and reconnect; the daemon replays
  exactly the events you missed.
- **Real mobile rendering** — Claude's markdown stays both **text-selectable and syntax-highlighted**;
  tool diffs open in a fast, syntax-highlighted diff view.
- **Every session at a glance** — a live drawer shows the status of all your sessions.

---

## How it works

```
                  QR pair (Ed25519 pubkey, out-of-band trust root)
   ┌──────────────┐ ──────────────────────────────────────────► ┌─────────────────────┐
   │   iOS app    │                                              │     macOS daemon     │
   │  (Expo / RN) │ ◄════════ WebRTC DataChannel (P2P) ════════► │   (Node + TS)        │
   └──────┬───────┘             DTLS, end-to-end                 │   orchestrates       │
          │                                                      │   Claude Code via    │
          │                                                      │   the Agent SDK      │
          ▼                                                      └─────────────────────┘
   ┌────────────────────────────────┐
   │ Cloudflare Worker + Durable     │ ──── SDP/ICE signaling + TURN NAT fallback ────►
   │ Object  (connection broker)     │      (brokers the handshake only; never sees
   └────────────────────────────────┘       your session data)
```

The Mac **daemon** is the orchestration layer: it spawns and supervises Claude Code via the
Claude Agent SDK, manages session lifecycle, and exposes sessions to paired clients over a
typed wire protocol. The **iOS app** is a thin, real-time client. A **Cloudflare Worker +
Durable Object** brokers the initial WebRTC handshake (and provides a TURN fallback), then
steps out of the way — application traffic is peer-to-peer.

### Under the hood

- **Private by default, mirror on demand** — sessions run over a direct P2P WebRTC link; a bridged
  session tees the same event stream to Anthropic's cloud (claude.ai / Claude Desktop) without
  dropping it.
- **Authenticated pairing** — pairing exchanges an Ed25519 public key via QR; the WebRTC DTLS
  fingerprint is signed under that key, so even a compromised signaling server can't MITM the
  connection.
- **Resumable protocol** — a cursor + epoch-fenced event stream lets reconnecting clients replay
  only missed events, with a full-snapshot fallback when the daemon restarts.
- **Optimistic local state** — sessions and transcripts live in TanStack DB collections; writes
  apply optimistically and roll back on rejection, while the daemon's push stream reconciles them
  and re-snapshots on reconnect.
- **Hybrid markdown renderer** — native attributed-string prose (selectable) + custom components
  for syntax-highlighted code, bridging a tradeoff pure-native and WebView renderers can't.
- **Pre-warmed diff view** — a resident, pre-warmed WebView hosting the Shiki-based
  [`@pierre/diffs`](https://diffs.com) renderer keeps tool-diff opens fast.

---

## Security & privacy

- **End-to-end encryption.** Session traffic rides a WebRTC DataChannel secured with DTLS,
  encrypted between your two devices.
- **The relay can't read your data.** The Cloudflare signaling server only brokers connection
  setup (SDP/ICE); it is never in the data path. The TURN fallback only ever relays
  already-encrypted bytes.
- **Your credentials stay on your Mac.** The daemon uses your existing Claude login from the
  system keychain. Thinkite never reads, stores, or transmits your tokens.

---

## Getting started

**Prerequisites**

- macOS (Apple Silicon)
- A logged-in Claude account — sign in once with the Claude Code CLI (`claude /login`) or Claude Desktop
- An iPhone

**Install**

1. **[Download Thinkite for macOS](https://thinkite.dev/mac)** and drag it to Applications.
2. Launch Thinkite — the daemon starts automatically, and the app stays resident in your tray.
3. **[Get the iOS app](https://thinkite.dev/ios)** (TestFlight).
4. From the tray menu, choose **Pair new device** and scan the QR with the app.
5. Create a session (pick a project folder) and start prompting.

---

## Project structure

This is a bun monorepo:

| Package | What it is |
|---|---|
| `packages/app` | iOS client — Expo / React Native |
| `packages/daemon` | macOS daemon — wraps the Claude Agent SDK, WebRTC peer, session orchestration, cloud bridge |
| `packages/desktop` | macOS desktop GUI — Electron + Vite + React, tray, terminal, pairing |
| `packages/protocol` | Shared wire protocol — zod schemas, version negotiation, chunking |
| `packages/signaling` | Cloudflare Worker + Durable Object signaling server |
| `packages/website` | Landing page (Astro) |


---

## Development

```bash
# prerequisites: bun >= 1.3, Node >= 24 (vitest/tsc/eas run on node)
bun install

bun run typecheck
bun run test         # vitest (on node)

# run the desktop GUI in dev (vite HMR auto-spawned)
bun run --cwd packages/desktop dev

# run the daemon standalone
bun run --cwd packages/daemon dev

# run the iOS app
cd packages/app && bun run ios
```

---

## Tech stack

TypeScript · Node.js · React Native (Expo) · TanStack DB · WebRTC · Cloudflare Workers / Durable Objects ·
Claude Agent SDK · Electron · zod

---

## Status

Thinkite is an early (V0) project under active development. Core flows — pairing, starting and
streaming P2P sessions, optional cloud bridging, tool diffs, and mid-response reconnect — work
today on macOS (Apple Silicon) and iOS. Expect rough edges; interfaces may change.

---

## FAQ

**Does this use my Claude plan?**
Yes. Thinkite runs Claude Code locally with your existing Claude login; usage counts against
your Claude plan exactly as if you ran Claude Code yourself.

**Do I need Claude Desktop?**
No — you just need a Claude login, which you can create with the Claude Code CLI or Claude Desktop.

**Is it macOS-only?**
The daemon currently targets macOS (Apple Silicon). The mobile client is iOS.

---

## License

[Apache-2.0](LICENSE)

---

## Acknowledgments

Diff and code rendering is powered by [`@pierre/diffs`](https://diffs.com) and [Shiki](https://shiki.style).

> **Disclaimer:** Thinkite is an independent, open-source project. It is not affiliated with,
> endorsed by, or sponsored by Anthropic. "Claude" and "Claude Code" are trademarks of Anthropic.
