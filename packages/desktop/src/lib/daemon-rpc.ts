import {
  type Command,
  type DaemonFrame,
  daemonFrame,
  type EventDelta,
  PROTOCOL_VERSION,
  type SessionState,
  type TimelineItem,
  type TurnUsage,
} from "@thinkite/protocol";

// WebSocket client for the daemon's /rpc bridge — the local counterpart of
// iOS's daemon-client.ts, minus everything transport-establishment
// (iroh dial, pairing, version gating): the daemon lives in the
// server process this page was served from, so "connect" is one ws() call
// and the protocol package on both ends is the same import.
//
// Reconnect is silent and infinite (exponential backoff, 5s cap). In-flight
// requests reject on drop; registered subscriptions re-issue on the next
// open, and the daemon serves a fresh initial snapshot — which is exactly
// the truncate-then-insert contract the collection sync handlers expect.

export interface SessionsSubscription {
  onInitial(entries: Array<{ sessionId: string; state: SessionState }>): void;
  onChange(sessionId: string, state: SessionState): void;
  onRemove(sessionId: string): void;
}

/** Payload delivered to a transcript subscription's onSubscribed — the
 *  cold/warm distinction mirrors iOS's SubscriptionAttached:
 *  `recovered: false` = full snapshot, truncate + ingest `settled`;
 *  `recovered: true` = incremental resume, keep state, gap events replay
 *  via onEvent. */
export interface TranscriptAttached {
  recovered: boolean;
  settled: TimelineItem[];
  cursor: number;
  initialUsage?: TurnUsage;
}

export interface TranscriptSubscription {
  onEvent(delta: EventDelta): void;
  onSubscribed(info: TranscriptAttached): void;
}

interface SessionSubEntry {
  callbacks: TranscriptSubscription;
  /** Last cursor consumed via an event frame OR set from a cold-path
   *  response — the next (re)attach passes it back as sinceCursor. */
  cursor: number | null;
  /** Daemon process epoch from the last subscribe.response; passed back
   *  as sinceEpoch — a mismatch (daemon restart) forces the cold path. */
  epoch: string | null;
}

interface Pending {
  resolve: (frame: DaemonFrame) => void;
  reject: (err: Error) => void;
}

class DaemonRpc {
  #ws: WebSocket | null = null;
  #pending = new Map<string, Pending>();
  #sessionsSub: SessionsSubscription | null = null;
  #sessionSubs = new Map<string, SessionSubEntry>();
  #backoff = 500;
  #reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  #disposed = false;

  constructor() {
    this.#connect();
  }

