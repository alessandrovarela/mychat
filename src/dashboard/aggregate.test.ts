import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LIMIT_DEFAULTS, loadLimits } from "../config/limits.js";
import type { PlatformLimits } from "../config/limits.js";
import type {
  ExecutionFailureReason,
  SuppressionReason,
} from "../engine/execute.js";
import { encodeNoMatch } from "../flows/matching.js";
import { encodeExecutionFailure } from "../runtime/execution-audit.js";
import { RATE_CAPS } from "../runtime/rate.js";
import type { RateCounts } from "../runtime/rate.js";
import {
  createAuditRepository,
  createDurableWorkStore,
  IN_MEMORY_DATABASE,
  openDatabase,
} from "../storage/index.js";
import type {
  AuditRecord,
  AuditRepository,
  DatabaseHandle,
  DurableWorkStore,
} from "../storage/index.js";
import {
  capUsageOf,
  DASHBOARD_RANGES,
  readDashboardMetrics,
  RECENT_ACTIVITY_LIMIT,
  recentActivityOf,
  windowOf,
} from "./aggregate.js";
import type {
  CountSeries,
  DashboardRange,
  DashboardSources,
  LinkClickSource,
  TypeBreakdown,
} from "./aggregate.js";
import { createQueueSource } from "./queue.js";

/**
 * Proves REQ-030 and REQ-036 to REQ-040: the operator's numbers come from this
 * application's own tables, and the aggregation agrees with a direct count of
 * the same period.
 *
 * The cross-check is the point of most of what follows. Every total is compared
 * against `AuditRepository.query`, which reaches the rows by a different route
 * (a SQL filter per type, instead of one read grouped in memory). A test that
 * only checked the aggregation against itself would keep passing on the day the
 * two stopped agreeing, which is the exact failure REQ-036 names.
 */

const NOW = new Date("2026-08-02T12:00:00.000Z");
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** What an instance that configured no zone counts in (REQ-153). */
const EPOCH_ZONE = "UTC";

/**
 * The operator's own zone, three hours behind UTC and with no daylight saving
 * since 2019, which is why it is the one to reason about: every instant here
 * moves by exactly three hours and nothing else changes.
 */
const OPERATOR_ZONE = "America/Sao_Paulo";

/** A zone AHEAD of UTC, so a mistake that only shifts one way still shows. */
const AHEAD_ZONE = "Asia/Tokyo";

function hoursAgo(hours: number): Date {
  return new Date(NOW.getTime() - hours * HOUR_MS);
}

function daysAgo(days: number): Date {
  return new Date(NOW.getTime() - days * DAY_MS);
}

function seriesFor(breakdown: TypeBreakdown, subtype: string): CountSeries {
  const found = breakdown.series.find((series) => series.subtype === subtype);

  if (found === undefined) {
    throw new Error(`no series for "${subtype}"`);
  }

  return found;
}

function sumOf(counts: readonly number[]): number {
  return counts.reduce((total, value) => total + value, 0);
}

