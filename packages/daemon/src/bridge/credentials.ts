/**
 * Read/write the Claude Code OAuth credentials that the BridgeTransport
 * needs for `createCodeSession` / `fetchRemoteCredentials` (and that the
 * OAuthRefreshManager rotates).
 *
 * WHY this exists (the daemon's pure-P2P path doesn't touch credentials —
 * it delegates auth entirely to the spawned `claude` binary). The bridge
 * control-plane calls are direct HTTP from the daemon, so they need the
 * token in-hand. The `claude` binary refreshes the keychain token on use,
 * but an IDLE re-attached bridge (lazy query → no binary running) has
 * nothing refreshing it — hence sidecode must read AND refresh the token
 * itself. See project_sidecode_ccr_architecture "RE-ADJUSTED back up".
 *
 * Storage layout mirrors the `claude` binary's own `getSecureStorage()`
 * (claude-code-source src/utils/secureStorage) FAITHFULLY so we read/write
 * the exact same entry it does — same service name, same account, same
 * `{ claudeAiOauth: {...} }` JSON envelope:
 *   - macOS  → keychain via `security`, falling back to the plaintext file
 *              (matches createFallbackStorage(macOsKeychainStorage, plainText))
 *   - others → `~/.claude/.credentials.json` plaintext (respects
 *              CLAUDE_CONFIG_DIR), chmod 0600
 *
 * Writeback preserves the envelope and any unknown inner fields
 * (rateLimitTier, subscriptionType, …) so we never clobber data the binary
 * or Desktop wrote.
 *
 * Cross-platform note: only STORAGE differs by platform; the refresh HTTP
 * call (oauth-refresh.ts) is platform-independent. This module is the
 * Linux/WSL seam referenced in the V1+ expansion plan.
 */

import { execFileSync } from "node:child_process";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Keychain service name the `claude` CLI uses (macOsKeychainStorage). */
const KEYCHAIN_SERVICE = "Claude Code-credentials";
/** Keychain account = `$USER` (matches the binary; falls back to "default"). */
const KEYCHAIN_ACCOUNT = process.env.USER || "default";

/**
 * The OAuth token blob, as persisted under `claudeAiOauth`. Field names are
 * the binary's verbatim (OAuthTokens in claude-code-source). `expiresAt` is
 * epoch milliseconds.
 */
export interface OAuthCredentials {
  accessToken: string;
  refreshToken: string;
  /** Epoch ms. The keychain token expires ~daily. */
  expiresAt: number;
  scopes: string[];
  /** "max" | "pro" | "team" | "enterprise" | null — preserved on writeback. */
  subscriptionType?: string | null;
  rateLimitTier?: string | null;
}

/**
 * Minimal secure-storage interface (a get/set of the raw JSON string).
 * Test seam: pass a fake to readCredentials/writeCredentials. Production
 * default = `defaultSecureStore()`.
 */
export interface SecureStore {
  get(): string | null;
  set(value: string): boolean;
}

/** macOS keychain store via the `security` CLI. Mirrors macOsKeychainStorage. */
export function keychainStore(): SecureStore {
  return {
    get(): string | null {
      try {
        return execFileSync(
          "security",
          [
            "find-generic-password",
            "-a",
            KEYCHAIN_ACCOUNT,
            "-w",
            "-s",
            KEYCHAIN_SERVICE,
          ],
          { encoding: "utf8", stdio: ["pipe", "pipe", "ignore"] },
        ).trim();
      } catch {
        return null;
      }
    },
    set(value: string): boolean {
      try {
        execFileSync(
          "security",
          [
            "add-generic-password",
            "-U",
            "-a",
            KEYCHAIN_ACCOUNT,
            "-s",
            KEYCHAIN_SERVICE,
            "-w",
            value,
          ],
          { stdio: ["pipe", "pipe", "ignore"] },
        );
        return true;
      } catch {
        return false;
      }
    },
  };
}

/** Path to the plaintext credentials file (Linux/WSL, or macOS fallback). */
function plaintextCredentialsPath(): string {
  const configDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
  return join(configDir, ".credentials.json");
}

/** Plaintext-file store. Mirrors plainTextStorage (chmod 0600 on write). */
export function plaintextStore(): SecureStore {
  return {
    get(): string | null {
      try {
        return readFileSync(plaintextCredentialsPath(), "utf8");
      } catch {
        return null;
      }
    },
    set(value: string): boolean {
      try {
        const path = plaintextCredentialsPath();
        writeFileSync(path, value, { encoding: "utf8" });
        chmodSync(path, 0o600);
        return true;
      } catch {
        return false;
      }
    },
  };
}

/** Try `primary` first, fall back to `secondary`. Mirrors createFallbackStorage. */
export function fallbackStore(
  primary: SecureStore,
  secondary: SecureStore,
): SecureStore {
  return {
    get(): string | null {
      return primary.get() ?? secondary.get();
    },
    set(value: string): boolean {
      return primary.set(value) || secondary.set(value);
    },
  };
}

