import { DASHBOARD_RANGES } from "../../dashboard/aggregate.js";
import type {
  ActivityAction,
  ActivityEvent,
  ExecutionLifecycle,
  ExecutionLifecycleEvent,
  MessageLifecycle,
  CapUsage,
  CountSeries,
  DashboardMetrics,
  DashboardRange,
  QueueSnapshot,
  RecentActivity,
  LinkAnalytics,
  TypeBreakdown,
} from "../../dashboard/aggregate.js";
import { isActionReason } from "../../engine/execute.js";
import type { OperationalStatus } from "../../platform/status.js";
import type { TriggerSwitchPreference } from "../../config/trigger-switches.js";
import type { FastifyInstance } from "fastify";
import {
  apiRoute,
  arrayOf,
  INTEGER,
  inputObject,
  NUMBER,
  outputObject,
  STATUS,
  STRING,
  TIMESTAMP,
} from "./contract.js";

/**
 * The operator's numbers over HTTP (REQ-036 to REQ-040).
 *
 * One route and one read: the whole report for one range comes from a single
 * call to `readDashboardMetrics`, which reads the trail once. A route per tile
 * would fire a dozen queries at slightly different instants and let the numbers
 * on one screen disagree with each other.
 *
 * Every value that crosses here is a number, a code or an instant. No label,
 * no unit, no sentence: the screen owns the wording and the catalogue owns the
 * language (REQ-073, REQ-074), which is also why the range is an identifier and
 * never the operator's name for it.
 *
 * The recent activity (REQ-164) travels in that same answer, and it holds the
 * one exception to the paragraph above: the CONTACT's own text. It is content
 * and not wording, so no catalogue could hold it and translating it would be a
 * lie; it is also the fact an operator most needs on a line that says a keyword
 * did not match. Every other reason stays a code, the stored phrases included:
 * `aggregate.ts` decides what a reason can be reduced to and this route carries
 * only that.
 */

/** The read this route needs. A function, so a test can drive it with a double
 * instead of a database, a trail and a queue. */
export type DashboardMetricsReader = (
  range: DashboardRange,
  now: Date,
) => Promise<DashboardMetrics>;

/** The same status read used by the CLI, narrowed to what the panel presents. */
export type DashboardStatusReader = () => Promise<
  Pick<OperationalStatus, "openAlert">
>;

const COUNT_SERIES = outputObject(
  { subtype: STRING, total: INTEGER, counts: arrayOf(INTEGER) },
  ["subtype", "total", "counts"],
);

const BREAKDOWN = outputObject(
  {
    granularity: STRING,
    /** The x axis: one instant per bucket, ascending and continuous. */
    buckets: arrayOf(TIMESTAMP),
    series: arrayOf(COUNT_SERIES),
    /** Entries that name no type, kept apart from the named ones (REQ-106). */
    unknown: COUNT_SERIES,
    total: INTEGER,
  },
  ["granularity", "buckets", "series", "unknown", "total"],
);

const CAP_USAGE = outputObject(
  {
    cap: STRING,
    window: STRING,
    used: INTEGER,
    limit: INTEGER,
    /** Unrounded: rounding is a presentation choice, and it is not made here. */
    usedPct: NUMBER,
    status: STRING,
  },
  ["cap", "window", "used", "limit", "usedPct", "status"],
);

const PENDING_KIND = outputObject(
  { kind: STRING, pending: INTEGER, oldestPendingAt: TIMESTAMP },
  ["kind", "pending"],
);

const QUEUE = outputObject(
  {
    pending: INTEGER,
    /** Absent when nothing is pending: a queue at rest, not an error. */
    oldestPendingAt: TIMESTAMP,
    byKind: arrayOf(PENDING_KIND),
  },
  ["pending", "byKind"],
);

