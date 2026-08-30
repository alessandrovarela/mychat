import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { UnifiedAutomation } from "../flows/schema.js";
import { createAutomationAggregateRepository } from "./automation-aggregates.js";
import { IN_MEMORY_DATABASE, openDatabase } from "./database.js";
import type { DatabaseHandle } from "./database.js";
import { createPublicationAutomationCoverageReader } from "./publication-automation-coverage.js";
import { automationAggregates } from "./schema.js";

function automation(
  id: string,
  target: string,
  state: "active" | "draft",
): UnifiedAutomation {
  const definition = {
    schema_version: 2 as const,
    kind: "automation" as const,
    id,
    state,
    trigger: {
      type: "comment" as const,
      target,
      match: { keywords: ["guide"], mode: "contains" as const },
    },
    rules: { once_per_contact: false },
    steps: [
      {
        id: "message",
        action: "send_dm" as const,
        message: { text: "Here" },
      },
    ],
  };
  return definition as UnifiedAutomation;
}

/** The document phase 3n retired: a delivery that carried a file (REQ-284). */
function withAttachment(id: string, target: string): unknown {
  return {
    schema_version: 2,
    kind: "automation",
    id,
    state: "active",
    trigger: {
      type: "comment",
      target,
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
  };
}

const WHEN = new Date("2026-08-19T12:00:00Z");

/**
 * A row written by the version BEFORE this one, put in as text.
 *
 * The repository cannot be used for it, and the reason is worth the four lines:
 * `save` writes the row and then reads it back through the current schema, so
 * it throws on the way out while the row is already there. That is how these
 * rows come to exist in a real instance, but a test that leaned on it would be
 * asserting the order of two statements inside somebody else's function. The
 * text and the columns are what this reader sees, so the text and the columns
 * are what these cases write: `publication_target` filled exactly as the older
 * version filled it, from a trigger it still understood.
 */
function storeLegacy(definition: unknown, id: string, target: string | null) {
  handle.db
    .insert(automationAggregates)
    .values({
      id,
      definition: JSON.stringify(definition),
      publicationTarget: target,
      createdAt: WHEN,
      updatedAt: WHEN,
    })
    .run();
}

let handle: DatabaseHandle;

beforeEach(() => {
  handle = openDatabase({ databasePath: IN_MEMORY_DATABASE });
});

afterEach(() => handle.close());

describe("REQ-214: publication coverage reads the v2 aggregate", () => {
  it("reports the one active or draft automation each publication owns", async () => {
    const stored = createAutomationAggregateRepository(handle.db);
    await stored.save(automation("first-active", "post-1", "active"));
    await stored.save(automation("second-draft", "post-2", "draft"));
    // A publication outside the page asked for: its automation belongs to
    // nobody on this page and must not be counted into any of them.
    await stored.save(automation("elsewhere", "post-9", "active"));

    await expect(
      createPublicationAutomationCoverageReader(handle.db).read([
        "post-1",
        "post-2",
        "post-3",
      ]),
    ).resolves.toEqual([
      {
        publicationId: "post-1",
        active: 1,
        inactive: 0,
        automations: [{ id: "first-active", enabled: true }],
      },
      {
        publicationId: "post-2",
        active: 0,
        inactive: 1,
        automations: [{ id: "second-draft", enabled: false }],
      },
      {
        publicationId: "post-3",
        active: 0,
        inactive: 0,
        automations: [],
      },
    ]);
  });

  it("never suggests multiple specific automations for one publication", async () => {
    const stored = createAutomationAggregateRepository(handle.db);
    expect(
      (await stored.save(automation("first", "post-1", "active"))).ok,
    ).toBe(true);
    expect(
      (await stored.save(automation("second", "post-1", "draft"))).ok,
    ).toBe(false);

    const [coverage] = await createPublicationAutomationCoverageReader(
      handle.db,
    ).read(["post-1"]);
    expect(coverage?.automations).toHaveLength(1);
  });

  it("does not query storage for an empty page", async () => {
    await expect(
      createPublicationAutomationCoverageReader(handle.db).read([]),
    ).resolves.toEqual([]);
  });
});

/**
 * REQ-294: a stored automation the schema refuses is REPORTED, not dropped.
 *
 * The defect this proves against is history rather than theory. When `name`
 * left the format in phase 3l the rows written under the old shape stopped
 * parsing, this reader answered `[]` for each of them, and the operator opened
 * the screen to a shorter list with nothing said about why. The attachment left
 * the same way (REQ-284), by the same explicit decision, so the same rows are
 * about to stop parsing again. The refusal stays; the silence is what these
 * cases exist to remove.
 */
describe("REQ-294: what cannot be read is named", () => {
  it("names the refused automation and the publication it was stored against", async () => {
    storeLegacy(
      withAttachment("legacy-attachment", "post-1"),
      "legacy-attachment",
      "post-1",
    );

    await expect(
      createPublicationAutomationCoverageReader(handle.db).unreadable(),
    ).resolves.toEqual([{ id: "legacy-attachment", publicationId: "post-1" }]);
  });

  it("reports a row that is not even JSON, which nothing else can read", async () => {
    handle.db
      .insert(automationAggregates)
      .values({
        id: "corrupt",
        definition: "{ not json at all",
        publicationTarget: null,
        createdAt: WHEN,
        updatedAt: WHEN,
      })
      .run();

    await expect(
      createPublicationAutomationCoverageReader(handle.db).unreadable(),
    ).resolves.toEqual([{ id: "corrupt" }]);
  });

  it("keeps covering the publications it CAN read, beside the one it cannot", async () => {
    const stored = createAutomationAggregateRepository(handle.db);
    await stored.save(automation("readable", "post-1", "active"));
    storeLegacy(
      withAttachment("legacy-attachment", "post-2"),
      "legacy-attachment",
      "post-2",
    );

    const reader = createPublicationAutomationCoverageReader(handle.db);

    // The good one is listed exactly as it was before the bad one existed: a
    // document nobody can parse must cost its own row and no other.
    await expect(reader.read(["post-1", "post-2"])).resolves.toEqual([
      {
        publicationId: "post-1",
        active: 1,
        inactive: 0,
        automations: [{ id: "readable", enabled: true }],
      },
      { publicationId: "post-2", active: 0, inactive: 0, automations: [] },
    ]);
    await expect(reader.unreadable()).resolves.toEqual([
      { id: "legacy-attachment", publicationId: "post-2" },
    ]);
  });

  it("reports nothing when every stored automation parses", async () => {
    const stored = createAutomationAggregateRepository(handle.db);
    await stored.save(automation("readable", "post-1", "active"));
    await stored.save(automation("draft", "post-2", "draft"));

    await expect(
      createPublicationAutomationCoverageReader(handle.db).unreadable(),
    ).resolves.toEqual([]);
  });
});
