import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createAuditRepository,
  subtypeGroupOf,
  UNKNOWN_SUBTYPE,
} from "./audit.js";
import type {
  AuditEntry,
  AuditRepository,
  AuditSubtypeGroup,
} from "./audit.js";
import { IN_MEMORY_DATABASE, openDatabase } from "./database.js";
import type { DatabaseHandle } from "./database.js";

/**
 * Proves REQ-029: every inbound event and every executed action leaves a
 * record carrying instant, contact, flow, step and outcome, and a failed
 * action also carries the reason.
 *
 * The trail is queried, not just written. The application spec decided the
 * operator's metrics come from this table instead of an external
 * observability stack, so "it appends" would not be enough: an append-only
 * blob nobody can filter answers no operator question.
 */

const T0 = new Date("2026-08-01T10:00:00.000Z");
const T1 = new Date("2026-08-01T11:00:00.000Z");
const T2 = new Date("2026-08-01T12:00:00.000Z");

describe("REQ-029: the audit trail", () => {
  let handle: DatabaseHandle;
  let audit: AuditRepository;

  beforeEach(() => {
    handle = openDatabase({ databasePath: IN_MEMORY_DATABASE });
    audit = createAuditRepository(handle.db);
  });

  afterEach(() => {
    handle.close();
  });

  it("records an inbound event with everything the operator needs to trace it", async () => {
    const entry = await audit.record(
      {
        kind: "event_received",
        outcome: "ok",
        contactId: "contact-1",
        eventId: "event-1",
      },
      T0,
    );

    expect(entry).toMatchObject({
      kind: "event_received",
      outcome: "ok",
      contactId: "contact-1",
      eventId: "event-1",
    });
    expect(entry.occurredAt.toISOString()).toBe(T0.toISOString());
    expect(entry.id).toBeGreaterThan(0);
  });

  it("records an executed action with contact, flow, step and outcome", async () => {
    const entry = await audit.record(
      {
        kind: "action_executed",
        outcome: "ok",
        contactId: "contact-1",
        flowId: "welcome",
        stepId: "send-link",
        automationId: "automation-1",
      },
      T0,
    );

    // The five fields REQ-029 names, all present on one row.
    expect(entry.occurredAt).toBeInstanceOf(Date);
    expect(entry.contactId).toBe("contact-1");
    expect(entry.flowId).toBe("welcome");
    expect(entry.stepId).toBe("send-link");
    expect(entry.outcome).toBe("ok");
  });

  it("keeps execution, scope and publication attribution as immutable facts", async () => {
    const entry = await audit.record(
      {
        kind: "action_executed",
        outcome: "ok",
        automationId: "welcome",
        executionId: "welcome:contact-1:run",
        automationScope: "publication",
        publicationId: "post-1",
      },
      T0,
    );

    expect(entry).toMatchObject({
      executionId: "welcome:contact-1:run",
      automationScope: "publication",
      publicationId: "post-1",
    });
    expect(await audit.query()).toContainEqual(
      expect.objectContaining({
        executionId: "welcome:contact-1:run",
        publicationId: "post-1",
      }),
    );
  });

  it("keeps the matched keyword as an immutable execution fact", async () => {
    const entry = await audit.record(
      {
        kind: "action_executed",
        outcome: "ok",
        automationId: "welcome",
        executionId: "welcome:contact-1:run",
        matchedKeyword: "guide",
      },
      T0,
    );

    expect(entry.matchedKeyword).toBe("guide");
    expect((await audit.query())[0]).toMatchObject({
      matchedKeyword: "guide",
    });
  });

  it("carries the reason when the action failed", async () => {
    const entry = await audit.record(
      {
        kind: "action_executed",
        outcome: "failed",
        contactId: "contact-1",
        flowId: "welcome",
        stepId: "send-link",
        reason: "platform returned 429",
      },
      T0,
    );

    expect(entry.reason).toBe("platform returned 429");
  });

  it("omits absent fields instead of turning them into nulls", async () => {
    // An event rejected before anyone knows the contact still deserves a row;
    // what it must not do is claim a contact of `null`.
    const entry = await audit.record(
      { kind: "event_received", outcome: "failed", reason: "bad signature" },
      T0,
    );

    expect(entry.contactId).toBeUndefined();
    expect(entry.flowId).toBeUndefined();
    expect(entry).toHaveProperty("reason");
  });

  it("distinguishes the outcomes an operator would ask about separately", async () => {
    for (const outcome of ["duplicate", "suppressed", "blocked"] as const) {
      const entry = await audit.record(
        { kind: "event_received", outcome, reason: `because ${outcome}` },
        T0,
      );
      expect(entry.outcome).toBe(outcome);
    }

    expect(await audit.query({ outcome: "suppressed" })).toHaveLength(1);
  });
});