describe("the dashboard aggregation", () => {
  let handle: DatabaseHandle;
  let audit: AuditRepository;
  let work: DurableWorkStore;

  beforeEach(() => {
    handle = openDatabase({ databasePath: IN_MEMORY_DATABASE });
    audit = createAuditRepository(handle.db);
    work = createDurableWorkStore(handle.db);
  });

  afterEach(() => {
    handle.close();
  });

  function sources(
    limits: PlatformLimits = LIMIT_DEFAULTS,
    zone: string = EPOCH_ZONE,
    clicks: LinkClickSource = { samples: async () => [] },
  ): DashboardSources {
    return {
      audit,
      work,
      queue: createQueueSource(handle.db),
      limits,
      zone,
      clicks,
    };
  }

  function report(
    range: DashboardRange = "last_24_hours",
    limits?: PlatformLimits,
  ) {
    return readDashboardMetrics(sources(limits ?? LIMIT_DEFAULTS), range, NOW);
  }

  /** The same read, by an instance whose operator configured a zone. */
  function reportIn(zone: string, range: DashboardRange = "last_24_hours") {
    return readDashboardMetrics(sources(LIMIT_DEFAULTS, zone), range, NOW);
  }

  async function write(entry: AuditRecord, at: Date): Promise<void> {
    await audit.record(entry, at);
  }

  /** Queues a send and concludes it, which is what the rate budget counts. */
  async function completedSend(key: string, at: Date): Promise<void> {
    const { item } = await work.enqueue(
      {
        kind: "send",
        dedupeKey: key,
        payload: { action: "direct_message" },
        sendClass: "private_reply",
      },
      at,
    );

    await work.complete(item.id, at);
  }

  describe("REQ-036: events received, by type", () => {
    it("counts each type exactly as a direct query of the period does (AC 37)", async () => {
      await write(
        { kind: "event_received", subtype: "comment", outcome: "ok" },
        hoursAgo(1),
      );
      await write(
        { kind: "event_received", subtype: "comment", outcome: "ok" },
        hoursAgo(3),
      );
      await write(
        { kind: "event_received", subtype: "direct_message", outcome: "ok" },
        hoursAgo(5),
      );
      // Outside the 24-hour window: it must not reach any of the counts.
      await write(
        { kind: "event_received", subtype: "comment", outcome: "ok" },
        hoursAgo(30),
      );

      const metrics = await report();
      const { since, until } = metrics.window;

      for (const series of metrics.events.series) {
        const direct = await audit.query({
          kind: "event_received",
          subtype: series.subtype,
          since,
          until,
        });

        expect(series.total, `series ${series.subtype}`).toBe(direct.length);
        // The buckets have to carry the same number the total claims, or the
        // chart and the figure printed beside it would disagree.
        expect(sumOf(series.counts)).toBe(series.total);
      }

      expect(seriesFor(metrics.events, "comment").total).toBe(2);
      expect(seriesFor(metrics.events, "direct_message").total).toBe(1);

      const interactionReceipts = await audit.query({
        kind: "event_received",
        since,
        until,
      });
      expect(metrics.events.total).toBe(
        interactionReceipts.filter(
          (entry) => entry.subtype !== undefined && entry.outcome === "ok",
        ).length,
      );
    });

    it("separates two events of the same day into their own hours (AC 42)", async () => {
      await write(
        { kind: "event_received", subtype: "comment", outcome: "ok" },
        hoursAgo(1),
      );
      await write(
        { kind: "event_received", subtype: "comment", outcome: "ok" },
        hoursAgo(3),
      );

      const comments = seriesFor((await report()).events, "comment");
      const filled = comments.counts.filter((count) => count > 0);

      // Two hours apart, so two buckets of one. An aggregation that rounded to
      // the day would report a single bucket of two and pass every total.
      expect(filled).toEqual([1, 1]);
    });

    it("counts one typed receipt instead of later outcomes for the same interaction", async () => {
      // The dispatcher first records an identified receipt, then the matching
      // engine may append duplicate or suppression outcomes. The headline is
      // about the interaction, not every audit decision it caused.
      await write(
        { kind: "event_received", subtype: "comment", outcome: "ok" },
        hoursAgo(1),
      );
      await write(
        { kind: "event_received", subtype: "comment", outcome: "duplicate" },
        hoursAgo(1),
      );
      await write(
        { kind: "event_received", subtype: "comment", outcome: "suppressed" },
        hoursAgo(2),
      );

      expect(seriesFor((await report()).events, "comment").total).toBe(1);
    });
  });

  describe("REQ-106: entries that name no type (AC 36)", () => {
    it("keeps delivery records out of the interaction total", async () => {
      // What `/webhook` writes: one row per DELIVERY, with no subtype, because
      // one accepted body may carry a comment and a message at once. Rows
      // written before the migration read back the same way.
      await write({ kind: "event_received", outcome: "ok" }, hoursAgo(1));
      await write({ kind: "event_received", outcome: "ok" }, hoursAgo(2));
      await write(
        { kind: "event_received", subtype: "comment", outcome: "ok" },
        hoursAgo(2),
      );

      const metrics = await report();

      expect(metrics.events.unknown.total).toBe(0);
      expect(sumOf(metrics.events.unknown.counts)).toBe(0);
      // A delivery can hold more than one interaction, so it cannot be a
      // separate series alongside the typed receipts.
      expect(metrics.events.series.map((series) => series.subtype)).toEqual([
        "comment",
      ]);
      expect(metrics.events.total).toBe(1);
    });

    it("reports an empty group rather than nothing when every entry names its type", async () => {
      await write(
        { kind: "event_received", subtype: "comment", outcome: "ok" },
        hoursAgo(1),
      );

      const metrics = await report();

      expect(metrics.events.unknown.total).toBe(0);
      expect(metrics.events.unknown.counts).toHaveLength(
        metrics.events.buckets.length,
      );
    });
  });

  describe("REQ-037: actions executed, by type (AC 38)", () => {
    it("counts a comment reply and a message sent separately", async () => {
      await write(
        { kind: "action_executed", subtype: "comment_reply", outcome: "ok" },
        hoursAgo(1),
      );
      await write(
        { kind: "action_executed", subtype: "comment_reply", outcome: "ok" },
        hoursAgo(2),
      );
      await write(
        { kind: "action_executed", subtype: "message_sent", outcome: "ok" },
        hoursAgo(3),
      );

      const metrics = await report();

      expect(seriesFor(metrics.actions, "comment_reply").total).toBe(2);
      expect(seriesFor(metrics.actions, "message_sent").total).toBe(1);

      for (const series of metrics.actions.series) {
        const direct = await audit.query({
          kind: "action_executed",
          subtype: series.subtype,
          outcome: "ok",
          since: metrics.window.since,
          until: metrics.window.until,
        });

        expect(series.total, `series ${series.subtype}`).toBe(direct.length);
      }
    });

    it("leaves out a step that was recorded but not performed", async () => {
      // A suppressed message step is still a message step, recorded as one,
      // that sent nothing. Counting it would report a message nobody received.
      await write(
        {
          kind: "action_executed",
          subtype: "message_sent",
          outcome: "suppressed",
        },
        hoursAgo(1),
      );
      await write(
        { kind: "action_executed", subtype: "message_sent", outcome: "failed" },
        hoursAgo(1),
      );
      await write(
        { kind: "action_executed", subtype: "message_sent", outcome: "ok" },
        hoursAgo(1),
      );

      expect(seriesFor((await report()).actions, "message_sent").total).toBe(1);
    });

    it("keeps the accepted count standing when the delivery later fails", async () => {
      // The trail is append-only, so the correction is a NEW row, not an edit:
      // the enqueue asserted `message_sent`/`ok`, and the delivery that failed
      // added its own row. The accepted count therefore stays at one and the
      // error count rises, which is why the screen must say "accepted for
      // sending" rather than "sent".
      await write(
        { kind: "action_executed", subtype: "message_sent", outcome: "ok" },
        hoursAgo(2),
      );
      await write(
        {
          kind: "action_executed",
          subtype: "message_sent",
          outcome: "failed",
          reason: "platform refused",
        },
        hoursAgo(1),
      );

      const metrics = await report();

      expect(seriesFor(metrics.actions, "message_sent").total).toBe(1);
      expect(metrics.failures.errors).toBe(1);
    });
  });

  describe("REQ-038: consumption against the configured caps (AC 39)", () => {
    const counts = (overrides: Partial<RateCounts> = {}): RateCounts => ({
      privateRepliesLastHour: 0,
      callsThisSecond: 0,
      mediaCallsThisSecond: 0,
      ...overrides,
    });

    function usage(rate: RateCounts, limits: PlatformLimits) {
      const found = capUsageOf(rate, limits).find(
        (cap) => cap.cap === "private_replies_per_hour",
      );

      if (found === undefined) {
        throw new Error("the private-reply cap is missing from the report");
      }

      return found;
    }

    const limits = loadLimits({ PRIVATE_REPLIES_PER_HOUR: "100" });

    it("reads as normal below the proximity threshold", () => {
      const cap = usage(counts({ privateRepliesLastHour: 79 }), limits);

      expect(cap.status).toBe("normal");
      expect(cap.usedPct).toBe(79);
      expect(cap.limit).toBe(100);
    });

    it("signals attention on reaching the threshold, and critical on the second one", () => {
      expect(usage(counts({ privateRepliesLastHour: 80 }), limits).status).toBe(
        "attention",
      );
      expect(usage(counts({ privateRepliesLastHour: 94 }), limits).status).toBe(
        "attention",
      );
      expect(usage(counts({ privateRepliesLastHour: 95 }), limits).status).toBe(
        "critical",
      );
      expect(
        usage(counts({ privateRepliesLastHour: 120 }), limits).status,
      ).toBe("critical");
    });

    it("takes both thresholds from configuration, never from a literal", () => {
      // The same consumption, judged differently, because the operator moved
      // the thresholds. A hard-coded 80 and 95 would ignore this environment
      // and keep the first two verdicts at "normal".
      const tuned = loadLimits({
        PRIVATE_REPLIES_PER_HOUR: "100",
        ALERT_THRESHOLD_PCT: "40",
        CRITICAL_THRESHOLD_PCT: "60",
      });

      expect(usage(counts({ privateRepliesLastHour: 45 }), tuned).status).toBe(
        "attention",
      );
      expect(usage(counts({ privateRepliesLastHour: 65 }), tuned).status).toBe(
        "critical",
      );
      expect(usage(counts({ privateRepliesLastHour: 45 }), limits).status).toBe(
        "normal",
      );
    });

    it("reports the caps that exist and invents none", async () => {
      // REQ-079: the platform's general quota is a moving 24-hour window
      // derived from the account's impressions and cannot be computed locally.
      // A bar for it here would be a number nobody can source.
      const metrics = await report();

      expect(metrics.caps.map((cap) => cap.cap)).toEqual([...RATE_CAPS]);
    });

    it("counts real concluded sends against the cap in force", async () => {
      const tight = loadLimits({ PRIVATE_REPLIES_PER_HOUR: "10" });

      for (let index = 0; index < 8; index += 1) {
        await completedSend(
          `send-${index}`,
          new Date(NOW.getTime() - (index + 1) * 60_000),
        );
      }

      const metrics = await report("last_24_hours", tight);
      const cap = metrics.caps.find(
        (entry) => entry.cap === "private_replies_per_hour",
      );

      expect(cap?.used).toBe(8);
      expect(cap?.limit).toBe(10);
      expect(cap?.usedPct).toBe(80);
      expect(cap?.status).toBe("attention");
    });
  });

  describe("REQ-039: errors and too-many-requests answers (AC 40)", () => {
    it("counts both, apart from each other, matching the record", async () => {
      await write(
        {
          kind: "event_received",
          outcome: "failed",
          reason: "signature mismatch",
        },
        hoursAgo(1),
      );
      await write(
        {
          kind: "action_executed",
          subtype: "message_sent",
          outcome: "failed",
          reason: "boom",
        },
        hoursAgo(2),
      );
      await write(
        {
          kind: "action_executed",
          subtype: "message_sent",
          outcome: "blocked",
          reason: "429",
        },
        hoursAgo(3),
      );
      // Outside the window, so neither count may move.
      await write(
        {
          kind: "action_executed",
          subtype: "message_sent",
          outcome: "blocked",
        },
        hoursAgo(40),
      );

      const metrics = await report();
      const { since, until } = metrics.window;

      const failed = await audit.query({ outcome: "failed", since, until });
      const blocked = await audit.query({
        kind: "action_executed",
        outcome: "blocked",
        since,
        until,
      });

      expect(metrics.failures.errors).toBe(failed.length);
      expect(metrics.failures.errors).toBe(2);
      expect(metrics.failures.rateLimited).toBe(blocked.length);
      expect(metrics.failures.rateLimited).toBe(1);
    });
  });

  describe("REQ-040: the pending queue (AC 41)", () => {
    it("reports zero and no oldest instant when the queue is empty", async () => {
      const metrics = await report();

      expect(metrics.queue.pending).toBe(0);
      expect(metrics.queue.oldestPendingAt).toBeUndefined();
      expect(metrics.queue.byKind).toEqual([]);
    });

    it("reports how many are waiting and since when", async () => {
      const oldest = hoursAgo(6);

      await work.enqueue(
        {
          kind: "send",
          dedupeKey: "waiting-1",
          payload: {},
          sendClass: "direct_message",
        },
        oldest,
      );
      await work.enqueue(
        {
          kind: "send",
          dedupeKey: "waiting-2",
          payload: {},
          sendClass: "direct_message",
        },
        hoursAgo(2),
      );

      const metrics = await report();

      expect(metrics.queue.pending).toBe(2);
      expect(metrics.queue.oldestPendingAt).toEqual(oldest);
    });

    it("leaves concluded work out of the backlog", async () => {
      await completedSend("already-done", hoursAgo(1));

      const metrics = await report();

      expect(metrics.queue.pending).toBe(0);
      expect(metrics.queue.oldestPendingAt).toBeUndefined();
    });

    it("keeps the application's own timer out of the operator's backlog", async () => {
      // A credential check is work this application schedules for itself and
      // re-arms forever. Counted as a pending action it would show a queue that
      // is never empty, and an "oldest pending" that means nothing.
      await work.enqueue(
        { kind: "credential_check", dedupeKey: "credential", payload: {} },
        hoursAgo(9),
      );
      await work.enqueue(
        {
          kind: "send",
          dedupeKey: "waiting",
          payload: {},
          sendClass: "direct_message",
        },
        hoursAgo(1),
      );

      const metrics = await report();

      expect(metrics.queue.pending).toBe(1);
      expect(metrics.queue.oldestPendingAt).toEqual(hoursAgo(1));
      expect(metrics.queue.byKind).toEqual([
        { kind: "credential_check", pending: 1, oldestPendingAt: hoursAgo(9) },
        { kind: "send", pending: 1, oldestPendingAt: hoursAgo(1) },
      ]);
    });
  });

  describe("AC 42: the three ranges", () => {
    beforeEach(async () => {
      await write(
        { kind: "event_received", subtype: "comment", outcome: "ok" },
        hoursAgo(1),
      );
      await write(
        { kind: "event_received", subtype: "comment", outcome: "ok" },
        daysAgo(3),
      );
      await write(
        { kind: "event_received", subtype: "comment", outcome: "ok" },
        daysAgo(20),
      );
    });

    it("cuts the last 24 hours by hour and the longer ranges by day", async () => {
      const granularity = new Map<DashboardRange, string>();

      for (const range of DASHBOARD_RANGES) {
        granularity.set(range, (await report(range)).events.granularity);
      }

      expect(granularity.get("last_24_hours")).toBe("hour");
      expect(granularity.get("last_7_days")).toBe("day");
      expect(granularity.get("last_30_days")).toBe("day");
    });

    it("matches a direct count of the record in every range", async () => {
      const expected: Readonly<Record<DashboardRange, number>> = {
        last_24_hours: 1,
        last_7_days: 2,
        last_30_days: 3,
      };

      for (const range of DASHBOARD_RANGES) {
        const metrics = await report(range);
        const direct = await audit.query({
          kind: "event_received",
          since: metrics.window.since,
          until: metrics.window.until,
        });

        expect(metrics.events.total, range).toBe(direct.length);
        expect(metrics.events.total, range).toBe(expected[range]);
        expect(sumOf(seriesFor(metrics.events, "comment").counts), range).toBe(
          expected[range],
        );
      }
    });

    it("gives the axis one bucket per hour, then one per day", async () => {
      // The window ends at `now`, which is rarely a boundary, so the first and
      // last buckets are partial: 24 hours span 25 hourly buckets.
      const day = (await report("last_24_hours")).events;
      const week = (await report("last_7_days")).events;

      expect(day.buckets).toHaveLength(25);
      expect(week.buckets).toHaveLength(8);
      expect((await report("last_30_days")).events.buckets).toHaveLength(31);

      // The instants themselves, not only how many: an axis cut to the wrong
      // size still has a plausible length, and every total would still add up.
      expect(day.buckets.at(0)).toEqual(new Date("2026-08-01T12:00:00.000Z"));
      expect(day.buckets.at(-1)).toEqual(new Date("2026-08-02T12:00:00.000Z"));
      expect(week.buckets.at(0)).toEqual(new Date("2026-07-26T00:00:00.000Z"));
      expect(week.buckets.at(-1)).toEqual(new Date("2026-08-02T00:00:00.000Z"));
    });

    it("puts either side of midnight in different daily buckets", async () => {
      handle.close();
      handle = openDatabase({ databasePath: IN_MEMORY_DATABASE });
      audit = createAuditRepository(handle.db);
      work = createDurableWorkStore(handle.db);

      // 23:30 and 00:30 UTC: half an hour apart, different days.
      await write(
        { kind: "event_received", subtype: "comment", outcome: "ok" },
        new Date("2026-08-01T23:30:00.000Z"),
      );
      await write(
        { kind: "event_received", subtype: "comment", outcome: "ok" },
        new Date("2026-08-02T00:30:00.000Z"),
      );

      const comments = seriesFor(
        (await report("last_7_days")).events,
        "comment",
      );

      expect(comments.counts.filter((count) => count > 0)).toEqual([1, 1]);
      expect(comments.total).toBe(2);
    });
  });

  /**
   * REQ-153: the zone is part of the COUNTING, not of the wording.
   *
   * Every case here is written so that a build which merely relabelled the
   * columns would pass nothing: what is asserted is which bucket an entry
   * landed in, and how many buckets the axis has, both read from the numbers
   * rather than from any text.
   */
  describe("REQ-153: the configured zone decides which bucket an entry falls in", () => {
    /** Late evening in Sao Paulo, and already the next day in UTC. */
    const LATE_EVENING = new Date("2026-08-01T23:30:00.000Z");

    async function comment(at: Date): Promise<void> {
      await write(
        { kind: "event_received", subtype: "comment", outcome: "ok" },
        at,
      );
    }

    /** The bucket instants where something was actually counted. */
    function filled(breakdown: TypeBreakdown): string[] {
      const series = seriesFor(breakdown, "comment");

      return breakdown.buckets
        .filter((_, index) => (series.counts[index] ?? 0) > 0)
        .map((bucket) => bucket.toISOString());
    }

    it("files an evening event under the local day, not under the next UTC one", async () => {
      // 20:30 in Sao Paulo on 1 August, which is 23:30 UTC the same day, and
      // 08:30 on 2 August in Tokyo. One instant, three calendars.
      await comment(LATE_EVENING);

      // The local midnights, expressed as the instants they really are: this is
      // what a bucket cut in that zone must equal, and none of them is a UTC
      // midnight.
      expect(
        filled((await reportIn(OPERATOR_ZONE, "last_7_days")).events),
      ).toEqual(["2026-08-01T03:00:00.000Z"]);
      expect(
        filled((await reportIn(AHEAD_ZONE, "last_7_days")).events),
      ).toEqual(["2026-08-01T15:00:00.000Z"]);
      // And the same entry, counted by an instance that configured nothing,
      // still lands on the UTC midnight of the following day.
      expect(filled((await report("last_7_days")).events)).toEqual([
        "2026-08-01T00:00:00.000Z",
      ]);
    });

    it("separates two entries the zone puts on different days", async () => {
      // 23:30 and 03:30 UTC: four hours apart. In Sao Paulo they are 20:30 on
      // the 1st and 00:30 on the 2nd, so the local calendar splits them; in UTC
      // they are 23:30 on the 1st and 03:30 on the 2nd, which splits them too,
      // but at a different pair of buckets.
      await comment(LATE_EVENING);
      await comment(new Date("2026-08-02T03:30:00.000Z"));

      expect(
        filled((await reportIn(OPERATOR_ZONE, "last_7_days")).events),
      ).toEqual(["2026-08-01T03:00:00.000Z", "2026-08-02T03:00:00.000Z"]);
    });

    it("joins two entries the zone puts on the same day, and UTC does not", async () => {
      // 04:00 on 1 August and 02:00 on 2 August, in UTC, are 01:00 and 23:00 of
      // the SAME 1 August in Sao Paulo. One local day, two UTC ones: a build
      // that only relabelled the columns would report two buckets of one entry
      // each here, which is the whole distinction this task turns on.
      await comment(new Date("2026-08-01T04:00:00.000Z"));
      await comment(new Date("2026-08-02T02:00:00.000Z"));

      const local = seriesFor(
        (await reportIn(OPERATOR_ZONE, "last_7_days")).events,
        "comment",
      );
      const utc = seriesFor((await report("last_7_days")).events, "comment");

      expect(local.counts.filter((count) => count > 0)).toEqual([2]);
      expect(utc.counts.filter((count) => count > 0)).toEqual([1, 1]);
    });

    it("cuts the hourly axis on the zone's own hour, offsets included", async () => {
      // Half an hour off UTC, which is what makes this case worth writing: an
      // implementation that shifted whole hours only would floor these buckets
      // onto :00 and count the same entries into the neighbouring hour.
      await comment(new Date("2026-08-02T11:45:00.000Z"));

      const buckets = (await reportIn("Asia/Kolkata")).events.buckets;

      expect(filled((await reportIn("Asia/Kolkata")).events)).toEqual([
        "2026-08-02T11:30:00.000Z",
      ]);
      expect(buckets.at(-1)).toEqual(new Date("2026-08-02T11:30:00.000Z"));
    });

    it("keeps a local day a day long across a daylight-saving change", async () => {
      // 25 October 2026, the night London puts its clocks back: that local day
      // is 25 hours long. Stepping the axis by a fixed 24 hours would repeat a
      // bucket or skip one, and either way the columns stop being days.
      const days = (
        await readDashboardMetrics(
          sources(LIMIT_DEFAULTS, "Europe/London"),
          "last_7_days",
          new Date("2026-10-28T12:00:00.000Z"),
        )
      ).events.buckets;

      const starts = days.map((bucket) => bucket.toISOString());

      // No bucket repeated and none skipped: the 25th begins at midnight BST
      // (23:00 UTC of the 24th) and the 26th at midnight GMT, which are 25
      // hours apart. A fixed step would have landed the second one an hour
      // early, back inside the day that was still running.
      expect(new Set(starts).size).toBe(starts.length);
      expect(starts).toContain("2026-10-24T23:00:00.000Z");
      expect(starts).toContain("2026-10-26T00:00:00.000Z");
      expect(
        new Date("2026-10-26T00:00:00.000Z").getTime() -
          new Date("2026-10-24T23:00:00.000Z").getTime(),
      ).toBe(25 * HOUR_MS);
      expect(
        starts.filter(
          (start) =>
            start > "2026-10-24T23:00:00.000Z" &&
            start < "2026-10-26T00:00:00.000Z",
        ),
      ).toEqual([]);
    });

    it("carries the zone it counted in, so the screen reads the same clock", async () => {
      const metrics = await reportIn(OPERATOR_ZONE);

      expect(metrics.window.zone).toBe(OPERATOR_ZONE);
      expect((await report()).window.zone).toBe(EPOCH_ZONE);
    });
  });

  /**
   * REQ-183: the zone became changeable while the process runs, so this module
   * is now asked in more than one zone within a single lifetime.
   *
   * It keeps ONE formatter per zone (`ZONE_READERS`), because building one is
   * expensive and every sample of a window asks the same question of the same
   * zone. That cache is keyed BY ZONE, which is what makes it correct under a
   * zone that changes: the second zone gets a formatter of its own, and nothing
   * has to be invalidated when the operator switches — there is no entry that
   * has gone stale, only one that is no longer asked for. A cache keyed by
   * nothing, or a formatter kept in a module-level variable, would answer every
   * later read in the first zone the process happened to be asked about, and
   * that is the failure this case exists to catch.
   */
  describe("REQ-183: reads in different zones inside one process", () => {
    it("cuts each read in the zone THAT read was given", async () => {
      // 20:30 on 1 August in Sao Paulo, 08:30 on the 2nd in Tokyo.
      await write(
        { kind: "event_received", subtype: "comment", outcome: "ok" },
        new Date("2026-08-01T23:30:00.000Z"),
      );

      function filled(breakdown: TypeBreakdown): string[] {
        const series = seriesFor(breakdown, "comment");

        return breakdown.buckets
          .filter((_, index) => (series.counts[index] ?? 0) > 0)
          .map((bucket) => bucket.toISOString());
      }

      // The order matters: the first read is what warms the cache, the second
      // is the switch, and the third is the switch back. All three run in this
      // one process, with nothing reset in between.
      const before = await reportIn(OPERATOR_ZONE, "last_7_days");
      const after = await reportIn(AHEAD_ZONE, "last_7_days");
      const back = await reportIn(OPERATOR_ZONE, "last_7_days");

      expect(filled(before.events)).toEqual(["2026-08-01T03:00:00.000Z"]);
      expect(filled(after.events)).toEqual(["2026-08-01T15:00:00.000Z"]);
      expect(filled(back.events)).toEqual(filled(before.events));

      // And the axis moved with it, bucket for bucket, rather than only the
      // one column that happened to hold the sample.
      expect(after.events.buckets).not.toEqual(before.events.buckets);
      expect(back.events.buckets).toEqual(before.events.buckets);
    });

    it("counts in UTC again after a read that was not in UTC", async () => {
      // UTC takes a path of its own: the epoch is already written in it, so no
      // formatter is consulted at all. A read in another zone before it must
      // leave that path alone.
      await write(
        { kind: "event_received", subtype: "comment", outcome: "ok" },
        new Date("2026-08-01T23:30:00.000Z"),
      );

      await reportIn(OPERATOR_ZONE, "last_7_days");

      expect(
        (await report("last_7_days")).events.buckets.map((bucket) =>
          bucket.toISOString(),
        ),
      ).toContain("2026-08-01T00:00:00.000Z");
    });
  });

  /**
   * REQ-164: the window, event by event.
   *
   * The case that carries the requirement is the first one: the list has to
   * come out of the SAME read of the trail as the counts. A second query would
   * run at a slightly different instant, and two halves of one screen would
   * report two different periods, which is the failure the whole module is
   * built around.
   */
  describe("REQ-164: the recent activity of the window", () => {
    const ARRIVED = hoursAgo(2);

    /** The receipt the dispatcher writes for an accepted interaction. */
    async function arrival(
      eventId: string,
      at: Date = ARRIVED,
      over: Partial<AuditRecord> = {},
    ): Promise<void> {
      await write(
        {
          kind: "event_received",
          subtype: "comment",
          outcome: "ok",
          contactId: "contact-1",
          eventId,
          eventText: "quero",
          contactUsername: "fulano",
          ...over,
        },
        at,
      );
    }

    /** The trail, with a counter on the one method the report reads through. */
    function countedSources(counter: { queries: number }): DashboardSources {
      return {
        ...sources(),
        audit: {
          record: (entry, at) => audit.record(entry, at),
          query: (filter) => {
            counter.queries += 1;
            return audit.query(filter);
          },
        },
      };
    }

    it("comes from the one read the counts come from", async () => {
      await arrival("evt-1");
      await write(
        {
          kind: "action_executed",
          subtype: "message_sent",
          outcome: "ok",
          eventId: "evt-1",
          flowId: "welcome",
          stepId: "reply",
        },
        ARRIVED,
      );

      const counter = { queries: 0 };
      const metrics = await readDashboardMetrics(
        countedSources(counter),
        "last_24_hours",
        NOW,
      );

      // Both halves are actually populated, so this cannot pass by answering
      // nothing at all, and the trail was consulted exactly once for them.
      expect(metrics.events.total).toBeGreaterThan(0);
      expect(metrics.activity.items).toHaveLength(1);
      expect(counter.queries).toBe(1);
    });

    it("puts every row of one event on one line, actions oldest first", async () => {
      await arrival("evt-1");
      await write(
        {
          kind: "action_executed",
          subtype: "comment_reply",
          outcome: "ok",
          eventId: "evt-1",
          contactId: "contact-1",
          flowId: "welcome",
          stepId: "reply",
          automationId: "launch",
        },
        hoursAgo(1.9),
      );
      await write(
        {
          kind: "action_executed",
          subtype: "message_sent",
          outcome: "failed",
          eventId: "evt-1",
          contactId: "contact-1",
          flowId: "welcome",
          stepId: "deliver",
          reason: "the platform answered 400",
        },
        hoursAgo(1.8),
      );

      const [event, ...rest] = (await report()).activity.items;

      // One event, one line: the correlation is the event id the platform gave
      // the delivery, never a guess from two instants that happen to be close.
      expect(rest).toEqual([]);
      expect(event?.eventId).toBe("evt-1");
      expect(event?.subtype).toBe("comment");
      expect(event?.contactUsername).toBe("fulano");
      expect(event?.eventText).toBe("quero");
      // The arrival, and not the instant of the last thing that happened.
      expect(event?.at).toEqual(ARRIVED);
      expect(event?.actions).toEqual([
        {
          at: hoursAgo(1.9),
          subtype: "comment_reply",
          outcome: "ok",
          flowId: "welcome",
          stepId: "reply",
          automationId: "launch",
        },
        {
          at: hoursAgo(1.8),
          subtype: "message_sent",
          outcome: "failed",
          flowId: "welcome",
          stepId: "deliver",
        },
      ]);
      // The trail stores the platform's sentence; the report does not carry it.
      expect(JSON.stringify(event)).not.toContain("the platform answered");
    });

    it("says why a step was deliberately not performed, in the engine's code", async () => {
      // Typed, so a code renamed in the engine fails to COMPILE here instead of
      // leaving a green test written against a value nobody writes any more.
      const known: SuppressionReason = "email_already_known";

      await arrival("evt-suppressed");
      await write(
        {
          kind: "action_executed",
          subtype: "message_sent",
          outcome: "suppressed",
          eventId: "evt-suppressed",
          flowId: "welcome",
          stepId: "ask-email",
          reason: known,
        },
        hoursAgo(1),
      );

      const [action, ...rest] =
        (await report()).activity.items[0]?.actions ?? [];

      // The outcome says the step fired nothing; the reason says why, which is
      // the question an operator opens this list with (REQ-068, REQ-163).
      expect(rest).toEqual([]);
      expect(action?.outcome).toBe("suppressed");
      expect(action?.reason).toBe(known);
    });

    it("says why an execution failed, in the engine's code (REQ-171)", async () => {
      // Typed, so a code renamed in the engine fails to COMPILE here instead of
      // leaving a green test written against a value nobody writes any more.
      const known: ExecutionFailureReason = "flow_not_runnable";

      await arrival("evt-broken");
      await write(
        {
          kind: "action_executed",
          subtype: "execution_failed",
          outcome: "failed",
          eventId: "evt-broken",
          flowId: "welcome",
          // Written the way `recordExecution` writes it, by the very function
          // that writes it: two encoders of one format drift the day the format
          // gains a field.
          reason: encodeExecutionFailure({ reason: known, detail: "welcome" }),
        },
        hoursAgo(1),
      );

      const [action, ...rest] =
        (await report()).activity.items[0]?.actions ?? [];

      // The line the operator opens this list for: the run failed, and here is
      // why, as a code a catalogue can answer plus the datum it cannot carry.
      expect(rest).toEqual([]);
      expect(action?.outcome).toBe("failed");
      expect(action?.reason).toBe(known);
      expect(action?.detail).toBe("welcome");
    });

    it("carries what the platform answered as data, under a code", async () => {
      await arrival("evt-refused");
      await write(
        {
          kind: "action_executed",
          subtype: "message_sent",
          outcome: "failed",
          eventId: "evt-refused",
          reason: encodeExecutionFailure({
            reason: "unexpected_error",
            detail: "the platform answered 400",
          }),
        },
        hoursAgo(1),
      );

      const [action] = (await report()).activity.items[0]?.actions ?? [];

      // The limit REQ-171 draws, at the layer that decides what crosses. The
      // words are the platform's, so no catalogue holds them and none pretends
      // to: they travel as the DETAIL of a code, never as the reason itself,
      // and the screen quotes them instead of reading them as a label.
      expect(action?.reason).toBe("unexpected_error");
      expect(action?.detail).toBe("the platform answered 400");
    });

    it("carries no detail for a reason it could not read", async () => {
      await arrival("evt-mute");
      await write(
        {
          kind: "action_executed",
          subtype: "message_sent",
          outcome: "failed",
          eventId: "evt-mute",
          // The right shape, a code from a build whose vocabulary has moved on.
          // Refused whole: half of it would be a detail hanging off a cause
          // this build cannot name, which reads as a sentence nobody wrote.
          reason: JSON.stringify({
            code: "execution_failure",
            reason: "reason_from_another_build",
            detail: "whatever it said",
          }),
        },
        hoursAgo(1),
      );

      const [action] = (await report()).activity.items[0]?.actions ?? [];

      expect(action).not.toHaveProperty("reason");
      expect(action).not.toHaveProperty("detail");
      expect(JSON.stringify(action)).not.toContain("whatever it said");
    });

    it("carries no reason that is not one of the engine's codes", async () => {
      await arrival("evt-worded");
      await write(
        {
          kind: "action_executed",
          subtype: "message_sent",
          outcome: "failed",
          eventId: "evt-worded",
          // What a failed step stores: the message of whatever was thrown, in
          // the language the instance runs in. No catalogue can translate it.
          reason: "the platform answered 400",
        },
        hoursAgo(1.5),
      );
      await write(
        {
          kind: "action_executed",
          subtype: "pause_started",
          outcome: "suppressed",
          eventId: "evt-worded",
          // Suppressed, and STILL not a code this build knows: a row written
          // by a build whose vocabulary has moved on. Recognition is membership
          // of the closed list and never the outcome beside it, so this one is
          // dropped exactly like the sentence above.
          reason: "a_reason_from_another_build",
        },
        hoursAgo(1.4),
      );

      const actions = (await report()).activity.items[0]?.actions ?? [];

      expect(actions).toHaveLength(2);
      for (const action of actions) {
        // Absent, not empty: the two are different facts everywhere else in
        // this chain, and an empty code would read as a reason nobody named.
        expect(action.reason).toBeUndefined();
        expect(action).not.toHaveProperty("reason");
      }
      expect(JSON.stringify(actions)).not.toContain("the platform answered");
      expect(JSON.stringify(actions)).not.toContain("another_build");
    });

    it("says why an event fired nothing, in codes and counts (REQ-160)", async () => {
      await arrival("evt-quiet", ARRIVED, { eventText: "oi" });
      await write(
        {
          kind: "event_received",
          subtype: "comment",
          outcome: "suppressed",
          contactId: "contact-1",
          eventId: "evt-quiet",
          reason: encodeNoMatch([
            { reason: "no_keyword", count: 3 },
            { reason: "disabled", count: 1 },
          ]),
        },
        ARRIVED,
      );

      const [event] = (await report()).activity.items;

      expect(event?.outcome).toBe("suppressed");
      expect(event?.actions).toEqual([]);
      // Decoded by the module that wrote the value, so the two can never drift.
      expect(event?.silence).toEqual({
        code: "no_match",
        refusals: [
          { reason: "no_keyword", count: 3 },
          { reason: "disabled", count: 1 },
        ],
      });
    });

    it("keeps an empty refusal list apart from no aggregate at all", async () => {
      await arrival("evt-none");
      await write(
        {
          kind: "event_received",
          subtype: "comment",
          outcome: "suppressed",
          eventId: "evt-none",
          // No automation existed to refuse it, which is a different answer
          // from every automation refusing it.
          reason: encodeNoMatch([]),
        },
        ARRIVED,
      );

      expect((await report()).activity.items[0]?.silence).toEqual({
        code: "no_match",
        refusals: [],
      });
    });

    it("names a reason it cannot read instead of forwarding the phrase", async () => {
      await arrival("evt-old");
      await write(
        {
          kind: "event_received",
          subtype: "comment",
          outcome: "suppressed",
          eventId: "evt-old",
          // A row from before REQ-160, and the same shape a refusal code this
          // build does not know produces: `decodeNoMatch` refuses the whole
          // value rather than under-reporting a count read as complete.
          reason: "no enabled automation matched this event",
        },
        ARRIVED,
      );

      const [event] = (await report()).activity.items;

      // The state is named by a code the catalogue can translate. The stored
      // phrase stays in the trail: it is wording in the language the instance
      // wrote it in, and no catalogue can translate a value out of a row.
      expect(event?.silence).toEqual({ code: "unreadable", refusals: [] });
      expect(JSON.stringify(event)).not.toContain("no enabled automation");
    });

    it("keeps an interaction that said nothing apart from a row that stored nothing", async () => {
      // A sticker: text arrived, and it was empty (REQ-162).
      await arrival("evt-sticker", hoursAgo(1), { eventText: "" });
      // A row written before the column existed: it stored no text at all.
      await write(
        {
          kind: "event_received",
          subtype: "direct_message",
          outcome: "ok",
          eventId: "evt-legacy",
        },
        hoursAgo(2),
      );

      const items = (await report()).activity.items;
      const sticker = items.find((item) => item.eventId === "evt-sticker");
      const legacy = items.find((item) => item.eventId === "evt-legacy");

      expect(sticker?.eventText).toBe("");
      expect(legacy?.eventText).toBeUndefined();
      expect(legacy).not.toHaveProperty("eventText");
    });

    it("orders the events newest first and caps how many it carries", async () => {
      const many = RECENT_ACTIVITY_LIMIT + 5;

      for (let index = 0; index < many; index += 1) {
        // Newest last, so an implementation that just took the first rows the
        // query returned would answer the wrong end of the window. A minute
        // apart, which keeps every one of them inside the range being read.
        await arrival(
          `evt-${String(index)}`,
          new Date(NOW.getTime() - (many - index) * 60_000),
        );
      }

      const activity = (await report()).activity;

      expect(activity.items).toHaveLength(RECENT_ACTIVITY_LIMIT);
      expect(activity.limit).toBe(RECENT_ACTIVITY_LIMIT);
      // Every event of the window is still counted, so the screen can say the
      // list is cut instead of implying the account was quiet.
      expect(activity.total).toBe(many);
      expect(activity.items[0]?.eventId).toBe(`evt-${String(many - 1)}`);
      expect(activity.items.at(-1)?.eventId).toBe(
        `evt-${String(many - RECENT_ACTIVITY_LIMIT)}`,
      );
    });

    it("lists no entry that belongs to no event", async () => {
      // A delivery whose signature did not verify: it names no event, and
      // nothing in that body was ever established as coming from the platform.
      await write(
        {
          kind: "event_received",
          outcome: "failed",
          reason: "signature mismatch",
        },
        ARRIVED,
      );
      // An alert is the application talking to the operator, not an event.
      await write(
        { kind: "alert", subtype: "credential_renewed", outcome: "ok" },
        ARRIVED,
      );
      await arrival("evt-1");

      const activity = (await report()).activity;

      expect(activity.items.map((item) => item.eventId)).toEqual(["evt-1"]);
      expect(activity.total).toBe(1);
      // Not lost, only listed elsewhere: the refused delivery is still an error
      // in the counts an operator reads above the list.
      expect((await report()).failures.errors).toBe(1);
    });

    it("groups the same way whichever order the rows are read in", async () => {
      // The trail answers newest first by default, and this list must not
      // depend on that: two reads of one period have to produce one report.
      const rows: AuditRecord[] = [
        {
          kind: "event_received",
          subtype: "comment",
          outcome: "ok",
          eventId: "evt-1",
          eventText: "quero",
        },
        {
          kind: "action_executed",
          subtype: "comment_reply",
          outcome: "ok",
          eventId: "evt-1",
        },
        {
          kind: "action_executed",
          subtype: "message_sent",
          outcome: "ok",
          eventId: "evt-1",
        },
      ];

      const samples = rows.map((row, index) => ({
        id: index + 1,
        occurredAt: new Date(ARRIVED.getTime() + index * 1000),
        ...row,
      }));

      const forwards = recentActivityOf(samples);
      const backwards = recentActivityOf([...samples].reverse());

      expect(backwards).toEqual(forwards);
      expect(
        forwards.items[0]?.actions.map((action) => action.subtype),
      ).toEqual(["comment_reply", "message_sent"]);
    });
  });

  describe("REQ-412/REQ-415: immutable execution lifecycle", () => {
    it("keeps multiple direct-message results, receipts and a correlated click on one execution", async () => {
      const executionId = "guide:contact-1:run";
      await write(
        {
          kind: "event_received",
          subtype: "comment",
          outcome: "ok",
          eventId: "evt-guide",
          contactId: "contact-1",
          eventText: "quero o guia",
        },
        hoursAgo(3),
      );
      await write(
        {
          kind: "action_executed",
          subtype: "message_sent",
          outcome: "ok",
          eventId: "evt-guide",
          executionId,
          contactId: "contact-1",
        },
        hoursAgo(2),
      );
      await write(
        {
          kind: "action_executed",
          subtype: "message_sent",
          outcome: "ok",
          eventId: "evt-guide",
          executionId,
          contactId: "contact-1",
        },
        hoursAgo(2),
      );
      await write(
        {
          kind: "action_executed",
          subtype: "message_sent",
          outcome: "ok",
          executionId,
          contactId: "contact-1",
          reason: "platform_accepted",
          platformMessageId: "mid-1",
        },
        hoursAgo(1),
      );
      await write(
        {
          kind: "action_executed",
          subtype: "message_sent",
          outcome: "ok",
          executionId,
          contactId: "contact-1",
          reason: "platform_seen",
        },
        new Date(hoursAgo(1).getTime() + 1_000),
      );
      await write(
        {
          kind: "action_executed",
          subtype: "message_sent",
          outcome: "failed",
          executionId,
          contactId: "contact-1",
          reason: "400: window closed",
        },
        new Date(hoursAgo(1).getTime() + 2_000),
      );

      const clicks: LinkClickSource = {
        samples: async () => [
          {
            occurredAt: new Date(hoursAgo(1).getTime() + 3_000),
            automationId: "guide",
            buttonId: "open-guide",
            destinationId: 1,
            destinationVersion: 1,
            contactId: "contact-1",
            executionId,
            buttonLabel: "Abrir guia",
          },
        ],
      };

      const lifecycle = (
        await readDashboardMetrics(
          sources(LIMIT_DEFAULTS, EPOCH_ZONE, clicks),
          "last_24_hours",
          NOW,
        )
      ).activity.executions[0];

      expect(lifecycle).toMatchObject({
        executionId,
        summary: {
          total: 2,
          queued: 0,
          accepted: 0,
          seen: 1,
          failed: 1,
          latestStatus: "failed",
        },
      });
      expect(lifecycle?.messages).toEqual([
        expect.objectContaining({ status: "seen", platformMessageId: "mid-1" }),
        expect.objectContaining({ status: "failed" }),
      ]);
      expect(lifecycle?.events.map((event) => event.kind)).toEqual([
        "received",
        "message_queued",
        "message_queued",
        "message_accepted",
        "message_seen",
        "message_failed",
        "clicked",
      ]);
      expect(lifecycle?.events.at(-1)).toMatchObject({
        kind: "clicked",
        buttonLabel: "Abrir guia",
      });
      expect(lifecycle?.messages[1]?.events.at(-1)).toMatchObject({
        kind: "message_failed",
        detail: "400: window closed",
      });
    });

    it("keeps an accepted API response honest when no seen receipt exists", async () => {
      const executionId = "guide:contact-1:unseen";
      await write(
        {
          kind: "action_executed",
          subtype: "message_sent",
          outcome: "ok",
          executionId,
          contactId: "contact-1",
        },
        hoursAgo(2),
      );
      await write(
        {
          kind: "action_executed",
          subtype: "message_sent",
          outcome: "ok",
          executionId,
          contactId: "contact-1",
          reason: "platform_accepted",
          platformMessageId: "mid-unseen",
        },
        hoursAgo(1),
      );

      const lifecycle = (await report()).activity.executions[0];
      expect(lifecycle?.summary).toMatchObject({
        total: 1,
        accepted: 1,
        seen: 0,
        latestStatus: "accepted",
      });
      expect(lifecycle?.messages[0]?.status).toBe("accepted");
      expect(lifecycle?.events.map((event) => event.kind)).not.toContain(
        "message_seen",
      );
    });
  });

  describe("the window boundaries", () => {
    it("spans exactly the range asked for, ending now", () => {
      const window = windowOf("last_7_days", NOW, EPOCH_ZONE);

      expect(window.until).toEqual(NOW);
      expect(window.since).toEqual(new Date("2026-07-26T12:00:00.000Z"));
    });

    it("includes an entry written at the very start of the window", async () => {
      const window = windowOf("last_24_hours", NOW, EPOCH_ZONE);
      await write(
        { kind: "event_received", subtype: "comment", outcome: "ok" },
        window.since,
      );

      expect((await report()).events.total).toBe(1);
    });
  });

  describe("REQ-392 to REQ-398: application-owned link analytics", () => {
    it("keeps totals, the post funnel and button versions in the same range", async () => {
      const executionId = "launch:contact-1:run";
      await write(
        {
          kind: "event_received",
          subtype: "comment",
          outcome: "ok",
          contactId: "contact-1",
          executionId,
          publicationId: "post-1",
        },
        hoursAgo(2),
      );
      await write(
        {
          kind: "action_executed",
          subtype: "comment_reply",
          outcome: "ok",
          contactId: "contact-1",
          executionId,
          publicationId: "post-1",
        },
        hoursAgo(2),
      );
      await write(
        {
          kind: "action_executed",
          subtype: "message_sent",
          outcome: "ok",
          contactId: "contact-1",
          executionId,
          publicationId: "post-1",
        },
        hoursAgo(2),
      );
      const clicks: LinkClickSource = {
        samples: async () => [
          {
            occurredAt: hoursAgo(1),
            automationId: "launch",
            buttonId: "learn-more",
            destinationId: 1,
            destinationVersion: 2,
            contactId: "contact-1",
            executionId,
          },
          {
            occurredAt: hoursAgo(1),
            automationId: "launch",
            buttonId: "learn-more",
            destinationId: 1,
            destinationVersion: 2,
            contactId: "contact-2",
            executionId: "legacy-run",
          },
        ],
      };

      const metrics = await readDashboardMetrics(
        sources(LIMIT_DEFAULTS, EPOCH_ZONE, clicks),
        "last_24_hours",
        NOW,
      );

      expect(metrics.links.totals).toEqual({
        clicks: 2,
        uniqueContacts: 2,
        automations: 1,
        publications: 1,
      });
      expect(metrics.links.trend.total).toBe(2);
      expect(sumOf(metrics.links.trend.counts)).toBe(2);
      expect(metrics.links.posts).toEqual([
        {
          publicationId: "post-1",
          comments: 1,
          commentDetails: [],
          publicReplies: 1,
          acceptedMessages: 1,
          clicks: 1,
          uniqueContacts: 1,
          links: [{ clicks: 1, uniqueContacts: 1 }],
        },
      ]);
      expect(metrics.links.unattributedClicks).toBe(1);
      expect(metrics.links.buttons).toEqual([
        {
          automationId: "launch",
          buttonId: "learn-more",
          destinationVersion: 2,
          clicks: 2,
          uniqueContacts: 2,
        },
      ]);
    });

    it("groups global and publication automations under one cached post without rebuilding history", async () => {
      const globalRun = "global:contact-1:run";
      const postRun = "post:contact-2:run";
      await write(
        {
          kind: "event_received",
          subtype: "comment",
          outcome: "ok",
          contactId: "contact-1",
          executionId: globalRun,
          publicationId: "post-1",
          eventText: "quero saber mais",
        },
        hoursAgo(3),
      );
      await write(
        {
          kind: "action_executed",
          subtype: "message_sent",
          outcome: "ok",
          contactId: "contact-1",
          executionId: globalRun,
          publicationId: "post-1",
          matchedKeyword: "saber",
        },
        hoursAgo(3),
      );
      await write(
        {
          kind: "event_received",
          subtype: "comment",
          outcome: "ok",
          contactId: "contact-2",
          executionId: postRun,
          publicationId: "post-1",
          eventText: "me mande o link",
        },
        hoursAgo(2),
      );
      const clicks: LinkClickSource = {
        samples: async () => [
          {
            occurredAt: hoursAgo(1),
            automationId: "global-flow",
            buttonId: "old-link",
            destinationId: 1,
            destinationVersion: 1,
            contactId: "contact-1",
            executionId: globalRun,
            buttonLabel: "Abrir guia",
          },
          {
            occurredAt: hoursAgo(1),
            automationId: "post-flow",
            buttonId: "legacy-link",
            destinationId: 2,
            destinationVersion: 1,
            contactId: "contact-2",
            executionId: postRun,
          },
        ],
      };
      const metrics = await readDashboardMetrics(
        {
          ...sources(LIMIT_DEFAULTS, EPOCH_ZONE, clicks),
          publications: {
            byIds: async (ids) =>
              ids.includes("post-1")
                ? [
                    {
                      id: "post-1",
                      caption: "A primeira linha da publicação",
                      thumbnailKey: "thumbs/post-1.jpg",
                    },
                  ]
                : [],
          },
        },
        "last_24_hours",
        NOW,
      );

      expect(metrics.links.posts).toEqual([
        {
          publicationId: "post-1",
          publication: {
            id: "post-1",
            caption: "A primeira linha da publicação",
            thumbnailKey: "thumbs/post-1.jpg",
          },
          comments: 2,
          commentDetails: [
            { text: "me mande o link" },
            { text: "quero saber mais", matchedKeyword: "saber" },
          ],
          publicReplies: 0,
          acceptedMessages: 1,
          clicks: 2,
          uniqueContacts: 2,
          links: [
            { clicks: 1, uniqueContacts: 1 },
            { label: "Abrir guia", clicks: 1, uniqueContacts: 1 },
          ],
        },
      ]);
      // The two flow ids live only in the click-store diagnostics. They cannot
      // split the publication contract the Links screen reads.
      expect(metrics.links.posts).toHaveLength(1);
    });
  });
});

