import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { IN_MEMORY_DATABASE, openDatabase } from "./database.js";
import type { DatabaseHandle } from "./database.js";
import { createDurableWorkStore } from "./durable-work.js";
import type { DurableWorkStore } from "./durable-work.js";

/**
 * Proves REQ-016 at the storage layer: pending work survives the process, and
 * concluded work is never done twice.
 *
 * "Survives the process" is tested the only honest way — against a real file,
 * closing the handle and opening a new one. An in-memory database that is never
 * closed proves nothing about a restart, and this is the requirement where the
 * difference is the whole point.
 */

const T0 = new Date("2026-08-01T10:00:00.000Z");
const T1 = new Date("2026-08-01T10:00:05.000Z");
const T2 = new Date("2026-08-01T10:01:00.000Z");

describe("durable work store", () => {
  let handle: DatabaseHandle;
  let work: DurableWorkStore;

  beforeEach(() => {
    handle = openDatabase({ databasePath: IN_MEMORY_DATABASE });
    work = createDurableWorkStore(handle.db);
  });

  afterEach(() => {
    handle.close();
  });

  it("enqueues work due now and hands it back to the sweep", async () => {
    await work.enqueue(
      { kind: "send", dedupeKey: "send-1", payload: { text: "hello" } },
      T0,
    );

    const due = await work.due(T0);

    expect(due).toHaveLength(1);
    expect(due[0]?.kind).toBe("send");
    expect(due[0]?.payload).toEqual({ text: "hello" });
    expect(due[0]?.attempts).toBe(0);
  });

  it("withholds work whose instant has not arrived", async () => {
    await work.enqueue(
      { kind: "send", dedupeKey: "send-1", payload: {}, dueAt: T2 },
      T0,
    );

    expect(await work.due(T1)).toHaveLength(0);
    expect(await work.due(T2)).toHaveLength(1);
  });

  it("treats the same dedupe key as the same work, not as an error", async () => {
    const first = await work.enqueue(
      { kind: "send", dedupeKey: "send-1", payload: { text: "a" } },
      T0,
    );
    const second = await work.enqueue(
      { kind: "send", dedupeKey: "send-1", payload: { text: "b" } },
      T1,
    );

    expect(first.enqueued).toBe(true);
    expect(second.enqueued).toBe(false);
    // The stored work is the FIRST one: a repeat offer never rewrites what is
    // already queued, or a redelivered event could change a pending message.
    expect(second.item.payload).toEqual({ text: "a" });
    expect(await work.due(T1)).toHaveLength(1);
  });

  it("stops collecting work once it is concluded", async () => {
    const { item } = await work.enqueue(
      { kind: "send", dedupeKey: "send-1", payload: {} },
      T0,
    );

    await work.complete(item.id, T1);

    expect(await work.due(T2)).toHaveLength(0);
    expect((await work.find(item.id))?.status).toBe("done");
  });

  it("stops collecting work that gave up, and keeps the reason", async () => {
    const { item } = await work.enqueue(
      { kind: "send", dedupeKey: "send-1", payload: {} },
      T0,
    );

    await work.fail(item.id, "retry budget exhausted", T1);
    const stored = await work.find(item.id);

    expect(await work.due(T2)).toHaveLength(0);
    expect(stored?.status).toBe("failed");
    expect(stored?.lastReason).toBe("retry budget exhausted");
    expect(stored?.attempts).toBe(1);
  });

  it("returns deferred work only after the new instant, counting the attempt", async () => {
    const { item } = await work.enqueue(
      { kind: "send", dedupeKey: "send-1", payload: {} },
      T0,
    );

    await work.defer(item.id, T2, T1, "hourly cap reached");

    expect(await work.due(T1)).toHaveLength(0);
    const [returned] = await work.due(T2);
    expect(returned?.attempts).toBe(1);
    expect(returned?.lastReason).toBe("hourly cap reached");
  });

  it("REQ-337: deferring concluded work leaves it concluded, instead of resurrecting it", async () => {
    const { item } = await work.enqueue(
      { kind: "suspension", dedupeKey: "wait-1", payload: {} },
      T0,
    );
    await work.complete(item.id, T1);

    await work.defer(item.id, T2, T1, "an attempt spent too late");

    const stored = await work.find(item.id);
    expect(stored?.status).toBe("done");
    expect(stored?.attempts).toBe(0);
    expect(stored?.lastReason).toBeNull();
    expect(await work.due(T2)).toHaveLength(0);
  });

  it("hands due work back oldest first", async () => {
    await work.enqueue(
      { kind: "send", dedupeKey: "later", payload: {}, dueAt: T1 },
      T0,
    );
    await work.enqueue(
      { kind: "send", dedupeKey: "earlier", payload: {}, dueAt: T0 },
      T0,
    );

    const due = await work.due(T2);

    expect(due.map((entry) => entry.dedupeKey)).toEqual(["earlier", "later"]);
  });

  it("counts only pending work", async () => {
    const { item } = await work.enqueue(
      { kind: "send", dedupeKey: "a", payload: {} },
      T0,
    );
    await work.enqueue({ kind: "send", dedupeKey: "b", payload: {} }, T0);
    await work.complete(item.id, T1);

    expect(await work.countPending()).toBe(1);
  });

  it("carries the contact and execution a piece of work belongs to", async () => {
    await work.enqueue(
      {
        kind: "suspension",
        dedupeKey: "exec-1:confirm",
        payload: { stepId: "confirm" },
        contactId: "contact-1",
        executionId: "exec-1",
      },
      T0,
    );

    const [item] = await work.due(T0);

    expect(item?.contactId).toBe("contact-1");
    expect(item?.executionId).toBe("exec-1");
  });

  it("REQ-347: retiring an execution leaves other pending sends alone", async () => {
    const { item: stale } = await work.enqueue(
      {
        kind: "send",
        dedupeKey: "exec-1:ask",
        payload: {},
        executionId: "exec-1",
      },
      T0,
    );
    const { item: other } = await work.enqueue(
      {
        kind: "send",
        dedupeKey: "exec-2:answer",
        payload: {},
        executionId: "exec-2",
      },
      T0,
    );

    await work.retirePendingSends("exec-1", T1);

    expect((await work.find(stale.id))?.status).toBe("done");
    expect((await work.find(other.id))?.status).toBe("pending");
    expect(await work.due(T1)).toEqual([
      expect.objectContaining({ id: other.id }),
    ]);
  });
});