describe("REQ-029: the trail is queryable, not merely appendable", () => {
  let handle: DatabaseHandle;
  let audit: AuditRepository;

  beforeEach(async () => {
    handle = openDatabase({ databasePath: IN_MEMORY_DATABASE });
    audit = createAuditRepository(handle.db);

    await audit.record(
      {
        kind: "event_received",
        outcome: "ok",
        contactId: "alice",
        eventId: "e1",
      },
      T0,
    );
    await audit.record(
      {
        kind: "action_executed",
        outcome: "ok",
        contactId: "alice",
        flowId: "welcome",
        stepId: "s1",
      },
      T1,
    );
    await audit.record(
      {
        kind: "action_executed",
        outcome: "failed",
        contactId: "bob",
        flowId: "other",
        stepId: "s1",
        reason: "nope",
      },
      T2,
    );
  });

  afterEach(() => {
    handle.close();
  });

  it("returns the whole trail newest first when nothing is filtered", async () => {
    const entries = await audit.query();

    expect(entries).toHaveLength(3);
    expect(entries[0]?.contactId).toBe("bob");
  });

  it("filters by contact", async () => {
    const entries = await audit.query({ contactId: "alice" });

    expect(entries).toHaveLength(2);
    expect(entries.every((entry) => entry.contactId === "alice")).toBe(true);
  });

  it("filters by kind, by outcome and by flow", async () => {
    expect(await audit.query({ kind: "event_received" })).toHaveLength(1);
    expect(await audit.query({ outcome: "failed" })).toHaveLength(1);
    expect(await audit.query({ flowId: "welcome" })).toHaveLength(1);
  });

  it("filters by event id, which is how a duplicate delivery is traced", async () => {
    const entries = await audit.query({ eventId: "e1" });

    expect(entries).toHaveLength(1);
    expect(entries[0]?.kind).toBe("event_received");
  });

  it("narrows by time window", async () => {
    const entries = await audit.query({ since: T1, until: T2 });

    expect(entries).toHaveLength(2);
  });

  it("orders oldest first on request, so a run reads as a sequence", async () => {
    const entries = await audit.query({ order: "oldest" });

    expect(entries.map((entry) => entry.contactId)).toEqual([
      "alice",
      "alice",
      "bob",
    ]);
  });

  it("caps the result when asked", async () => {
    expect(await audit.query({ limit: 2 })).toHaveLength(2);
  });

  it("combines filters instead of applying only the last one", async () => {
    const entries = await audit.query({
      contactId: "alice",
      kind: "action_executed",
    });

    expect(entries).toHaveLength(1);
    expect(entries[0]?.stepId).toBe("s1");
  });
});

/**
 * Proves REQ-106: the entry records the SPECIFIC type of the event or the
 * action, written at the instant of the record, and entries that predate the
 * column group as unknown without failing the aggregation.
 *
 * What the test has to rule out is not "the value round-trips" but "the value
 * could have been derived later". The derivation available in this codebase is
 * `stepId` looked up against the flow definition in force, and Phase 3 adds
 * revisions and restoration precisely so that definition changes: a run from
 * yesterday would then be counted as whatever its step happens to be today, or
 * as nothing at all once the flow is deleted.
 */
