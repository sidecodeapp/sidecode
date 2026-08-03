// Electron main (node process; bundled to dist-electron/index.js by
// vite-plugin-electron — externals resolve from node_modules at runtime).
// Serves the Vite-built SPA from dist/ and mounts our own routes (PTY
// WebSocket, daemon RPC, diff, pairing) on one fixed-port node http server —
// same port and routes as the electrobun and deno predecessors, so the
// renderer never noticed a runtime change.
//
// Dev:   bun run dev        (vite — the plugin builds this file, spawns
//        Electron with VITE_DEV_SERVER_URL, and rebuild+restarts on main
//        changes; NOTE: a main-file save bounces the daemon and kills live
//        PTY shells, deliberate trade for the auto-restart loop)
//        bun run dev:static (vite build + electron; no dev server —
//        exercises the built dist)
// Pack:  S3 (electron-builder) — not wired yet.
import { execFile } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { hostname } from "node:os";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type Daemon,
  type PlanUsageResult,
  type PlanUsageWindow,
  readActiveDaemonLock,
  resolveSidecodeHome,
  start as startDaemon,
} from "@sidecodeapp/daemon";
import {
  app,
  BrowserWindow,
  Menu,
  nativeImage,
  powerSaveBlocker,
  shell,
  Tray,
} from "electron";
import { WebSocketServer } from "ws";
import { handleDiff } from "./diff";
import { attachPty, ptyParams } from "./pty";
import { attachRpc } from "./rpc";
import {
  checkForUpdates,
  getUpdateState,
  initUpdater,
  quitAndInstall,
} from "./updater";

// ─── Single instance ────────────────────────────────────────────────────────
// The port-conflict guard alone made a second launch die AFTER booting a
// twin daemon; the lock stops it before any of that, and hands the gesture
// to the running instance (which raises its window).
if (!app.requestSingleInstanceLock()) {
  app.exit(0);
  // exit() tears the process down asynchronously — stop evaluating so the
  // daemon/server boot below never starts in the doomed instance.
  await new Promise<never>(() => {});
}
app.on("second-instance", () => openMain());

// Mode detection: `app.isPackaged` (real Electron signal — no more
// version.json channel probing; electrobun needed that because a stable
// .app launched from inside the repo defeated layout walk-ups, but
// isPackaged is stamped by the binary itself, not the filesystem).
//
// Dev: everything (dist/, assets/, the repo's node_modules) hangs off the
// package root = one level above dist-electron/. A packaged app has dist/
// and assets/ staged under process.resourcesPath by electron-builder (S3).
const HERE = dirname(fileURLToPath(import.meta.url)); // <root>/dist-electron
// Dev root = the package dir; packaged root = app.getAppPath() (app.asar —
// Electron's asar-patched fs lets the http server readFile straight out of
// the archive, so dist/ and assets/ ship INSIDE it, no extraResources).
const ROOT = app.isPackaged ? app.getAppPath() : dirname(HERE);
const PKG = app.isPackaged ? null : ROOT;
const REPO = PKG ? dirname(dirname(PKG)) : null;
const DIST = join(ROOT, "dist");
const TRAY_ICON = join(ROOT, "assets/iconTemplate.png");
console.log(
  `[desktop] boot — ${PKG ? `dev pkg ${PKG}` : `packaged ${process.resourcesPath}`}`,
);

const PORT = 5199;
const BASE = `http://127.0.0.1:${PORT}`;
// vite-plugin-electron stamps the dev-server origin into our env in dev;
// absence (dev:static, packaged) means serve the built dist ourselves.
const pageBase = process.env.VITE_DEV_SERVER_URL ?? BASE;

// Dev: spawn the SDK's platform-package claude binary from the REPO (same
// seam run-query.ts forwards) — top-level under bun's hoisted linker, .bun
// store under the isolated one.
//
// Packaged: no repo, and the SDK's 230MB platform binary is deliberately
// not shipped — discover the SYSTEM claude instead, gated by version.
// Spawning a mismatched CLI must not happen: an old CLI can mismatch the
// SDK's control protocol and hang the first turn (spawns, writes JSONL
// meta records, never processes the prompt), which is WORSE than failing
// loudly here. (Handshake watchdog = follow-up hardening.)
const MIN_CLAUDE = [2, 1, 0] as const;

