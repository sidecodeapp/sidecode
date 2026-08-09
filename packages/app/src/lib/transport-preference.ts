import * as SecureStore from "expo-secure-store";

/**
 * Dev toggle for which wire the daemon connection uses. "webrtc" is the
 * shipping default; "iroh" dials the daemon's IrohPeerServer (phase 3
 * dogfood — same identity/pairing, different transport). Same
 * SecureStore-scalar pattern as theme-preference.
 *
 * Takes effect on the next (re)connect — flipping it doesn't tear down
 * a live transport.
 */
export type TransportPref = "webrtc" | "iroh";

const KEY = "sidecode.transport.v1";

export async function getTransportPreference(): Promise<TransportPref> {
  const v = await SecureStore.getItemAsync(KEY);
  return v === "iroh" ? "iroh" : "webrtc";
}

export async function setTransportPreference(
  pref: TransportPref,
): Promise<void> {
  await SecureStore.setItemAsync(KEY, pref);
}
