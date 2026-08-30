import type { PlatformLimits } from "../config/limits.js";
import { isSuppressionReason } from "../engine/execute.js";
import type { ActionReason } from "../engine/execute.js";
import { decodeNoMatch } from "../flows/matching.js";
import type { MatchTally } from "../flows/matching.js";
import { decodeExecutionFailure } from "../runtime/execution-audit.js";
import { RATE_CAPS, readRateCounts } from "../runtime/rate.js";
import type { RateCap, RateCounts } from "../runtime/rate.js";
import { subtypeGroupOf, UNKNOWN_SUBTYPE } from "../storage/audit.js";
import type {
  AuditKind,
  AuditOutcome,
  AuditRepository,
  AuditSubtype,
  AuditSubtypeGroup,
} from "../storage/audit.js";
import type { DurableWorkStore, WorkKind } from "../storage/durable-work.js";
import type { ButtonClickSample } from "../storage/button-clicks.js";
import type {
  BucketGranularity,
  CapStatus,
  CapWindow,
  DashboardRange,
} from "./vocabulary.js";

/**
 * The operator's numbers (REQ-030, REQ-036, REQ-037, REQ-038, REQ-039,
 * REQ-040).
 *
 * Every figure here is computed from tables this application owns: the audit
 * trail for what happened, the durable work queue for what is still waiting.
 * No observability service is consulted, which is REQ-030 read as it has to be
 * read to stay consistent with REQ-040: the requirement forbids an EXTERNAL
 * source, not a second internal one. The pending queue does not live in the
 * trail and never could, because the trail records what already happened.
 *
 * This module computes; it renders nothing. Every value is a number, a date or
 * a member of a union, so the screen owns the wording and the catalogue owns
 * the language (REQ-073).
 */

/**
 * The panel's closed vocabularies, declared in `./vocabulary.js` and re-exported
 * here so every reader of this module keeps its one address for them.
 *
 * They sit in a module of their own because the interface's program cannot
 * compile THIS one (it reaches a database driver) and still has to hold its own
 * declarations of the same four words against them (REQ-192, and REQ-196 for
 * `CapWindow`, which was found beside the first three and named by neither).
 * `vocabulary.ts` says the rest.
 */
export { DASHBOARD_RANGES } from "./vocabulary.js";
export type {
  BucketGranularity,
  CapStatus,
  CapWindow,
  DashboardRange,
} from "./vocabulary.js";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

const BUCKET_MS: Readonly<Record<BucketGranularity, number>> = {
  hour: HOUR_MS,
  day: DAY_MS,
};

/**
 * How long each range looks back, and how finely it is cut.
 *
 * The granularity is a property of the range and not a separate choice: a
 * thirty-day chart by hour is 720 columns nobody can read, and a one-day chart
 * by day is a single column that answers nothing.
 */
const RANGE_SPECS: Readonly<
  Record<
    DashboardRange,
    { readonly spanMs: number; readonly granularity: BucketGranularity }
  >
> = {
  last_24_hours: { spanMs: 24 * HOUR_MS, granularity: "hour" },
  last_7_days: { spanMs: 7 * DAY_MS, granularity: "day" },
  last_30_days: { spanMs: 30 * DAY_MS, granularity: "day" },
};

/** The period a report covers. Both ends are inclusive, as `AuditQuery` is. */
export interface RangeWindow {
  readonly range: DashboardRange;
  readonly granularity: BucketGranularity;
  readonly since: Date;
  readonly until: Date;
  /**
   * The zone the buckets are cut in (REQ-153). It travels WITH the window
   * because it is not a presentation detail: it decided which bucket each entry
   * fell into, so the screen that labels those buckets has to read them in the
   * same zone or it names a column after an hour it does not count.
   */
  readonly zone: string;
}

export function windowOf(
  range: DashboardRange,
  now: Date,
  zone: string,
): RangeWindow {
  const spec = RANGE_SPECS[range];

  return {
    range,
    granularity: spec.granularity,
    since: new Date(now.getTime() - spec.spanMs),
    until: now,
    zone,
  };
}

/** The one zone that needs no calendar: the epoch is already written in it. */
const EPOCH_ZONE = "UTC";

/**
 * One formatter per zone, kept, because building one is expensive and every
 * sample of a window asks the same question of the same zone.
 */
const ZONE_READERS = new Map<string, Intl.DateTimeFormat>();

function zoneReader(zone: string): Intl.DateTimeFormat {
  const kept = ZONE_READERS.get(zone);
  if (kept !== undefined) {
    return kept;
  }

  const reader = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    // `h23` and not `hour12: false`: the second reports midnight as hour 24 on
    // some engines, which would floor an instant into the previous day.
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

  ZONE_READERS.set(zone, reader);
  return reader;
}

/**
 * How far the zone's clock is from UTC at a given instant, in milliseconds.
 *
 * Read from the calendar at THAT instant and never from a stored number,
 * because it moves: a zone on daylight saving is two different offsets over one
 * window, and using either of them everywhere puts an hour's worth of entries in
 * the wrong day twice a year.
 */
function offsetMsOf(at: Date, zone: string): number {
  const parts = zoneReader(zone).formatToParts(at);
  const read = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((part) => part.type === type)?.value ?? "0");

  const wallClock = Date.UTC(
    read("year"),
    read("month") - 1,
    read("day"),
    read("hour"),
    read("minute"),
    read("second"),
  );

  // Both sides at second precision: the reading above carries no milliseconds,
  // and every offset in the calendar is a whole number of minutes.
  return wallClock - Math.floor(at.getTime() / 1000) * 1000;
}

/**
 * The bucket an instant falls in, IN THE CONFIGURED ZONE (REQ-153).
 *
 * The zone belongs here, in the counting, and not to whoever writes the label.
 * Flooring on the epoch makes a bucket a UTC hour or a UTC midnight, so a panel
 * that merely translated those labels into a zone three hours behind would show
 * an operator the first three hours of their evening filed under the next day.
 * Which bucket an entry belongs to is the question, and only this function
 * answers it.
 *
 * Still arithmetic, and still not the machine's calendar: `getHours()` buckets
 * by whatever zone the PROCESS happens to run in, so the same trail would read
 * differently after a server move and a test would depend on the developer's
 * laptop. The zone arrives as an argument, from configuration, and is the only
 * calendar consulted.
 *
 * The offset is read twice on purpose. The first reading is the one in force at
 * the instant being placed; the bucket START may sit on the other side of a
 * daylight-saving change and therefore have a different one, and it is the
 * start's own offset that says where the bucket begins.
 */
export function bucketStartOf(
  at: Date,
  granularity: BucketGranularity,
  zone: string,
): Date {
  const size = BUCKET_MS[granularity];

  // Epoch zero is a UTC midnight and both bucket sizes divide a UTC day
  // exactly, so in this one zone the floor needs no calendar at all. It is also
  // the default of an installation that configured nothing, which keeps the
  // common case as cheap as it was before the zone existed.
  if (zone === EPOCH_ZONE) {
    return new Date(Math.floor(at.getTime() / size) * size);
  }

  const offset = offsetMsOf(at, zone);
  const localStart = Math.floor((at.getTime() + offset) / size) * size;
  const guess = localStart - offset;
  const startOffset = offsetMsOf(new Date(guess), zone);

  return new Date(startOffset === offset ? guess : localStart - startOffset);
}

