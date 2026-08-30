import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import SqliteDriver from "better-sqlite3";
import type { Database as SqliteConnection } from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { IN_MEMORY_DATABASE, openDatabase } from "./database.js";
import { MigrationError, StorageError } from "./errors.js";
import {
  DEFAULT_MIGRATIONS_FOLDER,
  MIGRATIONS_TABLE,
  readAppliedMigrations,
  readMigrations,
  runMigrations,
} from "./migrations.js";
import type { Migration } from "./migrations.js";

/**
 * Migration behaviour, proved with no container and no network (ADR-018): a
 * temporary SQLite file, or an in-memory one where reopening is not the point.
 */

const workspaces: string[] = [];

afterEach(() => {
  while (workspaces.length > 0) {
    const workspace = workspaces.pop();
    if (workspace !== undefined) {
      rmSync(workspace, { recursive: true, force: true });
    }
  }
});

function workspace(): string {
  const created = mkdtempSync(join(tmpdir(), "mychat-storage-"));
  workspaces.push(created);
  return created;
}

function tableNames(connection: SqliteConnection): string[] {
  const rows = connection
    .prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`,
    )
    .all() as { name: string }[];
  return rows.map((row) => row.name);
}

function ledgerRows(
  connection: SqliteConnection,
): { tag: string; checksum: string; applied_at: number }[] {
  return connection
    .prepare(`SELECT tag, checksum, applied_at FROM ${MIGRATIONS_TABLE}`)
    .all() as { tag: string; checksum: string; applied_at: number }[];
}

/** A migrations folder written on the fly, to exercise failure paths. */
function migrationsFolder(files: Record<string, string>): string {
  const folder = join(workspace(), "migrations");
  mkdirSync(join(folder, "meta"), { recursive: true });

  writeFileSync(
    join(folder, "meta", "_journal.json"),
    JSON.stringify({
      version: "7",
      dialect: "sqlite",
      entries: Object.keys(files).map((tag, idx) => ({
        idx,
        version: "6",
        when: 0,
        tag,
        breakpoints: true,
      })),
    }),
  );

  for (const [tag, sql] of Object.entries(files)) {
    writeFileSync(join(folder, `${tag}.sql`), sql);
  }

  return folder;
}

describe("reading the generated migrations", () => {
  it("reads the migration shipped with the application", () => {
    const migrations = readMigrations();

    // Derived from the folder rather than pinned to a literal: a new
    // migration is a routine event, and a test that fails on every one of them
    // trains people to update it without reading it.
    expect(migrations.length).toBeGreaterThan(0);
    expect(migrations.map((migration) => migration.tag)).toContain(
      "0000_initial",
    );
    expect(migrations.map((migration) => migration.tag)).toEqual(
      [...migrations]
        .sort((a, b) => a.tag.localeCompare(b.tag))
        .map((m) => m.tag),
    );
    for (const migration of migrations) {
      expect(migration.statements.length).toBeGreaterThan(0);
      expect(migration.checksum).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  /**
   * The snapshot drizzle-kit DIFFS AGAINST is the last one, and only the last
   * one. Measured on 2026-08-20: `0013`, `0015` and `0016` have no snapshot
   * because those three were written by hand, and nothing is harmed by their
   * absence. What DID break, on 2026-08-18, was the last snapshot being older
   * than the last migration: `generate` then compared the schema against a
   * stale picture and re-emitted everything since, producing a migration with
   * four DROP TABLEs already applied and one ADD COLUMN already applied.
   * Applied as it came, it would have failed. So the invariant worth a guard
   * is not "every entry has a snapshot": it is "the newest entry has one".
   */
  it("keeps a snapshot for the newest journal entry, the only one generate compares against", () => {
    const journal = JSON.parse(
      readFileSync(
        join(DEFAULT_MIGRATIONS_FOLDER, "meta", "_journal.json"),
        "utf8",
      ),
    ) as { entries: { idx: number; tag: string }[] };

    expect(journal.entries.length).toBeGreaterThan(0);
    const newest = journal.entries.reduce((a, b) => (b.idx > a.idx ? b : a));
    const snapshot = join(
      DEFAULT_MIGRATIONS_FOLDER,
      "meta",
      `${String(newest.idx).padStart(4, "0")}_snapshot.json`,
    );

    expect(
      existsSync(snapshot),
      `no snapshot for ${newest.tag}: drizzle-kit generate would diff against an older picture and re-emit migrations already applied`,
    ).toBe(true);
  });

  it("refuses a folder with no journal instead of silently migrating nothing", () => {
    expect(() => readMigrations(join(workspace(), "absent"))).toThrow(
      StorageError,
    );
  });

  it("refuses a journal entry whose SQL file is missing, naming the migration", () => {
    const folder = migrationsFolder({ "0000_initial": "SELECT 1;" });
    rmSync(join(folder, "0000_initial.sql"));

    expect(() => readMigrations(folder)).toThrow(/0000_initial/);
  });
});

describe("applying migrations to an empty database (AC 19)", () => {
  it("does not leave retired flow, automation, or revision tables", () => {
    const handle = openDatabase({ databasePath: IN_MEMORY_DATABASE });

    try {
      expect(tableNames(handle.connection)).not.toContain("flows");
      expect(tableNames(handle.connection)).not.toContain("automations");
      expect(tableNames(handle.connection)).not.toContain("flow_revisions");
      expect(tableNames(handle.connection)).not.toContain(
        "automation_revisions",
      );
    } finally {
      handle.close();
    }
  });

  it("creates the tables Phase 3 writes to", () => {
    const handle = openDatabase({ databasePath: IN_MEMORY_DATABASE });

    try {
      expect(tableNames(handle.connection)).toEqual(
        expect.arrayContaining([
          "operator_credential",
          "sessions",
          "automation_aggregates",
          "publication_cache",
          "instance_preferences",
        ]),
      );
    } finally {
      handle.close();
    }
  });

  it("creates the durable automation failure sequence table", () => {
    const handle = openDatabase({ databasePath: IN_MEMORY_DATABASE });

    try {
      expect(tableNames(handle.connection)).toContain(
        "automation_failure_sequences",
      );
    } finally {
      handle.close();
    }
  });

  it("adds the audit subtype column to a database that already had entries", () => {
    // REQ-106 lands on a table that already exists in the field, so the
    // migration is an ALTER and not a fresh CREATE. This asserts the shape the
    // running installation ends up with: the column is there, and it is
    // NULLABLE, because the rows already written cannot be told what they were.
    const handle = openDatabase({ databasePath: IN_MEMORY_DATABASE });

    try {
      const columns = handle.connection
        .prepare(`PRAGMA table_info(audit_entries)`)
        .all() as { name: string; notnull: number }[];

      const subtype = columns.find((column) => column.name === "subtype");

      expect(subtype).toBeDefined();
      expect(subtype?.notnull).toBe(0);
    } finally {
      handle.close();
    }
  });

  it("adds the event text and the public identifier as nullable columns", () => {
    // REQ-162 lands on the same table already in the field, so it is an ALTER
    // too. Both columns are NULLABLE by construction: the rows already written
    // never stored a text, and no pass over them could reconstruct one. A NOT
    // NULL here would either refuse to apply or backfill an empty string onto
    // every historical row, which is a value claiming "this event said
    // nothing" about events nobody ever recorded.
    const handle = openDatabase({ databasePath: IN_MEMORY_DATABASE });

    try {
      const columns = handle.connection
        .prepare(`PRAGMA table_info(audit_entries)`)
        .all() as { name: string; notnull: number; dflt_value: unknown }[];

      for (const name of ["event_text", "contact_username"]) {
        const column = columns.find((candidate) => candidate.name === name);

        expect(column).toBeDefined();
        expect(column?.notnull).toBe(0);
        // No default either: a default would put a value on rows that arrived
        // with none, which is the same lie by a quieter route.
        expect(column?.dflt_value).toBeNull();
      }
    } finally {
      handle.close();
    }
  });

  it("adds nullable immutable analytics attribution to the audit trail", () => {
    const handle = openDatabase({ databasePath: IN_MEMORY_DATABASE });

    try {
      const columns = handle.connection
        .prepare(`PRAGMA table_info(audit_entries)`)
        .all() as { name: string; notnull: number; dflt_value: unknown }[];

      for (const name of [
        "execution_id",
        "automation_scope",
        "publication_id",
        "matched_keyword",
      ]) {
        const column = columns.find((candidate) => candidate.name === name);
        expect(column).toBeDefined();
        expect(column?.notnull).toBe(0);
        expect(column?.dflt_value).toBeNull();
      }

      const indexes = handle.connection
        .prepare(`PRAGMA index_list(audit_entries)`)
        .all() as { name: string }[];
      expect(indexes.map((index) => index.name)).toEqual(
        expect.arrayContaining([
          "audit_execution_idx",
          "audit_publication_idx",
        ]),
      );
    } finally {
      handle.close();
    }
  });

  it("adds nullable historical button labels with no legacy backfill", () => {
    const handle = openDatabase({ databasePath: IN_MEMORY_DATABASE });

    try {
      for (const [table, name] of [
        ["button_destinations", "label"],
        ["button_clicks", "button_label"],
      ] as const) {
        const columns = handle.connection
          .prepare(`PRAGMA table_info(${table})`)
          .all() as { name: string; notnull: number; dflt_value: unknown }[];
        const column = columns.find((candidate) => candidate.name === name);
        expect(column).toBeDefined();
        expect(column?.notnull).toBe(0);
        expect(column?.dflt_value).toBeNull();
      }
    } finally {
      handle.close();
    }
  });

  it("adds the publication caption as a nullable column with no default", () => {
    // REQ-216 lands on a table that is already full in the field, so it is an
    // ALTER and not a fresh CREATE. NULLABLE by construction, and for two
    // reasons that both have to keep working: a publication may carry no
    // caption at all, and every row cached before this column existed carries
    // no caption that anything local could reconstruct. A NOT NULL here would
    // either refuse to apply or write an empty string onto every row already
    // stored, which is a value claiming "this post said nothing".
    const handle = openDatabase({ databasePath: IN_MEMORY_DATABASE });

    try {
      const columns = handle.connection
        .prepare(`PRAGMA table_info(publication_cache)`)
        .all() as { name: string; notnull: number; dflt_value: unknown }[];

      const caption = columns.find((column) => column.name === "caption");

      expect(caption).toBeDefined();
      expect(caption?.notnull).toBe(0);
      // No default either: a default would put text on rows that arrived with
      // none, which is the same lie by a quieter route.
      expect(caption?.dflt_value).toBeNull();
    } finally {
      handle.close();
    }
  });

  it("reports and records what it applied", () => {
    const handle = openDatabase({ databasePath: IN_MEMORY_DATABASE });

    try {
      const shipped = readMigrations().map((migration) => migration.tag);

      expect(handle.migrations.applied).toEqual(shipped);
      expect(handle.migrations.alreadyApplied).toEqual([]);

      // The report is what the caller logs; the ledger is what survives a
      // restart. Both have to name every migration.
      expect(readAppliedMigrations(handle.connection)).toEqual(shipped);

      const recorded = ledgerRows(handle.connection);
      expect(recorded).toHaveLength(shipped.length);
      expect(recorded[0]?.tag).toBe("0000_initial");
      expect(recorded[0]?.checksum).toMatch(/^[0-9a-f]{64}$/);
      expect(recorded[0]?.applied_at).toBeGreaterThan(0);
    } finally {
      handle.close();
    }
  });
});

describe("a migration that fails (AC 20)", () => {
  const broken: Migration = {
    tag: "0001_broken",
    statements: ["CREATE TABLE ok (id TEXT)", "THIS IS NOT SQL"],
    checksum: "0".repeat(64),
  };

  it("throws an error that identifies the migration", () => {
    const connection = new SqliteDriver(IN_MEMORY_DATABASE);

    try {
      let caught: unknown;
      try {
        runMigrations(connection, [broken]);
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(MigrationError);
      expect((caught as MigrationError).tag).toBe("0001_broken");
      expect((caught as MigrationError).message).toContain("0001_broken");
    } finally {
      connection.close();
    }
  });

  it("leaves neither a half applied schema nor a ledger row claiming success", () => {
    const connection = new SqliteDriver(IN_MEMORY_DATABASE);

    try {
      expect(() => runMigrations(connection, [broken])).toThrow(MigrationError);

      // The first statement of the migration succeeded before the second one
      // failed: if it survived, the next start would serve on a schema no
      // migration describes.
      expect(tableNames(connection)).not.toContain("ok");
      expect(ledgerRows(connection)).toEqual([]);
    } finally {
      connection.close();
    }
  });

  it("stops openDatabase from handing out a usable database", () => {
    const folder = migrationsFolder({ "0000_broken": "THIS IS NOT SQL" });

    expect(() =>
      openDatabase({
        databasePath: join(workspace(), "mychat.db"),
        migrationsFolder: folder,
      }),
    ).toThrow(MigrationError);
  });

  it("refuses a migration whose content changed after it was applied", () => {
    const connection = new SqliteDriver(IN_MEMORY_DATABASE);

    try {
      const original: Migration = {
        tag: "0000_initial",
        statements: ["CREATE TABLE example (id TEXT)"],
        checksum: "a".repeat(64),
      };
      runMigrations(connection, [original]);

      const edited: Migration = { ...original, checksum: "b".repeat(64) };
      expect(() => runMigrations(connection, [edited])).toThrow(/0000_initial/);
    } finally {
      connection.close();
    }
  });
});

describe("an already migrated database (AC 21)", () => {
  it("reapplies nothing when the process starts again", () => {
    const databasePath = join(workspace(), "mychat.db");

    const first = openDatabase({ databasePath });
    const firstLedger = ledgerRows(first.connection);
    first.close();

    const second = openDatabase({ databasePath });

    try {
      expect(second.migrations.applied).toEqual([]);
      expect(second.migrations.alreadyApplied).toEqual(
        readMigrations().map((migration) => migration.tag),
      );

      // Same row, same instant: nothing ran a second time.
      expect(ledgerRows(second.connection)).toEqual(firstLedger);
    } finally {
      second.close();
    }
  });

  it("creates the database file under a directory that does not exist yet", () => {
    const databasePath = join(workspace(), "dev-data", "nested", "mychat.db");

    const handle = openDatabase({ databasePath });

    try {
      expect(handle.migrations.applied).toEqual(
        readMigrations().map((migration) => migration.tag),
      );
    } finally {
      handle.close();
    }
  });
});
