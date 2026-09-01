import { useCallback, useEffect, useId, useMemo, useState } from "react";
import type { ReactElement } from "react";
import {
  Button,
  CapMeter,
  Chip,
  DataTable,
  EmptyState,
  Icon,
  ICON_SIZE,
  Modal,
  Notice,
  PendingState,
  StatusBadge,
  TrendChart,
} from "../components/index.js";
import type {
  BadgeState,
  ChipTone,
  IconName,
  TableColumn,
  TableRow,
  TableTotal,
  TrendSeries,
} from "../components/index.js";
import {
  EXECUTION_FAILURE_REASONS,
  SUPPRESSION_REASONS,
} from "../../engine/execute.js";
import type { ActionReason } from "../../engine/execute.js";
import { MATCH_REFUSALS } from "../../flows/matching.js";
import type { MatchRefusal } from "../../flows/matching.js";
import {
  actionOutcomeTextKey,
  actionReasonTextKey,
  ACTIVITY_OUTCOMES,
  ACTIVITY_SILENCES,
  activitySilenceTextKey,
  arrivalTextKey,
  executionFailureTextKey,
  matchRefusalTextKey,
  suppressionTextKey,
} from "../../i18n/engine-reasons.js";
import type {
  ActivityOutcome,
  ActivitySilence,
} from "../../i18n/engine-reasons.js";
import { useLocale } from "../locale.js";
import { isUnauthorizedFailure } from "../http-failure.js";
import { SessionExpiredNotice } from "../session-expired.js";

/**
 * The operator's panel (REQ-036 to REQ-040, REQ-115), dressed.
 *
 * It PRESENTS and never computes. Every number on this page arrives already
 * decided by `src/dashboard/aggregate.ts` and travels over
 * `GET /api/dashboard/metrics?range=`: the bucketing, the per-type split, the
 * percentage against each cap and the status derived from the configured
 * thresholds are all made there, once, from a single read of the trail. A
 * screen that recomputed any of it would be a second opinion nobody asked for,
 * and the two would disagree the day a threshold moved.
 *
 * ONE BLOCK PER NATURE OF INFORMATION, which is the fix the design handoff asks
 * for: the figures of the period, consumption against a ceiling, the shape over
 * time and counting over time are different questions, and in the interface
 * this replaces they all looked like the same stack of paragraphs. Each block
 * is a `section` with
 * its own heading, which is also what makes each one a region a screen reader
 * can jump between, and the ORDER of them is a requirement rather than a taste:
 *
 *   - the band of figures for the period (REQ-177): the numbers that answer
 *     "is it working?", ABOVE everything else on the page that carries a datum;
 *   - consumption against the caps (REQ-178): a ceiling and how much of it is
 *     spent. SECOND, and no longer at the foot of the page, because it is what
 *     an operator looks for in a hurry when something is going wrong in public;
 *   - the volume of the period (REQ-179): ONE drawing, in which what arrived
 *     and what was done are cut over the same periods and measured against the
 *     same scale, so the two can be read one against the other;
 *   - events received, and actions performed: counting over time, each a table
 *     with the granularity marked in its head. These two do NOT open with the
 *     page (REQ-180): they sit behind a control the page names, and `Detail`
 *     below says why;
 *   - the recent activity, event by event, LAST, for the reason its own block
 *     records: it is the only one as tall as the traffic.
 *
 * Three decisions the aggregation left explicitly to this file, each one a
 * place where showing the raw number would mislead:
 *
 *   - the `unknown` group is NOT a series beside the types. The `/webhook`
 *     route writes one row per DELIVERY with no subtype, because a single
 *     accepted body may carry a comment and a direct message at once. Drawn as
 *     a column it would stand as tall as the traffic itself, right next to the
 *     very types it is made of. So it is reported apart, as its own labelled
 *     figure ("Deliveries" for events, "Unspecified" for actions), and the
 *     recorded total beside it is the one figure that includes both halves.
 *   - actions are counted at ENQUEUEING, so "messages" here means accepted for
 *     sending and never confirmed delivered. `dashboard.acceptedNote` says so
 *     and travels INSIDE the actions block, as the table's own caption, which
 *     is announced with the table and before the figures it qualifies. A note
 *     in a page footer is a note nobody reads, and a HEADLINE figure is read
 *     without any note being read at all, which is why the band names that
 *     count with the same sentence and stands the error count beside it
 *     (REQ-181);
 *   - two of the three caps measure the CURRENT SECOND, so they read zero
 *     almost every time the page is opened. That is honest, and a bar pinned at
 *     zero forever is not: it reads as a broken widget. Those two are text
 *     only, with a sentence explaining the window, and the meter is kept for the
 *     hourly cap, the only one whose window is long enough for a filling bar to
 *     mean anything.
 *
 * THE TABLES STAY, AND THE DRAWING IS ONE. The tables were chosen rather than
 * settled for: the values ARE the answer to "does this match the record", every
 * one of them is readable by a screen reader in the row and column that name
 * it, and nothing in them is carried by a colour or a pixel height. What is
 * ADDED, and never traded for them (REQ-154):
 *
 *   - a proportional bar INSIDE the numeric cell (`bars`): the figure stays
 *     exactly where it was and the bar sits beside it, hidden from assistive
 *     technology, because it says nothing the figure does not already say;
 *   - ONE `TrendChart`, in a block of its own, one strip per type, which is the
 *     reading a table of thirty rows cannot give: the SHAPE of the counts,
 *     whether the traffic is flat or peaked at nine in the morning, seen
 *     instead of read one row at a time. Identity is carried by the NAME beside
 *     each strip and the nature by a written heading over each run of them, so
 *     there is no legend and no colour to tell apart.
 *
 * ONE FRAME AND NOT TWO (REQ-179), and the reason is arithmetic rather than
 * tidiness: `TrendChart` scales every strip against the tallest column IN THE
 * DRAWING, so two drawings side by side each had a scale of their own and two
 * strips of the same height meant two different quantities. Cut over the same
 * buckets and measured against one scale, "more arrived than was done about it"
 * becomes a thing an operator SEES instead of a pair of pictures they have to
 * hold in their head. Nothing is recomputed to achieve it: the strips are the
 * very series the aggregation already decided, drawn in one place.
 *
 * What the drawing deliberately leaves out is everything on this page that is
 * NOT a series over time. The caps already have a meter, which is a length
 * against a ceiling somebody declared, and drawing them twice would say the same
 * thing in two shapes. The band is single figures, and a chart of one number is
 * decoration. The unknown group is not drawn for the very reason it is not a
 * column: it is made of the same deliveries the types are made of, so a strip
 * beside them would show the same traffic twice.
 */

/**
 * Where the panel lives, as `src/web/routes.tsx` registers it.
 *
 * Exported because another screen leads HERE: the access screen takes the
 * operator to the panel once the session is open (REQ-146), and the address it
 * navigates to has to be the one the route table answers, not a second copy of
 * the same string. `src/web/app.test.tsx` checks that the table carries it.
 */
export const DASHBOARD_ADDRESS = "/dashboard";

/**
 * The ranges the route accepts, mirrored from the contract it declares
 * (`src/http/api/dashboard.ts` builds its enum from `DASHBOARD_RANGES`).
 *
 * Declared here rather than imported, and the reason is the compiler and not
 * taste: `src/dashboard/aggregate.ts` reaches the trail, the durable work store
 * and the configuration, so pulling its module into the interface program (the
 * only one in the repository with a DOM and without node types) would drag a
 * database driver into a browser bundle's typecheck.
 *
 * What the mirror no longer buys is the freedom to disagree. The next three
 * types are held against `src/dashboard/vocabulary.ts` by assignment in both
 * directions, in `dashboard.test.tsx` (REQ-192): a range, a granularity or a
 * band added or dropped on one side alone stops `npm run build`. `vocabulary.ts`
 * is the same words with no imports at all, which is what this program can read
 * and `aggregate.ts` is not.
 */
export const DASHBOARD_RANGES = [
  "last_24_hours",
  "last_7_days",
  "last_30_days",
] as const;

export type DashboardRange = (typeof DASHBOARD_RANGES)[number];

export type BucketGranularity = "hour" | "day";
export type CapStatus = "normal" | "attention" | "critical";
/**
 * Mirrored from the computed vocabulary like the three above, and held against
 * it since REQ-196. It decides which caveat a meter carries
 * (`cap.window === "second"` below), so out of step it would print the wrong
 * one beside a right number, which is the failure a screen cannot show you.
 */
export type CapWindow = "hour" | "second";

/** One type, counted per bucket. `counts` is aligned with `buckets`. */
export interface CountSeriesView {
  readonly subtype: string;
  readonly total: number;
  readonly counts: readonly number[];
}

export interface BreakdownView {
  readonly granularity: BucketGranularity;
  /** The x axis: one instant per bucket, ascending, as ISO-8601 text. */
  readonly buckets: readonly string[];
  readonly series: readonly CountSeriesView[];
  /** Entries naming no type, kept apart from the named ones (REQ-106). */
  readonly unknown: CountSeriesView;
  /** Named types PLUS the unknown group. */
  readonly total: number;
}

export interface CapUsageView {
  readonly cap: string;
  readonly window: CapWindow;
  readonly used: number;
  readonly limit: number;
  readonly usedPct: number;
  readonly status: CapStatus;
}

export interface QueueView {
  readonly pending: number;
  /** Absent when nothing is pending: a queue at rest, not an error. */
  readonly oldestPendingAt?: string;
}

/** One refusal code with how many automations refused for it (REQ-160). */
export interface MatchTallyView {
  readonly reason: MatchRefusal;
  readonly count: number;
}

export interface EventSilenceView {
  readonly code: ActivitySilence;
  /**
   * Always present, and EMPTY is a fact of its own: with `no_match` it says
   * there was no automation at all to refuse the event, which is a different
   * answer from every automation refusing it, and this screen tells them apart.
   */
  readonly refusals: readonly MatchTallyView[];
}

/** One thing the application did about an event, as the trail recorded it. */
export interface ActivityActionView {
  readonly at: string;
  readonly subtype: string;
  /**
   * READ AS THE TRAIL WRITES IT: a `message_sent` with outcome `ok` says the
   * step ENQUEUED the message, never that the platform delivered it, which is
   * why the name beside it stays `dashboard.action.messageSent`, "messages
   * accepted for sending", and why no wording on this page says "sent".
   */
  readonly outcome: ActivityOutcome;
  readonly flowId?: string;
  readonly stepId?: string;
  readonly automationId?: string;
  /**
   * WHY the step fired nothing (REQ-068) or failed (REQ-171), as the code the
   * engine emitted, translated HERE (REQ-163).
   *
   * The union is imported from the engine and not mirrored, unlike the outcomes
   * and the silence codes above: `src/engine/execute.ts` is pure by ADR-003, so
   * this program can read it without dragging a driver into a browser bundle,
   * and a code added there reaches this type with nothing to keep in step.
   *
   * Absent means the answer carried no code, which is every action that simply
   * worked and also one whose stored reason this build cannot name. The line
   * then says WHAT happened without claiming to know why, and no stored phrase
   * crosses to fill the gap.
   */
  readonly reason?: ActionReason;
  /**
   * What the code cannot carry: which step, which target, or what the platform
   * answered (REQ-171).
   *
   * Shown as a QUOTATION and never as the reason itself. The catalogue owns the
   * sentence beside it and owns the framing this appears in; what it does not
   * own, and could not, is these words, because they are an identifier or
   * somebody else's answer. Exactly the standing of `eventText` on the line
   * above (REQ-162).
   */
  readonly detail?: string;
}

