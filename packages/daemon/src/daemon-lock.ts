import {
  existsSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

/**
 * `$THINKITE_HOME/daemon.lock` records that a daemon owns this home, so
 * that one-shot CLI commands (notably `sidecode pair`) can detect it and
 * refuse to spawn a competing one.
 *
 * Post-WebRTC pivot, host/port are gone — the daemon doesn't bind a
 * local port; all transport goes through signaling.thinkite.dev + WebRTC.
 * The lock is now just a liveness record (PID + startedAt).
 *
 * The lock is best-effort: written on start, deleted on graceful stop.
 * A stale file (PID dead) is treated the same as a missing file.
 */
export interface DaemonLock {
  pid: number;
  startedAt: number;
}

const FILE_NAME = "daemon.lock";

export function writeDaemonLock(home: string, info: DaemonLock): void {
  const path = join(home, FILE_NAME);
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(info, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}

export function deleteDaemonLock(home: string): void {
  const path = join(home, FILE_NAME);
  if (existsSync(path)) {
    try {
      unlinkSync(path);
    } catch {
      // best-effort
    }
  }
}

/** Read the lock and return its contents IF the recorded PID is still alive. */
export function readActiveDaemonLock(home: string): DaemonLock | null {
  const path = join(home, FILE_NAME);
  if (!existsSync(path)) return null;
  let parsed: DaemonLock;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8")) as DaemonLock;
  } catch {
    return null;
  }
  if (!isPidAlive(parsed.pid)) return null;
  return parsed;
}

function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    // Signal 0 doesn't deliver a signal; it just probes if the PID exists
    // and we have permission to signal it. Throws ESRCH if pid is gone.
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}
