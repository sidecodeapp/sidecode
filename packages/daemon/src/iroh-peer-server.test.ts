import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type BiStream, Endpoint, EndpointAddr } from "@number0/iroh";
import {
  type Command,
  type DaemonFrame,
  decodeWireFrameLength,
  decodeWireFramePayload,
  encodeWireFrame,
  IROH_RPC_ALPN,
  PROTOCOL_VERSION,
  WIRE_FRAME_HEADER_BYTES,
} from "@thinkite/protocol";
import { afterEach, describe, expect, it } from "vitest";
import type { CommandContext } from "./command.ts";
import { loadOrCreateIdentity } from "./identity.ts";
import { IrohPeerServer } from "./iroh-peer-server.ts";
import { KnownClients } from "./known-clients.ts";

/**
 * Full-wire integration tests: a real second iroh endpoint (napi, same
 * process) dials the server. `minimal` preset on both sides = no relays,
 * no discovery — direct-dial by socket address, fully offline.
 */

const ALPN_BYTES = Array.from(Buffer.from(IROH_RPC_ALPN));

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) {
    try {
      await fn();
    } catch {
      // teardown best-effort
    }
  }
});

interface Harness {
  server: IrohPeerServer;
  knownClients: KnownClients;
  home: string;
}

function makeHarness(opts?: {
  isPairing?: () => boolean;
  commandHandler?: (cmd: Command, ctx: CommandContext) => void | Promise<void>;
}): Harness {
  const home = mkdtempSync(join(tmpdir(), "iroh-peer-test-"));
  cleanups.push(() => rmSync(home, { recursive: true, force: true }));
  const identity = loadOrCreateIdentity(home);
  const knownClients = KnownClients.load(home);
  const server = new IrohPeerServer({
    identity,
    knownClients,
    commandHandler: opts?.commandHandler,
    isPairing: opts?.isPairing,
    preset: "minimal",
  });
  cleanups.push(() => server.stop());
  return { server, knownClients, home };
}

async function makeClientEndpoint(): Promise<{
  ep: Endpoint;
  pubkeyB64: string;
}> {
  const b = Endpoint.builder();
  b.applyMinimal();
  b.secretKey(Array.from(randomBytes(32)));
  const ep = await b.bind();
  cleanups.push(() => ep.close());
  const pubkeyB64 = Buffer.from(Uint8Array.from(ep.id().toBytes())).toString(
    "base64url",
  );
  return { ep, pubkeyB64 };
}

/** Server's dialable address, with loopback fallbacks for wildcard binds. */
function dialAddr(server: IrohPeerServer): EndpointAddr {
  const addr = server.endpointAddr();
  const direct = addr.directAddresses();
  const loopback = direct
    .map((a) => a.slice(a.lastIndexOf(":")))
    .map((port) => `127.0.0.1${port}`);
  return new EndpointAddr(addr.id(), null, [...direct, ...loopback]);
}

function sendFrame(
  bi: BiStream,
  frame: Record<string, unknown>,
): Promise<void> {
  return bi.send.writeAll(Array.from(encodeWireFrame(JSON.stringify(frame))));
}

async function readFrame(bi: BiStream): Promise<DaemonFrame> {
  const header = await bi.recv.readExact(WIRE_FRAME_HEADER_BYTES);
  const length = decodeWireFrameLength(Uint8Array.from(header));
  const body = await bi.recv.readExact(length);
  return JSON.parse(
    decodeWireFramePayload(Uint8Array.from(body)),
  ) as DaemonFrame;
}

function pair(knownClients: KnownClients, pubkeyB64: string): void {
  knownClients.add({
    fingerprint: fingerprintOf(pubkeyB64),
    publicKeyB64: pubkeyB64,
    pairedAt: Date.now(),
  });
}

function fingerprintOf(pubkeyB64: string): string {
  // Mirror of identity.ts's derivation, kept local so the test asserts
  // the SERVER derives the same value rather than trusting one helper.
  return createHash("sha256")
    .update(Buffer.from(pubkeyB64, "base64url"))
    .digest("hex")
    .slice(0, 16);
}

