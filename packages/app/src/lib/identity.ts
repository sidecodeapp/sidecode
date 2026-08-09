import * as ed25519 from "@noble/ed25519";
import { sha256, sha512 } from "@noble/hashes/sha2.js";
import * as Crypto from "expo-crypto";
import * as SecureStore from "expo-secure-store";
import { base64UrlToBytes, bytesToBase64Url } from "./base64";

// Global crypto (getRandomValues / randomUUID) is polyfilled in
// `@/lib/polyfills`, imported first in app/_layout.tsx — so it's installed
// before this module's runtime code (key gen / signing) runs.
//
// noble/ed25519 v3 ships without a hash impl bundled. Async APIs default to
// `crypto.subtle.digest("SHA-512")` — RN doesn't have WebCrypto, so we MUST
// wire `sha512Async` ourselves. `sha512` is for the sync paths (some helpers
// fall through to it); set both at module top before any ed25519 call.
ed25519.hashes.sha512 = sha512;
ed25519.hashes.sha512Async = (msg) => Promise.resolve(sha512(msg));

/** Persistent ed25519 identity for this iOS install. */
export interface ClientIdentity {
  /** 16 hex chars: SHA256(rawPublicKey).slice(0,16). Stable across runs. */
  fingerprint: string;
  /** base64url-encoded 32-byte raw ed25519 public key (Ed25519 JWK `x`). */
  publicKeyB64: string;
  /** Sign arbitrary bytes with the private key. Returns base64url signature. */
  sign(bytes: Uint8Array): Promise<string>;
  /**
   * The raw 32-byte ed25519 seed — doubles as the iroh secret key, so
   * the iroh wire's EndpointId IS `publicKeyB64` and the daemon's
   * known_clients gate admits us with no extra handshake (mirrors the
   * daemon-side `seedFromPrivateKey` derivation, validated in phase 2).
   */
  privateKeySeed: Uint8Array;
}

// SecureStore restricts keys to [A-Za-z0-9._-] — no slashes / colons.
const STORE_KEY = "sidecode_client_identity_v1";

interface StoredIdentity {
  privateKeyB64: string;
}

/**
 * Load the persisted identity, or generate a new keypair on first launch.
 * Identity persists across app restarts via SecureStore (iOS Keychain).
 *
 * Resetting (re-pair flow): call `resetIdentity()` then call this again.
 */
export async function loadOrCreateIdentity(): Promise<ClientIdentity> {
  const existing = await readStored();
  if (existing) return materialize(base64UrlToBytes(existing.privateKeyB64));

  const privateKey = Crypto.getRandomBytes(32);
  await SecureStore.setItemAsync(
    STORE_KEY,
    JSON.stringify({ privateKeyB64: bytesToBase64Url(privateKey) }),
  );
  return materialize(privateKey);
}

export async function resetIdentity(): Promise<void> {
  await SecureStore.deleteItemAsync(STORE_KEY);
}

async function readStored(): Promise<StoredIdentity | null> {
  const raw = await SecureStore.getItemAsync(STORE_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as StoredIdentity;
  } catch {
    return null;
  }
}

async function materialize(privateKey: Uint8Array): Promise<ClientIdentity> {
  const publicKey = await ed25519.getPublicKeyAsync(privateKey);
  const fingerprint = bytesToHex(sha256(publicKey)).slice(0, 16);
  return {
    fingerprint,
    publicKeyB64: bytesToBase64Url(publicKey),
    sign: async (bytes) =>
      bytesToBase64Url(await ed25519.signAsync(bytes, privateKey)),
    privateKeySeed: privateKey,
  };
}

function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 1) {
    out += (bytes[i] as number).toString(16).padStart(2, "0");
  }
  return out;
}
