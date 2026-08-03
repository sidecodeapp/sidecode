// electron-updater state machine + dialogs — harvested verbatim from the
// menubar app (its electron/updater.ts), only the LSUIElement-specific
// focus notes adjusted: this app has a Dock presence, but the focus steal
// stays (a background-parked tray app can still be behind everything when
// an interactive check answers).
import { app, dialog } from "electron";
// electron-updater is CJS; default-import + destructure is the safe ESM interop.
import electronUpdater from "electron-updater";

const { autoUpdater } = electronUpdater;

/**
 * Update lifecycle as the menu renders it. autoDownload is on, so an available
 * update goes straight to "downloading"; "downloaded" is the only actionable
 * state (click → quitAndInstall). idle/error show no prominent item — the
 * manual "Check for updates" in the About submenu covers re-checking.
 */
export type UpdateState =
  | { status: "idle" }
  | { status: "checking" }
  | { status: "downloading"; version: string; percent: number }
  | { status: "downloaded"; version: string }
  | { status: "error"; message: string };

let state: UpdateState = { status: "idle" };
// download-progress events carry no version; remember it from update-available.
let pendingVersion = "";
let onChange: (() => void) | null = null;

// Sparkle's convention, adopted here: a USER-initiated check must always
// answer with visible UI (dialog), while scheduled background checks stay
// silent (menu rows + tray title only). This flag marks the in-flight check
// as user-initiated; each terminal outcome (up to date / downloaded / error)
// consumes it.
let interactiveCheck = false;

// 6h: frequent enough to keep the protocol-mismatch window to hours, rare
// enough to be invisible in network logs.
const RECHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

export function getUpdateState(): UpdateState {
  return state;
}

export function initUpdater(opts: { onStateChange: () => void }): void {
  // Auto-update only runs in packaged builds — Squirrel.Mac needs the installed
  // .app, and the feed is the embedded app-update.yml (from electron-builder.cjs
  // `publish`: GitHub Releases by default, latest PUBLISHED release only). In dev
  // it's inert; test via a packaged build pointed at a static feed with
  // SIDECODE_UPDATE_URL.
  if (!app.isPackaged) return;
  onChange = opts.onStateChange;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true; // silently apply on next quit (default)

  autoUpdater.on("checking-for-update", () => set({ status: "checking" }));
  autoUpdater.on("update-available", (info) => {
    pendingVersion = info.version;
    // No dialog here even for interactive checks: the tray title starts
    // showing live "⬇ N%" immediately (right where the user just clicked),
    // and the flag survives until update-downloaded prompts the restart.
    set({ status: "downloading", version: info.version, percent: 0 });
  });
  autoUpdater.on("update-not-available", () => {
    set({ status: "idle" });
    if (consumeInteractive()) {
      showDialog({
        message: "You're up to date",
        detail: `Thinkite ${app.getVersion()} is the latest version.`,
      });
    }
  });
  autoUpdater.on("download-progress", (p) =>
    set({
      status: "downloading",
      version: pendingVersion,
      percent: Math.round(p.percent),
    }),
  );
  autoUpdater.on("update-downloaded", (info) => {
    set({ status: "downloaded", version: info.version });
    // A user who manually checked almost certainly wants to install right
    // away — offer the restart instead of making them reopen the menu.
    // (electron-updater re-fires this immediately for an already-cached
    // download, so a manual re-check while in "downloaded" lands here too.)
    if (consumeInteractive()) {
      app.focus({ steal: true }); // see showDialog
      void dialog
        .showMessageBox({
          type: "info",
          message: `Thinkite ${info.version} is ready`,
          detail: "Restart now to finish updating?",
          buttons: ["Restart Now", "Later"],
          defaultId: 0,
          cancelId: 1,
        })
        .then(({ response }) => {
          if (response === 0) quitAndInstall();
        });
    }
  });
  autoUpdater.on("error", (err) => {
    const message = err?.message ?? String(err);
    set({ status: "error", message });
    // Background-check failures (laptop offline, feed hiccup) stay silent —
    // the 6h cadence retries on its own.
    if (consumeInteractive()) {
      showDialog({
        type: "warning",
        message: "Couldn't check for updates",
        detail: message,
      });
    }
  });

  checkForUpdates();
  // Tray-resident apps run for weeks; a startup-only check would let the
  // Mac side drift behind an auto-updating iOS app until the next reboot —
  // exactly the window that puts the phone on the update-required gate.
  // autoDownload + autoInstallOnAppQuit keep each periodic hit silent.
  setInterval(checkForUpdates, RECHECK_INTERVAL_MS).unref();
}

export function checkForUpdates(opts: { interactive?: boolean } = {}): void {
  if (opts.interactive) interactiveCheck = true;
  // Failures also fire the "error" event; this catch just prevents an unhandled
  // rejection when no feed is reachable (e.g. dev without a real dev-app-update.yml).
  autoUpdater.checkForUpdates().catch((err) => {
    console.warn(
      `[updater] check failed: ${err instanceof Error ? err.message : err}`,
    );
  });
}

export function quitAndInstall(): void {
  autoUpdater.quitAndInstall();
}

function consumeInteractive(): boolean {
  const was = interactiveCheck;
  interactiveCheck = false;
  return was;
}

function showDialog(opts: {
  type?: "info" | "warning";
  message: string;
  detail: string;
}): void {
  // The app can be tray-parked behind everything; without an explicit focus
  // steal the dialog can open behind whatever app is frontmost.
  app.focus({ steal: true });
  void dialog.showMessageBox({
    type: opts.type ?? "info",
    message: opts.message,
    detail: opts.detail,
    buttons: ["OK"],
  });
}

function set(next: UpdateState): void {
  state = next;
  onChange?.();
}
