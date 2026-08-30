#!/usr/bin/env node
import { createApp } from "./app.js";
import { ConfigError } from "./config/errors.js";
import { ASSETS_ROUTE_PREFIX } from "./http/index.js";
import { t } from "./i18n/index.js";
import { StorageError } from "./storage/index.js";

/**
 * The process (REQ-091). Everything it does lives in `app.ts`; this file only
 * reads `process.env`, binds a port, and handles the signals that end it.
 *
 * Deliberately thin, and for the same reason `cli/bin.ts` is: the composition
 * has to be exercisable by a test without a process exiting under it.
 */

/**
 * Every interface, not loopback. The platform reaches this process from the
 * outside, through a tunnel in development and a proxy or a container port
 * mapping in production, and binding to loopback makes all three unreachable
 * with no error to explain it.
 */
const HOST = "0.0.0.0";

async function main(): Promise<void> {
  const app = await createApp(process.env);

  // Registered BEFORE listening, so an interrupt during start-up still drains
  // the sweep and closes the database instead of severing them.
  const stop = (): void => {
    void app.close().then(() => {
      process.exit(0);
    });
  };

  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  // Last, and only now: everything that could refuse to work has already run.
  await app.server.listen({ port: app.config.port, host: HOST });

  const origin = app.config.publicOrigin;
  console.log(
    t("app.listening", {
      port: app.config.port,
      origin,
      webhook: `${origin}/webhook`,
      assets: `${origin}${ASSETS_ROUTE_PREFIX}`,
    }),
  );
}

try {
  await main();
} catch (error: unknown) {
  // Configuration and migrations are the two failures an operator can act on,
  // and both already carry a message that names what is wrong: a stack trace
  // over it would bury the one line that matters. Anything else is a defect of
  // ours and propagates whole, stack included.
  if (error instanceof ConfigError || error instanceof StorageError) {
    console.error(error.message);
    process.exitCode = 1;
  } else {
    throw error;
  }
}
