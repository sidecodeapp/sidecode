/**
 * @alpha containment seam for the Agent SDK's `/bridge` subpath.
 *
 * This is the ONLY module in the daemon that imports from
 * `@anthropic-ai/claude-agent-sdk/bridge`. Every CCR/BridgeTransport call
 * goes through the wrappers here, so when the @alpha surface churns (it's
 * been @alpha the entire ~2 months since v0.2.81 — see
 * reference_agent_sdk_bridge_api memory) there is exactly ONE file to fix.
 *
 * Two kinds of wrapping:
 *   - `createCodeSession` / `fetchRemoteCredentials` take POSITIONAL args
 *     (8 and 5 respectively). Positional ordering is the most likely thing
 *     to break on an @alpha bump, and the call sites are unreadable
 *     (`createCodeSession(BASE, token, title, 30000, tags, undefined, cwd,
 *     model)`). We re-expose them as object-args with the host + timeout
 *     defaulted, so callers pass only what they mean.
 *   - `attachBridgeSession` is already object-args and `isCredentialsFailure`
 *     is a type guard — those are pass-through re-exports (still routed
 *     here so the import graph has a single choke point).
 *
 * Signatures verified against the installed bridge.d.ts (SDK 0.3.156,
 * 2026-05-30). Spike reference: spikes/ccr-backfill.mjs (the create →
 * fetchCredentials → attach trio this wraps).
 */

import {
  type AttachBridgeSessionOptions,
  type BridgeSessionHandle,
  type CodeSessionGitContext,
  type CredentialsFailure,
  type RemoteCredentials,
  attachBridgeSession as sdkAttachBridgeSession,
  createCodeSession as sdkCreateCodeSession,
  fetchRemoteCredentials as sdkFetchRemoteCredentials,
  isCreateSessionFailure as sdkIsCreateSessionFailure,
  isCredentialsFailure as sdkIsCredentialsFailure,
} from "@anthropic-ai/claude-agent-sdk/bridge";

// Re-export the @alpha types so downstream modules type against the adapter,
// not the SDK subpath directly (keeps the choke point honest).
export type {
  AttachBridgeSessionOptions,
  BridgeSessionHandle,
  CodeSessionGitContext,
  CredentialsFailure,
  RemoteCredentials,
};

/** Anthropic's production CCR host. The SDK's bridge calls take baseUrl
 *  verbatim (no hardcoded host inside) — we default it here so callers
 *  don't repeat it. Overridable per-call for staging/local pointing. */
export const ANTHROPIC_API_BASE = "https://api.anthropic.com";

/** Default per-call timeout for the create/fetch HTTP wrappers. Matches
 *  the value used across all spikes. */
export const DEFAULT_BRIDGE_TIMEOUT_MS = 30_000;

export interface CreateCodeSessionParams {
  /** OAuth access token (keychain `Claude Code-credentials`). Must be a
   *  full-scope claude.ai login token — inference-only tokens are rejected
   *  by CCR (reference_agent_sdk_bridge_api). */
  accessToken: string;
  /** Becomes the cloud session title (shown on claude.ai). */
  title: string;
  /** Own-tag so sidecode can identify its sessions in `GET /v1/code/sessions`
   *  (e.g. `["sidecode"]`). Unlike runAssistantWorker, the low-level create
   *  honors custom tags. */
  tags?: string[];
  gitContext?: CodeSessionGitContext;
  /** Local working directory. The code-session config DOES carry cwd (fixes
   *  the empty-cwd problem the runAssistantWorker path has). */
  cwd?: string;
  /** Raw SDK model key, e.g. `claude-sonnet-4-6`. */
  model?: string;
  baseUrl?: string;
  timeoutMs?: number;
}

/**
 * `POST {baseUrl}/v1/code/sessions` → `cse_*` id, or `null` on failure.
 *
 * NOTE (spiked): a `null` return is AMBIGUOUS — createCodeSession swallows
 * the HTTP status (validateStatus < 500) so an expired-token 401 looks
 * identical to a network/gate failure. Callers must preflight the token
 * (OAuthRefreshManager.ensureFresh) so a `null` here is known to be
 * non-token. See project_sidecode_ccr_architecture.
 *
 * SDK 0.3.207 added a structured `CreateSessionFailure` to the return
 * union, but it only fires on `session_grouping_id` rejection — a
 * positional param this adapter never passes — so it's unreachable for
 * us. Folded back to `null` (with a log, since it would be genuinely
 * surprising) to keep the caller contract unchanged.
 */