const ACTIVITY_ACTION = outputObject(
  {
    at: TIMESTAMP,
    subtype: STRING,
    /**
     * The trail's verdict as the trail means it: `ok` on a `message_sent` says
     * the step enqueued the message, never that the platform delivered it, so
     * the screen labels it "accepted for sending".
     */
    outcome: STRING,
    flowId: STRING,
    stepId: STRING,
    automationId: STRING,
    /**
     * WHY a step fired nothing or failed, as the engine's own code and never as
     * the phrase stored beside it (REQ-163, REQ-171). A code is a code, so it
     * crosses under the same rule the `subtype` and the `outcome` cross by; the
     * sentence it stands for is picked from the catalogue, on the screen.
     *
     * Declared but not required: the reason column also holds the no-match
     * envelope and sentences written before those requirements, and none of
     * those becomes this field.
     */
    reason: STRING,
    /**
     * What the code cannot carry: which step, which target, or what the
     * platform answered (REQ-171).
     *
     * The SECOND exception to the rule at the top of this file, and it holds
     * for the same reason `eventText` does: this is not the application's
     * wording. It is an identifier, or a quotation of what somebody outside
     * said, and no catalogue could ever hold either. The screen shows it as a
     * quotation beside the translated code, never as a label.
     */
    detail: STRING,
  },
  ["at", "subtype", "outcome"],
);

/** One refusal code with how many automations it refused (REQ-160). */
const MATCH_TALLY = outputObject({ reason: STRING, count: INTEGER }, [
  "reason",
  "count",
]);

const SILENCE = outputObject(
  {
    /** `no_match` or `unreadable`: a code the catalogue gives words to. */
    code: STRING,
    refusals: arrayOf(MATCH_TALLY),
  },
  ["code", "refusals"],
);

const ACTIVITY_EVENT = outputObject(
  {
    eventId: STRING,
    at: TIMESTAMP,
    subtype: STRING,
    outcome: STRING,
    contactId: STRING,
    /** Absent when the payload brought no public identifier (REQ-162). */
    contactUsername: STRING,
    /**
     * What the contact wrote. Declared but NOT required, and the difference
     * carries a fact: an empty string is an interaction that said nothing, and
     * no field at all is a row that stored nothing (REQ-162).
     */
    eventText: STRING,
    actions: arrayOf(ACTIVITY_ACTION),
    /** Present only when the event fired nothing. */
    silence: SILENCE,
  },
  ["eventId", "at", "subtype", "outcome", "actions"],
);

const ACTIVITY = outputObject(
  {
    items: arrayOf(ACTIVITY_EVENT),
    total: INTEGER,
    limit: INTEGER,
    executions: arrayOf(
      outputObject(
        {
          executionId: STRING,
          at: TIMESTAMP,
          updatedAt: TIMESTAMP,
          messages: arrayOf(
            outputObject(
              {
                id: INTEGER,
                status: STRING,
                platformMessageId: STRING,
                events: arrayOf(
                  outputObject(
                    {
                      at: TIMESTAMP,
                      kind: STRING,
                      subtype: STRING,
                      outcome: STRING,
                      reason: STRING,
                      detail: STRING,
                      platformMessageId: STRING,
                      messageId: INTEGER,
                      buttonLabel: STRING,
                    },
                    ["at", "kind"],
                  ),
                ),
              },
              ["id", "status", "events"],
            ),
          ),
          summary: outputObject(
            {
              total: INTEGER,
              queued: INTEGER,
              accepted: INTEGER,
              seen: INTEGER,
              failed: INTEGER,
              latestStatus: STRING,
            },
            ["total", "queued", "accepted", "seen", "failed"],
          ),
          events: arrayOf(
            outputObject(
              {
                at: TIMESTAMP,
                kind: STRING,
                subtype: STRING,
                outcome: STRING,
                reason: STRING,
                detail: STRING,
                platformMessageId: STRING,
                messageId: INTEGER,
                buttonLabel: STRING,
              },
              ["at", "kind"],
            ),
          ),
        },
        ["executionId", "at", "updatedAt", "messages", "summary", "events"],
      ),
    ),
    executionTotal: INTEGER,
  },
  ["items", "total", "limit", "executions", "executionTotal"],
);

const OPEN_ALERT = outputObject(
  {
    origin: STRING,
    reason: STRING,
    occurredAt: TIMESTAMP,
    subtype: STRING,
    automationId: STRING,
  },
  ["origin", "reason", "occurredAt"],
);