describe("REQ-106: the entry records its own type", () => {
  let handle: DatabaseHandle;
  let audit: AuditRepository;

  beforeEach(() => {
    handle = openDatabase({ databasePath: IN_MEMORY_DATABASE });
    audit = createAuditRepository(handle.db);
  });

  afterEach(() => {
    handle.close();
  });

  /** A row exactly as it stood before the column existed: no subtype at all. */
  function insertPreMigrationEntry(kind: string, outcome: string): void {
    handle.connection
      .prepare(
        `INSERT INTO audit_entries (occurred_at, kind, outcome) VALUES (?, ?, ?)`,
      )
      .run(T0.getTime(), kind, outcome);
  }

  function countBySubtype(
    entries: readonly AuditEntry[],
  ): Map<AuditSubtypeGroup, number> {
    const counts = new Map<AuditSubtypeGroup, number>();
    for (const entry of entries) {
      const group = subtypeGroupOf(entry);
      counts.set(group, (counts.get(group) ?? 0) + 1);
    }
    return counts;
  }

  it("tells a comment from a direct message, which `kind` alone never could", async () => {
    await audit.record(
      { kind: "event_received", subtype: "comment", outcome: "ok" },
      T0,
    );
    await audit.record(
      { kind: "event_received", subtype: "direct_message", outcome: "ok" },
      T1,
    );

    // The count REQ-036 asks for, and the reason the column exists: both rows
    // are `event_received`, so before this there was nothing to group by.
    expect(await audit.query({ subtype: "comment" })).toHaveLength(1);
    expect(await audit.query({ subtype: "direct_message" })).toHaveLength(1);
    expect(await audit.query({ kind: "event_received" })).toHaveLength(2);
  });

  it("counts a public reply apart from a message sent (REQ-037)", async () => {
    await audit.record(
      {
        kind: "action_executed",
        subtype: "comment_reply",
        outcome: "ok",
        flowId: "welcome",
        stepId: "s1",
      },
      T0,
    );
    await audit.record(
      {
        kind: "action_executed",
        subtype: "message_sent",
        outcome: "ok",
        flowId: "welcome",
        stepId: "s2",
      },
      T1,
    );

    expect(await audit.query({ subtype: "comment_reply" })).toHaveLength(1);
    expect(await audit.query({ subtype: "message_sent" })).toHaveLength(1);
  });

  it("keeps a per-row answer, so no reader can recompute it from flow and step", async () => {
    // The SAME flow and the SAME step, recorded twice with different types:
    // this is what a flow edited (or restored) between the two runs looks like
    // from the trail's side. A subtype derived from `stepId` against the
    // definition in force could only give both rows one answer, and would
    // therefore have to be wrong about one of them.
    await audit.record(
      {
        kind: "action_executed",
        subtype: "message_sent",
        outcome: "ok",
        flowId: "welcome",
        stepId: "step-1",
      },
      T0,
    );
    await audit.record(
      {
        kind: "action_executed",
        subtype: "comment_reply",
        outcome: "ok",
        flowId: "welcome",
        stepId: "step-1",
      },
      T1,
    );

    const entries = await audit.query({ order: "oldest" });

    expect(entries.map((entry) => entry.subtype)).toEqual([
      "message_sent",
      "comment_reply",
    ]);
  });

  it("hands back the type it was given, on the entry it just wrote", async () => {
    // Read from the write itself, not only from a later query: the value has to
    // be on the record at the instant of the record, which is what a caller
    // holding the returned entry is entitled to assume.
    const entry = await audit.record(
      {
        kind: "action_executed",
        subtype: "pause_started",
        outcome: "ok",
        contactId: "contact-1",
      },
      T0,
    );

    expect(entry.subtype).toBe("pause_started");
  });

  it("groups an entry written before the migration as unknown", async () => {
    insertPreMigrationEntry("event_received", "ok");

    const [entry] = await audit.query();

    // Absent, not null and not invented: the row cannot say what it was, and
    // the only reading that does not lie is that nobody knows.
    expect(entry?.subtype).toBeUndefined();
    expect(subtypeGroupOf(entry ?? {})).toBe(UNKNOWN_SUBTYPE);
  });

  it("reaches those entries by query, so the group is not an in-memory scan", async () => {
    insertPreMigrationEntry("event_received", "ok");
    insertPreMigrationEntry("action_executed", "ok");
    await audit.record(
      { kind: "event_received", subtype: "comment", outcome: "ok" },
      T1,
    );

    const unknown = await audit.query({ subtype: UNKNOWN_SUBTYPE });

    expect(unknown).toHaveLength(2);
    expect(unknown.every((entry) => entry.subtype === undefined)).toBe(true);
  });

  it("aggregates a mixed trail without failing, and the totals add up", async () => {
    // AC 36: the aggregation runs over old rows and new ones together.
    insertPreMigrationEntry("event_received", "ok");
    insertPreMigrationEntry("event_received", "ok");
    await audit.record(
      { kind: "event_received", subtype: "comment", outcome: "ok" },
      T1,
    );
    await audit.record(
      { kind: "event_received", subtype: "comment", outcome: "ok" },
      T1,
    );
    await audit.record(
      { kind: "event_received", subtype: "direct_message", outcome: "ok" },
      T2,
    );

    const entries = await audit.query({ kind: "event_received" });
    const counts = countBySubtype(entries);

    expect(counts.get("comment")).toBe(2);
    expect(counts.get("direct_message")).toBe(1);
    // Visible AS unknown, which is the requirement: not dropped, not folded
    // into one of the real types, and not a reason for the count to throw.
    expect(counts.get(UNKNOWN_SUBTYPE)).toBe(2);
    expect([...counts.values()].reduce((sum, n) => sum + n, 0)).toBe(
      entries.length,
    );
  });

  it("does not match unknown rows when a real type is asked for", async () => {
    // The trap this catches is SQL's own: `subtype = 'unknown'` is never true
    // for a NULL, and neither is `subtype = 'comment'`. A filter that compared
    // the group as a value would return an empty set and look like "there were
    // none" rather than like a broken filter.
    insertPreMigrationEntry("event_received", "ok");

    expect(await audit.query({ subtype: "comment" })).toHaveLength(0);
    expect(await audit.query({ subtype: UNKNOWN_SUBTYPE })).toHaveLength(1);
  });

  it("combines the type with the other filters", async () => {
    await audit.record(
      {
        kind: "action_executed",
        subtype: "message_sent",
        outcome: "ok",
        contactId: "alice",
      },
      T0,
    );
    await audit.record(
      {
        kind: "action_executed",
        subtype: "message_sent",
        outcome: "failed",
        contactId: "alice",
        reason: "platform returned 429",
      },
      T1,
    );

    // Counting messages actually SENT is the pair, never the subtype alone: the
    // subtype says what kind of action it was, the outcome says whether it
    // happened.
    const sent = await audit.query({ subtype: "message_sent", outcome: "ok" });

    expect(sent).toHaveLength(1);
    expect(sent[0]?.occurredAt.toISOString()).toBe(T0.toISOString());
  });
});

