import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigError } from "../config/errors.js";
import { createAuditRepository } from "../storage/audit.js";
import { subtypeGroupOf, UNKNOWN_SUBTYPE } from "../storage/audit.js";
import type { AuditRepository } from "../storage/audit.js";
import { IN_MEMORY_DATABASE, openDatabase } from "../storage/database.js";
import type { DatabaseHandle } from "../storage/database.js";
import {
  attemptAuthentication,
  AUTH_THROTTLE_DEFAULTS,
  AUTH_THROTTLE_ENV_VARIABLES,
  createAuthThrottle,
  loadAuthThrottleLimits,
  originKey,
  resolveOrigin,
  retryAfterSeconds,
  throttleRefusalReason,
  UNKNOWN_ORIGIN,
} from "./throttle.js";
import type {
  AuthAttemptOutcome,
  AuthThrottle,
  AuthThrottleLimits,
} from "./throttle.js";

/**
 * Proves REQ-034 and acceptance criteria 7, 8 and 9 of the phase.
 *
 * Two tests here catch a mistake none of the others can see, and they are the
 * reason this file is worth reading:
 *
 *   - "refuses the right password while the origin is blocked", and its
 *     companion assertion that the verifier was never even asked. Verify the
 *     password first and consult the ceiling afterwards, and every other test
 *     in this file still passes: they all send wrong passwords. That inverted
 *     order is not a ceiling at all, since the attacker who finally guesses
 *     right walks straight in.
 *   - "leaves a second origin alone while the first is blocked". A global
 *     counter satisfies REQ-034 as written and hands anyone on the internet a
 *     way to lock the operator out of their own dashboard with five wrong
 *     passwords.
 *
 * The clock is an argument everywhere, so criterion 9 (the block ends and the
 * right password is accepted) is proven by crossing the interval rather than
 * by waiting one out.
 */

const START = new Date("2026-08-02T09:00:00.000Z");
const PASSWORD = "Zq7-Vamp!Krux9";
const WRONG = "not-the-password";
const OPERATOR = "203.0.113.7";
const STRANGER = "198.51.100.4";

const MINUTE = 60 * 1000;

const LIMITS: AuthThrottleLimits = {
  attempts: 3,
  windowMs: 10 * MINUTE,
  blockMs: 15 * MINUTE,
  trackedOrigins: 100,
  trustedProxyHops: 0,
};

/** Reads like the clock it stands in for: `at(5)` is five minutes in. */
function at(minutes: number): Date {
  return new Date(START.getTime() + minutes * MINUTE);
}

interface Harness {
  readonly audit: AuditRepository;
  readonly throttle: AuthThrottle;
  /** Every password the verifier was actually asked about, in order. */
  readonly asked: string[];
  attempt(
    origin: string,
    password: string,
    now: Date,
  ): Promise<AuthAttemptOutcome>;
}

let handle: DatabaseHandle;

function buildHarness(limits: AuthThrottleLimits = LIMITS): Harness {
  const audit = createAuditRepository(handle.db);
  const throttle = createAuthThrottle(limits);
  const asked: string[] = [];

  return {
    audit,
    throttle,
    asked,
    attempt(origin, password, now) {
      return attemptAuthentication(
        origin,
        password,
        {
          throttle,
          audit,
          // Injected, so no Argon2id derivation is paid for here: what this
          // file tests is the ORDER and the counting, not the hash, which
          // `./credential.test.ts` already covers.
          verify: (candidate: string): Promise<boolean> => {
            asked.push(candidate);
            return Promise.resolve(candidate === PASSWORD);
          },
          describe: (who, retryAt): string =>
            `refused ${who} until ${retryAt.toISOString()}`,
        },
        now,
      );
    },
  };
}

beforeEach(() => {
  handle = openDatabase({ databasePath: IN_MEMORY_DATABASE });
});

afterEach(() => {
  handle.close();
});

