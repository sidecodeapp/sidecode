import {
  encodePairOffer,
  PAIR_OFFER_VERSION,
  type PairOfferFrame,
} from "@thinkite/protocol";
import type { Identity } from "./identity.ts";

/**
 * Pair-offer construction — pure over the daemon's identity + a
 * serviceName label. The QR carries just `daemonIdentityPublicKey +
 * serviceName`; admission of unknown pubkeys at connect time is gated
 * separately by the pair-window flag in WebRTCPeerServer.
 */
export interface PairOfferResult {
  /** Base64url-encoded `pair.offer` payload — what goes into the QR. */
  encoded: string;
  /** The decoded offer the encoded payload represents. Returned for
   *  loggers / tests / callers that need the structured form. */
  offer: PairOfferFrame;
}

export function createPairOffer(
  identity: Identity,
  serviceName: string,
): PairOfferResult {
  const offer: PairOfferFrame = {
    type: "pair.offer",
    v: PAIR_OFFER_VERSION,
    daemonIdentityPublicKey: identity.publicKeyB64,
    serviceName,
  };
  return { offer, encoded: encodePairOffer(offer) };
}