async function resolveClaude(): Promise<string | undefined> {
  if (REPO !== null) {
    const repoModules = join(REPO, "node_modules");
    const candidates = [
      join(repoModules, "@anthropic-ai/claude-agent-sdk-darwin-arm64/claude"),
    ];
    try {
      for (const entry of await readdir(join(repoModules, ".bun"))) {
        if (entry.startsWith("@anthropic-ai+claude-agent-sdk-darwin-")) {
          candidates.push(
            join(
              repoModules,
              ".bun",
              entry,
              "node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude",
            ),
          );
        }
      }
    } catch {
      // no .bun store (hoisted layout) — top-level candidate only
    }
    for (const c of candidates) {
      if (await stat(c).catch(() => null)) return c;
    }
    return undefined;
  }
  // System discovery order: user PATH (meaningful when launched from a
  // terminal; Finder gives a bare one), then the native installer's
  // default, then Homebrew/npm-global prefixes.
  const home = process.env.HOME ?? "";
  const which = (await run("/usr/bin/which", ["claude"]))?.trim();
  const candidates = [
    which,
    join(home, ".local/bin/claude"),
    "/opt/homebrew/bin/claude",
    "/usr/local/bin/claude",
  ].filter((c): c is string => !!c);
  for (const c of candidates) {
    if (!(await stat(c).catch(() => null))) continue;
    const version = await claudeVersion(c);
    if (version === null) {
      console.warn(
        `[desktop] ${c}: --version failed or unparseable — skipping`,
      );
      continue;
    }
    const ok =
      version[0] > MIN_CLAUDE[0] ||
      (version[0] === MIN_CLAUDE[0] &&
        (version[1] > MIN_CLAUDE[1] ||
          (version[1] === MIN_CLAUDE[1] && version[2] >= MIN_CLAUDE[2])));
    if (!ok) {
      console.warn(
        `[desktop] ${c}: version ${version.join(".")} < ${MIN_CLAUDE.join(".")} — skipping (control-protocol mismatch risk)`,
      );
      continue;
    }
    console.log(`[desktop] system claude ${version.join(".")} at ${c}`);
    return c;
  }
  return undefined;
}

function run(cmd: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 5000 }, (err, stdout) =>
      resolve(err ? null : stdout),
    );
  });
}

