import {
  decodePairOfferPayload,
  PAIR_OFFER_VERSION,
} from "@thinkite/protocol";
import { describe, expect, it } from "vitest";
import type { Identity } from "./identity.ts";
import { createPairOffer } from "./pairing.ts";

// Identity is just a pubkey+fingerprint+privateKey blob from the daemon's
// POV — createPairOffer only reads `publicKeyB64`, so we hand it a stub
// instead of spinning up the real key generation.
const fakeIdentity = {
  fingerprint: "988d6cb2baa153ef",
  publicKeyB64: "vqRrAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  // Other fields not exercised by createPairOffer; cast through unknown
  // so we don't have to construct a real Node KeyObject in the test.
} as unknown as Identity;

describe("createPairOffer", () => {
  it("returns the v2 pair.offer shape", () => {
    const { offer } = createPairOffer(fakeIdentity, "yueqians-mac");
    expect(offer.type).toBe("pair.offer");
    expect(offer.v).toBe(PAIR_OFFER_VERSION);
    expect(offer.daemonIdentityPublicKey).toBe(fakeIdentity.publicKeyB64);
    expect(offer.serviceName).toBe("yueqians-mac");
  });

  it("encoded payload round-trips through decodePairOfferPayload", () => {
    const { encoded, offer } = createPairOffer(fakeIdentity, "mac");
    expect(decodePairOfferPayload(encoded)).toEqual(offer);
  });

  it("is pure — two calls with the same input produce identical output", () => {
    const a = createPairOffer(fakeIdentity, "mac");
    const b = createPairOffer(fakeIdentity, "mac");
    // Same pubkey + same serviceName + no time component → deterministic.
    expect(a.encoded).toEqual(b.encoded);
  });
});
