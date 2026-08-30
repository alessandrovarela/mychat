import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createButtonClickStore } from "./button-clicks.js";
import type { ButtonClickStore } from "./button-clicks.js";
import { IN_MEMORY_DATABASE, openDatabase } from "./database.js";
import type { DatabaseHandle } from "./database.js";

const T0 = new Date("2026-08-14T12:00:00.000Z");
const T1 = new Date("2026-08-14T13:00:00.000Z");

/** Records `times` clicks on each button, through its persisted destination. */
async function clickThrough(
  store: ButtonClickStore,
  clicks: readonly (readonly [string, string, number])[],
): Promise<void> {
  for (const [automationId, buttonId, times] of clicks) {
    const destination = await store.destinationFor(
      automationId,
      buttonId,
      `https://example.com/${automationId}/${buttonId}`,
      T0,
    );
    for (let index = 0; index < times; index += 1) {
      await store.record({
        occurredAt: T1,
        automationId,
        buttonId,
        destinationId: destination.id,
        destinationVersion: destination.version,
        contactId: `c${String(index)}`,
        executionId: `${automationId}:${buttonId}:${String(index)}`,
      });
    }
  }
}

describe("REQ-220/REQ-222: versioned button destinations and metrics", () => {
  let handle: DatabaseHandle;
  let store: ButtonClickStore;

  beforeEach(() => {
    handle = openDatabase({ databasePath: IN_MEMORY_DATABASE });
    store = createButtonClickStore(handle.db);
  });

  afterEach(() => handle.close());

  it("keeps the destination version on a label-only resend and appends a URL edit", async () => {
    const first = await store.destinationFor(
      "launch",
      "download",
      "https://example.com/first",
      T0,
    );
    const same = await store.destinationFor(
      "launch",
      "download",
      "https://example.com/first",
      T1,
    );
    const edited = await store.destinationFor(
      "launch",
      "download",
      "https://example.com/second",
      T1,
    );

    expect(same).toEqual(first);
    expect(edited).toMatchObject({ version: 2, buttonId: "download" });
    expect((await store.findDestination(first.id))?.url).toBe(
      "https://example.com/first",
    );
  });

  it("captures the label shown at delivery and on every new click", async () => {
    const first = await store.destinationFor(
      "launch",
      "download",
      "https://example.com/guide",
      T0,
      "Get the guide",
    );
    const renamed = await store.destinationFor(
      "launch",
      "download",
      "https://example.com/guide",
      T1,
      "Download now",
    );

    expect(first).toMatchObject({ version: 1, label: "Get the guide" });
    expect(renamed).toMatchObject({ version: 2, label: "Download now" });

    await store.record({
      occurredAt: T1,
      automationId: first.automationId,
      buttonId: first.buttonId,
      destinationId: first.id,
      destinationVersion: first.version,
      contactId: "contact-1",
      executionId: "launch:contact-1:run",
      buttonLabel: first.label,
    });

    expect(await store.samples(T0, T1)).toEqual([
      expect.objectContaining({ buttonLabel: "Get the guide" }),
    ]);
  });

  it("consolidates destination versions under the stable button id", async () => {
    const v1 = await store.destinationFor(
      "launch",
      "download",
      "https://example.com/v1",
      T0,
    );
    const v2 = await store.destinationFor(
      "launch",
      "download",
      "https://example.com/v2",
      T1,
    );
    const more = await store.destinationFor(
      "launch",
      "more",
      "https://example.com/more",
      T1,
    );

    for (const [destination, contactId] of [
      [v1, "c1"],
      [v2, "c2"],
      [more, "c3"],
    ] as const) {
      await store.record({
        occurredAt: T1,
        automationId: destination.automationId,
        buttonId: destination.buttonId,
        destinationId: destination.id,
        destinationVersion: destination.version,
        contactId,
        executionId: `launch:${contactId}:run`,
      });
    }

    expect(await store.metrics("launch")).toEqual({
      automationId: "launch",
      total: 3,
      buttons: [
        { buttonId: "download", total: 2 },
        { buttonId: "more", total: 1 },
      ],
    });
  });

  it("keeps the execution identity that links a click to immutable trail attribution", async () => {
    const destination = await store.destinationFor(
      "launch",
      "download",
      "https://example.com/guide",
      T0,
    );

    await store.record({
      occurredAt: T1,
      automationId: destination.automationId,
      buttonId: destination.buttonId,
      destinationId: destination.id,
      destinationVersion: destination.version,
      contactId: "contact-1",
      executionId: "launch:contact-1:run",
    });

    const row = handle.connection
      .prepare("SELECT execution_id FROM button_clicks")
      .get() as { execution_id: string };

    expect(row.execution_id).toBe("launch:contact-1:run");
  });

  it("counts a whole listing in one read, keeping every automation's buttons its own", async () => {
    await clickThrough(store, [
      ["launch", "download", 2],
      ["launch", "more", 1],
      ["webinar", "download", 3],
    ]);

    const measured = await store.metricsForAutomations([
      "launch",
      "webinar",
      "quiet",
      "launch",
    ]);

    expect(measured.get("launch")).toEqual({
      automationId: "launch",
      total: 3,
      buttons: [
        { buttonId: "download", total: 2 },
        { buttonId: "more", total: 1 },
      ],
    });
    // The same button identifier under another automation is another button:
    // grouping by the button alone would hand "launch" the webinar's three.
    expect(measured.get("webinar")).toEqual({
      automationId: "webinar",
      total: 3,
      buttons: [{ buttonId: "download", total: 3 }],
    });
    // Measured zero, not absent: nobody clicked, and that is an answer.
    expect(measured.get("quiet")).toEqual({
      automationId: "quiet",
      total: 0,
      buttons: [],
    });
    // Asked twice, counted once.
    expect(measured.size).toBe(3);
  });

  it("agrees with the single read, and answers nothing when nothing is asked", async () => {
    await clickThrough(store, [
      ["launch", "download", 2],
      ["webinar", "signup", 1],
    ]);

    for (const automationId of ["launch", "webinar"]) {
      expect(
        (await store.metricsForAutomations([automationId])).get(automationId),
      ).toEqual(await store.metrics(automationId));
    }
    expect((await store.metricsForAutomations([])).size).toBe(0);
  });

  it("refuses a non-HTTP destination before persistence", async () => {
    await expect(
      store.destinationFor("launch", "bad", "javascript:alert(1)", T0),
    ).rejects.toThrow("HTTP");
    expect(await store.metrics("launch")).toMatchObject({ total: 0 });
  });
});