/**
 * Platform-appropriate store, identical resolution to the `claude` binary's
 * `getSecureStorage()`: darwin → keychain-with-plaintext-fallback; else →
 * plaintext file.
 */
export function defaultSecureStore(): SecureStore {
  if (process.platform === "darwin") {
    return fallbackStore(keychainStore(), plaintextStore());
  }
  return plaintextStore();
}

/** Unwrap the stored JSON to the inner token object. The binary persists
 *  `{ claudeAiOauth: {...} }`; some older/edge stores keep the object at the
 *  root. We accept both (matches the spikes' `parsed.claudeAiOauth ?? parsed`). */
function unwrapInner(parsed: unknown): Record<string, unknown> | null {
  if (parsed === null || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;
  const wrapped = obj.claudeAiOauth;
  if (
    wrapped !== undefined &&
    wrapped !== null &&
    typeof wrapped === "object"
  ) {
    return wrapped as Record<string, unknown>;
  }
  return obj;
}

/**
 * Read the OAuth credentials. Returns `null` when the store is empty, the
 * JSON is malformed, or the required fields (accessToken/refreshToken) are
 * missing — callers treat any of these as "not authenticated / re-login".
 */
export function readCredentials(
  store: SecureStore = defaultSecureStore(),
): OAuthCredentials | null {
  const raw = store.get();
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const inner = unwrapInner(parsed);
  if (
    inner === null ||
    typeof inner.accessToken !== "string" ||
    typeof inner.refreshToken !== "string"
  ) {
    return null;
  }
  return {
    accessToken: inner.accessToken,
    refreshToken: inner.refreshToken,
    expiresAt: typeof inner.expiresAt === "number" ? inner.expiresAt : 0,
    scopes: Array.isArray(inner.scopes)
      ? inner.scopes.filter((s): s is string => typeof s === "string")
      : [],
    subscriptionType:
      typeof inner.subscriptionType === "string"
        ? inner.subscriptionType
        : null,
    rateLimitTier:
      typeof inner.rateLimitTier === "string" ? inner.rateLimitTier : null,
  };
}

/**
 * Persist refreshed credentials, PRESERVING the storage envelope and every
 * unknown inner field (so we don't drop data the binary/Desktop wrote
 * between our read and write). Re-reads the current blob, merges the new
 * token fields over the existing inner object, and writes it back in the
 * same `{ claudeAiOauth: {...} }` shape it had (defaulting to wrapped — the
 * real keychain shape — when the store was empty).
 *
 * Returns the store's success flag.
 */
export function writeCredentials(
  updated: OAuthCredentials,
  store: SecureStore = defaultSecureStore(),
): boolean {
  let existingInner: Record<string, unknown> = {};
  let wrapped = true; // the keychain's real shape; default for empty stores
  const raw = store.get();
  if (raw !== null) {
    try {
      const parsed = JSON.parse(raw);
      if (
        parsed !== null &&
        typeof parsed === "object" &&
        "claudeAiOauth" in (parsed as Record<string, unknown>)
      ) {
        const inner = (parsed as Record<string, unknown>).claudeAiOauth;
        existingInner =
          inner && typeof inner === "object"
            ? (inner as Record<string, unknown>)
            : {};
        wrapped = true;
      } else if (parsed !== null && typeof parsed === "object") {
        existingInner = parsed as Record<string, unknown>;
        wrapped = false;
      }
    } catch {
      // Corrupt existing blob — overwrite with a clean wrapped envelope.
    }
  }
  const mergedInner: Record<string, unknown> = {
    ...existingInner,
    accessToken: updated.accessToken,
    refreshToken: updated.refreshToken,
    expiresAt: updated.expiresAt,
    scopes: updated.scopes,
  };
  if (updated.subscriptionType !== undefined) {
    mergedInner.subscriptionType = updated.subscriptionType;
  }
  if (updated.rateLimitTier !== undefined) {
    mergedInner.rateLimitTier = updated.rateLimitTier;
  }
  const blob = wrapped ? { claudeAiOauth: mergedInner } : mergedInner;
  return store.set(JSON.stringify(blob));
}

/**
 * Read the org UUID from the CLI global config (`~/.claude.json`, or
 * `$CLAUDE_CONFIG_DIR/.claude.json`). Needed as `x-organization-uuid` on
 * the read-only control-plane queries (`GET /v1/code/sessions`, usage).
 * Returns `null` if absent/unreadable. (NOT under `.claude/` — the global
 * config sits at the home root.)
 */
export function readOrgUUID(): string | null {
  const path = process.env.CLAUDE_CONFIG_DIR
    ? join(process.env.CLAUDE_CONFIG_DIR, ".claude.json")
    : join(homedir(), ".claude.json");
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as {
      oauthAccount?: { organizationUuid?: unknown };
    };
    const uuid = parsed?.oauthAccount?.organizationUuid;
    return typeof uuid === "string" ? uuid : null;
  } catch {
    return null;
  }
}