describe("REQ-034: attempts above the limit, from one origin, are refused", () => {
  it("lets an origin spend exactly the configured attempts", async () => {
    const harness = buildHarness();

    for (let attempt = 0; attempt < LIMITS.attempts; attempt += 1) {
      expect(await harness.attempt(OPERATOR, WRONG, at(0))).toStrictEqual({
        kind: "rejected",
      });
    }

    const refused = await harness.attempt(OPERATOR, WRONG, at(0));

    expect(refused.kind).toBe("throttled");
  });

  it("refuses the right password while the origin is blocked", async () => {
    const harness = buildHarness();

    for (let attempt = 0; attempt < LIMITS.attempts; attempt += 1) {
      await harness.attempt(OPERATOR, WRONG, at(0));
    }

    const outcome = await harness.attempt(OPERATOR, PASSWORD, at(1));

    // Acceptance criterion 7: the ceiling outranks the credential. A correct
    // password inside the block is refused like any other.
    expect(outcome.kind).toBe("throttled");
  });

  it("never even asks the verifier while the origin is blocked", async () => {
    const harness = buildHarness();

    for (let attempt = 0; attempt < LIMITS.attempts; attempt += 1) {
      await harness.attempt(OPERATOR, WRONG, at(0));
    }

    const askedBefore = [...harness.asked];
    await harness.attempt(OPERATOR, PASSWORD, at(1));

    // The strongest form of criterion 7, and the one that also protects the
    // process: a refused attempt costs no derivation, so guessing in volume
    // cannot be used to burn the server's CPU either.
    expect(harness.asked).toStrictEqual(askedBefore);
  });

  it("says exactly when the origin may try again", async () => {
    const harness = buildHarness();

    for (let attempt = 0; attempt < LIMITS.attempts; attempt += 1) {
      await harness.attempt(OPERATOR, WRONG, at(2));
    }

    const outcome = await harness.attempt(OPERATOR, PASSWORD, at(3));

    expect(outcome).toStrictEqual({
      kind: "throttled",
      retryAt: new Date(at(2).getTime() + LIMITS.blockMs),
    });
  });

  it("accepts the right password once the interval is over", async () => {
    const harness = buildHarness();

    for (let attempt = 0; attempt < LIMITS.attempts; attempt += 1) {
      await harness.attempt(OPERATOR, WRONG, at(0));
    }

    const blocked = LIMITS.blockMs / MINUTE;

    expect(await harness.attempt(OPERATOR, PASSWORD, at(blocked - 1))).toEqual(
      expect.objectContaining({ kind: "throttled" }),
    );
    // Acceptance criterion 9.
    expect(
      await harness.attempt(OPERATOR, PASSWORD, at(blocked)),
    ).toStrictEqual({ kind: "accepted" });
  });

  it("does not push the block further out with the attempts it refuses", async () => {
    const harness = buildHarness();

    for (let attempt = 0; attempt < LIMITS.attempts; attempt += 1) {
      await harness.attempt(OPERATOR, WRONG, at(0));
    }

    // A browser retrying on a timer, or an attacker who never stops. Neither
    // may extend the lockout, or criterion 9 would never come true for the
    // operator whose page is refreshing itself.
    for (let minute = 1; minute < LIMITS.blockMs / MINUTE; minute += 1) {
      await harness.attempt(OPERATOR, PASSWORD, at(minute));
    }

    expect(
      await harness.attempt(OPERATOR, PASSWORD, at(LIMITS.blockMs / MINUTE)),
    ).toStrictEqual({ kind: "accepted" });
  });
});

describe("REQ-034: the count belongs to the origin, not to the installation", () => {
  it("leaves a second origin alone while the first is blocked", async () => {
    const harness = buildHarness();

    for (let attempt = 0; attempt < LIMITS.attempts; attempt += 1) {
      await harness.attempt(STRANGER, WRONG, at(0));
    }

    expect(await harness.attempt(STRANGER, PASSWORD, at(1))).toEqual(
      expect.objectContaining({ kind: "throttled" }),
    );
    // The whole point: whoever is hammering the door cannot lock the operator
    // out of their own dashboard.
    expect(await harness.attempt(OPERATOR, PASSWORD, at(1))).toStrictEqual({
      kind: "accepted",
    });
  });

  it("forgets what an origin spent once it signs in", async () => {
    const harness = buildHarness();

    for (let attempt = 0; attempt < LIMITS.attempts - 1; attempt += 1) {
      await harness.attempt(OPERATOR, WRONG, at(0));
    }

    expect(await harness.attempt(OPERATOR, PASSWORD, at(1))).toStrictEqual({
      kind: "accepted",
    });

    // An operator who mistypes twice a day must not accumulate a lockout over
    // a working week.
    for (let attempt = 0; attempt < LIMITS.attempts - 1; attempt += 1) {
      expect(await harness.attempt(OPERATOR, WRONG, at(2))).toStrictEqual({
        kind: "rejected",
      });
    }
  });

  it("does not accumulate failures spread beyond the window", async () => {
    const harness = buildHarness();
    const window = LIMITS.windowMs / MINUTE;

    for (let round = 0; round < LIMITS.attempts * 2; round += 1) {
      // One failure per window, forever: a count that never expired would
      // eventually block an operator who simply mistypes now and then.
      expect(
        await harness.attempt(OPERATOR, WRONG, at(round * window)),
      ).toStrictEqual({ kind: "rejected" });
    }
  });
});

