/**
 * Length-prefix framing for the iroh QUIC transport.
 *
 * WebRTC DataChannel has message boundaries (SCTP), so the WebRTC path
 * sends bare JSON strings (chunked above the SCTP size cap — see
 * chunking.ts). A QUIC bi-stream is a byte stream with NO message
 * boundaries, so the iroh path frames each JSON message as:
 *
 *   [4-byte big-endian u32: payload byte length][UTF-8 JSON payload]
 *
 * No chunking envelope on this path — QUIC streams have no per-message
 * size cap, so a multi-megabyte `subscribe.response` is just one frame.
 * The length cap below only guards against a corrupt/hostile header
 * committing the reader to an absurd allocation.
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

/**
 * Encode one JSON message into a single wire buffer (header + payload).
 * Throws if the encoded payload exceeds MAX_WIRE_FRAME_BYTES.
 */
export function encodeWireFrame(json: string): Uint8Array {
  const payload = new TextEncoder().encode(json);
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
  return new TextDecoder().decode(payload);
}
