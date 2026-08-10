import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  clearPairedDaemon,
  type DaemonClient,
  daemonClient,
  decodePairOffer,
  getPairedDaemon,
  IncompatibleProtocolError,
  type PairedDaemon,
  Transport,
} from "./daemon-client";
import { loadOrCreateIdentity } from "./identity";

// Reconnect tuning — paseo's defaults (`packages/server/src/client/daemon-client.ts`).
// Curve: 1.5s, 3s, 6s, 12s, 24s, 30s, 30s, ... (capped). No max attempts —
// retry forever; user can manually unpair if it never recovers.
const RECONNECT_BASE_DELAY_MS = 1500;
const RECONNECT_MAX_DELAY_MS = 30_000;
const reconnectDelayMs = (attempt: number): number =>
  Math.min(RECONNECT_BASE_DELAY_MS * 2 ** attempt, RECONNECT_MAX_DELAY_MS);

/**
 * Internal state machine. Wider than what most consumers see — derive a
 * 4-tone `connectionStatus` for UI in `useDaemonClient` below.
 *
 * `connecting.attempt` and `offline.attempt` track the position in the
 * exponential-backoff sequence. `attempt === 0` means "first try since
 * pair / reset / mount". On a successful connect the counter resets so
 * that a brief drop heals quickly with a 1.5s retry, not a 30s one.
 *
 * Post-facade-refactor: state no longer carries the live client (the
 * `DaemonClient` facade is stable for the Provider's lifetime and held
 * in a ref). State is purely the connection-status machine; consumers
 * always get back the same facade instance via context.
 *
 * Axis note: this is the connection-HEALTH machine. The IDENTITY axis
 * (paired vs not) lives in the separate `paired` field, which is what the
 * route gate (`isUnpaired`) reads. `unpaired` here is just this machine's
 * resting value when there's no credential — set atomically with
 * `setPaired(null)`, used only for badge derivation. Do NOT route off it;
 * route off `paired` so health transitions can't move the user between
 * onboarding and main.
 */
type DaemonState =
  | { status: "connecting"; attempt: number }
  | { status: "ready" }
  | { status: "offline"; reason?: string; attempt: number }
  | { status: "unpaired" } // resting value when paired === null (not the route signal)
  | { status: "error"; error: Error };

/**
 * Public 4-tone status for UI badges. Maps to paseo's
 * `HostRuntimeConnectionStatus` (minus `idle`, since sidecode collapses
 * pre-pair into a separate `unpaired` flag). `null` when in `unpaired`
 * state — there's nothing to show until the user pairs.
 *
 * Tone convention (matches paseo, see `packages/app/src/utils/daemons.ts`):
 *   online      → success (green)
 *   connecting  → warning (amber) — actively trying
 *   offline     → warning (amber) — waiting for next backoff slot
 *   error       → destructive (red) — terminal handshake failure
 */
export type ConnectionStatus = "connecting" | "online" | "offline" | "error";

function deriveConnectionStatus(state: DaemonState): ConnectionStatus | null {
  switch (state.status) {
    case "connecting":
      return "connecting";
    case "ready":
      return "online";
    case "offline":
      return "offline";
    case "error":
      return "error";
    case "unpaired":
      return null;
  }
}

/**
 * iOS systemColor hex for the status dot. UX choice (vs paseo's 4-tone):
 * we collapse `connecting` and `offline` to the same gray since the
 * brief amber flicker between an offline drop and the next handshake is
 * too short to be useful (~200ms in happy path), and a clear binary
 * "online vs not" is easier for users to scan. Internal state machine
 * still distinguishes the two for retry timing.
 */
export function statusColor(status: ConnectionStatus | null): string {
  switch (status) {
    case "online":
      return "#34C759"; // systemGreen
    case "connecting":
    case "offline":
      return "#8E8E93"; // systemGray — not online, retry loop owns the recovery
    case "error":
      return "#FF3B30"; // systemRed — terminal handshake failure
    case null:
      return "#8E8E93"; // page should be unmounted while unpaired, defensive
  }
}