describe("REQ-034: the refusal is on the record", () => {
  it("writes an alert entry naming the origin and the reason", async () => {
    const harness = buildHarness();

    for (let attempt = 0; attempt < LIMITS.attempts; attempt += 1) {
      await harness.attempt(OPERATOR, WRONG, at(0));
    }

    const outcome = await harness.attempt(OPERATOR, PASSWORD, at(1));
    const entries = await harness.audit.query({ kind: "alert" });
    const [entry] = entries;

    // Acceptance criterion 8.
    expect(entries).toHaveLength(1);
    expect(entry?.outcome).toBe("blocked");
    expect(entry?.occurredAt).toStrictEqual(at(1));
    expect(entry?.reason).toContain(OPERATOR);
    expect(entry?.reason).toContain(
      outcome.kind === "throttled" ? outcome.retryAt.toISOString() : "",
    );
  });

  it("groups the entry as unknown until the trail has a subtype for it", async () => {
    const harness = buildHarness();

    for (let attempt = 0; attempt < LIMITS.attempts; attempt += 1) {
      await harness.attempt(OPERATOR, WRONG, at(0));
    }
    await harness.attempt(OPERATOR, PASSWORD, at(1));

    const [entry] = await harness.audit.query({ kind: "alert" });

    // `AuditAlertSubtype` is closed and every member of it is about the
    // platform credential. Borrowing one would file authentication refusals
    // under credential failures and corrupt a count nobody would ever audit,
    // so absence is the honest answer until that union gains a member.
    expect(entry).toBeDefined();
    expect(entry === undefined ? undefined : subtypeGroupOf(entry)).toBe(
      UNKNOWN_SUBTYPE,
    );
  });

  it("records every refusal, not only the first of a block", async () => {
    const harness = buildHarness();

    for (let attempt = 0; attempt < LIMITS.attempts; attempt += 1) {
      await harness.attempt(OPERATOR, WRONG, at(0));
    }

    await harness.attempt(OPERATOR, PASSWORD, at(1));
    await harness.attempt(OPERATOR, PASSWORD, at(2));

    expect(await harness.audit.query({ kind: "alert" })).toHaveLength(2);
  });

  it("words the entry from the catalogue when nothing is injected", async () => {
    const audit = createAuditRepository(handle.db);
    const throttle = createAuthThrottle(LIMITS);
    const deps = {
      throttle,
      audit,
      verify: (candidate: string): Promise<boolean> =>
        Promise.resolve(candidate === PASSWORD),
    };

    for (let attempt = 0; attempt < LIMITS.attempts; attempt += 1) {
      await attemptAuthentication(OPERATOR, WRONG, deps, at(0));
    }

    const outcome = await attemptAuthentication(
      OPERATOR,
      PASSWORD,
      deps,
      at(1),
    );
    const [entry] = await audit.query({ kind: "alert" });

    // No operator-facing sentence is written in the code (KEEL): the default
    // wording is a catalogue lookup, and this is what proves the trail carries
    // that lookup rather than a literal someone typed here.
    expect(outcome.kind).toBe("throttled");
    expect(entry?.reason).toBe(
      outcome.kind === "throttled"
        ? throttleRefusalReason(OPERATOR, outcome.retryAt)
        : undefined,
    );
  });

  it("writes nothing for an attempt the ceiling never refused", async () => {
    const harness = buildHarness();

    for (let attempt = 0; attempt < LIMITS.attempts - 1; attempt += 1) {
      await harness.attempt(OPERATOR, WRONG, at(0));
    }
    await harness.attempt(OPERATOR, PASSWORD, at(1));

    // The trail records the CEILING acting. A wrong password below the limit
    // is an ordinary refusal that REQ-034 does not ask for, and recording each
    // one here would let anyone grow the operator's database at will.
    expect(await harness.audit.query({ kind: "alert" })).toStrictEqual([]);
  });
});

