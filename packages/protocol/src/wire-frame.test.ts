import { describe, expect, it } from "vitest";
import {
  decodeWireFrameLength,
  decodeWireFramePayload,
  encodeWireFrame,
  MAX_WIRE_FRAME_BYTES,
  utf8DecodeFallback,
  utf8EncodeFallback,
  WIRE_FRAME_HEADER_BYTES,
} from "./wire-frame.ts";

function roundtrip(json: string): string {
  const frame = encodeWireFrame(json);
  const length = decodeWireFrameLength(
    frame.subarray(0, WIRE_FRAME_HEADER_BYTES),
  );
  expect(frame.byteLength).toBe(WIRE_FRAME_HEADER_BYTES + length);
  return decodeWireFramePayload(frame.subarray(WIRE_FRAME_HEADER_BYTES));
}

describe("encodeWireFrame / decode*", () => {
  it("roundtrips ASCII JSON", () => {
    const json = JSON.stringify({ type: "ping", t: 123 });
    expect(roundtrip(json)).toBe(json);
  });

  it("roundtrips multi-byte UTF-8 (CJK + emoji)", () => {
    const json = JSON.stringify({ type: "sendPrompt", text: "你好👋 世界" });
    expect(roundtrip(json)).toBe(json);
    // Header must count BYTES, not UTF-16 chars.
    const frame = encodeWireFrame(json);
    const length = decodeWireFrameLength(frame);
    expect(length).toBeGreaterThan(json.length);
  });

  it("length prefix is big-endian u32", () => {
    const frame = encodeWireFrame("{}");
    expect([...frame.subarray(0, 4)]).toEqual([0, 0, 0, 2]);
  });

  it("decodes length from a subarray with a nonzero byteOffset", () => {
    // Simulates a reader that sliced the header out of a larger buffer.
    const frame = encodeWireFrame('{"a":1}');
    const shifted = new Uint8Array(3 + frame.byteLength);
    shifted.set(frame, 3);
    const header = shifted.subarray(3, 3 + WIRE_FRAME_HEADER_BYTES);
    expect(decodeWireFrameLength(header)).toBe(7);
  });

  it("rejects a truncated header", () => {
    expect(() => decodeWireFrameLength(new Uint8Array(3))).toThrow(/truncated/);
  });

  it("rejects a zero-length payload", () => {
    expect(() => decodeWireFrameLength(new Uint8Array(4))).toThrow(/zero/);
  });

  it("rejects a payload length above the cap", () => {
    const header = new Uint8Array(4);
    new DataView(header.buffer).setUint32(0, MAX_WIRE_FRAME_BYTES + 1, false);
    expect(() => decodeWireFrameLength(header)).toThrow(/exceeds cap/);
  });

  it("rejects encoding a payload above the cap without allocating the frame", () => {
    // 64MiB+ of ASCII — the encoder must throw, not truncate.
    const big = "x".repeat(MAX_WIRE_FRAME_BYTES + 1);
    expect(() => encodeWireFrame(big)).toThrow(/exceeds cap/);
  });
});

describe("utf8 fallback codec (Hermes path)", () => {
  const samples = [
    "",
    "plain ascii {}",
    JSON.stringify({ text: "你好，世界" }),
    "emoji 👋🎏 + astral 𝄞𐍈",
    "mixed: ħëllø 你好 👨‍👩‍👧‍👦 end",
    "x".repeat(10_000) + "汉".repeat(5_000),
  ];

  it("encode matches TextEncoder byte-for-byte", () => {
    for (const s of samples) {
      expect([...utf8EncodeFallback(s)]).toEqual([
        ...new TextEncoder().encode(s),
      ]);
    }
  });

  it("decode matches TextDecoder", () => {
    for (const s of samples) {
      const bytes = new TextEncoder().encode(s);
      expect(utf8DecodeFallback(bytes)).toBe(new TextDecoder().decode(bytes));
    }
  });

  it("roundtrips without native codecs at all", () => {
    for (const s of samples) {
      expect(utf8DecodeFallback(utf8EncodeFallback(s))).toBe(s);
    }
  });
});
