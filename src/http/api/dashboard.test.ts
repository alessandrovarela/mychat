import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../../app.js";
import type { App } from "../../app.js";
import {
  createOperatorCredentialStore,
  setOperatorPassword,
} from "../../auth/credential.js";
import { SESSION_COOKIE_NAME } from "../../auth/session.js";
import { ConfigError } from "../../config/errors.js";
import { encodeNoMatch } from "../../flows/matching.js";
import {
  createAuditRepository,
  createButtonClickStore,
  createPublicationCacheStore,
  openDatabase,
} from "../../storage/index.js";
import type { AuditRepository, DatabaseHandle } from "../../storage/index.js";

/**
 * REQ-153 against the COMPOSED application: the panel counts and labels in the
 * zone the INSTANCE is configured with.
 *
 * Why here, and against the whole process rather than against the aggregation:
 * `src/dashboard/aggregate.test.ts` proves that a zone changes which bucket an
 * entry falls in, and every case there passes whether or not the running
 * process ever hands the aggregation the operator's zone. That is the defect
 * this file exists to make impossible, and it is the shape the phase has been
 * bitten by twice already (REQ-130, REQ-135): a capability proven in isolation,
 * never wired, green suite, silent gap in the product.
 *
 * So nothing here is injected. The environment carries the zone, `createApp`
 * builds the real router over a real database, the trail row is written through
 * a SECOND connection to the file the application wrote, and the numbers are
 * read through the contract with an operator's session, exactly as the screen
 * reads them.
 *
 * The distinction every case turns on: a build that translated the LABELS into
 * the configured zone and went on flooring its buckets on the epoch would put
 * the evening of an operator in Sao Paulo under the following day. So what is
 * asserted is the bucket INSTANT an entry landed on, never a rendered word.
 */

const APP_SECRET = "app-secret";
const VERIFY_TOKEN = "verify-me";
const PASSWORD = "operator-password";
const NOW = new Date("2026-08-02T12:00:00.000Z");

/** Three hours behind UTC, and on no daylight saving since 2019. */
const OPERATOR_ZONE = "America/Sao_Paulo";

/**
 * 20:30 on 1 August for the operator, 23:30 on 1 August in UTC. The instant is
 * the same; the DAY it belongs to is what the zone decides.
 */
const LATE_EVENING = new Date("2026-08-01T23:30:00.000Z");

/** Local midnight of 1 August in Sao Paulo, which is no UTC midnight at all. */
const LOCAL_DAY = "2026-08-01T03:00:00.000Z";
const UTC_DAY = "2026-08-01T00:00:00.000Z";

const clock = { now: (): Date => NOW };

const dirs: string[] = [];
const apps: App[] = [];
const handles: DatabaseHandle[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "mychat-dashboard-"));
  dirs.push(dir);
  return dir;
}

function baseEnv(
  dir: string,
  overrides: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  return {
    META_APP_SECRET: APP_SECRET,
    WEBHOOK_VERIFY_TOKEN: VERIFY_TOKEN,
    DATABASE_PATH: join(dir, "mychat.db"),
    ASSETS_DIR: join(dir, "assets"),
    THUMBNAILS_DIR: join(dir, "thumbs"),
    // Far longer than this file takes, so the armed loop never races a read.
    SWEEP_INTERVAL_MS: "60000",
    ...overrides,
  };
}

/** A second connection to the file the application wrote. */
function inspect(dir: string): DatabaseHandle {
  const handle = openDatabase({ databasePath: join(dir, "mychat.db") });
  handles.push(handle);
  return handle;
}

