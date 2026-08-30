import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LIMIT_DEFAULTS } from "../config/limits.js";
import {
  createDurableWorkStore,
  IN_MEMORY_DATABASE,
  openDatabase,
} from "../storage/index.js";
import type { DatabaseHandle, DurableWorkStore } from "../storage/index.js";
import { decideRate, readRateCounts } from "./rate.js";
import type { RateCounts, RateLimits } from "./rate.js";

/**
 * Proves the first half of REQ-017: reaching a cap DEFERS, it never discards.
 *
 * The caps enforced here are only the ones that can be computed locally — the
 * hourly private-reply ceiling and the per-second quotas. The platform's
 * general quota is a moving 24-hour window derived from the account's
 * impressions; pretending to compute it would be a number invented in code,
 * which is exactly what REQ-079 exists to prevent.
 */

const NOW = new Date("2026-08-01T10:30:00.000Z");

const limits: RateLimits = {
  privateRepliesPerHour: LIMIT_DEFAULTS.privateRepliesPerHour,
  callsPerSecond: LIMIT_DEFAULTS.callsPerSecond,
  mediaCallsPerSecond: LIMIT_DEFAULTS.mediaCallsPerSecond,
};

function counts(overrides: Partial<RateCounts> = {}): RateCounts {
  return {
    privateRepliesLastHour: 0,
    callsThisSecond: 0,
    mediaCallsThisSecond: 0,
    ...overrides,
  };
}

describe("REQ-017: the hourly private-reply ceiling", () => {
  it("allows a send below the ceiling", () => {
    expect(
      decideRate(
        "private_reply",
        counts({ privateRepliesLastHour: limits.privateRepliesPerHour - 1 }),
        limits,
        NOW,
      ),
    ).toEqual({ allowed: true });
  });

  it("defers at the ceiling, naming the cap", () => {
    const verdict = decideRate(
      "private_reply",
      counts({ privateRepliesLastHour: limits.privateRepliesPerHour }),
      limits,
      NOW,
    );

    expect(verdict.allowed).toBe(false);
    if (verdict.allowed) return;
    expect(verdict.cap).toBe("private_replies_per_hour");
  });

  it("defers to the instant the window frees up, not a whole hour later", () => {
    // The oldest counted reply is 59 minutes old, so the window opens in one
    // minute. Waiting an hour would idle the queue for 59 minutes it never
    // needed to wait.
    const oldest = new Date(NOW.getTime() - 59 * 60 * 1000);
    const verdict = decideRate(
      "private_reply",
      counts({
        privateRepliesLastHour: limits.privateRepliesPerHour,
        oldestPrivateReply: oldest,
      }),
      limits,
      NOW,
    );

    if (verdict.allowed) throw new Error("expected a deferral");
    expect(verdict.retryAt).toEqual(new Date(NOW.getTime() + 60 * 1000));
  });

  it("does not apply the hourly ceiling to an ordinary direct message", () => {
    // There is no official hourly cap on ordinary messages. Inventing one here
    // would throttle the account against a number nobody published.
    expect(
      decideRate(
        "direct_message",
        counts({ privateRepliesLastHour: limits.privateRepliesPerHour * 2 }),
        limits,
        NOW,
      ),
    ).toEqual({ allowed: true });
  });
});

