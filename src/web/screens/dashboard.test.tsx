import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { ReactElement } from "react";
import en from "../../i18n/locales/en.json";
/**
 * The other shipped language, read for one thing only: REQ-181 is a promise
 * about the WORD beside a headline number, and a promise kept in English while
 * the Portuguese catalogue says "enviadas" is a promise kept for half the
 * operators. Every other assertion in this file runs in the language the
 * screen is mounted in.
 */
import ptBR from "../../i18n/locales/pt-BR.json";
/**
 * The data layer's own three words, for REQ-192 and nothing else.
 *
 * `vocabulary.js` and never `aggregate.js`: the second reaches a database
 * driver, and this file is compiled by the interface's program, so importing it
 * would put the driver where the mirror exists to keep it out. `vocabulary.ts`
 * imports nothing at all, which is the whole reason it was split off.
 */
import { DASHBOARD_RANGES as COMPUTED_RANGES } from "../../dashboard/vocabulary.js";
import type {
  BucketGranularity as ComputedBucketGranularity,
  CapStatus as ComputedCapStatus,
  CapWindow as ComputedCapWindow,
  DashboardRange as ComputedDashboardRange,
} from "../../dashboard/vocabulary.js";
import type { CapStatus as MeterCapStatus } from "../components/CapMeter.js";
import { LocaleProvider } from "../locale.js";
import type { LocaleClient, LocaleState } from "../locale.js";
import { DASHBOARD_RANGES, DashboardScreen, LABEL_KEYS } from "./dashboard.js";
import type {
  ActivityEventView,
  BucketGranularity,
  CapStatus,
  CapWindow,
  DashboardClient,
  DashboardMetricsView,
  DashboardRange,
  RecentActivityView,
} from "./dashboard.js";

/**
 * The panel, against the acceptance criteria of the phase (37 to 42) and
 * against REQ-115, which is what this task adds: the four situations the screen
 * can be in look like four different things, and so do the three consumption
 * bands.
 *
 * Every fixture below is what the API answers, never what the screen computes:
 * the aggregation is proven in `src/dashboard/aggregate.test.ts` and the
 * contract in `src/http/api-contract.test.ts`, so what is at stake here is the
 * PRESENTATION. Four things this file exists to pin down, because each one is a
 * number or a state that would still render, wrongly, if the screen got it
 * wrong:
 *
 *   - the unknown group is reported apart and never as a column, so the columns
 *     plus that group add up to the recorded total and nothing is counted
 *     twice;
 *   - the cap status comes from the field the aggregation computed against the
 *     configured thresholds, and is written in WORDS, so it is not recomputed
 *     here and not carried by a tint;
 *   - the two per-second ceilings carry no meter, because they read the second
 *     in progress and a bar frozen at empty reads as a broken widget;
 *   - an empty period, a read in flight and a failed read are three different
 *     things on screen, and an empty queue shows its zero without raising an
 *     alert about nothing.
 *
 * The words are the SHIPPED catalogue's, read out of it rather than retyped:
 * rewording a sentence must not fail a test about behaviour, and a test that
 * quoted its own copy would go green against a screen showing something else.
 */

/**
 * The engine's own vocabulary, which this screen translates too: a step
 * deliberately not performed (REQ-068) reaches the panel as a code, and the
 * words for it were already in the shipped catalogue before any screen asked
 * for them (REQ-163).
 */
const suppressed = en.engine.suppressed;

/**
 * And its failure vocabulary (REQ-171). A run that broke reaches the panel as a
 * code exactly as a suppressed step does, and lands as a sentence the same way;
 * what it may also bring is a DETAIL, which is the one thing on this line the
 * catalogue does not own and could not.
 */
const failed = en.engine.failed;

/**
 * This screen's own section, and the trail's vocabulary it renders — the
 * PUBLISHED catalogue, with nothing spread over it. Every assertion in this
 * file therefore runs against the sentence an operator really reads, and a
 * rewording in `src/i18n/locales/*.json` flows straight through here.
 */
const copy = en.screens.dashboard;
const navCopy = en.nav;
const words = en.dashboard;

const catalogues = {
  en: {
    ...en,
    dashboard: words,
    screens: { ...en.screens, dashboard: copy },
  },
};

/** Resolves a catalogue entry the way the translator does, for a query. */
function text(
  template: string,
  params: Record<string, string | number>,
): string {
  return Object.entries(params).reduce(
    (resolved, [name, value]) =>
      resolved.split(`{{${name}}}`).join(String(value)),
    template,
  );
}

/** The instance's language, which this screen does not choose. */
const localeClient: LocaleClient = {
  read: (): Promise<LocaleState> =>
    Promise.resolve({ locale: "en", available: ["en"] }),
  write: (): Promise<LocaleState> =>
    Promise.resolve({ locale: "en", available: ["en"] }),
};

const HOUR_BUCKETS = [
  "2026-08-01T09:00:00.000Z",
  "2026-08-01T10:00:00.000Z",
  "2026-08-01T11:00:00.000Z",
];

const DAY_BUCKETS = [
  "2026-07-29T00:00:00.000Z",
  "2026-07-30T00:00:00.000Z",
  "2026-07-31T00:00:00.000Z",
  "2026-08-01T00:00:00.000Z",
];

/** What an instance that configured no zone counts and labels in. */
const EPOCH_ZONE = "UTC";

/**
 * The window event by event (REQ-164, REQ-165), with the four shapes a line can
 * take: one that fired and did two things, one whose action failed, one that
 * fired NOTHING and says why with the aggregate behind it, and one the record
 * says nothing else about.
 *
 * The texts are deliberately three different facts: words, an empty string (an
 * interaction that carried none: a sticker, a button) and no field at all (a
 * row that stored none). The trail keeps them apart and so must the screen.
 */
const ACTIVITY: RecentActivityView = {
  items: [
    {
      eventId: "evt-fired",
      at: "2026-08-01T11:20:00.000Z",
      subtype: "comment",
      outcome: "ok",
      contactId: "contact-1",
      contactUsername: "fulano",
      eventText: "quero",
      actions: [
        {
          at: "2026-08-01T11:20:01.000Z",
          subtype: "comment_reply",
          outcome: "ok",
        },
        {
          at: "2026-08-01T11:20:02.000Z",
          subtype: "message_sent",
          outcome: "ok",
        },
        {
          // A step the run reached and deliberately did not perform (REQ-068).
          // The verdict says THAT it fired nothing; the code says why, and the
          // screen is where that code becomes a sentence (REQ-163).
          at: "2026-08-01T11:20:03.000Z",
          subtype: "message_sent",
          outcome: "suppressed",
          reason: "email_already_known",
        },
      ],
    },
    {
      eventId: "evt-failed",
      at: "2026-08-01T11:10:00.000Z",
      subtype: "direct_message",
      outcome: "ok",
      contactId: "contact-2",
      // A direct message brings no public identifier (REQ-162), and the
      // interaction carried no words at all: a sticker, or a button.
      eventText: "",
      actions: [
        {
          at: "2026-08-01T11:10:01.000Z",
          subtype: "message_sent",
          outcome: "failed",
        },
      ],
    },
    {
      eventId: "evt-silent",
      at: "2026-08-01T11:00:00.000Z",
      subtype: "comment",
      outcome: "suppressed",
      contactId: "contact-3",
      contactUsername: "cicrano",
      eventText: "oi",
      actions: [],
      silence: {
        code: "no_match",
        refusals: [
          { reason: "no_keyword", count: 3 },
          { reason: "disabled", count: 1 },
        ],
      },
    },
    {
      eventId: "evt-bare",
      at: "2026-08-01T10:50:00.000Z",
      subtype: "comment",
      outcome: "duplicate",
      actions: [],
    },
  ],
  // Far more than the four sent: the cap was applied, and the screen has to be
  // able to say so in figures rather than fade the list out.
  total: 137,
  limit: 50,
};

/** The finest range: hourly buckets, a queue with work in it, a cap at 90. */
const HOURLY: DashboardMetricsView = {
  window: {
    range: "last_24_hours",
    granularity: "hour",
    since: "2026-07-31T12:30:00.000Z",
    until: "2026-08-01T12:30:00.000Z",
    zone: EPOCH_ZONE,
  },
  events: {
    granularity: "hour",
    buckets: HOUR_BUCKETS,
    series: [
      { subtype: "comment", total: 5, counts: [1, 3, 1] },
      { subtype: "direct_message", total: 3, counts: [0, 1, 2] },
    ],
    unknown: { subtype: "unknown", total: 4, counts: [1, 2, 1] },
    // 5 + 3 + 4: the named types AND the group kept apart from them.
    total: 12,
  },
  actions: {
    granularity: "hour",
    buckets: HOUR_BUCKETS,
    series: [
      { subtype: "comment_reply", total: 4, counts: [1, 2, 1] },
      { subtype: "message_sent", total: 7, counts: [2, 3, 2] },
    ],
    unknown: { subtype: "unknown", total: 0, counts: [0, 0, 0] },
    total: 11,
  },
  caps: [
    {
      cap: "private_replies_per_hour",
      window: "hour",
      used: 90,
      limit: 100,
      usedPct: 90,
      status: "critical",
    },
    {
      cap: "calls_per_second",
      window: "second",
      used: 0,
      limit: 60,
      usedPct: 0,
      status: "normal",
    },
    {
      cap: "media_calls_per_second",
      window: "second",
      used: 2,
      limit: 5,
      usedPct: 40,
      status: "normal",
    },
  ],
  failures: { errors: 1234, rateLimited: 27 },
  queue: { pending: 4, oldestPendingAt: "2026-08-01T08:15:00.000Z" },
  links: {
    totals: {
      clicks: 42,
      uniqueContacts: 31,
      automations: 3,
      publications: 2,
    },
    trend: {
      granularity: "hour",
      buckets: HOUR_BUCKETS,
      counts: [1, 7, 18, 16],
      total: 42,
    },
    posts: [
      {
        publicationId: "post-1",
        publication: {
          id: "post-1",
          caption: "The guide you asked for",
          thumbnailKey: "thumbs/post-1.jpg",
        },
        comments: 18,
        commentDetails: [
          { text: "I want the guide", matchedKeyword: "guide" },
          { text: "Can you send it?" },
        ],
        publicReplies: 12,
        acceptedMessages: 10,
        clicks: 9,
        uniqueContacts: 8,
        links: [
          { label: "Open guide", clicks: 7, uniqueContacts: 6 },
          { clicks: 2, uniqueContacts: 2 },
        ],
      },
    ],
    unattributedClicks: 2,
    buttons: [
      {
        automationId: "automation-1",
        buttonId: "learn-more",
        destinationVersion: 2,
        clicks: 9,
        uniqueContacts: 8,
      },
    ],
  },
  activity: ACTIVITY,
};

/** A wider range: daily buckets, a cap merely close to its ceiling, no queue. */
const DAILY: DashboardMetricsView = {
  window: {
    range: "last_7_days",
    granularity: "day",
    since: "2026-07-25T12:30:00.000Z",
    until: "2026-08-01T12:30:00.000Z",
    zone: EPOCH_ZONE,
  },
  events: {
    granularity: "day",
    buckets: DAY_BUCKETS,
    series: [
      { subtype: "comment", total: 9, counts: [2, 3, 1, 3] },
      { subtype: "direct_message", total: 4, counts: [1, 0, 2, 1] },
    ],
    unknown: { subtype: "unknown", total: 2, counts: [1, 0, 1, 0] },
    total: 15,
  },
  actions: {
    granularity: "day",
    buckets: DAY_BUCKETS,
    series: [
      { subtype: "comment_reply", total: 6, counts: [1, 2, 1, 2] },
      { subtype: "message_sent", total: 8, counts: [2, 2, 2, 2] },
    ],
    unknown: { subtype: "unknown", total: 0, counts: [0, 0, 0, 0] },
    total: 14,
  },
  caps: [
    {
      cap: "private_replies_per_hour",
      window: "hour",
      used: 80,
      limit: 100,
      usedPct: 80,
      status: "attention",
    },
    {
      cap: "calls_per_second",
      window: "second",
      used: 0,
      limit: 60,
      usedPct: 0,
      status: "normal",
    },
    {
      cap: "media_calls_per_second",
      window: "second",
      used: 0,
      limit: 5,
      usedPct: 0,
      status: "normal",
    },
  ],
  failures: { errors: 0, rateLimited: 0 },
  queue: { pending: 0 },
  // Everything the window holds, so nothing is cut and no note says it was.
  activity: { items: ACTIVITY.items.slice(0, 1), total: 1, limit: 50 },
};

/** The three bands at once, which no single real range is guaranteed to show. */
const BANDS: DashboardMetricsView = {
  ...HOURLY,
  caps: [
    {
      cap: "private_replies_per_hour",
      window: "hour",
      used: 12,
      limit: 100,
      usedPct: 12,
      status: "normal",
    },
    {
      cap: "calls_per_second",
      window: "second",
      used: 48,
      limit: 60,
      usedPct: 80,
      status: "attention",
    },
    {
      cap: "media_calls_per_second",
      window: "second",
      used: 5,
      limit: 5,
      usedPct: 100,
      status: "critical",
    },
  ],
};

const BY_RANGE: Readonly<Record<DashboardRange, DashboardMetricsView>> = {
  last_24_hours: HOURLY,
  last_7_days: DAILY,
  last_30_days: DAILY,
};

/** The API, as the screen sees it: it answers, and remembers what it was asked. */
function createClientDouble(): DashboardClient & {
  readonly reads: DashboardRange[];
} {
  const double = {
    reads: [] as DashboardRange[],

    read: (range: DashboardRange): Promise<DashboardMetricsView> => {
      double.reads.push(range);
      return Promise.resolve(BY_RANGE[range]);
    },
  };

  return double;
}

/** A client that always answers the same thing, for a shaped fixture. */
function answering(metrics: DashboardMetricsView): DashboardClient {
  return {
    read: (): Promise<DashboardMetricsView> => Promise.resolve(metrics),
  };
}

function mount(client: DashboardClient): ReactElement {
  return (
    <LocaleProvider client={localeClient} catalogues={catalogues}>
      <DashboardScreen client={client} />
    </LocaleProvider>
  );
}

/** A block, found by the heading that names it. */
function region(name: string): HTMLElement {
  return screen.getByRole("region", { name });
}

/** The value beside a labelled figure. */
function figure(scope: HTMLElement, label: string): string {
  return within(scope).getByText(label).nextElementSibling?.textContent ?? "";
}

function textOf(cells: readonly HTMLElement[]): string[] {
  return cells.map((cell) => cell.textContent ?? "");
}

/** One ceiling's row, whichever shape it took. */
function capRow(label: string): HTMLElement {
  const rows = within(region(copy.capsTitle)).getAllByRole("listitem");
  const found = rows.find((row) => row.textContent?.includes(label));

  if (found === undefined) {
    throw new Error(`no cap row for ${label}`);
  }

  return found;
}

function usage(used: number, limit: number, percent: number): string {
  return text(words.cap.usage, { used, limit, percent });
}

async function show(client: DashboardClient): Promise<void> {
  render(mount(client));
  // The band, because it is the first block with a datum and the only one that
  // is on screen in every state the answer can put the page in. Waiting on a
  // counting table would be waiting on something the page deliberately does not
  // open with any more (REQ-180).
  await screen.findByRole("region", { name: copy.summaryTitle });
}

/** The control the page names for the granular reading (REQ-180). */
function detailControl(): HTMLElement {
  return screen.getByRole("button", {
    name:
      screen.queryByRole("region", { name: copy.eventsTitle }) === null
        ? copy.detailShow
        : copy.detailHide,
  });
}

/**
 * Opens the granular reading, the way an operator does.
 *
 * Every case below that reads a counting table goes through this, and that is
 * the point rather than a chore: the tables are the same tables they always
 * were, and the one thing that changed is that reaching them is now an act.
 */
async function openDetail(): Promise<void> {
  await userEvent.click(screen.getByRole("button", { name: copy.detailShow }));
  await screen.findByRole("region", { name: copy.eventsTitle });
}

/** Opens the page at the finest range with the granular reading unfolded. */
async function showDetailed(): Promise<
  DashboardClient & { readonly reads: DashboardRange[] }
> {
  const client = await showHourly();
  await openDetail();

  return client;
}

async function showHourly(): Promise<
  DashboardClient & { readonly reads: DashboardRange[] }
> {
  const client = createClientDouble();
  await show(client);

  return client;
}

/** Moves to the wider range and waits for the redraw. */
async function chooseSevenDays(): Promise<void> {
  await userEvent.click(
    screen.getByRole("button", { name: words.range.last7Days }),
  );
  await screen.findAllByText(copy.granularity.day);
}

/** Every block on the page, named by its own heading, in document order. */
function regionNames(): readonly string[] {
  return screen
    .getAllByRole("region")
    .map((block) => within(block).getByRole("heading").textContent ?? "");
}