async function claudeVersion(
  bin: string,
): Promise<[number, number, number] | null> {
  const out = await run(bin, ["--version"]);
  const m = out?.match(/(\d+)\.(\d+)\.(\d+)/);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

// ─── In-process daemon (D2): this process IS the sidecode daemon ───────────
// Same identity, same ~/.sidecode home, same signaling presence the iOS app
// pairs against. `start()` only writes the liveness lock, so check it first:
// if another daemon owns the home (e.g. the menubar app), the GUI keeps
// working in local-only mode (PTY/diff don't need the daemon; sessions +
// transcripts do) rather than fighting over signaling with a twin identity.
//
// The daemon is external in the main bundle, resolved from node_modules at
// runtime — a daemon rebuild needs no desktop re-bundle. Packaged builds
// revisit this in S3 (bundle + stage node-datachannel, the electrobun
// recipe carried over).
let daemon: Daemon | null = null;
{
  const home = resolveSidecodeHome(); // ensures the dir exists
  const lock = readActiveDaemonLock(home);
  if (lock) {
    console.warn(
      `[desktop] another daemon owns ${home} (pid ${lock.pid}) — starting GUI without in-process daemon`,
    );
  } else {
    const claudeExecutablePath = await resolveClaude();
    if (claudeExecutablePath === undefined) {
      console.warn(
        "[desktop] no usable claude binary found — falling back to SDK resolution (may pick a mismatched CLI)",
      );
    }
    console.log(`[desktop] starting daemon — claude ${claudeExecutablePath}`);
    daemon = await startDaemon({ claudeExecutablePath });
    console.log(
      `[desktop] daemon up — fingerprint ${daemon.fingerprint}, pairedClients ${daemon.pairedClientCount()}`,
    );
  }
}

// ─── HTTP + WS server (fixed port, node http + ws) ─────────────────────────
const MIME: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".wasm": "application/wasm",
  ".map": "application/json",
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", BASE);
  try {
    if (url.pathname === "/api/daemon/status") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify(
          daemon
            ? {
                running: true,
                fingerprint: daemon.fingerprint,
                pairedClients: daemon.pairedClientCount(),
                authenticatedPeers: daemon.authenticatedPeerCount(),
              }
            : { running: false },
        ),
      );
      return;
    }
    if (url.pathname === "/api/diff") {
      const r = await handleDiff(url);
      if ("json" in r) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(r.json));
      } else {
        res.writeHead(r.status, { "content-type": "text/plain" });
        res.end(r.body);
      }
      return;
    }
    if (url.pathname === "/api/pair/offer") {
      if (daemon === null) {
        // Another daemon owns ~/.sidecode — pairing belongs to IT, not us.
        res.writeHead(503, { "content-type": "text/plain" });
        res.end("daemon not running in this process — pairing unavailable");
        return;
      }
      // Same payload the menubar minted: a pure function of the daemon
      // identity plus this host's name (shown in iOS's confirm modal), so
      // no TTL and no refresh. Admission is gated by the pair window's
      // open/close (setPairing in openPairWindow), not by this call.
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(daemon.createPairOffer(hostname())));
      return;
    }
    if (url.pathname.startsWith("/api/")) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
      return;
    }
    // Static SPA from dist/. SPA fallback only for HTML navigations, so
    // missing assets/API paths still 404.
    const rel = url.pathname === "/" ? "/index.html" : url.pathname;
    let file = join(DIST, rel);
    let st = await stat(file).catch(() => null);
    if (
      !st?.isFile() &&
      req.method === "GET" &&
      (req.headers.accept ?? "").includes("text/html")
    ) {
      file = join(DIST, "index.html");
      st = await stat(file).catch(() => null);
    }
    if (!st?.isFile()) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
      return;
    }
    res.writeHead(200, {
      "content-type": MIME[extname(file)] ?? "application/octet-stream",
    });
    res.end(await readFile(file));
  } catch (e) {
    res.writeHead(500, { "content-type": "text/plain" });
    res.end(String(e));
  }
});

const wss = new WebSocketServer({ noServer: true });
server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url ?? "/", BASE);
  if (url.pathname === "/pty") {
    const params = ptyParams(url);
    if (typeof params === "string") {
      socket.end(`HTTP/1.1 400 Bad Request\r\n\r\n${params}`);
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => attachPty(ws, params));
  } else if (url.pathname === "/rpc") {
    if (daemon === null) {
      // The GUI shows its daemon-offline state off this instead of a dead
      // socket.
      socket.end(
        "HTTP/1.1 503 Service Unavailable\r\n\r\ndaemon not running in this process",
      );
      return;
    }
    const d = daemon;
    wss.handleUpgrade(req, socket, head, (ws) => attachRpc(ws, d));
  } else {
    socket.destroy();
  }
});

await new Promise<void>((resolve, reject) => {
  server.once("error", reject);
  server.listen(PORT, "127.0.0.1", resolve);
}).catch((e) => {
  console.error(`[desktop] port ${PORT} unavailable:`, e);
  app.exit(1);
});
console.log(`[desktop] serving ${DIST} + /pty /rpc /api on ${BASE}`);

// ─── Windows ────────────────────────────────────────────────────────────────
let mainWin: BrowserWindow | null = null;
function openMain(): void {
  if (mainWin !== null) {
    mainWin.focus();
    return;
  }
  mainWin = new BrowserWindow({
    title: "Thinkite",
    x: 160,
    y: 120,
    width: 1200,
    height: 800,
    // Transparent titlebar: native traffic lights inset over the page; the
    // renderer detects Electron (userAgent) and renders a strip with native
    // `-webkit-app-region: drag` — no preload needed.
    titleBarStyle: "hiddenInset",
  });
  void mainWin.loadURL(`${pageBase}/`);
  mainWin.on("closed", () => {
    // Real close; the app lives on in the tray/dock. PTY sessions live
    // server-side and survive this.
    mainWin = null;
  });
}

