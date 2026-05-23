#!/usr/bin/env node
/**
 * Posthorn gateway entrypoint — `node dist/main.js` (or the `posthorn` bin).
 *
 * The thinnest possible process shell: read configuration from the real
 * `process.env`, wire a {@link Gateway}, start it, and translate OS signals into a
 * graceful shutdown. Every decision lives in the pure, tested modules this calls
 * ({@link loadConfig}, {@link createGateway}); this file is the one place that
 * touches `process` and the console, and it is intentionally not unit-tested (the
 * composition it drives is, via `gateway.test.ts`).
 */

import { loadConfig } from "./runtime/config.js";
import { createGateway } from "./runtime/gateway.js";

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const gateway = createGateway(config);
  const address = await gateway.start();
  console.log(
    `[posthorn] listening on http://${address.host}:${address.port} ` +
      `(data: ${config.dataDir})`,
  );

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    console.log(`[posthorn] ${signal} received — shutting down gracefully`);
    gateway.stop().then(
      () => {
        console.log("[posthorn] stopped");
        process.exit(0);
      },
      (err: unknown) => {
        console.error("[posthorn] error during shutdown:", err);
        process.exit(1);
      },
    );
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err: unknown) => {
  console.error("[posthorn] failed to start:", err);
  process.exitCode = 1;
});
