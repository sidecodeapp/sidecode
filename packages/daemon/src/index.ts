import {
  getSessionInfo,
  getSessionMessages,
} from "@anthropic-ai/claude-agent-sdk";
import { type EventDelta, PROTOCOL_VERSION } from "@thinkite/protocol";
import { BridgeService } from "./bridge/bridge-service.ts";
import { OAuthRefreshManager } from "./bridge/oauth-refresh.ts";
import {
  reattachBridgedSessions,
  summarizeReattach,
} from "./bridge/startup-reattach.ts";
import { deleteDaemonLock, writeDaemonLock } from "./daemon-lock.ts";
import { GitWatcherRegistry } from "./git-watch.ts";
import { resolveThinkiteHome } from "./home.ts";
import { loadOrCreateIdentity } from "./identity.ts";
import { KnownClients } from "./known-clients.ts";
import {
  createLocalConnection,
  type LocalConnection,
  type LocalConnectionOptions,
} from "./local-connection.ts";
import { foldEventDelta } from "./messages/fold.ts";
import { extractLatestUsage, normalize } from "./messages/normalize.ts";
import { createPairOffer } from "./pairing.ts";
import { createPlanUsageFetcher, type PlanUsageResult } from "./plan-usage.ts";
import { createCommandHandler } from "./router.ts";
import { ensureSessionLoop, pushPrompt } from "./runtime/run-query.ts";
import { SessionRuntimeManager } from "./runtime/session-runtime-manager.ts";
import {
  clearBridgeWorkerState,
  listSidecodeSessions,
  writeBridgeWorkerState,
} from "./sidecode-sessions.ts";
import { IrohPeerServer } from "./iroh-peer-server.ts";
import { WebRTCPeerServer } from "./webrtc-peer.ts";

export interface DaemonOptions {
  /** Override THINKITE_HOME. */
  homeDir?: string;
  /** Override signaling host (for `wrangler dev`). */
  signalingHost?: string;
  signalingScheme?: "ws" | "wss";
  /**
   * Absolute path to the bundled `claude` SEA binary to spawn. The Electron
   * host (menubar) computes this because it owns packaging: in the packaged
   * .app the binary is `asarUnpack`'d to a fixed `Resources/app.asar.unpacked/`
   * location, and the SDK's own resolution would otherwise point INSIDE
   * `app.asar` (a file) → `spawn ENOTDIR`. Omit in dev: the SDK resolves its
   * platform package from node_modules itself (no asar). The daemon stays
   * electron-agnostic and just forwards this into every claude spawn.
   */
  claudeExecutablePath?: string;
}

export type { DaemonLock } from "./daemon-lock.ts";

// Host-side single-instance guard: `start()` only WRITES the lock (liveness
// record); a host that may coexist with another daemon (deno desktop while
// the menubar app runs) checks before starting.
export { readActiveDaemonLock } from "./daemon-lock.ts";
export { resolveThinkiteHome } from "./home.ts";
export type {
  LocalConnection,
  LocalConnectionOptions,
} from "./local-connection.ts";
export type {
  PlanUsage,
  PlanUsageResult,
  PlanUsageWindow,
} from "./plan-usage.ts";