describe("REQ-017: the per-second quotas", () => {
  it("defers to the start of the next second when the general quota is full", () => {
    const at = new Date("2026-08-01T10:30:00.400Z");
    const verdict = decideRate(
      "direct_message",
      counts({ callsThisSecond: limits.callsPerSecond }),
      limits,
      at,
    );

    if (verdict.allowed) throw new Error("expected a deferral");
    expect(verdict.cap).toBe("calls_per_second");
    expect(verdict.retryAt).toEqual(new Date("2026-08-01T10:30:01.000Z"));
  });

  it("holds media to its own, tighter quota", () => {
    const verdict = decideRate(
      "media",
      counts({
        callsThisSecond: limits.mediaCallsPerSecond,
        mediaCallsThisSecond: limits.mediaCallsPerSecond,
      }),
      limits,
      NOW,
    );

    if (verdict.allowed) throw new Error("expected a deferral");
    expect(verdict.cap).toBe("media_calls_per_second");
  });

  it("counts media against the general quota too, not instead of it", () => {
    // The tighter ceiling is additional. A media send that fits its own quota
    // still consumes a call.
    const verdict = decideRate(
      "media",
      counts({
        callsThisSecond: limits.callsPerSecond,
        mediaCallsThisSecond: 1,
      }),
      limits,
      NOW,
    );

    if (verdict.allowed) throw new Error("expected a deferral");
    expect(verdict.cap).toBe("calls_per_second");
  });

  it("lets a text send through while media is exhausted", () => {
    expect(
      decideRate(
        "direct_message",
        counts({
          callsThisSecond: 1,
          mediaCallsThisSecond: limits.mediaCallsPerSecond,
        }),
        limits,
        NOW,
      ),
    ).toEqual({ allowed: true });
  });
});

describe("REQ-017: the counts come from work actually concluded", () => {
  let handle: DatabaseHandle;
  let work: DurableWorkStore;

  beforeEach(() => {
    handle = openDatabase({ databasePath: IN_MEMORY_DATABASE });
    work = createDurableWorkStore(handle.db);
  });

  afterEach(() => {
    handle.close();
  });

  async function conclude(
    key: string,
    sendClass: "private_reply" | "direct_message" | "media",
    at: Date,
  ): Promise<void> {
    const { item } = await work.enqueue(
      { kind: "send", dedupeKey: key, payload: {}, sendClass },
      at,
    );
    await work.complete(item.id, at);
  }

  it("counts a concluded send and ignores one still pending", async () => {
    await conclude("done-1", "private_reply", NOW);
    await work.enqueue(
      {
        kind: "send",
        dedupeKey: "pending-1",
        payload: {},
        sendClass: "private_reply",
      },
      NOW,
    );

    expect(await readRateCounts(work, NOW)).toMatchObject({
      privateRepliesLastHour: 1,
    });
  });

  it("ignores a send the platform refused", async () => {
    // A refused send consumed no quota. Counting it would throttle the account
    // for work it never did.
    const { item } = await work.enqueue(
      {
        kind: "send",
        dedupeKey: "failed-1",
        payload: {},
        sendClass: "private_reply",
      },
      NOW,
    );
    await work.fail(item.id, "refused", NOW);

    expect(await readRateCounts(work, NOW)).toMatchObject({
      privateRepliesLastHour: 0,
    });
  });

  it("drops a send out of the window once an hour has passed", async () => {
    const longAgo = new Date(NOW.getTime() - 61 * 60 * 1000);
    await conclude("old", "private_reply", longAgo);
    await conclude("recent", "private_reply", NOW);

    const gathered = await readRateCounts(work, NOW);

    expect(gathered.privateRepliesLastHour).toBe(1);
    expect(gathered.oldestPrivateReply).toEqual(NOW);
  });

  it("sums every class into the per-second count", async () => {
    await conclude("a", "private_reply", NOW);
    await conclude("b", "direct_message", NOW);
    await conclude("c", "media", NOW);

    expect(await readRateCounts(work, NOW)).toMatchObject({
      callsThisSecond: 3,
      mediaCallsThisSecond: 1,
    });
  });

  it("starts the per-second count fresh on the next second", async () => {
    await conclude("a", "direct_message", new Date("2026-08-01T10:30:00.900Z"));

    const sameSecond = await readRateCounts(
      work,
      new Date("2026-08-01T10:30:00.950Z"),
    );
    const nextSecond = await readRateCounts(
      work,
      new Date("2026-08-01T10:30:01.010Z"),
    );

    expect(sameSecond.callsThisSecond).toBe(1);
    expect(nextSecond.callsThisSecond).toBe(0);
  });
});
