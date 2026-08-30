import SqliteDriver from "better-sqlite3";
import type { Database as SqliteConnection } from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAutomationRunStore } from "./automation-runs.js";
import type { AutomationRunStore } from "./automation-runs.js";
import { IN_MEMORY_DATABASE, openDatabase } from "./database.js";
import type { DatabaseHandle } from "./database.js";
import { readMigrations, runMigrations } from "./migrations.js";

/**
 * Proves REQ-015: a contact runs an automation once, and the suppression is
 * keyed by the pair (automation, contact) rather than by flow.
 *
 * That distinction is the corrected error the requirement carries: keyed by
 * flow, someone who received one publication's material could never receive
 * another's, because both automations share the flow.
 *
 * And REQ-239 and REQ-240, which moved the mark without weakening it: the row
 * is written by the run that DELIVERS, and the write is still one atomic
 * INSERT, so two runs of one automation racing for the same contact cannot
 * both take it.
 */

const T0 = new Date("2026-08-01T10:00:00.000Z");
const T1 = new Date("2026-08-01T11:00:00.000Z");

/** Two runs of the same automation for the same contact, as the id encodes it. */
const RUN = "a1:contact-1:first";
const OTHER_RUN = "a1:contact-1:second";

describe("REQ-015: once per contact, per automation", () => {
  let handle: DatabaseHandle;
  let runs: AutomationRunStore;

  beforeEach(() => {
    handle = openDatabase({ databasePath: IN_MEMORY_DATABASE });
    runs = createAutomationRunStore(handle.db);
  });

  afterEach(() => {
    handle.close();
  });

  it("lets the first run through", async () => {
    expect(await runs.claim("a1", "contact-1", RUN, T0)).toBe(true);
  });

  it("suppresses the second run of the same pair", async () => {
    await runs.claim("a1", "contact-1", RUN, T0);

    expect(await runs.claim("a1", "contact-1", OTHER_RUN, T1)).toBe(false);
    expect(await runs.hasRun("a1", "contact-1")).toBe(true);
  });

  it("REQ-239: lets the run that HOLDS the mark deliver again", async () => {
    // One run, two deliveries: a message, a question, and then the file. The
    // second ask is the same run coming back after the contact answered, and
    // the mark it wrote itself must not be what stops it.
    await runs.claim("a1", "contact-1", RUN, T0);

    expect(await runs.claim("a1", "contact-1", RUN, T1)).toBe(true);
  });

  it("REQ-240: only one of two runs racing for a contact takes the mark", async () => {
    // The whole of the race, as the storage sees it. Both runs exist because
    // both passed the READ that `dispatch.ts` now does at the start, which is
    // exactly what a read cannot prevent; this INSERT is what decides, and it
    // decides once.
    const claims = await Promise.all([
      runs.claim("a1", "contact-1", RUN, T0),
      runs.claim("a1", "contact-1", OTHER_RUN, T0),
    ]);

    expect(claims.filter(Boolean)).toHaveLength(1);
  });

  it("refuses a run that finds a mark carrying no run at all", async () => {
    // A row written by the code that claimed at the START of a run, which is
    // what a database upgraded from an earlier build carries. It names no
    // delivery, so no run can call it its own, and the refusal is the safer of
    // the two errors: a contact who did receive is not sent a second copy.
    handle.connection
      .prepare(
        `INSERT INTO automation_runs (automation_id, contact_id, first_run_at)
         VALUES ('a1', 'contact-1', 0)`,
      )
      .run();

    expect(await runs.claim("a1", "contact-1", RUN, T0)).toBe(false);
    expect(await runs.hasRun("a1", "contact-1")).toBe(true);
  });

  it("lets the SAME contact run a DIFFERENT automation", async () => {
    // The heart of the corrected requirement: two automations over the same
    // flow are two different deliveries, and a contact is entitled to both.
    await runs.claim("a1", "contact-1", RUN, T0);

    expect(await runs.claim("a2", "contact-1", "a2:contact-1:x", T1)).toBe(
      true,
    );
  });

  it("lets a DIFFERENT contact run the same automation", async () => {
    await runs.claim("a1", "contact-1", RUN, T0);

    expect(await runs.claim("a1", "contact-2", "a1:contact-2:x", T1)).toBe(
      true,
    );
  });

  it("keeps the first instant, not the latest attempt", async () => {
    await runs.claim("a1", "contact-1", RUN, T0);
    await runs.claim("a1", "contact-1", OTHER_RUN, T1);

    // A second attempt must not rewrite history; the trail says when the
    // contact FIRST ran it.
    expect(await runs.hasRun("a1", "contact-1")).toBe(true);
  });

  it("reports no run for a pair that never happened", async () => {
    expect(await runs.hasRun("a1", "nobody")).toBe(false);
  });

  it("forgets an automation's runs, so recreating it starts clean", async () => {
    await runs.claim("a1", "contact-1", RUN, T0);
    await runs.claim("a1", "contact-2", "a1:contact-2:x", T0);
    await runs.claim("a2", "contact-1", "a2:contact-1:x", T0);

    expect(await runs.forget("a1")).toBe(2);
    expect(await runs.hasRun("a1", "contact-1")).toBe(false);
    // Untouched: forgetting one automation must not reset another.
    expect(await runs.hasRun("a2", "contact-1")).toBe(true);
  });

  it("reports nothing forgotten for an automation that never ran", async () => {
    // Zero and not a failure: an automation deleted before it ever fired is an
    // ordinary deletion, and the caller must not have to guard against it.
    expect(await runs.forget("never-fired")).toBe(0);
  });
});