let pairWin: BrowserWindow | null = null;
function openPairWindow(): void {
  if (pairWin !== null && !pairWin.isDestroyed()) {
    pairWin.focus();
    return;
  }
  // The window IS the admission gate (menubar semantics carried over):
  // showing it starts admitting pairing attempts, dismissing stops them —
  // so the QR "always works" exactly while it's visible, and no stranger
  // can pair against a daemon whose owner isn't looking at a pair window.
  daemon?.setPairing(true);
  const win = new BrowserWindow({
    width: 420,
    height: 680,
    show: false,
    resizable: false,
    fullscreenable: false,
    minimizable: false,
    maximizable: false,
    titleBarStyle: "hiddenInset",
    // Per-window title. The shared index.html ships a <title>, which
    // Electron would otherwise copy onto every window that loads it; the
    // `page-title-updated` preventDefault below locks this in (visible in
    // Mission Control / window menus, not in the hidden bar).
    title: "Pair New Device",
  });
  void win.loadURL(`${pageBase}/pair`);
  win.on("page-title-updated", (e) => e.preventDefault());
  win.once("ready-to-show", () => win.show());
  win.on("closed", () => {
    // Window closed → close the admission gate. Already-paired clients
    // still reconnect; only NEW unknown-pubkey pairing is gated.
    daemon?.setPairing(false);
    pairWin = null;
  });
  pairWin = win;
}

// ─── Tray: Plan Usage + actions (harvested from the retired menubar app) ───
// Last fetch result, rendered by buildMenu. macOS doesn't repaint an open
// NSMenu, so the open itself can only ever paint an ALREADY-cached
// snapshot — a tray click can't show its own in-flight fetch. A background
// poll keeps the cache warm so each open shows near-current data. The
// per-open refreshPlanUsage() stays (the daemon's 30s cache + single-flight
// make the extra fetches free), but the poll is what makes the number
// fresh. Token Stats stays CUT from V0 (stats-cache.json is lazily
// written; honest numbers need Desktop-style JSONL aggregation).
let planUsage: PlanUsageResult | null = null;
// 2 min: the daemon's 30s TTL coalesces anything faster, and plan usage
// drifts slowly — tighter would burn requests for no visible gain.
const PLAN_USAGE_POLL_MS = 2 * 60_000;
let planUsageTimer: ReturnType<typeof setInterval> | null = null;
let tray: Tray | null = null;
let keepAwakeId: number | null = null;

function refreshPlanUsage(): void {
  if (!daemon) return;
  void daemon.fetchPlanUsage().then((result) => {
    // Keep showing the last good snapshot through transient failures —
    // a flaky network shouldn't blank the section.
    if (result.status === "error" && planUsage?.status === "ok") return;
    planUsage = result;
    refreshMenu();
  });
}

// The usage endpoint returns utilization as 0..100 already (live-verified:
// `71` = 71%), NOT a 0..1 fraction — do not multiply.
function formatPercent(util: number): string {
  return `${Math.round(util)}%`;
}

// Coarse single-unit countdown: "resets 42m" / "resets 7h" / "resets 3d".
// Ceil everywhere so the label never understates the wait.
function formatResets(resetsAt: string): string {
  const ms = new Date(resetsAt).getTime() - Date.now();
  if (ms <= 0) return "resets now";
  const min = Math.ceil(ms / 60_000);
  if (min < 60) return `resets ${min}m`;
  const hours = Math.ceil(min / 60);
  if (hours < 24) return `resets ${hours}h`;
  return `resets ${Math.ceil(hours / 24)}d`;
}