describe("REQ-115: one block per nature of information", () => {
  it("gives each nature its own named region", async () => {
    await showHourly();

    // The figures of the period, consumption against a ceiling, the shape over
    // time and the event by event reading are four different questions. Each
    // one is a region with its own heading, which is what lets an operator jump
    // between them instead of scrolling one undifferentiated stack.
    expect(regionNames()).toEqual([
      // First, and the position is the requirement rather than a taste
      // (REQ-177): it is the block that answers "is it working?".
      copy.summaryTitle,
      // Second, and the position is the requirement again (REQ-178): it is what
      // an operator looks for in a hurry when something is going wrong in
      // public, and it used to sit at the foot of the page.
      copy.capsTitle,
      copy.volumeTitle,
      // Last, and the position is a decision: it is the only block whose height
      // is the traffic's rather than the layout's, so anything under it would
      // sit past fifty rows of scrolling.
      words.activity.title,
    ]);
  });

  it("gives the counting blocks a region each, once they are opened", async () => {
    await showDetailed();

    // The fifth question is counting over time, and it is one block per nature
    // exactly as before (REQ-180): what changed is that the page no longer
    // OPENS with them, not that they stopped being blocks of their own.
    expect(regionNames()).toEqual([
      copy.summaryTitle,
      copy.capsTitle,
      copy.volumeTitle,
      copy.eventsTitle,
      copy.actionsTitle,
      words.activity.title,
    ]);
  });
});

/* ------------------------------------------------------------------ *
 * REQ-177 and REQ-181: the band of figures, and the label that does not lie
 * ------------------------------------------------------------------ */

/** The band's own region, which is the first thing on the page with a datum. */
function band(): HTMLElement {
  return region(copy.summaryTitle);
}

/** Every word the band writes under a number, in the order they are drawn. */
function bandLabels(): readonly string[] {
  return [...band().querySelectorAll("dt")].map(
    (term) => term.textContent ?? "",
  );
}

/**
 * The band that answers "is it working?" (REQ-177).
 *
 * Three things this block pins down, and each of them is a way the band could
 * still render while answering the wrong question:
 *
 *   - it stands ABOVE everything with a datum in it. A band under the first
 *     chart is a band an operator reaches by scrolling, and the panel is opened
 *     precisely when there is no time to scroll;
 *   - every figure in it is the answer's, and the accepted count is the MESSAGE
 *     series rather than the action total, which also counts comment replies,
 *     attributes set and pauses started;
 *   - it carries everything the two blocks it replaces carried, the
 *     too-many-requests count and the queue's oldest instant included. A
 *     reorganisation that dropped a figure would be a loss dressed as a tidy-up.
 */
describe("REQ-177: the panel opens with the numbers of the period", () => {
  it("stands above every table and every drawing on the page", async () => {
    await showDetailed();

    const opening = band();
    const withData = [
      ...screen.getAllByRole("table"),
      ...screen.getAllByRole("img"),
    ];

    // Guards the guard: a page that had drawn no table and no chart would pass
    // the sweep below having compared the band against nothing. Two tables and
    // the one drawing the panel now carries (REQ-179).
    expect(withData.length).toBeGreaterThanOrEqual(3);

    for (const later of withData) {
      // Document order, which is both the reading order and the order a screen
      // reader walks. The band moved under any one of these still renders every
      // figure, and answers the question only to whoever went looking for it.
      expect(
        opening.compareDocumentPosition(later) &
          Node.DOCUMENT_POSITION_FOLLOWING,
        `${copy.summaryTitle} should precede ${later.textContent ?? ""}`,
      ).toBeTruthy();
    }
  });

  it("answers with the figures the aggregation already decided", async () => {
    await showHourly();

    // Accepted for sending is the MESSAGE count: the window recorded 11
    // actions, 4 of them comment replies, and a headline of 11 messages would
    // be counting replies as messages.
    expect(figure(band(), words.action.messageSent)).toBe("7");
    // Received is every entry of the window, the deliveries with no readable
    // type included, which is what "how much arrived" means.
    expect(figure(band(), copy.eventsTitle)).toBe("12");
    expect(figure(band(), words.failures.errors)).toBe("1,234");
    expect(figure(band(), words.queue.pending)).toBe("4");
  });

  it("keeps throttling and queue timing beside the six headline figures", async () => {
    await showHourly();

    // Nothing was dropped in the move: the throttling count, which is the one
    // figure that says to slow down rather than to hunt a fault, and the
    // instant the oldest queued item has been waiting since.
    expect(band()).toHaveTextContent(text(copy.rateLimitedNote, { count: 27 }));
    expect(
      within(band()).getByText(words.queue.oldest.split("{{")[0] as string, {
        exact: false,
      }),
    ).toBeInTheDocument();
  });

  it("shows a zero for a type the period recorded nothing of", async () => {
    await show(
      answering({
        ...HOURLY,
        actions: {
          granularity: "hour",
          buckets: HOUR_BUCKETS,
          series: [{ subtype: "comment_reply", total: 4, counts: [1, 2, 1] }],
          unknown: { subtype: "unknown", total: 0, counts: [0, 0, 0] },
          total: 4,
        },
      }),
    );

    // The aggregation reports what happened rather than a row of zeros, so a
    // window with no message has no series at all. "No message went out" is an
    // answer and a blank space is not.
    expect(figure(band(), words.action.messageSent)).toBe("0");
  });
});

/**
 * REQ-181: no headline figure claims a delivery.
 *
 * The trail writes the `ok` row of a `message_sent` when the step ENQUEUES the
 * message; the platform delivers it later, in the sweep, and a delivery that
 * then fails adds its own `failed` row without being subtracted from the count.
 * So "sent" beside that number is the screen stating something the record never
 * said, and a big number is read without the note under it being read at all,
 * which is why this is a requirement about the LABEL and not about a caveat.
 */
describe("REQ-181: no headline number claims a delivery", () => {
  it("names the enqueued count accepted for sending, in both languages", () => {
    const shipped = [
      ["en", en.dashboard.action.messageSent],
      ["pt-BR", ptBR.dashboard.action.messageSent],
    ] as const;

    for (const [locale, label] of shipped) {
      expect(label.toLowerCase(), locale).toMatch(/accepted|aceitas/);
      // The words a delivery would be claimed in, in each language. The
      // sentence in force says "accepted for sending" and "aceitas para
      // envio", and neither of those trips this.
      expect(label.toLowerCase(), locale).not.toMatch(
        /\bsent\b|\bdelivered\b|enviad|entregue/,
      );
    }
  });

  it("puts no word of delivery under any number of the band", async () => {
    await showHourly();

    // The whole band and not only the message figure: the requirement is about
    // every big number on this page, and the next figure added beside these is
    // exactly the one nobody would remember to check.
    expect(bandLabels()).toContain(words.action.messageSent);
    expect(
      bandLabels().filter((label) => /\bsent\b|\bdelivered\b/i.test(label)),
    ).toEqual([]);
  });

  it("stands the error count in the band, beside the number it corrects", async () => {
    await showHourly();

    // In the same region and in the same list, not in a footnote: the accepted
    // count only goes up, and the period's failures are the other half of that
    // story. Read apart, "7 accepted" is seven messages an operator believes
    // went out.
    expect(bandLabels()).toContain(words.failures.errors);
    expect(figure(band(), words.failures.errors)).toBe("1,234");
  });
});

describe("criterion 37: counts by type and by bucket match the record", () => {
  it("puts each type in its own column and each bucket in its own row", async () => {
    await showDetailed();

    const table = within(region(copy.eventsTitle)).getByRole("table");
    const rows = within(table).getAllByRole("row");

    // The header, three hourly buckets, and the totals line.
    expect(rows).toHaveLength(5);

    expect(
      textOf(within(rows[0] as HTMLElement).getAllByRole("columnheader")),
    ).toEqual([
      copy.columnPeriod,
      words.event.comment,
      words.event.directMessage,
    ]);

    // The middle bucket, exactly as the aggregation counted it: 3 comments and
    // 1 direct message in the 10:00 hour.
    expect(textOf(within(rows[2] as HTMLElement).getAllByRole("cell"))).toEqual(
      ["3", "1"],
    );

    expect(textOf(within(rows[4] as HTMLElement).getAllByRole("cell"))).toEqual(
      ["5", "3"],
    );
  });

  it("labels every bucket, and never two of them the same", async () => {
    await showDetailed();

    const table = within(region(copy.eventsTitle)).getByRole("table");
    const headers = textOf(within(table).getAllByRole("rowheader"));

    // Three buckets plus the totals line, all named, none repeated: a chart
    // with two columns called the same thing hides one of them.
    expect(headers).toHaveLength(4);
    expect(new Set(headers).size).toBe(headers.length);
    expect(headers.every((header) => header.trim() !== "")).toBe(true);
  });

  it("stays a table, and gains the bar inside the cell instead of replacing it", async () => {
    await showDetailed();

    const table = within(region(copy.eventsTitle)).getByRole("table");

    // The registered request is for a visual reading to be ADDED. So every
    // figure is still a cell a screen reader reaches by row and column, and the
    // proportional bar beside it is hidden, because it says nothing the figure
    // does not already say.
    expect(within(table).getAllByRole("cell")).not.toHaveLength(0);
    for (const hidden of table.querySelectorAll("[aria-hidden='true']")) {
      expect(hidden.textContent).toBe("");
    }
  });
});

describe("criterion 38: replies and messages are counted apart", () => {
  it("gives each action type its own column and its own total", async () => {
    await showDetailed();

    const table = within(region(copy.actionsTitle)).getByRole("table");
    const rows = within(table).getAllByRole("row");

    expect(
      textOf(within(rows[0] as HTMLElement).getAllByRole("columnheader")),
    ).toEqual([
      copy.columnPeriod,
      words.action.commentReply,
      words.action.messageSent,
    ]);

    expect(textOf(within(rows[4] as HTMLElement).getAllByRole("cell"))).toEqual(
      ["4", "7"],
    );
  });

  it("says the messages were accepted for sending, inside the table itself", async () => {
    await showDetailed();

    const actions = region(copy.actionsTitle);
    const note = within(actions).getByText(words.acceptedNote);

    // Not a footnote at the bottom of the page, and not even a paragraph under
    // the block: the note is the table's caption, so it is announced with the
    // table and ahead of the figures it qualifies. Without it, "7 messages"
    // reads as seven deliveries confirmed.
    expect(within(actions).getByRole("table")).toContainElement(note);
  });

  it("keeps the note in the block even when there is no table to caption", async () => {
    await show(
      answering({
        ...HOURLY,
        actions: {
          granularity: "hour",
          buckets: HOUR_BUCKETS,
          series: [],
          unknown: { subtype: "unknown", total: 0, counts: [0, 0, 0] },
          total: 0,
        },
      }),
    );
    await openDetail();

    // The caption has nowhere to live when the period recorded nothing, and the
    // caveat still belongs to the block: "Entries recorded: 0" is an accepted
    // for sending count too.
    expect(
      within(region(copy.actionsTitle)).getByText(words.acceptedNote),
    ).toBeInTheDocument();
  });
});

describe("REQ-106: the group with no type is reported, and reported apart", () => {
  it("keeps it out of the columns and names it for what it is", async () => {
    await showDetailed();

    const events = region(copy.eventsTitle);

    // "Deliveries", because a webhook row is one accepted body that may carry a
    // comment and a message at once. As a column it would stand as tall as the
    // traffic it is made of.
    expect(figure(events, words.event.unknown)).toBe("4");
    expect(figure(events, copy.recorded)).toBe("12");

    const columns = textOf(
      within(within(events).getByRole("table")).getAllByRole("columnheader"),
    );
    expect(columns).not.toContain(words.event.unknown);
    // The period and the two named types, and nothing else: a fourth column
    // here is the group drawn as a series, which is the one shape that makes
    // the same deliveries appear twice on one screen.
    expect(columns).toHaveLength(3);
  });

  it("adds up: the columns plus the group are the recorded total", async () => {
    await showDetailed();

    const events = region(copy.eventsTitle);
    const table = within(events).getByRole("table");
    const rows = within(table).getAllByRole("row");
    const totals = textOf(
      within(rows[rows.length - 1] as HTMLElement).getAllByRole("cell"),
    ).map(Number);

    const group = Number(figure(events, words.event.unknown));
    const recorded = Number(figure(events, copy.recorded));

    // Read off the screen and summed here, which is what an operator does when
    // they ask "does this match the record". A group folded into the series
    // would be counted on both sides of this equation.
    expect(totals.reduce((sum, value) => sum + value, 0) + group).toBe(
      recorded,
    );
    expect(recorded).toBe(12);
  });

  it("names the actions group by the word the actions catalogue uses", async () => {
    await showDetailed();

    expect(figure(region(copy.actionsTitle), words.action.unknown)).toBe("0");
  });
});

describe("criterion 39: the cap indicator signals when the threshold is passed", () => {
  it("writes the status in words, so colour is never the only carrier", async () => {
    await showHourly();

    const hourly = capRow(words.cap.privateRepliesPerHour);

    expect(hourly).toHaveTextContent(usage(90, 100, 90));
    // The word, from the catalogue, next to the tint: this is what an operator
    // who cannot tell the three tints apart reads.
    expect(hourly).toHaveTextContent(words.capStatus.critical);
    expect(hourly).toHaveAttribute("data-status", "critical");
  });

  it("shows the normal indicator for a cap below the threshold", async () => {
    await showHourly();

    const perSecond = capRow(words.cap.callsPerSecond);

    expect(perSecond).toHaveTextContent(usage(0, 60, 0));
    expect(perSecond).toHaveTextContent(words.capStatus.normal);
    expect(perSecond).toHaveAttribute("data-status", "normal");
  });

  it("signals the middle step too, without recomputing the percentage", async () => {
    await showHourly();
    await chooseSevenDays();

    const hourly = capRow(words.cap.privateRepliesPerHour);

    // 80 of 100 is the same arithmetic as any other 80 percent; what makes it
    // "close to the cap" is the configured threshold, which was applied by the
    // aggregation and is read here from the field it wrote.
    expect(hourly).toHaveTextContent(usage(80, 100, 80));
    expect(hourly).toHaveTextContent(words.capStatus.attention);
    expect(hourly).toHaveAttribute("data-status", "attention");
  });

  it("tells the three bands apart, each carried by its own word", async () => {
    await show(answering(BANDS));

    const bands = [
      [words.cap.privateRepliesPerHour, "normal", words.capStatus.normal],
      [words.cap.callsPerSecond, "attention", words.capStatus.attention],
      [words.cap.mediaCallsPerSecond, "critical", words.capStatus.critical],
    ] as const;

    // Three rows, three attributes, three different sentences. The tint differs
    // too, and that is exactly why it may never be the only difference: an
    // operator who cannot tell the three apart by colour reads three words
    // (REQ-038, REQ-115).
    for (const [name, status, word] of bands) {
      const row = capRow(name);

      expect(row).toHaveAttribute("data-status", status);
      expect(row).toHaveTextContent(word);
    }

    expect(new Set(bands.map(([, , word]) => word)).size).toBe(3);
  });

  it("draws the meter only for the cap whose window is an hour", async () => {
    await showHourly();

    const caps = region(copy.capsTitle);
    const meters = within(caps).getAllByRole("meter");

    // The two per-second caps measure the second in progress and read zero
    // almost every time the page opens. A bar frozen at zero reads as a broken
    // widget, so they are text, with a sentence saying which second they mean.
    expect(meters).toHaveLength(1);
    expect(capRow(words.cap.privateRepliesPerHour)).toContainElement(
      meters[0] as HTMLElement,
    );
    expect(meters[0]).toHaveAttribute("aria-valuenow", "90");
    expect(meters[0]).toHaveAttribute("aria-valuemax", "100");

    expect(
      within(capRow(words.cap.callsPerSecond)).queryByRole("meter"),
    ).toBeNull();
    expect(
      within(capRow(words.cap.mediaCallsPerSecond)).queryByRole("meter"),
    ).toBeNull();

    expect(within(caps).getByText(copy.capSecondNote)).toBeInTheDocument();
  });
});

describe("criterion 40: errors and refusals appear and match the record", () => {
  it("shows errors and keeps the throttling count named beside them", async () => {
    await showHourly();

    // In the band, which is where the count that CORRECTS the accepted figure
    // has to stand (REQ-181), and where the two stay apart: merged into one
    // number a throttled account would be invisible inside the failure total.
    const failures = region(copy.summaryTitle);

    // Grouped by the locale, not printed raw: 1234 on a panel is a number an
    // operator has to count the digits of.
    expect(figure(failures, words.failures.errors)).toBe("1,234");
    expect(failures).toHaveTextContent(
      text(copy.rateLimitedNote, { count: 27 }),
    );
  });
});