export interface Daemon {
  stop(): Promise<void>;
  /** Identity fingerprint, for status / pair display. */
  readonly fingerprint: string;
  /** Number of paired clients in known_clients.json (snapshot). */
  pairedClientCount(): number;
  /** Number of currently authenticated WebRTC peers. */
  authenticatedPeerCount(): number;
  /**
   * Mint a fresh pair offer pointing at this daemon. Pure: derived from the
   * daemon's identity + the given serviceName — no per-offer state, no
   * nonces, no clock dependency, NO side effects. The same daemon always
   * mints the same offer, so a caller can mint once and cache it.
   *
   * Admission is controlled separately via `setPairing` — minting an offer
   * does NOT open the gate.
   */
  createPairOffer(serviceName: string): { encoded: string };
  /**
   * Open / close the pair-window admission gate. While open, an unknown
   * client pubkey that connects is admitted to known_clients; while closed,
   * unknown pubkeys are rejected. The menubar flips this on the Pair
   * window's open/close — the window being visible IS the gate, so closing
   * it stops admitting new devices immediately (no trailing TTL).
   * Already-paired clients reconnect regardless of this flag.
   */
  setPairing(open: boolean): void;
  /**
   * Per-session runtime manager. Empty until slice G wires it into the
   * router; surfaced here so daemon.stop() can drain it on shutdown and
   * tests can inspect it.
   */
  readonly runtimeManager: SessionRuntimeManager<EventDelta>;
  /**
   * CCR bridge mirror service (slice M1). Owns the OAuthRefreshManager + all
   * live BridgeTransports. Surfaced so the M1.5 spike (and future RPC wiring
   * in M4) can `attach` sessions, and so daemon.stop() drains it. Empty in
   * normal operation until a session is bridged.
   */
  readonly bridgeService: BridgeService;
  /**
   * Plan-utilization snapshot for the menubar's "Claude Plan Usage" rows
   * (5h / weekly / per-model % + reset times). Never throws — returns a
   * closed result union (`ok` / `signed_out` / `error`); single-flight +
   * 30s cache inside, so call freely on every tray click. The OAuth token
   * stays inside the daemon; callers get parsed numbers only.
   */
  fetchPlanUsage(): Promise<PlanUsageResult>;
  /**
   * Open an in-process client connection to the command router — the same
   * RPC surface WebRTC peers get (sendPrompt, subscribe, subscribeSessions,
   * …), minus pairing/auth: the caller is the host process, already inside
   * the trust boundary. One connection per client socket; `close()` fires
   * the router's per-connection cleanups and must be called when the
   * client goes away. Open connections are closed by `stop()`.
   */
  connectLocal(options: LocalConnectionOptions): LocalConnection;
}

