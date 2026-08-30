import { AUTH_THROTTLE_DEFAULTS } from "../config/limits.js";
import type { AuthThrottleLimits } from "../config/limits.js";
import { t } from "../i18n/index.js";
import type { AuditRepository } from "../storage/audit.js";

/**
 * The ceiling on authentication attempts, per origin (REQ-034).
 *
 * There is ONE password and the route that checks it is public, which is the
 * shape that invites guessing in volume. Argon2id already makes each guess
 * expensive (`./credential.ts`), but cost per guess is only half the defence:
 * the hash resists the guess, the ceiling is what stops there being a million
 * of them. It also protects the process itself, since every guess buys the
 * attacker 19 MiB and a few milliseconds of the server's own CPU.
 *
 * Three decisions carry this file.
 *
 *   1. The ceiling is consulted BEFORE the password is verified, and that
 *      order is not an implementation detail: it IS the difference between a
 *      ceiling and a second opinion. `attemptAuthentication` owns the order so
 *      the route cannot get it wrong, and so it can be proven by a test that
 *      needs no HTTP server.
 *   2. The count is per ORIGIN, never global. A global counter would let
 *      anyone on the internet lock the operator out of their own dashboard
 *      with a handful of wrong passwords, turning a defence into a trivial
 *      denial of service.
 *   3. Nothing here is persisted. The state answers one question ("how many
 *      wrong passwords has this origin sent lately") whose whole horizon is a
 *      few minutes, so a restart forgetting it costs an attacker one window
 *      and costs the operator nothing. What DOES need to survive is the
 *      evidence, and that goes to the audit trail, which is a table.
 */

/* -------------------------------------------------------------- configuration */

/**
 * The limits in force are DECLARED in `src/config/limits.ts`, beside the
 * platform quotas, and re-exported here so a caller of the ceiling still has
 * one import. They are configuration like any other: one declaration, a line in
 * `.env.example`, and a value readable at runtime (REQ-006, REQ-108).
 *
 * What stays in this file is the mechanism that spends them.
 */
export {
  AUTH_THROTTLE_DEFAULTS,
  AUTH_THROTTLE_ENV_VARIABLES,
  loadAuthThrottleLimits,
} from "../config/limits.js";

export type {
  AuthThrottleLimitKey,
  AuthThrottleLimits,
} from "../config/limits.js";

/* ------------------------------------------------------------------- origin */

/** The header a reverse proxy writes the addresses it saw into. */
export const FORWARDED_FOR_HEADER = "x-forwarded-for";

/**
 * Bucket for a request whose peer address the server cannot see.
 *
 * One shared bucket, so those requests throttle each other. That is the safe
 * direction: an address nobody can read must not become a free pass, and the
 * case does not arise over TCP anyway.
 */
export const UNKNOWN_ORIGIN = "unknown";

/** What a request offers about where it came from. */
export interface OriginSource {
  /** The socket peer. Cannot be forged by the client: TCP delivered to it. */
  readonly remoteAddress?: string | undefined;
  /** The forwarded header, as received. Read only when hops are declared. */
  readonly forwardedFor?: string | readonly string[] | undefined;
}

/** IPv6 counts by network, and this is how many groups a /64 covers. */
const IPV6_PREFIX_GROUPS = 4;
const IPV6_GROUPS = 8;
const IPV6_GROUP = /^[0-9a-f]{1,4}$/;
const IPV4_MAPPED_PREFIX = "::ffff:";

/** Drops a port, in the two forms an address can carry one. */
function stripPort(address: string): string {
  if (address.startsWith("[")) {
    const close = address.indexOf("]");
    return close === -1 ? address : address.slice(1, close);
  }

  const colon = address.indexOf(":");
  // Exactly one colon is IPv4 with a port. More than one is IPv6, which never
  // carries a port unless bracketed, so cutting there would truncate it.
  return colon !== -1 && address.indexOf(":", colon + 1) === -1
    ? address.slice(0, colon)
    : address;
}

/**
 * The /64 an IPv6 address belongs to, or undefined when it is not one.
 *
 * Grouping is the point rather than a shortcut. A single IPv6 host is normally
 * handed an entire /64, so counting per full address would give one attacker
 * 2^64 free budgets and no ceiling at all. The cost is that two operators
 * behind one /64 share a budget, which is the same trade every NAT already
 * imposes on IPv4.
 */