/** One event, with what arrived, what was done, and why nothing was (REQ-164). */
export interface ActivityEventView {
  readonly eventId: string;
  readonly at: string;
  readonly subtype: string;
  /** What the trail last said about the ARRIVAL, not about what was done. */
  readonly outcome: ActivityOutcome;
  readonly contactId?: string;
  /** Absent when the payload brought no public identifier (REQ-162). */
  readonly contactUsername?: string;
  /**
   * What the contact wrote, verbatim (REQ-162), and the one piece of text on
   * this page the catalogue neither owns nor could.
   *
   * Empty and absent are DIFFERENT facts and stay different here: an empty
   * string is an interaction that carried no words (a sticker, a button), and
   * no field at all is a line that never stored any.
   */
  readonly eventText?: string;
  readonly actions: readonly ActivityActionView[];
  /** Present only when the trail recorded the event as firing nothing. */
  readonly silence?: EventSilenceView;
}

export interface RecentActivityView {
  /** Newest first, at most `limit` of them. */
  readonly items: readonly ActivityEventView[];
  /** Every event of the window, so the screen says the list is cut in FIGURES. */
  readonly total: number;
  readonly limit: number;
  /** Correlated, immutable run histories. Older facts without this identity stay in `items`. */
  readonly executions?: readonly ExecutionLifecycleView[];
  readonly executionTotal?: number;
}

type MessageLifecycleStatusView = "queued" | "accepted" | "seen" | "failed";

interface ExecutionLifecycleEventView {
  readonly at: string;
  readonly kind: string;
  readonly subtype?: string;
  readonly outcome?: ActivityOutcome;
  readonly reason?: string;
  readonly detail?: string;
  readonly buttonLabel?: string;
}

interface ExecutionLifecycleView {
  readonly executionId: string;
  readonly at: string;
  readonly updatedAt: string;
  readonly summary: {
    readonly total: number;
    readonly queued: number;
    readonly accepted: number;
    readonly seen: number;
    readonly failed: number;
    readonly latestStatus: MessageLifecycleStatusView;
  };
  readonly messages: readonly {
    readonly id: number;
    readonly status: MessageLifecycleStatusView;
    readonly events: readonly ExecutionLifecycleEventView[];
  }[];
  readonly events: readonly ExecutionLifecycleEventView[];
}

/** The overview consumes only link totals; 3t.6 owns the detailed breakdown. */
export interface LinkTotalsView {
  readonly clicks: number;
  readonly uniqueContacts: number;
  readonly automations: number;
  readonly publications: number;
}

/** A click count over the same buckets used by the operational panel. */
export interface LinkTrendView {
  readonly granularity: BucketGranularity;
  readonly buckets: readonly string[];
  readonly counts: readonly number[];
  readonly total: number;
}

/** The post snapshot is an attribution fact, never inferred on the screen. */
export interface PostFunnelView {
  readonly publicationId: string;
  readonly publication?: {
    readonly id: string;
    readonly caption?: string;
    readonly thumbnailKey?: string;
  };
  readonly comments: number;
  readonly commentDetails: readonly {
    readonly text?: string;
    readonly matchedKeyword?: string;
  }[];
  readonly publicReplies: number;
  readonly acceptedMessages: number;
  readonly clicks: number;
  readonly uniqueContacts: number;
  readonly links: readonly {
    readonly label?: string;
    readonly clicks: number;
    readonly uniqueContacts: number;
  }[];
}

/** A button's historical destination version, kept distinct on purpose. */
export interface ButtonVersionView {
  readonly automationId: string;
  readonly buttonId: string;
  readonly destinationVersion: number;
  readonly clicks: number;
  readonly uniqueContacts: number;
}

export interface LinkAnalyticsView {
  readonly totals: LinkTotalsView;
  readonly trend?: LinkTrendView;
  readonly posts?: readonly PostFunnelView[];
  readonly unattributedClicks?: number;
  readonly buttons?: readonly ButtonVersionView[];
}

export interface DashboardMetricsView {
  readonly window: {
    readonly range: DashboardRange;
    readonly granularity: BucketGranularity;
    readonly since: string;
    readonly until: string;
    /** The zone the buckets were cut in, which is the one they are read in. */
    readonly zone: string;
  };
  readonly events: BreakdownView;
  readonly actions: BreakdownView;
  readonly caps: readonly CapUsageView[];
  readonly failures: {
    readonly errors: number;
    readonly rateLimited: number;
  };
  readonly queue: QueueView;
  /** Link facts from the same ranged read as every operational total. */
  readonly links?: LinkAnalyticsView;
  /** The same window event by event (REQ-164), from the same read. */
  readonly activity: RecentActivityView;
  /** The operational status command's newest failed alert, when one is open. */
  readonly openAlert?: {
    readonly origin: "machine" | "instance";
    readonly reason: string;
    readonly occurredAt: string;
    readonly subtype?: string;
    readonly automationId?: string;
  };
  /** Only explicit off choices; an all-on instance carries an empty list. */
  readonly disabledTriggers?: readonly {
    readonly name: "all" | "comments" | "directMessages";
    readonly updatedAt: string;
  }[];
}

/** The one call this screen makes, so a test drives it with a double. */
export interface DashboardClient {
  read(range: DashboardRange): Promise<DashboardMetricsView>;
}

const METRICS_ENDPOINT = "/api/dashboard/metrics";

/** The real client: same origin, so the session cookie travels on its own. */
export const httpDashboardClient: DashboardClient = {
  read: async (range: DashboardRange): Promise<DashboardMetricsView> => {
    const response = await fetch(
      `${METRICS_ENDPOINT}?range=${encodeURIComponent(range)}`,
    );

    if (!response.ok) {
      throw new Error(String(response.status));
    }

    const body = (await response.json()) as {
      readonly metrics: DashboardMetricsView;
    };

    return body.metrics;
  },
};

/**
 * Every identifier that crosses the API, and the catalogue key that names it.
 *
 * Maps rather than a switch, because the identifiers are the trail's own
 * vocabulary and the sentences are the catalogue's: neither side is written in
 * this file. The keys are literals so `dashboard.test.tsx` can check each one
 * against the shipped catalogue, which is the guard `catalogue.test.ts` cannot
 * give a lookup it does not see written as `t("...")`.
 */
const RANGE_LABEL_KEYS: Readonly<Record<DashboardRange, string>> = {
  last_24_hours: "dashboard.range.last24Hours",
  last_7_days: "dashboard.range.last7Days",
  last_30_days: "dashboard.range.last30Days",
};

const GRANULARITY_KEYS: Readonly<Record<BucketGranularity, string>> = {
  hour: "screens.dashboard.granularity.hour",
  day: "screens.dashboard.granularity.day",
};

const EVENT_LABEL_KEYS: Readonly<Record<string, string>> = {
  comment: "dashboard.event.comment",
  direct_message: "dashboard.event.directMessage",
};

const ACTION_LABEL_KEYS: Readonly<Record<string, string>> = {
  comment_reply: "dashboard.action.commentReply",
  message_sent: "dashboard.action.messageSent",
  // REQ-156: the pause names itself in the trail, and here is where that name
  // becomes a column an operator can read. Without this entry the count is
  // still drawn, under its own code inside a translated frame, which is the
  // fallback for a type this build has no sentence for and not a label.
  pause_started: "dashboard.action.pauseStarted",
  wait_ended: "dashboard.action.waitEnded",
  execution_failed: "dashboard.action.executionFailed",
};

/**
 * The unit a relative reading is said in (REQ-182), and the sentence for each.
 *
 * ONE unit per line and never a chain ("1 hour and 12 minutes"): this reading
 * answers "how recent" at a glance, and the exact instant is written beside it
 * for everything finer than that.
 *
 * The four steps are decided by what the answer can carry rather than by taste.
 * The widest window this panel reads is thirty days, so days is the coarsest
 * unit that can ever be needed, and a line reading "4 weeks ago" inside a period
 * the page itself calls "last 30 days" would be a second arithmetic to do. Under
 * a minute is a step of its own for two reasons: a count that changes while it
 * is being read says less than "just now", and the minute sentence would
 * otherwise open at zero.
 *
 * A record over a CLOSED union, so a fifth step added here fails the compilation
 * instead of arriving with no sentence, and its keys are listed in `LABEL_KEYS`
 * so the shipped catalogue is held to them too (REQ-174). The three counted keys
 * address a PLURAL family: the catalogue carries `_one` and `_other` under each
 * of them and i18next chooses from `count`, which is what keeps "há 1 minuto"
 * from reading "há 1 minutos".
 */
type ElapsedUnit = "now" | "minutes" | "hours" | "days";

const ELAPSED_KEYS: Readonly<Record<ElapsedUnit, string>> = {
  now: "dashboard.activity.relative.justNow",
  minutes: "dashboard.activity.relative.minutes",
  hours: "dashboard.activity.relative.hours",
  days: "dashboard.activity.relative.days",
};

const CAP_LABEL_KEYS: Readonly<Record<string, string>> = {
  private_replies_per_hour: "dashboard.cap.privateRepliesPerHour",
  calls_per_second: "dashboard.cap.callsPerSecond",
  media_calls_per_second: "dashboard.cap.mediaCallsPerSecond",
};

const CAP_STATUS_KEYS: Readonly<Record<CapStatus, string>> = {
  normal: "dashboard.capStatus.normal",
  attention: "dashboard.capStatus.attention",
  critical: "dashboard.capStatus.critical",
};

/**
 * The three consumption bands as the design system tints them.
 *
 * `normal` becomes `active` because in the badge's vocabulary the calm state is
 * the one in force, and the other two are named the same on both sides. The
 * tint is the ONLY thing this map decides: the word beside it comes from
 * `CAP_STATUS_KEYS` and renders whatever the tint does (REQ-038).
 */
const CAP_BADGE_STATES: Readonly<Record<CapStatus, BadgeState>> = {
  normal: "active",
  attention: "attention",
  critical: "critical",
};

/**
 * The glyph that picks a ceiling under pressure out of a list of ceilings
 * (REQ-178), or nothing for the band that is not worth pointing at.
 *
 * MEASURED BEFORE IT WAS BUILT, and half of the requirement was already paid:
 * `CAP_STATUS_KEYS` puts the band on the row in WORDS, three different
 * sentences from the catalogue, and `criterion 39` in `dashboard.test.tsx` has
 * been holding the screen to them since the panel was dressed. So colour was
 * never the only carrier here. What was missing is the other half of "stands
 * out FROM THE OTHERS": three rows of the same shape are told apart only by
 * reading each one, and this block is opened precisely when there is no time to
 * read. A shape does that reading at a glance, and it is not a second tint.
 *
 * ONE glyph for both bands under pressure and not two, because the mark answers
 * "this one, look here" and the WORD beside it answers which band: a shape
 * vocabulary of two triangles would be a second thing to learn, and it would be
 * the one thing on the row nobody could look up.
 *
 * `null` and not an omission for `normal`: the record is exhaustive over the
 * union, so a fourth band added to the aggregation fails the compilation here
 * instead of quietly arriving with no mark and no decision behind it (REQ-157).
 */
const CAP_STATUS_MARKS: Readonly<Record<CapStatus, IconName | null>> = {
  normal: null,
  attention: "triangle-alert",
  critical: "triangle-alert",
};

/**
 * The trail's five verdicts as the design system tints them, exhaustively.
 *
 * A record over the union and not a lookup with a default: a sixth verdict
 * added to the trail has to fail the COMPILATION here, because the alternative
 * is a line drawn with whatever tint the fallback happened to pick, which reads
 * as a decision nobody made (REQ-157).
 *
 * The tint decides nothing an operator has to see: the WORD beside it comes
 * from the catalogue and says the same thing (REQ-038).
 */