/** Human-readable label paired with `statusColor`. */
export function statusLabel(status: ConnectionStatus | null): string {
  switch (status) {
    case "online":
      return "Online";
    case "connecting":
    case "offline":
      return "Offline";
    case "error":
      return "Error";
    case null:
      return "—";
  }
}

interface DaemonClientContextValue {
  /** Stable facade reference — same instance for the Provider's
   *  lifetime. Use this for all RPCs; the underlying Transport gets
   *  swapped on each reconnect transparently. */
  client: DaemonClient;
  state: DaemonState;
  paired: PairedDaemon | null;
  /** Sticky protocol-mismatch record — survives retry windows (where
   *  `state` flips to `connecting`). Non-null ⟺ the update-required
   *  route gate is up. Cleared on successful handshake or unpair(). */
  protocolError: IncompatibleProtocolError | null;
  initialized: boolean;
  reset: () => void;
  /**
   * Run a first-time pair using a base64url-encoded `pair.offer` (the
   * payload from `sidecode pair`'s QR or the printed base64 fallback).
   * Resolves on successful handshake; subsequent reset()s will go
   * through the trusted-reconnect path automatically. Throws on
   * malformed payload, expired offer, or handshake failure.
   */
  pair: (offerB64: string) => Promise<void>;
  /**
   * Tear down the current connection, wipe the persisted PairedDaemon,
   * and flip to `unpaired`. The root layout's `Stack.Protected` guard
   * picks this up and routes the user back to /onboarding automatically
   * — no imperative navigation needed at the call site.
   */
  unpair: () => Promise<void>;
}

const Ctx = createContext<DaemonClientContextValue | null>(null);

/**
 * Owns the app's single live daemon connection. On mount it tries the
 * trusted-reconnect path; if no PairedDaemon is on disk, it lands on
 * `unpaired` so the layout can route to the pair screen.
 *
 * Auto-reconnect: every connection failure — the initial boot handshake
 * included — schedules an exponential-backoff retry and KEEPS the paired
 * credential. We never clear the pairing on a connect failure: a failure
 * is overwhelmingly a transient unreachable daemon (Mac asleep, daemon
 * not running, network blip), and silently wiping on every daemon-down
 * would force a QR re-scan on the next launch. A genuinely-dead pairing
 * (e.g. the daemon's identity actually rotated) just sits at `offline`
 * until the user clears it explicitly via Settings → Forget host
 * (`unpair()`). This mirrors paseo, where host removal is only ever an
 * explicit, confirmed user action — never an automatic connect-failure
 * side effect.
 *
 * `pair()` introduces new credentials. `reset()` re-runs the boot path
 * with whatever's already persisted. `unpair()` is the explicit user
 * teardown — the ONLY path that clears the stored credential.
 *
 * Wrap any tree that calls `useDaemonClient()` (typically inside
 * `<QueryClientProvider>` at the layout root).
 */
