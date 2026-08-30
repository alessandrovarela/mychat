#!/usr/bin/env node
import { run } from "./main.js";

/**
 * The executable wrapper. Kept separate from `main.ts` so the command logic is
 * importable by a test without the process exiting under it.
 */
const databasePath = process.env["DATABASE_PATH"] ?? "dev-data/mychat.db";

run(process.argv.slice(2), databasePath)
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
