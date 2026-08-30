import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Clock } from "../engine/ports.js";
import { t } from "../i18n/index.js";
import {
  createAuditRepository,
  createDurableWorkStore,
  IN_MEMORY_DATABASE,
  openDatabase,
} from "../storage/index.js";
import type {
  AuditRepository,
  DatabaseHandle,
  DurableWorkStore,
} from "../storage/index.js";
import { withSendPolicy } from "./policy.js";
import type { SendAttempt, SendPolicyDeps } from "./policy.js";
import { runSweep } from "./sweep.js";

/**
 * Proves REQ-017 and REQ-018 where they meet the queue: a cap defers without
 * discarding, a refusal comes back with a growing interval, and an exhausted
 * budget fails with the reason recorded.
 *
 * Driven through `runSweep` rather than by calling the wrapper directly,
 * because what the requirement claims is about the QUEUE — that nothing is
 * dropped and that the work returns — and only the sweep can show that.
 */

const T0 = new Date("2026-08-01T10:00:00.000Z");

function movableClock(at: Date): Clock & { set(next: Date): void } {
  let now = at;
  return {
    now: () => now,
    set(next: Date) {
      now = next;
    },
  };
}

describe("send policy over the queue", () => {
  let handle: DatabaseHandle;
  let work: DurableWorkStore;
  let audit: AuditRepository;
  let clock: ReturnType<typeof movableClock>;

  beforeEach(() => {
    handle = openDatabase({ databasePath: IN_MEMORY_DATABASE });
    work = createDurableWorkStore(handle.db);
    audit = createAuditRepository(handle.db);
    clock = movableClock(T0);
  });

  afterEach(() => {
    handle.close();
  });

  function deps(overrides: Partial<SendPolicyDeps> = {}): SendPolicyDeps {
    return {
      work,
      clock,
      audit,
      limits: {
        privateRepliesPerHour: 2,
        callsPerSecond: 100,
        mediaCallsPerSecond: 10,
        retryAttempts: 3,
        retryBaseMs: 1000,
      },
      // Fixed jitter: the deferral lands on an instant the test can name.
      jitter: () => 1,
      ...overrides,
    };
  }

  async function queue(
    key: string,
    at: Date = T0,
    payload: unknown = {},
  ): Promise<number> {
    const { item } = await work.enqueue(
      {
        kind: "send",
        dedupeKey: key,
        payload,
        sendClass: "private_reply",
      },
      at,
    );
    return item.id;
  }

  async function sweepWith(
    attempt: () => Promise<SendAttempt>,
    overrides: Partial<SendPolicyDeps> = {},
  ): Promise<void> {
    await runSweep({
      work,
      clock,
      handlers: { send: withSendPolicy(attempt, deps(overrides)) },
    });
  }

  it("concludes a send the platform accepted", async () => {
    const id = await queue("send-1");

    await sweepWith(() => Promise.resolve({ kind: "sent" }));

    expect((await work.find(id))?.status).toBe("done");
  });

  describe("REQ-200: only definitive attributable outcomes count", () => {
    async function attributed(key: string): Promise<number> {
      const { item } = await work.enqueue(
        {
          kind: "send",
          dedupeKey: key,
          payload: {},
          executionId: "launch-post:contact-1:run",
          sendClass: "private_reply",
        },
        clock.now(),
      );
      return item.id;
    }

    it("reports one failure only after transient retries are exhausted", async () => {
      const id = await attributed("attributed-transient");
      const failures: string[] = [];
      const conclusions = {
        succeeded: () => Promise.resolve(),
        failed: (_automationId: string, reason: string) => {
          failures.push(reason);
          return Promise.resolve();
        },
      };

      for (let pass = 0; pass < 4; pass += 1) {
        const current = await work.find(id);
        if (current?.status !== "pending") break;
        clock.set(current.dueAt);
        await sweepWith(
          () => Promise.resolve({ kind: "transient", reason: "network" }),
          { conclusions },
        );
        if (current.attempts < 2) expect(failures).toEqual([]);
      }

      expect(failures).toHaveLength(1);
      expect(failures[0]).toContain("network");
    });

    it("never reports a credential refusal and resets on success", async () => {
      const events: string[] = [];
      const conclusions = {
        succeeded: (automationId: string) => {
          events.push(`ok:${automationId}`);
          return Promise.resolve();
        },
        failed: (automationId: string) => {
          events.push(`failed:${automationId}`);
          return Promise.resolve();
        },
      };

      await attributed("credential");
      await sweepWith(
        () =>
          Promise.resolve({
            kind: "permanent",
            reason: "401: expired",
            category: "credential",
          }),
        { conclusions },
      );
      expect(events).toEqual([]);

      await attributed("success");
      await sweepWith(() => Promise.resolve({ kind: "sent" }), {
        conclusions,
      });
      expect(events).toEqual(["ok:launch-post"]);
    });
  });

  it("defers at the cap without discarding, and delivers when it frees up", async () => {
    // Two private replies already concluded, against a ceiling of two.
    for (const key of ["old-1", "old-2"]) {
      const id = await queue(key);
      await work.complete(id, T0);
    }
    const id = await queue("send-3");
    let attempts = 0;

    await sweepWith(() => {
      attempts += 1;
      return Promise.resolve({ kind: "sent" });
    });

    // Not attempted, not dropped: still pending, with a future instant.
    expect(attempts).toBe(0);
    const deferred = await work.find(id);
    expect(deferred?.status).toBe("pending");
    expect(deferred?.dueAt.getTime()).toBeGreaterThan(T0.getTime());
    expect(deferred?.lastReason).toContain("private_replies_per_hour");

    // An hour later the window has moved, and the send goes out.
    clock.set(new Date(T0.getTime() + 61 * 60 * 1000));
    await sweepWith(() => {
      attempts += 1;
      return Promise.resolve({ kind: "sent" });
    });

    expect(attempts).toBe(1);
    expect((await work.find(id))?.status).toBe("done");
  });

  it("comes back later after a rate-limited answer, with a growing interval", async () => {
    const id = await queue("send-1");
    const attempt = (): Promise<SendAttempt> =>
      Promise.resolve({ kind: "rate_limited" });

    await sweepWith(attempt);
    const first = await work.find(id);
    expect(first?.status).toBe("pending");
    expect(first?.dueAt).toEqual(new Date(T0.getTime() + 1000));

    clock.set(first!.dueAt);
    await sweepWith(attempt);
    const second = await work.find(id);
    // Doubled, not repeated: a fixed interval would hammer an account the
    // platform is already refusing.
    expect(second?.dueAt).toEqual(new Date(first!.dueAt.getTime() + 2000));
  });

  it("obeys the platform's own retry instant when it sends one", async () => {
    const id = await queue("send-1");

    await sweepWith(() =>
      Promise.resolve({ kind: "rate_limited", retryAfterMs: 90_000 }),
    );

    // The platform knows when the account is welcome back; the local curve is
    // a guess, and a guess must not overrule it.
    expect((await work.find(id))?.dueAt).toEqual(
      new Date(T0.getTime() + 90_000),
    );
  });

  it("fails with the reason once the retry budget is spent", async () => {
    const id = await queue("send-1");
    const attempt = (): Promise<SendAttempt> =>
      Promise.resolve({ kind: "transient", reason: "gateway timeout" });

    for (let pass = 0; pass < 5; pass += 1) {
      const current = await work.find(id);
      if (current?.status !== "pending") break;
      clock.set(current.dueAt);
      await sweepWith(attempt);
    }

    const final = await work.find(id);
    expect(final?.status).toBe("failed");
    expect(final?.lastReason).toContain("gateway timeout");
    // The budget is three attempts, and the message says so.
    expect(final?.lastReason).toContain("3");
  });

  it("retries an uncertain delivery ONCE, never five times", async () => {
    // The defect this guards is not hypothetical: on 2026-08-02 a 500 that had
    // actually delivered was retried through the whole budget, and one contact
    // received five identical messages. Retrying a send that may have landed
    // duplicates it, and a duplicate to a person is the harm, not the cost.
    const id = await queue("send-1");
    let attempts = 0;
    const attempt = (): Promise<SendAttempt> => {
      attempts += 1;
      return Promise.resolve({
        kind: "transient",
        reason: "500: An unknown error has occurred.",
        deliveryUncertain: true,
      });
    };

    for (let pass = 0; pass < 6; pass += 1) {
      const current = await work.find(id);
      if (current?.status !== "pending") break;
      clock.set(current.dueAt);
      await sweepWith(attempt);
    }

    expect(attempts).toBe(2);
    const final = await work.find(id);
    expect(final?.status).toBe("failed");
    expect(final?.lastReason).toContain("twice to the same person");
  });

  it("still spends the full budget when delivery is certainly not done", async () => {
    // A timeout with no answer at all is the case the retry budget was built
    // for, and it must keep its five attempts.
    const id = await queue("send-2");
    let attempts = 0;
    const attempt = (): Promise<SendAttempt> => {
      attempts += 1;
      return Promise.resolve({ kind: "transient", reason: "gateway timeout" });
    };

    for (let pass = 0; pass < 6; pass += 1) {
      const current = await work.find(id);
      if (current?.status !== "pending") break;
      clock.set(current.dueAt);
      await sweepWith(attempt);
    }

    expect(attempts).toBe(3);
    expect((await work.find(id))?.status).toBe("failed");
  });

  it("does not spend the budget on a refusal that waiting cannot fix", async () => {
    const id = await queue("send-1");

    await sweepWith(() =>
      Promise.resolve({ kind: "permanent", reason: "outside the window" }),
    );

    const final = await work.find(id);
    expect(final?.status).toBe("failed");
    expect(final?.lastReason).toBe("outside the window");
    // One attempt, not the whole budget: retrying a refusal is calls spent to
    // be told the same thing.
    expect(final?.attempts).toBe(1);
  });

  it("checks the cap BEFORE asking the platform", async () => {
    for (const key of ["old-1", "old-2"]) {
      const id = await queue(key);
      await work.complete(id, T0);
    }
    await queue("send-3");
    let asked = false;

    await sweepWith(() => {
      asked = true;
      return Promise.resolve({ kind: "sent" });
    });

    // Asking and being refused would spend a call to learn something already
    // known, which on the one path with a real hourly ceiling is the whole
    // difference between pacing and being throttled.
    expect(asked).toBe(false);
  });

  it("leaves work with no send class to the handler, uncapped", async () => {
    // Suspension timeouts share this queue and answer to no quota.
    const { item } = await work.enqueue(
      { kind: "send", dedupeKey: "no-class", payload: {} },
      T0,
    );
    let asked = false;

    await sweepWith(() => {
      asked = true;
      return Promise.resolve({ kind: "sent" });
    });

    expect(asked).toBe(true);
    expect((await work.find(item.id))?.status).toBe("done");
  });

  /**
   * REQ-039 needs a SOURCE, and until now there was none: the only
   * `action_executed` row a send ever produced was written when the step
   * ENQUEUED it, so a 429, a 5xx or a refusal at the moment of delivery left no
   * trace anywhere the dashboard could count.
   *
   * What is on trial here is the counting, not the wording: that the two
   * numbers the requirement names stay apart, that a delivery is not counted
   * twice, and that an installation with no trail wired still delivers.
   */
  describe("REQ-039: what the platform answered reaches the trail", () => {
    /** The delivery rows, as an aggregation over the period would read them. */
    function actions(): ReturnType<AuditRepository["query"]> {
      return audit.query({ kind: "action_executed" });
    }

    it("tells too many requests apart from an ordinary error", async () => {
      await queue("send-429", T0, { action: "direct_message" });
      await sweepWith(() => Promise.resolve({ kind: "rate_limited" }));

      await queue("send-500", T0, { action: "direct_message" });
      await sweepWith(() =>
        Promise.resolve({ kind: "transient", reason: "500: upstream said no" }),
      );

      const throttled = await audit.query({
        kind: "action_executed",
        outcome: "blocked",
      });
      const errors = await audit.query({
        kind: "action_executed",
        outcome: "failed",
      });

      // Two answers, two counts, and REQ-039 asks for them separately for a
      // reason: merged into one total, an account the platform is throttling is
      // invisible inside the ordinary failures, and the operator reads a number
      // that cannot tell them to stop sending.
      expect(throttled).toHaveLength(1);
      expect(throttled[0]?.reason).toBe(t("rate.rateLimited"));
      expect(errors).toHaveLength(1);
      expect(errors[0]?.reason).toBe("500: upstream said no");
    });

    it("records the Meta acceptance and its immutable message id", async () => {
      await work.enqueue(
        {
          kind: "send",
          dedupeKey: "send-1",
          payload: { action: "direct_message" },
          contactId: "contact-1",
          executionId: "welcome:contact-1:run",
          sendClass: "direct_message",
        },
        T0,
      );

      await sweepWith(() =>
        Promise.resolve({ kind: "sent", platformMessageId: "mid.1" }),
      );

      // Queueing and API acceptance are different facts. The latter never
      // asserts delivery or reading, it only preserves Meta's answer and id
      // for a later echo/seen webhook to correlate.
      expect(await actions()).toEqual([
        expect.objectContaining({
          outcome: "ok",
          reason: "platform_accepted",
          contactId: "contact-1",
          executionId: "welcome:contact-1:run",
          platformMessageId: "mid.1",
        }),
      ]);
    });

    it("writes one row per answer, not one per message", async () => {
      const id = await queue("send-1", T0, { action: "direct_message" });
      const attempt = (): Promise<SendAttempt> =>
        Promise.resolve({ kind: "rate_limited" });

      for (let pass = 0; pass < 5; pass += 1) {
        const current = await work.find(id);
        if (current?.status !== "pending") break;
        clock.set(current.dueAt);
        await sweepWith(attempt);
      }

      // Three refusals in the period are three refusals, and the requirement
      // counts the ANSWERS the platform gave rather than the messages that
      // provoked them.
      expect(
        await audit.query({ kind: "action_executed", outcome: "blocked" }),
      ).toHaveLength(3);
    });

    it("names the kind of action the delivery was about", async () => {
      await queue("reply-1", T0, { action: "reply_comment" });

      await sweepWith(() =>
        Promise.resolve({ kind: "permanent", reason: "outside the window" }),
      );

      const [entry] = await actions();
      expect(entry?.subtype).toBe("comment_reply");
      expect(entry?.outcome).toBe("failed");
      expect(entry?.reason).toBe("outside the window");
    });

    it("names the contact the delivery was for", async () => {
      await work.enqueue(
        {
          kind: "send",
          dedupeKey: "send-1",
          payload: { action: "direct_message" },
          contactId: "contact-9",
          sendClass: "direct_message",
        },
        T0,
      );

      await sweepWith(() =>
        Promise.resolve({ kind: "permanent", reason: "refused" }),
      );

      // Without it the operator reads a count and cannot reach the person it
      // happened to.
      expect((await actions())[0]?.contactId).toBe("contact-9");
    });

    it("labels nothing when the payload names no action", async () => {
      await queue("send-1");

      await sweepWith(() =>
        Promise.resolve({ kind: "permanent", reason: "refused" }),
      );

      // The honest absence rather than a default: this queue is shared, and a
      // row whose payload this module cannot read is one it must not label as
      // a message. The reader groups it as unknown.
      expect((await actions())[0]?.subtype).toBeUndefined();
    });

    it("records an adapter that threw, once per answer", async () => {
      const id = await queue("send-1", T0, { action: "direct_message" });

      await sweepWith(() => {
        throw new Error("socket hang up");
      });

      // The commonest production error of all reaches no status code, so it
      // never reaches the classification. Counted nowhere, REQ-039 would show
      // zero errors through an outage.
      const [entry] = await actions();
      expect(entry?.outcome).toBe("failed");
      expect(entry?.reason).toBe("socket hang up");
      // One row for this one throw, and the send is not over: it comes back on
      // the retry budget like any other transient failure (REQ-119).
      expect(await actions()).toHaveLength(1);
      expect((await work.find(id))?.status).toBe("pending");
    });

    it("writes nothing when our own cap defers the send", async () => {
      for (const key of ["old-1", "old-2"]) {
        const id = await queue(key);
        await work.complete(id, T0);
      }
      await queue("send-3", T0, { action: "direct_message" });

      await sweepWith(() => Promise.resolve({ kind: "sent" }));

      // Our own pacing is not an answer the platform gave. Counted as one it
      // would inflate the very number that tells an operator the platform is
      // refusing them, on a queue that in fact never called it.
      expect(await actions()).toHaveLength(0);
    });

    it("delivers exactly as before when no trail is wired", async () => {
      const id = await queue("send-1", T0, { action: "direct_message" });

      await sweepWith(() => Promise.resolve({ kind: "rate_limited" }), {
        audit: undefined,
      });

      // An installation whose composition root has not been updated loses the
      // dashboard's counts, never a message.
      expect((await work.find(id))?.status).toBe("pending");
      expect(await actions()).toHaveLength(0);
    });
  });

  /**
   * REQ-119: an exception IS an answer, and gets the same budget.
   *
   * The defect these guard is an inversion: an adapter that threw was marked
   * failed for good on the first try, while the identical failure arriving as a
   * 5xx kept the whole budget. A throw is the most transient failure there is
   * (a reset socket, a name that did not resolve), so the contact never
   * received and the trail claimed a permanent failure that never was.
   */
  describe("REQ-119: a thrown send is retried like an answered one", () => {
    /** Drives one row until it leaves the queue, counting the attempts made. */
    async function drain(
      id: number,
      attempt: () => Promise<SendAttempt>,
      passes = 8,
    ): Promise<number> {
      let calls = 0;

      for (let pass = 0; pass < passes; pass += 1) {
        const current = await work.find(id);
        if (current?.status !== "pending") break;
        clock.set(current.dueAt);
        await sweepWith(() => {
          calls += 1;
          return attempt();
        });
      }

      return calls;
    }

    it("spends exactly the attempts the same failure spends when answered", async () => {
      const thrown = await queue("thrown");
      const threw = await drain(thrown, () => {
        throw new Error("socket hang up");
      });

      // Queued only now: a second pending row would be swept alongside the
      // first and spend its own budget on the wrong adapter.
      const answered = await queue("answered", clock.now());
      const gotAnAnswer = await drain(answered, () =>
        Promise.resolve({ kind: "transient", reason: "socket hang up" }),
      );

      // The equality IS the requirement: the same failure, in its two possible
      // shapes, is worth the same number of tries.
      expect(threw).toBe(gotAnAnswer);
      // And that number is the configured budget, not one.
      expect(threw).toBe(3);
      expect((await work.find(thrown))?.status).toBe("failed");
    });

    it("brings a thrown send back on the growing interval, not at once", async () => {
      const id = await queue("thrown");
      const boom = (): never => {
        throw new Error("ECONNRESET");
      };

      await sweepWith(boom);
      const first = await work.find(id);
      expect(first?.status).toBe("pending");
      expect(first?.dueAt).toEqual(new Date(T0.getTime() + 1000));

      clock.set(first!.dueAt);
      await sweepWith(boom);

      // Doubled, exactly as REQ-018 requires of a refusal: a throw hammering at
      // a fixed rate would be a second defect, not a fix for the first.
      expect((await work.find(id))?.dueAt).toEqual(
        new Date(first!.dueAt.getTime() + 2000),
      );
    });

    it("fails rather than blocks once a thrown send spends the budget", async () => {
      const id = await queue("thrown", T0, { action: "direct_message" });

      await drain(id, () => {
        throw new Error("socket hang up");
      });

      const final = await work.find(id);
      expect(final?.status).toBe("failed");
      expect(final?.lastReason).toContain("socket hang up");
      // The budget is three attempts, and the message says so.
      expect(final?.lastReason).toContain("3");
      // `blocked` counts the platform answering too many requests, and an
      // outage is not that. Joining that count would inflate the one number
      // that tells an operator to stop sending (REQ-039).
      expect(
        await audit.query({ kind: "action_executed", outcome: "blocked" }),
      ).toHaveLength(0);
      expect(
        await audit.query({ kind: "action_executed", outcome: "failed" }),
      ).toHaveLength(3);
    });

    it("gives up at once on a throw that proves the program is wrong", async () => {
      const id = await queue("bug");

      const calls = await drain(id, () => {
        throw new TypeError("cannot read properties of undefined");
      });

      // A runtime error with no cause is this code dereferencing what is not
      // there, and the same queued row reproduces it on every attempt. Spending
      // the budget on it buys nothing and delays the moment it is visible.
      expect(calls).toBe(1);
      const final = await work.find(id);
      expect(final?.status).toBe("failed");
      expect(final?.attempts).toBe(1);
    });

    it("does not mistake a network failure wearing a runtime name for a defect", async () => {
      const id = await queue("network");

      await sweepWith(() => {
        throw new TypeError("fetch failed", { cause: new Error("ECONNRESET") });
      });

      // Node's `fetch` reports EVERY network failure as `TypeError: fetch
      // failed` with the real error in `cause`. Reading only the name would
      // classify the commonest production failure of all as a bug in our code,
      // which is precisely the giving-up this requirement forbids.
      expect((await work.find(id))?.status).toBe("pending");
    });
  });
});
