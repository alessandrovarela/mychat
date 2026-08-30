import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAssetUsageReader } from "./asset-usage.js";
import { IN_MEMORY_DATABASE, openDatabase } from "./database.js";
import type { DatabaseHandle } from "./database.js";
import { automationAggregates } from "./schema.js";

/**
 * Proves the read REQ-293 rests on: what a deletion is going to break.
 *
 * Rows are written directly, and that is the design under test rather than a
 * shortcut. The reader looks for the key in the stored TEXT, so it keeps
 * answering across a format change: the automation that a new schema refuses is
 * exactly the one whose contacts are holding a link to the file, and a reader
 * built on the repository would throw instead of naming it.
 */

const NOW = new Date("2026-08-19T10:00:00.000Z");
const KEY = "guide~1a2b3c4d.pdf";

let handle: DatabaseHandle;

beforeEach(() => {
  handle = openDatabase({ databasePath: IN_MEMORY_DATABASE });
});

afterEach(() => handle.close());

function seed(
  id: string,
  definition: unknown,
  publicationTarget: string | null = null,
): void {
  handle.db
    .insert(automationAggregates)
    .values({
      id,
      definition:
        typeof definition === "string"
          ? definition
          : JSON.stringify(definition),
      publicationTarget,
      createdAt: NOW,
      updatedAt: NOW,
    })
    .run();
}

function usingAsset(id: string, key: string, state = "active"): unknown {
  return {
    schema_version: 2,
    kind: "automation",
    id,
    state,
    trigger: { type: "comment", match: { keywords: ["guide"] } },
    steps: [
      { id: "message", action: "send_dm", message: { text: "Here it is" } },
      { id: "card", card: { title: "Guide", image: key } },
    ],
  };
}

describe("REQ-293: where a resource is used", () => {
  it("names every automation that carries the key, and nothing else", async () => {
    seed("launch", usingAsset("launch", KEY), "post-1");
    seed("draft", usingAsset("draft", KEY, "draft"));
    seed("unrelated", usingAsset("unrelated", "other~99887766.pdf"), "post-2");

    await expect(createAssetUsageReader(handle.db).read(KEY)).resolves.toEqual([
      { automationId: "draft", enabled: false },
      { automationId: "launch", enabled: true, publicationId: "post-1" },
    ]);
  });

  it("finds the key wherever the format of the day puts it", async () => {
    // Three shapes of the same reference, none of which this reader knows by
    // name: a step field, a destination address built from the key, and a
    // document no validator would accept at all.
    seed("in-a-step", { id: "in-a-step", steps: [{ asset: KEY }] });
    seed("in-an-address", {
      id: "in-an-address",
      buttons: [{ url: `https://cdn.example/assets/${KEY}` }],
    });
    seed("legacy", { steps: [{ action: "send_attachment", asset: KEY }] });

    await expect(
      createAssetUsageReader(handle.db).read(KEY),
    ).resolves.toHaveLength(3);
  });

  it("still answers for a definition that is not even JSON", async () => {
    seed("corrupt", `{"steps":[{"asset":"${KEY}"`);

    await expect(createAssetUsageReader(handle.db).read(KEY)).resolves.toEqual([
      { automationId: "corrupt", enabled: false },
    ]);
  });

  it("reports nothing for a resource nobody refers to", async () => {
    seed("launch", usingAsset("launch", KEY), "post-1");

    await expect(
      createAssetUsageReader(handle.db).read("nobody~00000000.pdf"),
    ).resolves.toEqual([]);
  });
});
