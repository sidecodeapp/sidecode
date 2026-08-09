#!/usr/bin/env node
import { PROTOCOL_VERSION } from "@thinkite/protocol";
import { resolveThinkiteHome } from "../home.ts";
import { loadOrCreateIdentity } from "../identity.ts";
import { start } from "../index.ts";
import { KnownClients } from "../known-clients.ts";
import { runPairCommand } from "../pair-command.ts";

const [, , rawSubcommand, ...rest] = process.argv;
const subcommand = rawSubcommand ?? "help";

async function main(): Promise<void> {
  switch (subcommand) {
    case "up":
    case "start": {
      const daemon = await start();
      let shuttingDown = false;
      const shutdown = async (signal: string) => {
        if (shuttingDown) {
          console.log(`received ${signal} during shutdown — ignoring`);
          return;
        }
        shuttingDown = true;
        console.log(`\nreceived ${signal}, shutting down…`);
        // Process-level safety net: if daemon.stop() (and the per-runtime
        // 5s grace inside) still haven't finished after 10s, force exit.
        // unref() so the timer doesn't itself prevent natural exit if
        // shutdown DOES complete cleanly.
        const forceExit = setTimeout(() => {
          console.error("shutdown stalled past 10s, forcing exit");
          process.exit(1);
        }, 10_000);
        forceExit.unref();
        try {
          await daemon.stop();
        } catch (err) {
          console.error("error during shutdown:", err);
        } finally {
          clearTimeout(forceExit);
          process.exit(0);
        }
      };
      process.on("SIGINT", () => void shutdown("SIGINT"));
      process.on("SIGTERM", () => void shutdown("SIGTERM"));
      return;
    }

    case "down":
    case "stop":
      console.log("TODO: signal running daemon");
      return;

    case "pair": {
      await runPairCommand(rest);
      return;
    }

    case "status": {
      const home = resolveThinkiteHome();
      const identity = loadOrCreateIdentity(home);
      const known = KnownClients.load(home);
      console.log(`thinkite home:    ${home}`);
      console.log(`fingerprint:      ${identity.fingerprint}`);
      console.log(`paired clients:   ${known.list().length}`);
      for (const c of known.list()) {
        const when = new Date(c.pairedAt).toISOString().slice(0, 19);
        console.log(`  ${c.fingerprint}  paired ${when}  ${c.label ?? ""}`);
      }
      return;
    }

    case "logs":
      console.log("TODO: tail $THINKITE_HOME/daemon.log");
      return;

    case "iroh-probe": {
      // Dev-only: echo-accept on the daemon identity over iroh. See
      // iroh-probe.ts — lazy import keeps the napi binding off every
      // other subcommand's path.
      const { runIrohProbe } = await import("../iroh-probe.ts");
      await runIrohProbe(resolveThinkiteHome());
      return;
    }

    case "install-agent":
      console.log("TODO: install launchd plist to ~/Library/LaunchAgents/");
      return;

    case "version":
    case "--version":
    case "-v":
      console.log(`thinkite (protocol ${PROTOCOL_VERSION})`);
      return;

    case "help":
    case "--help":
    case "-h":
      printHelp();
      return;

    default:
      console.error(`thinkite: unknown command "${subcommand}"\n`);
      printHelp();
      process.exit(1);
  }
}

function printHelp(): void {
  console.log(`thinkite — remote-control Claude Code from your phone

Usage:
  thinkite <command>

Commands:
  up, start          Start the daemon in the foreground
  down, stop         Stop the running daemon
  pair               Print pairing QR for a new mobile client
  status             Show daemon status and connected clients
  logs               Tail daemon logs
  install-agent      Install launchd plist so daemon starts on login
  version            Print version
  help               Show this help`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