const OUTCOME_BADGE_STATES: Readonly<Record<ActivityOutcome, BadgeState>> = {
  ok: "active",
  failed: "critical",
  // A redelivery the door refused and a step deliberately not performed are
  // both NORMAL: neither is a fault, and marking them would teach the operator
  // to ignore the marks that are.
  duplicate: "neutral",
  suppressed: "neutral",
  blocked: "attention",
};

/** The catalogue entries a section carries that the other one does not. */
interface SectionText {
  readonly titleKey: string;
  readonly unknownKey: string;
  readonly labelKeys: Readonly<Record<string, string>>;
}

const EVENT_SECTION: SectionText = {
  titleKey: "screens.dashboard.eventsTitle",
  unknownKey: "dashboard.event.unknown",
  labelKeys: EVENT_LABEL_KEYS,
};

const ACTION_SECTION: SectionText = {
  titleKey: "screens.dashboard.actionsTitle",
  unknownKey: "dashboard.action.unknown",
  labelKeys: ACTION_LABEL_KEYS,
};

/** The translator, exactly as `useLocale` hands it over. */
type Translate = ReturnType<typeof useLocale>["t"];

/** Keep catalogue references literal so the unused-key proof can see them. */
function triggerName(
  name: "all" | "comments" | "directMessages",
  t: Translate,
): string {
  switch (name) {
    case "all":
      return t("settings.triggerName.all");
    case "comments":
      return t("settings.triggerName.comments");
    case "directMessages":
      return t("settings.triggerName.directMessages");
  }
}

/**
 * The catalogue's name for one type of one section.
 *
 * A type this build has no sentence for is still counted and still shown, named
 * by its own code inside a translated frame. Silence would drop a column, and
 * dropping a column is how a total stops adding up.
 *
 * A function and not a method of either block, because the table and the
 * drawing now live in different sections of the page and a type named one thing
 * in a column head and another beside a strip would be two readings of one
 * count (REQ-179).
 */
function labelOf(section: SectionText, subtype: string, t: Translate): string {
  const key = section.labelKeys[subtype];

  return key === undefined
    ? t("screens.dashboard.unnamedType", { code: subtype })
    : t(key);
}

/**
 * Every key the activity list DERIVES from a code rather than writing down.
 *
 * Derived through `src/i18n/engine-reasons.ts`, which is the one place a code
 * meets the catalogue (REQ-163): the guard that refuses an untranslated code
 * and the line that shows it ask the same function, so they cannot disagree
 * about a key. What that costs is visibility, since a key built at runtime is
 * invisible to the walker in `catalogue.test.ts`, and this list is what pays
 * it back on this side.
 */
const ACTIVITY_CODE_KEYS: readonly string[] = [
  ...ACTIVITY_OUTCOMES.map(arrivalTextKey),
  ...ACTIVITY_OUTCOMES.map(actionOutcomeTextKey),
  ...ACTIVITY_SILENCES.map(activitySilenceTextKey),
  ...MATCH_REFUSALS.map(matchRefusalTextKey),
  // The engine's suppression codes, from the SAME list the engine emits from:
  // a code added there arrives here with nobody registering it, and the check
  // in `dashboard.test.tsx` then demands the catalogue name it. That is what
  // makes the label total for a vocabulary no `Record` over a union guards,
  // since the key is derived rather than written down (REQ-157, REQ-163).
  ...SUPPRESSION_REASONS.map(suppressionTextKey),
  // And its failure codes, which arrive on the same field and are read on the
  // same line (REQ-171). Both halves are here because `actionReasonTextKey`
  // dispatches between them, and a list that carried only one would leave the
  // other translated by nobody's check.
  ...EXECUTION_FAILURE_REASONS.map(executionFailureTextKey),
];

/**
 * Exported for the test, which asserts every key above resolves in the shipped
 * catalogue. A map is invisible to the walker in `catalogue.test.ts`, so the
 * proof that these keys exist has to be written somewhere, and here it is.
 */
export const LABEL_KEYS: readonly string[] = [
  ...Object.values(RANGE_LABEL_KEYS),
  // Kept here even though `BucketGranularity` is closed and a third granularity
  // would fail the compilation: exhaustiveness answers whether every value has
  // a ROW, and says nothing about whether the row's key still names a sentence.
  // Measured before this line existed: with the two keys taken out of both
  // catalogues, the only thing that failed was a rendering assertion reading an
  // undefined fixture, which reports a missing property of a test double where
  // an operator would have met the placeholder of REQ-075 (REQ-174).
  ...Object.values(GRANULARITY_KEYS),
  ...Object.values(EVENT_LABEL_KEYS),
  ...Object.values(ACTION_LABEL_KEYS),
  ...Object.values(CAP_LABEL_KEYS),
  ...Object.values(CAP_STATUS_KEYS),
  // Listed even though `ElapsedUnit` is closed, for the reason the granularity
  // keys are: exhaustiveness answers whether every step has a ROW, and says
  // nothing about whether that row still names a sentence. These three of the
  // four address a plural family, so what the catalogue carries under them is
  // `_one` and `_other`, and the check reading this list knows it (REQ-182).
  ...Object.values(ELAPSED_KEYS),
  EVENT_SECTION.unknownKey,
  ACTION_SECTION.unknownKey,
  "screens.dashboard.technicalEventsNote",
  ...ACTIVITY_CODE_KEYS,
];

/**
 * The zone read while there are no numbers to read in it.
 *
 * Every instant on this page is read in the zone the ANSWER carries
 * (`window.zone`), because that is the zone the aggregation cut the buckets in
 * (REQ-153): the label of a column has to name the hour that column counted,
 * and only the side that did the counting knows which hour that was. Reading
 * them in the browser's zone instead would name the same instance differently
 * on two laptops.
 *
 * This value therefore labels nothing. It exists because the formatters are
 * built before the first answer arrives, and the states that precede it (a read
 * in flight, a read that failed) show no instant at all.
 *
 * The zone in force is a decision the operator has to be able to READ, not one
 * they have to infer from a column that looks an hour off:
 * `screens.dashboard.zoneNote` names it at the foot of the page.
 */
const FALLBACK_ZONE = "UTC";

/** The first column of both tables: the bucket, which is not a figure. */
const PERIOD_COLUMN = "period";

/** Placeholder rows drawn while the numbers are being read. */
const LOADING_SKELETON = 2;

interface Formatters {
  number(value: number): string;
  bucket(iso: string, granularity: BucketGranularity): string;
  instant(iso: string): string;
}

function createFormatters(locale: string, zone: string): Formatters {
  const numbers = new Intl.NumberFormat(locale);

  const perGranularity: Readonly<
    Record<BucketGranularity, Intl.DateTimeFormat>
  > = {
    hour: new Intl.DateTimeFormat(locale, {
      timeZone: zone,
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    }),
    day: new Intl.DateTimeFormat(locale, {
      timeZone: zone,
      year: "numeric",
      month: "short",
      day: "numeric",
    }),
  };

  const instants = new Intl.DateTimeFormat(locale, {
    timeZone: zone,
    dateStyle: "medium",
    timeStyle: "short",
  });

  return {
    number: (value: number): string => numbers.format(value),
    bucket: (iso: string, granularity: BucketGranularity): string =>
      perGranularity[granularity].format(new Date(iso)),
    instant: (iso: string): string => instants.format(new Date(iso)),
  };
}

/**
 * One labelled figure: the value on top, the word under it.
 *
 * A definition list and not two spans, because the pair IS the datum: "4" alone
 * is not the unknown group, and an operator using a screen reader gets the
 * label tied to the number instead of tied to whatever happens to precede it.
 * The word is written first in the markup, which is the order `dl` requires and
 * the order a reader wants; `.mc-figures` is what puts the number above it on
 * screen.
 */
function Figure({
  label,
  value,
}: {
  readonly label: string;
  readonly value: string;
}): ReactElement {
  return (
    <div className="mc-metric">
      <dt className="mc-metric__label">{label}</dt>
      <dd className="mc-metric__value">{value}</dd>
    </div>
  );
}

interface BreakdownProps {
  readonly breakdown: BreakdownView;
  readonly section: SectionText;
  readonly formatters: Formatters;
  /** The caveat belonging to these numbers. The actions block carries one. */
  readonly note?: string;
}

/**
 * One counting block: a table of counts per bucket per type, then the two
 * figures the table deliberately leaves out.
 *
 * The SHAPE of these same counts is drawn once, for both natures at a time, by
 * `Volume` (REQ-179). This block carries no drawing of its own, and that is the
 * point rather than a loss: a strip here and a strip there, each scaled against
 * its own block, is exactly the pair of pictures nobody could compare.
 */
function Breakdown({
  breakdown,
  section,
  formatters,
  note,
}: BreakdownProps): ReactElement {
  const { t } = useLocale();
  const headingId = useId();

  const empty = breakdown.series.length === 0 && breakdown.unknown.total === 0;

  const columns: readonly TableColumn[] = [
    { key: PERIOD_COLUMN, label: t("screens.dashboard.columnPeriod") },
    ...breakdown.series.map((series) => ({
      key: series.subtype,
      label: labelOf(section, series.subtype, t),
    })),
  ];

  const periods: readonly string[] = breakdown.buckets.map((bucket) =>
    formatters.bucket(bucket, breakdown.granularity),
  );

  const rows: readonly TableRow[] = breakdown.buckets.map((bucket, index) => ({
    key: bucket,
    label: periods[index] ?? "",
    cells: Object.fromEntries(
      breakdown.series.map((series) => [
        series.subtype,
        formatters.number(series.counts[index] ?? 0),
      ]),
    ),
  }));

  const total: TableTotal = {
    label: t("screens.dashboard.total"),
    cells: Object.fromEntries(
      breakdown.series.map((series) => [
        series.subtype,
        formatters.number(series.total),
      ]),
    ),
  };

  return (
    <section className="mc-panel" aria-labelledby={headingId}>
      <div className="mc-panel__head">
        <h2 id={headingId} className="mc-panel__title">
          {t(section.titleKey)}
        </h2>
        {/* How wide a row is, marked rather than written into a sentence:
            changing the range changes this word, and it is the fastest way to
            see that the table below was redrawn (REQ-039). */}
        <StatusBadge state="neutral" dot={false}>
          {t(GRANULARITY_KEYS[breakdown.granularity])}
        </StatusBadge>
      </div>

      {empty ? (
        <>
          {/* A designed state and not a gap in the screen: a fresh instance
              records nothing until the first comment arrives, and an operator
              who cannot tell that from a failure will go looking for a fault
              that is not there (REQ-115). No action is offered because there is
              none: the traffic comes from the platform. */}
          <EmptyState icon={null} title={t("screens.dashboard.noActivity")}>
            {t("screens.dashboard.noActivityHint")}
          </EmptyState>
          {note === undefined ? null : <p className="mc-panel__note">{note}</p>}
        </>
      ) : (
        <DataTable
          bars
          // The caption, so the caveat is announced WITH the table and ahead of
          // the figures it qualifies, instead of being a paragraph the reader
          // meets after having already believed the number.
          caption={note}
          columns={columns}
          rows={rows}
          total={total}
        />
      )}

      <dl className="mc-figures">
        <Figure
          label={t(section.unknownKey)}
          value={formatters.number(breakdown.unknown.total)}
        />
        <Figure
          label={t("screens.dashboard.recorded")}
          value={formatters.number(breakdown.total)}
        />
      </dl>
    </section>
  );
}

