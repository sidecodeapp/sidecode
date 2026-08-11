import type { Command, DaemonFrame } from "@thinkite/protocol";

/**
 * Per-peer dispatch context handed to every command handler invocation.
 * The handler uses `send` to push responses or events back to this peer.
 *
 * Transport-agnostic: IrohPeerServer and the in-process
 * server (deleted) both produce the same shape. Lives in its own module
 * so the router doesn't import the transport, and the transport doesn't
 * import the router.
 */
export interface CommandContext {
  send: (frame: DaemonFrame) => void;
  /** ed25519 fingerprint (16 hex chars) of the authenticated peer. */
  fingerprint: string;
  /**
   * Register a callback to fire when this peer disconnects. Used by
   * subscription handlers (slice G2) to drop their runtime subscriber
   * fanouts on disconnect — implicit unsubscribe-all-for-this-peer.
   *
   * Callbacks fire in registration order. Exceptions are logged and
   * swallowed so one bad cleanup doesn't skip the rest. The same `cb`
   * reference can be registered multiple times — useless usually; harmless
   * if it happens (just runs N times on close). Callers should ensure
   * the underlying cleanup is idempotent (SessionRuntime's unsubscribe
   * closures already are).
   */
  onDisconnect: (cb: () => void) => void;
  /**
   * Per-peer scratch storage shared across every CommandContext for this
   * peer — `ctx.send` itself is recreated per command so can't be a stable
   * WeakMap key. Router uses this to track per-peer subscriptions:
   * `Map<sessionId, unsubscribeFn>` keyed by a string the router picks
   * (e.g. `"subs"`).
   *
   * Untyped on purpose so multiple handlers can stash their own state
   * without coupling them through CommandContext shape. Router agrees on
   * the keys + value types it uses; the transport just owns the slot.
   */
  state: Map<string, unknown>;
}

/** Dispatched for every authenticated command frame. May be async. The
 *  transport catches thrown errors and emits an `error` frame; handlers
 *  that want a structured response should send it via `ctx.send` instead
 *  of throwing. */
export type CommandHandler = (
  cmd: Command,
  ctx: CommandContext,
) => void | Promise<void>;