function ipv6Network(address: string): string | undefined {
  if (!address.includes(":")) {
    return undefined;
  }

  const halves = address.split("::");
  if (halves.length > 2) {
    return undefined;
  }

  const head = (halves[0] ?? "").split(":").filter((group) => group !== "");
  const tail =
    halves.length === 2
      ? (halves[1] ?? "").split(":").filter((group) => group !== "")
      : [];
  const zeros =
    halves.length === 2 ? IPV6_GROUPS - head.length - tail.length : 0;

  if (zeros < 0) {
    return undefined;
  }

  const groups = [...head, ...Array<string>(zeros).fill("0"), ...tail];
  if (groups.length !== IPV6_GROUPS) {
    return undefined;
  }

  const prefix: string[] = [];
  for (const group of groups.slice(0, IPV6_PREFIX_GROUPS)) {
    if (!IPV6_GROUP.test(group)) {
      // Not an address this function understands. Undefined sends the caller
      // back to the literal string, which still counts SOMETHING, instead of
      // inventing a network.
      return undefined;
    }
    prefix.push(Number.parseInt(group, 16).toString(16));
  }

  return `${prefix.join(":")}::/64`;
}

/**
 * The key an address is counted under.
 *
 * Normalised, because the alternative hands out extra budgets for free: the
 * same host reaching a dual-stack socket appears as `1.2.3.4` and as
 * `::ffff:1.2.3.4`, and two spellings of one origin is two ceilings.
 */
export function originKey(address: string): string {
  const bare = stripPort(address.trim().toLowerCase());

  if (bare === "") {
    return UNKNOWN_ORIGIN;
  }

  const unmapped = bare.startsWith(IPV4_MAPPED_PREFIX)
    ? bare.slice(IPV4_MAPPED_PREFIX.length)
    : bare;

  return ipv6Network(unmapped) ?? unmapped;
}

function forwardedChain(
  header: string | readonly string[] | undefined,
): string[] {
  if (header === undefined) {
    return [];
  }

  // A repeated header arrives as several values, and the chain is their
  // concatenation in the order they were received.
  const joined = Array.isArray(header) ? header.join(",") : String(header);

  return joined
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
}

/**
 * Which origin a request is counted against.
 *
 * The problem this solves: ADR-013 puts Caddy in front in production, so the
 * socket peer is the proxy for EVERY request, and counting that address would
 * put the whole internet in one bucket. The first attacker to cross the
 * ceiling would lock out the operator, which is decision 2 of this module
 * inverted into the exact denial of service it exists to prevent.
 *
 * The header is therefore read, but never taken at face value, and the
 * configuration is a HOP COUNT rather than a boolean because that is what makes
 * the value unforgeable. Each proxy APPENDS the peer it saw, so with one
 * trusted proxy the trustworthy entry is the LAST one: anything a client puts
 * in the header lands to the left of what Caddy wrote. Reading the leftmost
 * entry is the classic mistake, and it is total: a client sends
 * `X-Forwarded-For: <random>` on every request and the ceiling never counts the
 * same origin twice.
 *
 * The risk in the other direction is stated plainly because it is real: declare
 * a hop that does not exist, and a client controls its own origin key by
 * writing the header itself. Which is why the default is zero, and why the
 * value must be set only by whoever knows what the deployment puts in front.
 */
export function resolveOrigin(
  source: OriginSource,
  trustedProxyHops: number,
): string {
  const peer =
    source.remoteAddress === undefined || source.remoteAddress.trim() === ""
      ? UNKNOWN_ORIGIN
      : originKey(source.remoteAddress);

  if (trustedProxyHops <= 0) {
    return peer;
  }

  const chain = forwardedChain(source.forwardedFor);
  // Each trusted hop wrote one entry; the client's address is the one just
  // before them. A header shorter than that is a deployment that does not
  // match the declared hop count, and the socket peer is the only value left
  // that nobody can forge.
  const claimed = chain[chain.length - trustedProxyHops];

  return claimed === undefined ? peer : originKey(claimed);
}

/* ----------------------------------------------------------------- decision */

export type AuthAttemptVerdict =
  | { readonly allowed: true; readonly remaining: number }
  | {
      readonly allowed: false;
      /** The exact instant the origin may try again. Never a guess. */
      readonly retryAt: Date;
      readonly failures: number;
    };