/**
 * The granular reading, behind a path the page names (REQ-180).
 *
 * THE DIAGNOSIS IS THE OPERATOR'S: the panel opened with a table of counts per
 * hour, and "it is very cluttered". Thirty rows of figures are the answer to a
 * question asked with time in hand, and they were standing in front of the four
 * that answer "is it working?". So the two tables leave the OPENING without
 * leaving the SCREEN: closed, this costs one line of page; open, it is the very
 * same reading, with the same numbers, the same columns and the same caveat.
 *
 * ONE control for both tables and not one each. The two are a pair by
 * construction: `src/dashboard/aggregate.ts` cuts them over the same window and
 * the block above draws them in ONE frame precisely so that "more arrived than
 * was done about it" can be read across them (REQ-179). A control per table
 * would let an operator open the actions and leave the arrivals shut, which is
 * half of a reading whose whole value is the comparison. It would also put two
 * near-identical sentences in the tab order, and the one thing a screen reader
 * user should not have to do is tell "detail of the received" from "detail of
 * the performed" by listening to both.
 *
 * THE STATE SURVIVES A CHANGE OF PERIOD, and that is why it is held by
 * `DashboardScreen` rather than here: choosing another range replaces the load
 * with a read in flight, so a state living in this component would be unmounted
 * and come back shut. An operator who opened the detail and then moved from
 * twenty-four hours to seven days is asking the SAME question over a wider
 * window, and a screen that closed the answer they had just opened would be
 * undoing their work from a control they never touched.
 *
 * THE DISCLOSURE CONTRACT, in full, because half of one is a control that lies:
 * the button says whether it is expanded (`aria-expanded`) and points at what it
 * expands (`aria-controls`, at a region that is in the document either way); it
 * is a real `button`, so the keyboard reaches it with no help from us; and shut,
 * the tables are not rendered at all, which is the only kind of hidden a screen
 * reader cannot walk into. The trailing chevron is decoration and carries no
 * datum: `Icon` leaves it unnamed, and the word beside it already says which way
 * this goes.
 */
function Detail({
  metrics,
  formatters,
  open,
  panelId,
  onToggle,
}: {
  readonly metrics: DashboardMetricsView;
  readonly formatters: Formatters;
  readonly open: boolean;
  /** What the control points at, minted by the screen that owns the state. */
  readonly panelId: string;
  readonly onToggle: () => void;
}): ReactElement {
  const { t } = useLocale();

  return (
    <>
      <div className="mc-row">
        <Button
          variant="secondary"
          aria-expanded={open}
          aria-controls={panelId}
          iconEnd={open ? "chevron-up" : "chevron-down"}
          onClick={onToggle}
        >
          {open
            ? t("screens.dashboard.detailHide")
            : t("screens.dashboard.detailShow")}
        </Button>
      </div>

      {/* The region the control names, present in the document whether it is
          open or shut, so `aria-controls` points at something real in both
          states. What changes is its CONTENT: shut, the tables are not rendered,
          so there is nothing left to reach by any route. */}
      <div id={panelId} className="mc-detail" hidden={!open}>
        {open ? (
          <>
            <Breakdown
              breakdown={metrics.events}
              section={EVENT_SECTION}
              formatters={formatters}
            />

            {/* The caveat travels with the table too, and not only in the band:
                the count is written when a message is ACCEPTED for sending, and
                a delivery that fails afterwards is in the error count and not
                subtracted from here. The drawing above needs no second copy of
                it: the strip is named by the very sentence the caveat is about
                ("messages accepted for sending"), so it claims no delivery to
                correct (REQ-181). */}
            <Breakdown
              breakdown={metrics.actions}
              section={ACTION_SECTION}
              formatters={formatters}
              note={t("dashboard.acceptedNote")}
            />
          </>
        ) : null}
      </div>
    </>
  );
}

/**
 * The volume of the period, in ONE frame (REQ-179).
 *
 * WHAT ARRIVED AND WHAT WAS DONE ABOUT IT, drawn together, because that pair IS
 * the reading: two hundred comments answered by four replies and two hundred
 * answered by a hundred and ninety are the same two blocks of figures and two
 * completely different mornings. Until this block existed the panel drew them in
 * two frames, and `TrendChart` scales every strip against the tallest column of
 * the drawing it is in, so the two pictures had two scales: a strip in the
 * actions frame standing as tall as one in the events frame meant nothing at
 * all, and an operator who read it as "as many as arrived" was reading a
 * coincidence of layout.
 *
 * ONE AXIS, and it is not a choice made here. `src/dashboard/aggregate.ts`
 * builds both breakdowns with `breakdownOf(samples, window)`, from the SAME
 * window, so the two carry the same buckets in the same order by construction;
 * the periods below are read once, from the events side, and the granularity
 * from the window itself, which is the one place that decides it.
 *
 * NOTHING IS RECOMPUTED to get here (REQ-036): the strips are the very series
 * the aggregation decided, counts and all, laid side by side. What this block
 * deliberately does NOT draw is a line per nature, which would have meant adding
 * the types up per bucket on the screen: that sum exists nowhere in the answer,
 * no table carries it as text, and it would disagree with the band by exactly
 * the deliveries the unknown group holds (REQ-106).
 *
 * The counts travel as NUMBERS and are never re-read out of the text a table
 * printed: that is the defect REQ-155 fixed inside the cells, and handing the
 * drawing the figures instead of their formatting is what keeps it from coming
 * back in another shape. The peak is the only figure computed here, and it
 * computes no metric: it is the tallest column of a strip, said in words, so a
 * height on screen has a number an operator can name.
 */
function Volume({
  metrics,
  formatters,
}: {
  readonly metrics: DashboardMetricsView;
  readonly formatters: Formatters;
}): ReactElement {
  const { t } = useLocale();
  const headingId = useId();

  const natures: readonly {
    readonly breakdown: BreakdownView;
    readonly section: SectionText;
  }[] = [
    { breakdown: metrics.events, section: EVENT_SECTION },
    { breakdown: metrics.actions, section: ACTION_SECTION },
  ];

  const strips: readonly TrendSeries[] = natures.flatMap(
    ({ breakdown, section }) =>
      breakdown.series.map((series) => ({
        // The nature and the type, because the two vocabularies are the trail's
        // and nothing forbids them a shared word: a `comment` counted as an
        // arrival and a `comment` counted as an action would be one React key
        // for two strips, and one of them would stop being drawn.
        key: `${section.titleKey}:${series.subtype}`,
        group: t(section.titleKey),
        label: labelOf(section, series.subtype, t),
        counts: series.counts,
        peakLabel: t("screens.dashboard.chartPeak", {
          count: formatters.number(Math.max(0, ...series.counts)),
        }),
      })),
  );

  const periods: readonly string[] = metrics.events.buckets.map((bucket) =>
    formatters.bucket(bucket, metrics.window.granularity),
  );

  return (
    <section className="mc-panel" aria-labelledby={headingId}>
      <div className="mc-panel__head">
        <h2 id={headingId} className="mc-panel__title">
          {t("screens.dashboard.volumeTitle")}
        </h2>
        {/* How wide a column is, marked rather than written into a sentence:
            changing the range changes this word, and it is the fastest way to
            see that the drawing was redrawn (REQ-039). */}
        <StatusBadge state="neutral" dot={false}>
          {t(GRANULARITY_KEYS[metrics.window.granularity])}
        </StatusBadge>
      </div>

      {strips.length === 0 ? (
        // A designed state and not a gap: a fresh instance records nothing until
        // the first comment arrives, and a drawing of flat strips for nothing
        // would have to be read before it could say it said nothing (REQ-115).
        // A period where only ONE of the two natures recorded anything is NOT
        // this case: it draws, with the half that happened, which is the shape
        // of "events arrived and nothing was done about them".
        <EmptyState icon={null} title={t("screens.dashboard.noActivity")}>
          {t("screens.dashboard.noActivityHint")}
        </EmptyState>
      ) : (
        <TrendChart
          label={t("screens.dashboard.volumeChart")}
          axes={{
            x: t("screens.dashboard.chartXAxis"),
            y: t("screens.dashboard.chartYAxis"),
          }}
          note={t("screens.dashboard.chartNote")}
          periods={periods}
          series={strips}
        />
      )}
    </section>
  );
}

/**
 * The shape that says "this ceiling, look here" (REQ-178), or nothing.
 *
 * Unnamed on purpose, which is what makes `Icon` hide it from assistive
 * technology: the sentence from `CAP_STATUS_KEYS` is right beside it and says
 * the same thing, so announcing the mark would read one band twice. The
 * requirement is that colour is not ALONE, and it is not: the word carries the
 * band for everyone, and the shape carries it a second time for the eye that is
 * scanning a list rather than reading it.
 *
 * It carries no colour of its own either. `Icon` strokes with `currentColor`,
 * which inside a badge is that badge's ink over that badge's own surface, a pair
 * `tokens.test.ts` already measures against the 4.5:1 text floor and therefore
 * well over the 3:1 REQ-176 asks of a mark.
 */
function CapMark({
  status,
}: {
  readonly status: CapStatus;
}): ReactElement | null {
  const glyph = CAP_STATUS_MARKS[status];

  return glyph === null ? null : <Icon name={glyph} size={ICON_SIZE.chip} />;
}

/**
 * One ceiling read over the second in progress: the same three facts a meter
 * carries (name, numbers, status in words) with no track drawn.
 *
 * The bar is what is missing and the reason is honesty: this cap counts the
 * calls made inside the second the page happened to open in, so it is zero
 * almost every time anyone looks. A bar frozen at empty forever does not report
 * "nothing is being spent", it reports "this widget is broken".
 */
function CapLine({
  cap,
  name,
  usageLabel,
}: {
  readonly cap: CapUsageView;
  readonly name: string;
  readonly usageLabel: string;
}): ReactElement {
  const { t } = useLocale();

  return (
    <div className="mc-capline">
      <span className="mc-capline__name">{name}</span>
      <span className="mc-capline__value">{usageLabel}</span>
      <StatusBadge state={CAP_BADGE_STATES[cap.status]} dot={false}>
        <CapMark status={cap.status} />
        {t(CAP_STATUS_KEYS[cap.status])}
      </StatusBadge>
    </div>
  );
}

function Caps({
  caps,
  formatters,
}: {
  readonly caps: readonly CapUsageView[];
  readonly formatters: Formatters;
}): ReactElement {
  const { t } = useLocale();
  const headingId = useId();

  const perSecond = caps.some((cap) => cap.window === "second");

  return (
    <section className="mc-panel" aria-labelledby={headingId}>
      <div className="mc-panel__head">
        <h2 id={headingId} className="mc-panel__title">
          {t("screens.dashboard.capsTitle")}
        </h2>
      </div>

      <ul className="mc-caps">
        {caps.map((cap) => {
          const key = CAP_LABEL_KEYS[cap.cap];
          const name =
            key === undefined
              ? t("screens.dashboard.unnamedType", { code: cap.cap })
              : t(key);

          const usageLabel = t("dashboard.cap.usage", {
            used: formatters.number(cap.used),
            limit: formatters.number(cap.limit),
            // Rounded here and only here: the aggregation deliberately hands
            // over an unrounded percentage because rounding is a presentation
            // choice. The STATUS is not recomputed from it, which is the whole
            // point of the field beside it.
            percent: formatters.number(Math.round(cap.usedPct)),
          });

          return (
            // The band the aggregation decided, carried on the row that shows
            // it: a test reads it here to prove the screen passed the decision
            // through instead of deriving a second one from the percentage.
            <li key={cap.cap} data-status={cap.status}>
              {cap.window === "hour" ? (
                <CapMeter
                  name={name}
                  used={cap.used}
                  limit={cap.limit}
                  status={cap.status}
                  statusLabel={t(CAP_STATUS_KEYS[cap.status])}
                  statusMark={<CapMark status={cap.status} />}
                  usageLabel={usageLabel}
                />
              ) : (
                <CapLine cap={cap} name={name} usageLabel={usageLabel} />
              )}
            </li>
          );
        })}
      </ul>

      {perSecond ? (
        <p className="mc-panel__note">{t("screens.dashboard.capSecondNote")}</p>
      ) : null}
    </section>
  );
}

