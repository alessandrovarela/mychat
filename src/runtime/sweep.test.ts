import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Clock } from "../engine/ports.js";
import { IN_MEMORY_DATABASE, openDatabase } from "../storage/index.js";
import type { DatabaseHandle, DurableWorkStore } from "../storage/index.js";
import { createDurableWorkStore } from "../storage/index.js";
import { runSweep } from "./sweep.js";
import type { SweepOutcome } from "./sweep.js";

/**
 * Proves REQ-016 end to end: work enqueued before a restart is DELIVERED after
 * it, exactly once, by the sweep rather than by a caller that happened to still
 * be in memory.
 *
 * Time is injected everywhere. No test here waits, which is the only reason a
 * deferral to a future instant can be asserted at all.
 */

const T0 = new Date("2026-08-01T10:00:00.000Z");
const T1 = new Date("2026-08-01T10:00:05.000Z");
const T2 = new Date("2026-08-01T10:01:00.000Z");

/** A clock a test moves by hand. */
function fixedClock(at: Date): Clock & { set(next: Date): void } {
  let now = at;
  return {
    now: () => now,
    set(next: Date) {
      now = next;
    },
  };
}

describe("periodic sweep", () => {
  let handle: DatabaseHandle;
  let work: DurableWorkStore;

  beforeEach(() => {
    handle = openDatabase({ databasePath: IN_MEMORY_DATABASE });
    work = createDurableWorkStore(handle.db);
  });

  afterEach(() => {
    handle.close();
  });

  it("hands due work to the handler registered for its kind", async () => {
    await work.enqueue(
      { kind: "send", dedupeKey: "send-1", payload: { text: "hello" } },
      T0,
    );
    const seen: unknown[] = [];

    const report = await runSweep({
      work,
      clock: fixedClock(T1),
      handlers: {
        send: (item) => {
          seen.push(item.payload);
          return Promise.resolve<SweepOutcome>({ kind: "done" });
        },
      },
    });

    expect(seen).toEqual([{ text: "hello" }]);
    expect(report).toMatchObject({ examined: 1, completed: 1 });
  });

  it("never hands the same concluded work over twice", async () => {
    await work.enqueue({ kind: "send", dedupeKey: "send-1", payload: {} }, T0);
    let calls = 0;
    const deps = {
      work,
      clock: fixedClock(T1),
      handlers: {
        send: () => {
          calls += 1;
          return Promise.resolve<SweepOutcome>({ kind: "done" });
        },
      },
    };

    await runSweep(deps);
    await runSweep(deps);
    await runSweep(deps);

    expect(calls).toBe(1);
  });

  it("leaves untouched work whose instant has not come", async () => {
    await work.enqueue(
      { kind: "send", dedupeKey: "send-1", payload: {}, dueAt: T2 },
      T0,
    );
    let calls = 0;
    const handlers = {
      send: () => {
        calls += 1;
        return Promise.resolve<SweepOutcome>({ kind: "done" });
      },
    };

    await runSweep({ work, clock: fixedClock(T1), handlers });
    expect(calls).toBe(0);

    await runSweep({ work, clock: fixedClock(T2), handlers });
    expect(calls).toBe(1);
  });

  it("returns deferred work on a later pass, not on this one", async () => {
    await work.enqueue({ kind: "send", dedupeKey: "send-1", payload: {} }, T0);
    const attempts: number[] = [];
    const handlers = {
      send: (item: { attempts: number }) => {
        attempts.push(item.attempts);
        return Promise.resolve<SweepOutcome>(
          attempts.length === 1
            ? { kind: "defer", dueAt: T2, reason: "hourly cap reached" }
            : { kind: "done" },
        );
      },
    };

    await runSweep({ work, clock: fixedClock(T0), handlers });
    await runSweep({ work, clock: fixedClock(T1), handlers });
    await runSweep({ work, clock: fixedClock(T2), handlers });

    // Two calls, not three: the middle pass came before the deferred instant.
    expect(attempts).toEqual([0, 1]);
  });

  it("marks work failed when the handler gives up, keeping the reason", async () => {
    const { item } = await work.enqueue(
      { kind: "send", dedupeKey: "send-1", payload: {} },
      T0,
    );

    const report = await runSweep({
      work,
      clock: fixedClock(T1),
      handlers: {
        send: () =>
          Promise.resolve<SweepOutcome>({
            kind: "failed",
            reason: "outside the delivery window",
          }),
      },
    });

    expect(report.failed).toBe(1);
    expect((await work.find(item.id))?.lastReason).toBe(
      "outside the delivery window",
    );
  });

  it("survives a handler that throws, and does not lose the rest of the pass", async () => {
    await work.enqueue({ kind: "send", dedupeKey: "a", payload: {} }, T0);
    await work.enqueue({ kind: "send", dedupeKey: "b", payload: {} }, T0);
    const delivered: string[] = [];

    const report = await runSweep({
      work,
      clock: fixedClock(T1),
      handlers: {
        send: (item) => {
          if (item.dedupeKey === "a") {
            throw new Error("adapter exploded");
          }
          delivered.push(item.dedupeKey);
          return Promise.resolve<SweepOutcome>({ kind: "done" });
        },
      },
    });

    // The second contact's delivery is innocent of the first one's failure.
    expect(delivered).toEqual(["b"]);
    expect(report).toMatchObject({ failed: 1, completed: 1 });
    expect((await work.findByKey("a"))?.lastReason).toBe("adapter exploded");
  });

  it("reports a kind nobody handles instead of silently dropping it", async () => {
    await work.enqueue(
      { kind: "suspension", dedupeKey: "exec-1", payload: {} },
      T0,
    );

    const report = await runSweep({
      work,
      clock: fixedClock(T1),
      handlers: {},
    });

    expect(report.unhandled).toEqual(["suspension"]);
    // Still pending: unhandled is a wiring mistake, and losing the work would
    // hide it exactly when the operator needs to see it.
    expect(await work.countPending()).toBe(1);
  });

  it("honours the batch size so a backlog cannot starve the loop", async () => {
    for (const key of ["a", "b", "c"]) {
      await work.enqueue({ kind: "send", dedupeKey: key, payload: {} }, T0);
    }

    const report = await runSweep({
      work,
      clock: fixedClock(T1),
      batchSize: 2,
      handlers: {
        send: () => Promise.resolve<SweepOutcome>({ kind: "done" }),
      },
    });

    expect(report.examined).toBe(2);
    expect(await work.countPending()).toBe(1);
  });
});