/**
 * The next bucket after this one, in the same zone.
 *
 * Adding the bucket size is not enough and cannot be: a local day is 23 or 25
 * hours long twice a year, so one fixed step lands inside the day it started in
 * (and would repeat a bucket forever) or one hour into the next (and is
 * correct). Stepping, then flooring, then stepping again while nothing moved is
 * what makes both cases land on the boundary the calendar actually has.
 */
function nextBucketStart(
  start: Date,
  granularity: BucketGranularity,
  zone: string,
): Date {
  const size = BUCKET_MS[granularity];
  let probe = start.getTime() + size;
  let next = bucketStartOf(new Date(probe), granularity, zone);

  // Half an hour, because that is the smallest step any zone shifts its clock
  // by. A larger one could jump clean over a bucket, which would leave a hole
  // in the axis instead of closing the loop.
  const HALF_HOUR_MS = 30 * 60 * 1000;
  while (next.getTime() <= start.getTime()) {
    probe += HALF_HOUR_MS;
    next = bucketStartOf(new Date(probe), granularity, zone);
  }

  return next;
}

/**
 * Every bucket of the window, ascending and continuous, including the ones
 * nothing happened in: a chart with holes in its axis misreads as a chart with
 * zeros, and the two mean different things to whoever is looking.
 *
 * The first and last buckets are partial by construction (the window ends at
 * `now`, which is rarely a bucket boundary), and that is honest: cutting them
 * would drop the most recent activity, which is the part an operator opens the
 * screen to see.
 */
export function bucketStartsOf(window: RangeWindow): readonly Date[] {
  const last = bucketStartOf(
    window.until,
    window.granularity,
    window.zone,
  ).getTime();

  const starts: Date[] = [];
  let start = bucketStartOf(window.since, window.granularity, window.zone);

  while (start.getTime() <= last) {
    starts.push(start);
    start = nextBucketStart(start, window.granularity, window.zone);
  }

  return starts;
}

/**
 * The slice of a trail entry a count needs. Structural on purpose: an
 * `AuditEntry` satisfies it, so nothing has to be mapped, and a test can count
 * plain objects with no database.
 */
export interface AuditSample {
  readonly occurredAt: Date;
  readonly kind: AuditKind;
  readonly subtype?: AuditSubtype;
  readonly outcome: AuditOutcome;
}

/** One type, counted per bucket. `counts` is aligned with `buckets`. */
export interface CountSeries {
  readonly subtype: AuditSubtypeGroup;
  readonly total: number;
  readonly counts: readonly number[];
}

export interface TypeBreakdown {
  readonly granularity: BucketGranularity;
  /** The x axis: one instant per bucket, ascending. */
  readonly buckets: readonly Date[];
  /**
   * One series per type actually seen in the window, ordered by name so two
   * reads of the same period produce the same chart. Types with nothing in the
   * period are absent rather than flat lines: the trail's vocabulary covers
   * events, actions and alerts, and listing all of them would draw a legend
   * mostly made of zeros.
   */
  readonly series: readonly CountSeries[];
  /**
   * The entries that name no type, grouped (REQ-106), and deliberately NOT
   * mixed into `series`.
   *
   * Two very different things land here. A row written before the migration
   * that added the column cannot say what it was. And the `/webhook` route
   * writes one row per DELIVERY with no subtype on purpose, because the
   * platform batches: a single accepted body may carry a comment and a direct
   * message at once, so no single origin would be honest. Merged into the
   * chart, that second case draws an "unknown" line as tall as the traffic
   * itself, next to the very types it is made of. Kept apart, the screen can
   * label it for what it is (deliveries) or leave it out, and the aggregation
   * still shows it instead of dropping data on the floor.
   */
  readonly unknown: CountSeries;
  /** Named types plus the unknown group: what a direct count of the same
   * period returns. */
  readonly total: number;
}

function emptySeries(subtype: AuditSubtypeGroup, buckets: number): CountSeries {
  return { subtype, total: 0, counts: new Array<number>(buckets).fill(0) };
}

/**
 * Counts samples into buckets by type.
 *
 * The caller decides WHICH samples are counted (see `readDashboardMetrics`);
 * this function decides only where each one lands.
 */
export function breakdownOf(
  samples: readonly AuditSample[],
  window: RangeWindow,
): TypeBreakdown {
  const buckets = bucketStartsOf(window);
  const position = new Map<number, number>(
    buckets.map((start, index) => [start.getTime(), index]),
  );

  const counts = new Map<AuditSubtypeGroup, number[]>();
  let total = 0;

  for (const sample of samples) {
    const bucket = position.get(
      bucketStartOf(
        sample.occurredAt,
        window.granularity,
        window.zone,
      ).getTime(),
    );

    // A sample outside the window is skipped rather than folded into the edge
    // bucket, which would report activity in a period it did not happen in.
    if (bucket === undefined) {
      continue;
    }

    const group = subtypeGroupOf(sample);
    let row = counts.get(group);
    if (row === undefined) {
      row = new Array<number>(buckets.length).fill(0);
      counts.set(group, row);
    }

    row[bucket] = (row[bucket] ?? 0) + 1;
    total += 1;
  }

  const unknownCounts = counts.get(UNKNOWN_SUBTYPE);
  counts.delete(UNKNOWN_SUBTYPE);

  const series = [...counts.entries()]
    .map(([subtype, row]) => ({
      subtype,
      total: row.reduce((sum, value) => sum + value, 0),
      counts: row,
    }))
    .sort((left, right) => left.subtype.localeCompare(right.subtype));

  return {
    granularity: window.granularity,
    buckets,
    series,
    unknown:
      unknownCounts === undefined
        ? emptySeries(UNKNOWN_SUBTYPE, buckets.length)
        : {
            subtype: UNKNOWN_SUBTYPE,
            total: unknownCounts.reduce((sum, value) => sum + value, 0),
            counts: unknownCounts,
          },
    total,
  };
}

/** Errors and refusals in the period (REQ-039). */
export interface FailureCounts {
  /**
   * Everything that failed, whatever kind of entry it was: a delivery whose
   * signature did not verify is an error an operator must see, exactly like a
   * send the platform rejected.
   */
  readonly errors: number;
  /**
   * Too-many-requests answers, counted apart from the errors above. The trail
   * has no subtype that tells the two apart, so the outcome carries it:
   * `blocked` is written in one place only (`src/runtime/policy.ts`, on a 429).
   * Merged into the error total, a throttled account would be invisible inside
   * it, and that is the one number telling the operator to slow down.
   */
  readonly rateLimited: number;
}

export function failureCountsOf(
  samples: readonly AuditSample[],
): FailureCounts {
  let errors = 0;
  let rateLimited = 0;

  for (const sample of samples) {
    if (sample.outcome === "failed") {
      errors += 1;
    }

    if (sample.kind === "action_executed" && sample.outcome === "blocked") {
      rateLimited += 1;
    }
  }

  return { errors, rateLimited };
}

export interface CapUsage {
  readonly cap: RateCap;
  readonly window: CapWindow;
  readonly used: number;
  readonly limit: number;
  /** Unrounded: rounding is a presentation choice and belongs to the screen. */
  readonly usedPct: number;
  readonly status: CapStatus;
}

