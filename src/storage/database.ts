import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import SqliteDriver from "better-sqlite3";
import type { Database as SqliteConnection } from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type { EnvConfig } from "../config/env.js";
import { runMigrations, readMigrations } from "./migrations.js";
import type { MigrationReport } from "./migrations.js";
import * as schema from "./schema.js";

/**
 * Opening the database, which is also the only place migrations are applied.
 *
 * The Phase 1 start-up sequence calls `openDatabase` BEFORE the HTTP server
 * starts listening, and lets the error propagate: a failure here must stop the
 * process instead of letting it serve on a schema it cannot trust (acceptance
 * criterion 20). Nothing else in the codebase should open a connection.
 */

/** Value SQLite reserves for a database that lives only in memory. */
export const IN_MEMORY_DATABASE = ":memory:";

/**
 * Structural on purpose: `EnvConfig` satisfies it, so the start-up sequence
 * passes the loaded configuration straight through.
 */
export interface DatabaseConfig extends Pick<EnvConfig, "databasePath"> {
  /** Defaults to the `drizzle/` folder shipped with the application. */
  readonly migrationsFolder?: string;
}

export type MyChatDatabase = BetterSQLite3Database<typeof schema>;

export interface DatabaseHandle {
  readonly db: MyChatDatabase;
  /** What the start-up migration run did, for the caller to log (AC 19). */
  readonly migrations: MigrationReport;
  /** Underlying connection, for the rare caller that needs raw SQL. */
  readonly connection: SqliteConnection;
  close(): void;
}

export function openDatabase(config: DatabaseConfig): DatabaseHandle {
  const connection = connect(config.databasePath);

  try {
    const migrations = runMigrations(
      connection,
      readMigrations(config.migrationsFolder),
    );

    return {
      db: drizzle(connection, { schema }),
      migrations,
      connection,
      close: () => connection.close(),
    };
  } catch (error) {
    // A half-open handle on an unmigrated database is exactly what must not
    // survive this function.
    connection.close();
    throw error;
  }
}

function connect(databasePath: string): SqliteConnection {
  if (databasePath !== IN_MEMORY_DATABASE) {
    // A fresh clone has no `dev-data/`, and the default path points inside it.
    mkdirSync(dirname(resolve(databasePath)), { recursive: true });
  }

  const connection = new SqliteDriver(databasePath);

  // WAL is what Litestream replicates from (ADR-014), so it is not a tuning
  // knob here: without it there is no continuous backup.
  connection.pragma("journal_mode = WAL");
  connection.pragma("foreign_keys = ON");

  return connection;
}
