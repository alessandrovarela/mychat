import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAutomationAggregateLifecycle } from "../flows/automations.js";
import type { AutomationAggregateStore } from "../flows/automations.js";
import type { UnifiedAutomation } from "../flows/schema.js";
import { createAutomationAggregateRepository } from "./automation-aggregates.js";
import { IN_MEMORY_DATABASE, openDatabase } from "./database.js";
import type { DatabaseHandle } from "./database.js";
import { createPublicationAutomationCoverageReader } from "./publication-automation-coverage.js";
import {
  automationAggregates,
  automationPendingPublicationBaselines,
} from "./schema.js";

/**
 * REQ-217, against the database that actually enforces it.
 *
 * The rule is that a publication has at most ONE specific automation, draft or
 * active, and the spec asks for it to hold "na persistência/API contra criações
 * concorrentes, não apenas por um controle oculto na interface". Two requests
 * that both read "no automation here yet" and then both write is precisely the
 * case an application-level check cannot close: only a UNIQUE index can, and
 * only if something exercises it.
 *
 * Everything above this layer was proved against doubles: the lifecycle suite
 * runs on an in-memory map with no notion of uniqueness, and the API suite
 * hands the route a `save` that already returns the conflict. Both pass with
 * the index dropped. This file is the one that does not.
 */

const T0 = new Date("2026-08-14T12:00:00.000Z");

function automation(
  id: string,
  target: string,
  state: "draft" | "active" = "active",
): UnifiedAutomation {
  return {
    schema_version: 2,
    kind: "automation",
    id,
    state,
    trigger: {
      type: "comment",
      target,
      match: { keywords: ["guide"], mode: "contains" },
    },
    rules: { once_per_contact: true, first_reply_delay_seconds: 5 },
    steps: [{ id: "reply", action: "reply_comment", text: "Sent" }],
  };
}

function directMessage(id: string): UnifiedAutomation {
  return {
    schema_version: 2,
    kind: "automation",
    id,
    state: "active",
    trigger: {
      type: "direct_message",
      match: { keywords: ["guide"], mode: "contains" },
    },
    rules: { once_per_contact: true, first_reply_delay_seconds: 5 },
    steps: [
      {
        id: "deliver",
        action: "send_dm",
        message: { text: "hi" },
      },
    ],
  };
}