const DISABLED_TRIGGER = outputObject({ name: STRING, updatedAt: TIMESTAMP }, [
  "name",
  "updatedAt",
]);

const LINK_TREND = outputObject(
  {
    granularity: STRING,
    buckets: arrayOf(TIMESTAMP),
    counts: arrayOf(INTEGER),
    total: INTEGER,
  },
  ["granularity", "buckets", "counts", "total"],
);

const LINK_TOTALS = outputObject(
  {
    clicks: INTEGER,
    uniqueContacts: INTEGER,
    automations: INTEGER,
    publications: INTEGER,
  },
  ["clicks", "uniqueContacts", "automations", "publications"],
);

const POST_FUNNEL = outputObject(
  {
    publicationId: STRING,
    publication: outputObject(
      { id: STRING, caption: STRING, thumbnailKey: STRING },
      ["id"],
    ),
    comments: INTEGER,
    commentDetails: arrayOf(
      outputObject({ text: STRING, matchedKeyword: STRING }, []),
    ),
    publicReplies: INTEGER,
    acceptedMessages: INTEGER,
    clicks: INTEGER,
    uniqueContacts: INTEGER,
    links: arrayOf(
      outputObject(
        { label: STRING, clicks: INTEGER, uniqueContacts: INTEGER },
        ["clicks", "uniqueContacts"],
      ),
    ),
  },
  [
    "publicationId",
    "comments",
    "commentDetails",
    "publicReplies",
    "acceptedMessages",
    "clicks",
    "uniqueContacts",
    "links",
  ],
);

const BUTTON_VERSION = outputObject(
  {
    automationId: STRING,
    buttonId: STRING,
    destinationVersion: INTEGER,
    clicks: INTEGER,
    uniqueContacts: INTEGER,
  },
  [
    "automationId",
    "buttonId",
    "destinationVersion",
    "clicks",
    "uniqueContacts",
  ],
);

const LINKS = outputObject(
  {
    totals: LINK_TOTALS,
    trend: LINK_TREND,
    posts: arrayOf(POST_FUNNEL),
    unattributedClicks: INTEGER,
    buttons: arrayOf(BUTTON_VERSION),
  },
  ["totals", "trend", "posts", "unattributedClicks", "buttons"],
);

const METRICS = outputObject(
  {
    window: outputObject(
      {
        range: STRING,
        granularity: STRING,
        since: TIMESTAMP,
        until: TIMESTAMP,
        /**
         * The zone the buckets were CUT in (REQ-153), not a hint about how to
         * write them. The screen reads every instant of this answer in it, so
         * the label of a column names the hour that column counted.
         */
        zone: STRING,
      },
      ["range", "granularity", "since", "until", "zone"],
    ),
    events: BREAKDOWN,
    actions: BREAKDOWN,
    caps: arrayOf(CAP_USAGE),
    failures: outputObject({ errors: INTEGER, rateLimited: INTEGER }, [
      "errors",
      "rateLimited",
    ]),
    queue: QUEUE,
    /** The same window event by event (REQ-164), from the same read. */
    activity: ACTIVITY,
    links: LINKS,
    /** The newest failed operational alert, absent while status is healthy. */
    openAlert: OPEN_ALERT,
    disabledTriggers: arrayOf(DISABLED_TRIGGER),
  },
  [
    "window",
    "events",
    "actions",
    "caps",
    "failures",
    "queue",
    "activity",
    "links",
    "disabledTriggers",
  ],
);

/**
 * The range is required and enumerated, from the domain's own list rather than
 * a copy: a fourth range added there is accepted here with no edit, and a range
 * this build does not know is refused by name before anything is read.
 */
const RANGE_QUERY = inputObject(
  { range: { type: "string", enum: [...DASHBOARD_RANGES] } },
  ["range"],
);

function presentSeries(series: CountSeries): unknown {
  return {
    subtype: series.subtype,
    total: series.total,
    counts: [...series.counts],
  };
}

