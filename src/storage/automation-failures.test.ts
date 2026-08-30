import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { IN_MEMORY_DATABASE, openDatabase } from "./database.js";
import type { DatabaseHandle } from "./database.js";
import { createAutomationFailureSequenceStore } from "./automation-failures.js";

describe("REQ-200: persistent definitive failure sequences", () => {
  let handle: DatabaseHandle;

  beforeEach(() => {
    handle = openDatabase({ databasePath: IN_MEMORY_DATABASE });
  });

  afterEach(() => handle.close());

  it("keeps each automation independent and only retains the ten-minute window", async () => {
    const failures = createAutomationFailureSequenceStore(handle.db);
    const first = new Date("2026-08-01T10:00:00.000Z");
    const recent = new Date("2026-08-01T10:10:00.000Z");
    const outside = new Date("2026-08-01T10:10:00.001Z");

    await failures.recordFailure("one", first);
    await failures.recordFailure("two", recent);
    expect(await failures.recordFailure("one", recent)).toHaveLength(2);
    expect(await failures.recordFailure("one", outside)).toEqual([
      recent,
      outside,
    ]);
    expect(await failures.read("two")).toEqual([recent]);
  });

  it("is read by a fresh store and a success resets it", async () => {
    const at = new Date("2026-08-01T10:00:00.000Z");
    await createAutomationFailureSequenceStore(handle.db).recordFailure(
      "launch-post",
      at,
    );

    const afterRestart = createAutomationFailureSequenceStore(handle.db);
    expect(await afterRestart.read("launch-post")).toEqual([at]);
    await afterRestart.reset("launch-post");
    expect(await afterRestart.read("launch-post")).toEqual([]);
  });
});