describe("REQ-217: one specific automation per publication, enforced by the database", () => {
  let handle: DatabaseHandle;
  let store: AutomationAggregateStore;

  beforeEach(() => {
    handle = openDatabase({ databasePath: IN_MEMORY_DATABASE });
    store = createAutomationAggregateRepository(handle.db, { now: () => T0 });
  });

  afterEach(() => handle.close());

  it("refuses a second automation on the same publication, naming the target", async () => {
    expect((await store.save(automation("first", "post-1"))).ok).toBe(true);

    const second = await store.save(automation("second", "post-1"));

    expect(second).toMatchObject({
      ok: false,
      conflict: "publication_target_conflict",
      target: "post-1",
    });
  });

  it("leaves no partial row behind when it refuses", async () => {
    await store.save(automation("first", "post-1"));
    await store.save(automation("second", "post-1"));

    const stored = await store.list();
    expect(stored.map((record) => record.definition.id)).toEqual(["first"]);
    // The loser is absent, not present-and-broken: a row written and then
    // rejected would still be read back by the dispatcher.
    expect(await store.findById("second")).toBeUndefined();
  });

  it("holds whatever the two states are, because a draft occupies the publication too", async () => {
    await store.save(automation("first", "post-1", "draft"));

    // Draft then active, which is the pair an interface-level check is most
    // likely to let through: the first one is not even running yet.
    expect(
      await store.save(automation("second", "post-1", "active")),
    ).toMatchObject({ ok: false, conflict: "publication_target_conflict" });

    const other = openDatabase({ databasePath: IN_MEMORY_DATABASE });
    const fresh = createAutomationAggregateRepository(other.db, {
      now: () => T0,
    });
    await fresh.save(automation("first", "post-1", "active"));
    expect(
      await fresh.save(automation("second", "post-1", "draft")),
    ).toMatchObject({ ok: false, conflict: "publication_target_conflict" });
    other.close();
  });

  it("lets an automation keep its own publication when it is edited", async () => {
    await store.save(automation("first", "post-1"));

    // Same id, same target: this is an UPDATE, and colliding with itself would
    // make editing an automation impossible after the first save.
    const again = await store.save(automation("first", "post-1", "draft"));

    expect(again.ok).toBe(true);
    expect((await store.list()).length).toBe(1);
    expect(await store.findById("first")).toMatchObject({
      definition: { state: "draft" },
    });
  });

  /**
   * The other half of REQ-217, and the one that breaks in SILENCE.
   *
   * The index constrains a publication, and a direct message has none: its
   * `publicationTarget` is null, SQLite compares nulls as distinct, and that is
   * the only reason two of them can coexist. This used to be proved with the
   * account-wide comment target beside them; phase 3k removed that target with
   * REQ-218 and the direct message inherits the whole proof, because a target
   * calculation that started answering a constant instead of null would make
   * the SECOND direct-message automation an operator writes fail to save, with
   * a conflict naming a publication neither of them has.
   */
  it("constrains only the publication, so direct-message automations still stack", async () => {
    expect((await store.save(directMessage("dm-one"))).ok).toBe(true);
    expect((await store.save(directMessage("dm-two"))).ok).toBe(true);
    expect((await store.save(directMessage("dm-three"))).ok).toBe(true);
    // And a publication-specific one alongside them, which is the arrangement
    // an account actually operates: one automation per post, plus the
    // account's direct-message automations.
    expect((await store.save(automation("specific", "post-1"))).ok).toBe(true);
    expect((await store.list()).length).toBe(4);
  });

  /**
   * REQ-213 and criterion 2, which is the promise the whole phase was built to
   * make: editing one automation changes no other.
   *
   * Under v1 this could not be promised. A flow was shared, so correcting the
   * message of one publication silently rewrote every automation pointing at
   * that flow, and the competitive analysis named it the model's invisible
   * risk. Under v2 isolation is structural, each aggregate being its own row
   * and its own document, and that is exactly why it deserves a test: a
   * structural guarantee nobody exercises is one refactor away from being a
   * claim again.
   */
  it("changes nothing in the neighbours when one aggregate is edited", async () => {
    await store.save(automation("first", "post-1"));
    await store.save(automation("second", "post-2"));
    await store.save(directMessage("third"));

    const before = await store.list();
    const untouched = before.filter((row) => row.definition.id !== "first");

    const edited = automation("first", "post-1", "draft");
    await store.save({
      ...edited,
      steps: [
        {
          id: "deliver",
          action: "send_dm",
          message: { text: "a different message entirely" },
        },
      ],
    } as UnifiedAutomation);

    const after = await store.list();
    // What the edit changed is the message, which is where an edit shows now:
    // an automation carries no name to rewrite (REQ-279).
    const step = after.find((row) => row.definition.id === "first")?.definition
      .steps?.[0];
    expect(step?.action === "send_dm" && step.message?.text).toBe(
      "a different message entirely",
    );
    // Byte for byte, including the timestamps: an edit that touched a
    // neighbour would show up here even if its content happened to match.
    expect(after.filter((row) => row.definition.id !== "first")).toEqual(
      untouched,
    );
  });

  it("carries the refusal up to the lifecycle the API answers 409 from", async () => {
    // The route's own suite hands it a `save` that already refuses. This is the
    // half that proves the refusal is PRODUCED: a real repository underneath a
    // real lifecycle, with the field renamed from `conflict` to `refusal` on
    // the way, which is the seam where the 409 would quietly stop happening.
    const lifecycle = createAutomationAggregateLifecycle(store);
    await lifecycle.save(automation("first", "post-1"));

    expect(await lifecycle.save(automation("second", "post-1"))).toMatchObject({
      ok: false,
      refusal: "publication_target_conflict",
      target: "post-1",
    });
  });

  it("keeps one pending scope atomically, independently of publication targets", async () => {
    const pending = {
      ...automation("pending-one", "post-ignored"),
      scope: { type: "next_publication" as const },
      trigger: {
        type: "comment" as const,
        match: { keywords: ["guide"], mode: "contains" as const },
      },
    };
    expect((await store.save(pending)).ok).toBe(true);
    expect(await store.save({ ...pending, id: "pending-two" })).toMatchObject({
      ok: false,
      conflict: "next_publication_conflict",
    });
  });

  it("binds the pending automation to a discovered publication before it can be matched", async () => {
    const pending = {
      ...automation("pending-one", "post-ignored"),
      scope: { type: "next_publication" as const },
      trigger: {
        type: "comment" as const,
        match: { keywords: ["guide"], mode: "contains" as const },
      },
    };
    await store.save(pending, []);

    await expect(
      createAutomationAggregateRepository(handle.db, {
        now: () => T0,
      }).bindPendingToPublication("post-new"),
    ).resolves.toMatchObject({
      kind: "bound",
      stored: {
        definition: {
          scope: { type: "publication", publicationId: "post-new" },
          trigger: { target: "post-new" },
        },
      },
    });
  });

  it("leaves the pending automation for a later publication when a manual specific won", async () => {
    const pending = {
      ...automation("pending-one", "post-ignored"),
      scope: { type: "next_publication" as const },
      trigger: {
        type: "comment" as const,
        match: { keywords: ["guide"], mode: "contains" as const },
      },
    };
    await store.save(pending, []);
    await store.save(automation("manual", "post-new"));

    await expect(
      createAutomationAggregateRepository(handle.db, {
        now: () => T0,
      }).bindPendingToPublication("post-new"),
    ).resolves.toEqual({
      kind: "conflict",
      target: "post-new",
    });
    await expect(store.findById("pending-one")).resolves.toMatchObject({
      definition: { scope: { type: "next_publication" } },
    });
  });

  it("keeps the pending automation for a publication in its activation baseline", async () => {
    const pending = {
      ...automation("pending-baseline", "post-ignored"),
      scope: { type: "next_publication" as const },
      trigger: {
        type: "comment" as const,
        match: { keywords: ["guide"], mode: "contains" as const },
      },
    };
    await store.save(pending, ["post-known"]);
    const repository = createAutomationAggregateRepository(handle.db, {
      now: () => T0,
    });

    await expect(
      repository.bindPendingToPublication("post-known"),
    ).resolves.toEqual({
      kind: "no_pending",
    });
    await expect(
      repository.bindPendingToPublication("post-new"),
    ).resolves.toMatchObject({
      kind: "bound",
    });
    expect(
      handle.db.select().from(automationPendingPublicationBaselines).all(),
    ).toEqual([]);
  });

  it("refuses an equivalent global match after folding case, accents and spaces", async () => {
    const global = {
      ...automation("global-one", "post-ignored"),
      scope: { type: "global" as const },
      trigger: {
        type: "comment" as const,
        match: { keywords: ["  CÓDIGO  "], mode: "contains" as const },
      },
    };
    expect((await store.save(global)).ok).toBe(true);
    expect(
      await store.save({
        ...global,
        id: "global-two",
        trigger: {
          type: "comment",
          match: { keywords: ["codigo"], mode: "contains" },
        },
      }),
    ).toMatchObject({
      ok: false,
      conflict: "global_match_conflict",
      automationId: "global-one",
    });
  });
});