/**
 * The type whose count is the MESSAGES, as the trail spells it.
 *
 * The band reads this one series instead of `actions.total`, and the difference
 * is the honesty of the headline: the total is every action of the window,
 * comment replies and attributes set and pauses started included, so a figure
 * calling all of it "messages" would misname the number in a second way beside
 * the one REQ-181 forbids. The value is the trail's own vocabulary
 * (`src/storage/audit.ts`), which is why it is a code and not a sentence.
 */
const MESSAGE_SUBTYPE = "message_sent";

/**
 * What one type counted over the whole window, or zero for a period that
 * recorded none of it.
 *
 * A LOOKUP and not an aggregation: the total it returns is the one
 * `src/dashboard/aggregate.ts` already computed for that series. A type with
 * nothing in the period has no series at all (the aggregation reports what
 * happened rather than a row of zeros), and the absence is a zero here rather
 * than a blank, because "no messages went out" is an answer and an empty space
 * is not.
 */
function totalOf(breakdown: BreakdownView, subtype: string): number {
  return (
    breakdown.series.find((series) => series.subtype === subtype)?.total ?? 0
  );
}

/**
 * The band that answers "is it working?" (REQ-177).
 *
 * FIRST on the page, above everything that carries a datum, and the position IS
 * the requirement. An operator opens this panel with something going wrong in
 * public and asks one question; the screen this replaces opened with a table of
 * counts per hour, which answers that question only to somebody who reads it row
 * by row. The blocks below still hold every figure and every shape; what changes
 * is that none of them is what the page opens with.
 *
 * "MESSAGES ACCEPTED FOR SENDING", NEVER "sent" (REQ-181), and the sentence is
 * the very one the actions table writes at the head of its column. The trail
 * writes the `ok` row of a `message_sent` when the step ENQUEUES the message;
 * the delivery happens later, in the sweep, and a delivery that then fails adds
 * its own `failed` row without being subtracted from here. Two sentences for one
 * fact would be two things to keep honest, so there is one.
 *
 * THE ERRORS STAND IN THE BAND, beside the count they correct, for the same
 * reason: a headline figure is read without any note being read, so the
 * correction has to be a figure too. `dashboard.acceptedNote` still travels as
 * the actions table's caption, and it qualifies the same count in the block that
 * breaks it down by period.
 *
 * IT ABSORBS THE TWO BLOCKS that used to carry these figures side by side at the
 * foot of the page, and everything they carried comes with them: the
 * too-many-requests count, which is the one figure telling an operator to slow
 * down rather than to go looking for a fault, and the instant the oldest queued
 * item has been waiting since. Keeping those blocks as well would have printed
 * the same numbers twice on one page, which is the reading this phase exists to
 * remove.
 */
function Summary({
  metrics,
  formatters,
}: {
  readonly metrics: DashboardMetricsView;
  readonly formatters: Formatters;
}): ReactElement {
  const { t } = useLocale();
  const headingId = useId();

  return (
    <section className="mc-panel" aria-labelledby={headingId}>
      <div className="mc-panel__head">
        <h2 id={headingId} className="mc-panel__title">
          {t("screens.dashboard.summaryTitle")}
        </h2>
      </div>

      <dl className="mc-figures mc-summary">
        <Figure
          label={t("screens.dashboard.eventsTitle")}
          value={formatters.number(metrics.events.total)}
        />
        <Figure
          label={t("screens.dashboard.interactionsHandled")}
          value={formatters.number(metrics.actions.total)}
        />
        <Figure
          label={t("dashboard.action.messageSent")}
          value={formatters.number(totalOf(metrics.actions, MESSAGE_SUBTYPE))}
        />
        <Figure
          label={t("screens.dashboard.linkClicks")}
          value={formatters.number(metrics.links?.totals.clicks ?? 0)}
        />
        <Figure
          label={t("dashboard.failures.errors")}
          value={formatters.number(metrics.failures.errors)}
        />
        <Figure
          label={t("dashboard.queue.pending")}
          value={formatters.number(metrics.queue.pending)}
        />
      </dl>

      {/* An empty queue is a queue at rest. It shows the zero and says so, and
          it is NOT an alert: a panel that cried wolf over nothing pending would
          teach the operator to ignore the place real alerts appear. */}
      <p className="mc-panel__note">
        {t("screens.dashboard.rateLimitedNote", {
          count: formatters.number(metrics.failures.rateLimited),
        })}{" "}
        {metrics.queue.oldestPendingAt === undefined
          ? t("dashboard.queue.empty")
          : t("dashboard.queue.oldest", {
              since: formatters.instant(metrics.queue.oldestPendingAt),
            })}
      </p>
      <p className="mc-panel__note">
        {t("screens.dashboard.technicalEventsNote")}
      </p>
    </section>
  );
}

/**
 * Whether a line carries the contact's own words, none at all, or nothing
 * recorded. Three states because the trail keeps three (REQ-162), and the
 * middle one is the falsy one: an empty string is an interaction that said
 * nothing (a sticker, a button), and no field at all is a row that stored
 * nothing. Collapsing them would turn "said nothing" into "we know nothing",
 * which is the second reading of a line the operator is trying to explain.
 */
type SaidState = "present" | "empty" | "absent";

function saidStateOf(text: string | undefined): SaidState {
  // Compared against undefined and NOT tested for truth, which is the whole
  // point: the empty text is the case that has to survive.
  return text === undefined ? "absent" : text === "" ? "empty" : "present";
}

/**
 * Why an event fired nothing, in the operator's words, with the aggregate
 * REQ-160 stored behind it.
 *
 * Three answers and not one, because the record really does carry three, and an
 * operator asking "why did nothing happen" is answered differently by each:
 * every automation refused and here is the tally, there was no automation at
 * all to refuse, and this build cannot read what was written. The third one
 * names ITSELF from the catalogue and never shows the stored phrase: that
 * phrase is application wording in whatever language the instance wrote it, and
 * putting it on screen is what REQ-163 and REQ-074 forbid.
 */