/**
 * The rows the defect already left behind (REQ-120).
 *
 * Deleting an automation used to leave its runs in place, so a database that
 * has been through a delete-and-recreate carries rows naming an automation
 * that no longer exists. The deletion path fixed in `src/flows/automations.ts`
 * cannot reach them: that deletion already happened, possibly months ago. A
 * one-shot migration sweeps them, and this proves it sweeps THOSE and nothing
 * else.
 */
const CLEANUP_MIGRATION = "0010_forget_orphan_automation_runs";

describe(`REQ-120: ${CLEANUP_MIGRATION}`, () => {
  let connection: SqliteConnection;

  afterEach(() => {
    connection.close();
  });

  /**
   * A database as it stood BEFORE the cleanup, carrying one live automation
   * with a run, one orphan run, and one audit entry naming the automation that
   * was deleted. Migrations are taken from the shipped folder and cut at the
   * cleanup, which is the only honest way to reproduce the state: applying the
   * whole set first would sweep the rows before they could be written.
   */
  function databaseBeforeTheCleanup(): void {
    const shipped = readMigrations();
    const cleanupAt = shipped.findIndex((one) => one.tag === CLEANUP_MIGRATION);

    expect(cleanupAt).toBeGreaterThan(-1);

    connection = new SqliteDriver(IN_MEMORY_DATABASE);
    connection.pragma("foreign_keys = ON");
    runMigrations(connection, shipped.slice(0, cleanupAt));

    connection.exec(`
      INSERT INTO flows (id, name, definition, created_at, updated_at)
        VALUES ('welcome', 'Welcome', '{}', 0, 0);
      INSERT INTO automations
        (id, schema_version, name, enabled, trigger_type, trigger_keywords,
         trigger_match_mode, flow_id, once_per_contact, created_at, updated_at)
        VALUES ('live', 1, 'Live', 1, 'comment', '[]', 'contains', 'welcome',
                1, 0, 0);
      INSERT INTO automation_runs VALUES ('live', 'contact-1', 0);
      INSERT INTO automation_runs VALUES ('deleted-in-the-past', 'contact-2', 0);
      INSERT INTO audit_entries
        (occurred_at, kind, subtype, outcome, contact_id, automation_id)
        VALUES (0, 'event_received', 'comment', 'ok', 'contact-2',
                'deleted-in-the-past');
    `);
  }

  function runRows(): { automation_id: string; contact_id: string }[] {
    return connection
      .prepare(
        `SELECT automation_id, contact_id FROM automation_runs
         ORDER BY automation_id`,
      )
      .all() as { automation_id: string; contact_id: string }[];
  }

  it("sweeps the rows of an automation that no longer exists", () => {
    databaseBeforeTheCleanup();
    expect(runRows()).toHaveLength(2);

    runMigrations(connection, readMigrations());

    // The live automation keeps its record, so a contact it already served is
    // still spared a second delivery (REQ-015); the orphan is gone, so an
    // automation recreated under that id starts clean (REQ-120).
    expect(runRows()).toEqual([
      { automation_id: "live", contact_id: "contact-1" },
    ]);
  });

  it("leaves the audit trail of the deleted automation alone (REQ-056)", () => {
    databaseBeforeTheCleanup();

    runMigrations(connection, readMigrations());

    // The trail answers for what happened, including for an automation that
    // was deleted: sweeping the control of who ran it must not sweep the
    // record of what it did.
    const entries = connection
      .prepare(`SELECT automation_id FROM audit_entries`)
      .all() as { automation_id: string }[];

    expect(entries).toEqual([{ automation_id: "deleted-in-the-past" }]);
  });
});
