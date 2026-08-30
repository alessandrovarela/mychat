/**
 * The zone of the instance, and who gets to decide it (REQ-153, REQ-183).
 *
 * The rule is the one the language already states in `src/i18n/preference.ts`,
 * word for word: the operator's choice is authoritative, and the environment
 * supplies only the INITIAL value, used while no choice has been made. So the
 * stored value is read FIRST, on every read, and `MYCHAT_TIMEZONE` is consulted
 * exactly when the store is empty. Reading the environment first would work
 * perfectly on the machine that never sets it and would silently overrule the
 * panel on the machine that does.
 *
 * What makes this cheap, and worth saying out loud because it is the reason
 * REQ-183 is a small change: no instant in this database carries a zone.
 * `occurred_at` is an epoch (`timestamp_ms`), which is a point in time and not a
 * reading of a clock, so the zone is used only when something is READ — to
 * decide which local day a sample falls in (`windowOf`) and to write an instant
 * on screen. There is no history to reprocess when it changes, and nothing to
 * migrate: only the next read has to ask again.
 *
 * Which is exactly what "without restarting" means here, and the only thing
 * that had to change: the value used to be captured once, at composition time,
 * into the closure that reads the metrics.
 *
 * This module is deliberately dependency-free (no zod, no store, no Fastify):
 * `src/config/env.ts` imports the vocabulary from HERE rather than the reverse,
 * so parsing the environment and knowing what a zone is stay separable.
 */

/**
 * The zone the panel counts and labels in when the operator names none.
 *
 * UTC because it is the only zone that is right for nobody and wrong for
 * nobody: it is what the trail's instants already are, and it is what every
 * bucket meant before this value existed, so an installation that never sets it
 * sees exactly the numbers it saw yesterday.
 */
export const DEFAULT_TIME_ZONE = "UTC";

/**
 * Whether this build's calendar data knows the zone.
 *
 * Asked of `Intl` rather than of a list written here, and that is the point: the
 * list of zones belongs to the runtime, changes with it, and a copy of it in
 * this file would refuse a zone the aggregation can perfectly well count in (or
 * accept one it cannot). Constructing the formatter is the only way to ask,
 * because an unknown zone is reported by a throw and by nothing else.
 *
 * One function, two callers, on purpose: the start-up check of
 * `MYCHAT_TIMEZONE` and the refusal of `POST /api/instance` have to agree about
 * what a zone is, or the panel would refuse what the `.env` accepts.
 */
export function isKnownTimeZone(zone: string): boolean {
  try {
    Intl.DateTimeFormat("en-US", { timeZone: zone }).resolvedOptions();
    return true;
  } catch {
    return false;
  }
}

/**
 * Every zone a selector may offer, with `inForce` guaranteed to be among them.
 *
 * The runtime's own list, and two corrections to it that are not decoration:
 *
 *   - `Intl.supportedValuesOf("timeZone")` does NOT contain "UTC" (measured on
 *     Node 24: 418 identifiers, every one of them with an area prefix, and no
 *     `Etc/*` at all). UTC is this instance's DEFAULT, so a list taken straight
 *     from the runtime would be a list an instance on UTC cannot see itself in,
 *     and could never be switched back to.
 *   - it lists the CANONICAL identifier only, and a link is not canonical:
 *     `Asia/Kolkata` is a name the aggregation counts in perfectly well, and
 *     the runtime answers `Asia/Calcutta` for it. An operator whose `.env` says
 *     one of those names would be shown a selector with no option matching
 *     what is in force, and the browser would silently display the FIRST one
 *     instead — a zone nobody configured, presented as fact, which is the
 *     defect REQ-166 exists to have removed.
 *
 * Hence the argument: the answer is built around what is in force rather than
 * beside it. Sorted, so the selector reads the same way twice.
 */
export function knownTimeZones(inForce: string): readonly string[] {
  const supported =
    typeof Intl.supportedValuesOf === "function"
      ? Intl.supportedValuesOf("timeZone")
      : [];

  return [...new Set([DEFAULT_TIME_ZONE, inForce, ...supported])].sort();
}

/** The row that carries the zone in `instance_preferences`. */
export const TIME_ZONE_PREFERENCE_KEY = "timeZone";

/** Refusal code for a zone this build's calendar data cannot count in. */
export const UNKNOWN_TIME_ZONE = "unknown_time_zone";

export interface TimeZonePreferenceStore {
  /** Undefined while the operator has never chosen: not the same as UTC. */
  read(): Promise<string | undefined>;
  write(zone: string, now: Date): Promise<void>;
}

/** Where the zone in force came from, which is what REQ-183 is about. */
export type TimeZoneSource = "stored" | "environment";

export interface TimeZoneInForce {
  readonly timeZone: string;
  readonly source: TimeZoneSource;
}

export type TimeZoneChoice =
  | { readonly ok: true; readonly timeZone: string }
  | { readonly ok: false; readonly refusal: typeof UNKNOWN_TIME_ZONE };

export interface TimeZonePreferenceDeps {
  readonly store: TimeZonePreferenceStore;
  /**
   * The INITIAL value, which is `config.timeZone` and therefore
   * `MYCHAT_TIMEZONE` or its default. Passed as a resolved string rather than
   * read from `process.env` here — unlike the language, whose variable nothing
   * validates — because the environment schema already refuses an unknown zone
   * at start-up, naming the variable, and a second reading here would either
   * repeat that check or quietly disagree with it.
   */
  readonly initial: string;
  /** Injected so a test asserts an instant instead of racing the machine's. */
  readonly now: () => Date;
}

export interface TimeZonePreference {
  /**
   * The zone in force, and where it came from. Asked on EVERY read, which is
   * the whole of REQ-183: a caller that keeps the answer has pinned the zone to
   * the moment it asked.
   */
  inForce(): Promise<TimeZoneInForce>;
  /** The panel's choice: refused if unknown, persisted if not. */
  choose(zone: string): Promise<TimeZoneChoice>;
}

export function createTimeZonePreference(
  deps: TimeZonePreferenceDeps,
): TimeZonePreference {
  return {
    inForce: async (): Promise<TimeZoneInForce> => {
      const stored = await deps.store.read();

      // A stored zone this build cannot count in falls back to the environment
      // and leaves the row alone, the way an unrenderable stored locale falls
      // back to English: only `choose` can write this row and only a known zone
      // gets through it, so reaching here means the runtime's calendar data
      // changed under a stored choice. Honouring it would throw inside every
      // aggregation instead of showing numbers in a zone somebody configured.
      if (stored !== undefined && isKnownTimeZone(stored)) {
        return { timeZone: stored, source: "stored" };
      }

      return { timeZone: deps.initial, source: "environment" };
    },

    choose: async (zone: string): Promise<TimeZoneChoice> => {
      if (!isKnownTimeZone(zone)) {
        // Refused rather than stored: a row holding a name no formatter accepts
        // would make every later read of the dashboard throw, and the panel
        // would be broken by a setting instead of by a deploy.
        return { ok: false, refusal: UNKNOWN_TIME_ZONE };
      }

      await deps.store.write(zone, deps.now());

      return { ok: true, timeZone: zone };
    },
  };
}