afterEach(async () => {
  for (const app of apps.splice(0)) {
    await app.close();
  }
  for (const handle of handles.splice(0)) {
    handle.close();
  }
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

interface Reader {
  readonly app: App;
  readonly cookie: string;
  readonly dir: string;
}

interface BreakdownBody {
  readonly buckets: string[];
  readonly series: { subtype: string; total: number; counts: number[] }[];
}

interface ActivityBody {
  readonly items: {
    readonly eventId: string;
    readonly at: string;
    readonly subtype: string;
    readonly outcome: string;
    readonly contactUsername?: string;
    readonly eventText?: string;
    readonly actions: { subtype: string; outcome: string; at: string }[];
    readonly silence?: {
      code: string;
      refusals: { reason: string; count: number }[];
    };
  }[];
  readonly total: number;
  readonly limit: number;
  readonly executions: readonly {
    readonly executionId: string;
    readonly at: string;
    readonly updatedAt: string;
    readonly summary: {
      readonly total: number;
      readonly queued: number;
      readonly accepted: number;
      readonly seen: number;
      readonly failed: number;
      readonly latestStatus?: string;
    };
    readonly messages: readonly {
      readonly id: number;
      readonly status: string;
      readonly platformMessageId?: string;
      readonly events: readonly {
        readonly at: string;
        readonly kind: string;
        readonly detail?: string;
      }[];
    }[];
    readonly events: readonly {
      readonly at: string;
      readonly kind: string;
      readonly buttonLabel?: string;
    }[];
  }[];
  readonly executionTotal: number;
}

interface MetricsBody {
  readonly metrics: {
    readonly window: { range: string; granularity: string; zone: string };
    readonly events: BreakdownBody;
    readonly links: {
      readonly totals: {
        readonly clicks: number;
        readonly uniqueContacts: number;
        readonly automations: number;
        readonly publications: number;
      };
      readonly trend: {
        readonly buckets: string[];
        readonly counts: number[];
        readonly total: number;
      };
      readonly posts: readonly {
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
        readonly links: readonly {
          readonly label?: string;
          readonly clicks: number;
          readonly uniqueContacts: number;
        }[];
      }[];
      readonly buttons: readonly unknown[];
      readonly unattributedClicks: number;
    };
    readonly activity: ActivityBody;
    readonly openAlert?: {
      readonly origin: string;
      readonly reason: string;
      readonly occurredAt: string;
      readonly subtype?: string;
      readonly automationId?: string;
    };
    readonly disabledTriggers: readonly {
      readonly name: string;
      readonly updatedAt: string;
    }[];
  };
}

/**
 * The application as deployed, with one comment in its trail and an operator
 * who can open the panel.
 *
 * No platform credential, deliberately: this installation has never seen the
 * platform, which keeps the trail free of the entry the credential seeding
 * writes, so what is counted below is exactly what this file put there.
 */
async function bootWith(
  seed: (audit: AuditRepository) => Promise<void>,
  zone?: string,
): Promise<Reader> {
  const dir = tempDir();
  const app = await createApp(
    baseEnv(dir, zone === undefined ? {} : { MYCHAT_TIMEZONE: zone }),
    { clock },
  );
  apps.push(app);

  const db = inspect(dir).db;
  await setOperatorPassword(PASSWORD, createOperatorCredentialStore(db), NOW);
  await seed(createAuditRepository(db));

  const opened = await app.server.inject({
    method: "POST",
    url: "/api/session",
    headers: { "content-type": "application/json" },
    payload: JSON.stringify({ password: PASSWORD }),
  });
  const session = opened.cookies.find(
    (cookie) => cookie.name === SESSION_COOKIE_NAME,
  );
  expect(session).toBeDefined();

  return {
    app,
    cookie: `${SESSION_COOKIE_NAME}=${String(session?.value)}`,
    dir,
  };
}

function bootWithTrail(zone?: string): Promise<Reader> {
  return bootWith(
    (audit) =>
      audit
        .record(
          { kind: "event_received", subtype: "comment", outcome: "ok" },
          LATE_EVENING,
        )
        .then(() => undefined),
    zone,
  );
}

/** The numbers exactly as the screen reads them, through the contract. */
async function metricsOf(
  reader: Reader,
  range = "last_7_days",
): Promise<MetricsBody["metrics"]> {
  const response = await reader.app.server.inject({
    method: "GET",
    url: `/api/dashboard/metrics?range=${range}`,
    headers: { cookie: reader.cookie },
  });

  expect(response.statusCode).toBe(200);

  return response.json<MetricsBody>().metrics;
}

/** The bucket instants where something was actually counted. */
function filled(breakdown: BreakdownBody): string[] {
  const counts = breakdown.series.find(
    (series) => series.subtype === "comment",
  )?.counts;

  if (counts === undefined) {
    throw new Error("no comment series in the answer");
  }

  return breakdown.buckets.filter((_, index) => (counts[index] ?? 0) > 0);
}

/**
 * REQ-164: the same authenticated route gives back the window event by event.
 *
 * Against the composed application, and through the contract, because that is
 * where the two things this list can get wrong are visible: the serialiser
 * decides what actually reaches a screen (a field nobody declared cannot), and
 * the private scope decides who may ask.
 */
describe("REQ-164: the recent activity over the contract", () => {
  /** Ten minutes before `NOW`, comfortably inside every range. */
  const RECENTLY = new Date("2026-08-02T11:50:00.000Z");

  async function bootWithActivity(): Promise<Reader> {
    return bootWith(async (audit) => {
      // One comment that fired a reply, as the dispatcher records it: the
      // receipt carrying what arrived, then what was done about it.
      await audit.record(
        {
          kind: "event_received",
          subtype: "comment",
          outcome: "ok",
          contactId: "contact-1",
          eventId: "evt-fired",
          eventText: "quero",
          contactUsername: "fulano",
        },
        RECENTLY,
      );
      await audit.record(
        {
          kind: "action_executed",
          subtype: "message_sent",
          outcome: "ok",
          contactId: "contact-1",
          eventId: "evt-fired",
          flowId: "welcome",
          stepId: "deliver",
        },
        new Date(RECENTLY.getTime() + 1000),
      );

      // And one that fired nothing at all, with the aggregate REQ-160 stores.
      await audit.record(
        {
          kind: "event_received",
          subtype: "comment",
          outcome: "ok",
          contactId: "contact-2",
          eventId: "evt-quiet",
          eventText: "oi",
        },
        new Date(RECENTLY.getTime() - 60_000),
      );
      await audit.record(
        {
          kind: "event_received",
          subtype: "comment",
          outcome: "suppressed",
          contactId: "contact-2",
          eventId: "evt-quiet",
          reason: encodeNoMatch([{ reason: "no_keyword", count: 3 }]),
        },
        new Date(RECENTLY.getTime() - 59_000),
      );
    });
  }

  it("answers what arrived, what was done, and why nothing was", async () => {
    const metrics = await metricsOf(await bootWithActivity(), "last_24_hours");
    const activity = metrics.activity;

    expect(activity.total).toBe(2);
    expect(activity.items.map((item) => item.eventId)).toEqual([
      "evt-fired",
      "evt-quiet",
    ]);

    const fired = activity.items[0];
    expect(fired?.contactUsername).toBe("fulano");
    expect(fired?.eventText).toBe("quero");
    expect(fired?.actions).toEqual([
      {
        at: new Date(RECENTLY.getTime() + 1000).toISOString(),
        subtype: "message_sent",
        outcome: "ok",
        flowId: "welcome",
        stepId: "deliver",
      },
    ]);

    const quiet = activity.items[1];
    expect(quiet?.eventText).toBe("oi");
    expect(quiet?.actions).toEqual([]);
    // Codes and counts, never a sentence: the screen writes the words from the
    // catalogue, in the operator's language (REQ-163, REQ-074).
    expect(quiet?.silence).toEqual({
      code: "no_match",
      refusals: [{ reason: "no_keyword", count: 3 }],
    });
  });

  it("counts the same events it lists, from the same read", async () => {
    const metrics = await metricsOf(await bootWithActivity(), "last_24_hours");

    // Four rows in the trail, but only two typed receipt rows: the other rows
    // describe what happened after those arrivals. The list and the counts
    // above it come out of one query, so they cannot describe two periods.
    expect(metrics.events.series[0]?.subtype).toBe("comment");
    expect(metrics.events.series[0]?.total).toBe(2);
    expect(metrics.activity.total).toBe(2);
  });

  it("serialises one execution's message lifecycle without claiming delivery", async () => {
    const reader = await bootWith(async (audit) => {
      await audit.record(
        {
          kind: "action_executed",
          subtype: "message_sent",
          outcome: "ok",
          executionId: "guide:contact-1:run",
          contactId: "contact-1",
        },
        RECENTLY,
      );
      await audit.record(
        {
          kind: "action_executed",
          subtype: "message_sent",
          outcome: "ok",
          executionId: "guide:contact-1:run",
          contactId: "contact-1",
          reason: "platform_accepted",
          platformMessageId: "mid-guide",
        },
        new Date(RECENTLY.getTime() + 1_000),
      );
    });

    const activity = (await metricsOf(reader, "last_24_hours")).activity;
    expect(activity.executionTotal).toBe(1);
    expect(activity.executions).toEqual([
      expect.objectContaining({
        executionId: "guide:contact-1:run",
        summary: expect.objectContaining({
          total: 1,
          accepted: 1,
          seen: 0,
          latestStatus: "accepted",
        }),
        messages: [
          expect.objectContaining({
            status: "accepted",
            platformMessageId: "mid-guide",
          }),
        ],
      }),
    ]);
  });

  it("keeps every provable DM state, its technical failure and a later click in one execution", async () => {
    const executionId = "guide:contact-1:complete";
    const reader = await bootWith(async (audit) => {
      const at = (seconds: number): Date =>
        new Date(RECENTLY.getTime() + seconds * 1_000);
      await audit.record(
        {
          kind: "event_received",
          subtype: "comment",
          outcome: "ok",
          eventId: "evt-guide",
          executionId,
          contactId: "contact-1",
        },
        at(0),
      );
      // Four queued messages are deliberately kept separate. Their later
      // observations are the only facts allowed to move each one forward.
      for (const seconds of [1, 3, 6, 8]) {
        await audit.record(
          {
            kind: "action_executed",
            subtype: "message_sent",
            outcome: "ok",
            executionId,
            contactId: "contact-1",
          },
          at(seconds),
        );
      }
      await audit.record(
        {
          kind: "action_executed",
          subtype: "message_sent",
          outcome: "ok",
          executionId,
          contactId: "contact-1",
          reason: "platform_accepted",
          platformMessageId: "mid-accepted",
        },
        at(2),
      );
      await audit.record(
        {
          kind: "action_executed",
          subtype: "message_sent",
          outcome: "ok",
          executionId,
          contactId: "contact-1",
          reason: "platform_accepted",
          platformMessageId: "mid-seen",
        },
        at(4),
      );
      await audit.record(
        {
          kind: "action_executed",
          subtype: "message_sent",
          outcome: "ok",
          executionId,
          contactId: "contact-1",
          reason: "platform_seen",
          platformMessageId: "mid-seen",
        },
        at(5),
      );
      await audit.record(
        {
          kind: "action_executed",
          subtype: "message_sent",
          outcome: "failed",
          executionId,
          contactId: "contact-1",
          reason: "400: window closed",
        },
        at(7),
      );
    });
    const db = inspect(reader.dir).db;
    const clicks = createButtonClickStore(db);
    const destination = await clicks.destinationFor(
      "guide",
      "open-guide",
      "https://example.test/guide",
      RECENTLY,
      "Open guide",
    );
    await clicks.record({
      occurredAt: new Date(RECENTLY.getTime() + 9_000),
      automationId: "guide",
      buttonId: "open-guide",
      destinationId: destination.id,
      destinationVersion: destination.version,
      contactId: "contact-1",
      executionId,
      buttonLabel: "Open guide",
    });

    const lifecycle = (await metricsOf(reader, "last_24_hours")).activity
      .executions[0];

    expect(lifecycle).toMatchObject({
      executionId,
      summary: {
        total: 4,
        queued: 1,
        accepted: 1,
        seen: 1,
        failed: 1,
        latestStatus: "queued",
      },
    });
    expect(lifecycle?.messages.map((message) => message.status)).toEqual([
      "accepted",
      "seen",
      "failed",
      "queued",
    ]);
    expect(lifecycle?.messages[0]?.platformMessageId).toBe("mid-accepted");
    expect(lifecycle?.messages[1]?.platformMessageId).toBe("mid-seen");
    expect(lifecycle?.events.map((event) => event.kind)).toEqual([
      "received",
      "message_queued",
      "message_accepted",
      "message_queued",
      "message_accepted",
      "message_seen",
      "message_queued",
      "message_failed",
      "message_queued",
      "clicked",
    ]);
    expect(lifecycle?.messages[2]?.events.at(-1)).toMatchObject({
      kind: "message_failed",
      detail: "400: window closed",
    });
    expect(lifecycle?.events.at(-1)).toMatchObject({
      kind: "clicked",
      buttonLabel: "Open guide",
    });
  });

  it("refuses the report to a request with no session", async () => {
    const reader = await bootWithActivity();

    const response = await reader.app.server.inject({
      method: "GET",
      url: "/api/dashboard/metrics?range=last_24_hours",
    });

    // The activity carries what contacts wrote and who they are, so the route
    // that answers it is private exactly as the counts are.
    expect(response.statusCode).toBe(401);
    expect(response.body).not.toContain("quero");
  });
});

describe("REQ-203: the panel carries the open operational alert", () => {
  it("answers the same automatic-pause origin, reason and instant as status", async () => {
    const reason = "Launch was paused automatically after three failures";
    const reader = await bootWith((audit) =>
      audit
        .record(
          {
            kind: "alert",
            subtype: "automation_auto_paused",
            outcome: "failed",
            automationId: "launch",
            reason,
          },
          NOW,
        )
        .then(() => undefined),
    );

    expect((await metricsOf(reader, "last_24_hours")).openAlert).toEqual({
      origin: "machine",
      reason,
      occurredAt: NOW.toISOString(),
      subtype: "automation_auto_paused",
      automationId: "launch",
    });
  });

  it("omits any alert claim while operational status is healthy", async () => {
    expect(
      (await metricsOf(await bootWith(async () => undefined))).openAlert,
    ).toBeUndefined();
  });
});

describe("REQ-207: the panel contract names disabled trigger switches", () => {
  it("returns silence when all three switches are on", async () => {
    const reader = await bootWith(async () => undefined);
    expect((await metricsOf(reader)).disabledTriggers).toEqual([]);
  });

  it("returns every off switch with the instant it changed", async () => {
    const reader = await bootWith(async () => undefined);
    for (const name of ["comments", "directMessages"] as const) {
      const response = await reader.app.server.inject({
        method: "POST",
        url: "/api/instance/triggers",
        headers: {
          cookie: reader.cookie,
          "content-type": "application/json",
        },
        payload: JSON.stringify({ name, enabled: false }),
      });
      expect(response.statusCode).toBe(200);
    }

    expect((await metricsOf(reader)).disabledTriggers).toEqual([
      { name: "comments", updatedAt: NOW.toISOString() },
      { name: "directMessages", updatedAt: NOW.toISOString() },
    ]);
  });
});

describe("REQ-153: the composed application counts in the configured zone", () => {
  it("files the operator's evening under their own day", async () => {
    const metrics = await metricsOf(await bootWithTrail(OPERATOR_ZONE));

    // The bucket is a local midnight in Sao Paulo, three hours off any UTC one.
    // This is the assertion a relabelling build cannot pass: it would answer
    // the UTC midnight of 1 August and merely print it differently, and with
    // the entry at 23:30 UTC it would answer the midnight of the 2nd.
    expect(filled(metrics.events)).toEqual([LOCAL_DAY]);
    expect(metrics.window.granularity).toBe("day");
  });

  it("carries the zone it counted in, so the screen reads the same clock", async () => {
    const metrics = await metricsOf(await bootWithTrail(OPERATOR_ZONE));

    // The screen labels every instant of this answer with it. A zone the panel
    // chose for itself would be a second opinion, and the two would disagree
    // the day the configuration changed.
    expect(metrics.window.zone).toBe(OPERATOR_ZONE);
  });

  it("counts on the epoch for an instance that configured no zone", async () => {
    const metrics = await metricsOf(await bootWithTrail());

    // The default is not an accident: it is what every bucket already was, so
    // an installation that sets nothing sees the numbers it saw yesterday.
    expect(metrics.window.zone).toBe("UTC");
    expect(filled(metrics.events)).toEqual([UTC_DAY]);
  });

  it("puts the same instant in a different bucket for a zone ahead of UTC", async () => {
    const metrics = await metricsOf(await bootWithTrail("Asia/Tokyo"));

    // 08:30 on 2 August in Tokyo: the same row, a different day, and neither
    // the UTC answer nor the Sao Paulo one.
    expect(metrics.window.zone).toBe("Asia/Tokyo");
    expect(filled(metrics.events)).toEqual(["2026-08-01T15:00:00.000Z"]);
    expect(filled(metrics.events)).not.toEqual([UTC_DAY]);
  });

  it("refuses to start on a zone name it cannot count in, naming the variable", async () => {
    // The typo an operator will actually make. Refused at start-up, like every
    // other value this application cannot honour: falling back to UTC would
    // file every number under a zone nobody chose, and say so nowhere.
    const error: unknown = await createApp(
      baseEnv(tempDir(), { MYCHAT_TIMEZONE: "America/Sao_Paolo" }),
      { clock },
    ).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(ConfigError);
    expect((error as ConfigError).variables).toEqual(["MYCHAT_TIMEZONE"]);
    expect((error as ConfigError).message).toContain("MYCHAT_TIMEZONE");
    // Never the value: this goes to a terminal and to a log.
    expect((error as ConfigError).message).not.toContain("Sao_Paolo");
  });
});

describe("REQ-392 and REQ-398: the authenticated link contract", () => {
  it("returns only internal click totals and an aligned zero trend", async () => {
    const metrics = await metricsOf(await bootWith(async () => undefined));

    expect(metrics.links.totals).toEqual({
      clicks: 0,
      uniqueContacts: 0,
      automations: 0,
      publications: 0,
    });
    expect(metrics.links.trend.counts).toHaveLength(
      metrics.links.trend.buckets.length,
    );
    expect(metrics.links.trend.total).toBe(0);
    expect(metrics.links.posts).toEqual([]);
    expect(metrics.links.buttons).toEqual([]);
    expect(metrics.links.unattributedClicks).toBe(0);
    // CTR would require impressions, and the contract deliberately exposes no
    // platform, location, browser, device, IP or user-agent dimension.
    expect(metrics.links).not.toHaveProperty("ctr");
    expect(metrics.links).not.toHaveProperty("location");
    expect(metrics.links).not.toHaveProperty("device");
    expect(metrics.links).not.toHaveProperty("browser");
  });

  it("enriches the post contract from cache and keeps link labels as snapshots", async () => {
    const reader = await bootWith(async (audit) => {
      await audit.record(
        {
          kind: "event_received",
          subtype: "comment",
          outcome: "ok",
          contactId: "contact-1",
          executionId: "run-1",
          publicationId: "post-1",
          eventText: "quero o guia",
        },
        LATE_EVENING,
      );
      await audit.record(
        {
          kind: "action_executed",
          subtype: "message_sent",
          outcome: "ok",
          contactId: "contact-1",
          executionId: "run-1",
          publicationId: "post-1",
          matchedKeyword: "guia",
        },
        LATE_EVENING,
      );
    });
    const db = inspect(reader.dir).db;
    const cache = createPublicationCacheStore(db);
    await cache.replace(
      [
        {
          id: "post-1",
          caption: "Guia para começar",
          mediaType: "IMAGE",
          publishedAt: LATE_EVENING,
          thumbnailKey: "thumbs/post-1.jpg",
        },
      ],
      NOW,
    );
    const clicks = createButtonClickStore(db);
    const destination = await clicks.destinationFor(
      "any-automation",
      "guide",
      "https://example.test/guide",
      NOW,
      "Abrir guia",
    );
    await clicks.record({
      occurredAt: NOW,
      automationId: "any-automation",
      buttonId: "guide",
      destinationId: destination.id,
      destinationVersion: destination.version,
      contactId: "contact-1",
      executionId: "run-1",
      buttonLabel: "Abrir guia",
    });

    const metrics = await metricsOf(reader, "last_24_hours");

    expect(metrics.links.posts).toEqual([
      {
        publicationId: "post-1",
        publication: {
          id: "post-1",
          caption: "Guia para começar",
          thumbnailKey: "thumbs/post-1.jpg",
        },
        comments: 1,
        commentDetails: [{ text: "quero o guia", matchedKeyword: "guia" }],
        publicReplies: 0,
        acceptedMessages: 1,
        clicks: 1,
        uniqueContacts: 1,
        links: [{ label: "Abrir guia", clicks: 1, uniqueContacts: 1 }],
      },
    ]);
  });
});