  /** HMR hygiene: close the socket and stop reconnecting so a hot-swapped
   *  module instance doesn't leave a zombie connection (and its
   *  subscription fanout) alive on the daemon. */
  dispose(): void {
    this.#disposed = true;
    if (this.#reconnectTimer !== null) clearTimeout(this.#reconnectTimer);
    this.#ws?.close();
  }

  /**
   * Register the (single) sessions-stream consumer. Issues the
   * subscribeSessions RPC now if connected, and again after every
   * reconnect — each (re)issue delivers a fresh `onInitial` ground-truth
   * snapshot. Router-side cleanup is implicit on socket close, so
   * `unsubscribe` only stops local routing.
   */
  subscribeSessions(sub: SessionsSubscription): { unsubscribe(): void } {
    if (this.#sessionsSub !== null) {
      throw new Error("subscribeSessions: already subscribed");
    }
    this.#sessionsSub = sub;
    if (this.#ws?.readyState === WebSocket.OPEN) {
      void this.#issueSubscribeSessions();
    }
    return {
      unsubscribe: () => {
        if (this.#sessionsSub === sub) this.#sessionsSub = null;
      },
    };
  }

  /**
   * Open the live transcript stream for one session (single consumer per
   * session — the transcript collection factory). Issues the subscribe
   * RPC now if connected, and again after every reconnect with the
   * entry's cursor/epoch as resume hints — the daemon serves the warm
   * (incremental) path when it can and falls back to a fresh snapshot,
   * which onSubscribed surfaces as `recovered: false`.
   */
  subscribeSession(
    sessionId: string,
    callbacks: TranscriptSubscription,
  ): { unsubscribe(): void } {
    if (this.#sessionSubs.has(sessionId)) {
      throw new Error(`subscribeSession: already subscribed: ${sessionId}`);
    }
    const entry: SessionSubEntry = { callbacks, cursor: null, epoch: null };
    this.#sessionSubs.set(sessionId, entry);
    if (this.#ws?.readyState === WebSocket.OPEN) {
      void this.#issueSubscribeSession(sessionId, entry);
    }
    return {
      unsubscribe: () => {
        if (this.#sessionSubs.get(sessionId) !== entry) return;
        this.#sessionSubs.delete(sessionId);
        if (this.#ws?.readyState === WebSocket.OPEN) {
          // Fire-and-forget: socket close also implicitly unsubscribes.
          void this.#request({
            type: "unsubscribe",
            requestId: crypto.randomUUID(),
            sessionId,
          }).catch(() => {});
        }
      },
    };
  }

  async #issueSubscribeSession(
    sessionId: string,
    entry: SessionSubEntry,
  ): Promise<void> {
    try {
      const res = await this.#request({
        type: "subscribe",
        requestId: crypto.randomUUID(),
        sessionId,
        ...(entry.cursor !== null && entry.epoch !== null
          ? { sinceCursor: entry.cursor, sinceEpoch: entry.epoch }
          : {}),
      });
      if (res.type !== "subscribe.response") return;
      // Unsubscribed (or replaced) during the await — don't deliver.
      if (this.#sessionSubs.get(sessionId) !== entry) return;
      entry.epoch = res.epoch;
      // Cold path: the response cursor IS the high-water mark. Warm path:
      // leave it — the replayed gap events advance it one frame at a time.
      if (!res.recovered) entry.cursor = res.cursor;
      entry.callbacks.onSubscribed({
        recovered: res.recovered,
        settled: res.settled,
        cursor: res.cursor,
        initialUsage: res.initialUsage,
      });
    } catch (err) {
      // Connection dropped mid-flight — the reconnect path re-issues.
      console.warn("[daemon-rpc] subscribe failed:", err);
    }
  }

  /**
   * Send a user prompt into a session. Resolves when the daemon accepted
   * the turn (the reply itself streams via session state + JSONL).
   * `userMessageUuid` lets the caller optimistically render the bubble
   * under the same uuid the daemon will persist — dedupe by key, no
   * double bubble.
   */
  async sendPrompt(opts: {
    sessionId: string;
    text: string;
    cwd?: string;
    userMessageUuid?: string;
    model?: string;
  }): Promise<void> {
    await this.#request({
      type: "sendPrompt",
      requestId: crypto.randomUUID(),
      ...opts,
    });
  }

  /** Stop the live turn — the session and subprocess stay alive for
   *  follow-up prompts. */
  async interrupt(sessionId: string): Promise<void> {
    await this.#request({
      type: "interrupt",
      requestId: crypto.randomUUID(),
      sessionId,
    });
  }

  /** Pick-time commit of the model selection (not bundled with sendPrompt):
   *  the daemon applies it to the live query via applyFlagSettings, then
   *  persists to session metadata. Rejects when the control-plane apply
   *  fails — callers roll back their optimistic picker state. */
  async setSessionSelection(sessionId: string, model: string): Promise<void> {
    await this.#request({
      type: "setSessionSelection",
      requestId: crypto.randomUUID(),
      sessionId,
      model,
    });
  }

  #connect(): void {
    if (this.#disposed) return;
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${location.host}/rpc`);
    this.#ws = ws;
    ws.onopen = () => {
      this.#backoff = 500;
      ws.send(
        JSON.stringify({ type: "hello", protocolVersion: PROTOCOL_VERSION }),
      );
      if (this.#sessionsSub !== null) void this.#issueSubscribeSessions();
      for (const [sessionId, entry] of this.#sessionSubs) {
        void this.#issueSubscribeSession(sessionId, entry);
      }
    };
    ws.onmessage = (ev) => {
      if (typeof ev.data === "string") this.#onFrame(ev.data);
    };
    ws.onclose = () => {
      this.#ws = null;
      const dropped = new Error("daemon connection closed");
      for (const p of this.#pending.values()) p.reject(dropped);
      this.#pending.clear();
      if (this.#disposed) return;
      this.#reconnectTimer = setTimeout(() => this.#connect(), this.#backoff);
      this.#backoff = Math.min(this.#backoff * 2, 5_000);
    };
  }

  #onFrame(text: string): void {
    let frame: DaemonFrame;
    try {
      frame = daemonFrame.parse(JSON.parse(text));
    } catch (err) {
      console.warn("[daemon-rpc] dropped unparseable frame:", err);
      return;
    }
    switch (frame.type) {
      case "server_info":
      case "pong":
        return;
      case "session_state_changed":
        this.#sessionsSub?.onChange(frame.sessionId, frame.state);
        return;
      case "session_state_removed":
        this.#sessionsSub?.onRemove(frame.sessionId);
        return;
      case "event": {
        const entry = this.#sessionSubs.get(frame.sessionId);
        if (entry === undefined) return;
        entry.cursor = frame.cursor;
        entry.callbacks.onEvent(frame.delta);
        return;
      }
      default: {
        const requestId =
          "requestId" in frame ? (frame.requestId as string) : undefined;
        const pending =
          requestId === undefined ? undefined : this.#pending.get(requestId);
        if (pending === undefined) return;
        this.#pending.delete(requestId!);
        if (frame.type === "error") {
          pending.reject(new Error(`${frame.code}: ${frame.message}`));
        } else {
          pending.resolve(frame);
        }
      }
    }
  }

  #request(cmd: Command): Promise<DaemonFrame> {
    const ws = this.#ws;
    if (ws === null || ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("daemon connection not open"));
    }
    const requestId = (cmd as { requestId: string }).requestId;
    return new Promise<DaemonFrame>((resolve, reject) => {
      this.#pending.set(requestId, { resolve, reject });
      ws.send(JSON.stringify(cmd));
    });
  }

  async #issueSubscribeSessions(): Promise<void> {
    try {
      const res = await this.#request({
        type: "subscribeSessions",
        requestId: crypto.randomUUID(),
      });
      if (res.type === "subscribeSessions.response") {
        this.#sessionsSub?.onInitial(res.initial);
      }
    } catch (err) {
      // Connection dropped mid-flight — the reconnect path re-issues.
      console.warn("[daemon-rpc] subscribeSessions failed:", err);
    }
  }
}

export const daemonRpc = new DaemonRpc();

if (import.meta.hot) {
  import.meta.hot.dispose(() => daemonRpc.dispose());
}