/* ------------------------------------------------------------------ *
 * REQ-294: one refused document costs its own row and no other
 * ------------------------------------------------------------------ */

/**
 * A document written by the version BEFORE this one, put in as text.
 *
 * The repository cannot write it, and that is the point: `save` reads the row
 * back through the current schema and refuses it on the way out. This is how
 * these rows come to exist in a real instance anyway, phase 3l having taken
 * `name` out of the format and REQ-284 the attachment, both by decisions that
 * stand. The columns are filled exactly as the older version filled them, from
 * a trigger it still understood.
 */
function storeLegacy(
  handle: DatabaseHandle,
  id: string,
  target: string | null,
): void {
  handle.db
    .insert(automationAggregates)
    .values({
      id,
      definition: JSON.stringify({
        schema_version: 2,
        kind: "automation",
        id,
        state: "active",
        trigger: {
          type: "comment",
          target: target ?? "post-9",
          match: { keywords: ["guide"], mode: "contains" },
        },
        rules: { once_per_contact: false },
        steps: [
          {
            id: "message",
            action: "send_dm",
            message: {
              text: "Here",
              attachments: [{ kind: "document", file: "guide.pdf" }],
            },
          },
        ],
      }),
      publicationTarget: target,
      createdAt: T0,
      updatedAt: T0,
    })
    .run();
}