// SF Symbol → 16x16 template image (auto-tints to follow menu fg color,
// turns white when highlighted). macOS HIG size for menu item icons.
const MENU_ICON_SIZE = 16;
function symbolIcon(name: string): Electron.NativeImage {
  const img = nativeImage
    .createFromNamedImage(name)
    .resize({ width: MENU_ICON_SIZE, height: MENU_ICON_SIZE });
  img.setTemplateImage(true);
  return img;
}

// One disabled info row per available rate window. Windows the endpoint
// didn't return (enterprise/org accounts) are skipped, never shown as 0%.
function planUsageItems(): Electron.MenuItemConstructorOptions[] {
  if (planUsage === null) {
    return [{ label: "Loading…", enabled: false }];
  }
  switch (planUsage.status) {
    case "signed_out":
      return [{ label: "Not signed in — run `claude /login`", enabled: false }];
    case "error":
      // Only reached when there's no last-good snapshot to keep showing.
      return [{ label: "Usage unavailable", enabled: false }];
    case "ok": {
      const u = planUsage.usage;
      const row = (
        name: string,
        w: PlanUsageWindow | undefined,
        showReset = false,
      ): Electron.MenuItemConstructorOptions | null =>
        w
          ? {
              label: `${name} - ${formatPercent(w.utilization)}${
                showReset && w.resetsAt ? ` · ${formatResets(w.resetsAt)}` : ""
              }`,
              enabled: false,
            }
          : null;
      const rows = [
        row("5h", u.fiveHour, true),
        row("Weekly", u.sevenDay, true),
        row("Opus", u.sevenDayOpus),
        row("Sonnet", u.sevenDaySonnet),
      ].filter((r) => r !== null);
      return rows.length > 0
        ? rows
        : [{ label: "No usage data for this plan", enabled: false }];
    }
  }
}

// State-adaptive update row driven by electron-updater (server/updater.ts).
// Shown only when there's something to convey; idle/error fall back to the
// manual "Check for updates" in the About submenu.
function updateMenuItem(): Electron.MenuItemConstructorOptions | null {
  const s = getUpdateState();
  switch (s.status) {
    case "checking":
      return { label: "Checking for updates…", enabled: false };
    case "downloading":
      return { label: `Downloading update… ${s.percent}%`, enabled: false };
    case "downloaded":
      return {
        label: `Restart to update · v${s.version}`,
        icon: symbolIcon("arrow.up.circle"),
        click: () => quitAndInstall(),
      };
    default:
      return null; // idle | error
  }
}

function buildMenu(): Electron.Menu {
  const items: Electron.MenuItemConstructorOptions[] = [
    { label: "Claude Plan Usage", type: "header" },
    ...planUsageItems(),
    { type: "separator" },
    {
      label: "Open Thinkite",
      icon: symbolIcon("macwindow"),
      click: () => openMain(),
    },
    {
      label: "Pair new device",
      icon: symbolIcon("link"),
      click: () => openPairWindow(),
    },
    {
      label: "Settings",
      icon: symbolIcon("gear"),
      submenu: [
        {
          label: "Launch at login",
          type: "checkbox",
          checked: app.isPackaged && app.getLoginItemSettings().openAtLogin,
          enabled: app.isPackaged,
          sublabel: app.isPackaged ? undefined : "Packaged build only",
          click: (item) => {
            app.setLoginItemSettings({ openAtLogin: item.checked });
          },
        },
        {
          label: "Keep computer awake",
          type: "checkbox",
          checked:
            keepAwakeId !== null && powerSaveBlocker.isStarted(keepAwakeId),
          click: (item) => {
            if (item.checked) {
              keepAwakeId = powerSaveBlocker.start("prevent-display-sleep");
            } else if (keepAwakeId !== null) {
              powerSaveBlocker.stop(keepAwakeId);
              keepAwakeId = null;
            }
          },
        },
      ],
    },
    { type: "separator" },
  ];

  const updateItem = updateMenuItem();
  if (updateItem) items.push(updateItem);

  items.push(
    {
      label: "About Thinkite",
      icon: symbolIcon("info.circle"),
      submenu: [
        { label: `Version ${app.getVersion()}`, enabled: false },
        {
          label: "Check for updates",
          // Interactive: a user-initiated check always answers with a
          // dialog (up to date / restart prompt / error) — Sparkle
          // convention; scheduled checks stay silent.
          click: () => checkForUpdates({ interactive: true }),
        },
        {
          label: "View on GitHub",
          click: () => {
            void shell.openExternal("https://github.com/thinkite/thinkite");
          },
        },
      ],
    },
    { type: "separator" },
    {
      label: "Quit Thinkite",
      accelerator: "CommandOrControl+Q",
      click: () => app.quit(),
    },
  );
  return Menu.buildFromTemplate(items);
}