/**
 * How each cap is measured. A `Record` over `RATE_CAPS` and not a list, so a
 * cap added to the rate budget fails to compile here instead of quietly
 * dropping off the screen.
 */
const CAP_WINDOWS: Readonly<Record<RateCap, CapWindow>> = {
  private_replies_per_hour: "hour",
  calls_per_second: "second",
  media_calls_per_second: "second",
};

/**
 * Consumption against the caps that exist (REQ-038).
 *
 * What is NOT here is the point. The platform's general quota is a moving
 * 24-hour window derived from the account's impressions, and it cannot be
 * computed locally (REQ-079, and `src/config/limits.ts` says so at length). A
 * bar for it would be an invented number in the one place an operator would
 * trust it most. So this reports the three caps that are real, from counts of
 * work actually concluded, and the 429 count in `FailureCounts` is what tells
 * the operator about the quota nobody local can measure.
 */
export function capUsageOf(
  counts: RateCounts,
  limits: PlatformLimits,
): readonly CapUsage[] {
  const used: Readonly<Record<RateCap, number>> = {
    private_replies_per_hour: counts.privateRepliesLastHour,
    calls_per_second: counts.callsThisSecond,
    media_calls_per_second: counts.mediaCallsThisSecond,
  };

  const capValue: Readonly<Record<RateCap, number>> = {
    private_replies_per_hour: limits.privateRepliesPerHour,
    calls_per_second: limits.callsPerSecond,
    media_calls_per_second: limits.mediaCallsPerSecond,
  };

  return RATE_CAPS.map((cap) => {
    const limit = capValue[cap];
    const consumed = used[cap];
    // A cap of zero admits nothing, so any use of it is full use. Dividing
    // would produce Infinity or NaN and paint a bar nobody can read.
    const usedPct =
      limit <= 0 ? (consumed > 0 ? 100 : 0) : (consumed / limit) * 100;

    return {
      cap,
      window: CAP_WINDOWS[cap],
      used: consumed,
      limit,
      usedPct,
      status: capStatusOf(usedPct, limits),
    };
  });
}

/**
 * Both thresholds come from configuration (`alertThresholdPct` and
 * `criticalThresholdPct`), never from a literal here: an operator who wants to
 * be warned earlier changes an environment variable, not this file.
 *
 * Reaching the threshold signals, rather than only passing it: at exactly 80
 * percent of a cap the operator is as close to it as the number was meant to
 * warn about, and a strict comparison would stay silent on the round figure
 * everyone will check first.
 */
export function capStatusOf(
  usedPct: number,
  limits: PlatformLimits,
): CapStatus {
  if (usedPct >= limits.criticalThresholdPct) {
    return "critical";
  }

  if (usedPct >= limits.alertThresholdPct) {
    return "attention";
  }

  return "normal";
}

/** A queue row as this module reads it: only what REQ-040 asks about. */
export interface PendingWork {
  readonly kind: WorkKind;
  /** When it entered the queue, which is what "the oldest" measures. */
  readonly createdAt: Date;
}

/**
 * The queue, as far as the dashboard is concerned. Declared here and
 * implemented in `./queue.ts`, so the aggregation can be exercised with plain
 * objects.
 */
export interface QueueSource {
  /** Every pending row, whatever its kind and whatever its due instant. */
  pending(): Promise<readonly PendingWork[]>;
}

export interface PendingKind {
  readonly kind: WorkKind;
  readonly pending: number;
  readonly oldestPendingAt?: Date;
}

export interface QueueSnapshot {
  /**
   * Pending ACTIONS: queued sends, and only those (REQ-040).
   *
   * The table is shared by three kinds of waiting (ADR-005), and the other two
   * are not actions. A `credential_check` is a timer the application sets for
   * itself and re-arms forever, so counting it would show a queue that is never
   * empty and an "oldest pending" that means nothing. A `suspension` is a run
   * waiting for the CONTACT to answer, which is the flow working as written,
   * not a backlog. Both stay visible in `byKind` for a screen that wants them.
   */
  readonly pending: number;
  /** Absent when nothing is pending, which is a queue at rest, not an error. */
  readonly oldestPendingAt?: Date;
  /** Every kind with something pending, ordered by name. */
  readonly byKind: readonly PendingKind[];
}

/** The kind whose backlog REQ-040 is about. */
const QUEUED_ACTION: WorkKind = "send";

export function queueSnapshotOf(
  pending: readonly PendingWork[],
): QueueSnapshot {
  const byKind = new Map<WorkKind, { count: number; oldest: Date }>();

  for (const work of pending) {
    const seen = byKind.get(work.kind);

    if (seen === undefined) {
      byKind.set(work.kind, { count: 1, oldest: work.createdAt });
      continue;
    }

    seen.count += 1;
    if (work.createdAt.getTime() < seen.oldest.getTime()) {
      seen.oldest = work.createdAt;
    }
  }

  const actions = byKind.get(QUEUED_ACTION);

  return {
    pending: actions?.count ?? 0,
    ...(actions !== undefined && { oldestPendingAt: actions.oldest }),
    byKind: [...byKind.entries()]
      .map(([kind, seen]) => ({
        kind,
        pending: seen.count,
        oldestPendingAt: seen.oldest,
      }))
      .sort((left, right) => left.kind.localeCompare(right.kind)),
  };
}

/**
 * The slice of a trail entry the recent activity needs, on top of what a count
 * needs. Structural for the same reason `AuditSample` is: an `AuditEntry`
 * satisfies it, so nothing has to be mapped and a test can group plain objects.
 */
export interface ActivitySample extends AuditSample {
  /** The row's own number, which is also the order it was written in. */
  readonly id: number;
  readonly eventId?: string;
  readonly contactId?: string;
  readonly contactUsername?: string;
  readonly eventText?: string;
  readonly flowId?: string;
  readonly stepId?: string;
  readonly automationId?: string;
  readonly executionId?: string;
  readonly publicationId?: string;
  /** Immutable trigger word from a fact written by this execution. */
  readonly matchedKeyword?: string;
  /** Meta's immutable id, present after a confirmed API acceptance. */
  readonly platformMessageId?: string;
  readonly reason?: string;
}

/** One thing the application did about an event, as the trail recorded it. */
export interface ActivityAction {
  readonly at: Date;
  readonly subtype: AuditSubtypeGroup;
  /**
   * The trail's own verdict, and READ AS THE TRAIL WRITES IT. A `message_sent`
   * with outcome `ok` says the step ENQUEUED the message, never that the
   * platform delivered it (see `DashboardMetrics.actions` below), so the screen
   * has to say "accepted for sending" here and never "sent".
   */
  readonly outcome: AuditOutcome;
  readonly flowId?: string;
  readonly stepId?: string;
  readonly automationId?: string;
  /**
   * WHY the step did not do what it was for, as the stable code the engine
   * emitted: deliberately not performed (REQ-068, REQ-163), or failed
   * (REQ-171). The type is the union of the two closed lists and not a string,
   * so whoever reads this field knows what it holds, and the words for it are
   * picked from the catalogue by `actionReasonTextKey`.
   *
   * FOUR different things live in that one column and only these two may travel
   * as this field. The other two are a suppressed EVENT's no-match envelope,
   * read by `silenceOf` above, and a sentence a row stored before REQ-171,
   * which no catalogue can translate. So RECOGNITION decides, never a prefix
   * and never the outcome beside it: membership of the suppression list, or a
   * failure envelope that decodes. Both tests are exact, and the outcome alone
   * would not be, since `suppressed` says only THAT a step fired nothing.
   *
   * An unrecognised reason produces no field, on purpose. It is the same answer
   * `silenceOf` gives with `unreadable`: a phrase this application wrote cannot
   * be translated by a catalogue, and forwarding it would put the wording of
   * whichever language the instance ran in onto the operator's screen.
   */
  readonly reason?: ActionReason;
  /**
   * The datum the code cannot carry (REQ-171): which step, which target, or
   * what the platform answered a step that called out and got a refusal.
   *
   * It crosses under the same rule `eventText` crosses by, and only that rule:
   * it is not this application's wording, so no catalogue owns it and none
   * could. The screen shows it as a QUOTATION beside the translated code, never
   * as the code's own words, and never translated.
   *
   * Never present without `reason`. A detail alone is a fragment attached to a
   * cause nobody could name, which reads on a screen as a sentence the
   * application chose to say.
   */
  readonly detail?: string;
}

