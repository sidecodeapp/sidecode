import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import electron from "vite-plugin-electron/simple";
import pkg from "./package.json" with { type: "json" };

// Anything resolved through `dependencies` is left as a runtime require()
// instead of being inlined into dist-electron/index.js (menubar's recipe).
// Native modules (@lydell/node-pty, @number0/iroh via the daemon) must
// NOT be bundled — the bundler rewrites the .node require path and the
// binary can't be found. External-by-name is also the property that lets a
// daemon rebuild land without re-bundling the desktop main, and bun's
// hoisted linker puts every name where Node can resolve it.
const externalDeps = Object.keys(pkg.dependencies ?? {});

export default defineConfig({
  plugins: [
    tanstackRouter({ target: "react", autoCodeSplitting: true }),
    react(),
    tailwindcss(),
    // Orchestration is INVERTED vs the electrobun era: `vite` is the one
    // dev command — this plugin bundles server/index.ts, spawns Electron
    // with VITE_DEV_SERVER_URL in its env once the dev server is up, and
    // rebuild+restarts Electron on main-process changes (renderer changes
    // stay plain HMR). The old in-main probe/spawn dance is gone; main
    // just reads the env var. No preload: the renderer talks to main over
    // the loopback server, not IPC.
    electron({
      main: {
        entry: "server/index.ts",
        vite: {
          build: {
            rolldownOptions: { external: ["electron", ...externalDeps] },
          },
        },
      },
    }),
  ],
  resolve: {
    // The workspace hoists one react (pinned by the Expo app) while Astryx's
    // peer range can pull a nested copy — two React instances break hooks
    // (`p.H.use` TypeError in Theme). Always bundle exactly one.
    dedupe: ["react", "react-dom"],
  },
  // Pierre's worker.js is an ES module — the official docs call out that
  // Vite's `?worker` build needs format "es" (the iife default can't wrap
  // module workers). Chromium-only target now, es stays safe.
  worker: { format: "es" },
  // Prebundle Pierre's entries (incl. the ?worker subpath) — t3code's setup;
  // avoids dev-time optimizer misses on the multi-entry exports map.
  optimizeDeps: {
    include: ["@pierre/diffs", "@pierre/diffs/react"],
  },
  server: {
    port: 5183,
    strictPort: true,
    // Backend routes live on server/index.ts's fixed port; the renderer
    // uses relative URLs, so the dev server forwards them.
    proxy: {
      "/pty": { target: "http://127.0.0.1:5199", ws: true },
      "/rpc": { target: "http://127.0.0.1:5199", ws: true },
      "/api": { target: "http://127.0.0.1:5199" },
    },
  },
});