function refreshMenu(): void {
  tray?.setContextMenu(buildMenu());
  // Download progress lives in the tray TITLE (text beside the icon) — the
  // one surface visible without opening anything; macOS doesn't repaint an
  // already-open NSMenu.
  const s = getUpdateState();
  tray?.setTitle(s.status === "downloading" ? ` ${s.percent}%` : "");
}

function setupTray(): void {
  // Monochrome template image (black + alpha): macOS tints via the alpha
  // mask — dark glyph on light menu bars, light on dark, inverted on
  // highlight. createFromPath auto-pairs the @2x file; setTemplateImage is
  // an explicit guard on top of the Template filename suffix.
  const icon = nativeImage.createFromPath(TRAY_ICON);
  icon.setTemplateImage(true);
  tray = new Tray(icon);
  // Order matters: kick the async usage refresh FIRST (lands by the next
  // open), then rebuild synchronously so this open gets the cached snapshot.
  const onTrayOpen = () => {
    refreshPlanUsage();
    refreshMenu();
  };
  tray.on("click", onTrayOpen);
  tray.on("right-click", onTrayOpen);
  refreshPlanUsage();
  refreshMenu();
  planUsageTimer = setInterval(refreshPlanUsage, PLAN_USAGE_POLL_MS);
}

// ─── Lifecycle: tray-resident ───────────────────────────────────────────────
// Closing every window keeps the app (and daemon) alive in the tray/dock —
// the electrobun `exitOnLastWindowClosed:false` semantics, natively.
// Registering the (no-op) handler is what overrides Electron's default
// quit-on-last-window.
app.on("window-all-closed", () => {});

// Dock click with no windows: recreate the main window.
app.on("activate", openMain);

// One shutdown path for every exit trigger (tray Quit, Cmd+Q, SIGINT/
// SIGTERM): intercept quit once, drain the daemon (WebRTC peers, claude
// subprocesses, JSONL writes), then exit HARD.
//
// app.exit(0), NOT a second app.quit(): the polite second pass (close
// windows → will-quit) was observed to wedge INDEFINITELY after ^C under
// vite-plugin-electron dev — the daemon drained, then the process sat
// there ignoring further signals. After the drain there is nothing left
// worth being polite about (renderer holds no unsaved state; PTY shells
// die with the process by design), and S1's exit(0) path never wedged
// once. The 5s race guards a hung daemon.stop().
let isQuitting = false;
app.on("before-quit", (event) => {
  if (isQuitting) return;
  event.preventDefault();
  isQuitting = true;
  if (planUsageTimer) clearInterval(planUsageTimer);
  const stop = daemon ? daemon.stop() : Promise.resolve();
  void Promise.race([
    stop.catch((e) => console.error("[desktop] daemon stop failed:", e)),
    new Promise((r) => setTimeout(r, 5000)),
  ]).then(() => app.exit(0));
});
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => app.quit());
}

// NOT `await app.whenReady()`: with an ESM entry Electron delays `ready`
// until the module's top-level evaluation (including every await above)
// finishes — a top-level await on whenReady is therefore a DEADLOCK (the
// daemon and server booted, no window ever appeared). The .then() lets
// evaluation complete; ready fires right after.
void app.whenReady().then(() => {
  setupTray();
  // Auto-download + drive the update menu row / tray-title percent.
  // Inert in dev (packaged-only inside).
  initUpdater({ onStateChange: refreshMenu });
  openMain();
});