function Silence({
  silence,
  formatters,
}: {
  readonly silence: EventSilenceView;
  readonly formatters: Formatters;
}): ReactElement {
  const { t } = useLocale();

  // An empty list under `no_match` is a legitimate and DIFFERENT answer: no
  // automation existed to refuse the event. Said with the code alone it would
  // read as "every automation refused, for no reason at all".
  const nothingInstalled =
    silence.code === "no_match" && silence.refusals.length === 0;

  return (
    <div className="mc-activity__silence">
      <Icon name="info" size={ICON_SIZE.text} />
      <div className="mc-activity__reason">
        <p>
          {nothingInstalled
            ? t("dashboard.activity.silence.no_match_empty")
            : t(activitySilenceTextKey(silence.code))}
        </p>

        {silence.refusals.length === 0 ? null : (
          <ul className="mc-activity__refusals">
            {silence.refusals.map((tally) => (
              // The code translated, never the code shown: `no_keyword` on a
              // panel is the defect REQ-163 exists to prevent, and the key is
              // derived by the same function the guard checks.
              <li key={tally.reason} data-refusal={tally.reason}>
                {t("dashboard.activity.refusalCount", {
                  reason: t(matchRefusalTextKey(tally.reason)),
                  count: formatters.number(tally.count),
                })}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

/** The units the relative reading is said in, in milliseconds. */
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

interface Elapsed {
  readonly unit: ElapsedUnit;
  /** Whole units, and the number the catalogue picks its plural form by. */
  readonly count: number;
}

/**
 * How long before `asOf` the instant `at` was, in whole units of one size.
 *
 * PURE, and the reference is an ARGUMENT rather than the browser's clock, which
 * is the whole of what makes this line testable: "ten minutes ago" read off
 * `Date.now()` is a different sentence every time the suite runs, and the fix is
 * the same one the engine uses for every other instant in this project (a clock
 * is injected, never read from inside). The reference this screen passes is the
 * answer's own `window.until`, which the aggregation sets to the instant the
 * read was taken at, so this reading and the counts beside it are measured from
 * ONE instant and no line can be more recent than the page it sits on.
 *
 * Never a reading in the future: an event stamped after the read (a row written
 * between the query and the answer, a clock a second out) says it just happened
 * rather than "in -1 minutes", which is not a thing that has occurred.
 *
 * Whole units, rounded DOWN, because the exact instant is beside it: "1 hour
 * ago" for eighty minutes loses nothing an operator cannot read off the line,
 * and a rounded up "2 hours" would name an hour the record does not carry.
 */
function elapsedSince(at: string, asOf: string): Elapsed {
  const millis = Math.max(0, Date.parse(asOf) - Date.parse(at));

  if (millis < MINUTE_MS) {
    return { unit: "now", count: 0 };
  }

  if (millis < HOUR_MS) {
    return { unit: "minutes", count: Math.floor(millis / MINUTE_MS) };
  }

  if (millis < DAY_MS) {
    return { unit: "hours", count: Math.floor(millis / HOUR_MS) };
  }

  return { unit: "days", count: Math.floor(millis / DAY_MS) };
}

/**
 * One event: who, in their own words, what became of it, and when.
 *
 * The instant is read in the zone the ANSWER carries, like every other instant
 * on this page (REQ-153, REQ-165): an operator comparing this line against the
 * platform's own record has to see the clock their instance runs on, and a line
 * read in UTC would be three hours off with nothing saying why.
 *
 * TWO READINGS OF THE SAME INSTANT, side by side (REQ-182), because the line is
 * asked two different questions. "When exactly" is the one that gets compared
 * against the platform's own record, or quoted when somebody asks what time it
 * broke, and only an absolute instant in a named zone answers it. "How recent"
 * is the one a glance asks, and answering it from a timestamp is arithmetic the
 * operator has to do in their head, every line, all the way down the list.
 *
 * The absolute comes FIRST and stays the information proper: the relative is a
 * reading OF it, it is the coarser of the two, and the day the two disagree the
 * exact one is the one to trust.
 *
 * BOTH are announced, and both are a `<time>` carrying the SAME `dateTime`. The
 * relative one is not decoration and is not hidden from assistive technology:
 * "how recent" is a question of its own, and a screen reader given the instant
 * alone would be left doing exactly the mental arithmetic this pair removes,
 * which is the requirement in as many words. The proportional bars in the tables
 * ARE hidden, and the difference is the test: a bar says nothing the figure does
 * not already say, while "just now" says something a timestamp only implies.
 * Repeating `dateTime` on both is what keeps them one fact rather than two: any
 * reader of the markup gets the same exact instant from either element.
 */
function ActivityLine({
  event,
  asOf,
  formatters,
}: {
  readonly event: ActivityEventView;
  /** The instant the answer was read at, which "how recent" is counted from. */
  readonly asOf: string;
  readonly formatters: Formatters;
}): ReactElement {
  const { t } = useLocale();
  const [detailsOpen, setDetailsOpen] = useState(false);
  const detailsId = useId();

  const said = saidStateOf(event.eventText);
  const elapsed = elapsedSince(event.at, asOf);

  const who =
    event.contactUsername !== undefined
      ? t("dashboard.activity.contact", { username: event.contactUsername })
      : event.contactId !== undefined
        ? t("dashboard.activity.contactId", { id: event.contactId })
        : t("dashboard.activity.noContact");

  const eventChip = activityEventChip(event.subtype, t);
  const actionChips: readonly {
    readonly key: string;
    readonly label: string;
    readonly tone: ChipTone;
    readonly icon: IconName;
    readonly className: string;
  }[] = event.actions.map((action) => ({
    key: `${action.at}-${action.subtype}`,
    ...activityActionChip(action.subtype, t),
    tone: action.outcome === "failed" ? "neutral" : "accent",
  }));

  const hasDetails =
    event.silence !== undefined ||
    event.actions.some(
      (action) =>
        action.outcome !== "ok" ||
        action.reason !== undefined ||
        action.detail !== undefined,
    ) ||
    event.outcome !== "ok";

  return (
    // The verdict the aggregation decided, carried on the line that shows it,
    // so a test reads it here instead of inferring it from a tint.
    <li
      className="mc-activity__item"
      data-event-id={event.eventId}
      data-outcome={event.outcome}
    >
      <div className="mc-activity__head">
        <div className="mc-activity__summary">
          <span className="mc-activity__who">{who}</span>

          {/* The contact's own text, verbatim, and the three states of it kept
              apart. It is content and not wording: no catalogue holds it, and
              translating it would be a lie. */}
          <span className="mc-activity__said" data-text={said}>
            {said === "present"
              ? t("dashboard.activity.text", { text: event.eventText })
              : said === "empty"
                ? t("dashboard.activity.noWords")
                : t("dashboard.activity.noText")}
          </span>
        </div>

        <div
          className="mc-activity__chips"
          aria-label={t("dashboard.activity.chipsLabel")}
        >
          <ActivityChip chip={eventChip} />
          {actionChips.map((action) => (
            <ActivityChip key={action.key} chip={action} />
          ))}
          {event.outcome === "ok" ? null : (
            <StatusBadge
              state={OUTCOME_BADGE_STATES[event.outcome]}
              dot={false}
            >
              {t(arrivalTextKey(event.outcome))}
            </StatusBadge>
          )}
        </div>

        <span className="mc-activity__meta">
          <time dateTime={event.at}>{formatters.instant(event.at)}</time>
          {/* The same instant, read as a distance instead of as a clock. The
              unit is carried as data, so a test reads WHICH step was chosen
              from the line rather than inferring it from a sentence, exactly as
              the outcome and the reason above are read. */}
          <time dateTime={event.at} data-elapsed={elapsed.unit}>
            {t(ELAPSED_KEYS[elapsed.unit], { count: elapsed.count })}
          </time>
        </span>
      </div>

      {hasDetails ? (
        <>
          <Button
            variant="secondary"
            className="mc-activity__details-toggle"
            aria-expanded={detailsOpen}
            aria-controls={detailsId}
            onClick={(): void => {
              setDetailsOpen((open) => !open);
            }}
          >
            {detailsOpen
              ? t("dashboard.activity.hideDetails")
              : t("dashboard.activity.showDetails")}
          </Button>
          <div
            id={detailsId}
            className="mc-activity__details"
            hidden={!detailsOpen}
          >
            {detailsOpen ? (
              <ActivityDetails event={event} formatters={formatters} />
            ) : null}
          </div>
        </>
      ) : null}
    </li>
  );
}

/** One visual vocabulary for activity rows and the legend that explains it. */
function ActivityChip({
  chip,
}: {
  readonly chip: {
    readonly label: string;
    readonly icon: IconName;
    readonly className: string;
    readonly tone?: ChipTone;
  };
}): ReactElement {
  return (
    <Chip tone={chip.tone ?? "neutral"} className={chip.className}>
      <Icon name={chip.icon} size={ICON_SIZE.chip} />
      {chip.label}
    </Chip>
  );
}

/** The short, visual vocabulary of the compact activity row (REQ-404). */
function activityEventChip(
  subtype: ActivityEventView["subtype"],
  t: Translate,
): {
  readonly label: string;
  readonly icon: IconName;
  readonly className: string;
} {
  if (subtype === "comment") {
    return {
      label: t("dashboard.activity.chip.commented"),
      icon: "message-circle",
      className: "mc-activity__chip--comment",
    };
  }

  if (subtype === "direct_message") {
    return {
      label: t("dashboard.activity.chip.directMessage"),
      icon: "message-circle",
      className: "mc-activity__chip--message",
    };
  }

  const eventLabelKey = EVENT_LABEL_KEYS[subtype];
  return {
    label:
      eventLabelKey === undefined
        ? t("screens.dashboard.unnamedType", { code: subtype })
        : t(eventLabelKey),
    icon: "info",
    className: "mc-activity__chip--technical",
  };
}

function activityActionChip(
  subtype: ActivityActionView["subtype"],
  t: Translate,
): {
  readonly label: string;
  readonly icon: IconName;
  readonly className: string;
} {
  if (subtype === "comment_reply") {
    return {
      label: t("dashboard.activity.chip.commentReply"),
      icon: "check",
      className: "mc-activity__chip--reply",
    };
  }

  if (subtype === "message_sent") {
    return {
      label: t("dashboard.activity.chip.messageAccepted"),
      icon: "clock",
      className: "mc-activity__chip--queued",
    };
  }

  if (
    subtype === "button_clicked" ||
    subtype === "button_click" ||
    subtype === "link_clicked"
  ) {
    return {
      label: t("dashboard.activity.chip.clicked"),
      icon: "link",
      className: "mc-activity__chip--click",
    };
  }

  return {
    label: activityActionChipLabel(subtype, t),
    icon: "info",
    className: "mc-activity__chip--technical",
  };
}

function activityActionChipLabel(
  subtype: ActivityActionView["subtype"],
  t: Translate,
): string {
  if (subtype === "comment_reply") {
    return t("dashboard.activity.chip.commentReply");
  }

  if (subtype === "message_sent") {
    return t("dashboard.activity.chip.messageAccepted");
  }

  const key = ACTION_LABEL_KEYS[subtype];
  return key === undefined
    ? t("screens.dashboard.unnamedType", { code: subtype })
    : t(key);
}

function ActivityDetails({
  event,
  formatters,
}: {
  readonly event: ActivityEventView;
  readonly formatters: Formatters;
}): ReactElement {
  const { t } = useLocale();

  return (
    <>
      {event.silence === undefined ? null : (
        <Silence silence={event.silence} formatters={formatters} />
      )}
      {event.actions.length === 0 ? null : (
        <ul className="mc-activity__actions">
          {event.actions.map((action, index) => (
            <li
              key={`${action.at}-${action.subtype}-${String(index)}`}
              className="mc-activity__action"
              data-outcome={action.outcome}
            >
              <span>{activityActionChipLabel(action.subtype, t)}</span>
              <StatusBadge
                state={OUTCOME_BADGE_STATES[action.outcome]}
                dot={false}
              >
                {t(actionOutcomeTextKey(action.outcome))}
              </StatusBadge>
              {action.reason === undefined ? null : (
                <span className="mc-activity__why" data-reason={action.reason}>
                  {t(actionReasonTextKey(action.reason))}
                  {action.detail === undefined ? null : (
                    <span
                      className="mc-activity__detail"
                      data-detail={action.detail}
                    >
                      {t("dashboard.activity.reasonDetail", {
                        detail: action.detail,
                      })}
                    </span>
                  )}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      {event.silence === undefined && event.actions.length === 0 ? (
        <p className="mc-activity__note">
          {t("dashboard.activity.nothingDone")}
        </p>
      ) : null}
    </>
  );
}

function executionStatusText(
  status: MessageLifecycleStatusView,
  t: Translate,
): string {
  return t(`dashboard.activity.execution.status.${status}`);
}

function executionEventText(
  event: ExecutionLifecycleEventView,
  t: Translate,
): string {
  if (event.kind === "clicked") {
    return event.buttonLabel === undefined
      ? t("dashboard.activity.execution.clicked")
      : t("dashboard.activity.execution.clickedLabel", {
          label: event.buttonLabel,
        });
  }
  if (event.kind === "message_queued")
    return t("dashboard.activity.execution.status.queued");
  if (event.kind === "message_accepted")
    return t("dashboard.activity.execution.status.accepted");
  if (event.kind === "message_seen")
    return t("dashboard.activity.execution.status.seen");
  if (event.kind === "message_failed")
    return t("dashboard.activity.execution.status.failed");
  if (event.kind === "received")
    return t("dashboard.activity.execution.received");
  return event.subtype === undefined
    ? t("dashboard.activity.execution.action")
    : activityActionChipLabel(event.subtype, t);
}

function ExecutionLine({
  execution,
  formatters,
}: {
  readonly execution: ExecutionLifecycleView;
  readonly formatters: Formatters;
}): ReactElement {
  const { t } = useLocale();
  const [detailsOpen, setDetailsOpen] = useState(false);
  const detailsId = useId();
  const summary = execution.summary;
  const statuses = (["queued", "accepted", "seen", "failed"] as const).filter(
    (status) => summary[status] > 0,
  );
  const failure = execution.messages
    .flatMap((message) => message.events)
    .find(
      (event) =>
        event.kind === "message_failed" &&
        (event.detail !== undefined || event.reason !== undefined),
    );

  return (
    <li
      className="mc-activity__item mc-activity__execution"
      data-execution-id={execution.executionId}
    >
      <div className="mc-activity__head">
        <div className="mc-activity__summary">
          <span className="mc-activity__who">
            {t("dashboard.activity.execution.run")}
          </span>
          <span className="mc-activity__said">
            {t("dashboard.activity.execution.summary", {
              count: summary.total,
            })}
          </span>
        </div>
        <div
          className="mc-activity__chips"
          aria-label={t("dashboard.activity.execution.summaryLabel")}
        >
          {statuses.map((status) => (
            <ActivityChip
              key={status}
              chip={{
                label: `${summary[status]} ${executionStatusText(status, t)}`,
                icon:
                  status === "failed"
                    ? "circle-alert"
                    : status === "seen"
                      ? "circle-check"
                      : status === "accepted"
                        ? "check"
                        : "clock",
                className: `mc-activity__chip--execution mc-activity__chip--${status}`,
                tone: status === "failed" ? "neutral" : "accent",
              }}
            />
          ))}
        </div>
        <span className="mc-activity__meta">
          <time dateTime={execution.updatedAt}>
            {formatters.instant(execution.updatedAt)}
          </time>
        </span>
      </div>
      {failure === undefined ? null : (
        <p className="mc-activity__failure" data-reason={failure.reason}>
          {failure.detail === undefined
            ? t("dashboard.activity.execution.failure")
            : t("dashboard.activity.reasonDetail", { detail: failure.detail })}
        </p>
      )}
      <Button
        variant="secondary"
        className="mc-activity__details-toggle"
        aria-expanded={detailsOpen}
        aria-controls={detailsId}
        onClick={(): void => setDetailsOpen((open) => !open)}
      >
        {detailsOpen
          ? t("dashboard.activity.hideDetails")
          : t("dashboard.activity.showDetails")}
      </Button>
      <div
        id={detailsId}
        className="mc-activity__details"
        hidden={!detailsOpen}
      >
        {detailsOpen ? (
          <ol
            className="mc-activity__timeline"
            aria-label={t("dashboard.activity.execution.timeline")}
          >
            {execution.events.map((event, index) => (
              <li
                key={`${event.at}-${event.kind}-${index}`}
                data-kind={event.kind}
              >
                <time dateTime={event.at}>{formatters.instant(event.at)}</time>
                <span>{executionEventText(event, t)}</span>
                {event.detail === undefined ? null : (
                  <span
                    className="mc-activity__detail"
                    data-detail={event.detail}
                  >
                    {t("dashboard.activity.reasonDetail", {
                      detail: event.detail,
                    })}
                  </span>
                )}
              </li>
            ))}
          </ol>
        ) : null}
      </div>
    </li>
  );
}

/**
 * The recent activity: the window read event by event (REQ-165).
 *
 * LAST on the page, and the position is a decision. This is the only block
 * whose height is the traffic's rather than the layout's, so anything placed
 * under it would sit past fifty rows of scrolling; the blocks above answer "how
 * much happened", and this one answers "what happened, and to whom".
 *
 * The list is CUT at the cap the answer declares, and it says so in figures
 * rather than fading out: an operator who cannot tell a short list from a
 * truncated one will read "eight events today" off a page showing eight of
 * three hundred.
 */
function Activity({
  activity,
  asOf,
  formatters,
  onViewAll,
}: {
  readonly activity: RecentActivityView;
  /**
   * The instant every "how recent" on this list is counted from (REQ-182).
   *
   * It comes from the ANSWER and never from this side: the window the aggregation
   * cut ends at the clock instant of the read, and passing that instant down is
   * what keeps the list from claiming an event is more recent than the figures
   * printed above it.
   */
  readonly asOf: string;
  readonly formatters: Formatters;
  /** Present on the overview, where a compact sample leads to the full list. */
  readonly onViewAll?: () => void;
}): ReactElement {
  const { t } = useLocale();
  const headingId = useId();
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);

  const diagnosticItems = activity.items.filter(isDiagnosticActivity);
  const regularItems = activity.items.filter(
    (event) => !isDiagnosticActivity(event),
  );
  // A bare execution identity from a historic fact is not proof of a direct
  // message lifecycle. Showing it as “0 direct messages” creates a prominent
  // but empty row; it remains in the historical event trail instead.
  const lifecycleExecutions = activity.executions?.filter(
    (execution) => execution.summary.total > 0,
  );
  const shown = regularItems.length;

  return (
    <section className="mc-panel" aria-labelledby={headingId}>
      <div className="mc-panel__head">
        <h2 id={headingId} className="mc-panel__title">
          {t("dashboard.activity.title")}
        </h2>
      </div>

      <div
        className="mc-activity__legend"
        aria-label={t("dashboard.activity.legendLabel")}
      >
        <span className="mc-activity__legend-title">
          {t("dashboard.activity.legendLabel")}
        </span>
        <ul className="mc-activity__legend-list">
          <li>
            <ActivityChip chip={activityEventChip("comment", t)} />
            <span className="mc-activity__legend-description">
              {t("dashboard.activity.legend.commented")}
            </span>
          </li>
          <li>
            <ActivityChip
              chip={{
                ...activityActionChip("comment_reply", t),
                tone: "accent",
              }}
            />
            <span className="mc-activity__legend-description">
              {t("dashboard.activity.legend.commentReply")}
            </span>
          </li>
          <li>
            <ActivityChip
              chip={{
                ...activityActionChip("message_sent", t),
                tone: "accent",
              }}
            />
            <span className="mc-activity__legend-description">
              {t("dashboard.activity.legend.messageAccepted")}
            </span>
          </li>
          <li>
            <ActivityChip
              chip={{
                ...activityActionChip("link_clicked", t),
                tone: "accent",
              }}
            />
            <span className="mc-activity__legend-description">
              {t("dashboard.activity.legend.clicked")}
            </span>
          </li>
        </ul>
      </div>

      {diagnosticItems.length === 0 ? null : (
        <div className="mc-activity__diagnostics">
          <Button
            variant="ghost"
            aria-pressed={diagnosticsOpen}
            onClick={(): void => {
              setDiagnosticsOpen((open) => !open);
            }}
          >
            {diagnosticsOpen
              ? t("dashboard.activity.hideDiagnostics", {
                  count: formatters.number(diagnosticItems.length),
                })
              : t("dashboard.activity.showDiagnostics", {
                  count: formatters.number(diagnosticItems.length),
                })}
          </Button>
          {diagnosticsOpen ? (
            <p className="mc-panel__note">
              {t("dashboard.activity.diagnosticsHint")}
            </p>
          ) : null}
        </div>
      )}

      {(lifecycleExecutions?.length ?? 0) > 0 ? (
        <ol className="mc-activity mc-activity__executions">
          {lifecycleExecutions?.map((execution) => (
            <ExecutionLine
              key={execution.executionId}
              execution={execution}
              formatters={formatters}
            />
          ))}
        </ol>
      ) : null}

      {shown === 0 && (lifecycleExecutions?.length ?? 0) === 0 ? (
        // A designed state and not a gap: a fresh instance records nothing
        // until the first comment arrives, and an operator who cannot tell that
        // from a failure goes hunting for a fault that is not there (REQ-115).
        <EmptyState icon={null} title={t("dashboard.activity.empty")}>
          {t("screens.dashboard.noActivityHint")}
        </EmptyState>
      ) : shown === 0 ? null : (lifecycleExecutions?.length ?? 0) > 0 ? (
        <section
          className="mc-activity__historical"
          aria-label={t("dashboard.activity.historicalTitle")}
        >
          <h3>{t("dashboard.activity.historicalTitle")}</h3>
          <p className="mc-panel__note">
            {t("dashboard.activity.historicalHint")}
          </p>
          <ol className="mc-activity">
            {regularItems.map((event) => (
              <ActivityLine
                key={event.eventId}
                event={event}
                asOf={asOf}
                formatters={formatters}
              />
            ))}
          </ol>
        </section>
      ) : (
        <ol className="mc-activity">
          {regularItems.map((event) => (
            <ActivityLine
              key={event.eventId}
              event={event}
              asOf={asOf}
              formatters={formatters}
            />
          ))}
        </ol>
      )}

      {activity.total > shown ? (
        <p className="mc-panel__note">
          {t("dashboard.activity.truncated", {
            shown: formatters.number(shown),
            total: formatters.number(activity.total),
          })}
        </p>
      ) : null}

      {diagnosticsOpen ? (
        <section
          className="mc-activity__technical"
          aria-label={t("dashboard.activity.technicalTitle")}
        >
          <h3>{t("dashboard.activity.technicalTitle")}</h3>
          <ol className="mc-activity">
            {diagnosticItems.map((event) => (
              <ActivityLine
                key={event.eventId}
                event={event}
                asOf={asOf}
                formatters={formatters}
              />
            ))}
          </ol>
        </section>
      ) : null}

      {onViewAll === undefined ? null : (
        <Button variant="secondary" onClick={onViewAll}>
          {t("screens.dashboard.viewAllActivity")}
        </Button>
      )}
    </section>
  );
}

/**
 * A webhook delivery can be retained even when it yielded no interaction at
 * all. Such a row has no contact, no payload text and no known subtype, so it
 * cannot help an operator understand an automation run. It remains available
 * in Diagnostics, where it is useful to investigate payload translation.
 */
function isDiagnosticActivity(event: ActivityEventView): boolean {
  const numericOnlyContact =
    event.contactUsername === undefined &&
    event.contactId !== undefined &&
    /^\d+$/.test(event.contactId);
  // “Nothing triggered” is useful for diagnosis, but not the compact operator
  // reading. It stays intact behind the diagnostic control with its reason.
  return (
    numericOnlyContact ||
    (event.contactId === undefined &&
      event.contactUsername === undefined &&
      event.eventText === undefined &&
      EVENT_LABEL_KEYS[event.subtype] === undefined)
  );
}

type DashboardView = "overview" | "links" | "activity";

const DASHBOARD_VIEW_KEYS: Readonly<Record<DashboardView, string>> = {
  overview: "screens.dashboard.views.overview",
  links: "screens.dashboard.views.links",
  activity: "screens.dashboard.views.activity",
};

function DashboardNavigation({
  active,
  onSelect,
}: {
  readonly active: DashboardView;
  readonly onSelect: (view: DashboardView) => void;
}): ReactElement {
  const { t } = useLocale();

  return (
    <nav
      className="mc-dashboard-nav"
      aria-label={t("screens.dashboard.views.label")}
    >
      <ul className="mc-dashboard-nav__list">
        {(Object.keys(DASHBOARD_VIEW_KEYS) as DashboardView[]).map((view) => (
          <li key={view}>
            <Button
              variant={active === view ? "primary" : "secondary"}
              aria-current={active === view ? "page" : undefined}
              onClick={(): void => {
                onSelect(view);
              }}
            >
              {t(DASHBOARD_VIEW_KEYS[view])}
            </Button>
          </li>
        ))}
      </ul>
    </nav>
  );
}

/**
 * The engagement view reports only facts this instance recorded. A post row
 * carries the persisted publication snapshot, so it never turns an old click
 * into an attribution guess after an automation is edited.
 */
function LinksOverview({
  metrics,
  formatters,
}: {
  readonly metrics: DashboardMetricsView;
  readonly formatters: Formatters;
}): ReactElement {
  const { t } = useLocale();
  const headingId = useId();
  const links = metrics.links;
  const trend = links?.trend;
  const posts = links?.posts ?? [];
  const unattributed = links?.unattributedClicks ?? 0;
  const [selectedPostId, setSelectedPostId] = useState<string>();
  const selectedPost = posts.find(
    (post) => post.publicationId === selectedPostId,
  );
  const periods = (trend?.buckets ?? []).map((bucket) =>
    formatters.bucket(bucket, trend?.granularity ?? metrics.window.granularity),
  );
  const hasFacts = (links?.totals.clicks ?? 0) > 0;

  return (
    <>
      <section className="mc-panel" aria-labelledby={headingId}>
        <div className="mc-panel__head">
          <h2 id={headingId} className="mc-panel__title">
            {t("screens.dashboard.linksTitle")}
          </h2>
        </div>
        <dl className="mc-figures mc-summary">
          <Figure
            label={t("screens.dashboard.linkClicks")}
            value={formatters.number(links?.totals.clicks ?? 0)}
          />
          <Figure
            label={t("screens.dashboard.uniqueContacts")}
            value={formatters.number(links?.totals.uniqueContacts ?? 0)}
          />
          <Figure
            label={t("screens.dashboard.postsWithClicks")}
            value={formatters.number(links?.totals.publications ?? 0)}
          />
        </dl>
        <p className="mc-panel__note">{t("screens.dashboard.linksIntro")}</p>
      </section>

      {!hasFacts ? (
        <section className="mc-panel" aria-labelledby="link-empty-title">
          <EmptyState
            icon={null}
            title={t("screens.dashboard.linksEmptyTitle")}
          >
            {t("screens.dashboard.linksEmptyHint")}
          </EmptyState>
        </section>
      ) : null}

      {trend === undefined ? null : (
        <section className="mc-panel" aria-labelledby="link-trend-title">
          <div className="mc-panel__head">
            <h2 id="link-trend-title" className="mc-panel__title">
              {t("screens.dashboard.linkTrendTitle")}
            </h2>
            <StatusBadge state="neutral" dot={false}>
              {t(GRANULARITY_KEYS[trend.granularity])}
            </StatusBadge>
          </div>
          <TrendChart
            label={t("screens.dashboard.linkTrendChart")}
            axes={{
              x: t("screens.dashboard.chartXAxis"),
              y: t("screens.dashboard.chartYAxis"),
            }}
            note={t("screens.dashboard.linkTrendNote")}
            periods={periods}
            series={[
              {
                key: "clicks",
                label: t("screens.dashboard.linkClicks"),
                counts: trend.counts,
                peakLabel: t("screens.dashboard.chartPeak", {
                  count: formatters.number(Math.max(0, ...trend.counts)),
                }),
              },
            ]}
          />
        </section>
      )}

      <section className="mc-panel" aria-labelledby="link-posts-title">
        <div className="mc-panel__head">
          <h2 id="link-posts-title" className="mc-panel__title">
            {t("screens.dashboard.linkPostsTitle")}
          </h2>
        </div>
        {posts.length === 0 && unattributed === 0 ? (
          <EmptyState icon={null} title={t("screens.dashboard.linkPostsEmpty")}>
            {t("screens.dashboard.linkPostsEmptyHint")}
          </EmptyState>
        ) : posts.length === 0 ? null : (
          <ul className="mc-link-posts">
            {posts.map((post) => (
              <li key={post.publicationId} className="mc-link-post">
                <div className="mc-link-post__identity">
                  {post.publication?.thumbnailKey === undefined ? (
                    <div
                      className="mc-link-post__thumbnail mc-link-post__thumbnail--missing"
                      aria-hidden="true"
                    >
                      <Icon name="image" size={ICON_SIZE.text} />
                    </div>
                  ) : (
                    <img
                      className="mc-link-post__thumbnail"
                      src={`/${post.publication.thumbnailKey}`}
                      alt=""
                    />
                  )}
                  <div className="mc-link-post__copy">
                    <p className="mc-link-post__caption">
                      {post.publication?.caption ??
                        t("screens.dashboard.linkPostUnavailable")}
                    </p>
                  </div>
                </div>
                <dl
                  className="mc-link-post__figures"
                  aria-label={t("screens.dashboard.linkPostFunnel", {
                    id: post.publicationId,
                  })}
                >
                  <div>
                    <dt>{t("screens.dashboard.linkCommentsLabel")}</dt>
                    <dd>{formatters.number(post.comments)}</dd>
                  </div>
                  <div>
                    <dt>{t("screens.dashboard.linkClicks")}</dt>
                    <dd>{formatters.number(post.clicks)}</dd>
                  </div>
                </dl>
                <Button
                  variant="secondary"
                  onClick={(): void => setSelectedPostId(post.publicationId)}
                >
                  {t("screens.dashboard.linkViewDetails")}
                </Button>
              </li>
            ))}
          </ul>
        )}
        {unattributed === 0 ? null : (
          <aside
            className="mc-link-unattributed"
            aria-labelledby="link-unattributed-title"
          >
            <div>
              <h3 id="link-unattributed-title">
                {t("screens.dashboard.linkUnattributedTitle")}
              </h3>
              <p>{t("screens.dashboard.linkUnattributedHint")}</p>
            </div>
            <strong className="mc-link-unattributed__count">
              {t("screens.dashboard.linkUnattributedCount", {
                count: formatters.number(unattributed),
              })}
            </strong>
          </aside>
        )}
      </section>

      {selectedPost === undefined ? null : (
        <Modal
          title={t("screens.dashboard.linkDetailsTitle")}
          lead={
            selectedPost.publication?.caption ??
            t("screens.dashboard.linkPostUnavailable")
          }
          size="md"
          closeLabel={t("screens.dashboard.linkDetailsClose")}
          onClose={(): void => setSelectedPostId(undefined)}
        >
          <div className="mc-link-details">
            <section aria-labelledby="link-details-comments">
              <h3 id="link-details-comments">
                {t("screens.dashboard.linkDetailsComments")}
              </h3>
              {selectedPost.commentDetails.length === 0 ? (
                <p>{t("screens.dashboard.linkDetailsCommentsEmpty")}</p>
              ) : (
                <ul>
                  {selectedPost.commentDetails.map((comment, index) => (
                    <li key={`${comment.text ?? "empty"}-${index}`}>
                      <span>
                        {comment.text ??
                          t("screens.dashboard.linkCommentWithoutText")}
                      </span>
                      {comment.matchedKeyword === undefined ? null : (
                        <Chip tone="neutral">
                          {t("screens.dashboard.linkMatchedKeyword", {
                            keyword: comment.matchedKeyword,
                          })}
                        </Chip>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </section>
            <section aria-labelledby="link-details-links">
              <h3 id="link-details-links">
                {t("screens.dashboard.linkDetailsLinks")}
              </h3>
              {selectedPost.links.length === 0 ? (
                <p>{t("screens.dashboard.linkDetailsLinksEmpty")}</p>
              ) : (
                <ul>
                  {selectedPost.links.map((link, index) => (
                    <li key={`${link.label ?? "legacy"}-${index}`}>
                      <span>
                        {link.label ??
                          t("screens.dashboard.linkHistoricalLabel")}
                      </span>
                      <strong>
                        {t("screens.dashboard.linkClicksCount", {
                          count: formatters.number(link.clicks),
                        })}
                      </strong>
                    </li>
                  ))}
                </ul>
              )}
            </section>
            <p className="mc-link-details__id">
              {t("screens.dashboard.linkPostDetailId", {
                id: selectedPost.publicationId,
              })}
            </p>
          </div>
        </Modal>
      )}
    </>
  );
}

type Load =
  | { readonly status: "loading" }
  | { readonly status: "failed" }
  | { readonly status: "unauthorized" }
  | { readonly status: "ready"; readonly metrics: DashboardMetricsView };

export interface DashboardScreenProps {
  /** Injected by tests. The running interface always talks to the API. */
  readonly client?: DashboardClient;
  /** Injected by tests. The operator lands on the finest range. */
  readonly range?: DashboardRange;
}

export function DashboardScreen({
  client = httpDashboardClient,
  range: initialRange = "last_24_hours",
}: DashboardScreenProps = {}): ReactElement {
  const { locale, t } = useLocale();
  const [range, setRange] = useState<DashboardRange>(initialRange);
  const [view, setView] = useState<DashboardView>("overview");
  const [attempt, setAttempt] = useState(0);
  const [load, setLoad] = useState<Load>({ status: "loading" });
  /**
   * Whether the granular reading is open (REQ-180). Shut when the page opens,
   * which is the requirement, and held HERE rather than inside `Detail` because
   * everything below the load gate is unmounted while a read is in flight: a
   * state kept there would come back shut every time the operator changed the
   * period, which is the screen undoing a choice they made.
   */
  const [detailOpen, setDetailOpen] = useState(false);
  const detailPanelId = useId();

  // The zone of the answer on screen, never a zone chosen here: the buckets
  // were cut in it (REQ-153), and a page that read them in any other one would
  // label a column after an hour it does not count. Before the first answer
  // there is nothing to read, which is all the fallback is for.
  const zone =
    load.status === "ready" ? load.metrics.window.zone : FALLBACK_ZONE;

  const formatters = useMemo(
    () => createFormatters(locale, zone),
    [locale, zone],
  );

  useEffect(() => {
    // Answers to a range the operator has already moved away from are dropped
    // rather than rendered: without this, a slow first request landing after a
    // fast second one would paint yesterday's numbers under today's heading.
    let current = true;

    setLoad({ status: "loading" });

    void (async (): Promise<void> => {
      try {
        const metrics = await client.read(range);
        if (current) {
          setLoad({ status: "ready", metrics });
        }
      } catch (failure) {
        if (current) {
          setLoad({
            status: isUnauthorizedFailure(failure) ? "unauthorized" : "failed",
          });
        }
      }
    })();

    return (): void => {
      current = false;
    };
  }, [client, range, attempt]);

  const retry = useCallback((): void => {
    setAttempt((previous) => previous + 1);
  }, []);

  const toggleDetail = useCallback((): void => {
    setDetailOpen((was) => !was);
  }, []);

  return (
    <div className="mc-page">
      <div className="mc-page__head">
        <div className="mc-page__titles">
          <h1>{t("screens.dashboard.title")}</h1>
          {load.status === "ready" ? (
            <p className="mc-page__lead">
              {t("screens.dashboard.period", {
                since: formatters.instant(load.metrics.window.since),
                until: formatters.instant(load.metrics.window.until),
              })}
            </p>
          ) : null}
        </div>

        <div
          role="group"
          className="mc-row"
          aria-label={t("screens.dashboard.rangeLegend")}
        >
          {DASHBOARD_RANGES.map((option) => (
            <Button
              key={option}
              variant={option === range ? "primary" : "secondary"}
              // Marked rather than disabled: the chosen range still has to be
              // visible, and a disabled button in a row of three reads as
              // broken. The weight and the attribute say the same thing, which
              // is what keeps the mark off colour alone (REQ-038).
              aria-current={option === range}
              onClick={(): void => {
                setRange(option);
              }}
            >
              {t(RANGE_LABEL_KEYS[option])}
            </Button>
          ))}
        </div>
      </div>

      <DashboardNavigation active={view} onSelect={setView} />

      {load.status === "loading" ? (
        <PendingState
          label={t("screens.dashboard.loading")}
          skeleton={LOADING_SKELETON}
        />
      ) : null}

      {load.status === "failed" ? (
        // An `error` notice and not a `warning`: nothing usable is left on
        // screen, and the one thing worth offering is the read again.
        <Notice
          nature="error"
          actions={
            <Button variant="secondary" icon="refresh-cw" onClick={retry}>
              {t("screens.dashboard.retry")}
            </Button>
          }
        >
          {t("screens.dashboard.error")}
        </Notice>
      ) : null}

      {load.status === "unauthorized" ? <SessionExpiredNotice /> : null}

      {load.status === "ready" ? (
        <>
          {load.metrics.openAlert === undefined ? null : (
            <Notice
              nature="warning"
              title={t(
                load.metrics.openAlert.origin === "machine"
                  ? "screens.dashboard.machineAlertTitle"
                  : "screens.dashboard.operationalAlertTitle",
              )}
            >
              <span>{load.metrics.openAlert.reason}</span>{" "}
              <time dateTime={load.metrics.openAlert.occurredAt}>
                {t("screens.dashboard.operationalAlertAt", {
                  at: formatters.instant(load.metrics.openAlert.occurredAt),
                })}
              </time>
            </Notice>
          )}

          {(load.metrics.disabledTriggers ?? []).length === 0 ? null : (
            <Notice
              nature="warning"
              title={t("screens.dashboard.triggersOffTitle")}
            >
              <ul>
                {(load.metrics.disabledTriggers ?? []).map((item) => (
                  <li key={item.name} data-trigger-switch={item.name}>
                    {triggerName(item.name, t)}{" "}
                    <time dateTime={item.updatedAt}>
                      {t("screens.dashboard.triggerOffAt", {
                        at: formatters.instant(item.updatedAt),
                      })}
                    </time>
                  </li>
                ))}
              </ul>
            </Notice>
          )}

          {view === "overview" ? (
            <>
              <Summary metrics={load.metrics} formatters={formatters} />
              <Caps caps={load.metrics.caps} formatters={formatters} />
              <Volume metrics={load.metrics} formatters={formatters} />
              <Detail
                metrics={load.metrics}
                formatters={formatters}
                open={detailOpen}
                panelId={detailPanelId}
                onToggle={toggleDetail}
              />
              <Activity
                activity={load.metrics.activity}
                asOf={load.metrics.window.until}
                formatters={formatters}
                onViewAll={(): void => {
                  setView("activity");
                }}
              />
            </>
          ) : null}

          {view === "links" ? (
            <LinksOverview metrics={load.metrics} formatters={formatters} />
          ) : null}

          {view === "activity" ? (
            <>
              <Detail
                metrics={load.metrics}
                formatters={formatters}
                open={detailOpen}
                panelId={detailPanelId}
                onToggle={toggleDetail}
              />
              <Activity
                activity={load.metrics.activity}
                asOf={load.metrics.window.until}
                formatters={formatters}
              />
            </>
          ) : null}

          {/* The zone NAMED, and named with the value the answer carried: an
              operator comparing a column against the platform's own record has
              to know which clock the column is on, and a sentence that stated a
              zone of its own would be right only until the configuration
              changed (REQ-153). */}
          <p className="mc-source">
            <Icon name="clock" size={ICON_SIZE.chip} />
            {t("screens.dashboard.zoneNote", {
              zone: load.metrics.window.zone,
            })}
          </p>
        </>
      ) : null}
    </div>
  );
}
