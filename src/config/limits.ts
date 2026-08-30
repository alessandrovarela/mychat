import { ConfigError, configMessages } from "./errors.js";

/**
 * Limits live in configuration, never as literals in code (KEEL convention).
 * Every value has a built-in default so a fresh installation runs with nothing
 * filled in, and every value is overridable by an environment variable so
 * tuning never touches code.
 *
 * TWO families live here, and they must not be mixed:
 *
 *   1. `PlatformLimits`: quotas the platform publishes. Every value is the one
 *      `docs/platform-limits.md` confirmed against the official documentation,
 *      with its URL and consultation date. When a number changes there, it
 *      changes here too, and never the other way round: a limit this file
 *      cannot point at in that document is an invented number (REQ-079).
 *   2. `AuthThrottleLimits`: this application's own operational ceiling on
 *      authentication attempts. Nothing outside the project sustains those
 *      numbers, so they are declared in their own section, further down, and
 *      never inside `PlatformLimits`, whose whole contract is the paragraph
 *      above. They are here rather than beside the mechanism they govern
 *      because they are configuration: declared in one place, listed in
 *      `.env.example`, and reported at runtime like every other limit
 *      (REQ-006, REQ-108).
 *
 * Two figures the project once carried do NOT exist in the official
 * documentation and are gone: an hourly cap on messages and an hourly cap on
 * API calls, both guessed at 200. The real quotas are per second, and the one
 * official hourly ceiling applies only to private replies. The general call
 * quota is a moving 24-hour window derived from the account's impressions,
 * so it cannot be computed locally at all, which is why backing off on a 429
 * is the mechanism that actually protects the account, not a local counter.
 */
export interface PlatformLimits {
  /** Direct-message window: 24 hours from the contact's last message. */
  readonly messageWindowHours: number;
  /**
   * Private-reply window: 7 days from the comment. A separate window from the
   * one above, on purpose — the two are not interchangeable (REQ-080).
   */
  readonly commentReplyWindowDays: number;
  /** The only official hourly ceiling: private replies, per account. */
  readonly privateRepliesPerHour: number;
  /** Per-second quota for text, links, reactions and stickers. */
  readonly callsPerSecond: number;
  /** Per-second quota for audio and video, an order of magnitude tighter. */
  readonly mediaCallsPerSecond: number;
  readonly retryAttempts: number;
  readonly retryBaseMs: number;
  /**
   * How close to a cap counts as worth signalling, in percent (REQ-038). The
   * dashboard's normal-to-attention boundary.
   */
  readonly alertThresholdPct: number;
  /**
   * The second boundary, attention-to-critical (REQ-038). Two thresholds and
   * not one because they answer different questions: the first says "watch
   * this", the second says "the next sends are going to be deferred". One
   * number would either warn too late to act or shout on every busy hour.
   */
  readonly criticalThresholdPct: number;
  /**
   * Message text ceiling, in BYTES of UTF-8 — not characters (REQ-087). The
   * distinction is not pedantry: in Portuguese every accented character costs
   * two bytes, so a text that looks short overflows. Official wording:
   * "Message text must be UTF-8 and be a 1000 bytes or less".
   */
  readonly messageTextBytes: number;
  /**
   * Label ceiling of a URL button, which lives inside a generic template. A
   * DIFFERENT mechanism from the quick reply below, with a different ceiling:
   * treating them as one makes one of the two silently stop working.
   */
  readonly linkButtonLabelChars: number;
  /**
   * Label ceiling of a quick reply. Truncated by the platform past this.
   *
   * THIRTY-FIVE, from the measurement on the operated account on 2026-08-19,
   * and no longer the twenty the secondary source of 2026-08-01 claimed. Both
   * readings stay in `docs/platform-limits.md`, because a source is never
   * erased: a label of 67 characters was accepted and stored whole, the button
   * showed 35 of them with an ellipsis, and the webhook echo came back with
   * all 67. Twenty was not conservative, it was wrong, and it made the
   * product's OWN default label (`confirmationQuickReplyDefault`, 21 UTF-16
   * units because the padlock is a surrogate pair) be predicted as cut on a
   * screen where it arrives whole. This number refuses nothing (REQ-306): it
   * is where the panel starts warning that the contact will read less than was
   * typed. Chosen at 35 and not 36 because the measurement said "close to 36"
   * without separating graphemes from UTF-16 units, and the number that was
   * actually SEEN is 35.
   */
  readonly quickReplyLabelChars: number;
  /**
   * Title ceiling of a generic-template element, in CHARACTERS.
   *
   * Its own ceiling, an order of magnitude tighter than the 1000 bytes a text
   * message accepts, and that gap is the whole reason it is configured
   * separately: a message with a link becomes a card and its text becomes the
   * card's title, so a text that passed the message ceiling arrives TRUNCATED
   * on the contact's screen (REQ-230). Refusing it at activation is the only
   * moment anybody can still fix it.
   */
  readonly cardTitleChars: number;
  /** Subtitle ceiling of the same element, published as the same number. */
  readonly cardDescriptionChars: number;
}

