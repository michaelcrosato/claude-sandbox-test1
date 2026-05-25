#!/usr/bin/env node
/**
 * Posthorn gateway entrypoint — `node dist/main.js` (or the `posthorn` bin).
 *
 * The thinnest possible process shell. With no args (or any non-`admin` args) it
 * reads configuration from the real `process.env`, wires a {@link Gateway}, starts
 * it, and translates OS signals into a graceful shutdown. Invoked as
 * `posthorn admin <command>` it instead runs a one-shot provisioning command (the
 * bootstrap path for minting the first app/key — see {@link runAdminCommand}) and
 * exits. Every decision lives in the pure, tested modules this calls
 * ({@link loadConfig}, {@link createGateway}, {@link runAdminCommand}); this file
 * is the one place that touches `process` and the console, and it is intentionally
 * not unit-tested (the composition it drives is, via `gateway.test.ts` and
 * `admin.test.ts`).
 */

import { SqliteAppStore } from "./apps/sqlite-app-store.js";
import { loadConfig } from "./runtime/config.js";
import { createGateway, resolveLocations } from "./runtime/gateway.js";
import { runAdminCommand } from "./runtime/admin.js";
import { createLogger } from "./logging/logger.js";

/**
 * Run a one-shot `posthorn admin` command against the configured data store, then
 * return its exit code. Opens only the app store (provisioning never touches the
 * other stores) at the same location the gateway uses, and always closes it.
 */
async function runAdmin(args: readonly string[]): Promise<number> {
  const config = loadConfig(process.env);
  const locations = resolveLocations(config.dataDir);
  const store = new SqliteAppStore({ location: locations.apps });
  try {
    return await runAdminCommand(args, {
      store,
      out: (line) => console.log(line),
      err: (line) => console.error(line),
    });
  } finally {
    store.close();
  }
}

async function runServer(): Promise<void> {
  const config = loadConfig(process.env);
  const gateway = createGateway(config);
  // `start()` itself emits the structured `gateway started` line (host/port/dataDir),
  // so the process shell no longer prints a human-only banner that would pollute the
  // JSON-Lines stdout stream. Lifecycle/signal logging here rides the same logger.
  await gateway.start();
  const log = gateway.logger;

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    log.info("shutdown signal received", { component: "gateway", signal });
    gateway.stop().then(
      () => {
        // `stop()` emits the `gateway stopped` line; just exit cleanly here.
        process.exit(0);
      },
      (err: unknown) => {
        log.error("error during shutdown", { component: "gateway", err });
        process.exit(1);
      },
    );
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv[0] === "admin") {
    // One-shot provisioning command: run it and exit (no server, no signal loop).
    process.exitCode = await runAdmin(argv.slice(1));
    return;
  }
  await runServer();
}

main().catch((err: unknown) => {
  // Startup can fail before a gateway (and its logger) exists — a bad config value,
  // a port already in use. Emit a structured error line through a default logger so
  // even the fatal-boot case stays on the uniform JSON-Lines stream, then fail.
  createLogger().error("gateway failed to start", { component: "gateway", err });
  process.exitCode = 1;
});