export interface AuthThrottle {
  /**
   * Whether this origin may attempt at all. Reads only: no attempt has
   * happened yet, so nothing may be counted here.
   */
  check(origin: string, now: Date): AuthAttemptVerdict;
  /** Counts one failed attempt and returns the verdict that now applies. */
  fail(origin: string, now: Date): AuthAttemptVerdict;
  /** Forgets the origin's failures: whoever it is knows the password. */
  succeed(origin: string): void;
  /** How many origins are being tracked, so the memory bound is observable. */
  size(): number;
}

interface OriginState {
  failures: number;
  windowStartedAt: number;
  /** Set the moment the ceiling is crossed, and never moved afterwards. */
  blockedUntil?: number;
}

/**
 * The ceiling, holding its counts in memory.
 *
 * The clock arrives as an argument on every call and `Date.now` is never read
 * here, which is what lets a test cross an interval instead of waiting one.
 */
export function createAuthThrottle(
  limits: AuthThrottleLimits = AUTH_THROTTLE_DEFAULTS,
): AuthThrottle {
  const states = new Map<string, OriginState>();

  /** When a state stops deciding anything. */
  const endsAt = (state: OriginState): number =>
    state.blockedUntil ?? state.windowStartedAt + limits.windowMs;

  const spent = (state: OriginState, now: number): boolean =>
    endsAt(state) <= now;

  /** The state still in force for an origin. Expired state is dropped. */
  const usable = (origin: string, now: number): OriginState | undefined => {
    const state = states.get(origin);

    if (state === undefined) {
      return undefined;
    }

    if (spent(state, now)) {
      // Dropping it here is what makes acceptance criterion 9 true: once the
      // block has been served the origin starts from zero, so a single wrong
      // password does not put it straight back into a block it already paid.
      states.delete(origin);
      return undefined;
    }

    return state;
  };

  /**
   * Keeps the map inside its bound. Runs only when the bound is exceeded, so
   * the ordinary path costs one lookup rather than a scan of every origin.
   */
  const prune = (now: number): void => {
    if (states.size <= limits.trackedOrigins) {
      return;
    }

    for (const [origin, state] of states) {
      if (spent(state, now)) {
        states.delete(origin);
      }
    }

    if (states.size <= limits.trackedOrigins) {
      return;
    }

    // Still over the bound, so something has to go, and WHICH matters: an
    // attacker who can evict entries evicts their own block. Origins already
    // blocked are kept last, and among equals the ones expiring soonest go
    // first, since they are the ones with the least left to say.
    const ordered = [...states.entries()].sort((left, right) => {
      const blocked =
        Number(left[1].blockedUntil !== undefined) -
        Number(right[1].blockedUntil !== undefined);
      return blocked !== 0 ? blocked : endsAt(left[1]) - endsAt(right[1]);
    });

    for (const [origin] of ordered.slice(
      0,
      states.size - limits.trackedOrigins,
    )) {
      states.delete(origin);
    }
  };

  const verdictFor = (state: OriginState | undefined): AuthAttemptVerdict => {
    if (state === undefined) {
      return { allowed: true, remaining: limits.attempts };
    }

    if (state.blockedUntil !== undefined) {
      return {
        allowed: false,
        retryAt: new Date(state.blockedUntil),
        failures: state.failures,
      };
    }

    return {
      allowed: true,
      remaining: Math.max(0, limits.attempts - state.failures),
    };
  };

  return {
    check(origin: string, now: Date): AuthAttemptVerdict {
      return verdictFor(usable(origin, now.getTime()));
    },

    fail(origin: string, now: Date): AuthAttemptVerdict {
      const at = now.getTime();
      const existing = usable(origin, at);

      if (existing?.blockedUntil !== undefined) {
        // An origin already inside its block is not counted again, so the
        // block cannot be pushed further out by the attempts it is refusing.
        // Otherwise a browser retrying on a timer would extend its own lockout
        // indefinitely, and acceptance criterion 9 would never come true.
        return verdictFor(existing);
      }

      const state = existing ?? { failures: 0, windowStartedAt: at };
      state.failures += 1;

      if (state.failures >= limits.attempts) {
        state.blockedUntil = at + limits.blockMs;
      }

      states.set(origin, state);
      // After the write, never before: pruning first would leave the map one
      // entry over the bound at all times, which is a bound that does not hold.
      prune(at);

      return verdictFor(state);
    },

    succeed(origin: string): void {
      states.delete(origin);
    },

    size(): number {
      return states.size;
    },
  };
}

