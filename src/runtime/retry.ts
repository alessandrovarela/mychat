/**
 * The retry budget (REQ-018).
 *
 * Reactive backoff, not a local counter, is what actually protects the account.
 * The platform's general call quota is a moving 24-hour window derived from the
 * account's impressions, so it cannot be computed here at all — which means the
 * 429 IS the signal, and how the application answers it is the whole defence.
 *
 * Jitter is not decoration. Without it every deferred send in a batch comes
 * back at the same instant, reproducing the burst that caused the 429 in the
 * first place. With it, the same batch spreads.
 */

/** Why a send is coming back later. The audit trail reads this. */
export type RetryReason = "rate_limited" | "transient_error";

export interface RetryPolicy {
  /** How many attempts before the work is marked failed for good. */
  readonly attempts: number;
  /** First delay, doubled at each further attempt. */
  readonly baseMs: number;
}

/**
 * Random in [0, 1). Injected so a test can assert the exact instant a deferral
 * lands on: `Math.random()` in the middle of a schedule is untestable, and
 * asserting only a range would let the doubling silently stop doubling.
 */
export type Jitter = () => number;

export interface RetryDecision {
  /** False when the budget is spent: the caller must fail the work. */
  readonly retry: boolean;
  /** Present only when `retry` is true. */
  readonly dueAt?: Date;
  /** The delay actually applied, exposed so the audit can record it. */
  readonly delayMs?: number;
}

/** Half of the window is fixed and half is random: spread without starving. */
const JITTER_SHARE = 0.5;

/**
 * Decides whether a piece of work comes back, and when.
 *
 * `attemptsSoFar` is the count BEFORE this failure, which is what the durable
 * store holds: a piece of work that has never been tried has zero.
 */
export function nextRetry(
  attemptsSoFar: number,
  policy: RetryPolicy,
  now: Date,
  jitter: Jitter,
): RetryDecision {
  if (attemptsSoFar + 1 >= policy.attempts) {
    // The +1 counts THIS failure. A budget of five attempts means five tries,
    // not five retries after the first one.
    return { retry: false };
  }

  // Exponential: base, 2x base, 4x base ... The exponent is the number of
  // attempts already spent, so the first retry waits exactly `baseMs` at most.
  const window = policy.baseMs * 2 ** attemptsSoFar;
  const fixed = window * (1 - JITTER_SHARE);
  const delayMs = Math.round(fixed + window * JITTER_SHARE * jitter());

  return {
    retry: true,
    delayMs,
    dueAt: new Date(now.getTime() + delayMs),
  };
}