export async function start(options: DaemonOptions = {}): Promise<Daemon> {
  const home = options.homeDir ?? resolveThinkiteHome();
  const identity = loadOrCreateIdentity(home);
  const knownClients = KnownClients.load(home);

  // sidecode spawns the SDK's OWN bundled claude binary (shipped in the .app)
  // and authenticates it by passing the user's keychain OAuth token via env at
  // spawn time (run-query + OAuthRefreshManager). No system-claude resolution,
  // no PATH probing — we ship the version. The one prerequisite is that the
  // user has logged in to Claude Code once (keychain `Claude Code-credentials`,
  // via `claude /login` or Claude Desktop); a missing login surfaces per-turn
  // as a `turn_failed` with a "run claude /login" message.
  //
  // Mark sidecode-driven sessions with a remote-mobile entrypoint (not the SDK
  // default `sdk-ts`) so they stay visible in the user's `claude --resume`
  // picker, which hides sessions whose entrypoint is in the SDK set. Respect a
  // pre-set value (operator / test wins).
  process.env.CLAUDE_CODE_ENTRYPOINT ??= "remote_mobile";

  // Pair-window admission gate. The menubar flips this via `setPairing` on
  // the Pair window's open/close; `WebRTCPeerServer.isPairing` reads it on
  // every `peer.joined`. Closed by default — the window must be open for an
  // unknown pubkey to be admitted.
  //
  // THINKITE_PAIRING_OPEN=1 forces the gate open for the whole daemon
  // lifetime — dev/CLI affordance for pairing a fresh device when the
  // daemon runs headless via `thinkite up` (the CLI `pair` command
  // prints the QR from a separate process, so it can't flip the
  // in-process gate the way the menubar window does). Don't run a
  // long-lived daemon with this set: any device that scans the QR (or
  // learns the pubkey) gets admitted while it's up.
  let pairingOpen = process.env.THINKITE_PAIRING_OPEN === "1";
  if (pairingOpen) {
    console.log(
      "[sidecode] pairing gate FORCED OPEN via THINKITE_PAIRING_OPEN=1 — new devices will be admitted",
    );
  }

  // Lazy-populated by slice G's router when it sees its first sendPrompt.
  // Drained on shutdown via daemon.stop() → runtimeManager.shutdown().
  // `foldDelta` wires the continuous-fold reducer so each runtime keeps its
  // in-memory `settled` snapshot current as events fan out (no per-turn
  // JSONL re-read — see messages/fold.ts). `log` plumbs M3.7 teardown
  // structured-log events ("[teardown] armed/canceled/fired ...") through
  // the same `[sidecode]` stdout channel everything else uses.
  const runtimeManager = new SessionRuntimeManager<EventDelta>({
    foldDelta: foldEventDelta,
    log: (msg) => console.log(`[sidecode] ${msg}`),
  });
  // #17 — bind the sidecode home so the manager can read disk metadata
  // for `getAllSessionStates` (subscribeSessions initial snapshot) AND
  // persist `lastActivityAt` via `updateSidecodeSessionLastActivity` on
  // each activity edge. Tests use a memory-only manager (no setHome)
  // and skip the persistence path.
  runtimeManager.setHome(home);
  // CCR bridge mirror service (slice M1). One OAuthRefreshManager (the
  // keychain token is process-global) feeds every bridge; BridgeService
  // ref-counts its proactive timer to live only while ≥1 bridge is attached.
  // Drained in daemon.stop() AFTER runtimeManager.shutdown() so no late
  // forwardToBridge write races the transport close.
  //
  // Lifted out so the M3.4 startup-reattach orchestrator below shares the
  // SAME OAuth instance — the keychain token is process-global, and a
  // duplicate manager would double-refresh.
  const oauth = new OAuthRefreshManager();
  const bridgeService = new BridgeService({
    oauth,
    home,
    log: (message) => console.log(`[sidecode] ${message}`),
    // M3.3 upgrade backfill source — a session's prior history as raw
    // SDKMessages (user/assistant only; system/result are live-only
    // envelopes) to flush to the cloud transcript when a pure session is
    // upgraded to bridged.
    readHistory: async (cliSessionId, cwd) => {
      const msgs = await getSessionMessages(
        cliSessionId,
        cwd === undefined ? undefined : { dir: cwd },
      );
      return msgs.filter((m) => m.type === "user" || m.type === "assistant");
    },
    // Mirror every bridge worker-state write/clear into the manager cache so
    // the iOS-facing `bridged` flag converges live — BridgeService writes the
    // metadata `bridge` subtree directly, outside the manager's
    // persistMetadata, so the cache would otherwise stay stale.
    persist: {
      writeBridgeWorkerState: (h, sid, ws) => {
        const result = writeBridgeWorkerState(h, sid, ws);
        runtimeManager.notifyBridgeChanged(sid);
        return result;
      },
      clearBridgeWorkerState: (h, sid) => {
        const result = clearBridgeWorkerState(h, sid);
        runtimeManager.notifyBridgeChanged(sid);
        return result;
      },
    },
    // M2.2 read-in: a claude.ai-typed prompt → drive this session's local
    // turn. The reply streams back via M1's write-out tap; reusing the
    // inbound uuid makes the synthesized user_message's write-back fold
    // against claude.ai's own copy (dedup-by-uuid verified — no double
    // bubble, no origin tracking). Wiring this also flips every attached
    // transport to bidirectional.
    onInboundPrompt: async (sessionId, prompt) => {
      const runtime = runtimeManager.get(sessionId);
      if (runtime === undefined) {
        // No local runtime for this bridged session. Linking a cse_ to a
        // local runtime + spawning its loop is M3 (create-bridged / startup
        // re-attach); until then there's nothing local to drive.
        console.log(
          `[sidecode] bridge inbound for session ${sessionId} with no runtime — dropped`,
        );
        return;
      }
      // Ensure a query loop, then feed the prompt. ensureSessionLoop is
      // idempotent (no-op if already running) and sets inputChannel
      // synchronously, so the immediately-following pushPrompt always finds
      // a live channel. resume mode: a bridged session taking claude.ai
      // prompts has cloud history; the local create-vs-resume + cwd-from-cse
      // refinement is M3. pushPrompt is UNCHANGED from the local/iOS path —
      // bridge / local / iOS prompts share one code path.
      try {
        // Same per-spawn token as the iOS/local path — the bundled binary
        // gets it via env. A creds failure surfaces as turn_failed (forwarded
        // to claude.ai by the bridge mirror) rather than a silent drop.
        const oauthToken = await oauth.ensureFresh();
        ensureSessionLoop(runtime, {
          mode: "resume",
          oauthToken,
          claudeExecutablePath: options.claudeExecutablePath,
        });
        pushPrompt(runtime, prompt.text, prompt.images, prompt.uuid);
      } catch (err) {
        runtime.addEvent({
          kind: "turn_failed",
          error: err instanceof Error ? err.message : String(err),
        });
        console.log(
          `[sidecode] bridge inbound prompt failed for ${sessionId}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    },
    // M2.4 control routing: claude.ai pressed stop. Mirror of router's
    // `interrupt` RPC handler (router.ts):
    //   1. Synchronously mark `runtime.interrupted = true` BEFORE the await —
    //      the SDK ends an interrupted turn with `error_during_execution`,
    //      which handleResultEnvelope swallows when this flag is set so it
    //      isn't surfaced as a spurious turn_failed.
    //   2. await query.interrupt().
    //   3. addEvent({ kind: "turn_canceled" }) — so WebRTC subscribers see
    //      the cancel immediately. NOT mirrored to bridge (not in
    //      forwardToBridge allowlist), which is correct: claude.ai initiated
    //      the interrupt + SDK already auto-sent control_response:success;
    //      its spinner closes on the next `result` envelope via sendResult().
    // Best-effort: no live query → silent no-op (matches router's interrupt
    // semantics). Errors are logged but never propagate (would crash the
    // SDK's SSE read loop otherwise; the transport's try/catch is a 2nd net).
    onInterrupt: async (sessionId) => {
      const runtime = runtimeManager.get(sessionId);
      if (!runtime?.query) return;
      try {
        runtime.interrupted = true;
        await runtime.query.interrupt();
        runtime.addEvent({ kind: "turn_canceled" });
      } catch (err) {
        console.log(
          `[sidecode] bridge interrupt failed for ${sessionId}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    },
    // M2.4 control routing: claude.ai changed the model. Mirror of router's
    // `setSessionSelection` RPC handler:
    //   1. apply to the live query via applyFlagSettings({model}) — per
    //      upstream docs this behaves identically to the dedicated setModel().
    //   2. manager.setModel — updates runtime.currentModel + memory cache +
    //      disk + #17 fan-out to every iOS subscribeSessions listener.
    //   3. reportMetadata — PUT /worker external_metadata so any OTHER
    //      CCR client (multi-tab claude.ai) sees the new model.
    //   4. SDK auto-sends control_response:success — we owe no response.
    // Order: apply first, persist second — if apply throws (model not
    // allowed by the account, etc.), the runtime + disk stay untouched so
    // nothing drifts from what the live query actually has.
    onSetModel: async (sessionId, model) => {
      const runtime = runtimeManager.get(sessionId);
      try {
        if (runtime?.query?.applyFlagSettings) {
          await runtime.query.applyFlagSettings({ model });
        }
        const changed = runtimeManager.setModel(sessionId, model);
        if (changed) {
          // The initiating tab will see its own echo, but reportMetadata
          // is idempotent (same value = same external_metadata = no
          // visible churn).
          runtime?.bridge?.reportMetadata?.({ model: model ?? null });
        }
      } catch (err) {
        console.log(
          `[sidecode] bridge setModel failed for ${sessionId}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    },
  });
  // Set in daemon.stop() before runtimeManager.shutdown(). Router gates
  // sendPrompt behind it (see RouterDeps.isShuttingDown rationale).
  let shuttingDown = false;
  // One GitWatcher per cwd, shared across all connections + sessions.
  // Disposed on daemon.stop() to release fs.watch handles cleanly.
  const gitWatchers = new GitWatcherRegistry();

  // Process-wide epoch nonce. Stable for the daemon's lifetime — every
  // subscribe.response carries this so iOS can pass it back as
  // `sinceEpoch` on reconnect. A mismatch tells the daemon it cannot
  // serve an incremental resume (the runtime ring buffers are fresh)
  // and to fall back to the cold-path full snapshot. See RouterDeps.epoch
  // for the longer rationale. UUID is plenty of entropy; we never log
  // or surface this to the user.
  const epoch = crypto.randomUUID();

  const commandHandler = createCommandHandler({
    getMessages: async (cliSessionId, cwd) => {
      // `cwd` is a hint only — when undefined we let the SDK scan every
      // project key. Fork sessions in worktrees may have their JSONL at
      // the worktree's project key OR at originCwd's; the rule isn't
      // deterministic, so iOS omits the hint and we eat the ~20-stat scan
      // rather than mis-route.
      const sdkMessages = await getSessionMessages(
        cliSessionId,
        // `cwd` is a hint only — when undefined the SDK scans every
        // project key (robust for fork sessions where the JSONL location
        // isn't deterministic).
        cwd === undefined ? undefined : { dir: cwd },
        // Deliberately NOT passing `includeSystemMessages: true`. The
        // flag returns system messages but SDK's AH mapper strips
        // `subtype` + `compactMetadata`, leaving anonymous
        // `{type:'system', uuid, ...}` envelopes we can't act on (can't
        // tell compact_boundary from stop_hook_summary). Resume gets
        // no compact_divider for V0; live path emits dividers via
        // run-query.ts handling SDKCompactBoundaryMessage directly,
        // which still has the typed fields. See thinkite/thinkite#13
        // for the long-term fix (self-built session reader that
        // preserves these fields off the raw JSONL).
      );
      // Two derivations from the same SDK call (no duplicate JSONL
      // read): the normalized timeline iOS renders, and the resume-
      // time usage seed for the context meter. extractLatestUsage
      // works on the raw SDK shape — must run BEFORE normalize() (which
      // discards the .message envelope where usage lives).
      return {
        items: normalize(sdkMessages),
        initialUsage: extractLatestUsage(sdkMessages),
      };
    },
    runtimeManager,
    bridgeService,
    hasSession: async (cliSessionId) => {
      const info = await getSessionInfo(cliSessionId);
      return info !== undefined;
    },
    listSidecodeSessions: (opts) => listSidecodeSessions(home, opts),
    isShuttingDown: () => shuttingDown,
    // Per-spawn OAuth token for the bundled binary — same shared keychain
    // manager the CCR bridge uses (one keeper per process).
    ensureFreshToken: () => oauth.ensureFresh(),
    // Host-computed binary path (packaged app) — forwarded into every spawn.
    claudeExecutablePath: options.claudeExecutablePath,
    gitWatchers,
    epoch,
  });

  // Live in-process client connections (deno desktop GUI sockets). Tracked
  // so stop() can fire their router cleanups alongside the WebRTC peers'.
  const localConnections = new Set<LocalConnection>();

  const webrtc = new WebRTCPeerServer({
    identity,
    knownClients,
    commandHandler,
    isPairing: () => pairingOpen,
    signalingHost: options.signalingHost,
    signalingScheme: options.signalingScheme,
    log: (event, data) =>
      console.log(
        `[sidecode] ${event}${data ? ` ${JSON.stringify(data)}` : ""}`,
      ),
  });
  webrtc.start();

  // iroh listener (phase 3) — same identity, same known_clients gate,
  // same commandHandler; runs alongside WebRTC. No client traffic
  // arrives here until the app's dev toggle dials it, so always-on is
  // additive. Failure to load the napi binding (or to bind) degrades to
  // a log line — WebRTC remains the default path either way.
  const iroh = new IrohPeerServer({
    identity,
    knownClients,
    commandHandler,
    isPairing: () => pairingOpen,
    log: (event, data) =>
      console.log(
        `[sidecode] ${event}${data ? ` ${JSON.stringify(data)}` : ""}`,
      ),
  });
  void iroh.start().catch((err: unknown) => {
    console.log(
      `[sidecode] iroh.unavailable ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  });

  // M3.4 startup re-attach (M3.6 SCOPE — includes archived sessions). Scan
  // sidecode metadata for any session with a `bridge` field and revive the
  // BridgeTransport. Fire-and-forget: daemon shouldn't block iOS accept on
  // a (potentially slow) cloud probe per bridged session. iOS subscribe
  // doesn't depend on bridge state — a not-yet-re-attached session behaves
  // like a never-bridged session until the orchestrator catches up; once
  // attached, the inbound prompt handler above starts driving incoming
  // claude.ai messages.
  //
  // No `await` here: a serial multi-session probe could take several
  // seconds and we want the WebRTC peer server to start accepting iOS
  // connections immediately. Errors within a single session don't propagate
  // out of the orchestrator (each session is independently classified +
  // logged); the overall promise should not reject under normal conditions.
  void reattachBridgedSessions({
    home,
    runtimeManager,
    bridgeService,
    oauth,
    log: (msg) => console.log(`[sidecode] ${msg}`),
  })
    .then((summary) => console.log(`[sidecode] ${summarizeReattach(summary)}`))
    .catch((err) =>
      console.log(
        `[sidecode] [bridge] startup re-attach unexpectedly rejected: ${
          err instanceof Error ? err.message : String(err)
        }`,
      ),
    );

  // Advertise that we're running so `sidecode pair` (and the menubar) can
  // mint offers without spawning their own daemon. Address fields are
  // gone — the menubar reaches the daemon via the in-process function
  // call surface above, and the CLI does the same via the spawned-process
  // model. The lock just records "a daemon owns this $THINKITE_HOME".
  writeDaemonLock(home, {
    pid: process.pid,
    startedAt: Date.now(),
  });

  // Best-effort sync cleanup: if our parent kills us ungracefully (signal
  // not delivered to handler, hard SIGKILL elsewhere), we still try to
  // remove the lock here. `pair-command` falls back to PID liveness check
  // so a leftover lock file is harmless either way — it'd just be
  // recognized as stale.
  process.on("exit", () => deleteDaemonLock(home));

  console.log(
    `thinkite daemon (protocol ${PROTOCOL_VERSION}) connecting to signaling.thinkite.dev`,
  );
  console.log(`fingerprint: ${identity.fingerprint}`);
  console.log(`paired clients: ${knownClients.list().length}`);

  return {
    fingerprint: identity.fingerprint,
    pairedClientCount: () => knownClients.list().length,
    authenticatedPeerCount: () =>
      webrtc.authenticatedCount() + iroh.authenticatedCount(),
    fetchPlanUsage: createPlanUsageFetcher(oauth),
    createPairOffer: (serviceName) => {
      const { encoded } = createPairOffer(identity, serviceName);
      return { encoded };
    },
    setPairing: (open) => {
      pairingOpen = open;
    },
    runtimeManager,
    bridgeService,
    connectLocal(options) {
      const inner = createLocalConnection(commandHandler, {
        ...options,
        log: options.log ?? ((msg) => console.log(`[sidecode] ${msg}`)),
      });
      const conn: LocalConnection = {
        dispatchText: (text) => inner.dispatchText(text),
        close: () => {
          localConnections.delete(conn);
          inner.close();
        },
      };
      localConnections.add(conn);
      return conn;
    },
    async stop() {
      // Flip the gate FIRST so any inflight subscribe / sendPrompt RPC
      // racing with shutdown gets rejected before it can spawn a runtime
      // we won't drain.
      shuttingDown = true;
      // Drain SDK queries first so each subprocess gets the chance to
      // finish its current JSONL write before the transport tears down
      // and the process exits. SDK's `close()` triggers an internal 5s
      // grace; per-runtime timeoutMs caps how long we wait per session.
      // bin/thinkite.ts's outer 10s forceExit guards against catastrophic
      // hangs from there.
      await runtimeManager.shutdown(5000);
      // Close all CCR bridge mirrors + stop the OAuth refresh timer AFTER
      // the queries are drained — so no in-flight forwardToBridge write
      // races a transport close. Synchronous (just handle.close() per
      // bridge + clearTimeout); no await needed.
      bridgeService.shutdown();
      // Release fs.watch handles + cached SimpleGit instances; safe to
      // call before or after webrtc.stop(), no interaction with peers.
      gitWatchers.disposeAll();
      deleteDaemonLock(home);
      // Same point in the order as the WebRTC peers below: queries are
      // already drained, so these just run the (idempotent) subscription
      // cleanups. Copy first — close() mutates the set via connectLocal's
      // wrapper.
      for (const conn of [...localConnections]) conn.close();
      await webrtc.stop();
      await iroh.stop();
      console.log("sidecode daemon stopped");
    },
  };
}