/**
 * Why an event fired nothing, as far as this build can read the record.
 *
 * `no_match` carries the aggregate REQ-160 stored: pairs of code and count,
 * decoded by the very module that wrote them. The list is legitimately empty
 * when there was no automation at all to refuse the event, which is a different
 * answer from every automation refusing it, and the screen can tell them apart.
 *
 * `unreadable` is what an honest reader says about a reason it cannot turn into
 * codes: a row written before REQ-160, a refusal code this build does not know
 * (`decodeNoMatch` refuses the whole value on purpose, since skipping one pair
 * would under-report a total the operator reads as complete), or a path that
 * phrased its reason in words. The stored phrase itself deliberately does NOT
 * cross the contract: it is application wording in whatever language the
 * instance wrote it, and putting it on the screen is exactly what REQ-163 and
 * REQ-074 forbid. The screen names this state from the catalogue instead, and
 * the phrase stays where it was written, in the trail.
 */
export const SILENCE_CODES = ["no_match", "unreadable"] as const;

export type SilenceCode = (typeof SILENCE_CODES)[number];

export interface EventSilence {
  readonly code: SilenceCode;
  /** Always present, and empty whenever the code is `unreadable`. */
  readonly refusals: readonly MatchTally[];
}

/**
 * One event, with everything the trail says about it (REQ-164).
 *
 * Grouped by `eventId`, which is the identifier the platform itself gave the
 * delivery and the column the trail indexes. One event is therefore one line,
 * and the screen never has to correlate a message row with the comment that
 * caused it by guessing at instants.
 *
 * One consequence is worth stating rather than discovering. The platform
 * batches, so a single delivery may carry two interactions and the trail then
 * holds two receipts under one identifier. That event is still ONE line here:
 * the arrival facts are the first interaction's and the actions of both are on
 * it, because the identifier the operator can look up is the delivery's. The
 * second text is not lost, it is in the trail, and a screen that needs to split
 * such a line would have to group by contact as well, which is a decision the
 * screen has not asked for.
 */
export interface ActivityEvent {
  readonly eventId: string;
  /** When it arrived: the earliest instant any row of this event carries. */
  readonly at: Date;
  /** What arrived, or the unknown group when no row of the event named it. */
  readonly subtype: AuditSubtypeGroup;
  /**
   * What the trail last said about the ARRIVAL itself, which is not what the
   * actions say: `ok` for an event taken in, `suppressed` for one that fired
   * nothing, `duplicate` for a redelivery the door refused, `failed` for a
   * handler that threw. What was then DONE is `actions`.
   */
  readonly outcome: AuditOutcome;
  readonly contactId?: string;
  /**
   * Who originated it, as the payload named them. Absent when it brought no
   * public identifier, which is every direct message (REQ-162).
   */
  readonly contactUsername?: string;
  /**
   * What the contact wrote, verbatim (REQ-162), and the ONE piece of text this
   * contract carries.
   *
   * It crosses because it is not the application's wording: it is the content
   * of the event, exactly like the contact's identifier and the instant, and
   * the catalogue has no entry for it and never could. It is also the datum the
   * operator needs most on a line that says a keyword did not match. What the
   * screen must not do is translate it or trim it into a sentence of its own.
   *
   * Empty and absent stay different, as the trail keeps them (REQ-162): an
   * empty string is an interaction that carried no text (a sticker, a button),
   * and no field at all is a row that stored none.
   */
  readonly eventText?: string;
  /** In the order they happened, oldest first: a run read as it ran. */
  readonly actions: readonly ActivityAction[];
  /** Present only when the trail recorded the event as firing nothing. */
  readonly silence?: EventSilence;
}

export interface RecentActivity {
  /** Newest first, at most `limit` of them. */
  readonly items: readonly ActivityEvent[];
  /**
   * Every event of the window, the ones past the cap included, so the screen
   * can say the list is cut without having to count what it was not sent. It
   * counts EVENTS and not rows, which is why it differs from `events.total`:
   * one event is several rows, and some rows belong to no event at all.
   */
  readonly total: number;
  /** The cap that was applied, so the screen reads it instead of assuming it. */
  readonly limit: number;
  /**
   * The same recent window reduced by immutable execution identity.  `items`
   * stays event-shaped for existing consumers, while this collection gives the
   * activity detail one complete, correlated lifecycle per automation run.
   * Facts without an execution id deliberately stay out: joining them to a
   * run by contact or by a nearby instant would invent history.
   */
  readonly executions: readonly ExecutionLifecycle[];
  /** Every execution in the window, including ones after the display cap. */
  readonly executionTotal: number;
}

/** The only outbound states the application can prove from its own facts. */
export const MESSAGE_LIFECYCLE_STATUSES = [
  "queued",
  "accepted",
  "seen",
  "failed",
] as const;

export type MessageLifecycleStatus =
  (typeof MESSAGE_LIFECYCLE_STATUSES)[number];

/** A durable timeline fact, named by what was observed rather than inferred. */
export type ExecutionLifecycleEventKind =
  | "received"
  | "action"
  | "message_queued"
  | "message_accepted"
  | "message_echoed"
  | "message_seen"
  | "message_failed"
  | "clicked";

export interface ExecutionLifecycleEvent {
  readonly at: Date;
  readonly kind: ExecutionLifecycleEventKind;
  readonly subtype?: AuditSubtypeGroup;
  readonly outcome?: AuditOutcome;
  readonly reason?: string;
  readonly detail?: string;
  readonly platformMessageId?: string;
  /** The queue fact this message outcome belongs to, when it can be proven. */
  readonly messageId?: number;
  /** A click keeps the immutable label captured at the click, when available. */
  readonly buttonLabel?: string;
}

/** One message's facts. Its id is the immutable row that put it in the queue. */
export interface MessageLifecycle {
  readonly id: number;
  readonly status: MessageLifecycleStatus;
  readonly events: readonly ExecutionLifecycleEvent[];
  readonly platformMessageId?: string;
}

/** A compact, countable answer for runs with one or more direct messages. */
export interface MessageLifecycleSummary {
  readonly total: number;
  readonly queued: number;
  readonly accepted: number;
  readonly seen: number;
  readonly failed: number;
  /** The most recently observed safe state, never a delivery claim. */
  readonly latestStatus?: MessageLifecycleStatus;
}