export type LimitKey = keyof PlatformLimits;

export const LIMIT_DEFAULTS: PlatformLimits = {
  messageWindowHours: 24,
  commentReplyWindowDays: 7,
  privateRepliesPerHour: 750,
  callsPerSecond: 100,
  mediaCallsPerSecond: 10,
  retryAttempts: 5,
  retryBaseMs: 1000,
  alertThresholdPct: 80,
  criticalThresholdPct: 95,
  messageTextBytes: 1000,
  linkButtonLabelChars: 80,
  quickReplyLabelChars: 35,
  cardTitleChars: 80,
  cardDescriptionChars: 80,
};

export const LIMIT_ENV_VARIABLES: Readonly<Record<LimitKey, string>> = {
  messageWindowHours: "MESSAGE_WINDOW_HOURS",
  commentReplyWindowDays: "COMMENT_REPLY_WINDOW_DAYS",
  privateRepliesPerHour: "PRIVATE_REPLIES_PER_HOUR",
  callsPerSecond: "CALLS_PER_SECOND",
  mediaCallsPerSecond: "MEDIA_CALLS_PER_SECOND",
  retryAttempts: "RETRY_ATTEMPTS",
  retryBaseMs: "RETRY_BASE_MS",
  alertThresholdPct: "ALERT_THRESHOLD_PCT",
  criticalThresholdPct: "CRITICAL_THRESHOLD_PCT",
  messageTextBytes: "MESSAGE_TEXT_BYTES",
  linkButtonLabelChars: "LINK_BUTTON_LABEL_CHARS",
  quickReplyLabelChars: "QUICK_REPLY_LABEL_CHARS",
  cardTitleChars: "CARD_TITLE_CHARS",
  cardDescriptionChars: "CARD_DESCRIPTION_CHARS",
};

export type LimitSource = "default" | "environment";

/** One limit as it stands after reading the environment, ready to be logged. */
export interface EffectiveLimit<Key extends string = string> {
  readonly key: Key;
  readonly variable: string;
  readonly value: number;
  readonly source: LimitSource;
}

/**
 * A variable set to an empty (or whitespace-only) value expresses "not set":
 * that is what a blank line in `.env` means, and `.env.example` ships every
 * optional key blank on purpose.
 */
function readVariable(
  env: NodeJS.ProcessEnv,
  variable: string,
): string | undefined {
  const raw = env[variable];
  if (raw === undefined) {
    return undefined;
  }

  const trimmed = raw.trim();
  return trimmed === "" ? undefined : trimmed;
}

/**
 * Resolves one family of limits and reports where each value came from.
 *
 * Shared by both families because the reading is identical and only the rule
 * for what counts as a usable number differs, which is what `accepts` carries.
 * Every rejected variable is collected before throwing, so an operator who
 * mistyped three of them is told about three and not about the first.
 */
function describeFamily<Key extends string>(
  env: NodeJS.ProcessEnv,
  defaults: Readonly<Record<Key, number>>,
  variables: Readonly<Record<Key, string>>,
  accepts: (value: number, key: Key) => boolean,
): EffectiveLimit<Key>[] {
  const effective: EffectiveLimit<Key>[] = [];
  const invalid: string[] = [];

  for (const key of Object.keys(defaults) as Key[]) {
    const variable = variables[key];
    const raw = readVariable(env, variable);

    if (raw === undefined) {
      effective.push({
        key,
        variable,
        value: defaults[key],
        source: "default",
      });
      continue;
    }

    const value = Number(raw);
    // A typo must stop the process, not fall back to the default behind the
    // operator's back: they would run on numbers they never chose.
    if (!accepts(value, key)) {
      invalid.push(variable);
      continue;
    }

    effective.push({ key, variable, value, source: "environment" });
  }

  if (invalid.length > 0) {
    throw new ConfigError(
      configMessages.invalidLimitVariables(invalid),
      invalid,
    );
  }

  return effective;
}

/**
 * Resolves every platform limit and reports where its value came from, so the
 * process can log what is in effect at startup (REQ-006: the value in force is
 * readable at runtime).
 *
 * Pure: the environment arrives as an argument, `process.env` is never read
 * here.
 */
export function describeLimits(
  env: NodeJS.ProcessEnv,
): EffectiveLimit<LimitKey>[] {
  return describeFamily(
    env,
    LIMIT_DEFAULTS,
    LIMIT_ENV_VARIABLES,
    // Fractions are accepted on purpose: a per-second quota is a rate, and
    // nothing about it demands a whole number.
    (value) => Number.isFinite(value) && value >= 0,
  );
}

/**
 * Builds the limits in force from the given environment. Pure by design, so a
 * test can hand it any environment without touching the real process.
 */
export function loadLimits(env: NodeJS.ProcessEnv): PlatformLimits {
  const limits: Record<LimitKey, number> = { ...LIMIT_DEFAULTS };

  for (const limit of describeLimits(env)) {
    limits[limit.key] = limit.value;
  }

  return limits;
}

