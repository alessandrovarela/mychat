import type { PlatformLimits } from "../config/limits.js";
import type { DurableWorkStore, SendClass } from "../storage/index.js";

/**
 * The rate budget (REQ-017).
 *
 * What it can and cannot know is the whole design. The platform publishes ONE
 * hourly ceiling — private replies, per account — and per-second quotas. Its
 * general call quota is a moving 24-hour window derived from the account's
 * impressions, which no local counter can reproduce. So this module enforces
 * exactly the caps that are computable, and everything else is left to the
 * reactive backoff in `./retry.js`, which is what actually protects the
 * account.
 *
 * Reaching a cap NEVER discards a send. It moves it: the work goes back to the
 * queue with a later instant, and is delivered when the window allows.
 */

export const RATE_CAPS = [
  "private_replies_per_hour",
  "calls_per_second",
  "media_calls_per_second",
] as const;

export type RateCap = (typeof RATE_CAPS)[number];

export type RateVerdict =
  | { readonly allowed: true }
  | {
      readonly allowed: false;
      readonly cap: RateCap;
      /** The exact instant the window frees up. Never a guess when avoidable. */
      readonly retryAt: Date;
    };

/** Counts the decision reads. Gathered by `readRateCounts`, or by a test. */
export interface RateCounts {
  readonly privateRepliesLastHour: number;
  /** When the oldest counted private reply happened, if any. */
  readonly oldestPrivateReply?: Date;
  readonly callsThisSecond: number;
  readonly mediaCallsThisSecond: number;
}

export type RateLimits = Pick<
  PlatformLimits,
  "privateRepliesPerHour" | "callsPerSecond" | "mediaCallsPerSecond"
>;

const HOUR_MS = 60 * 60 * 1000;
const SECOND_MS = 1000;

/** Start of the second AFTER the one `at` falls in. */
function nextSecond(at: Date): Date {
  return new Date(Math.floor(at.getTime() / SECOND_MS) * SECOND_MS + SECOND_MS);
}

/**
 * Pure: the counts arrive already gathered, so every branch is reachable with
 * plain numbers and no database.
 */
export function decideRate(
  sendClass: SendClass,
  counts: RateCounts,
  limits: RateLimits,
  now: Date,
): RateVerdict {
  if (
    sendClass === "private_reply" &&
    counts.privateRepliesLastHour >= limits.privateRepliesPerHour
  ) {
    // The window frees up when the OLDEST reply inside it falls out, which is
    // a known instant. Deferring a whole hour instead would idle the queue for
    // fifty-nine minutes it did not need to wait.
    const oldest = counts.oldestPrivateReply;
    return {
      allowed: false,
      cap: "private_replies_per_hour",
      retryAt:
        oldest === undefined
          ? new Date(now.getTime() + HOUR_MS)
          : new Date(oldest.getTime() + HOUR_MS),
    };
  }

  if (
    sendClass === "media" &&
    counts.mediaCallsThisSecond >= limits.mediaCallsPerSecond
  ) {
    return {
      allowed: false,
      cap: "media_calls_per_second",
      retryAt: nextSecond(now),
    };
  }

  // Every class counts against the general per-second quota, media included:
  // its own tighter ceiling is additional, not a replacement.
  if (counts.callsThisSecond >= limits.callsPerSecond) {
    return {
      allowed: false,
      cap: "calls_per_second",
      retryAt: nextSecond(now),
    };
  }

  return { allowed: true };
}

/**
 * Gathers the counts from concluded work.
 *
 * Concluded, not attempted: a send the platform refused consumed no quota, and
 * counting it would throttle the account for work it never did.
 */
export async function readRateCounts(
  work: DurableWorkStore,
  now: Date,
): Promise<RateCounts> {
  const hourAgo = new Date(now.getTime() - HOUR_MS);
  const secondStart = new Date(
    Math.floor(now.getTime() / SECOND_MS) * SECOND_MS,
  );

  const [privateRepliesLastHour, oldestPrivateReply] = await Promise.all([
    work.countCompletedSince("private_reply", hourAgo),
    work.oldestCompletedSince("private_reply", hourAgo),
  ]);

  const perSecond = await Promise.all([
    work.countCompletedSince("private_reply", secondStart),
    work.countCompletedSince("direct_message", secondStart),
    work.countCompletedSince("media", secondStart),
  ]);

  const mediaCallsThisSecond = perSecond[2];

  return {
    privateRepliesLastHour,
    ...(oldestPrivateReply !== undefined && { oldestPrivateReply }),
    callsThisSecond: perSecond[0] + perSecond[1] + mediaCallsThisSecond,
    mediaCallsThisSecond,
  };
}