describe("REQ-294: a refused document does not take the listing with it", () => {
  let handle: DatabaseHandle;
  let store: AutomationAggregateStore;

  beforeEach(() => {
    handle = openDatabase({ databasePath: IN_MEMORY_DATABASE });
    store = createAutomationAggregateRepository(handle.db, { now: () => T0 });
  });

  afterEach(() => handle.close());

  it("lists the automations it CAN read, with an unreadable one in the table", async () => {
    await store.save(automation("readable", "post-1"));
    storeLegacy(handle, "legacy-attachment", "post-2");
    await store.save(automation("also-readable", "post-3"));

    // The listing this route serves used to be all or nothing: one row the
    // schema refuses threw on the way out and the operator got a 500, which is
    // the empty screen by another road.
    expect((await store.list()).map((row) => row.definition.id)).toEqual([
      "also-readable",
      "readable",
    ]);
  });

  it("still counts the refused row, which is what the interface warns from", async () => {
    await store.save(automation("readable", "post-1"));
    storeLegacy(handle, "legacy-attachment", "post-2");

    // The two sides of the same row, asserted in the order the operator
    // produces them: the screen lists first, and the warning is what it reads
    // next. Dropping the row from the listing is only honest while something
    // else still says it exists, so a listing that TIDIED it away, by deleting
    // it or by repairing it into something nobody wrote, would leave the
    // screen right back at a shorter list with nothing said.
    expect((await store.list()).map((row) => row.definition.id)).toEqual([
      "readable",
    ]);
    await expect(
      createPublicationAutomationCoverageReader(handle.db).unreadable(),
    ).resolves.toEqual([{ id: "legacy-attachment", publicationId: "post-2" }]);
  });

  it("answers a lookup by identifier with the refusal, not with absence", async () => {
    storeLegacy(handle, "legacy-attachment", "post-2");

    // Neither of the two answers this is NOT: "there is no such automation"
    // would be a lie about a row that is in the table, and an exception would
    // be the listing's own defect asked one row at a time.
    await expect(store.findById("legacy-attachment")).resolves.toEqual({
      unreadable: true,
      id: "legacy-attachment",
    });
    await expect(store.findById("never-stored")).resolves.toBeUndefined();
  });

  it("lets a complete definition be written over the refused row, as an update", async () => {
    storeLegacy(handle, "legacy-attachment", "post-2");
    const lifecycle = createAutomationAggregateLifecycle(store);

    // Not a compatibility layer and not a migration: nothing here reads the old
    // document or guesses at it. The operator writes a whole new definition
    // under the same identifier, and it lands as the UPDATE it is, because a
    // row that exists and cannot be read is still a row that exists.
    expect(
      await lifecycle.save(automation("legacy-attachment", "post-2")),
    ).toMatchObject({ ok: true, created: false });
    expect((await store.list()).map((row) => row.definition.id)).toEqual([
      "legacy-attachment",
    ]);
    await expect(
      createPublicationAutomationCoverageReader(handle.db).unreadable(),
    ).resolves.toEqual([]);
  });
});