/* ------------------------------------------------ authentication ceiling */

/**
 * The ceiling on authentication attempts, per origin (REQ-034).
 *
 * Declared here, in configuration, and NOT inside `PlatformLimits`: these are
 * operational choices of this application, like `DEFAULT_SESSION_TTL_MS` in
 * `src/auth/session.ts`, and the contract of `PlatformLimits` is that every
 * value in it is traceable to the platform's published documentation (REQ-079).
 * Two families, one file: what they share is being configuration, which is what
 * puts them in `.env.example` and under the guard that no variable is read
 * without being declared (REQ-108).
 *
 * The mechanism that spends these numbers lives in `src/auth/throttle.ts`, and
 * re-exports them so a caller of the ceiling still has one import.
 */
export interface AuthThrottleLimits {
  /** Failed attempts an origin may spend inside one window before the block. */
  readonly attempts: number;
  /** How long failures keep accumulating against an origin. */
  readonly windowMs: number;
  /** How long the origin is refused once the ceiling is crossed. */
  readonly blockMs: number;
  /**
   * How many origins may be tracked at once.
   *
   * A bound, not a tuning knob: the state is a map keyed by origin, and an
   * attacker with an IPv6 allocation has more addresses than this process has
   * memory. Without a cap the defence against guessing would itself be a way
   * to exhaust the host.
   */
  readonly trackedOrigins: number;
  /**
   * How many reverse proxies sit in front of this process (ADR-013 puts Caddy
   * there in production, so ONE is the deployed value; local development and
   * any direct exposure is zero).
   *
   * Zero means the forwarded header is not read at all. See `resolveOrigin` in
   * `src/auth/throttle.ts` for what a wrong value costs in each direction.
   */
  readonly trustedProxyHops: number;
}

export type AuthThrottleLimitKey = keyof AuthThrottleLimits;

export const AUTH_THROTTLE_DEFAULTS: AuthThrottleLimits = {
  attempts: 5,
  windowMs: 15 * 60 * 1000,
  blockMs: 15 * 60 * 1000,
  trackedOrigins: 10000,
  // Safe by default: an installation that never says it is behind a proxy is
  // never talked into believing a header. Getting this wrong in the other
  // direction (trusting a header nobody writes) removes the ceiling entirely.
  trustedProxyHops: 0,
};

export const AUTH_THROTTLE_ENV_VARIABLES: Readonly<
  Record<AuthThrottleLimitKey, string>
> = {
  attempts: "AUTH_ATTEMPT_LIMIT",
  windowMs: "AUTH_ATTEMPT_WINDOW_MS",
  blockMs: "AUTH_BLOCK_MS",
  trackedOrigins: "AUTH_TRACKED_ORIGINS",
  trustedProxyHops: "AUTH_TRUSTED_PROXY_HOPS",
};

/**
 * Smallest value each limit accepts.
 *
 * `attempts` floors at one and not at zero, and that is the footgun this table
 * exists for: zero would refuse the very first attempt of every origin
 * forever, locking the operator out of their own dashboard with no way in
 * short of editing the environment. A limit that can be typed into a lockout
 * has to fail at start-up instead.
 */
const AUTH_THROTTLE_MINIMUM: Readonly<Record<AuthThrottleLimitKey, number>> = {
  attempts: 1,
  windowMs: 1,
  blockMs: 1,
  trackedOrigins: 1,
  trustedProxyHops: 0,
};

/**
 * Resolves the authentication ceiling and reports where each value came from,
 * so it is readable at runtime exactly like a platform limit (REQ-006). A
 * ceiling nobody can read is a ceiling nobody can check they are running.
 *
 * Pure: the environment arrives as an argument, `process.env` is never read
 * here.
 */
export function describeAuthThrottleLimits(
  env: NodeJS.ProcessEnv,
): EffectiveLimit<AuthThrottleLimitKey>[] {
  return describeFamily(
    env,
    AUTH_THROTTLE_DEFAULTS,
    AUTH_THROTTLE_ENV_VARIABLES,
    // Whole numbers only, unlike the platform family: an attempt, a millisecond
    // and a proxy hop are all counts, and 2.5 attempts is a typo.
    (value, key) =>
      Number.isInteger(value) && value >= AUTH_THROTTLE_MINIMUM[key],
  );
}

/**
 * Builds the ceiling in force from the given environment. Pure by design, so a
 * test can hand it any environment without touching the real process.
 *
 * A typo stops the process naming the variable, rather than falling back to
 * the default behind the operator's back: silently running an authentication
 * ceiling nobody chose is worse than not starting.
 */
export function loadAuthThrottleLimits(
  env: NodeJS.ProcessEnv,
): AuthThrottleLimits {
  const limits: Record<AuthThrottleLimitKey, number> = {
    ...AUTH_THROTTLE_DEFAULTS,
  };

  for (const limit of describeAuthThrottleLimits(env)) {
    limits[limit.key] = limit.value;
  }

  return limits;
}