/**
 * Proves REQ-162 at the store: the trail keeps the text the event carried and
 * the public identifier of whoever originated it, and says it has neither when
 * it was given neither.
 *
 * The distinction under test is between three states that a careless
 * implementation collapses into one: a value, an empty value, and no value at
 * all. An operator reading "nothing" has to be able to tell "they sent a
 * sticker" from "this row never recorded what they sent".
 */
describe("REQ-162: the entry keeps what the event brought", () => {
  let handle: DatabaseHandle;
  let audit: AuditRepository;

  beforeEach(() => {
    handle = openDatabase({ databasePath: IN_MEMORY_DATABASE });
    audit = createAuditRepository(handle.db);
  });

  afterEach(() => {
    handle.close();
  });

  it("keeps the text and the public identifier it was given", async () => {
    const written = await audit.record(
      {
        kind: "event_received",
        subtype: "comment",
        outcome: "ok",
        contactId: "17841400000000001",
        eventId: "e1",
        eventText: "I want the guide",
        contactUsername: "someone",
      },
      T0,
    );

    // On the record it hands back, and on the record it reads back: a caller
    // holding the returned entry is entitled to the same answer as a caller
    // querying for it later.
    expect(written.eventText).toBe("I want the guide");
    expect(written.contactUsername).toBe("someone");

    const [queried] = await audit.query({ eventId: "e1" });
    expect(queried?.eventText).toBe("I want the guide");
    expect(queried?.contactUsername).toBe("someone");
  });

  it("keeps the identifier beside the contact id, not instead of it", async () => {
    // Two identifiers of the same person, and they are not interchangeable:
    // the id is what every other table joins on, the username is what a human
    // recognises and what its owner can change tomorrow.
    const entry = await audit.record(
      {
        kind: "event_received",
        subtype: "comment",
        outcome: "ok",
        contactId: "17841400000000001",
        eventText: "hi",
        contactUsername: "someone",
      },
      T0,
    );

    expect(entry.contactId).toBe("17841400000000001");
    expect(entry.contactUsername).toBe("someone");
  });

  it("records the absence of an identifier without inventing one", async () => {
    // A direct message: the payload carries a sender id and no username at all.
    const entry = await audit.record(
      {
        kind: "event_received",
        subtype: "direct_message",
        outcome: "ok",
        contactId: "17841400000000001",
        eventId: "e1",
        eventText: "yes",
      },
      T0,
    );

    expect(entry.eventText).toBe("yes");
    expect(entry.contactUsername).toBeUndefined();
    // And not filled in from the id on the way back out either.
    expect((await audit.query({ eventId: "e1" }))[0]?.contactUsername).toBe(
      undefined,
    );
  });

  it("tells an interaction that said nothing from a row that stored nothing", async () => {
    // A sticker, or a button with no label: text the caller deliberately wrote
    // as empty.
    await audit.record(
      {
        kind: "event_received",
        subtype: "direct_message",
        outcome: "ok",
        eventId: "sticker",
        eventText: "",
      },
      T0,
    );
    // A row from a writer that had no text to give: an event this build could
    // not read at all.
    await audit.record(
      {
        kind: "event_received",
        outcome: "suppressed",
        eventId: "unreadable",
        reason: "nothing to dispatch",
      },
      T1,
    );

    const [sticker] = await audit.query({ eventId: "sticker" });
    const [unreadable] = await audit.query({ eventId: "unreadable" });

    // The trap: `entry.eventText ||` anywhere on either side collapses these
    // two into the same answer, and the operator loses the only thing that
    // distinguishes "they sent no words" from "we recorded no words".
    expect(sticker?.eventText).toBe("");
    expect(sticker).toHaveProperty("eventText");
    expect(unreadable?.eventText).toBeUndefined();
    expect(unreadable).not.toHaveProperty("eventText");
  });

  it("groups a row written before the columns existed as having neither", async () => {
    handle.connection
      .prepare(
        `INSERT INTO audit_entries (occurred_at, kind, outcome) VALUES (?, ?, ?)`,
      )
      .run(T0.getTime(), "event_received", "ok");

    const [entry] = await audit.query();

    // Same reading as the subtype above: the row cannot say what it carried,
    // and absent is the only answer that does not lie.
    expect(entry?.eventText).toBeUndefined();
    expect(entry?.contactUsername).toBeUndefined();
  });
});