/** The execution-level model consumed by the activity detail. */
export interface ExecutionLifecycle {
  readonly executionId: string;
  /** First and latest persisted facts, so a UI never has to derive ordering. */
  readonly at: Date;
  readonly updatedAt: Date;
  readonly messages: readonly MessageLifecycle[];
  readonly summary: MessageLifecycleSummary;
  /** All available immutable facts in chronological order, including clicks. */
  readonly events: readonly ExecutionLifecycleEvent[];
}

/**
 * How many events the report carries.
 *
 * A cap, and not the whole window, because the window is bounded but the
 * traffic in it is not: thirty days of a busy account is tens of thousands of
 * events, each with its own text, and sending them all would turn one panel
 * request into megabytes nobody scrolls. Fifty is a few screenfuls of the most
 * recent activity, which is what this list is for; the counts above it already
 * answer "how much happened", and `total` says how much was left out.
 */
export const RECENT_ACTIVITY_LIMIT = 50;

function silenceOf(reason: string | undefined): EventSilence {
  // Decoded by the module that wrote the value, never by a second reader here:
  // two parsers of one format drift the day the format gains a field.
  const refusals = decodeNoMatch(reason);

  return refusals === undefined
    ? { code: "unreadable", refusals: [] }
    : { code: "no_match", refusals };
}

/** One event under construction. Mutable, and never leaves this module. */
interface EventGroup {
  eventId: string;
  at: Date;
  order: number;
  subtype: AuditSubtypeGroup;
  outcome: AuditOutcome;
  contactId?: string;
  contactUsername?: string;
  eventText?: string;
  actions: ActivityAction[];
  silence?: EventSilence;
}

/**
 * The reason column, read (REQ-163, REQ-171).
 *
 * Recognised, never guessed at, and each vocabulary decoded by the module that
 * WROTE it: a suppression is a bare member of the engine's closed list, and a
 * failure is the envelope `execution-audit.ts` writes and reads back. Anything
 * else, a phrase included, answers nothing at all, which is the same honest
 * answer `silenceOf` gives an event whose reason it cannot read.
 */
function whyOf(reason: string | undefined): {
  reason?: ActionReason;
  detail?: string;
} {
  if (isSuppressionReason(reason)) {
    return { reason };
  }

  const failure = decodeExecutionFailure(reason);

  return failure === undefined
    ? {}
    : {
        reason: failure.reason,
        ...(failure.detail !== undefined && { detail: failure.detail }),
      };
}

function actionOf(sample: ActivitySample): ActivityAction {
  return {
    at: sample.occurredAt,
    subtype: subtypeGroupOf(sample),
    outcome: sample.outcome,
    ...(sample.flowId !== undefined && { flowId: sample.flowId }),
    ...(sample.stepId !== undefined && { stepId: sample.stepId }),
    ...(sample.automationId !== undefined && {
      automationId: sample.automationId,
    }),
    ...whyOf(sample.reason),
  };
}

function finish(group: EventGroup): ActivityEvent {
  return {
    eventId: group.eventId,
    at: group.at,
    subtype: group.subtype,
    outcome: group.outcome,
    ...(group.contactId !== undefined && { contactId: group.contactId }),
    ...(group.contactUsername !== undefined && {
      contactUsername: group.contactUsername,
    }),
    // Compared against undefined and NOT tested for truth: the empty text is
    // the case that has to survive, and it is the falsy one (REQ-162).
    ...(group.eventText !== undefined && { eventText: group.eventText }),
    actions: group.actions,
    ...(group.silence !== undefined && { silence: group.silence }),
  };
}

/**
 * The window's events, each with what arrived, what was done, and why nothing
 * was (REQ-164).
 *
 * The caller decides WHICH samples are read; this function only groups them,
 * which is what keeps it on the same array the counts came from.
 *
 * Entries that name no event are skipped, and they are the ones no line could
 * honestly carry: a delivery whose signature did not verify belongs to no event
 * (nothing in that body was established as coming from the platform), and an
 * alert is the application talking to the operator rather than something a
 * contact did. Neither is lost: both are counted in `failures` and in the
 * breakdowns above.
 */
export function recentActivityOf(
  samples: readonly ActivitySample[],
  limit: number = RECENT_ACTIVITY_LIMIT,
  clicks: readonly ButtonClickSample[] = [],
): RecentActivity {
  // Oldest first, by the instant and then by the row number, BEFORE anything is
  // grouped. The caller reads the trail newest first, and every rule below
  // ("the first row that named an origin", "the last word on the arrival", the
  // order of the actions) would otherwise depend on how the query happened to
  // sort, which is how two reads of one period produce two different reports.
  const ordered = [...samples].sort(
    (left, right) =>
      left.occurredAt.getTime() - right.occurredAt.getTime() ||
      left.id - right.id,
  );

  const groups = new Map<string, EventGroup>();

  for (const sample of ordered) {
    const eventId = sample.eventId;

    if (eventId === undefined || sample.kind === "alert") {
      continue;
    }

    let group = groups.get(eventId);

    if (group === undefined) {
      group = {
        eventId,
        // The arrival, and correct because of the sort above: the first row of
        // a group is its earliest one.
        at: sample.occurredAt,
        order: sample.id,
        subtype: UNKNOWN_SUBTYPE,
        outcome: sample.outcome,
        actions: [],
      };
      groups.set(eventId, group);
    }

    group.order = sample.id;

    if (sample.kind === "action_executed") {
      group.actions.push(actionOf(sample));
      continue;
    }

    // An `event_received` row, which is the arrival speaking. The last one wins
    // the outcome: the door writes its receipt first and whatever became of the
    // event is written after it.
    group.outcome = sample.outcome;

    if (group.subtype === UNKNOWN_SUBTYPE && sample.subtype !== undefined) {
      group.subtype = sample.subtype;
    }

    if (group.contactId === undefined && sample.contactId !== undefined) {
      group.contactId = sample.contactId;
    }

    if (
      group.contactUsername === undefined &&
      sample.contactUsername !== undefined
    ) {
      group.contactUsername = sample.contactUsername;
    }

    if (group.eventText === undefined && sample.eventText !== undefined) {
      group.eventText = sample.eventText;
    }

    if (sample.outcome === "suppressed" && group.silence === undefined) {
      group.silence = silenceOf(sample.reason);
    }
  }

  const items = [...groups.values()]
    // Newest first, because an operator opens this list to see what just
    // happened, and the row number breaks a tie so the order never depends on
    // how a map happened to be filled.
    .sort(
      (left, right) =>
        right.at.getTime() - left.at.getTime() || right.order - left.order,
    )
    .slice(0, Math.max(limit, 0))
    .map(finish);

  const executions = executionLifecyclesOf(samples, clicks, limit);

  return {
    items,
    total: groups.size,
    limit,
    executions: executions.items,
    executionTotal: executions.total,
  };
}

interface MutableMessageLifecycle {
  readonly id: number;
  status: MessageLifecycleStatus;
  readonly events: ExecutionLifecycleEvent[];
  platformMessageId?: string;
}

interface MutableExecutionLifecycle {
  readonly executionId: string;
  readonly samples: ActivitySample[];
  readonly clicks: ButtonClickSample[];
}

