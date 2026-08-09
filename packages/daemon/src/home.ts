import { existsSync, mkdirSync, renameSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const DEFAULT_DIR_NAME = ".thinkite";
const LEGACY_DIR_NAME = ".sidecode";

/**
 * Resolve the daemon's home directory and ensure it exists with 0700 perms.
 *
 * Lookup order:
 *   1. $THINKITE_HOME env var, if set and non-empty
 *      ($SIDECODE_HOME still honored as a deprecated fallback)
 *   2. <homeDirOverride>/.thinkite, if homeDirOverride passed (test escape hatch)
 *   3. ~/.thinkite (production default)
 *
 * Pre-rename installs are migrated on first resolve: an existing
 * ~/.sidecode is atomically renamed to ~/.thinkite (same-volume rename,
 * so identity/known_clients/sessions move intact and pairing survives).
 * Runs before any lock acquisition — callers grab daemon.lock from the
 * path this returns, so the lock never straddles the move.
 */
export function resolveThinkiteHome(homeDirOverride?: string): string {
  const fromEnv = process.env.THINKITE_HOME || process.env.SIDECODE_HOME;
  if (fromEnv && fromEnv.length > 0) {
    ensureDir(fromEnv);
    return fromEnv;
  }
  const base = homeDirOverride ?? homedir();
  const path = join(base, DEFAULT_DIR_NAME);
  migrateLegacyHome(base, path);
  ensureDir(path);
  return path;
}

/** One-shot ~/.sidecode → ~/.thinkite migration. No-op once the new dir
 *  exists; if both exist we prefer the new one and leave the legacy dir
 *  untouched (never merge automatically). */
function migrateLegacyHome(base: string, next: string): void {
  const legacy = join(base, LEGACY_DIR_NAME);
  if (existsSync(next)) {
    if (existsSync(legacy)) {
      console.warn(
        `[thinkite] both ${next} and legacy ${legacy} exist; using ${next} (legacy dir left as-is)`,
      );
    }
    return;
  }
  let legacyStat: ReturnType<typeof statSync>;
  try {
    legacyStat = statSync(legacy);
  } catch {
    return; // no legacy install — fresh setup
  }
  if (!legacyStat.isDirectory()) return;
  renameSync(legacy, next);
  console.warn(`[thinkite] migrated data dir: ${legacy} → ${next}`);
}

function ensureDir(path: string): void {
  let stat: ReturnType<typeof statSync> | undefined;
  try {
    stat = statSync(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    mkdirSync(path, { recursive: true, mode: 0o700 });
    return;
  }
  if (!stat.isDirectory()) {
    throw new Error(
      `THINKITE_HOME path exists but is not a directory: ${path}`,
    );
  }
}