/**
 * Proves REQ-030 by reading the sources: every metric is derived from this
 * application's own tables, with no observability service in the path.
 *
 * Checked at the import graph and not by mocking a network call, because the
 * requirement is about a DEPENDENCY, and a dependency that exists but is not
 * exercised by a given test would pass any behavioural check.
 */
describe("REQ-030: the metrics depend on no external service", () => {
  const directory = fileURLToPath(new URL(".", import.meta.url));

  function productionSources(): string[] {
    return readdirSync(directory).filter(
      (name) => name.endsWith(".ts") && !name.endsWith(".test.ts"),
    );
  }

  function importsOf(file: string): string[] {
    const source = readFileSync(`${directory}${file}`, "utf8");
    const specifiers: string[] = [];
    const pattern =
      /(?:^|\n)\s*(?:import|export)[^"'\n]*from\s+["']([^"']+)["']/g;

    let match = pattern.exec(source);
    while (match !== null) {
      specifiers.push(match[1] ?? "");
      match = pattern.exec(source);
    }

    return specifiers;
  }

  it("finds the sources to check", () => {
    // Guards the guard: a directory read that matched nothing would pass while
    // proving nothing at all.
    expect(productionSources().length).toBeGreaterThan(1);
  });

  it("imports no transport and no telemetry client", () => {
    const forbidden = [
      /^https?:/,
      /^node:(http|https|net|tls|dgram)$/,
      /undici|node-fetch|axios/,
      /opentelemetry|datadog|sentry|prometheus|statsd/,
      // The only layer in this project that calls the platform. Metrics that
      // needed it would be metrics asked of somebody else's service.
      /\.\.\/platform\//,
    ];

    for (const file of productionSources()) {
      for (const specifier of importsOf(file)) {
        for (const pattern of forbidden) {
          expect(specifier, `${file} imports ${specifier}`).not.toMatch(
            pattern,
          );
        }
      }
    }
  });
});