describe("REQ-016: pending work survives the process", () => {
  let directory: string;
  let databasePath: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "mychat-durable-"));
    databasePath = join(directory, "mychat.db");
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  it("delivers work enqueued before a restart, exactly once", async () => {
    const before = openDatabase({ databasePath });
    await createDurableWorkStore(before.db).enqueue(
      { kind: "send", dedupeKey: "send-1", payload: { text: "hello" } },
      T0,
    );
    // The restart. Everything the process held in memory is gone from here on.
    before.close();

    const after = openDatabase({ databasePath });
    const work = createDurableWorkStore(after.db);
    const due = await work.due(T1);

    expect(due).toHaveLength(1);
    expect(due[0]?.payload).toEqual({ text: "hello" });

    await work.complete(due[0]!.id, T1);
    expect(await work.due(T2)).toHaveLength(0);
    after.close();
  });

  it("does not deliver again work that was already concluded", async () => {
    const before = openDatabase({ databasePath });
    const first = createDurableWorkStore(before.db);
    const { item } = await first.enqueue(
      { kind: "send", dedupeKey: "send-1", payload: {} },
      T0,
    );
    await first.complete(item.id, T0);
    before.close();

    const after = openDatabase({ databasePath });

    expect(await createDurableWorkStore(after.db).due(T2)).toHaveLength(0);
    after.close();
  });

  it("keeps a deferral's future instant across a restart", async () => {
    const before = openDatabase({ databasePath });
    const first = createDurableWorkStore(before.db);
    const { item } = await first.enqueue(
      { kind: "send", dedupeKey: "send-1", payload: {} },
      T0,
    );
    await first.defer(item.id, T2, T0, "hourly cap reached");
    before.close();

    const after = openDatabase({ databasePath });
    const work = createDurableWorkStore(after.db);

    // A restart is not a reason to send early: the cap that caused the deferral
    // did not reset because the process did.
    expect(await work.due(T1)).toHaveLength(0);
    expect(await work.due(T2)).toHaveLength(1);
    after.close();
  });
});
