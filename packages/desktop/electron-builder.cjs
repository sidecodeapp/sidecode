// electron-builder config, harvested from the menubar app's electron-builder.cjs
// with four desktop-specific inversions (marked DESKTOP below). CJS (.cjs) on
// purpose: this package is type:module, so a plain .js would load as ESM.
//
// Signing is auto-discovered from the keychain (the Developer ID Application
// cert) — no `identity` pin, so a machine without the cert just builds unsigned
// (warns) instead of failing. Notarization is GATED on the App Store Connect
// API-key env so quick local `package` builds stay fast (sign-only) and only
// the release path (env set: APPLE_API_KEY / _KEY_ID / _ISSUER) uploads to
// Apple's notary. Same script, env decides.
const notarize = Boolean(process.env.APPLE_API_KEY);

/** @type {import("electron-builder").Configuration} */
module.exports = {
  appId: "dev.thinkite.desktop",
  productName: "Thinkite",
  // devDep range is ^x — electron-builder needs the exact release to fetch
  // matching platform binaries; read it off the installed package so it can
  // never drift from node_modules.
  electronVersion: require("electron/package.json").version,
  directories: {
    // CRITICAL: vite emits the renderer to dist/. electron-builder's default
    // output is also `dist` and it WIPES the output dir first — send artifacts
    // to release/ instead. buildResources = build/ (icon.icns +
    // entitlements.mac.plist live there, tracked in git).
    output: "release",
    buildResources: "build",
  },
  // Production node_modules are collected automatically; this filter scopes
  // app source (dist = renderer, dist-electron = main bundle, assets = tray
  // icon; the main resolves all three via app.getAppPath(), and Electron's
  // asar-patched fs makes the http server's readFile work from inside the
  // archive).
  //
  // DESKTOP inversion #1: the SDK's per-platform `claude` SEA binary (~212MB)
  // is EXCLUDED — this app discovers the SYSTEM claude instead (version-gated
  // in server/index.ts), the electrobun-era decision that kept the install
  // small. Without the negation, the automatic node_modules collection would
  // drag the binary in through daemon → SDK → optional platform package.
  // (The SDK's JS itself stays — the daemon imports it.)
  files: [
    "dist/**/*",
    "dist-electron/**/*",
    "assets/**/*",
    "package.json",
    "!**/node_modules/@anthropic-ai/claude-agent-sdk-*/**",
  ],
  asar: true,
  // Native code can't load from inside the asar archive:
  //  - node-datachannel ships a prebuilt .node (must be dlopen-able)
  //  - @lydell/node-pty ditto (DESKTOP inversion #2 — menubar had no PTY)
  asarUnpack: [
    "**/node_modules/node-datachannel/**",
    "**/node_modules/@lydell/node-pty/**",
  ],
  // Prebuilt N-API modules; don't rebuild native modules against Electron.
  npmRebuild: false,
  // Chromium UI locale packs: en only (−47MB installed). Engine-generated
  // strings (form-validation bubbles etc.) become English; text RENDERING is
  // unaffected (icudtl.dat + system fonts stay). Renderer content is ours.
  electronLanguages: ["en"],
  mac: {
    category: "public.app-category.developer-tools",
    target: [
      { target: "dmg", arch: ["arm64"] },
      { target: "zip", arch: ["arm64"] }, // required by electron-updater
    ],
    // biome-ignore lint/suspicious/noTemplateCurlyInString: electron-builder's own placeholder syntax, not a JS template
    artifactName: "${productName}-${version}-${arch}.${ext}",
    hardenedRuntime: true,
    gatekeeperAssess: false,
    entitlements: "build/entitlements.mac.plist",
    entitlementsInherit: "build/entitlements.mac.plist",
    // DESKTOP inversion #3: no LSUIElement — this is a real windowed app
    // with a Dock icon; tray residency comes from window-all-closed no-op,
    // not from agent-app status.
    notarize,
  },
  // DESKTOP addition #4: lzfse DMG — smaller AND faster to mount than the
  // UDZO default (measured: 124→113MB, 5.3s→4.3s install). Switch to ULMO
  // (82MB) once electron-builder#10018 lands the enum.
  dmg: {
    format: "ULFO",
  },
  // electron-updater feed. The packaged app's embedded app-update.yml bakes in
  // whatever is set at BUILD time:
  //  - default: GitHub Releases (latest-mac.yml + .blockmap published as release
  //    assets; electron-updater polls the latest PUBLISHED release anonymously —
  //    this is why drafts are the release pipeline's safety gate).
  //  - SIDECODE_UPDATE_URL: generic-provider override for pointing a local test
  //    build at a static server (e.g. `npx serve release/`).
  // `releaseType: "draft"` means CI's `--publish always` creates a DRAFT release;
  // installed apps only see it once it's manually published.
  publish: process.env.SIDECODE_UPDATE_URL
    ? {
        provider: "generic",
        url: process.env.SIDECODE_UPDATE_URL,
        channel: "latest",
      }
    : {
        provider: "github",
        owner: "thinkite",
        repo: "thinkite",
        releaseType: "draft",
      },
};
