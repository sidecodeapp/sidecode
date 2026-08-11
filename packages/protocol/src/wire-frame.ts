/**
 * Length-prefix framing for the iroh QUIC transport.
 *
 * A QUIC bi-stream is a byte stream with NO message boundaries, so
 * each JSON message is framed as:
 *
 *   [4-byte big-endian u32: payload byte length][UTF-8 JSON payload]
 *
 * No chunking envelope (unlike the retired WebRTC path's SCTP cap) —
 * QUIC streams have no per-message size cap, so a multi-megabyte
 * `subscribe.response` is just one frame. The length cap below only
 * guards against a corrupt/hostile header committing the reader to an
 * absurd allocation.
 */

/** ALPN for the Thinkite RPC protocol over iroh. Bump the trailing
 *  version only on a wire-format break so old peers are refused at the
 *  QUIC handshake; schema-level compatibility stays with the
 *  hello/server_info handshake (`isProtocolCompatible`). */
export const IROH_RPC_ALPN = "thinkite/rpc/1";

/** Bytes in the length prefix. */
export const WIRE_FRAME_HEADER_BYTES = 4;

/**
 * Hard cap on a single frame's payload size. Generous — the largest
 * real frame is a `subscribe.response` carrying a long session's settled
 * transcript (single-digit MB territory) — while still bounding what a
 * corrupt length header can make the reader allocate.
 */
export const MAX_WIRE_FRAME_BYTES = 64 * 1024 * 1024;

// ─── UTF-8 codec ────────────────────────────────────────────────────
//
// TextEncoder/TextDecoder when the runtime has them (Node, browsers);
// pure-JS fallback for Hermes, which ships neither. Both inputs are
// JSON.stringify output, which is well-formed UTF-16 (lone surrogates
// get \u-escaped per ES2019), so the fallback doesn't need replacement-
// character handling.

/** Internal — exported for tests only (forces the non-native path). */
export function utf8EncodeFallback(s: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < s.length; i += 1) {
    let cp = s.charCodeAt(i);
    if (cp >= 0xd800 && cp <= 0xdbff && i + 1 < s.length) {
      const lo = s.charCodeAt(i + 1);
      if (lo >= 0xdc00 && lo <= 0xdfff) {
        cp = 0x10000 + ((cp - 0xd800) << 10) + (lo - 0xdc00);
        i += 1;
      }
    }
    if (cp < 0x80) out.push(cp);
    else if (cp < 0x800) out.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
    else if (cp < 0x10000) {
      out.push(
        0xe0 | (cp >> 12),
        0x80 | ((cp >> 6) & 0x3f),
        0x80 | (cp & 0x3f),
      );
    } else {
      out.push(
        0xf0 | (cp >> 18),
        0x80 | ((cp >> 12) & 0x3f),
        0x80 | ((cp >> 6) & 0x3f),
        0x80 | (cp & 0x3f),
      );
    }
  }
  return Uint8Array.from(out);
}

/** Internal — exported for tests only (forces the non-native path). */
export function utf8DecodeFallback(bytes: Uint8Array): string {
  let out = "";
  const chunk: number[] = [];
  let i = 0;
  while (i < bytes.length) {
    const b0 = bytes[i] as number;
    let cp: number;
    if (b0 < 0x80) {
      cp = b0;
      i += 1;
    } else if (b0 < 0xe0) {
      cp = ((b0 & 0x1f) << 6) | ((bytes[i + 1] ?? 0) & 0x3f);
      i += 2;
    } else if (b0 < 0xf0) {
      cp =
        ((b0 & 0x0f) << 12) |
        (((bytes[i + 1] ?? 0) & 0x3f) << 6) |
        ((bytes[i + 2] ?? 0) & 0x3f);
      i += 3;
    } else {
      cp =
        ((b0 & 0x07) << 18) |
        (((bytes[i + 1] ?? 0) & 0x3f) << 12) |
        (((bytes[i + 2] ?? 0) & 0x3f) << 6) |
        ((bytes[i + 3] ?? 0) & 0x3f);
      i += 4;
    }
    if (cp > 0xffff) {
      const v = cp - 0x10000;
      chunk.push(0xd800 + (v >> 10), 0xdc00 + (v & 0x3ff));
    } else {
      chunk.push(cp);
    }
    // Flush periodically — String.fromCharCode(...) has an argument cap.
    if (chunk.length >= 4096) {
      out += String.fromCharCode(...chunk);
      chunk.length = 0;
    }
  }
  if (chunk.length > 0) out += String.fromCharCode(...chunk);
  return out;
}

function utf8Encode(s: string): Uint8Array {
  if (typeof TextEncoder !== "undefined") return new TextEncoder().encode(s);
  return utf8EncodeFallback(s);
}

function utf8Decode(bytes: Uint8Array): string {
  if (typeof TextDecoder !== "undefined")
    return new TextDecoder().decode(bytes);
  return utf8DecodeFallback(bytes);
}

/**
 * Encode one JSON message into a single wire buffer (header + payload).
 * Throws if the encoded payload exceeds MAX_WIRE_FRAME_BYTES.
 */
export function encodeWireFrame(json: string): Uint8Array {
  const payload = utf8Encode(json);
  if (payload.byteLength > MAX_WIRE_FRAME_BYTES) {
    throw new Error(
      `wire frame payload ${payload.byteLength} bytes exceeds cap ${MAX_WIRE_FRAME_BYTES}`,
    );
  }
  const frame = new Uint8Array(WIRE_FRAME_HEADER_BYTES + payload.byteLength);
  new DataView(frame.buffer).setUint32(0, payload.byteLength, false);
  frame.set(payload, WIRE_FRAME_HEADER_BYTES);
  return frame;
}

/**
 * Decode the payload length from a frame header. Throws on a short
 * header, a zero length (no valid JSON is empty), or a length above the
 * cap — all three mean the stream is corrupt or hostile and the
 * connection should be dropped, since byte-stream framing can't resync.
 */
export function decodeWireFrameLength(header: Uint8Array): number {
  if (header.byteLength < WIRE_FRAME_HEADER_BYTES) {
    throw new Error(
      `wire frame header truncated: ${header.byteLength}/${WIRE_FRAME_HEADER_BYTES} bytes`,
    );
  }
  const length = new DataView(
    header.buffer,
    header.byteOffset,
    header.byteLength,
  ).getUint32(0, false);
  if (length === 0) {
    throw new Error("wire frame payload length is zero");
  }
  if (length > MAX_WIRE_FRAME_BYTES) {
    throw new Error(
      `wire frame payload ${length} bytes exceeds cap ${MAX_WIRE_FRAME_BYTES}`,
    );
  }
  return length;
}

/** Decode a frame payload back into the JSON string. */
export function decodeWireFramePayload(payload: Uint8Array): string {
  return utf8Decode(payload);
}