export async function createCodeSession(
  params: CreateCodeSessionParams,
): Promise<string | null> {
  const result = await sdkCreateCodeSession(
    params.baseUrl ?? ANTHROPIC_API_BASE,
    params.accessToken,
    params.title,
    params.timeoutMs ?? DEFAULT_BRIDGE_TIMEOUT_MS,
    params.tags,
    params.gitContext,
    params.cwd,
    params.model,
  );
  if (sdkIsCreateSessionFailure(result)) {
    console.log(
      `[sidecode] [bridge] createCodeSession terminal failure (status ${result.status}): ${result.detail ?? "no detail"}`,
    );
    return null;
  }
  return result;
}

export interface FetchRemoteCredentialsParams {
  /** The `cse_*` id from createCodeSession. */
  sessionId: string;
  accessToken: string;
  /** `X-Trusted-Device-Token` — needed only when the server has
   *  `sessions_elevated_auth_enforcement` on. */
  trustedDeviceToken?: string;
  baseUrl?: string;
  timeoutMs?: number;
}

/**
 * `POST {baseUrl}/v1/code/sessions/{id}/bridge` → worker credentials. The
 * call IS the worker register (bumps the epoch each time — re-fetching is
 * exactly how the proactive jwt refresh works, see ccr-reconnect spike).
 *
 * Returns `RemoteCredentials` on success, a `CredentialsFailure`
 * (`untrusted_device` | `session_stale_relogin` — both terminal, don't
 * retry) on a recoverable-by-relogin failure, or `null` on transport error.
 * Use `isCredentialsFailure` to discriminate.
 */
export function fetchRemoteCredentials(
  params: FetchRemoteCredentialsParams,
): Promise<RemoteCredentials | CredentialsFailure | null> {
  return sdkFetchRemoteCredentials(
    params.sessionId,
    params.baseUrl ?? ANTHROPIC_API_BASE,
    params.accessToken,
    params.timeoutMs ?? DEFAULT_BRIDGE_TIMEOUT_MS,
    params.trustedDeviceToken,
  );
}

/**
 * Open the bidirectional worker transport for a `cse_*` session. Pass-through
 * — the SDK's options object is already ergonomic. Routed here so the
 * `/bridge` import graph stays single-sourced.
 *
 * Returns the executor handle (write / sendResult / sendControl* /
 * reconnectTransport / flush / close / getSequenceNum / isConnected).
 */
export function attachBridgeSession(
  options: AttachBridgeSessionOptions,
): Promise<BridgeSessionHandle> {
  return sdkAttachBridgeSession(options);
}

/** Type guard for `fetchRemoteCredentials` results. */
export function isCredentialsFailure(
  value: RemoteCredentials | CredentialsFailure | null,
): value is CredentialsFailure {
  return sdkIsCredentialsFailure(value);
}

export interface DeleteCodeSessionParams {
  /** The `cse_*` id to hard-delete. */
  sessionId: string;
  accessToken: string;
  /** From `~/.claude.json` oauthAccount.organizationUuid (credentials.readOrgUUID). */
  organizationUuid: string;
  baseUrl?: string;
  timeoutMs?: number;
}

/**
 * `DELETE {baseUrl}/v1/code/sessions/{cseId}` — HARD-delete the cloud cse_
 * (the "downgrade / make private" teardown). The session vanishes from
 * claude.ai; the LOCAL `<cliSessionId>.jsonl` is a separate store and is
 * untouched, so the sidecode session continues as a pure P2P session.
 *
 * Unlike create/fetch/attach this is NOT an SDK function — the `/bridge`
 * subpath exposes no delete — so it's a raw HTTP call. Kept here so all CCR
 * endpoint knowledge (base URL + paths) stays single-sourced. `code`
 * namespace: Bearer + anthropic-version + x-organization-uuid, NO beta header
 * (verified — cse_ lifecycle endpoint map, project_sidecode_ccr_architecture).
 *
 * Returns `true` when the session is gone — 200 (deleted) OR 404 (already
 * absent: idempotent). Returns `false` on any other status / network error;
 * the caller logs and proceeds (the local detach already ran, and the
 * reconnect classifier independently clears state if the session is truly
 * gone). Never throws.
 */
export async function deleteCodeSession(
  params: DeleteCodeSessionParams,
): Promise<boolean> {
  const base = params.baseUrl ?? ANTHROPIC_API_BASE;
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    params.timeoutMs ?? DEFAULT_BRIDGE_TIMEOUT_MS,
  );
  try {
    const res = await fetch(`${base}/v1/code/sessions/${params.sessionId}`, {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${params.accessToken}`,
        "anthropic-version": "2023-06-01",
        "x-organization-uuid": params.organizationUuid,
      },
      signal: controller.signal,
    });
    // 200 = deleted, 404 = already gone — both mean "no longer exists".
    return res.ok || res.status === 404;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