describe("REQ-034: which origin an attempt is counted against", () => {
  it("counts the socket peer and ignores a header nobody trusts", () => {
    const spoofed = resolveOrigin(
      { remoteAddress: OPERATOR, forwardedFor: "10.0.0.9" },
      0,
    );

    // Default deployment: no proxy declared, so the header is not read at all.
    // Reading it here would let any client pick its own bucket and the ceiling
    // would count nothing.
    expect(spoofed).toBe(OPERATOR);
  });

  it("counts the address the trusted proxy wrote, not the one the client claims", () => {
    // ADR-013 puts Caddy in front: it APPENDS the peer it saw, so a client that
    // forges a header pushes its own forgery to the left and the rightmost
    // entry is still the address Caddy observed. Reading the leftmost entry is
    // the classic mistake, and it removes the ceiling entirely.
    const origin = resolveOrigin(
      { remoteAddress: "172.18.0.2", forwardedFor: `9.9.9.9, ${STRANGER}` },
      1,
    );

    expect(origin).toBe(STRANGER);
  });

  it("reads across a repeated header the same way", () => {
    const origin = resolveOrigin(
      { remoteAddress: "172.18.0.2", forwardedFor: ["9.9.9.9", STRANGER] },
      1,
    );

    expect(origin).toBe(STRANGER);
  });

  it("falls back to the socket peer when the chain is shorter than declared", () => {
    // The deployment does not match the declared hop count, and the socket peer
    // is the only value left that a client cannot write.
    expect(
      resolveOrigin({ remoteAddress: "172.18.0.2", forwardedFor: "" }, 1),
    ).toBe("172.18.0.2");
    expect(resolveOrigin({ remoteAddress: "172.18.0.2" }, 2)).toBe(
      "172.18.0.2",
    );
  });

  it("counts two spellings of one address as one origin", () => {
    // A dual-stack socket reports the same IPv4 host either way, and two
    // spellings of one origin would be two ceilings.
    expect(originKey("::ffff:203.0.113.7")).toBe(originKey(OPERATOR));
    expect(originKey("  203.0.113.7  ")).toBe(originKey(OPERATOR));
    expect(originKey("203.0.113.7:52344")).toBe(originKey(OPERATOR));
  });

  it("counts an IPv6 host by its network", () => {
    // One host is normally handed a whole /64, so counting per address gives
    // one attacker 2^64 budgets and no ceiling at all.
    expect(originKey("2001:db8:1:2::1")).toBe(
      originKey("2001:db8:1:2:a:b:c:d"),
    );
    expect(originKey("[2001:db8:1:2::1]:443")).toBe(
      originKey("2001:db8:1:2::9"),
    );
    expect(originKey("2001:db8:1:2::1")).not.toBe(originKey("2001:db8:1:3::1"));
  });

  it("gives a request with no readable address a bucket, never a free pass", () => {
    expect(resolveOrigin({}, 0)).toBe(UNKNOWN_ORIGIN);
    expect(resolveOrigin({ remoteAddress: "   " }, 0)).toBe(UNKNOWN_ORIGIN);
  });

  it("keeps counting something when an address makes no sense", () => {
    // Never undefined and never a shared bucket by accident: an unparseable
    // value still identifies whoever keeps sending it.
    expect(originKey("gibberish")).toBe("gibberish");
  });
});