/** The platform receipt codes are facts, unlike a plain queued message step. */
function lifecycleKindOf(sample: ActivitySample): ExecutionLifecycleEventKind {
  if (sample.kind === "event_received") return "received";
  if (sample.subtype !== "message_sent") return "action";
  if (sample.reason === "platform_accepted") return "message_accepted";
  if (sample.reason === "platform_echo") return "message_echoed";
  if (sample.reason === "platform_seen") return "message_seen";
  if (sample.outcome === "failed") return "message_failed";
  return "message_queued";
}

function lifecycleEventOf(
  sample: ActivitySample,
  kind: ExecutionLifecycleEventKind,
  messageId?: number,
): ExecutionLifecycleEvent {
  const failure = whyOf(sample.reason);
  const detail =
    failure.detail ?? (kind === "message_failed" ? sample.reason : undefined);
  return {
    at: sample.occurredAt,
    kind,
    ...(sample.subtype !== undefined && { subtype: sample.subtype }),
    outcome: sample.outcome,
    ...(failure.reason !== undefined && { reason: failure.reason }),
    ...(detail !== undefined && { detail }),
    ...(sample.platformMessageId !== undefined && {
      platformMessageId: sample.platformMessageId,
    }),
    ...(messageId !== undefined && { messageId }),
  };
}

function clickLifecycleEventOf(
  click: ButtonClickSample,
): ExecutionLifecycleEvent {
  return {
    at: click.occurredAt,
    kind: "clicked",
    ...(click.buttonLabel !== undefined && { buttonLabel: click.buttonLabel }),
  };
}

/**
 * Replays one execution's append-only facts.  A queue fact is the identity of
 * a DM before Meta assigns its id.  Later results consume those queue facts in
 * their observed order, matching the durable sender's oldest-first sweep.
 *
 * The pairing deliberately happens only inside one execution.  A contact can
 * have several automations in flight, and correlating a receipt merely by its
 * contact id would let one run rewrite another run's history.
 */
function messagesOf(
  samples: readonly ActivitySample[],
): readonly MessageLifecycle[] {
  const messages: MutableMessageLifecycle[] = [];
  const byPlatformMessageId = new Map<string, MutableMessageLifecycle>();

  const nextForResult = (): MutableMessageLifecycle | undefined =>
    messages.find((message) => message.status === "queued") ??
    messages.find((message) => message.status === "failed");

  const latestAccepted = (): MutableMessageLifecycle | undefined =>
    [...messages]
      .reverse()
      .find(
        (message) => message.status === "accepted" || message.status === "seen",
      );

  for (const sample of samples) {
    const kind = lifecycleKindOf(sample);
    if (kind === "message_queued") {
      const message: MutableMessageLifecycle = {
        id: sample.id,
        status: "queued",
        events: [],
      };
      message.events.push(lifecycleEventOf(sample, kind, message.id));
      messages.push(message);
      continue;
    }

    if (
      kind !== "message_accepted" &&
      kind !== "message_echoed" &&
      kind !== "message_seen" &&
      kind !== "message_failed"
    ) {
      continue;
    }

    const message =
      (sample.platformMessageId === undefined
        ? undefined
        : byPlatformMessageId.get(sample.platformMessageId)) ??
      (kind === "message_seen" ? latestAccepted() : nextForResult());

    // A receipt without the matching queue fact is still shown in the
    // execution timeline below.  It must not manufacture a message result.
    if (message === undefined) continue;

    if (kind === "message_accepted") {
      message.status = "accepted";
      if (sample.platformMessageId !== undefined) {
        message.platformMessageId = sample.platformMessageId;
        byPlatformMessageId.set(sample.platformMessageId, message);
      }
    } else if (kind === "message_seen") {
      message.status = "seen";
    } else if (kind === "message_failed") {
      message.status = "failed";
    }
    message.events.push(lifecycleEventOf(sample, kind, message.id));
  }

  return messages.map((message) => ({
    id: message.id,
    status: message.status,
    events: message.events,
    ...(message.platformMessageId !== undefined && {
      platformMessageId: message.platformMessageId,
    }),
  }));
}

function messageSummaryOf(
  messages: readonly MessageLifecycle[],
): MessageLifecycleSummary {
  const counts: Record<MessageLifecycleStatus, number> = {
    queued: 0,
    accepted: 0,
    seen: 0,
    failed: 0,
  };
  let latest: { at: Date; status: MessageLifecycleStatus } | undefined;

  for (const message of messages) {
    counts[message.status] += 1;
    const at = message.events.at(-1)?.at;
    if (at !== undefined && (latest === undefined || at > latest.at)) {
      latest = { at, status: message.status };
    }
  }

  return {
    total: messages.length,
    ...counts,
    ...(latest !== undefined && { latestStatus: latest.status }),
  };
}

/**
 * Execution-level view used by the activity detail.  Facts remain in their
 * original order and no missing lifecycle step is filled in from today's flow
 * definition or from another run of the same contact.
 */
export function executionLifecyclesOf(
  samples: readonly ActivitySample[],
  clicks: readonly ButtonClickSample[] = [],
  limit: number = RECENT_ACTIVITY_LIMIT,
): { readonly items: readonly ExecutionLifecycle[]; readonly total: number } {
  const groups = new Map<string, MutableExecutionLifecycle>();
  const executionIdsByEvent = new Map<string, Set<string>>();

  for (const sample of samples) {
    if (sample.executionId === undefined) continue;
    const group = groups.get(sample.executionId) ?? {
      executionId: sample.executionId,
      samples: [],
      clicks: [],
    };
    group.samples.push(sample);
    groups.set(sample.executionId, group);
    if (sample.eventId !== undefined) {
      const ids = executionIdsByEvent.get(sample.eventId) ?? new Set<string>();
      ids.add(sample.executionId);
      executionIdsByEvent.set(sample.eventId, ids);
    }
  }

  // The inbound receipt predates the execution id being allocated.  It is a
  // durable fact of every run the same event actually started, so copying the
  // fact into each named run is correlation by the event's own id, not a guess.
  for (const sample of samples) {
    if (sample.kind !== "event_received" || sample.eventId === undefined)
      continue;
    for (const executionId of executionIdsByEvent.get(sample.eventId) ?? []) {
      groups.get(executionId)?.samples.push(sample);
    }
  }

  for (const click of clicks) {
    const group = groups.get(click.executionId) ?? {
      executionId: click.executionId,
      samples: [],
      clicks: [],
    };
    group.clicks.push(click);
    groups.set(click.executionId, group);
  }

  const all: ExecutionLifecycle[] = [];
  for (const group of groups.values()) {
    const ordered = [
      ...new Map(group.samples.map((sample) => [sample.id, sample])).values(),
    ].sort(
      (left, right) =>
        left.occurredAt.getTime() - right.occurredAt.getTime() ||
        left.id - right.id,
    );
    const messages = messagesOf(ordered);
    const events = [
      ...ordered.map((sample) => {
        const kind = lifecycleKindOf(sample);
        const messageId = kind === "message_queued" ? sample.id : undefined;
        return lifecycleEventOf(sample, kind, messageId);
      }),
      ...group.clicks.map(clickLifecycleEventOf),
    ].sort((left, right) => left.at.getTime() - right.at.getTime());
    const at = events[0]?.at ?? group.clicks[0]?.occurredAt;
    const updatedAt = events.at(-1)?.at ?? at;
    if (at === undefined || updatedAt === undefined) continue;
    all.push({
      executionId: group.executionId,
      at,
      updatedAt,
      messages,
      summary: messageSummaryOf(messages),
      events,
    });
  }
  all.sort(
    (left, right) =>
      right.updatedAt.getTime() - left.updatedAt.getTime() ||
      right.executionId.localeCompare(left.executionId),
  );

  return { items: all.slice(0, Math.max(limit, 0)), total: all.length };
}