/** Seconds to put in a `Retry-After` header. At least one, always rounded up. */
export function retryAfterSeconds(retryAt: Date, now: Date): number {
  return Math.max(1, Math.ceil((retryAt.getTime() - now.getTime()) / 1000));
}

/* -------------------------------------------------------------------- trail */

/** Catalogue key of the sentence the trail carries. */
export const THROTTLE_REASON_KEY = "auth.attemptsThrottled";

/** How a refusal is worded in the trail. Injected so a test needs no locale. */
export type DescribeThrottleRefusal = (origin: string, retryAt: Date) => string;

export const throttleRefusalReason: DescribeThrottleRefusal = (
  origin,
  retryAt,
) => t(THROTTLE_REASON_KEY, { origin, retryAt: retryAt.toISOString() });

/**
 * Writes the refusal to the audit trail (acceptance criterion 8): the origin
 * that was refused, and why.
 *
 * `kind: "alert"`, because this is the application telling the OPERATOR
 * something about their installation rather than recording what happened to a
 * contact. `outcome: "blocked"`, which `src/storage/audit.ts` defines as a
 * refusal made before going any further, and that is exactly what this is: the
 * password was never looked at.
 *
 * No subtype, and it is worth being explicit about why. `AuditAlertSubtype` is
 * a closed union of four values, all of them about the platform credential;
 * none of them is this. Writing one anyway would put authentication refusals
 * into the operator's count of credential failures, which is a corrupted total
 * that nobody would ever notice. Absent reads back as the `unknown` group,
 * which is honest, and the union gains an `auth_throttled` member the moment
 * that file may be touched.
 */
export async function recordThrottleRefusal(
  audit: AuditRepository,
  origin: string,
  retryAt: Date,
  now: Date,
  describe: DescribeThrottleRefusal = throttleRefusalReason,
): Promise<void> {
  await audit.record(
    {
      kind: "alert",
      outcome: "blocked",
      reason: describe(origin, retryAt),
    },
    now,
  );
}

/* ------------------------------------------------------------------ attempt */

export type AuthAttemptOutcome =
  | { readonly kind: "accepted" }
  | { readonly kind: "rejected" }
  | { readonly kind: "throttled"; readonly retryAt: Date };

export interface AuthAttemptDeps {
  readonly throttle: AuthThrottle;
  readonly audit: AuditRepository;
  /** Whether the password is the one in force. Injected: this module never
   * reads a credential store, and a test never pays for a derivation. */
  readonly verify: (password: string) => Promise<boolean>;
  readonly describe?: DescribeThrottleRefusal;
}

/**
 * One authentication attempt, in the only order that makes the ceiling a
 * ceiling (REQ-034, acceptance criteria 7, 8 and 9).
 *
 * The ceiling is consulted FIRST and the password is not verified at all when
 * the origin is inside its block, which is what acceptance criterion 7 means
 * by "even if the password is correct". Verifying first and consulting after
 * looks identical in every test that sends a wrong password, and is not a
 * ceiling: an attacker who eventually guesses right walks straight in, and the
 * server keeps paying for a full Argon2id derivation on every refused request.
 *
 * The order lives HERE rather than in the route so that it is provable without
 * an HTTP server, and so that adding a second entry point cannot get it wrong.
 */
export async function attemptAuthentication(
  origin: string,
  password: string,
  deps: AuthAttemptDeps,
  now: Date,
): Promise<AuthAttemptOutcome> {
  const verdict = deps.throttle.check(origin, now);

  if (!verdict.allowed) {
    await recordThrottleRefusal(
      deps.audit,
      origin,
      verdict.retryAt,
      now,
      deps.describe,
    );

    return { kind: "throttled", retryAt: verdict.retryAt };
  }

  if (!(await deps.verify(password))) {
    deps.throttle.fail(origin, now);
    return { kind: "rejected" };
  }

  // Whoever this is knows the password, so the failures counted against the
  // origin have been answered. Keeping them would eventually lock out an
  // operator who mistypes across a working day.
  deps.throttle.succeed(origin);

  return { kind: "accepted" };
}