describe("IrohPeerServer", () => {
  it("paired client: hello → server_info, ping → pong", async () => {
    const h = makeHarness();
    await h.server.start();
    const { ep, pubkeyB64 } = await makeClientEndpoint();
    pair(h.knownClients, pubkeyB64);

    const conn = await ep.connect(dialAddr(h.server), ALPN_BYTES);
    const bi = await conn.openBi();
    await sendFrame(bi, { type: "hello", protocolVersion: PROTOCOL_VERSION });
    const info = await readFrame(bi);
    expect(info).toEqual({
      type: "server_info",
      protocolVersion: PROTOCOL_VERSION,
    });

    await sendFrame(bi, { type: "ping", t: 42 });
    const pong = await readFrame(bi);
    expect(pong).toMatchObject({ type: "pong", echoT: 42 });
    expect(h.server.authenticatedCount()).toBe(1);
  });

  it("unknown client with pair window closed is rejected", async () => {
    const h = makeHarness({ isPairing: () => false });
    await h.server.start();
    const { ep } = await makeClientEndpoint();

    const conn = await ep.connect(dialAddr(h.server), ALPN_BYTES);
    // Server closes right after its known_clients lookup — the client
    // observes the connection dying, and nothing gets persisted.
    await conn.closed();
    expect(h.knownClients.list()).toHaveLength(0);
    expect(h.server.authenticatedCount()).toBe(0);
  });

  it("unknown client is admitted and persisted while pairing is open", async () => {
    const h = makeHarness({ isPairing: () => true });
    await h.server.start();
    const { ep, pubkeyB64 } = await makeClientEndpoint();

    const conn = await ep.connect(dialAddr(h.server), ALPN_BYTES);
    const bi = await conn.openBi();
    await sendFrame(bi, { type: "hello", protocolVersion: PROTOCOL_VERSION });
    const info = await readFrame(bi);
    expect(info).toMatchObject({ type: "server_info" });

    expect(h.knownClients.list()).toHaveLength(1);
    expect(h.knownClients.list()[0]).toMatchObject({
      publicKeyB64: pubkeyB64,
      fingerprint: fingerprintOf(pubkeyB64),
    });
  });

  it("incompatible hello gets an error frame and a close", async () => {
    const h = makeHarness();
    await h.server.start();
    const { ep, pubkeyB64 } = await makeClientEndpoint();
    pair(h.knownClients, pubkeyB64);

    const conn = await ep.connect(dialAddr(h.server), ALPN_BYTES);
    const bi = await conn.openBi();
    await sendFrame(bi, { type: "hello", protocolVersion: "99.0.0" });
    const err = await readFrame(bi);
    expect(err).toMatchObject({
      type: "error",
      code: "incompatible_protocol",
      protocolVersion: PROTOCOL_VERSION,
    });
    await conn.closed();
    expect(h.server.authenticatedCount()).toBe(0);
  });

  it("non-hello frame before the handshake is refused", async () => {
    const h = makeHarness();
    await h.server.start();
    const { ep, pubkeyB64 } = await makeClientEndpoint();
    pair(h.knownClients, pubkeyB64);

    const conn = await ep.connect(dialAddr(h.server), ALPN_BYTES);
    const bi = await conn.openBi();
    await sendFrame(bi, { type: "ping", t: 1 });
    const err = await readFrame(bi);
    expect(err).toMatchObject({
      type: "error",
      code: "incompatible_protocol",
    });
    await conn.closed();
  });

  it("dispatches commands and fires onDisconnect on client close", async () => {
    const seen: Command[] = [];
    let disconnected = false;
    const h = makeHarness({
      commandHandler: (cmd, ctx) => {
        seen.push(cmd);
        ctx.onDisconnect(() => {
          disconnected = true;
        });
        ctx.send({
          type: "error",
          requestId: (cmd as { requestId: string }).requestId,
          code: "internal",
          message: "dispatched",
        });
      },
    });
    await h.server.start();
    const { ep, pubkeyB64 } = await makeClientEndpoint();
    pair(h.knownClients, pubkeyB64);

    const conn = await ep.connect(dialAddr(h.server), ALPN_BYTES);
    const bi = await conn.openBi();
    await sendFrame(bi, { type: "hello", protocolVersion: PROTOCOL_VERSION });
    await readFrame(bi); // server_info

    await sendFrame(bi, { type: "getFilesystemRoots", requestId: "r1" });
    const reply = await readFrame(bi);
    expect(reply).toMatchObject({
      type: "error",
      requestId: "r1",
      message: "dispatched",
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ type: "getFilesystemRoots" });

    conn.close(0n, []);
    await expect.poll(() => disconnected, { timeout: 5000 }).toBe(true);
    expect(h.server.authenticatedCount()).toBe(0);
  });

  it("carries a frame larger than the WebRTC chunking threshold in one piece", async () => {
    // The iroh path has no SCTP message cap — a >60k-char JSON that the
    // WebRTC path would split into chunk envelopes goes through whole.
    let captured: Command | null = null;
    const h = makeHarness({
      commandHandler: (cmd, ctx) => {
        captured = cmd;
        ctx.send({
          type: "error",
          requestId: (cmd as { requestId: string }).requestId,
          code: "internal",
          message: "x".repeat(200_000),
        });
      },
    });
    await h.server.start();
    const { ep, pubkeyB64 } = await makeClientEndpoint();
    pair(h.knownClients, pubkeyB64);

    const conn = await ep.connect(dialAddr(h.server), ALPN_BYTES);
    const bi = await conn.openBi();
    await sendFrame(bi, { type: "hello", protocolVersion: PROTOCOL_VERSION });
    await readFrame(bi); // server_info

    const bigPrompt = "汉字emoji🎏".repeat(20_000); // ~180k chars, multi-byte
    await sendFrame(bi, {
      type: "sendPrompt",
      requestId: "big",
      sessionId: "s1",
      text: bigPrompt,
    });
    const reply = await readFrame(bi);
    expect(reply).toMatchObject({ type: "error", requestId: "big" });
    expect((reply as { message: string }).message).toHaveLength(200_000);
    expect((captured as unknown as { text: string } | null)?.text).toBe(
      bigPrompt,
    );
  });
});