export interface DashboardMetrics {
  readonly window: RangeWindow;
  /**
   * Inbound events by type (REQ-036), counted whatever the application then
   * did with them: an event that arrived and was suppressed, or refused, or
   * already known, still arrived. What was DONE about it is the next field.
   */
  readonly events: TypeBreakdown;
  /**
   * Actions by type (REQ-037), counted only where the outcome is `ok`, which
   * is the trail's own definition of an action that happened (see
   * `src/storage/audit.ts`). A step deliberately not performed (REQ-068) is
   * recorded as the message step it was, and counting it would report a
   * message nobody received.
   *
   * READ THIS AS "ACCEPTED FOR SENDING", NOT AS "DELIVERED", and the
   * distinction is the trail's, not this module's. The `message_sent` row with
   * outcome `ok` is written when the step ENQUEUES the message; the delivery
   * happens later, in the sweep, which writes NO second row on success
   * precisely so nothing is counted twice. A delivery that then fails adds its
   * own `failed` row, which lands in `failures.errors`.
   *
   * So the correction is additive: the accepted count never goes down, and a
   * period showing accepted messages beside a non-zero error count is showing
   * both halves of the same story. The alternative (waiting for delivery to
   * count anything) would mean an append-only trail that has to be rewritten,
   * or an operator whose chart is empty while messages are going out. The
   * screen must therefore label this "accepted for sending" and never "sent",
   * and show the error count next to it.
   */
  readonly actions: TypeBreakdown;
  readonly caps: readonly CapUsage[];
  readonly failures: FailureCounts;
  readonly queue: QueueSnapshot;
  /**
   * The same window, event by event (REQ-164), from the same read the counts
   * above came from. Beside them and not behind a route of its own precisely
   * for that reason: a second route would be a second read at a second instant,
   * and a list that disagreed with the totals printed above it is the one
   * failure a panel cannot argue its way out of.
   */
  readonly activity: RecentActivity;
  /** Link engagement recorded by this application, without CTR or PII. */
  readonly links: LinkAnalytics;
}

export interface LinkTrend {
  readonly granularity: BucketGranularity;
  readonly buckets: readonly Date[];
  readonly counts: readonly number[];
  readonly total: number;
}

export interface LinkTotals {
  readonly clicks: number;
  readonly uniqueContacts: number;
  readonly automations: number;
  readonly publications: number;
}

export interface PostFunnel {
  readonly publicationId: string;
  /** Cache snapshot, absent when the publication is no longer cached. */
  readonly publication?: PostPublication;
  readonly comments: number;
  /**
   * Facts the post detail can show without re-reading today's automation.
   * Historic comments keep their original text, while new facts can also name
   * the stored trigger word that matched at execution time.
   */
  readonly commentDetails: readonly CommentDetail[];
  readonly publicReplies: number;
  readonly acceptedMessages: number;
  readonly clicks: number;
  readonly uniqueContacts: number;
  /** Link labels are click snapshots, never resolved from a current flow. */
  readonly links: readonly PostLinkAnalytics[];
}

/** The small, cache-owned presentation snapshot a dashboard post needs. */
export interface PostPublication {
  readonly id: string;
  readonly caption?: string;
  readonly thumbnailKey?: string;
}

/** A comment's durable detail. `matchedKeyword` is absent for legacy facts. */
export interface CommentDetail {
  readonly text?: string;
  readonly matchedKeyword?: string;
}

/** One historical destination in a post, grouped without exposing automation. */
export interface PostLinkAnalytics {
  /** Absent for a click written before the button-label snapshot existed. */
  readonly label?: string;
  readonly clicks: number;
  readonly uniqueContacts: number;
}

export interface ButtonVersionAnalytics {
  readonly automationId: string;
  readonly buttonId: string;
  readonly destinationVersion: number;
  readonly clicks: number;
  readonly uniqueContacts: number;
}

export interface LinkAnalytics {
  readonly totals: LinkTotals;
  readonly trend: LinkTrend;
  readonly posts: readonly PostFunnel[];
  /** Historic facts with no persisted post snapshot, never guessed. */
  readonly unattributedClicks: number;
  readonly buttons: readonly ButtonVersionAnalytics[];
}

/** The application-owned click facts required by the dashboard. */
export interface LinkClickSource {
  samples(since: Date, until: Date): Promise<readonly ButtonClickSample[]>;
}

/** The dashboard only needs already-cached publication facts, never the API. */
export interface PublicationCacheSource {
  byIds(ids: readonly string[]): Promise<readonly PostPublication[]>;
}

export interface DashboardSources {
  readonly audit: AuditRepository;
  /** Concluded sends, which is what the rate budget counts (REQ-038). */
  readonly work: DurableWorkStore;
  readonly queue: QueueSource;
  readonly limits: PlatformLimits;
  /**
   * The zone the instance counts in (REQ-153), from its configuration. Beside
   * the limits and for the same reason: it is a decision this module applies
   * and never makes, and it changes the numbers rather than their wording.
   */
  readonly zone: string;
  readonly clicks: LinkClickSource;
  /** Optional only while an old composition is upgraded; absence is honest. */
  readonly publications?: PublicationCacheSource;
}

function linkTrendOf(
  clicks: readonly ButtonClickSample[],
  window: RangeWindow,
): LinkTrend {
  const buckets = bucketStartsOf(window);
  const positions = new Map(
    buckets.map((bucket, index) => [bucket.getTime(), index]),
  );
  const counts = new Array<number>(buckets.length).fill(0);
  for (const click of clicks) {
    const position = positions.get(
      bucketStartOf(
        click.occurredAt,
        window.granularity,
        window.zone,
      ).getTime(),
    );
    if (position !== undefined) counts[position] = (counts[position] ?? 0) + 1;
  }
  return {
    granularity: window.granularity,
    buckets,
    counts,
    total: clicks.length,
  };
}

/**
 * Reads the publication snapshot of each click's immutable execution. A click
 * that predates this snapshot remains explicit as unattributed; it is never
 * classified by the automation's current configuration.
 */