export function DaemonClientProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<DaemonState>({
    status: "connecting",
    attempt: 0,
  });
  // Sticky: flips to true on the first reach of any settled state, never
  // flips back. Splash UX keys off this — `isLoading` flickers on every
  // reset/reconnect and would otherwise re-mount the splash branch.
  const [initialized, setInitialized] = useState(false);
  // The persisted `PairedDaemon` record — orthogonal to connection state.
  // Set when a successful `pair()` writes credentials, or when boot
  // `getPairedDaemon()` finds them. Cleared only by `unpair()` or the
  // initial-boot identity-rotation fallback. Stays populated through
  // `offline` / reconnect-loop windows so settings UI keeps showing
  // hostname / fingerprint / addresses while the WS is dropped.
  const [paired, setPaired] = useState<PairedDaemon | null>(null);
  // Sticky protocol-mismatch record. Set when a handshake fails with
  // IncompatibleProtocolError; cleared ONLY on a successful handshake or
  // unpair(). Deliberately NOT derived from `state` — a retry flips
  // `state` to `connecting` (error gone) and the update-required route
  // guard would flicker back to the main UI mid-retry. The screen stays
  // up through retries and reads the LAST mismatch's direction/copy.
  const [protocolError, setProtocolError] =
    useState<IncompatibleProtocolError | null>(null);
  // Bumped on every (re)connect / pair / unpair. In-flight async work
  // detects supersession by comparing its captured epoch to the current
  // value; mismatch = bail out without touching state.
  const epochRef = useRef(0);
  // Stable facade — the module-level singleton (see daemon-client.ts). One
  // instance for the whole app process, kept alive across every transport
  // reconnect. The Transport comes and goes (one per successful WebRTC
  // handshake); this Provider swaps it via _attachTransport /
  // _detachTransport without changing the facade identity. Consumers bind
  // to this object and never see a null / re-identified `client`. Held at
  // module scope (not a useRef) so non-React consumers — TanStack DB
  // collections — can import it directly.
  const facade = daemonClient;
  const transportRef = useRef<Transport | null>(null);
  // Pending reconnect schedule. Cleared on user-initiated transitions
  // (reset / pair / unpair) and on provider unmount.
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Auto-reconnect master switch. `false` while disposing (unmount /
  // unpair) so a late-firing onUnexpectedClose / timer doesn't resurrect
  // a doomed connection. Re-armed by `connect()` and `pair()`.
  const shouldReconnectRef = useRef(true);
  const clearReconnectTimer = useCallback(() => {
    if (reconnectTimerRef.current !== null) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
  }, []);

  /**
   * Auto-reconnect entrypoint. Defined as a `useEffectEvent` so the
   * stable-identity closure can directly reference `connect` (declared
   * later in this scope) without forming a `useCallback` dependency
   * cycle, AND without going through a manual ref. React guarantees the
   * function always uses the latest closure when called.
   *
   * Constraint: only safe to call from async event sources (network
   * close, setTimeout) — NOT during render. We call it from a WS close
   * handler and from a timer callback, both of which qualify.
   *
   * The `epoch` argument is captured per fresh client so a late-firing
   * close (e.g. WS dies milliseconds after `unpair()` bumped the epoch)
   * is dropped instead of triggering a ghost reconnect. First retry
   * uses `attempt: 1` since this branch is only reached after at least
   * one successful connection.
   */
  const handleUnexpectedClose = useEffectEvent((epoch: number) => {
    if (epoch !== epochRef.current) return;
    if (!shouldReconnectRef.current) return;
    clearReconnectTimer();
    // Phase-4 measurement log: timestamp of loss DETECTION (QUIC idle /
    // ICE failure / dc close — however the wire noticed).
    console.log(`[transport] lost ${new Date().toISOString()}`);
    setState({ status: "offline", attempt: 0 });
    const delay = reconnectDelayMs(0);
    reconnectTimerRef.current = setTimeout(() => {
      reconnectTimerRef.current = null;
      if (epoch !== epochRef.current) return;
      if (!shouldReconnectRef.current) return;
      connect(1);
    }, delay);
  });

  /**
   * Boot-retry entrypoint — called when the initial handshake (or a
   * subsequent retry of it) fails. Same useEffectEvent rationale as
   * `handleUnexpectedClose`: avoids the dep cycle with `connect`.
   */
  const handleBootRetry = useEffectEvent((epoch: number, attempt: number) => {
    reconnectTimerRef.current = null;
    if (epoch !== epochRef.current) return;
    if (!shouldReconnectRef.current) return;
    connect(attempt + 1);
  });

  const connect = useCallback(
    (attempt: number = 0) => {
      epochRef.current += 1;
      const epoch = epochRef.current;

      clearReconnectTimer();
      // Detach BEFORE closing — facade re-arms its readyPromise so any
      // in-flight RPC blocks until the next attach instead of resolving
      // against a dead transport. Then close the old transport.
      const prevTransport = transportRef.current;
      transportRef.current = null;
      if (prevTransport !== null) facade._detachTransport();
      prevTransport?.close();
      shouldReconnectRef.current = true;
      setState({ status: "connecting", attempt });

      void (async () => {
        try {
          const identity = await loadOrCreateIdentity();
          const loaded = await getPairedDaemon();
          if (!loaded) {
            if (epoch !== epochRef.current) return;
            setPaired(null);
            setState({ status: "unpaired" });
            setInitialized(true);
            return;
          }
          // Publish loaded paired record IMMEDIATELY — settings UI relies
          // on this to keep showing hostname / fingerprint / addresses
          // through the connecting + offline window. Decoupled from the
          // connection state machine.
          setPaired(loaded);
          let transport: Transport;
          try {
            transport = await Transport.reconnect(identity, loaded);
          } catch (err) {
            if (epoch !== epochRef.current) return;
            if (!shouldReconnectRef.current) return;
            // Protocol mismatch is TERMINAL — retrying can't change a
            // version check. Stop the auto-reconnect loop and surface a
            // terminal `error` (the message names which side is outdated
            // via `err.outdatedSide`); the user re-attempts via reset()
            // after updating. KEEP `paired` so the update screen can
            // still show host context, like the offline path.
            if (err instanceof IncompatibleProtocolError) {
              shouldReconnectRef.current = false;
              setProtocolError(err);
              setState({ status: "error", error: err });
              setInitialized(true);
              return;
            }
            // Boot reconnect failed. We deliberately do NOT clear the
            // paired credential — a failure is overwhelmingly a transient
            // unreachable daemon (Mac asleep, daemon not running, network
            // blip), not a permanent identity rotation. Go offline +
            // schedule a backoff retry, KEEP `paired` populated so the
            // session list / settings keep their host context, and mark
            // initialized so the splash hands off to the real UI instead
            // of hanging on a blank screen for the whole handshake window.
            // A genuinely-dead pairing just retries forever at `offline`;
            // the user clears it via Settings → Forget host (`unpair()`).
            const reason = err instanceof Error ? err.message : String(err);
            const delay = reconnectDelayMs(attempt);
            console.log(
              `[transport] connect attempt=${attempt} failed (${reason}) — retry in ${delay}ms ${new Date().toISOString()}`,
            );
            setState({ status: "offline", reason, attempt });
            reconnectTimerRef.current = setTimeout(
              () => handleBootRetry(epoch, attempt),
              delay,
            );
            setInitialized(true);
            return;
          }
          if (epoch !== epochRef.current) {
            transport.close();
            return;
          }
          {
            const d = transport.transportDiagnostics();
            console.log(
              `[transport] ready kind=${d.kind} wire=${d.wireMs}ms hello=${d.helloMs}ms attempt=${attempt} ${new Date().toISOString()}`,
            );
          }
          transport.setOnUnexpectedClose(() => handleUnexpectedClose(epoch));
          transportRef.current = transport;
          // Attach to the stable facade — readyPromise resolves and
          // every registered Subscription replays against the new
          // transport (with sinceCursor + sinceEpoch hints for
          // incremental resume).
          facade._attachTransport(transport);
          setProtocolError(null);
          setState({ status: "ready" });
          setInitialized(true);
        } catch (err) {
          if (epoch !== epochRef.current) return;
          setState({
            status: "error",
            error: err instanceof Error ? err : new Error(String(err)),
          });
          setInitialized(true);
        }
      })();
    },
    // handleBootRetry / handleUnexpectedClose are useEffectEvent —
    // stable-identity by contract, intentionally excluded from deps.
    [clearReconnectTimer],
  );

  // First-time pair via a freshly-scanned / pasted offer. The Transport.pair
  // call persists PairedDaemon on success, so subsequent boots skip the
  // pair screen. We bump the epoch to invalidate any in-flight connect()
  // attempt (e.g. if connect() lost the race against pair()).
  //
  // Routing is gated on the identity axis (`paired`), not on connection
  // health, so the route can't flicker mid-pair no matter what `state`
  // does: `paired` stays null until the handshake succeeds, keeping the
  // /onboarding `Stack.Protected` guard active throughout (OnboardingRoute
  // and any stacked pair modal stay mounted, so their local error state
  // survives a failed attempt). We still don't set `connecting` here —
  // there's nothing to show; busy/spinner + error UI are owned locally by
  // the caller (OnboardingRoute / PairModal). This context only mutates
  // `paired`/`state` on outcome. (Before the identity-axis split, a
  // `connecting` here would have flipped isUnpaired false and bounced the
  // router, unmounting the modal and wiping its error — that coupling is
  // gone now that the gate reads `paired`, not `state.status`.)
  const pair = useCallback(
    async (offerB64: string): Promise<void> => {
      epochRef.current += 1;
      const epoch = epochRef.current;
      clearReconnectTimer();
      shouldReconnectRef.current = true;

      try {
        const identity = await loadOrCreateIdentity();
        const offer = decodePairOffer(offerB64);
        const transport = await Transport.pair(identity, offer);
        if (epoch !== epochRef.current) {
          transport.close();
          return;
        }
        // Transport.pair persists PairedDaemon synchronously before
        // resolving, so this read always sees the freshly-written record.
        const loaded = await getPairedDaemon();
        if (!loaded) {
          // Defensive — shouldn't happen, but if SecureStore lied we'd
          // rather fall through to error than render `ready` with no
          // `paired`.
          transport.close();
          throw new Error("paired record missing after successful pair");
        }
        if (epoch !== epochRef.current) {
          transport.close();
          return;
        }
        // Swap: detach old transport first, close it, attach new one.
        const prevTransport = transportRef.current;
        transportRef.current = null;
        if (prevTransport !== null) facade._detachTransport();
        prevTransport?.close();
        transport.setOnUnexpectedClose(() => handleUnexpectedClose(epoch));
        transportRef.current = transport;
        facade._attachTransport(transport);
        setPaired(loaded);
        setProtocolError(null);
        setState({ status: "ready" });
        setInitialized(true);
      } catch (err) {
        if (epoch !== epochRef.current) return;
        // State is already `unpaired` (we never flipped it). Just rethrow
        // so the caller (OnboardingRoute / PairModal) can surface the
        // error in its local UI state.
        throw err;
      }
    },
    // handleUnexpectedClose is useEffectEvent — see note in `connect`.
    [clearReconnectTimer],
  );

  // Explicit user-initiated unpair (settings → host → "Forget host").
  // Bumps the epoch like connect/pair so any in-flight reconnect is
  // dropped, then closes the active client, wipes SecureStore, and flips
  // state to `unpaired`. The root Stack.Protected guard does the route
  // switch. Sets shouldReconnectRef to false so a late-firing
  // onUnexpectedClose / backoff-timer-fire doesn't resurrect anything.
  const unpair = useCallback(async (): Promise<void> => {
    epochRef.current += 1;
    shouldReconnectRef.current = false;
    clearReconnectTimer();
    const prevTransport = transportRef.current;
    transportRef.current = null;
    if (prevTransport !== null) facade._detachTransport();
    prevTransport?.close();
    await clearPairedDaemon();
    setPaired(null);
    setProtocolError(null);
    setState({ status: "unpaired" });
  }, [clearReconnectTimer]);

  useEffect(() => {
    connect();
    return () => {
      epochRef.current += 1;
      shouldReconnectRef.current = false;
      clearReconnectTimer();
      const prevTransport = transportRef.current;
      transportRef.current = null;
      if (prevTransport !== null) facade._detachTransport();
      prevTransport?.close();
    };
  }, [connect, clearReconnectTimer]);

  const reset = useCallback(() => connect(0), [connect]);

  const value = useMemo<DaemonClientContextValue>(
    () => ({
      client: facade,
      state,
      paired,
      protocolError,
      initialized,
      reset,
      pair,
      unpair,
    }),
    [state, paired, protocolError, initialized, reset, pair, unpair],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

interface UseDaemonClientResult {
  /** Stable facade reference, valid for the Provider's lifetime. RPCs
   *  on this object await the underlying transport's readyPromise
   *  internally; the facade survives every reconnect transparently.
   *  Use `connectionStatus` / `isUnpaired` / `isInitialized` for UI
   *  badges that need to show offline / connecting state. */
  client: DaemonClient;
  /**
   * Persisted paired-daemon record (serviceName + daemon pubkey).
   * Available throughout `ready` AND `offline` AND reconnect-loop
   * windows — only `null` when there's no record on disk (initial
   * unpaired, or after an explicit `unpair()` / first-boot identity-
   * rotation fallback). Settings UI relies on this to keep showing host
   * info while the transport is dropped.
   */
  paired: PairedDaemon | null;
  /** True during any in-flight handshake (initial boot AND every reset/reconnect). */
  isLoading: boolean;
  /** True when there's no paired credential (`paired === null`) — the app
   *  should route to the pair screen. This is the IDENTITY axis and the
   *  ONLY signal the route gate depends on; it's deliberately decoupled
   *  from connection health (connecting/ready/offline/error) so a transient
   *  health state can never flip the onboarding↔main route. Distinct from
   *  `error`: being unpaired is an expected first-launch state, not a fault. */
  isUnpaired: boolean;
  /** Sticky: true once we've reached any settled state (ready, unpaired,
   *  or error). Use this for one-shot UX like the splash gate. */
  isInitialized: boolean;
  error: Error | null;
  /** True while a protocol mismatch blocks this pairing — the
   *  update-required route gate keys off this (alongside `isUnpaired`).
   *  Sticky through retry windows, unlike `error`; details (direction,
   *  copy, versions) are on `protocolError`. */
  isProtocolBlocked: boolean;
  /** The mismatch record behind `isProtocolBlocked` — `outdatedSide`
   *  picks the update-required screen's copy + primary action. */
  protocolError: IncompatibleProtocolError | null;
  /**
   * 4-tone status for UI badges (connecting / online / offline / error).
   * `null` when there's nothing to show (`unpaired` — pair screen is
   * already up). See ConnectionStatus type for tone mapping.
   */
  connectionStatus: ConnectionStatus | null;
  /** Tear down the current connection (if any) and re-run the boot path. */
  reset: () => void;
  /** Run a first-time pair from a base64url offer string. */
  pair: (offerB64: string) => Promise<void>;
  /** Forget the paired host: close, wipe SecureStore, route to /onboarding. */
  unpair: () => Promise<void>;
}

export function useDaemonClient(): UseDaemonClientResult {
  const v = useContext(Ctx);
  if (!v) {
    throw new Error(
      "useDaemonClient must be used inside <DaemonClientProvider>",
    );
  }
  const {
    client,
    state,
    paired,
    protocolError,
    initialized,
    reset,
    pair,
    unpair,
  } = v;
  return {
    client,
    paired,
    isLoading: state.status === "connecting",
    // Routing keys off the IDENTITY axis (`paired`), never connection
    // health. A health transition (connecting/ready/offline/error) must
    // never flip the onboarding↔main route — only acquiring or clearing a
    // credential does. `paired === null` ⟺ no credential ⟺ show pair screen.
    isUnpaired: paired === null,
    isInitialized: initialized,
    error: state.status === "error" ? state.error : null,
    isProtocolBlocked: protocolError !== null,
    protocolError,
    // No credential → nothing to badge (the pair screen is up); otherwise
    // the live health tone. Mirrors `isUnpaired` keying off identity.
    connectionStatus: paired === null ? null : deriveConnectionStatus(state),
    reset,
    pair,
    unpair,
  };
}
