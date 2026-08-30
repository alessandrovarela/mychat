import { describe, expect, it } from "vitest";
import { nextRetry } from "./retry.js";
import type { RetryPolicy } from "./retry.js";

/**
 * Proves the second half of REQ-018: the interval grows exponentially, carries
 * jitter, and the budget ends somewhere.
 *
 * Jitter is asserted with an injected source rather than a range, on purpose. A
 * range assertion passes just as happily when the doubling silently stops
 * doubling, which is the failure that matters: without growth the retries
 * become a fixed-rate hammer on an account the platform is already refusing.
 */

const NOW = new Date("2026-08-01T10:00:00.000Z");
const policy: RetryPolicy = { attempts: 5, baseMs: 1000 };

/** No jitter: the delay is the fixed half of the window. */
const noJitter = () => 0;
/** Maximum jitter: the delay is the whole window. */
const fullJitter = () => 1;

describe("REQ-018: exponential backoff with jitter", () => {
  it("doubles the window at every further attempt", () => {
    const delays = [0, 1, 2, 3].map(
      (attempts) => nextRetry(attempts, policy, NOW, fullJitter).delayMs,
    );

    expect(delays).toEqual([1000, 2000, 4000, 8000]);
  });

  it("spreads within the window instead of landing on one instant", () => {
    // Half the window is fixed and half is random: a batch deferred together
    // comes back spread out, instead of reproducing the burst that caused the
    // refusal in the first place.
    const earliest = nextRetry(0, policy, NOW, noJitter).delayMs;
    const latest = nextRetry(0, policy, NOW, fullJitter).delayMs;

    expect(earliest).toBe(500);
    expect(latest).toBe(1000);
  });

  it("returns the instant, not only the delay", () => {
    const decision = nextRetry(1, policy, NOW, fullJitter);

    expect(decision.dueAt).toEqual(new Date(NOW.getTime() + 2000));
  });

  it("counts the budget in attempts, not in retries after the first", () => {
    // Five attempts means five tries. The fifth failure has no sixth.
    expect(nextRetry(3, policy, NOW, noJitter).retry).toBe(true);
    expect(nextRetry(4, policy, NOW, noJitter).retry).toBe(false);
  });

  it("gives up with no instant once the budget is spent", () => {
    const decision = nextRetry(10, policy, NOW, noJitter);

    expect(decision).toEqual({ retry: false });
  });

  it("honours a budget of a single attempt", () => {
    // One attempt means no retry at all, and the edge must not be off by one.
    expect(nextRetry(0, { attempts: 1, baseMs: 1000 }, NOW, noJitter)).toEqual({
      retry: false,
    });
  });

  it("takes both numbers from the policy rather than from a literal", () => {
    const other: RetryPolicy = { attempts: 9, baseMs: 250 };

    expect(nextRetry(2, other, NOW, fullJitter).delayMs).toBe(1000);
    expect(nextRetry(7, other, NOW, fullJitter).retry).toBe(true);
    expect(nextRetry(8, other, NOW, fullJitter).retry).toBe(false);
  });
});