function presentBreakdown(breakdown: TypeBreakdown): unknown {
  return {
    granularity: breakdown.granularity,
    buckets: breakdown.buckets.map((bucket) => bucket.toISOString()),
    series: breakdown.series.map(presentSeries),
    unknown: presentSeries(breakdown.unknown),
    total: breakdown.total,
  };
}

function presentCap(cap: CapUsage): unknown {
  return {
    cap: cap.cap,
    window: cap.window,
    used: cap.used,
    limit: cap.limit,
    usedPct: cap.usedPct,
    status: cap.status,
  };
}

function presentQueue(queue: QueueSnapshot): unknown {
  return {
    pending: queue.pending,
    ...(queue.oldestPendingAt !== undefined && {
      oldestPendingAt: queue.oldestPendingAt.toISOString(),
    }),
    byKind: queue.byKind.map((kind) => ({
      kind: kind.kind,
      pending: kind.pending,
      ...(kind.oldestPendingAt !== undefined && {
        oldestPendingAt: kind.oldestPendingAt.toISOString(),
      }),
    })),
  };
}

function presentAction(action: ActivityAction): unknown {
  // Asked of the value itself, and not merely trusted from the type above. This
  // is the line where the file's own rule is enforced: a reason that is not one
  // of the engine's codes is a SENTENCE, in whatever language the instance
  // wrote it, and it stops here exactly like the phrase behind an `unreadable`
  // silence does. The screen has no catalogue entry for it and never could
  // (REQ-074, REQ-163).
  //
  // The detail rides WITH the code and never on its own. Alone it would be a
  // fragment of a cause nothing named, and a screen has only one way to show a
  // fragment: as a sentence it appears to be making itself.
  const why = isActionReason(action.reason)
    ? {
        reason: action.reason,
        ...(action.detail !== undefined && { detail: action.detail }),
      }
    : {};

  return {
    at: action.at.toISOString(),
    subtype: action.subtype,
    outcome: action.outcome,
    ...(action.flowId !== undefined && { flowId: action.flowId }),
    ...(action.stepId !== undefined && { stepId: action.stepId }),
    ...(action.automationId !== undefined && {
      automationId: action.automationId,
    }),
    ...why,
  };
}

function presentEvent(event: ActivityEvent): unknown {
  return {
    eventId: event.eventId,
    at: event.at.toISOString(),
    subtype: event.subtype,
    outcome: event.outcome,
    ...(event.contactId !== undefined && { contactId: event.contactId }),
    ...(event.contactUsername !== undefined && {
      contactUsername: event.contactUsername,
    }),
    // Against undefined and never for truth: the empty text is a value, and
    // omitting it would turn "said nothing" into "stored nothing" (REQ-162).
    ...(event.eventText !== undefined && { eventText: event.eventText }),
    actions: event.actions.map(presentAction),
    ...(event.silence !== undefined && {
      silence: {
        code: event.silence.code,
        refusals: event.silence.refusals.map((tally) => ({
          reason: tally.reason,
          count: tally.count,
        })),
      },
    }),
  };
}

function presentLifecycleEvent(event: ExecutionLifecycleEvent): unknown {
  return {
    at: event.at.toISOString(),
    kind: event.kind,
    ...(event.subtype !== undefined && { subtype: event.subtype }),
    ...(event.outcome !== undefined && { outcome: event.outcome }),
    ...(event.reason !== undefined && { reason: event.reason }),
    ...(event.detail !== undefined && { detail: event.detail }),
    ...(event.platformMessageId !== undefined && {
      platformMessageId: event.platformMessageId,
    }),
    ...(event.messageId !== undefined && { messageId: event.messageId }),
    ...(event.buttonLabel !== undefined && { buttonLabel: event.buttonLabel }),
  };
}

function presentMessageLifecycle(message: MessageLifecycle): unknown {
  return {
    id: message.id,
    status: message.status,
    ...(message.platformMessageId !== undefined && {
      platformMessageId: message.platformMessageId,
    }),
    events: message.events.map(presentLifecycleEvent),
  };
}