describe("criterion 41: the queue, with work in it and at rest", () => {
  it("shows how much is waiting and since when", async () => {
    await showHourly();

    const queue = region(copy.summaryTitle);

    expect(figure(queue, words.queue.pending)).toBe("4");
    expect(
      within(queue).getByText(words.queue.oldest.split("{{")[0] as string, {
        exact: false,
      }),
    ).toBeInTheDocument();
  });

  it("shows the zero and says it is at rest, and raises no alert", async () => {
    await showHourly();
    await chooseSevenDays();

    const queue = region(copy.summaryTitle);

    expect(figure(queue, words.queue.pending)).toBe("0");
    expect(queue).toHaveTextContent(words.queue.empty);
    // Nothing pending is a queue at rest. A panel that alerted about it would
    // teach the operator to ignore the place real alerts appear.
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("criterion 42: changing the range changes the granularity", () => {
  it("asks the API for the chosen range and redraws at its granularity", async () => {
    const client = await showDetailed();

    expect(client.reads).toEqual(["last_24_hours"]);
    // One marker per block whose columns ARE the buckets: the drawing and the
    // two tables. The granularity belongs beside what it cut.
    expect(screen.getAllByText(copy.granularity.hour)).toHaveLength(3);

    await userEvent.click(
      screen.getByRole("button", { name: words.range.last7Days }),
    );

    await waitFor(() => {
      expect(client.reads).toEqual(["last_24_hours", "last_7_days"]);
    });

    await screen.findAllByText(copy.granularity.day);
    expect(screen.queryByText(copy.granularity.hour)).toBeNull();

    const events = region(copy.eventsTitle);
    const rows = within(within(events).getByRole("table")).getAllByRole("row");

    // Four daily buckets where there were three hourly ones, and the totals
    // that go with them: 9 + 4 + 2 recorded.
    expect(rows).toHaveLength(6);
    expect(textOf(within(rows[5] as HTMLElement).getAllByRole("cell"))).toEqual(
      ["9", "4"],
    );
    expect(figure(events, words.event.unknown)).toBe("2");
    expect(figure(events, copy.recorded)).toBe("15");

    expect(
      screen.getByRole("button", { name: words.range.last7Days }),
    ).toHaveAttribute("aria-current", "true");
  });

  it("offers the three ranges the API accepts, in one labelled group", async () => {
    await showHourly();

    const group = screen.getByRole("group", { name: copy.rangeLegend });

    expect(textOf(within(group).getAllByRole("button"))).toEqual([
      words.range.last24Hours,
      words.range.last7Days,
      words.range.last30Days,
    ]);
  });
});

describe("REQ-383 to REQ-385: insight destinations and operational overview", () => {
  it("switches among real destinations without changing the selected range", async () => {
    const client = await showHourly();
    const navigation = screen.getByRole("navigation", {
      name: copy.views.label,
    });

    expect(
      within(navigation).getByRole("button", { name: copy.views.overview }),
    ).toHaveAttribute("aria-current", "page");
    expect(figure(band(), copy.interactionsHandled)).toBe("11");
    expect(figure(band(), copy.linkClicks)).toBe("42");

    await userEvent.click(
      within(navigation).getByRole("button", { name: copy.views.links }),
    );

    const links = region(copy.linksTitle);
    expect(figure(links, copy.linkClicks)).toBe("42");
    expect(figure(links, copy.uniqueContacts)).toBe("31");
    expect(
      within(navigation).getByRole("button", { name: copy.views.links }),
    ).toHaveAttribute("aria-current", "page");

    await userEvent.click(
      within(navigation).getByRole("button", { name: copy.views.activity }),
    );
    await screen.findByRole("region", { name: words.activity.title });
    expect(client.reads).toEqual(["last_24_hours"]);
  });

  it("takes the overview activity path to the complete activity destination", async () => {
    await showHourly();

    await userEvent.click(
      screen.getByRole("button", { name: copy.viewAllActivity }),
    );

    expect(
      screen.getByRole("button", { name: copy.views.activity }),
    ).toHaveAttribute("aria-current", "page");
    expect(
      screen.getByRole("region", { name: words.activity.title }),
    ).toBeVisible();
  });
});

describe("REQ-405 to REQ-408: the Links destination", () => {
  it("groups engagement by post and opens only its immutable historical details", async () => {
    await showHourly();

    await userEvent.click(
      screen.getByRole("button", { name: copy.views.links }),
    );

    const links = region(copy.linksTitle);
    expect(figure(links, copy.linkClicks)).toBe("42");
    expect(
      screen.getByRole("region", { name: copy.linkTrendTitle }),
    ).toBeInTheDocument();
    expect(screen.getByText("The guide you asked for")).toBeInTheDocument();
    expect(screen.getByText(copy.linkCommentsLabel)).toBeInTheDocument();
    const postFunnel = screen.getByLabelText(
      text(copy.linkPostFunnel, { id: "post-1" }),
    );
    expect(within(postFunnel).getByText("18")).toBeInTheDocument();
    expect(within(postFunnel).getByText("9")).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: copy.linkUnattributedTitle }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(text(copy.linkUnattributedCount, { count: 2 })),
    ).toBeInTheDocument();
    expect(screen.getByText(copy.linkUnattributedHint)).toBeInTheDocument();
    expect(screen.queryByText("automation-1")).toBeNull();

    await userEvent.click(
      screen.getByRole("button", { name: copy.linkViewDetails }),
    );

    expect(
      screen.getByRole("dialog", { name: copy.linkDetailsTitle }),
    ).toHaveTextContent("I want the guide");
    expect(screen.getByText("Keyword: guide")).toBeInTheDocument();
    expect(screen.getByText("Open guide")).toBeInTheDocument();
    expect(screen.getByText(copy.linkHistoricalLabel)).toBeInTheDocument();
  });
});

/**
 * Historic clicks remain useful facts even before the execution trail carried
 * a publication snapshot. They are deliberately named as unattributed instead
 * of being attached to the automation currently configured, which would be a
 * reconstruction and not history.
 */
describe("REQ-411: historic clicks without a publication are explicit", () => {
  it("keeps the total visible in a named historic state without inventing a post", async () => {
    await show(
      answering({
        ...HOURLY,
        links: {
          ...HOURLY.links!,
          totals: {
            ...HOURLY.links!.totals,
            publications: 0,
          },
          posts: [],
          unattributedClicks: 2,
        },
      }),
    );

    await userEvent.click(
      screen.getByRole("button", { name: copy.views.links }),
    );

    const historic = screen.getByRole("complementary", {
      name: copy.linkUnattributedTitle,
    });
    expect(historic).toHaveTextContent(
      text(copy.linkUnattributedCount, { count: 2 }),
    );
    expect(historic).toHaveTextContent(copy.linkUnattributedHint);
    expect(screen.queryByText(copy.linkPostsEmpty)).toBeNull();
    expect(screen.queryByLabelText(/Post post-/)).toBeNull();
  });
});

/**
 * The revised Insights journey is deliberately proven as one path too.  The
 * individual tests above pin each presentation decision in place; this test
 * guards the boundary between them, where a later refactor could keep every
 * isolated component while putting a technical row back in the ordinary feed,
 * dropping the chart's visible scale, or making post history depend on the
 * automation that happened to produce it.
 */
describe("REQ-402 to REQ-408: the revised Insights journey", () => {
  it("keeps the compact operational reading separate from technical records and attributes history to its post", async () => {
    const numericContact: ActivityEventView = {
      eventId: "evt-platform-contact-journey",
      at: "2026-08-01T10:44:00.000Z",
      subtype: "direct_message",
      outcome: "ok",
      contactId: "701804635348805",
      eventText: "quero saber mais",
      actions: [],
    };
    const firedWithClick: ActivityEventView = {
      ...ACTIVITY.items[0]!,
      actions: [
        ...ACTIVITY.items[0]!.actions,
        {
          at: "2026-08-01T11:20:04.000Z",
          subtype: "link_clicked",
          outcome: "ok",
        },
      ],
    };

    await show(
      answering({
        ...HOURLY,
        activity: {
          items: [firedWithClick, ...ACTIVITY.items.slice(1), numericContact],
          total: 138,
          limit: 50,
        },
      }),
    );

    // Quantities, axes and reference scale belong to the chart itself. A
    // pointer-only tooltip would leave this path unable to answer its first
    // question, "how much happened?".
    const volume = screen.getByRole("img", { name: copy.volumeChart });
    expect(volume.querySelector(".mc-trend__axis-title--x")).toHaveTextContent(
      copy.chartXAxis,
    );
    expect(volume.querySelector(".mc-trend__axis-title--y")).toHaveTextContent(
      copy.chartYAxis,
    );
    expect(
      [...volume.querySelectorAll<HTMLElement>(".mc-trend__value")].map(
        (value) => value.textContent,
      ),
    ).toContain("3");
    expect(
      [...volume.querySelectorAll<HTMLElement>(".mc-trend__scale span")].map(
        (value) => value.textContent,
      ),
    ).toContain("0");

    const navigation = screen.getByRole("navigation", {
      name: copy.views.label,
    });
    await userEvent.click(
      within(navigation).getByRole("button", { name: copy.views.activity }),
    );

    const activity = region(words.activity.title);
    const fired = activityLine("evt-fired");

    // The compact, two-line mobile unit says what happened in short words, and
    // its legend carries the important non-delivery meaning of the queued DM.
    expect(fired).toHaveTextContent(words.activity.chip.commented);
    expect(fired).toHaveTextContent(words.activity.chip.commentReply);
    expect(fired).toHaveTextContent(words.activity.chip.messageAccepted);
    expect(fired).toHaveTextContent(words.activity.chip.clicked);
    const legend = activity.querySelector(".mc-activity__legend");
    expect(legend).toHaveTextContent(words.activity.chip.commented);
    expect(legend).toHaveTextContent(words.activity.chip.commentReply);
    expect(legend).toHaveTextContent(words.activity.chip.messageAccepted);
    expect(legend).toHaveTextContent(words.activity.chip.clicked);
    expect(legend).toHaveTextContent(words.activity.legend.messageAccepted);
    expect(
      activity.querySelector('[data-event-id="evt-platform-contact-journey"]'),
    ).toBeNull();
    expect(activity.querySelector('[data-event-id="evt-silent"]')).toBeNull();

    await openDiagnostics(2);
    expect(
      activity.querySelector('[data-event-id="evt-platform-contact-journey"]'),
    ).not.toBeNull();
    expect(
      activity.querySelector('[data-event-id="evt-silent"]'),
    ).not.toBeNull();

    await userEvent.click(
      within(navigation).getByRole("button", { name: copy.views.links }),
    );

    // The post is the attribution key. The API fixture still includes a legacy
    // automation dimension, but it must not turn into a reporting grouping.
    expect(screen.getByText("The guide you asked for")).toBeInTheDocument();
    expect(screen.queryByText("automation-1")).toBeNull();

    await userEvent.click(
      screen.getByRole("button", { name: copy.linkViewDetails }),
    );

    const details = screen.getByRole("dialog", {
      name: copy.linkDetailsTitle,
    });
    expect(details).toHaveTextContent("I want the guide");
    expect(details).toHaveTextContent("Keyword: guide");
    expect(details).toHaveTextContent("Open guide");
    expect(details).toHaveTextContent(copy.linkHistoricalLabel);
  });
});

describe("REQ-409 and REQ-410: the compact reading stays visually distinct", () => {
  it("keeps action chips on one internal line, protects their legend tones and bounds each trend series", () => {
    const sheet = styleSheet("components.css");
    const chips = blockAfter(sheet, ".mc-activity__chips .mc-chip {");
    const chipLabel = blockAfter(sheet, ".mc-chip__label {");
    const legendChips = blockAfter(sheet, ".mc-activity__legend .mc-chip {");
    const legendDescription = blockAfter(
      sheet,
      ".mc-activity__legend-description {",
    );
    const track = blockAfter(sheet, ".mc-trend__track {");

    expect(chips).toContain("flex-wrap: nowrap");
    expect(chips).toContain("white-space: nowrap");
    expect(chipLabel).toContain("display: inline-flex");
    expect(chipLabel).toContain("align-items: center");
    expect(legendChips).toContain("min-inline-size: max-content");
    expect(legendChips).toContain("font-size: var(--text-xs)");
    expect(legendDescription).toContain("color: var(--fg-3)");
    expect(sheet).not.toContain(".mc-activity__legend-list > li > span {");
    expect(track).toContain("border: 1px solid var(--border-card)");
    expect(track).toContain("border-radius: var(--radius-sm)");
  });
});

/**
 * The phase's actual operator path, rather than three isolated components:
 * one shared ranged read starts in Overview, the quantitative shape is
 * inspectable, Diagnostics remains an explicit choice, and Links retains that
 * same range when its data changes. Each assertion is deliberately against a
 * control or recorded number, never a class or a colour, so the proof survives
 * the compact layout rather than coupling itself to its decoration.
 */
describe("REQ-383, REQ-387, REQ-389, REQ-394, REQ-395 and REQ-400: the Insights operator journey", () => {
  it("keeps the selected range across views while exposing quantities, diagnostics and link facts", async () => {
    const client = await showHourly();

    const volume = screen.getByRole("img", { name: copy.volumeChart });
    const quantities = volume.querySelectorAll<HTMLElement>("[data-count]");

    // The chart is a compact visual aid, but neither the zero nor the actual
    // quantity exists only as a bar height.  `data-count` is the rendered
    // recorded number and its visible companion is checked in the component
    // contract; this screen-level path proves the real overview supplies it.
    expect(quantities.length).toBeGreaterThan(0);
    expect(quantities[0]).toHaveAttribute("data-count", "1");
    expect(quantities[1]).toHaveAttribute("data-count", "3");

    const navigation = screen.getByRole("navigation", {
      name: copy.views.label,
    });

    await userEvent.click(
      within(navigation).getByRole("button", { name: copy.views.activity }),
    );

    const diagnostics = screen.queryByRole("button", {
      name: text(words.activity.showDiagnostics, { count: 0 }),
    });

    // The shared fixture has no context-free delivery, so use a dedicated
    // response below to prove the control only appears where there is
    // diagnostic material.  Activity still remains a real destination here.
    expect(diagnostics).not.toBeInTheDocument();
    expect(
      within(navigation).getByRole("button", { name: copy.views.activity }),
    ).toHaveAttribute("aria-current", "page");

    await userEvent.click(
      within(navigation).getByRole("button", { name: copy.views.links }),
    );

    expect(
      screen.getByLabelText(text(copy.linkPostFunnel, { id: "post-1" })),
    ).toHaveTextContent("18");

    // Changing a period does one new read, retains Links rather than silently
    // returning to Overview, and renders the legitimate no-click state for the
    // wider fixture.  It is distinct from a failed or expired read, proved by
    // the state cases immediately below.
    await userEvent.click(
      screen.getByRole("button", { name: words.range.last7Days }),
    );
    await screen.findByText(copy.linksEmptyTitle);

    expect(client.reads).toEqual(["last_24_hours", "last_7_days"]);
    expect(
      within(navigation).getByRole("button", { name: copy.views.links }),
    ).toHaveAttribute("aria-current", "page");
    expect(screen.getByText(copy.linksEmptyTitle)).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("REQ-115: the states the operator meets before the numbers", () => {
  it("says it is reading while the request is in flight", () => {
    const pending: DashboardClient = {
      read: (): Promise<DashboardMetricsView> => new Promise(() => {}),
    };

    render(mount(pending));

    expect(screen.getByRole("status")).toHaveTextContent(copy.loading);
    expect(screen.queryByRole("table")).toBeNull();
    // Reading is not failing, and it is not empty either.
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByText(copy.noActivity)).toBeNull();
  });

  it("reports a failure and reads again when asked to", async () => {
    let answers = 0;
    const flaky: DashboardClient = {
      read: (range: DashboardRange): Promise<DashboardMetricsView> => {
        answers += 1;
        return answers === 1
          ? Promise.reject(new Error("500"))
          : Promise.resolve(BY_RANGE[range]);
      },
    };

    render(mount(flaky));

    const alert = await screen.findByRole("alert");

    expect(alert).toHaveTextContent(copy.error);
    // A failed read is not an empty period: nothing claims the period recorded
    // nothing, because nothing was read at all.
    expect(screen.queryByText(copy.noActivity)).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: copy.retry }));

    await screen.findByRole("region", { name: copy.summaryTitle });
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("sends an expired session to access without offering retry", async () => {
    render(
      mount({
        read: (): Promise<DashboardMetricsView> =>
          Promise.reject(new Error("401")),
      }),
    );

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(navCopy.sessionExpired);
    expect(alert).not.toHaveTextContent(copy.error);
    expect(screen.getByRole("link", { name: navCopy.signIn })).toHaveAttribute(
      "href",
      "/login",
    );
    expect(screen.queryByRole("button", { name: copy.retry })).toBeNull();
  });

  it("says a period with nothing in it is empty, instead of drawing a table", async () => {
    await show(
      answering({
        ...HOURLY,
        events: {
          granularity: "hour",
          buckets: HOUR_BUCKETS,
          series: [],
          unknown: { subtype: "unknown", total: 0, counts: [0, 0, 0] },
          total: 0,
        },
      }),
    );
    await openDetail();

    const events = region(copy.eventsTitle);

    expect(within(events).getByText(copy.noActivity)).toBeInTheDocument();
    // And it says a fresh instance looks like this, because an operator who
    // cannot tell "nothing happened" from "something is broken" goes hunting
    // for a fault that is not there.
    expect(within(events).getByText(copy.noActivityHint)).toBeInTheDocument();
    expect(within(events).queryByRole("table")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();

    // The actions block still has its table: an empty half is not an empty
    // page.
    expect(
      within(region(copy.actionsTitle)).getByRole("table"),
    ).toBeInTheDocument();
  });
});

describe("REQ-203: the open operational alert", () => {
  it("shows a machine pause with the same reason and instant from status", async () => {
    const occurredAt = "2026-08-01T11:45:00.000Z";
    const reason = "Launch was paused automatically after three failures";
    await show(
      answering({
        ...HOURLY,
        openAlert: {
          origin: "machine",
          reason,
          occurredAt,
          subtype: "automation_auto_paused",
          automationId: "launch",
        },
      }),
    );

    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent(copy.machineAlertTitle);
    expect(alert).toHaveTextContent(reason);
    expect(alert.querySelector("time")?.dateTime).toBe(occurredAt);
  });

  it("makes no alert claim when status answers with none open", async () => {
    await show(answering(HOURLY));

    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("REQ-207: disabled trigger switches on the panel", () => {
  it("names every disabled switch and the instant it was changed", async () => {
    const at = "2026-08-01T11:45:00.000Z";
    await show(
      answering({
        ...HOURLY,
        disabledTriggers: [
          { name: "all", updatedAt: at },
          { name: "comments", updatedAt: at },
        ],
      }),
    );

    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent(copy.triggersOffTitle);
    expect(alert).toHaveTextContent(en.settings.triggerName.all);
    expect(alert).toHaveTextContent(en.settings.triggerName.comments);
    expect(
      alert
        .querySelector('[data-trigger-switch="all"] time')
        ?.getAttribute("datetime"),
    ).toBe(at);
  });

  it("renders no warning when all switches are on", async () => {
    await show(answering({ ...HOURLY, disabledTriggers: [] }));
    expect(screen.queryByText(copy.triggersOffTitle)).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("REQ-115: the zone every instant is read in is declared on screen", () => {
  it("says which zone is in force, and reads the buckets in it", async () => {
    await showDetailed();

    expect(
      screen.getByText(text(copy.zoneNote, { zone: EPOCH_ZONE })),
    ).toBeInTheDocument();

    const table = within(region(copy.eventsTitle)).getByRole("table");
    const headers = textOf(within(table).getAllByRole("rowheader"));

    // An instance that configured no zone counts on the epoch, so the 09:00
    // bucket IS the 09:00 UTC hour. Read in the browser's own zone it would be
    // labelled a different hour on two laptops looking at the same instance.
    for (const [index, bucket] of HOUR_BUCKETS.entries()) {
      expect(headers[index]).toContain(bucket.slice(11, 16));
    }
  });
});

/**
 * REQ-153, the half that belongs to this file: the screen reads every instant
 * in the zone the ANSWER carries, and names that zone.
 *
 * The other half, which decides which bucket an entry falls in, is the
 * aggregation's and is proven against the composed application in
 * `src/http/api/dashboard.test.ts`. What would still be wrong with that half
 * working is this one: a screen formatting in UTC (or in the browser's zone)
 * would label a column after an hour that column does not count, and an
 * operator comparing the panel against the platform's own record would find
 * them three hours apart with nothing saying why.
 */
describe("REQ-153: the panel reads the instants in the instance's zone", () => {
  /** The operator's zone, three hours behind UTC and on no daylight saving. */
  const OPERATOR_ZONE = "America/Sao_Paulo";

  /** 09:00, 10:00 and 11:00 of the operator's clock, three hours off UTC. */
  const LOCAL_BUCKETS = [
    "2026-08-01T12:00:00.000Z",
    "2026-08-01T13:00:00.000Z",
    "2026-08-01T14:00:00.000Z",
  ];

  /** One event of the activity list: 09:20 on that same clock. */
  const LOCAL_EVENT = "2026-08-01T12:20:00.000Z";

  const IN_ZONE: DashboardMetricsView = {
    ...HOURLY,
    window: { ...HOURLY.window, zone: OPERATOR_ZONE },
    events: { ...HOURLY.events, buckets: LOCAL_BUCKETS },
    queue: { pending: 4, oldestPendingAt: "2026-08-01T12:15:00.000Z" },
    activity: {
      ...ACTIVITY,
      items: [
        // 09:20 of the operator's clock, 12:20 UTC.
        { ...(ACTIVITY.items[0] as ActivityEventView), at: LOCAL_EVENT },
      ],
    },
  };

  it("labels each bucket with the hour that bucket counts", async () => {
    await show(answering(IN_ZONE));
    await openDetail();

    const table = within(region(copy.eventsTitle)).getByRole("table");
    const headers = textOf(within(table).getAllByRole("rowheader"));

    // 09:00, 10:00 and 11:00 of the operator's own clock. Formatted in UTC
    // these same three instants read 12:00, 13:00 and 14:00, which is the
    // defect this case exists to catch: the same column, an hour it does not
    // count written in its head.
    expect(headers[0]).toContain("09:00");
    expect(headers[1]).toContain("10:00");
    expect(headers[2]).toContain("11:00");
    for (const header of headers.slice(0, 3)) {
      expect(header).not.toContain("12:00");
    }
  });

  it("reads the other instants of the page in that same zone", async () => {
    await show(answering(IN_ZONE));

    // One zone per page, and it is the answer's: the queue's oldest instant
    // (09:15 local) beside the buckets, never one clock for the table and
    // another for the paragraph under it.
    const queue = within(region(copy.summaryTitle));

    expect(queue.getByText(/9:15/)).toBeVisible();
    expect(queue.queryByText(/12:15/)).toBeNull();
  });

  it("reads the recent activity in that zone too (REQ-165)", async () => {
    await show(answering(IN_ZONE));

    const line = activityLines()[0] as HTMLElement;

    // 09:20 on the operator's own clock. Formatted in UTC the same instant
    // reads 12:20, which is the defect this case exists to catch: an operator
    // comparing this line against the platform's record would find it three
    // hours out with nothing on the page saying why.
    expect(line.textContent).toContain("9:20");
    expect(line.textContent).not.toContain("12:20");
  });

  it("names the zone in force rather than a zone of its own", async () => {
    await show(answering(IN_ZONE));

    expect(
      screen.getByText(text(copy.zoneNote, { zone: OPERATOR_ZONE })),
    ).toBeInTheDocument();
    // The sentence carries the configured value, so it cannot go on claiming
    // UTC the day the instance is configured for somewhere else.
    expect(
      screen.queryByText(text(copy.zoneNote, { zone: EPOCH_ZONE })),
    ).toBeNull();
  });
});

/**
 * REQ-156, the half that belongs to this file: a pause is named, not filed
 * under the group the panel keeps for entries that cannot say what they are.
 */
describe("REQ-156: the pause is a named column", () => {
  const WITH_PAUSE: DashboardMetricsView = {
    ...HOURLY,
    actions: {
      granularity: "hour",
      buckets: HOUR_BUCKETS,
      series: [
        { subtype: "message_sent", total: 7, counts: [2, 3, 2] },
        { subtype: "pause_started", total: 3, counts: [1, 1, 1] },
      ],
      unknown: { subtype: "unknown", total: 0, counts: [0, 0, 0] },
      total: 10,
    },
  };

  it("gives it the catalogue's name and not its code", async () => {
    await show(answering(WITH_PAUSE));
    await openDetail();

    const table = within(region(copy.actionsTitle)).getByRole("table");
    const columns = textOf(within(table).getAllByRole("columnheader"));

    expect(columns).toEqual([
      copy.columnPeriod,
      words.action.messageSent,
      words.action.pauseStarted,
    ]);
    // The fallback a type with no sentence gets, which is what this column
    // would read if the label key were missing: a code inside a frame.
    expect(columns).not.toContain(
      text(copy.unnamedType, { code: "pause_started" }),
    );
  });

  it("counts it as its own type, apart from the unknown group", async () => {
    await show(answering(WITH_PAUSE));
    await openDetail();

    const actions = region(copy.actionsTitle);
    const rows = within(within(actions).getByRole("table")).getAllByRole("row");

    // Three in the totals line, and nothing added to the group the screen
    // reports apart: a pause that landed there would be counted twice over the
    // day someone gave it a name.
    expect(textOf(within(rows[4] as HTMLElement).getAllByRole("cell"))).toEqual(
      ["7", "3"],
    );
    expect(figure(actions, words.action.unknown)).toBe("0");
  });
});

/* ------------------------------------------------------------------ *
 * REQ-154: a visual reading, ADDED to the table
 * ------------------------------------------------------------------ */

/**
 * The two stylesheets the theme case reads, as text.
 *
 * Read through `import.meta.glob` and not through an import, for the reason
 * `styles/tokens.test.ts` records: a `?raw` specifier would break
 * `tests/import-extensions.test.ts`, which requires every relative import in
 * the repository to end in `.js` (REQ-082). Vitest hands back an empty module
 * for a stylesheet unless `css` is on, which `vitest.config.ts` sets.
 */
const WEB_STYLES = import.meta.glob<string>(
  ["../components/components.css", "../styles/tokens/colors.css"],
  { eager: true, query: "?raw", import: "default" },
);

function styleSheet(name: string): string {
  return (
    Object.entries(WEB_STYLES).find(([key]) => key.endsWith(name))?.[1] ?? ""
  );
}

/** Every rule of the drawing, as `[selector, declarations]`. */
function chartRules(): readonly (readonly [string, string])[] {
  return [
    ...styleSheet("components.css").matchAll(
      /([^{}]*\.mc-trend[^{}]*)\{([^{}]*)\}/g,
    ),
  ].map(
    ([, selector = "", body = ""]) =>
      // The comment above a rule comes with it, since what precedes a selector
      // is whatever followed the last brace. Dropped here so a finding names
      // the rule and nothing else.
      [selector.replace(/\/\*[\s\S]*?\*\//g, "").trim(), body] as const,
  );
}

/** The body of the first `{ ... }` after `header`, braces balanced. */
function blockAfter(source: string, header: string): string {
  const open = source.indexOf("{", source.indexOf(header));
  let depth = 0;

  for (let index = open; index < source.length; index += 1) {
    depth += source[index] === "{" ? 1 : source[index] === "}" ? -1 : 0;

    if (depth === 0) {
      return source.slice(open + 1, index);
    }
  }

  return "";
}

function declarationsOf(block: string): ReadonlyMap<string, string> {
  return new Map(
    [...block.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map(
      ([, name = "", value = ""]) => [name, value.trim()],
    ),
  );
}

const PALETTE = styleSheet("colors.css");
/** The light theme, which declares every token, aliases included. */
const DECLARED = declarationsOf(blockAfter(PALETTE, ":root {"));
/** What the dark theme repaints on top of it. */
const REPAINTED = declarationsOf(
  blockAfter(
    blockAfter(PALETTE, "@media (prefers-color-scheme: dark)"),
    ":root {",
  ),
);

/**
 * Follows `var(--x)` aliases down to the token that really holds a colour, or
 * `undefined` for a name the palette never declared.
 */
function primitiveOf(name: string): string | undefined {
  const declared = DECLARED.get(name);

  if (declared === undefined) {
    return undefined;
  }

  const alias = /^var\((--[\w-]+)\)$/.exec(declared);

  return alias === null ? name : primitiveOf(alias[1] ?? "");
}

/** Colour written by hand, in the notations a value can arrive in. */
const COLOUR_LITERAL =
  /#(?:[\da-f]{3,8})\b|\brgba?\(|\bhsla?\(|\b(white|black|red|green|blue|gr[ae]y)\b/i;

/** Properties whose value paints something. Radius and width are not here. */
const PAINTED =
  /^(color|background|background-color|fill|stroke|border|border-top|border-right|border-bottom|border-left|outline|box-shadow)$/;

/** One strip of the drawing per series, in the order they are drawn. */
function strips(drawing: HTMLElement): readonly HTMLElement[] {
  return [...drawing.querySelectorAll<HTMLElement>("[data-series]")];
}

/**
 * THE drawing, definite article: the panel carries one frame and the block that
 * holds it is the only place to look for it (REQ-179).
 */
function chart(): HTMLElement {
  return within(region(copy.volumeTitle)).getByRole("img", {
    name: copy.volumeChart,
  });
}

/** The value columns of one counting table, the period column dropped. */
function valueColumns(title: string): readonly string[] {
  return textOf(
    within(within(region(title)).getByRole("table")).getAllByRole(
      "columnheader",
    ),
  ).slice(1);
}

/** One counting table's rows: the head, one per bucket, then the totals. */
function tableRows(title: string): readonly HTMLElement[] {
  return within(within(region(title)).getByRole("table")).getAllByRole("row");
}

/** The nature written over each run of strips, in the order they are drawn. */
function stripGroups(drawing: HTMLElement): readonly string[] {
  return [...drawing.querySelectorAll(".mc-trend__group")].map(
    (heading) => heading.textContent ?? "",
  );
}

/**
 * One nature with nothing in it.
 *
 * The aggregation reports what happened rather than a row of zeros, so a period
 * that recorded none of a nature has no series at all rather than a series of
 * zeros: that is the shape a fresh instance really answers with.
 */
function nothingCounted(): DashboardMetricsView["events"] {
  return {
    granularity: "hour",
    buckets: HOUR_BUCKETS,
    series: [],
    unknown: { subtype: "unknown", total: 0, counts: [0, 0, 0] },
    total: 0,
  };
}

/** The name written beside a strip: what tells it from the strip below. */
function stripName(strip: HTMLElement): string {
  return strip.querySelector(".mc-trend__name")?.textContent ?? "";
}

/** The counts a strip says it drew, in period order. */
function drawnCounts(strip: HTMLElement): readonly number[] {
  return [...strip.querySelectorAll<HTMLElement>("[data-count]")].map((slot) =>
    Number(slot.dataset.count),
  );
}

/** A column's height in percent, or `undefined` where none was drawn. */
function drawnHeights(strip: HTMLElement): readonly (number | undefined)[] {
  return [...strip.querySelectorAll<HTMLElement>("[data-count]")].map(
    (slot) => {
      const bar = slot.querySelector<HTMLElement>(".mc-trend__bar");

      return bar === null ? undefined : Number.parseFloat(bar.style.height);
    },
  );
}

/**
 * The counting blocks read as a shape as well as a table.
 *
 * The table answers "does this match the record" and stays exactly where it
 * was; what it cannot give is the SHAPE of thirty rows, which is what the
 * drawing adds. The requirement has three halves and each one has a case here:
 * every count drawn is a count the table carries as TEXT, the strips are told
 * apart by the name beside each one and never by a tint, and the drawing is
 * painted with tokens that BOTH themes repaint.
 */
describe("REQ-154: the counts are read as a shape, beside the tables", () => {
  it("keeps every table, and adds exactly one drawing", async () => {
    await showDetailed();

    // ADDED, not traded: both tables are still there, every figure of them
    // still a cell a screen reader reaches by row and column.
    for (const title of [copy.eventsTitle, copy.actionsTitle]) {
      expect(within(region(title)).getByRole("table")).toBeInTheDocument();
      // And the drawing is no longer inside either of them: the shape of both
      // natures is one frame of its own now (REQ-179).
      expect(within(region(title)).queryByRole("img")).toBeNull();
    }

    // Named, so it is an object a screen reader announces rather than a silent
    // heap of boxes.
    expect(chart()).toBeInTheDocument();

    // And nowhere else on the panel: the caps already have a meter, and the
    // band is single figures. A chart of one number is decoration, and drawing
    // a ceiling twice says the same thing in two shapes.
    for (const title of [copy.capsTitle, copy.summaryTitle]) {
      expect(within(region(title)).queryByRole("img")).toBeNull();
    }
  });

  it("draws no count the tables do not also carry as text", async () => {
    await showDetailed();

    const drawn = strips(chart());
    const arrivals = valueColumns(copy.eventsTitle);
    const performed = valueColumns(copy.actionsTitle);

    // The strips ARE the tables' value columns, in the same order: a strip for
    // something no table has a column for would be a figure that exists only
    // as a height. The unknown group is the case this forbids, and it is
    // reported apart precisely because it is made of the same deliveries.
    expect(drawn.map(stripName)).toEqual([...arrivals, ...performed]);

    // Then every column of every strip, against the cell that carries the same
    // count as text, in the table of the nature that strip belongs to. Read off
    // the screen on both sides, which is what an operator does when they ask
    // whether the picture matches the figures.
    const format = new Intl.NumberFormat("en");
    const readings = drawn.flatMap((strip, series) => {
      const arrival = series < arrivals.length;
      const rows = tableRows(arrival ? copy.eventsTitle : copy.actionsTitle);
      const column = arrival ? series : series - arrivals.length;

      return drawnCounts(strip).map((count, bucket) => {
        const cells = within(rows[bucket + 1] as HTMLElement).getAllByRole(
          "cell",
        );

        return `${format.format(count)} / ${cells[column]?.textContent ?? ""}`;
      });
    });

    expect(readings).toHaveLength(
      HOUR_BUCKETS.length * (arrivals.length + performed.length),
    );
    expect(
      readings.filter((reading) => {
        const [drawnCount, written] = reading.split(" / ");

        return drawnCount !== written;
      }),
    ).toEqual([]);
  });

  it("binds the height of every column to the count it declares", async () => {
    await showHourly();

    const drawn = strips(chart()).flatMap((strip) =>
      drawnCounts(strip).map((count, index) => ({
        count,
        height: drawnHeights(strip)[index],
      })),
    );

    // One scale for the whole drawing: the largest count in the frame is a full
    // column, so a strip half the height of its neighbour really did count half
    // as much. Without this the counts could be right in the attribute and the
    // picture still be drawn from something else. Since the frame now holds
    // both natures, the all-pairs sweep below crosses them, which is the
    // arithmetic REQ-179 is about.
    const peak = Math.max(...drawn.map(({ count }) => count));
    const tallest = drawn.filter(({ count }) => count === peak);

    expect(tallest).not.toHaveLength(0);
    expect(tallest.map(({ height }) => height)).toEqual(tallest.map(() => 100));

    // A period that counted nothing draws no column, and one that counted more
    // never draws a shorter one.
    for (const first of drawn) {
      for (const second of drawn) {
        if (first.count > second.count) {
          expect(
            first.height ?? 0,
            `${first.count} over ${second.count}`,
          ).toBeGreaterThan(second.height ?? 0);
        }
      }
    }

    expect(
      drawn.filter(({ count, height }) => count === 0 && height !== undefined),
    ).toEqual([]);
  });

  it("tells the strips apart by the name beside each one, never by a tint", async () => {
    await showHourly();

    const drawing = chart();
    const names = strips(drawing).map(stripName);

    // The name is the carrier, and it is the catalogue's: four strips, four
    // sentences, none of them blank and no two of them the same.
    expect(names).toEqual([
      words.event.comment,
      words.event.directMessage,
      words.action.commentReply,
      words.action.messageSent,
    ]);
    expect(new Set(names).size).toBe(names.length);

    // And the colour carries NOTHING: every column of every strip is painted
    // the same way, so an operator who tells no two tints apart, or who prints
    // the page in black and white, loses nothing at all. This is the assertion
    // that would fall the day a series got a tint of its own.
    const bars = [...drawing.querySelectorAll<HTMLElement>(".mc-trend__bar")];

    expect(bars).not.toHaveLength(0);
    expect(new Set(bars.map((bar) => bar.getAttribute("class"))).size).toBe(1);
    expect(
      bars.filter((bar) =>
        /colou?r|background|fill/i.test(bar.getAttribute("style") ?? ""),
      ),
    ).toEqual([]);

    // Not through the stylesheet either: a rule keyed on the type would put
    // identity back into the tint by the back door.
    expect(
      chartRules().filter(([selector]) => /data-series\s*=/.test(selector)),
    ).toEqual([]);
  });

  it("says how to read the drawing, and names the height of every strip", async () => {
    await showHourly();

    const volume = within(region(copy.volumeTitle));

    // A height is a quantity nobody can name until something names it: beside
    // each strip stands its own largest count, in the words of the catalogue
    // and the digits of the locale. Two strips peak at 3 and two at 2, one of
    // each in either nature, which is exactly the reading a single scale buys.
    expect(volume.getByText(copy.chartNote)).toBeInTheDocument();
    expect(
      volume.getAllByText(text(copy.chartPeak, { count: 3 })),
    ).toHaveLength(2);
    expect(
      volume.getAllByText(text(copy.chartPeak, { count: 2 })),
    ).toHaveLength(2);
  });

  it("draws nothing at all for a period that recorded nothing", async () => {
    await show(
      answering({
        ...HOURLY,
        events: nothingCounted(),
        actions: nothingCounted(),
      }),
    );

    const volume = region(copy.volumeTitle);

    // An empty block says it is empty. A drawing of six flat strips would be a
    // shape for nothing, and the operator would have to read it to find out it
    // says nothing.
    expect(within(volume).queryByRole("img")).toBeNull();
    expect(within(volume).getByText(copy.noActivity)).toBeInTheDocument();
    // And it says a fresh instance looks like this, so nobody goes hunting a
    // fault that is not there (REQ-115).
    expect(within(volume).getByText(copy.noActivityHint)).toBeInTheDocument();
  });

  /**
   * The third half, and the one no rendered DOM can answer: jsdom computes no
   * colour, so "it reads in the dark theme too" has to be proven where the
   * decision is written, which is the stylesheet.
   *
   * What is proven: the drawing paints with tokens and nothing else, every
   * token it names is one the palette really declares, and each of them
   * resolves to a primitive the dark theme REPAINTS. A drawing pinned to a
   * value chosen for the light theme is the defect, and it is invisible until
   * someone opens the page at night.
   */
  it("paints the drawing with tokens that both themes repaint", () => {
    const rules = chartRules();

    // Guards the sweep itself: a selector renamed and a check that then reads
    // nothing would pass forever.
    expect(rules.length).toBeGreaterThan(5);
    expect(DECLARED.size).toBeGreaterThan(0);
    expect(REPAINTED.size).toBeGreaterThan(0);

    const findings: string[] = [];
    let painted = 0;

    for (const [selector, body] of rules) {
      for (const [, property = "", value = ""] of body.matchAll(
        /([a-z-]+)\s*:\s*([^;]+);/g,
      )) {
        if (COLOUR_LITERAL.test(value)) {
          findings.push(`${selector}: ${property} is a colour written by hand`);
          continue;
        }

        if (!PAINTED.test(property)) {
          continue;
        }

        const tokens = [...value.matchAll(/var\((--[\w-]+)\)/g)].map(
          ([, name = ""]) => name,
        );

        if (tokens.length === 0) {
          findings.push(`${selector}: ${property} paints with no token`);
        }

        for (const token of tokens) {
          const primitive = primitiveOf(token);
          painted += 1;

          if (primitive === undefined) {
            findings.push(`${selector}: ${token} is declared by no palette`);
          } else if (!REPAINTED.has(primitive)) {
            findings.push(
              `${selector}: ${token} resolves to ${primitive}, which the dark theme leaves as the light one`,
            );
          }
        }
      }
    }

    expect(findings).toEqual([]);
    // The ink of the columns, the baseline, the names, the nature headings, the
    // peaks and the axis: a drawing that painted nothing would report no
    // finding either.
    expect(painted).toBeGreaterThanOrEqual(6);
  });
});

/* ------------------------------------------------------------------ *
 * REQ-178: the ceilings come second, and say which one is under pressure
 * ------------------------------------------------------------------ */

/**
 * The consumption block, moved up from the foot of the page.
 *
 * The position IS the requirement, and it comes from the operator rather than
 * from taste: the panel is opened when something is going wrong in public, and
 * the first question then is how much of the platform's allowance is already
 * spent. Under the drawing that is an answer reached by scrolling.
 *
 * The second half is accessibility and not decoration: a cap near its ceiling
 * has to be pickable out of a list of caps by somebody who tells no two colours
 * apart. Half of it was already paid before this task and is checked under
 * criterion 39: the band is written in WORDS, three different sentences from the
 * catalogue. What is added here is the shape, because three rows that read the
 * same are told apart only by reading each one, and this block exists for the
 * moment when there is no time to read.
 */
describe("REQ-178: the caps stand before the drawing, and point at themselves", () => {
  /** The glyph a row carries, which is the mark and nothing else on this row. */
  function capMark(label: string): Element | null {
    return capRow(label).querySelector("svg");
  }

  it("puts the consumption block under the band and above the drawing", async () => {
    await showDetailed();

    const caps = region(copy.capsTitle);

    // Document order, which is both the reading order and the order a screen
    // reader walks. Under the band, because "is it working?" is still the first
    // question; above the drawing, because the drawing answers "how much
    // happened", which is asked with more time than this one.
    expect(
      band().compareDocumentPosition(caps) & Node.DOCUMENT_POSITION_FOLLOWING,
      `${copy.summaryTitle} should precede ${copy.capsTitle}`,
    ).toBeTruthy();
    expect(
      caps.compareDocumentPosition(chart()) & Node.DOCUMENT_POSITION_FOLLOWING,
      `${copy.capsTitle} should precede the drawing`,
    ).toBeTruthy();

    // And above the tables it used to sit under: the block moved, it was not
    // copied, so there is exactly one of it.
    expect(
      screen.getAllByRole("region", { name: copy.capsTitle }),
    ).toHaveLength(1);
    for (const title of [copy.eventsTitle, copy.actionsTitle]) {
      expect(
        caps.compareDocumentPosition(region(title)) &
          Node.DOCUMENT_POSITION_FOLLOWING,
        `${copy.capsTitle} should precede ${title}`,
      ).toBeTruthy();
    }
  });

  it("marks the caps under pressure, and leaves the calm one unmarked", async () => {
    await show(answering(BANDS));

    // One mark on each band that is worth pointing at, and none on the band
    // that is not: a panel that marked every row would have marked nothing.
    expect(capMark(words.cap.privateRepliesPerHour)).toBeNull();
    expect(capMark(words.cap.callsPerSecond)).not.toBeNull();
    expect(capMark(words.cap.mediaCallsPerSecond)).not.toBeNull();

    // Hidden from assistive technology, because the sentence beside it says the
    // same thing: announced too, the band would be read twice.
    expect(capMark(words.cap.callsPerSecond)).toHaveAttribute(
      "aria-hidden",
      "true",
    );
  });

  it("distinguishes a cap near its ceiling by text and by shape, not by tint", async () => {
    await show(answering(BANDS));

    const calm = capRow(words.cap.privateRepliesPerHour);
    const nearly = capRow(words.cap.callsPerSecond);

    // Two carriers, and neither of them is a colour. The word is the
    // catalogue's and differs; the mark is a shape one row has and the other
    // does not. An operator who sees this list in one grey tells them apart
    // twice over.
    expect(nearly).toHaveTextContent(words.capStatus.attention);
    expect(calm).toHaveTextContent(words.capStatus.normal);
    expect(words.capStatus.attention).not.toBe(words.capStatus.normal);

    expect(capMark(words.cap.callsPerSecond)).not.toBeNull();
    expect(capMark(words.cap.privateRepliesPerHour)).toBeNull();

    // And no row carries a colour written into it: whatever tint the design
    // system gives a band lives in the stylesheet, where REQ-176 measures it.
    for (const row of within(region(copy.capsTitle)).getAllByRole("listitem")) {
      for (const painted of row.querySelectorAll("[style]")) {
        expect(
          /colou?r|background|fill/i.test(painted.getAttribute("style") ?? ""),
          painted.getAttribute("style") ?? "",
        ).toBe(false);
      }
    }
  });

  it("keeps the meter's own name the words, with the mark adding nothing", async () => {
    await showHourly();

    const meter = within(region(copy.capsTitle)).getByRole("meter");
    const named = (meter.getAttribute("aria-labelledby") ?? "")
      .split(" ")
      .map((id) => document.getElementById(id)?.textContent ?? "");

    // The meter is named by the pieces of text already on screen, pointed at
    // rather than restated, and the mark sits inside the badge that carries the
    // band. A mark that had gained a name of its own would put a wording into
    // that sentence that no catalogue wrote.
    expect(named.join(" ")).toContain(words.cap.privateRepliesPerHour);
    expect(named.join(" ")).toContain(words.capStatus.critical);

    // The meter carries a mark too, since this ceiling is at its limit, and it
    // is nameless: the sentence it stands beside is the one that gets read.
    const mark = capMark(words.cap.privateRepliesPerHour);

    expect(mark).not.toBeNull();
    expect(mark).toHaveAttribute("aria-hidden", "true");
    expect(mark).not.toHaveAttribute("aria-label");
  });
});

/* ------------------------------------------------------------------ *
 * REQ-179: one frame, and the two natures comparable inside it
 * ------------------------------------------------------------------ */

/**
 * What arrived and what was done about it, in ONE drawing.
 *
 * The panel used to draw them in two frames, and `TrendChart` scales every
 * strip against the tallest column of the drawing it is in: two frames meant
 * two scales, so a strip in the actions frame standing as tall as one in the
 * events frame meant nothing at all. "Two hundred comments answered by four
 * replies" and "two hundred answered by a hundred and ninety" are the same two
 * blocks of figures and two completely different mornings, and only one frame
 * makes the difference visible.
 *
 * Four things this block pins down, each of them a way the drawing could still
 * render while answering the wrong question: there is one frame and not two,
 * both natures are inside it, one axis and one scale run across both, and the
 * two halves are told apart by a written heading rather than by a tint.
 */
describe("REQ-179: the received and the performed share one frame", () => {
  it("draws one frame on the whole page, and both natures are in it", async () => {
    await showHourly();

    // Counted over the page and not over a block: two frames in two blocks is
    // exactly the arrangement this requirement replaces, and a check scoped to
    // one block would not have seen the second one.
    const frames = screen.getAllByRole("img");

    expect(frames).toHaveLength(1);
    expect(frames[0]).toBe(chart());

    // Both natures inside it, each run of strips headed by the name of what it
    // counts. The headings are the catalogue's own names for the two blocks,
    // which is what keeps a strip from being called one thing here and another
    // in the table that carries its figures.
    expect(stripGroups(chart())).toEqual([copy.eventsTitle, copy.actionsTitle]);
    expect(strips(chart())).toHaveLength(4);
  });

  it("cuts both natures over the same periods, on one axis", async () => {
    await showDetailed();

    const drawing = chart();

    // One axis for the drawing, written once: two axes would be two frames
    // wearing one heading.
    const axis = textOf([
      ...drawing.querySelectorAll<HTMLElement>(".mc-trend__axis"),
    ]);

    expect(axis).toHaveLength(1);

    // And every strip of every nature has one column per bucket, in the same
    // order: a strip cut over other periods would be drawn beside the others
    // and comparable with none of them.
    const columns = strips(drawing).map((strip) =>
      [...strip.querySelectorAll<HTMLElement>("[data-count]")].map(
        (slot) => slot.title,
      ),
    );

    const periods = tableRows(copy.eventsTitle)
      .slice(1, HOUR_BUCKETS.length + 1)
      .map((row) => within(row).getByRole("rowheader").textContent ?? "");

    expect(periods).toHaveLength(HOUR_BUCKETS.length);
    expect(columns).toEqual(strips(drawing).map(() => periods));
  });

  it("measures both natures against one scale", async () => {
    // A window where the tallest column is an ARRIVAL and the actions are all
    // smaller: with a frame of their own, the tallest action would have been
    // drawn full height and read as "as many as arrived".
    await show(
      answering({
        ...HOURLY,
        events: {
          granularity: "hour",
          buckets: HOUR_BUCKETS,
          series: [{ subtype: "comment", total: 24, counts: [4, 20, 0] }],
          unknown: { subtype: "unknown", total: 0, counts: [0, 0, 0] },
          total: 24,
        },
        actions: {
          granularity: "hour",
          buckets: HOUR_BUCKETS,
          series: [{ subtype: "comment_reply", total: 6, counts: [1, 5, 0] }],
          unknown: { subtype: "unknown", total: 0, counts: [0, 0, 0] },
          total: 6,
        },
      }),
    );

    const drawn = strips(chart());
    const arrivals = drawnHeights(drawn[0] as HTMLElement);
    const performed = drawnHeights(drawn[1] as HTMLElement);

    // 20 arrivals is the full column, and the 5 replies of the same hour are a
    // quarter of it. Read off the two strips, which is what an operator does
    // when they ask whether the answering kept up with the arriving.
    expect(arrivals[1]).toBe(100);
    expect(performed[1]).toBe(25);
    expect(arrivals[0]).toBe(20);
    expect(performed[0]).toBe(5);
  });

  it("tells the two natures apart by a heading, and not by a tint", async () => {
    await showHourly();

    const drawing = chart();
    const bars = [...drawing.querySelectorAll<HTMLElement>(".mc-trend__bar")];

    // Every column of every strip of both natures is painted the same way, so
    // an operator who tells no two tints apart, or who prints the page in black
    // and white, loses nothing at all. What the drawing gains over two frames
    // is a scale, never a palette.
    expect(bars.length).toBeGreaterThan(HOUR_BUCKETS.length);
    expect(new Set(bars.map((bar) => bar.getAttribute("class"))).size).toBe(1);
    expect(
      bars.filter((bar) =>
        /colou?r|background|fill/i.test(bar.getAttribute("style") ?? ""),
      ),
    ).toEqual([]);

    // The two headings are sentences, and different ones.
    const groups = stripGroups(drawing);

    expect(groups.every((heading) => heading.trim() !== "")).toBe(true);
    expect(new Set(groups).size).toBe(groups.length);
  });

  it("stays legible when one of the two natures recorded nothing", async () => {
    await show(answering({ ...HOURLY, actions: nothingCounted() }));

    const drawing = chart();

    // Events arrived and nothing was done about them, which is a shape worth
    // seeing rather than an empty block: the frame draws the half that happened
    // and heads it with the nature it counts, and nothing on screen claims the
    // other half was zero-by-drawing rather than absent.
    expect(strips(drawing)).toHaveLength(2);
    expect(stripGroups(drawing)).toEqual([copy.eventsTitle]);
    expect(drawing).not.toHaveTextContent(copy.actionsTitle);
  });

  it("stays legible when the OTHER nature is the empty one", async () => {
    // The same case the other way round, because nothing about the frame may
    // depend on which of the two halves is the one that happened: a drawing
    // that only survived a missing second group would fail here.
    await show(answering({ ...HOURLY, events: nothingCounted() }));

    expect(stripGroups(chart())).toEqual([copy.actionsTitle]);
    expect(strips(chart())).toHaveLength(2);
    expect(chart()).not.toHaveTextContent(copy.eventsTitle);
  });

  it("says the period is empty when neither nature recorded anything", async () => {
    await show(
      answering({
        ...HOURLY,
        events: nothingCounted(),
        actions: nothingCounted(),
      }),
    );

    const volume = region(copy.volumeTitle);

    // A frame of flat strips for nothing is a drawing an operator has to read
    // before finding out it says nothing, and a fresh instance answers exactly
    // this way until the first comment arrives (REQ-115).
    expect(within(volume).queryByRole("img")).toBeNull();
    expect(within(volume).getByText(copy.noActivity)).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

/* ------------------------------------------------------------------ *
 * REQ-180: the granular reading leaves the opening, not the screen
 * ------------------------------------------------------------------ */

/** Every value cell of one counting table, row by row, the totals included. */
function cellMatrix(title: string): readonly (readonly string[])[] {
  return tableRows(title)
    .slice(1)
    .map((row) => textOf(within(row).getAllByRole("cell")));
}

/** What one counting table says, whole: its columns and every figure in it. */
function readingOf(title: string): {
  readonly columns: readonly string[];
  readonly cells: readonly (readonly string[])[];
  readonly unknown: string;
  readonly recorded: string;
} {
  return {
    columns: textOf(
      within(within(region(title)).getByRole("table")).getAllByRole(
        "columnheader",
      ),
    ),
    cells: cellMatrix(title),
    unknown: figure(
      region(title),
      title === copy.eventsTitle ? words.event.unknown : words.action.unknown,
    ),
    recorded: figure(region(title), copy.recorded),
  };
}

/**
 * The granular reading, behind the path the page names (REQ-180).
 *
 * THE DIAGNOSIS IS THE OPERATOR'S, in their own words: the panel opened with a
 * table of events per hour, and "it is very cluttered". Thirty rows of counts
 * are the answer to a question asked with time in hand, and they stood in front
 * of the four figures that answer "is it working?".
 *
 * The requirement asks two things and only two, and each half is a way this
 * could go wrong on its own:
 *
 *   - the granular reading does NOT open with the page. Not "is scrolled past",
 *     not "is drawn small": is not there. A table rendered and merely made
 *     invisible is still a thing a screen reader walks through and a find on the
 *     page lands in, so the check below reads the raw document as well as the
 *     accessibility tree;
 *   - it stays COMPLETE when reached. That is the half a tidy-up quietly loses:
 *     a column dropped, a totals line traded for a subtitle, a caveat left
 *     behind with the block it used to caption. So what is compared here is the
 *     whole reading, columns, every cell, the totals row, the two figures the
 *     table leaves out and the note that qualifies the messages, against the
 *     figures the fixture answers with.
 *
 * And a disclosure has a contract, which is the third thing checked: the control
 * says whether it is expanded, points at what it expands, and the keyboard alone
 * reaches and works it. A control that only a mouse can open would have moved
 * the granular reading out of reach rather than out of the way.
 */
describe("REQ-180: the granular reading is behind a path the page names", () => {
  it("opens with no counting table on the page at all", async () => {
    await showHourly();

    // Neither in the accessibility tree nor in the document: hiding the tables
    // with a stylesheet would pass the first of these and fail the second,
    // which is exactly the difference between out of the way and out of reach.
    expect(screen.queryAllByRole("table")).toEqual([]);
    expect(document.querySelectorAll("table")).toHaveLength(0);
    expect(screen.queryByRole("region", { name: copy.eventsTitle })).toBeNull();
    expect(
      screen.queryByRole("region", { name: copy.actionsTitle }),
    ).toBeNull();

    // Nor any of the words the tables write: the column head and the caveat the
    // actions table captions itself with.
    expect(screen.queryByText(copy.columnPeriod)).toBeNull();
    expect(screen.queryByText(words.acceptedNote)).toBeNull();

    // Guards the guard: a page that had rendered nothing at all would satisfy
    // every line above. The band and the drawing are what the panel DOES open
    // with, and they are both here.
    expect(band()).toBeInTheDocument();
    expect(chart()).toBeInTheDocument();
  });

  it("names the path, and says the path is shut", async () => {
    await showHourly();

    const control = detailControl();

    // Announced instead of implied by the word on the button changing: a
    // control whose only signal is its own label tells a screen reader nothing
    // until it has been read twice.
    expect(control).toHaveAttribute("aria-expanded", "false");

    // And it points at something that really exists. An `aria-controls` naming
    // an element the page never renders is a promise to a screen reader that
    // the page cannot keep.
    const panelId = control.getAttribute("aria-controls") ?? "";

    expect(panelId).not.toBe("");
    expect(document.getElementById(panelId)).not.toBeNull();
  });

  it("is reached and worked by the keyboard alone", async () => {
    await showHourly();

    const control = detailControl();

    // Tabbed to from the top of the page, rather than focused by hand: what is
    // at stake is whether the control is IN the tab order, and calling focus()
    // on it would prove only that an element can be focused programmatically.
    for (let stops = 0; stops < 10 && document.activeElement !== control;) {
      await userEvent.tab();
      stops += 1;
    }

    expect(control).toHaveFocus();

    await userEvent.keyboard("{Enter}");
    await screen.findByRole("region", { name: copy.eventsTitle });

    expect(detailControl()).toHaveAttribute("aria-expanded", "true");
  });

  it("brings the granular reading complete when the control is used", async () => {
    await showDetailed();

    // The events, whole: the same columns, the same counts per bucket, the same
    // totals line, and the two figures the table deliberately leaves out
    // (REQ-106). Read off the screen, against the numbers the fixture answered.
    expect(readingOf(copy.eventsTitle)).toEqual({
      columns: [
        copy.columnPeriod,
        words.event.comment,
        words.event.directMessage,
      ],
      cells: [
        ["1", "0"],
        ["3", "1"],
        ["1", "2"],
        // The totals line, which is the row a tidy-up drops first: without it
        // the period has to be added up by hand, row by row.
        ["5", "3"],
      ],
      unknown: "4",
      recorded: "12",
    });

    // And the actions, whole, the same way.
    expect(readingOf(copy.actionsTitle)).toEqual({
      columns: [
        copy.columnPeriod,
        words.action.commentReply,
        words.action.messageSent,
      ],
      cells: [
        ["1", "2"],
        ["2", "3"],
        ["1", "2"],
        ["4", "7"],
      ],
      unknown: "0",
      recorded: "11",
    });

    // The caveat came with them, and came as the table's own caption: the count
    // is written when a message is ACCEPTED for sending, and a granular reading
    // that arrived without it would state seven deliveries nobody confirmed
    // (REQ-181).
    const actions = region(copy.actionsTitle);

    expect(within(actions).getByRole("table")).toContainElement(
      within(actions).getByText(words.acceptedNote),
    );

    // The granularity is still marked beside what it cut, on both tables.
    expect(screen.getAllByText(copy.granularity.hour)).toHaveLength(3);
  });

  it("says it is open, and shuts again when asked", async () => {
    await showDetailed();

    expect(detailControl()).toHaveAttribute("aria-expanded", "true");

    await userEvent.click(detailControl());

    // Back to the opening, all the way back: a control that hid the tables and
    // left them in the document would leave the page as cluttered for a screen
    // reader as it ever was.
    await waitFor(() => {
      expect(document.querySelectorAll("table")).toHaveLength(0);
    });
    expect(detailControl()).toHaveAttribute("aria-expanded", "false");
  });

  it("stays open when the operator moves to another period", async () => {
    await showDetailed();
    await chooseSevenDays();

    // Choosing another range is the SAME question over a wider window, and the
    // read in flight unmounts everything below it. A state that lived in the
    // block would come back shut, and the screen would be undoing a choice the
    // operator made, from a control they never touched.
    expect(detailControl()).toHaveAttribute("aria-expanded", "true");

    // Open AND redrawn: the wider window's own counts, four daily buckets where
    // there were three hourly ones. A block that had merely survived the change
    // would still be showing yesterday's numbers.
    expect(readingOf(copy.eventsTitle)).toEqual({
      columns: [
        copy.columnPeriod,
        words.event.comment,
        words.event.directMessage,
      ],
      cells: [
        ["2", "1"],
        ["3", "0"],
        ["1", "2"],
        ["3", "1"],
        ["9", "4"],
      ],
      unknown: "2",
      recorded: "15",
    });
  });

  it("keeps the recent activity last, with the control above it", async () => {
    await showHourly();

    const control = detailControl();
    const activity = region(words.activity.title);

    // Shut, and this is the reason the tables kept the place they had rather
    // than moving under the activity: the activity is the only block as tall as
    // the traffic, so a control placed after it would itself be the thing an
    // operator could not reach without scrolling past fifty rows.
    expect(
      control.compareDocumentPosition(activity) &
        Node.DOCUMENT_POSITION_FOLLOWING,
      "the control should precede the recent activity",
    ).toBeTruthy();

    await openDetail();

    // Open, and the activity is still last: the tables unfold above it, so the
    // block whose height is the traffic's still has nothing under it.
    for (const title of [copy.eventsTitle, copy.actionsTitle]) {
      expect(
        region(title).compareDocumentPosition(region(words.activity.title)) &
          Node.DOCUMENT_POSITION_FOLLOWING,
        `${title} should precede ${words.activity.title}`,
      ).toBeTruthy();
    }

    expect(regionNames().at(-1)).toBe(words.activity.title);
  });
});

/* ------------------------------------------------------------------ *
 * REQ-165 and REQ-163: the activity, and the codes behind it, in words
 * ------------------------------------------------------------------ */

/**
 * One line per EVENT, in the order they are drawn.
 *
 * The block's own children and not every `listitem` under it: the actions of an
 * event are a list inside its line, and counting those as lines would make
 * "four events" read as nine.
 */
function activityLines(): readonly HTMLElement[] {
  return [
    ...region(words.activity.title).querySelectorAll<HTMLElement>(
      ".mc-activity > li",
    ),
  ];
}

/** The line of one event, found by the identifier its fixture carries. */
function activityLine(eventId: string): HTMLElement {
  const found = region(words.activity.title).querySelector<HTMLElement>(
    `[data-event-id="${eventId}"]`,
  );

  if (found === null) {
    throw new Error(`no activity line for ${eventId}`);
  }

  return found;
}

async function openDiagnostics(count: number): Promise<void> {
  await userEvent.click(
    screen.getByRole("button", {
      name: text(words.activity.showDiagnostics, { count }),
    }),
  );
}

async function openActivityDetails(eventId: string): Promise<HTMLElement> {
  const line = region(words.activity.title).querySelector<HTMLElement>(
    `[data-event-id="${eventId}"]`,
  );

  if (line === null) {
    throw new Error(`no activity line for ${eventId}`);
  }

  await userEvent.click(
    within(line).getByRole("button", { name: words.activity.showDetails }),
  );
  return line;
}

function refusal(reason: string, count: number): string {
  return text(words.activity.refusalCount, {
    reason: (words.activity.refusal as Record<string, string>)[reason] ?? "",
    count,
  });
}

/**
 * The recent activity, which is where the record stops being a total and starts
 * being an answer (REQ-165).
 *
 * Four things this block exists to pin down, and each one is a line that would
 * still render, wrongly, if the screen got it wrong:
 *
 *   - technical events that fired NOTHING stay auditable in Diagnostics, while
 *     the standard list remains a concise operational reading;
 *   - "no automation matched" and "no automation exists" are different answers
 *     and read differently, because the second one is a thing to go and fix;
 *   - an interaction that carried no words is not a row that stored no text,
 *     and the trail keeps them apart on purpose (REQ-162);
 *   - the list is CUT at the cap the answer declares, and says so in figures.
 */
describe("REQ-165: the panel shows the recent activity", () => {
  it("puts one line per event, with who wrote and what they wrote", async () => {
    await showHourly();

    expect(activityLines()).toHaveLength(ACTIVITY.items.length - 1);

    const fired = activityLine("evt-fired");

    // The contact's own words, verbatim: it is content and not wording, no
    // catalogue holds it, and translating it would be a lie.
    expect(fired).toHaveTextContent(
      text(words.activity.contact, { username: "fulano" }),
    );
    expect(fired).toHaveTextContent(
      text(words.activity.text, { text: "quero" }),
    );
    // The compact row carries the event and resulting actions as chips.
    expect(fired).toHaveTextContent(words.activity.chip.commented);
    expect(fired).toHaveTextContent(words.activity.chip.commentReply);
    expect(fired).toHaveTextContent(words.activity.chip.messageAccepted);
    const legend = region(words.activity.title).querySelector(
      ".mc-activity__legend",
    );
    expect(legend?.querySelectorAll(".mc-chip")).toHaveLength(4);
    expect(legend).toHaveTextContent(words.activity.legend.messageAccepted);
  });

  it("names the contact a direct message brought no public handle for", async () => {
    await showHourly();

    // Absent on every direct message (REQ-162), so the line names them by the
    // identifier the record does carry rather than leaving the column blank.
    const failed = activityLine("evt-failed");

    expect(failed).toHaveTextContent(
      text(words.activity.contactId, { id: "contact-2" }),
    );
    // And nothing at all when even that is missing: a blank would read as a
    // line the screen failed to draw.
    expect(activityLine("evt-bare")).toHaveTextContent(
      words.activity.noContact,
    );
  });

  it("keeps context-free deliveries out of the standard list until Diagnostics opens", async () => {
    const diagnostic: ActivityEventView = {
      eventId: "evt-diagnostic",
      at: "2026-08-01T10:45:00.000Z",
      subtype: "unknown",
      outcome: "suppressed",
      actions: [],
    };

    await show(
      answering({
        ...HOURLY,
        activity: {
          items: [...ACTIVITY.items, diagnostic],
          total: 138,
          limit: 50,
        },
      }),
    );

    expect(activityLines()).toHaveLength(ACTIVITY.items.length - 1);
    expect(
      region(words.activity.title).querySelector(
        '[data-event-id="evt-diagnostic"]',
      ),
    ).toBeNull();

    await openDiagnostics(2);

    expect(activityLines()).toHaveLength(ACTIVITY.items.length + 1);
    expect(
      within(region(words.activity.title)).getByText(
        words.activity.diagnosticsHint,
      ),
    ).toBeInTheDocument();
    expect(
      region(words.activity.title).querySelector(
        '[data-event-id="evt-diagnostic"]',
      ),
    ).not.toBeNull();
  });

  it("keeps a platform-only numeric contact and an unmatched event in Diagnostics", async () => {
    const numericContact: ActivityEventView = {
      eventId: "evt-platform-contact",
      at: "2026-08-01T10:44:00.000Z",
      subtype: "direct_message",
      outcome: "ok",
      contactId: "701804635348805",
      eventText: "quero saber mais",
      actions: [],
    };

    await show(
      answering({
        ...HOURLY,
        activity: {
          items: [...ACTIVITY.items, numericContact],
          total: 138,
          limit: 50,
        },
      }),
    );

    expect(
      region(words.activity.title).querySelector(
        '[data-event-id="evt-platform-contact"]',
      ),
    ).toBeNull();
    expect(
      region(words.activity.title).querySelector(
        '[data-event-id="evt-silent"]',
      ),
    ).toBeNull();

    await openDiagnostics(2);

    expect(
      region(words.activity.title).querySelector(
        '[data-event-id="evt-platform-contact"]',
      ),
    ).not.toBeNull();
    expect(
      within(region(words.activity.title)).getByRole("heading", {
        name: words.activity.technicalTitle,
      }),
    ).toBeInTheDocument();
  });

  it("shows the event that fired nothing, and why, per reason", async () => {
    await showHourly();

    await openDiagnostics(1);
    const silent = await openActivityDetails("evt-silent");

    // The line that costs an operator real time, and the anchor of this task:
    // nothing happened, and here is the aggregate REQ-160 stored, by reason
    // and by how many automations refused for it.
    expect(silent).toHaveTextContent(words.activity.arrival.suppressed);
    expect(silent).toHaveTextContent(words.activity.silence.no_match);
    expect(silent).toHaveTextContent(refusal("no_keyword", 3));
    expect(silent).toHaveTextContent(refusal("disabled", 1));
  });

  it("says why a step was deliberately not performed, and not just that it was", async () => {
    await showHourly();

    const fired = await openActivityDetails("evt-fired");
    const why = fired.querySelector<HTMLElement>("[data-reason]");

    // The verdict beside the step says only THAT it fired nothing, which is
    // the half of the answer an operator already suspected. This is the other
    // half, and it comes from the catalogue: the engine cannot read one
    // (ADR-003), so it emits a code and this is where the code gets its words.
    expect(fired).toHaveTextContent(words.activity.actionOutcome.suppressed);
    expect(fired).toHaveTextContent(suppressed.email_already_known);
    // Carried as data, so a test reads the code from the line instead of
    // inferring it from a sentence, and the sentence stays the catalogue's.
    expect(why?.dataset["reason"]).toBe("email_already_known");
    expect(why).toHaveTextContent(suppressed.email_already_known);
  });

  it("says nothing about a reason for an action that has none", async () => {
    await showHourly();

    // Absent and empty stay different here as everywhere else in this chain: a
    // step that was performed has no reason to give, and a suppressed one whose
    // code this build cannot name arrives with no field either. Neither may
    // draw a blank line where a sentence belongs.
    const failed = await openActivityDetails("evt-failed");
    const bare = await openActivityDetails("evt-bare");
    const fired = await openActivityDetails("evt-fired");
    expect(failed.querySelector("[data-reason]")).toBeNull();
    expect(bare.querySelector("[data-reason]")).toBeNull();
    expect(fired.querySelectorAll("[data-reason]")).toHaveLength(1);
  });

  it("tells no automation matched from no automation installed", async () => {
    await show(
      answering({
        ...HOURLY,
        activity: {
          items: [
            {
              ...(ACTIVITY.items[2] as ActivityEventView),
              // The legitimate empty list: nothing existed to refuse it. Said
              // with the other sentence it would read as "every automation
              // refused, and for no reason at all".
              silence: { code: "no_match", refusals: [] },
            },
          ],
          total: 1,
          limit: 50,
        },
      }),
    );

    await openDiagnostics(1);
    const silent = await openActivityDetails("evt-silent");

    expect(silent).toHaveTextContent(words.activity.silence.no_match_empty);
    expect(silent).not.toHaveTextContent(words.activity.silence.no_match);
  });

  it("names a reason it cannot read, and shows nothing of what was stored", async () => {
    await show(
      answering({
        ...HOURLY,
        activity: {
          items: [
            {
              ...(ACTIVITY.items[2] as ActivityEventView),
              silence: { code: "unreadable", refusals: [] },
            },
          ],
          total: 1,
          limit: 50,
        },
      }),
    );

    await openDiagnostics(1);
    const silent = await openActivityDetails("evt-silent");

    // The stored phrase deliberately never crosses the contract: it is
    // application wording in whatever language the instance wrote it, and this
    // screen names the STATE from the catalogue instead (REQ-163, REQ-074).
    expect(silent).toHaveTextContent(words.activity.silence.unreadable);
    expect(silent).not.toHaveTextContent(words.activity.silence.no_match);
  });

  it("keeps an interaction with no words apart from a line with no text", async () => {
    await showHourly();

    // Three facts, three sentences. The empty string is the case that has to
    // survive, and it is the falsy one: a screen testing the text for truth
    // would fold "said nothing" into "we stored nothing" (REQ-162).
    expect(activityLine("evt-failed")).toHaveTextContent(
      words.activity.noWords,
    );
    expect(activityLine("evt-bare")).toHaveTextContent(words.activity.noText);
    expect(activityLine("evt-fired")).not.toHaveTextContent(
      words.activity.noWords,
    );

    const marks = activityLines().map(
      (line) =>
        line.querySelector<HTMLElement>("[data-text]")?.dataset["text"] ?? "",
    );

    expect(marks).toEqual(["present", "empty", "absent"]);
  });

  it("says the list was cut, in figures", async () => {
    await showHourly();

    // "Three of a hundred and thirty-seven", from the standard list's count: an
    // operator who cannot tell a short list from a truncated one reads the
    // whole period off four lines.
    expect(
      within(region(words.activity.title)).getByText(
        text(words.activity.truncated, { shown: 3, total: "137" }),
      ),
    ).toBeInTheDocument();
  });

  it("says nothing was cut when nothing was", async () => {
    await showHourly();
    await chooseSevenDays();

    expect(activityLines()).toHaveLength(1);
    expect(
      within(region(words.activity.title)).queryByText(
        text(words.activity.truncated, { shown: 1, total: 1 }),
      ),
    ).toBeNull();
  });

  it("says a period with no event is empty, instead of drawing a bare list", async () => {
    await show(
      answering({ ...HOURLY, activity: { items: [], total: 0, limit: 50 } }),
    );

    const activity = within(region(words.activity.title));

    expect(activity.getByText(words.activity.empty)).toBeInTheDocument();
    expect(activityLines()).toHaveLength(0);
    // A fresh instance looks like this, and saying so is what keeps an
    // operator from hunting a fault that is not there (REQ-115).
    expect(activity.getByText(copy.noActivityHint)).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("says so when the record explains neither an action nor a silence", async () => {
    await showHourly();

    // A line that trails off is a line an operator re-reads. This one says the
    // record is silent, which is the truth and is a different thing from a
    // reason nobody printed.
    expect(await openActivityDetails("evt-bare")).toHaveTextContent(
      words.activity.nothingDone,
    );
    expect(activityLine("evt-fired")).not.toHaveTextContent(
      words.activity.nothingDone,
    );
  });
});

/**
 * REQ-182: one instant, two readings, and neither one replaces the other.
 *
 * The line already carried the absolute instant in the instance's zone, which is
 * what an operator compares against the platform's own record and what they
 * quote when somebody asks at what time something broke. What it did not carry
 * is "how recent", and that answer was left as arithmetic done in the head, once
 * per line, all the way down a list of fifty.
 *
 * Everything here hangs on WHERE the relative reading counts from. "Ten minutes
 * ago" measured against the browser's clock is a different sentence every time
 * the suite runs, and a screen that read `Date.now()` could only be tested by
 * freezing time around it. The reference is the ANSWER's own `window.until`, the
 * instant the aggregation took the read at, so these cases state a fixture and
 * expect one sentence, and the case below that changes the reference alone is
 * what proves the screen is reading it rather than a clock of its own.
 */
describe("REQ-182: every line says when exactly, and how recent", () => {
  /**
   * The instant these answers were read at, which every case states its own
   * event against. Written here rather than taken from the shared fixture, so a
   * case reads as "this event, that long before the read" without the reference
   * having to be looked up in a window three hundred lines up.
   */
  const READ_AT = "2026-08-01T12:30:00.000Z";

  /** The shipped sentences, plural forms included. */
  const RELATIVE = words.activity.relative;

  function activityOf(at: string): RecentActivityView {
    return {
      items: [{ ...(ACTIVITY.items[0] as ActivityEventView), at }],
      total: 1,
      limit: 50,
    };
  }

  /** The finest range's answer, with its one event moved to a chosen instant. */
  function aged(at: string): DashboardMetricsView {
    return {
      ...HOURLY,
      window: { ...HOURLY.window, until: READ_AT },
      activity: activityOf(at),
    };
  }

  /** The seven day answer, which reaches back far enough to be read in days. */
  function agedDays(at: string): DashboardMetricsView {
    return {
      ...DAILY,
      window: { ...DAILY.window, until: READ_AT },
      activity: activityOf(at),
    };
  }

  /** The two readings of the first line, in the order they are written. */
  function readings(): readonly HTMLTimeElement[] {
    return [
      ...(activityLines()[0] as HTMLElement).querySelectorAll<HTMLTimeElement>(
        "time",
      ),
    ];
  }

  it("puts the exact instant and the distance from it on one line", async () => {
    // The requirement itself, and the pair is the point: either half alone
    // sends the operator back to a calculation. 12:20 UTC is what the record
    // says, and it happened ten minutes before this answer was read.
    await show(answering(aged("2026-08-01T12:20:00.000Z")));

    const line = activityLines()[0] as HTMLElement;

    expect(line).toHaveTextContent("12:20");
    expect(line).toHaveTextContent(text(RELATIVE.minutes_other, { count: 10 }));
  });

  it("counts from the instant the answer was read at, not from this clock", async () => {
    // The same event, two answers, two readings: the only thing that changed is
    // the end of the window. A screen counting from `Date.now()` would show the
    // same sentence twice (and a different one tomorrow), which is what makes
    // this the case that pins the injection rather than the wording.
    const at = "2026-08-01T11:30:00.000Z";

    await show(
      answering({
        ...HOURLY,
        window: { ...HOURLY.window, until: "2026-08-01T11:35:00.000Z" },
        activity: activityOf(at),
      }),
    );

    expect(readings()[1]).toHaveTextContent(
      text(RELATIVE.minutes_other, { count: 5 }),
    );

    // The second answer REPLACES the first: rendered side by side, every query
    // below would find two pages and report a fault in a test that did nothing
    // wrong. The suite's own `afterEach` does this between cases, not inside
    // one.
    cleanup();

    await show(answering(aged(at)));

    // An hour by the second answer's clock, five minutes by the first one's.
    expect(readings()[1]).toHaveTextContent(
      text(RELATIVE.hours_one, { count: 1 }),
    );
  });

  it("says one minute in the singular and the rest in the plural", async () => {
    // The reason the sentence is a plural family and not one string with a
    // number in it: "há 1 minutos" is what a single form ships in Portuguese,
    // and it is the kind of wrongness an operator reads as carelessness.
    await show(answering(aged("2026-08-01T12:29:00.000Z")));

    expect(readings()[1]).toHaveTextContent(
      text(RELATIVE.minutes_one, { count: 1 }),
    );

    cleanup();

    await show(answering(aged("2026-08-01T09:30:00.000Z")));

    expect(readings()[1]).toHaveTextContent(
      text(RELATIVE.hours_other, { count: 3 }),
    );
  });

  it("says an event of the last minute just happened", async () => {
    // Under a minute the number would change while it is being read, and the
    // minute sentence would open at zero. Both are worse than the plain fact.
    await show(answering(aged("2026-08-01T12:29:31.000Z")));

    expect(readings()[1]).toHaveTextContent(RELATIVE.justNow);
    expect(readings()[1]?.dataset["elapsed"]).toBe("now");
  });

  it("reads the older end of a wide period in days", async () => {
    // The widest window is thirty days, so days is the coarsest step there can
    // be: no line reads "4 weeks ago" inside a period the page calls 30 days.
    await show(answering(agedDays("2026-07-29T12:30:00.000Z")));

    expect(readings()[1]).toHaveTextContent(
      text(RELATIVE.days_other, { count: 3 }),
    );
    expect(readings()[1]?.dataset["elapsed"]).toBe("days");
  });

  it("rounds down, and never reads into the future", async () => {
    // Eighty minutes is one hour and not two: the exact instant is beside it,
    // so the coarse reading may be coarse but must not name an hour the record
    // does not carry.
    await show(answering(aged("2026-08-01T11:10:00.000Z")));

    expect(readings()[1]).toHaveTextContent(
      text(RELATIVE.hours_one, { count: 1 }),
    );

    cleanup();

    // A row written between the query and the answer, or a clock a second out.
    // "In -1 minutes" is not a thing that happened; "just now" is.
    await show(answering(aged("2026-08-01T12:31:00.000Z")));

    expect(readings()[1]).toHaveTextContent(RELATIVE.justNow);
  });

  it("gives both readings the same instant, and neither one to nobody", async () => {
    await show(answering(aged("2026-08-01T12:20:00.000Z")));

    const [exact, distance] = readings();

    // Two `time` elements over one fact: the absolute first, because it is the
    // information proper and the relative is a reading of it. Both carry the
    // SAME machine-readable instant, so nothing reading the markup can take
    // them for two different moments.
    expect(readings()).toHaveLength(2);
    expect(exact?.dateTime).toBe("2026-08-01T12:20:00.000Z");
    expect(distance?.dateTime).toBe(exact?.dateTime);
    expect(distance?.dataset["elapsed"]).toBe("minutes");

    // And neither is hidden from a screen reader. The bars inside the counting
    // tables are, because a bar says nothing its figure does not; "10 minutes
    // ago" says something the timestamp only implies, and hiding it would leave
    // exactly the mental arithmetic this requirement exists to remove.
    for (const reading of readings()) {
      expect(reading.closest("[aria-hidden='true']")).toBeNull();
    }
  });

  it("chooses the Portuguese singular and plural, in the language in force", async () => {
    /**
     * The other shipped language, MOUNTED, which nothing else in this file does
     * and the plural is the reason. The form is chosen from the count and from
     * the language, so a catalogue read in English proves only that the pair
     * exists: "há 1 minutos" is what a single sentence with a number in it
     * ships to half the operators, and the language that would show it is this
     * one. Both catalogues are given to the provider, as the real build bundles
     * them, so a key missing in Portuguese falls back to English here exactly
     * as it would on the running page, and these assertions fail on it.
     */
    const relative = ptBR.dashboard.activity.relative;

    const inPortuguese = (metrics: DashboardMetricsView): ReactElement => (
      <LocaleProvider
        client={{
          read: (): Promise<LocaleState> =>
            Promise.resolve({ locale: "pt-BR", available: ["pt-BR", "en"] }),
          write: (): Promise<LocaleState> =>
            Promise.resolve({ locale: "pt-BR", available: ["pt-BR", "en"] }),
        }}
        catalogues={{ en, "pt-BR": ptBR }}
      >
        <DashboardScreen client={answering(metrics)} />
      </LocaleProvider>
    );

    /** The relative reading of the first line, whatever the page is titled. */
    async function elapsedText(): Promise<string> {
      const line = await waitFor(() => {
        const first = document.querySelector<HTMLElement>(".mc-activity > li");

        if (first === null) {
          throw new Error("no activity line yet");
        }

        return first;
      });

      return [...line.querySelectorAll("time")][1]?.textContent ?? "";
    }

    render(inPortuguese(aged("2026-08-01T12:29:00.000Z")));

    expect(await elapsedText()).toBe(text(relative.minutes_one, { count: 1 }));

    cleanup();

    render(inPortuguese(aged("2026-08-01T12:20:00.000Z")));

    expect(await elapsedText()).toBe(
      text(relative.minutes_other, { count: 10 }),
    );
  });
});

/**
 * REQ-163, the half that belongs to a screen: the codes the application emits
 * arrive as WORDS.
 *
 * The engine, the matcher and the trail all speak in codes, because a value
 * that is counted and stored must not change when somebody rewords a screen
 * (ADR-003). The whole value of that trade is spent here: if the screen prints
 * the code, the operator reads `no_keyword` where a sentence belonged, and the
 * trade bought nothing.
 *
 * The other half, which no rendered DOM can answer, is in `catalogue.test.ts`:
 * a code with no translation in some language fails there, by derivation, with
 * nobody having remembered to register it.
 */
describe("REQ-163: the codes reach the operator as words", () => {
  /**
   * Identifiers, as the record writes them. Every one carries an underscore,
   * which is what makes this check total AND safe: no sentence in either
   * catalogue contains one, so a hit is always a code that leaked, never an
   * English word that happens to be spelled like its code.
   */
  const CODES = [
    "direct_message",
    "comment_reply",
    "message_sent",
    "pause_started",
    "no_match",
    "no_keyword",
    "wrong_origin",
    "wrong_target",
    // The engine's own, which reach the panel the same way and must land as
    // sentences the same way (REQ-068, REQ-163).
    "email_already_known",
    "conversation_already_open",
    "contact_already_follows",
  ];

  it("puts a sentence where each code was", async () => {
    await showHourly();

    const fired = await openActivityDetails("evt-fired");
    const failed = await openActivityDetails("evt-failed");
    const bare = await openActivityDetails("evt-bare");

    // The compact row omits the normal arrival verdict, while every non-normal
    // action still reaches the expanded reading in catalogue words.
    expect(fired).toHaveTextContent(words.activity.actionOutcome.ok);
    expect(failed).toHaveTextContent(words.activity.actionOutcome.failed);
    expect(failed).toHaveTextContent(words.activity.chip.directMessage);
    expect(bare).toHaveTextContent(words.activity.arrival.duplicate);
  });

  it("shows no identifier of the record anywhere in the list", async () => {
    await showHourly();

    await openActivityDetails("evt-fired");
    await openActivityDetails("evt-failed");
    await openDiagnostics(1);
    await openActivityDetails("evt-silent");
    await openActivityDetails("evt-bare");

    const shown = region(words.activity.title).textContent ?? "";

    // Guards the guard: a sweep looking for codes that appear nowhere in the
    // fixture would pass against a screen printing all of them.
    expect(CODES.filter((code) => shown.includes(code))).toEqual([]);
    expect(shown).toContain(words.activity.refusal.no_keyword);
    expect(shown).toContain(words.activity.chip.directMessage);
    // And the engine's code, whose sentence is on the line while the code
    // itself is nowhere in the text the sweep above just read.
    expect(shown).toContain(suppressed.email_already_known);
  });

  it("never says a message was sent, only accepted for sending", async () => {
    await showHourly();
    const fired = await openActivityDetails("evt-fired");

    // The trail writes the `ok` of a `message_sent` when the step ENQUEUES it;
    // the delivery happens later, in the sweep. A line saying "sent" would be
    // the screen lying, in the very block that exists to stop that.
    expect(words.action.messageSent.toLowerCase()).toContain("accepted");
    expect(fired).toHaveTextContent(words.activity.chip.messageAccepted);
  });
});

/**
 * REQ-171, the half that belongs to a screen: an execution that failed says WHY.
 *
 * The verdict beside the step already says a failure happened, which is the
 * half of the answer the operator arrived with. This block is about the other
 * half, and about the one place it cannot be given: what came back through a
 * port is the platform's wording, so the code carries the cause and the
 * quotation carries what was answered, shown as data and translated by nobody.
 */
describe("REQ-171: a failed execution says why, on the line", () => {
  const REFUSAL = "the platform answered 400: unsupported media";

  /**
   * A local fixture rather than a fifth item in the shared one: every other
   * block here counts that list, and a screen test should not make five other
   * assertions read differently to say one new thing.
   */
  function withFailure(action: {
    readonly reason?: string;
    readonly detail?: string;
  }): DashboardClient {
    const broken: ActivityEventView = {
      eventId: "evt-broken",
      at: "2026-08-01T11:30:00.000Z",
      subtype: "comment",
      outcome: "ok",
      contactId: "contact-9",
      eventText: "quero",
      actions: [
        {
          at: "2026-08-01T11:30:01.000Z",
          subtype: "message_sent",
          outcome: "failed",
          ...action,
        } as ActivityEventView["actions"][number],
      ],
    };

    return answering({
      ...HOURLY,
      activity: { items: [broken], total: 1, limit: 50 },
    });
  }

  it("puts the catalogue's sentence where the failure code was", async () => {
    await show(withFailure({ reason: "flow_not_runnable" }));

    const line = await openActivityDetails("evt-broken");
    const why = line.querySelector<HTMLElement>("[data-reason]");

    // The defect this task was written against: the trail stored a phrase, the
    // panel could translate no phrase, and the line said a step had failed with
    // nothing at all beside it.
    expect(line).toHaveTextContent(words.activity.actionOutcome.failed);
    expect(line).toHaveTextContent(failed.flow_not_runnable);
    // Carried as data, so a test reads the code from the line instead of
    // inferring it from a sentence, and the sentence stays the catalogue's.
    expect(why?.dataset["reason"]).toBe("flow_not_runnable");
  });

  it("quotes what the platform answered, beside the code and never as it", async () => {
    await show(withFailure({ reason: "unexpected_error", detail: REFUSAL }));

    const line = await openActivityDetails("evt-broken");

    // Both halves on the line, and each one what it is. The sentence is the
    // catalogue's, about a cause this build named; the quotation is the
    // platform's, framed by the catalogue and translated by nobody.
    expect(line).toHaveTextContent(failed.unexpected_error);
    expect(line).toHaveTextContent(
      text(words.activity.reasonDetail, { detail: REFUSAL }),
    );
    expect(
      line.querySelector<HTMLElement>("[data-detail]")?.dataset["detail"],
    ).toBe(REFUSAL);
    // The code itself is nowhere in the words: it is on the line as data.
    expect(line.textContent ?? "").not.toContain("unexpected_error");
  });

  it("shows a code with no detail as a sentence and nothing more", async () => {
    await show(withFailure({ reason: "transitions_form_a_cycle" }));

    const line = await openActivityDetails("evt-broken");

    expect(line).toHaveTextContent(failed.transitions_form_a_cycle);
    // No empty quotation: a pair of quote marks around nothing reads as a
    // platform that answered with silence, which is a fact nobody recorded.
    expect(line.querySelector("[data-detail]")).toBeNull();
  });

  it("says nothing at all when the record named no cause", async () => {
    // The reason a build cannot read never crosses the contract, so the line
    // arrives with no code. It says WHAT happened and does not guess at why,
    // and above all it prints no stored phrase in place of the answer.
    await show(withFailure({}));

    const line = await openActivityDetails("evt-broken");

    expect(line).toHaveTextContent(words.activity.actionOutcome.failed);
    expect(line.querySelector("[data-reason]")).toBeNull();
    expect(line.querySelector("[data-detail]")).toBeNull();
  });
});

describe("REQ-413/REQ-415/REQ-416: correlated execution activity", () => {
  it("summarizes each DM once and exposes its honest chronological lifecycle", async () => {
    await show(
      answering({
        ...HOURLY,
        activity: {
          items: ACTIVITY.items,
          total: ACTIVITY.total,
          limit: ACTIVITY.limit,
          executions: [
            {
              executionId: "guide:contact-1:run",
              at: "2026-08-01T11:20:00.000Z",
              updatedAt: "2026-08-01T11:20:09.000Z",
              summary: {
                total: 4,
                queued: 1,
                accepted: 1,
                seen: 1,
                failed: 1,
                latestStatus: "queued",
              },
              messages: [
                { id: 1, status: "accepted", events: [] },
                { id: 2, status: "seen", events: [] },
                {
                  id: 3,
                  status: "failed",
                  events: [
                    {
                      at: "2026-08-01T11:20:05.000Z",
                      kind: "message_failed",
                      detail: "400: window closed",
                    },
                  ],
                },
                { id: 4, status: "queued", events: [] },
              ],
              events: [
                { at: "2026-08-01T11:20:00.000Z", kind: "received" },
                { at: "2026-08-01T11:20:01.000Z", kind: "message_queued" },
                { at: "2026-08-01T11:20:02.000Z", kind: "message_accepted" },
                { at: "2026-08-01T11:20:03.000Z", kind: "message_queued" },
                { at: "2026-08-01T11:20:04.000Z", kind: "message_accepted" },
                { at: "2026-08-01T11:20:05.000Z", kind: "message_seen" },
                { at: "2026-08-01T11:20:06.000Z", kind: "message_queued" },
                {
                  at: "2026-08-01T11:20:07.000Z",
                  kind: "message_failed",
                  detail: "400: window closed",
                },
                { at: "2026-08-01T11:20:08.000Z", kind: "message_queued" },
                {
                  at: "2026-08-01T11:20:09.000Z",
                  kind: "clicked",
                  buttonLabel: "Open guide",
                },
              ],
            },
          ],
          executionTotal: 1,
        },
      }),
    );

    const execution = region(words.activity.title).querySelector<HTMLElement>(
      '[data-execution-id="guide:contact-1:run"]',
    );
    expect(execution).not.toBeNull();
    expect(execution).toHaveTextContent(
      `1 ${words.activity.execution.status.queued}`,
    );
    expect(execution).toHaveTextContent(
      `1 ${words.activity.execution.status.accepted}`,
    );
    expect(execution).toHaveTextContent(
      `1 ${words.activity.execution.status.seen}`,
    );
    expect(execution).toHaveTextContent(
      `1 ${words.activity.execution.status.failed}`,
    );
    // Four outbound messages remain one operator-facing run. Splitting this
    // into four activity rows would hide the causality the details preserve.
    expect(
      execution?.querySelectorAll(".mc-activity__chip--execution"),
    ).toHaveLength(4);
    expect(execution).toHaveTextContent(
      text(words.activity.reasonDetail, { detail: "400: window closed" }),
    );
    const historical = within(region(words.activity.title)).getByRole(
      "region",
      { name: words.activity.historicalTitle },
    );
    expect(historical).toHaveTextContent(words.activity.historicalHint);
    expect(
      historical.querySelector('[data-event-id="evt-fired"]'),
    ).not.toBeNull();

    await userEvent.setup().click(
      within(execution as HTMLElement).getByRole("button", {
        name: words.activity.showDetails,
      }),
    );
    const timeline = within(execution as HTMLElement).getByRole("list", {
      name: "Full execution timeline",
    });
    expect(timeline.querySelectorAll("li")).toHaveLength(10);
    expect(
      [...timeline.querySelectorAll("li")].map((item) => item.dataset["kind"]),
    ).toEqual([
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
    expect(timeline.lastElementChild).toHaveTextContent("Opened: Open guide");
    expect(timeline).toHaveTextContent("Sent to Meta");
    expect(timeline).not.toHaveTextContent("Delivered");
  });

  it("keeps empty historic executions and no-action events out of the standard activity list", async () => {
    await show(
      answering({
        ...HOURLY,
        activity: {
          items: ACTIVITY.items,
          total: ACTIVITY.total,
          limit: ACTIVITY.limit,
          executions: [
            {
              executionId: "old:empty",
              at: "2026-08-01T11:20:00.000Z",
              updatedAt: "2026-08-01T11:20:00.000Z",
              summary: {
                total: 0,
                queued: 0,
                accepted: 0,
                seen: 0,
                failed: 0,
                latestStatus: "queued",
              },
              messages: [],
              events: [
                {
                  at: "2026-08-01T11:20:00.000Z",
                  kind: "received",
                },
              ],
            },
          ],
          executionTotal: 1,
        },
      }),
    );

    const activity = region(words.activity.title);
    expect(activity).not.toHaveTextContent("0 DM queued");
    expect(
      activity.querySelector('[data-execution-id="old:empty"]'),
    ).toBeNull();
    expect(
      within(activity).getByRole("button", {
        name: words.activity.showDiagnostics.replace("{{count}}", "1"),
      }),
    ).toBeVisible();
  });
});

describe("REQ-074: every identifier is named by the shipped catalogue", () => {
  /** Flat leaf paths of a catalogue, the form `t` addresses them by. */
  function flatten(value: unknown, prefix = ""): string[] {
    return typeof value === "object" && value !== null
      ? Object.entries(value).flatMap(([key, nested]) =>
          flatten(nested, prefix === "" ? key : `${prefix}.${key}`),
        )
      : [prefix];
  }

  /**
   * The i18next plural suffixes, so a family counts as the one key its caller
   * asks for (REQ-182).
   *
   * `ELAPSED_KEYS` holds `...relative.minutes` and the catalogue carries
   * `minutes_one` and `minutes_other`, because the form is chosen from the
   * count and the language in force. A check comparing paths literally would
   * report the three counted keys of that record as missing while the screen
   * rendered them correctly.
   */
  const PLURAL_CATEGORIES = ["zero", "one", "two", "few", "many", "other"];

  /** Every key the catalogue answers to: its paths, plus each family's base. */
  function addressable(paths: readonly string[]): Set<string> {
    return new Set(
      paths.flatMap((path) => {
        const cut = path.lastIndexOf("_");

        return cut > 0 && PLURAL_CATEGORIES.includes(path.slice(cut + 1))
          ? [path, path.slice(0, cut)]
          : [path];
      }),
    );
  }

  it("resolves the keys the screen looks up through a map", () => {
    // `catalogue.test.ts` walks every `t("...")` written down, and a key held
    // in a map is invisible to it. These are exactly those keys: the trail's
    // vocabulary, the ranges and the cap statuses, each named by the catalogue.
    const known = addressable(flatten(en));

    // Guards the guard: the plural families are the reason `addressable`
    // exists, and a set built without them would let this pass by accident on
    // the day the last plural key was removed rather than on purpose.
    expect(known.has("dashboard.activity.relative.minutes")).toBe(true);
    expect(known.has("dashboard.activity.relative.nothing")).toBe(false);

    expect(LABEL_KEYS.filter((key) => !known.has(key))).toStrictEqual([]);
    expect(LABEL_KEYS.length).toBeGreaterThan(10);
  });

  // The two checks that stood here guarded the SCAFFOLD: while the wave's
  // snippet had not landed, this file spread its own sentences over the
  // published section, and something had to watch the two agree. The keys
  // landed, the spread is gone, and both checks would now compare the
  // catalogue with itself. What they were reaching for — text the catalogue
  // carries and nobody asks for — is REQ-172 in `catalogue.test.ts`, which
  // walks the production sources instead of one screen's fixture.
});

/* ------------------------------------------------------------------ *
 * REQ-192: the mirrored vocabularies, held against the computed ones
 * ------------------------------------------------------------------ */

/**
 * Four words are spelled twice or three times in this repository, and the
 * repetition is DELIBERATE: `src/dashboard/aggregate.ts` computes with them and
 * reaches a database driver doing it, while the interface's program compiles no
 * driver, so the screen declares its own. What was missing is the consequence.
 * Nothing failed while the spellings agreed, so a fourth range or a fourth band
 * taught to one side only would have surfaced on a screen rather than in a gate.
 *
 * The FOURTH word (`CapWindow`, REQ-196) arrived a phase after the other three,
 * and how it got left out is the part worth keeping. It was not missed: it was
 * found beside them, in the same two files, by the very task that built this
 * pin, and it went into the inbox because the requirement being implemented
 * named three types by name. So the pin shipped, the family read as closed, and
 * the member outside it went on deciding which caveat a meter prints
 * (`cap.window === "second"`) with nothing holding its two spellings together.
 * A requirement that lists its members guards a list; the sweep is what guards
 * the family.
 *
 * Held by ASSIGNMENT and in BOTH directions, the shape `i18n/catalogue.test.ts`
 * already uses for the mirrors in `engine-reasons.ts`: one direction alone
 * accepts a mirror that GAINED a member the original lacks, the other alone
 * accepts one that LOST a member the original has, and only the pair leaves no
 * member unaccounted for on either side.
 *
 * The pin lives HERE, rather than beside each declaration, because this screen
 * is the only module that holds all three names at once: it declares its own,
 * it imports the meter's, and it hands one to the other on every render. Split
 * over three files, it would be three chances to orphan it.
 *
 * It fails at COMPILE time and not in this case: `vite build` typechecks this
 * file (the plugin in `vite.config.ts`), so a member added or dropped on one
 * side alone stops `npm run build` before any test runs. The case exists so the
 * bindings are READ at runtime, which is what keeps a linter from deleting them
 * as dead code and taking the proof with them.
 */
describe("REQ-192: the mirrored types cannot drift from the computed ones", () => {
  it("keeps every mirrored union identical to the one that is computed", () => {
    const rangeIsMirrored: DashboardRange =
      "last_24_hours" as ComputedDashboardRange;
    const rangeIsComputed: ComputedDashboardRange =
      "last_24_hours" as DashboardRange;

    const granularityIsMirrored: BucketGranularity =
      "hour" as ComputedBucketGranularity;
    const granularityIsComputed: ComputedBucketGranularity =
      "hour" as BucketGranularity;

    const statusIsMirrored: CapStatus = "normal" as ComputedCapStatus;
    const statusIsComputed: ComputedCapStatus = "normal" as CapStatus;

    const windowIsMirrored: CapWindow = "hour" as ComputedCapWindow;
    const windowIsComputed: ComputedCapWindow = "hour" as CapWindow;

    // The meter spells the band a THIRD time, and is held against the same
    // original rather than against the screen: two edges to one anchor make the
    // remaining pair equal too, and there is no third edge to keep in step.
    const meterStatusIsMirrored: MeterCapStatus = "normal" as ComputedCapStatus;
    const meterStatusIsComputed: ComputedCapStatus = "normal" as MeterCapStatus;

    expect([
      rangeIsMirrored,
      rangeIsComputed,
      granularityIsMirrored,
      granularityIsComputed,
      statusIsMirrored,
      statusIsComputed,
      windowIsMirrored,
      windowIsComputed,
      meterStatusIsMirrored,
      meterStatusIsComputed,
    ]).toHaveLength(10);
  });

  it("offers the ranges in the order they are declared in", () => {
    // Guards the guard, and reaches one thing the assignments cannot: a type
    // knows the MEMBERS and not their ORDER, and the order is what an operator
    // reads on the control. Compared as values, so a list reshuffled on one
    // side is a failure rather than a surprise on screen.
    expect([...DASHBOARD_RANGES]).toStrictEqual([...COMPUTED_RANGES]);
    expect(DASHBOARD_RANGES.length).toBeGreaterThan(0);
  });
});
