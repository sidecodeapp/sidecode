import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  type KeyObject,
} from "node:crypto";
import {
  chmodSync,
  existsSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

/**
 * The daemon's long-lived ed25519 host identity. Generated on first run and
 * persisted in $THINKITE_HOME/identity.ed25519. Acts like an SSH host key:
 * iOS clients TOFU on the fingerprint at first pair, then verify identity
 * across reconnects without re-pairing.
 */
export interface Identity {
  /** Raw ed25519 public key (32 bytes) base64url-encoded. */
  publicKeyB64: string;
  /** SHA256 of the raw public key, hex, first 16 chars — short user-facing ID. */
  fingerprint: string;
  /** KeyObject usable for `crypto.sign(null, data, this)`. */
  privateKey: KeyObject;
}

const FILE_NAME = "identity.ed25519";

export function loadOrCreateIdentity(home: string): Identity {
  const path = join(home, FILE_NAME);
  if (existsSync(path)) return loadIdentity(path);
  return createIdentity(path);
}

function loadIdentity(path: string): Identity {
  const pem = readFileSync(path, "utf8");
  const privateKey = createPrivateKey({ key: pem, format: "pem" });
  const publicKey = createPublicKey(privateKey);
  return buildIdentity(privateKey, publicKey);
}

function createIdentity(path: string): Identity {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const pem = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
  // Atomic write: temp + rename + chmod 0600.
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, pem, { mode: 0o600 });
  renameSync(tmp, path);
  chmodSync(path, 0o600);
  return buildIdentity(privateKey, publicKey);
}

function buildIdentity(privateKey: KeyObject, publicKey: KeyObject): Identity {
  // Raw 32-byte ed25519 pubkey via JWK (`x` is base64url of the 32 bytes).
  const jwk = publicKey.export({ format: "jwk" }) as { x?: string };
  if (!jwk.x) throw new Error("ed25519 public key missing JWK 'x' field");
  const rawPubkey = Buffer.from(jwk.x, "base64url");
  const fingerprint = createHash("sha256")
    .update(rawPubkey)
    .digest("hex")
    .slice(0, 16);
  return {
    publicKeyB64: jwk.x, // base64url — URL-safe, fits in QR
    fingerprint,
    privateKey,
  };
}

/**
 * Extract the raw 32-byte ed25519 seed from a Node private KeyObject.
 * This is what makes the pairing identity double as the iroh secret key:
 * feeding the seed to iroh's `EndpointBuilder.secretKey` yields an
 * EndpointId byte-identical to `publicKeyB64` (validated in phase 2 —
 * see iroh-probe.ts).
 */
export function seedFromPrivateKey(privateKey: KeyObject): Buffer {
  const jwk = privateKey.export({ format: "jwk" }) as { d?: string };
  if (!jwk.d) throw new Error("ed25519 private key missing JWK 'd' field");
  const seed = Buffer.from(jwk.d, "base64url");
  if (seed.length !== 32) {
    throw new Error(`expected 32-byte ed25519 seed, got ${seed.length}`);
  }
  return seed;
}

/** Fingerprint of a base64url raw ed25519 pubkey — same derivation as
 *  `Identity.fingerprint` (sha256 of the raw key bytes, first 16 hex). */
export function fingerprintFromPubkeyB64(publicKeyB64: string): string {
  return createHash("sha256")
    .update(Buffer.from(publicKeyB64, "base64url"))
    .digest("hex")
    .slice(0, 16);
}

/** Decode a base64url ed25519 pubkey back into a Node KeyObject for verify(). */
export function publicKeyFromB64(b64url: string): KeyObject {
  const raw = Buffer.from(b64url, "base64url");
  if (raw.length !== 32) {
    throw new Error(`expected 32-byte ed25519 pubkey, got ${raw.length}`);
  }
  return createPublicKey({
    key: { kty: "OKP", crv: "Ed25519", x: b64url },
    format: "jwk",
  });
}