describe("REQ-034: the state stays bounded", () => {
  it("never tracks more origins than the bound allows", () => {
    const bound = 5;
    const throttle = createAuthThrottle({ ...LIMITS, trackedOrigins: bound });

    // An attacker with an IPv6 allocation has more networks than this process
    // has memory. Without the bound, the defence against guessing would itself
    // be a way to exhaust the host.
    for (let index = 0; index < 200; index += 1) {
      throttle.fail(`2001:db8:0:${index.toString(16)}::1`, at(0));
    }

    expect(throttle.size()).toBeLessThanOrEqual(bound);
  });

  it("keeps a blocked origin when it has to evict one", () => {
    const throttle = createAuthThrottle({
      ...LIMITS,
      attempts: 2,
      trackedOrigins: 2,
    });

    throttle.fail(OPERATOR, at(0));
    throttle.fail(OPERATOR, at(0));
    throttle.fail("198.51.100.1", at(1));
    throttle.fail("198.51.100.2", at(2));

    // An attacker who can evict entries evicts their own block, which would
    // make the ceiling a formality.
    expect(throttle.check(OPERATOR, at(3)).allowed).toBe(false);
    expect(throttle.size()).toBe(2);
  });

  it("drops what it no longer needs before evicting anything", () => {
    const throttle = createAuthThrottle({ ...LIMITS, trackedOrigins: 2 });

    throttle.fail("198.51.100.1", at(0));
    throttle.fail("198.51.100.2", at(0));
    // Far past the window of the first two: they decide nothing any more.
    throttle.fail("198.51.100.3", at(LIMITS.windowMs / MINUTE + 1));

    expect(throttle.size()).toBe(1);
  });
});

describe("REQ-034: the limit comes from configuration", () => {
  it("runs on its defaults with nothing set", () => {
    expect(loadAuthThrottleLimits({})).toStrictEqual(AUTH_THROTTLE_DEFAULTS);
  });

  it("reads a blank variable as not set", () => {
    // What a blank line in `.env` means.
    expect(
      loadAuthThrottleLimits({ [AUTH_THROTTLE_ENV_VARIABLES.attempts]: "  " }),
    ).toStrictEqual(AUTH_THROTTLE_DEFAULTS);
  });

  it("takes every limit from the environment", () => {
    const limits = loadAuthThrottleLimits({
      [AUTH_THROTTLE_ENV_VARIABLES.attempts]: "9",
      [AUTH_THROTTLE_ENV_VARIABLES.windowMs]: "60000",
      [AUTH_THROTTLE_ENV_VARIABLES.blockMs]: "120000",
      [AUTH_THROTTLE_ENV_VARIABLES.trackedOrigins]: "50",
      [AUTH_THROTTLE_ENV_VARIABLES.trustedProxyHops]: "1",
    });

    expect(limits).toStrictEqual({
      attempts: 9,
      windowMs: 60000,
      blockMs: 120000,
      trackedOrigins: 50,
      trustedProxyHops: 1,
    });
  });

  it("refuses a value that is not a whole number, naming the variable", () => {
    // A typo must stop the process rather than fall back to a default behind
    // the operator's back: they would be running a ceiling they never chose.
    try {
      loadAuthThrottleLimits({
        [AUTH_THROTTLE_ENV_VARIABLES.blockMs]: "soon",
      });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as ConfigError).variables).toStrictEqual([
        AUTH_THROTTLE_ENV_VARIABLES.blockMs,
      ]);
    }
  });

  it("refuses a limit of zero attempts", () => {
    // Zero would refuse the first attempt of every origin forever, and lock
    // the operator out of their own dashboard with no way back in.
    expect(() =>
      loadAuthThrottleLimits({ [AUTH_THROTTLE_ENV_VARIABLES.attempts]: "0" }),
    ).toThrow(ConfigError);
  });

  it("accepts no proxy in front, which is what a direct deployment has", () => {
    expect(
      loadAuthThrottleLimits({
        [AUTH_THROTTLE_ENV_VARIABLES.trustedProxyHops]: "0",
      }).trustedProxyHops,
    ).toBe(0);
  });
});

describe("REQ-034: what the refused caller is told to wait", () => {
  it("rounds up to whole seconds and never reports zero", () => {
    expect(retryAfterSeconds(new Date(START.getTime() + 1500), START)).toBe(2);
    expect(retryAfterSeconds(new Date(START.getTime() + 1), START)).toBe(1);
    // A past instant means the block has just lapsed. Zero would read as "no
    // wait" to a client that then retries in the same millisecond.
    expect(retryAfterSeconds(new Date(START.getTime() - 5000), START)).toBe(1);
  });
});