describe("REQ-016: the sweep delivers what the restart interrupted", () => {
  let directory: string;
  let databasePath: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "mychat-sweep-"));
    databasePath = join(directory, "mychat.db");
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  it("delivers a send enqueued by a process that no longer exists", async () => {
    const before = openDatabase({ databasePath });
    await createDurableWorkStore(before.db).enqueue(
      { kind: "send", dedupeKey: "send-1", payload: { text: "hello" } },
      T0,
    );
    before.close();

    const after = openDatabase({ databasePath });
    const work = createDurableWorkStore(after.db);
    const delivered: unknown[] = [];
    const deps = {
      work,
      clock: fixedClock(T1),
      handlers: {
        send: (item: { payload: unknown }) => {
          delivered.push(item.payload);
          return Promise.resolve<SweepOutcome>({ kind: "done" });
        },
      },
    };

    await runSweep(deps);
    // A second pass in the SAME restarted process: still once.
    await runSweep(deps);

    expect(delivered).toEqual([{ text: "hello" }]);
    after.close();
  });

  it("does not re-deliver a send the previous process had concluded", async () => {
    const before = openDatabase({ databasePath });
    const first = createDurableWorkStore(before.db);
    const { item } = await first.enqueue(
      { kind: "send", dedupeKey: "send-1", payload: {} },
      T0,
    );
    await first.complete(item.id, T0);
    before.close();

    const after = openDatabase({ databasePath });
    let calls = 0;

    await runSweep({
      work: createDurableWorkStore(after.db),
      clock: fixedClock(T2),
      handlers: {
        send: () => {
          calls += 1;
          return Promise.resolve<SweepOutcome>({ kind: "done" });
        },
      },
    });

    expect(calls).toBe(0);
    after.close();
  });
});