async function linkAnalyticsOf(
  clicks: readonly ButtonClickSample[],
  entries: readonly ActivitySample[],
  audit: AuditRepository,
  window: RangeWindow,
  publications?: PublicationCacheSource,
): Promise<LinkAnalytics> {
  const publicationsByExecution = new Map<string, string>();
  for (const entry of entries) {
    if (entry.executionId !== undefined && entry.publicationId !== undefined) {
      publicationsByExecution.set(entry.executionId, entry.publicationId);
    }
  }
  const missing = [
    ...new Set(
      clicks
        .map((click) => click.executionId)
        .filter((executionId) => !publicationsByExecution.has(executionId)),
    ),
  ];
  await Promise.all(
    missing.map(async (executionId) => {
      const facts = await audit.query({ executionId, order: "oldest" });
      const publicationId = facts.find(
        (fact) => fact.publicationId !== undefined,
      )?.publicationId;
      if (publicationId !== undefined) {
        publicationsByExecution.set(executionId, publicationId);
      }
    }),
  );

  interface CollectedPost {
    comments: number;
    commentDetails: CommentDetail[];
    publicReplies: number;
    acceptedMessages: number;
    clicks: number;
    contacts: Set<string>;
    links: Map<
      string,
      { label?: string; clicks: number; contacts: Set<string> }
    >;
  }
  const matchedKeywordsByExecution = new Map<string, string>();
  for (const entry of entries) {
    if (entry.executionId !== undefined && entry.matchedKeyword !== undefined) {
      matchedKeywordsByExecution.set(entry.executionId, entry.matchedKeyword);
    }
  }
  const posts = new Map<string, CollectedPost>();
  const postOf = (publicationId: string): CollectedPost => {
    let post = posts.get(publicationId);
    if (post === undefined) {
      post = {
        comments: 0,
        commentDetails: [],
        publicReplies: 0,
        acceptedMessages: 0,
        clicks: 0,
        contacts: new Set<string>(),
        links: new Map(),
      };
      posts.set(publicationId, post);
    }
    return post;
  };
  for (const entry of entries) {
    if (entry.publicationId === undefined) continue;
    const post = postOf(entry.publicationId);
    if (entry.kind === "event_received" && entry.subtype === "comment") {
      post.comments += 1;
      const matchedKeyword =
        entry.executionId === undefined
          ? undefined
          : matchedKeywordsByExecution.get(entry.executionId);
      if (entry.eventText !== undefined || matchedKeyword !== undefined) {
        post.commentDetails.push({
          ...(entry.eventText !== undefined && { text: entry.eventText }),
          ...(matchedKeyword !== undefined && { matchedKeyword }),
        });
      }
    }
    if (
      entry.kind === "action_executed" &&
      entry.outcome === "ok" &&
      entry.subtype === "comment_reply"
    ) {
      post.publicReplies += 1;
    }
    if (
      entry.kind === "action_executed" &&
      entry.outcome === "ok" &&
      entry.subtype === "message_sent"
    ) {
      post.acceptedMessages += 1;
    }
    if (entry.contactId !== undefined) post.contacts.add(entry.contactId);
  }

  interface CollectedButton {
    automationId: string;
    buttonId: string;
    destinationVersion: number;
    clicks: number;
    contacts: Set<string>;
  }
  const buttons = new Map<string, CollectedButton>();
  const automations = new Set<string>();
  const contacts = new Set<string>();
  let unattributedClicks = 0;
  for (const click of clicks) {
    automations.add(click.automationId);
    contacts.add(click.contactId);
    const key = `${click.automationId}\u0000${click.buttonId}\u0000${click.destinationVersion}`;
    let button = buttons.get(key);
    if (button === undefined) {
      button = {
        automationId: click.automationId,
        buttonId: click.buttonId,
        destinationVersion: click.destinationVersion,
        clicks: 0,
        contacts: new Set<string>(),
      };
      buttons.set(key, button);
    }
    button.clicks += 1;
    button.contacts.add(click.contactId);

    const publicationId = publicationsByExecution.get(click.executionId);
    if (publicationId === undefined) {
      unattributedClicks += 1;
      continue;
    }
    const post = postOf(publicationId);
    post.clicks += 1;
    post.contacts.add(click.contactId);
    const labelKey = click.buttonLabel ?? "";
    let link = post.links.get(labelKey);
    if (link === undefined) {
      link = {
        ...(click.buttonLabel !== undefined && { label: click.buttonLabel }),
        clicks: 0,
        contacts: new Set<string>(),
      };
      post.links.set(labelKey, link);
    }
    link.clicks += 1;
    link.contacts.add(click.contactId);
  }

  const cachedPublications = new Map(
    publications === undefined
      ? []
      : (await publications.byIds([...posts.keys()])).map((publication) => [
          publication.id,
          publication,
        ]),
  );

  return {
    totals: {
      clicks: clicks.length,
      uniqueContacts: contacts.size,
      automations: automations.size,
      publications: posts.size,
    },
    trend: linkTrendOf(clicks, window),
    posts: [...posts.entries()]
      .map(([publicationId, post]) => ({
        publicationId,
        ...(cachedPublications.get(publicationId) !== undefined && {
          publication: cachedPublications.get(publicationId),
        }),
        comments: post.comments,
        commentDetails: post.commentDetails,
        publicReplies: post.publicReplies,
        acceptedMessages: post.acceptedMessages,
        clicks: post.clicks,
        uniqueContacts: post.contacts.size,
        links: [...post.links.values()]
          .map((link) => ({
            ...(link.label !== undefined && { label: link.label }),
            clicks: link.clicks,
            uniqueContacts: link.contacts.size,
          }))
          .sort((left, right) =>
            (left.label ?? "").localeCompare(right.label ?? ""),
          ),
      }))
      .sort((left, right) =>
        left.publicationId.localeCompare(right.publicationId),
      ),
    unattributedClicks,
    buttons: [...buttons.values()]
      .map((button) => ({
        automationId: button.automationId,
        buttonId: button.buttonId,
        destinationVersion: button.destinationVersion,
        clicks: button.clicks,
        uniqueContacts: button.contacts.size,
      }))
      .sort(
        (left, right) =>
          left.automationId.localeCompare(right.automationId) ||
          left.buttonId.localeCompare(right.buttonId) ||
          left.destinationVersion - right.destinationVersion,
      ),
  };
}

/**
 * The whole report for one range.
 *
 * The trail is read ONCE for the window and every count is derived from that
 * one array, rather than issuing a query per type. Two reasons: a screen that
 * fires a dozen queries makes each of them a chance to disagree with the
 * others (they would run at slightly different instants), and grouping in SQL
 * means `strftime`, which is SQLite only, while ADR-002 keeps the door open for
 * PostgreSQL without rewriting callers. The window is bounded, so the array is
 * the traffic of at most thirty days on one account.
 */
export async function readDashboardMetrics(
  sources: DashboardSources,
  range: DashboardRange,
  now: Date,
): Promise<DashboardMetrics> {
  const window = windowOf(range, now, sources.zone);

  const [entries, rateCounts, pending, clicks] = await Promise.all([
    sources.audit.query({ since: window.since, until: window.until }),
    readRateCounts(sources.work, now),
    sources.queue.pending(),
    sources.clicks.samples(window.since, window.until),
  ]);

  const events = entries.filter((entry) => entry.kind === "event_received");
  const actions = entries.filter(
    (entry) => entry.kind === "action_executed" && entry.outcome === "ok",
  );

  return {
    window,
    events: breakdownOf(events, window),
    actions: breakdownOf(actions, window),
    caps: capUsageOf(rateCounts, sources.limits),
    // Over every entry of the window, not only the actions: an event refused
    // at the door failed too.
    failures: failureCountsOf(entries),
    queue: queueSnapshotOf(pending),
    // `entries` again, and that is the whole point: the list an operator reads
    // and the numbers printed above it come from ONE read of the trail, so no
    // line can contradict a total by having been fetched a moment later.
    activity: recentActivityOf(entries, RECENT_ACTIVITY_LIMIT, clicks),
    links: await linkAnalyticsOf(
      clicks,
      entries,
      sources.audit,
      window,
      sources.publications,
    ),
  };
}