function presentExecutionLifecycle(execution: ExecutionLifecycle): unknown {
  return {
    executionId: execution.executionId,
    at: execution.at.toISOString(),
    updatedAt: execution.updatedAt.toISOString(),
    messages: execution.messages.map(presentMessageLifecycle),
    summary: { ...execution.summary },
    events: execution.events.map(presentLifecycleEvent),
  };
}

function presentActivity(activity: RecentActivity): unknown {
  return {
    items: activity.items.map(presentEvent),
    total: activity.total,
    limit: activity.limit,
    executions: activity.executions.map(presentExecutionLifecycle),
    executionTotal: activity.executionTotal,
  };
}

function presentLinks(links: LinkAnalytics): unknown {
  return {
    totals: { ...links.totals },
    trend: {
      granularity: links.trend.granularity,
      buckets: links.trend.buckets.map((bucket) => bucket.toISOString()),
      counts: [...links.trend.counts],
      total: links.trend.total,
    },
    posts: links.posts.map((post) => ({
      publicationId: post.publicationId,
      ...(post.publication !== undefined && {
        publication: { ...post.publication },
      }),
      comments: post.comments,
      commentDetails: post.commentDetails.map((comment) => ({ ...comment })),
      publicReplies: post.publicReplies,
      acceptedMessages: post.acceptedMessages,
      clicks: post.clicks,
      uniqueContacts: post.uniqueContacts,
      links: post.links.map((link) => ({ ...link })),
    })),
    unattributedClicks: links.unattributedClicks,
    buttons: links.buttons.map((button) => ({ ...button })),
  };
}

function presentMetrics(
  metrics: DashboardMetrics,
  status: Pick<OperationalStatus, "openAlert">,
  disabledTriggers: readonly {
    readonly name: string;
    readonly updatedAt: Date;
  }[],
): unknown {
  const openAlert = status.openAlert;
  return {
    window: {
      range: metrics.window.range,
      granularity: metrics.window.granularity,
      since: metrics.window.since.toISOString(),
      until: metrics.window.until.toISOString(),
      zone: metrics.window.zone,
    },
    events: presentBreakdown(metrics.events),
    actions: presentBreakdown(metrics.actions),
    caps: metrics.caps.map(presentCap),
    failures: {
      errors: metrics.failures.errors,
      rateLimited: metrics.failures.rateLimited,
    },
    queue: presentQueue(metrics.queue),
    activity: presentActivity(metrics.activity),
    links: presentLinks(metrics.links),
    disabledTriggers: disabledTriggers.map((item) => ({
      name: item.name,
      updatedAt: item.updatedAt.toISOString(),
    })),
    ...(openAlert !== undefined && {
      openAlert: {
        origin: openAlert.origin,
        reason: openAlert.reason,
        occurredAt: openAlert.occurredAt.toISOString(),
        ...(openAlert.subtype !== undefined && { subtype: openAlert.subtype }),
        ...(openAlert.automationId !== undefined && {
          automationId: openAlert.automationId,
        }),
      },
    }),
  };
}

export function registerDashboardRoutes(
  scope: FastifyInstance,
  read: DashboardMetricsReader,
  readStatus: DashboardStatusReader,
  triggerSwitches: TriggerSwitchPreference,
  now: () => Date,
): void {
  apiRoute<unknown, { range: DashboardRange }>(scope, {
    method: "GET",
    url: "/api/dashboard/metrics",
    contract: {
      querystring: RANGE_QUERY,
      response: { 200: outputObject({ metrics: METRICS }, ["metrics"]) },
    },
    handler: async ({ query }) => {
      const [metrics, operational, switches] = await Promise.all([
        read(query.range, now()),
        readStatus(),
        triggerSwitches.read(),
      ]);
      const disabledTriggers = (
        ["all", "comments", "directMessages"] as const
      ).flatMap((name) => {
        const value = switches[name];
        return !value.enabled && value.updatedAt !== undefined
          ? [{ name, updatedAt: value.updatedAt }]
          : [];
      });
      return {
        status: STATUS.ok,
        payload: {
          metrics: presentMetrics(metrics, operational, disabledTriggers),
        },
      };
    },
  });
}
