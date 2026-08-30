import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fixedInstanceSettings } from "../config/instance-settings.js";
import { decodeNoMatch } from "../flows/matching.js";
import { validateUnifiedAutomation } from "../flows/validation.js";
import type { UnifiedAutomation } from "../flows/schema.js";
import { t } from "../i18n/index.js";
import {
  createAuditRepository,
  createAutomationAggregateRepository,
  createAutomationRunStore,
  createContactRepository,
  createConversationStore,
  createDurableWorkStore,
  createMemoryAssets,
  IN_MEMORY_DATABASE,
  openDatabase,
} from "../storage/index.js";
import type { DatabaseHandle } from "../storage/index.js";
import {
  createDispatcher,
  createPauseResume,
  translateInbound,
  UNREADABLE_INBOUND_REASON,
} from "./dispatch.js";
import type { DispatchDeps, InboundInteraction } from "./dispatch.js";
import { decodeExecutionFailure } from "./execution-audit.js";
import { MESSAGE_PAUSE_MS } from "./outbox.js";
import { createSuspensionTimeoutHandler } from "./suspension.js";
import { runSweep } from "./sweep.js";

/**
 * Proves REQ-092 and REQ-095: the whole path from an accepted event to queued
 * actions, with no network anywhere.
 *
 * The ORDER is what is on trial here, not the individual pieces (they have
 * their own tests):
 *
 *   1. a direct message marks the conversation open, a comment does not;
 *   2. the event is offered to the contact's suspended executions FIRST;
 *   3. the wait has the first word and the trigger has the second, so an event
 *      the wait ACCEPTED stops there and one it REFUSED goes on to matching.
 *
 * Two of these assertions would still pass with the order inverted, which is
 * why the resume cases assert what did NOT happen: an automation that was ready
 * to fire on the resuming message and never did.
 *
 * Everything the dispatcher executes is a version-2 AGGREGATE (REQ-213): the
 * automation owns its trigger, its rules and its steps, and no flow is stored
 * anywhere in this file. A run that needed a flow catalogue would find none.
 */

const T0 = new Date("2026-08-01T10:00:00.000Z");
const SECOND = 1000;
const HOUR = 60 * 60 * 1000;
const ACCOUNT = "17841400000000000";
const CONTACT = "contact-1";
/** The handle the platform sends beside the id, on a comment and nowhere else. */
const USERNAME = "someone";
const EVENT = "event-1";
const RESOURCE_URL = "https://cdn.example/guide";
/** The one resource the anchor automation names, and resolves only at send. */
const COVER = "cover.png";
/** What the second publication's automation delivers, and only it. */
const SECOND_RESOURCE = "the second guide itself";
/** The words on its button, which are the only answer that ends its wait. */
const SECOND_BUTTON = "Send it";
/** What a run delivers after a pause, and nobody has to answer for it. */
const PAUSED_RESOURCE = "the paused material";
const PAUSE_SECONDS = 30;

/** A stored aggregate, refused loudly here rather than halfway through a run. */
function automation(input: Record<string, unknown>): UnifiedAutomation {
  const result = validateUnifiedAutomation({
    schema_version: 2,
    kind: "automation",
    // Immediate by default HERE, and only here: the instants every case below
    // asserts were written with the first reply leaving at once, and the
    // automation's wait (REQ-277) is proven by the fixtures that declare one.
    rules: { once_per_contact: true, first_reply_delay_seconds: 0 },
    ...input,
  });
  if (!result.ok) {
    throw new Error(
      `fixture automation invalid: ${JSON.stringify(result.issues)}`,
    );
  }
  return result.value;
}

/**
 * The anchor case as ONE self-contained automation: it answers the comment,
 * asks for consent, and only then hands the file over. The confirmation is what
 * makes it the fixture every ordering case needs, because it leaves a wait
 * behind (REQ-066, REQ-067).
 */
function anchorAutomation(
  overrides: Record<string, unknown> = {},
): UnifiedAutomation {
  return automation({
    id: "anchor-automation",
    state: "active",
    trigger: {
      type: "comment",
      target: "media-1",
      match: { keywords: ["guide"], mode: "contains" },
    },
    steps: [
      { id: "reply", action: "reply_comment", text: "check your DMs" },
      {
        id: "confirm",
        action: "confirm_optin",
        text: "shall I send you the guide?",
        quick_reply_label: "Yes",
        on_timeout: "abandon",
      },
      {
        id: "deliver",
        action: "send_dm",
        message: {
          // The cover is the part that still names a RESOURCE and resolves it
          // at send time (REQ-020), which is what every ordering case below
          // needs: a URL that must not exist before the contact consents. The
          // attachment used to play that role and left the format with
          // REQ-284.
          image: COVER,
          buttons: [
            {
              id: "guide",
              label: "Get the guide",
              url: "https://example.com/guide",
            },
          ],
        },
      },
    ],
    ...overrides,
  });
}

/**
 * Fires on a DIRECT MESSAGE containing "yes", which is exactly what a contact
 * answering a confirmation sends. Its whole purpose is to be available to
 * matching at the moment the resume happens.
 */
function menuAutomation(
  overrides: Record<string, unknown> = {},
): UnifiedAutomation {
  return automation({
    id: "menu-automation",
    state: "active",
    trigger: {
      type: "direct_message",
      match: { keywords: ["yes"], mode: "contains" },
    },
    steps: [
      {
        id: "menu",
        action: "send_dm",
        message: { text: "the menu ran" },
      },
    ],
    ...overrides,
  });
}

/**
 * Fires on a DIRECT MESSAGE containing "catalogue", which is a word NO wait in
 * this file accepts as an answer.
 *
 * That is its whole purpose (REQ-242): the interesting message is the one a
 * wait refuses and a trigger matches, and the menu automation above cannot be
 * it, because its keyword is the confirmation's own button.
 */
function catalogueAutomation(
  overrides: Record<string, unknown> = {},
): UnifiedAutomation {
  return automation({
    id: "catalogue-automation",
    state: "active",
    trigger: {
      type: "direct_message",
      match: { keywords: ["catalogue"], mode: "contains" },
    },
    steps: [
      {
        id: "send",
        action: "send_dm",
        message: { text: "the catalogue ran" },
      },
    ],
    ...overrides,
  });
}

/**
 * The SECOND publication's automation, which also leaves the contact waiting.
 *
 * The pair is what makes REQ-236 testable at all: one automation cannot hold a
 * contact twice, and until this fixture existed nothing in this file could put
 * the same person into two waits at once, which is the situation the rule was
 * written for.
 */
function secondAutomation(
  overrides: Record<string, unknown> = {},
): UnifiedAutomation {
  return automation({
    id: "second-automation",
    state: "active",
    trigger: {
      type: "comment",
      target: "media-2",
      match: { keywords: ["guide"], mode: "contains" },
    },
    steps: [
      { id: "reply", action: "reply_comment", text: "the second answered" },
      {
        id: "confirm",
        action: "confirm_optin",
        text: "shall I send you the second guide?",
        // Deliberately NOT the anchor's button: the answer then names which
        // wait the contact meant, so a resume of the wrong one is visible
        // instead of being indistinguishable from a resume of the right one.
        quick_reply_label: SECOND_BUTTON,
        on_timeout: "abandon",
      },
      {
        id: "deliver",
        action: "send_dm",
        message: { text: SECOND_RESOURCE },
      },
    ],
    ...overrides,
  });
}

/**
 * A run that waits for NOBODY: the pause between two messages (REQ-098).
 *
 * Its wait is a row of the same kind as every other, and the only one no
 * contact can end, which is what makes it the interesting case for a rule about
 * who owns the contact.
 */
function pausingAutomation(): UnifiedAutomation {
  return automation({
    id: "pausing-automation",
    state: "active",
    trigger: {
      type: "comment",
      target: "media-1",
      match: { keywords: ["guide"], mode: "contains" },
    },
    steps: [
      { id: "reply", action: "reply_comment", text: "check your DMs" },
      { id: "pause", action: "delay", seconds: PAUSE_SECONDS },
      {
        id: "deliver",
        action: "send_dm",
        message: { text: PAUSED_RESOURCE },
      },
    ],
  });
}

/** What an automation with the operator's wait delivers, and only it. */
const WAITED_RESOURCE = "the material of the waiting automation";
/** The wait those automations declare, in seconds (REQ-277). */
const FIRST_REPLY_WAIT = 10;

/**
 * A public reply and a first direct message, with the operator's wait on the
 * automation (REQ-277).
 *
 * Two steps and NO step between them, deliberately: what this fixture exists to
 * show is the pair that leaves together, and a pause between them would make
 * the two instants explainable by the step instead of by the rule.
 */
function waitingAutomation(
  seconds: number = FIRST_REPLY_WAIT,
): UnifiedAutomation {
  return automation({
    id: "waiting-automation",
    state: "active",
    trigger: {
      type: "comment",
      target: "media-1",
      match: { keywords: ["guide"], mode: "contains" },
    },
    rules: { once_per_contact: true, first_reply_delay_seconds: seconds },
    steps: [
      { id: "reply", action: "reply_comment", text: "check your DMs" },
      { id: "deliver", action: "send_dm", message: { text: WAITED_RESOURCE } },
    ],
  });
}

/**
 * The same wait, on an automation that ASKS before it delivers.
 *
 * The confirmation is what makes a SECOND pass exist, and the second pass is
 * where the requirement draws its line: what the contact triggered waits, what
 * the contact answered does not.
 */
function waitingAndAskingAutomation(): UnifiedAutomation {
  return automation({
    id: "waiting-asking-automation",
    state: "active",
    trigger: {
      type: "comment",
      target: "media-1",
      match: { keywords: ["guide"], mode: "contains" },
    },
    rules: {
      once_per_contact: true,
      first_reply_delay_seconds: FIRST_REPLY_WAIT,
    },
    steps: [
      {
        id: "confirm",
        action: "confirm_optin",
        text: "shall I send you the guide?",
        quick_reply_label: "Yes",
        on_timeout: "abandon",
      },
      { id: "deliver", action: "send_dm", message: { text: WAITED_RESOURCE } },
    ],
  });
}

/** The address the waiting automation's delivery carries after its text. */
const WAITED_LINK = "https://zeta.example/webinar";

/**
 * The same wait, on a delivery that is SEVERAL messages (REQ-231, REQ-286).
 *
 * One step, a text and one pure link, which is what makes the two instants
 * this fixture exists for belong to ONE delivery: the wait applies to it as a
 * whole, and the pause applies between its messages. A second step would make
 * the gap explainable by the step order instead of by the two rules meeting.
 */
function waitingAndLinkingAutomation(): UnifiedAutomation {
  return automation({
    id: "waiting-linking-automation",
    state: "active",
    trigger: {
      type: "comment",
      target: "media-1",
      match: { keywords: ["guide"], mode: "contains" },
    },
    rules: {
      once_per_contact: true,
      first_reply_delay_seconds: FIRST_REPLY_WAIT,
    },
    steps: [
      {
        id: "deliver",
        action: "send_dm",
        message: { text: WAITED_RESOURCE, links: [WAITED_LINK] },
      },
    ],
  });
}

/**
 * A one-step automation on a comment: it suspends nothing, so a second event
 * from the same contact reaches matching instead of resuming a wait. That is
 * what makes it the right fixture for the once-per-contact rule.
 */
function plainAutomation(
  overrides: Record<string, unknown> = {},
): UnifiedAutomation {
  return automation({
    id: "plain-automation",
    state: "active",
    trigger: {
      type: "comment",
      target: "media-1",
      match: { keywords: ["guide"], mode: "contains" },
    },
    steps: [
      {
        id: "menu",
        action: "send_dm",
        message: { text: "the plain automation ran" },
      },
    ],
    ...overrides,
  });
}

/** A race can queue a public reply before its delivery gate loses. */
function replyThenDeliverAutomation(): UnifiedAutomation {
  return automation({
    id: "reply-then-deliver-automation",
    state: "active",
    trigger: {
      type: "comment",
      target: "media-1",
      match: { keywords: ["guide"], mode: "contains" },
    },
    steps: [
      { id: "reply", action: "reply_comment", text: "the race reply" },
      {
        id: "deliver",
        action: "send_dm",
        message: { text: "the race delivery" },
      },
    ],
  });
}

/** The two halves one run of `twoPartAutomation` hands over, in order. */
const FIRST_HALF = "here is the first half";
const SECOND_HALF = "and here is the rest";

/**
 * One run, TWO deliveries, with a wait between them.
 *
 * The shape matters for REQ-239: the second delivery asks the once-per-contact
 * gate again, and by then the mark exists because this very run wrote it. A
 * mark that could not name the run holding it would refuse the second half.
 */
function twoPartAutomation(): UnifiedAutomation {
  return automation({
    id: "two-part-automation",
    state: "active",
    trigger: {
      type: "comment",
      target: "media-1",
      match: { keywords: ["guide"], mode: "contains" },
    },
    steps: [
      { id: "intro", action: "send_dm", message: { text: FIRST_HALF } },
      {
        id: "confirm",
        action: "confirm_optin",
        text: "shall I send the rest?",
        quick_reply_label: "Yes",
        on_timeout: "abandon",
      },
      { id: "deliver", action: "send_dm", message: { text: SECOND_HALF } },
    ],
  });
}

/** A comment automation whose public reply names it, so a run is visible. */
function replying(
  id: string,
  target: string,
  text: string,
  overrides: Record<string, unknown> = {},
): UnifiedAutomation {
  return automation({
    id,
    state: "active",
    trigger: {
      type: "comment",
      target,
      match: { keywords: ["guide"], mode: "contains" },
    },
    steps: [{ id: "reply", action: "reply_comment", text }],
    ...overrides,
  });
}

function commentPayload(
  overrides: {
    text?: string;
    from?: string;
    recipient?: string;
    /** `null` drops the field, which is how an older delivery arrives. */
    username?: string | null;
    commentId?: string;
    mediaId?: string;
    time?: number;
  } = {},
): unknown {
  const username =
    overrides.username === undefined ? USERNAME : overrides.username;

  return {
    object: "instagram",
    entry: [
      {
        id: ACCOUNT,
        // Seconds, as the platform sends them.
        time: Math.floor((overrides.time ?? T0.getTime()) / 1000),
        changes: [
          {
            field: "comments",
            value: {
              id: overrides.commentId ?? "comment-1",
              text: overrides.text ?? "I want the guide",
              from: {
                id: overrides.from ?? CONTACT,
                ...(username !== null && { username }),
              },
              media: { id: overrides.mediaId ?? "media-1" },
            },
          },
        ],
      },
    ],
  };
}

function messagePayload(
  overrides: {
    text?: string;
    from?: string;
    recipient?: string;
    mid?: string;
    at?: Date;
    isEcho?: boolean;
  } = {},
): unknown {
  return {
    object: "instagram",
    entry: [
      {
        id: ACCOUNT,
        time: Math.floor(T0.getTime() / 1000),
        messaging: [
          {
            sender: { id: overrides.from ?? CONTACT },
            recipient: { id: overrides.recipient ?? ACCOUNT },
            // Milliseconds here, seconds above, in the same delivery.
            timestamp: (overrides.at ?? T0).getTime(),
            message: {
              mid: overrides.mid ?? "mid-1",
              text: overrides.text ?? "yes",
              ...(overrides.isEcho === true && { is_echo: true }),
            },
          },
        ],
      },
    ],
  };
}

/**
 * A tapped button. This is how the confirmation of a comment-born run comes
 * back: the private reply offers its choices as generic template postback
 * buttons, and a tap on one produces a `postback` with no `message` at all.
 */
function postbackPayload(
  overrides: {
    title?: string | null;
    payload?: string | null;
    from?: string;
    at?: Date;
  } = {},
): unknown {
  const title = overrides.title === undefined ? "Yes" : overrides.title;
  const payload = overrides.payload === undefined ? "Yes" : overrides.payload;

  return {
    object: "instagram",
    entry: [
      {
        id: ACCOUNT,
        time: Math.floor(T0.getTime() / 1000),
        messaging: [
          {
            sender: { id: overrides.from ?? CONTACT },
            recipient: { id: ACCOUNT },
            timestamp: (overrides.at ?? T0).getTime(),
            postback: {
              mid: "mid-postback-1",
              ...(title !== null && { title }),
              ...(payload !== null && { payload }),
            },
          },
        ],
      },
    ],
  };
}

describe("REQ-092: from the received event to the queue, unattended", () => {
  let handle: DatabaseHandle;
  let now: Date;
  let deps: DispatchDeps;

  async function install(
    automations: readonly UnifiedAutomation[],
    pendingBaselines: ReadonlyMap<string, readonly string[]> = new Map(),
  ): Promise<void> {
    const aggregates = createAutomationAggregateRepository(
      handle.db,
      deps.clock,
    );
    for (const definition of automations) {
      const saved = await aggregates.save(
        definition,
        definition.scope?.type === "next_publication"
          ? (pendingBaselines.get(definition.id) ?? [])
          : undefined,
      );
      if (!saved.ok) {
        throw new Error(
          `fixture automation "${definition.id}" was refused: ${saved.conflict}`,
        );
      }
    }
  }

  /**
   * The queued SENDS. The suspension shares the table (ADR-005), and counting
   * it as an action would make every assertion about what a contact receives
   * one too many.
   */
  function queued(): Promise<
    { payload: unknown; executionId: string | null }[]
  > {
    return createDurableWorkStore(handle.db)
      .due(new Date(8.64e15))
      .then((items) =>
        items
          .filter((item) => item.kind === "send")
          .map((item) => ({
            payload: item.payload,
            executionId: item.executionId,
          })),
      );
  }

  function texts(items: { payload: unknown }[]): string {
    return items.map((item) => JSON.stringify(item.payload)).join(" | ");
  }

  beforeEach(() => {
    handle = openDatabase({ databasePath: IN_MEMORY_DATABASE });
    now = T0;
    const clock = { now: () => now };
    deps = {
      clock,
      automationAggregates: createAutomationAggregateRepository(
        handle.db,
        clock,
      ),
      work: createDurableWorkStore(handle.db),
      conversations: createConversationStore(handle.db),
      contacts: createContactRepository(handle.db, () => now),
      assets: createMemoryAssets({ [COVER]: RESOURCE_URL }),
      random: { next: (): number => 0 },
      audit: createAuditRepository(handle.db),
      runs: createAutomationRunStore(handle.db),
      messageWindowHours: 24,
      instanceSettings: fixedInstanceSettings(),
    };
  });

  afterEach(() => {
    handle.close();
  });

  /**
   * The same dependencies under a clock that never hands out one instant
   * twice, for the cases that run two dispatches concurrently.
   *
   * A frozen clock would compose the SAME execution id for both runs (see
   * `executionIdFor` in `dispatch.ts`), and the queue would then collapse
   * their sends by identity: the case would pass while proving nothing about
   * the rule it is written for. A real clock ticks, so this one does too.
   */
  function tickingClock(): DispatchDeps {
    let tick = 0;

    return {
      ...deps,
      clock: {
        now: (): Date => {
          tick += 1;
          return new Date(T0.getTime() + tick);
        },
      },
    };
  }

  describe("REQ-204 and REQ-205: instance trigger switches", () => {
    it("suppresses a disabled channel with its own reason and runs no automation", async () => {
      await install([anchorAutomation()]);
      deps = {
        ...deps,
        triggerSwitches: {
          read: () =>
            Promise.resolve({
              all: { enabled: true },
              comments: { enabled: false, updatedAt: T0 },
              directMessages: { enabled: true },
            }),
          choose: () => Promise.reject(new Error("not used")),
          allows: () => Promise.resolve(false),
        },
      };

      await createDispatcher(deps)(commentPayload(), EVENT);

      expect(await queued()).toHaveLength(0);
      const trail = await deps.audit.query({ eventId: EVENT });
      expect(trail).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            outcome: "ok",
            subtype: "comment",
          }),
          expect.objectContaining({
            outcome: "suppressed",
            reason: "trigger_switch_comments_disabled",
          }),
        ]),
      );
    });

    it("lets Tudo override both channels without changing their stored values", async () => {
      await install([menuAutomation()]);
      const state = {
        all: { enabled: false, updatedAt: T0 },
        comments: { enabled: true },
        directMessages: { enabled: true },
      } as const;
      deps = {
        ...deps,
        triggerSwitches: {
          read: () => Promise.resolve(state),
          choose: () => Promise.reject(new Error("not used")),
          allows: () => Promise.resolve(false),
        },
      };

      await createDispatcher(deps)(messagePayload(), EVENT);

      expect(await queued()).toHaveLength(0);
      expect(state.directMessages.enabled).toBe(true);
      expect(
        (await deps.audit.query({ eventId: EVENT })).some(
          (entry) =>
            entry.outcome === "suppressed" &&
            entry.reason === "trigger_switch_all_disabled",
        ),
      ).toBe(true);
    });

    it("REQ-234: a disabled channel still records that the contact wrote", async () => {
      // The switch stops the CONSEQUENCE of the event, never the fact that it
      // arrived. The platform received the same message and counted a fresh
      // window from it; an instance that skipped the mark would come back from
      // the emergency stop believing the conversation is closed, ask a question
      // REQ-068 should have suppressed, and have its next send refused by the
      // window guard for a window that was in fact open.
      await install([menuAutomation()]);
      deps = {
        ...deps,
        triggerSwitches: {
          read: () =>
            Promise.resolve({
              all: { enabled: true },
              comments: { enabled: true },
              directMessages: { enabled: false, updatedAt: T0 },
            }),
          choose: () => Promise.reject(new Error("not used")),
          allows: () => Promise.resolve(false),
        },
      };

      await createDispatcher(deps)(messagePayload({ text: "menu" }), EVENT);

      // Suppressed, and yet marked: the two facts are independent.
      expect(await queued()).toHaveLength(0);
      expect(await deps.conversations.lastInboundAt(CONTACT)).toEqual(T0);
    });

    it("REQ-234: a disabled channel marks nothing for a comment", async () => {
      // The guard on the test above: moving the mark earlier must not turn a
      // comment into an open conversation. Commenting does not put the account
      // in the contact's inbox (REQ-066), and a mark here would suppress the
      // very question REQ-068 exists for.
      await install([anchorAutomation()]);
      deps = {
        ...deps,
        triggerSwitches: {
          read: () =>
            Promise.resolve({
              all: { enabled: true },
              comments: { enabled: false, updatedAt: T0 },
              directMessages: { enabled: true },
            }),
          choose: () => Promise.reject(new Error("not used")),
          allows: () => Promise.resolve(false),
        },
      };

      await createDispatcher(deps)(commentPayload(), EVENT);

      expect(await deps.conversations.lastInboundAt(CONTACT)).toBeUndefined();
    });

    it("dispatches normally while every switch is on", async () => {
      // The guard on the two above: a dispatcher that suppressed everything
      // would pass them both and be reported as honouring the switches.
      await install([menuAutomation()]);
      deps = {
        ...deps,
        triggerSwitches: {
          read: () =>
            Promise.resolve({
              all: { enabled: true },
              comments: { enabled: true },
              directMessages: { enabled: true },
            }),
          choose: () => Promise.reject(new Error("not used")),
          allows: () => Promise.resolve(true),
        },
      };

      await createDispatcher(deps)(
        messagePayload({ text: "yes please" }),
        EVENT,
      );

      expect(texts(await queued())).toContain("the menu ran");
    });
  });

  it("turns a matching comment into an execution and queued actions", async () => {
    await install([anchorAutomation()]);

    await createDispatcher(deps)(commentPayload(), EVENT);

    const items = await queued();
    // The public reply and the confirmation: both decided by the engine, both
    // durable rows rather than calls, which is what survives a restart.
    expect(items).toHaveLength(2);
    expect(texts(items)).toContain("check your DMs");
    expect(texts(items)).toContain("shall I send you the guide?");
    // Nothing carrying the resource has gone out yet (REQ-066).
    expect(texts(items)).not.toContain(RESOURCE_URL);

    const trail = await deps.audit.query({ contactId: CONTACT });
    expect(
      trail.filter((entry) => entry.kind === "action_executed").length,
    ).toBe(2);
    expect(trail.every((entry) => entry.eventId === EVENT)).toBe(true);
  });

  it("REQ-213/REQ-226: executes the active aggregate's own captured steps, with no flow anywhere", async () => {
    await install([
      automation({
        id: "owned-automation",
        state: "active",
        trigger: {
          type: "comment",
          target: "media-1",
          match: { keywords: ["guide"], mode: "contains" },
        },
        steps: [
          {
            id: "reply",
            action: "reply_comment",
            text: ["from the aggregate", "alternate reply"],
          },
          {
            id: "dm",
            action: "send_dm",
            message: { text: "owned private message" },
          },
        ],
      }),
    ]);

    // Nothing but the aggregate is stored. A live flow lookup would leave the
    // queue empty and record a missing-flow failure.
    await createDispatcher(deps)(commentPayload(), EVENT);

    const sent = texts(await queued());
    // The first wording, drawn by a source scripted to 0 (REQ-126).
    expect(sent).toContain("from the aggregate");
    expect(sent).toContain("owned private message");
    expect(await deps.audit.query({ outcome: "failed" })).toStrictEqual([]);
  });

  /**
   * A comment is answered by the automation of ITS publication, and by no
   * other.
   *
   * This is what remains after phase 3k removed the account-wide comment target
   * with REQ-218: there is no longer an arbitration between a global automation
   * and the publication's own, so what has to be pinned is the plain
   * consequence — the neighbour's automation never answers here, and an
   * uncovered publication is answered by nobody at all.
   */
  describe("a comment reaches only the automation of its own publication", () => {
    beforeEach(async () => {
      await install([
        replying("other-automation", "media-2", "other reply"),
        replying("specific-automation", "media-1", "specific reply"),
      ]);
    });

    it("runs the automation of the publication the comment arrived on", async () => {
      await createDispatcher(deps)(commentPayload(), EVENT);

      const sent = texts(await queued());
      expect(sent).toContain("specific reply");
      expect(sent).not.toContain("other reply");
      // Never started, rather than started and dropped later: a claim would
      // have suppressed the neighbour for this contact for ever.
      expect(
        await createAutomationRunStore(handle.db).hasRun(
          "other-automation",
          CONTACT,
        ),
      ).toBe(false);
    });

    it("snapshots execution, scope and publication on the actions it records", async () => {
      await createDispatcher(deps)(commentPayload(), EVENT);

      const receipt = (await deps.audit.query({ eventId: EVENT })).find(
        (entry) => entry.kind === "event_received",
      );
      const action = (await deps.audit.query({ eventId: EVENT })).find(
        (entry) => entry.kind === "action_executed",
      );

      expect(receipt).toMatchObject({ publicationId: "media-1" });
      expect(action).toMatchObject({
        automationId: "specific-automation",
        executionId: expect.stringMatching(/^specific-automation:/),
        automationScope: "publication",
        publicationId: "media-1",
        matchedKeyword: "guide",
      });
    });

    it("answers nothing once that publication's automation is gone", async () => {
      const dispatch = createDispatcher(deps);
      await dispatch(commentPayload(), EVENT);

      await createAutomationAggregateRepository(handle.db, deps.clock).remove(
        "specific-automation",
      );
      now = new Date(T0.getTime() + HOUR);
      await dispatch(commentPayload({ commentId: "comment-2" }), "event-2");

      // Silence, and never the neighbour's answer: with no account-wide
      // fallback left, an uncovered publication has nobody to answer for it.
      expect(texts(await queued())).not.toContain("other reply");
    });

    it("answers the other publication with its own automation", async () => {
      await createDispatcher(deps)(
        commentPayload({ mediaId: "media-2", commentId: "comment-2" }),
        EVENT,
      );

      const sent = texts(await queued());
      expect(sent).toContain("other reply");
      expect(sent).not.toContain("specific reply");
    });
  });

  describe("REQ-370 and REQ-371: comment scope precedence and pending binding", () => {
    it("runs a matching specific alone when an equivalent global also matches", async () => {
      await install([
        replying("specific", "media-1", "specific reply", {
          scope: { type: "publication", publicationId: "media-1" },
        }),
        replying("global", "ignored", "global reply", {
          scope: { type: "global" },
          trigger: {
            type: "comment",
            match: { keywords: ["guide"], mode: "contains" },
          },
        }),
      ]);

      await createDispatcher(deps)(commentPayload(), EVENT);

      const sent = texts(await queued());
      expect(sent).toContain("specific reply");
      expect(sent).not.toContain("global reply");
    });

    it("binds the pending automation before the comment that revealed its publication is matched", async () => {
      await install([
        replying("pending", "ignored", "new publication reply", {
          scope: { type: "next_publication" },
          trigger: {
            type: "comment",
            match: { keywords: ["guide"], mode: "contains" },
          },
        }),
      ]);

      await createDispatcher(deps)(
        commentPayload({ mediaId: "media-new" }),
        EVENT,
      );

      expect(texts(await queued())).toContain("new publication reply");
      await expect(
        deps.automationAggregates.findById("pending"),
      ).resolves.toMatchObject({
        definition: {
          scope: { type: "publication", publicationId: "media-new" },
          trigger: { target: "media-new" },
        },
      });
    });

    it("does not consume a pending automation for an id present in its activation baseline", async () => {
      await install(
        [
          replying("pending", "ignored", "new publication reply", {
            scope: { type: "next_publication" },
            trigger: {
              type: "comment",
              match: { keywords: ["guide"], mode: "contains" },
            },
          }),
        ],
        new Map([["pending", ["media-1"]]]),
      );

      await createDispatcher(deps)(commentPayload(), EVENT);

      expect(texts(await queued())).not.toContain("new publication reply");
      await expect(
        deps.automationAggregates.findById("pending"),
      ).resolves.toMatchObject({
        definition: { scope: { type: "next_publication" } },
      });

      await createDispatcher(deps)(
        commentPayload({
          mediaId: "media-new",
          from: "contact-new",
          commentId: "comment-new",
        }),
        "event-new",
      );

      expect(texts(await queued())).toContain("new publication reply");
    });
  });

  it("queues each send under the run's origin and window instant", async () => {
    await install([anchorAutomation()]);

    await createDispatcher(deps)(commentPayload(), EVENT);

    const reply = (await queued()).find((item) =>
      JSON.stringify(item.payload).includes("check your DMs"),
    );
    // The window counts from the COMMENT, not from the moment the process got
    // round to the event: a run answering under the wrong instant answers under
    // the wrong window.
    expect(reply?.payload).toMatchObject({
      action: "reply_comment",
      commentId: "comment-1",
      since: T0.toISOString(),
    });
  });

  it("names the automation, the contact and the instant in the execution id", async () => {
    await install([anchorAutomation()]);

    await createDispatcher(deps)(commentPayload(), EVENT);

    const [item] = await queued();
    // The suspension record keeps this id and nothing else, so the automation
    // has to be readable out of it for the resume to find the same aggregate.
    expect(item?.executionId).toMatch(/^anchor-automation:contact-1:.+$/);
  });

  /**
   * The ORDER, which is the requirement and not an implementation detail: the
   * event goes to the contact's suspended runs FIRST, and an event the wait
   * ACCEPTED stops there and is never offered to trigger matching.
   *
   * Only that half lives here. What the wait REFUSES does go on to matching
   * since REQ-242, and the block below owns that side of the order.
   */
  describe("REQ-067: the wait is offered the event before matching is", () => {
    it("offers the event to the suspended run first, and an ACCEPTED answer never to matching", async () => {
      // Both automations are installed and both are ready: the comment one
      // suspends the run, the message one would fire on the very word that ends
      // the wait. Only the resume may happen.
      await install([anchorAutomation(), menuAutomation()]);
      const dispatch = createDispatcher(deps);

      await dispatch(commentPayload(), EVENT);
      now = new Date(T0.getTime() + HOUR);
      // The words on the button, typed rather than tapped, which is what the
      // confirmation accepts since REQ-250 and what the menu automation is
      // standing there ready to match.
      await dispatch(messagePayload({ text: "Yes" }), "event-2");

      const items = await queued();
      // The wait ended and the resource went out.
      expect(texts(items)).toContain(RESOURCE_URL);
      // And the automation that was standing right there did not run: a second
      // run beside the one it unblocked would deliver to this contact twice.
      expect(texts(items)).not.toContain("the menu ran");
      expect(
        await createAutomationRunStore(handle.db).hasRun(
          "menu-automation",
          CONTACT,
        ),
      ).toBe(false);
    });

    it("a tapped button resumes the run, and reaches no trigger either", async () => {
      // The comment-born confirmation goes out as a postback button, so the
      // answer comes back as a postback and NOT as a message. Both automations
      // are installed and both are ready: the comment one suspended the run, the
      // message one would fire on the very word printed on the button. Only the
      // resume may happen, or the contact receives the resource twice.
      await install([anchorAutomation(), menuAutomation()]);
      const dispatch = createDispatcher(deps);

      await dispatch(commentPayload(), EVENT);
      now = new Date(T0.getTime() + HOUR);
      await dispatch(postbackPayload({ title: "Yes" }), "event-2");

      const items = await queued();
      expect(texts(items)).toContain(RESOURCE_URL);
      expect(texts(items)).not.toContain("the menu ran");
      expect(
        await createAutomationRunStore(handle.db).hasRun(
          "menu-automation",
          CONTACT,
        ),
      ).toBe(false);
      // The tap also opened the conversation, exactly as typing would have.
      expect(await deps.conversations.lastInboundAt(CONTACT)).toEqual(T0);
    });

    it("REQ-066: a comment cannot end a wait, only a message can", async () => {
      // The failure this guards is the whole point of the phase. Someone comments
      // the keyword, receives the question, never answers it, and comments again.
      // If a comment ended the wait they would be handed the link having
      // consented to nothing, and the confirmation would become a formality
      // anyone can skip by commenting twice.
      await install([anchorAutomation()]);
      const dispatch = createDispatcher(deps);

      await dispatch(commentPayload(), EVENT);
      expect(texts(await queued())).not.toContain(RESOURCE_URL);

      now = new Date(T0.getTime() + HOUR);
      await dispatch(commentPayload({ commentId: "comment-2" }), "event-2");

      // Still no resource: the wait is untouched, and the second comment was
      // offered to matching like any other comment.
      expect(texts(await queued())).not.toContain(RESOURCE_URL);
    });

    it("matches normally when the contact has nothing waiting", async () => {
      // The other side of the same rule: without a wait, the identical message
      // must reach matching. Otherwise the test above would pass on a dispatcher
      // that simply never matches direct messages.
      await install([menuAutomation()]);

      await createDispatcher(deps)(
        messagePayload({ text: "yes please" }),
        EVENT,
      );

      expect(texts(await queued())).toContain("the menu ran");
    });
  });

  /**
   * REQ-241 to REQ-244: the wait has the FIRST word and the trigger has the
   * SECOND, and the order between the two is the requirement.
   *
   * The block above proves the half that must never move: an answer the wait
   * ACCEPTED stops there. What is added here is the other half, and the two are
   * only safe together. A refused message was never an answer to anything, so
   * it goes on to matching exactly as if the contact were waiting for nothing,
   * and a trigger that fires ends the waiting run and begins its own. That
   * became safe when the confirmation stopped accepting anything but the words
   * on its own button (REQ-250): before it, a keyword typed mid-confirmation
   * was already stored as consent, and there was nothing left to fall through
   * with.
   *
   * Every case here is written against a DIRECT-MESSAGE automation whose
   * keyword no wait of this file accepts as an answer, because the interesting
   * message is the one that is refused by the wait and matched by a trigger.
   * With one fixture doing both jobs the cases would be indistinguishable from
   * each other.
   */
  describe("REQ-241: the wait has the first word, the trigger the second", () => {
    /** The waits still holding this contact. */
    function waitingRuns(): Promise<(string | null)[]> {
      return createDurableWorkStore(handle.db)
        .pendingSuspensionsFor(CONTACT)
        .then((items) => items.map((item) => item.executionId));
    }

    /** The trail's account of every wait that ended with nothing delivered. */
    async function endings(): Promise<{ stepId?: string; reason?: string }[]> {
      const trail = await deps.audit.query({ contactId: CONTACT });
      return trail
        .filter((entry) => entry.subtype === "wait_ended")
        .map((entry) => ({ ...entry }));
    }

    /** How many queued messages carry these words. One row is one message. */
    async function sendsSaying(words: string): Promise<number> {
      const items = await queued();
      return items.filter((item) =>
        JSON.stringify(item.payload).includes(words),
      ).length;
    }

    /**
     * The anchor's own wait row, whatever became of it.
     *
     * Found by the key the suspension composed, which carries the INSTANT the
     * run started: reading the pending rows instead would find nothing once a
     * supersession concluded the very row these cases are about.
     */
    function confirmWaitOf(startedAt: Date) {
      return createDurableWorkStore(handle.db).findByKey(
        `suspend:anchor-automation:${CONTACT}:${startedAt.getTime().toString(36)}:confirm`,
      );
    }

    /** The same row for the ordinary case, where the comment arrived at T0. */
    function confirmWait() {
      return confirmWaitOf(T0);
    }

    /** Puts the contact in the anchor's confirmation, waiting. */
    async function waitingAtConfirmation(): Promise<void> {
      await createDispatcher(deps)(commentPayload(), EVENT);
      expect(await waitingRuns()).toHaveLength(1);
      now = new Date(T0.getTime() + HOUR);
    }

    it("REQ-241: an answer the wait ACCEPTS never reaches the trigger", async () => {
      // The most expensive thing in this whole task to get wrong, and the one
      // the fall through below must not cost. The menu automation fires on the
      // very word printed on the confirmation's button, so a build that offered
      // an accepted answer to matching would hand this contact the resource
      // twice: once from the run that finally unblocked, once from a run that
      // should never have existed.
      await install([anchorAutomation(), menuAutomation()]);
      await waitingAtConfirmation();

      await createDispatcher(deps)(messagePayload({ text: "Yes" }), "event-2");

      const items = texts(await queued());
      expect(items).toContain(RESOURCE_URL);
      expect(items).not.toContain("the menu ran");
      expect(
        await createAutomationRunStore(handle.db).hasRun(
          "menu-automation",
          CONTACT,
        ),
      ).toBe(false);
      // The wait ended by being ANSWERED, and not by being taken: a
      // supersession row here would say a second run started, which is the
      // failure itself wearing the right result.
      expect(await endings()).toHaveLength(0);
    });

    it("REQ-242: a message the wait REFUSED starts the automation it matched", async () => {
      // The contact was asked to confirm, went quiet, and days later wrote
      // about something else entirely. Before this they stayed stuck to a
      // conversation they had left, and the automation their words matched
      // never ran.
      await install([anchorAutomation(), catalogueAutomation()]);
      await waitingAtConfirmation();

      await createDispatcher(deps)(
        messagePayload({ text: "send me the catalogue" }),
        "event-2",
      );

      const items = texts(await queued());
      expect(items).toContain("the catalogue ran");
      // The waiting run ENDED, and it delivered nothing on the way out: the
      // contact confirmed nothing, so the file it was guarding stays guarded.
      expect(items).not.toContain(RESOURCE_URL);
      expect(await waitingRuns()).toHaveLength(0);
      expect(await endings()).toEqual([
        expect.objectContaining({
          stepId: "confirm",
          reason: t("suspension.superseded", {
            automation: "catalogue-automation",
          }),
        }),
      ]);
    });

    it("REQ-243: the question is NOT asked again when a trigger took the contact", async () => {
      // Two messages would arrive together otherwise, and the second would come
      // from an automation that is dying: the contact reads the catalogue they
      // asked for, and under it the confirmation of a run that no longer
      // exists, offering a button that can never be answered.
      await install([anchorAutomation(), catalogueAutomation()]);
      await waitingAtConfirmation();

      await createDispatcher(deps)(
        messagePayload({ text: "send me the catalogue" }),
        "event-2",
      );

      // The first question was pending when the trigger superseded its run,
      // so it cannot arrive beside the new automation's reply.
      expect(await sendsSaying("shall I send you the guide?")).toBe(0);
    });

    it("REQ-243: no attempt is spent when a trigger took the contact", async () => {
      // The count pays for a question. No question went out, so nothing may be
      // taken: the routing used to spend it before this decision was even made,
      // and the contact would have paid for the silence.
      await install([anchorAutomation(), catalogueAutomation()]);
      await waitingAtConfirmation();

      await createDispatcher(deps)(
        messagePayload({ text: "send me the catalogue" }),
        "event-2",
      );

      const wait = await confirmWait();
      expect(wait?.attempts).toBe(0);
      // And the row is closed, by the supersession rather than by a ceiling.
      expect(wait?.status).toBe("done");
    });

    it("REQ-243: the refused message that matched NOTHING is asked again, and pays for it", async () => {
      // The other side of the same rule, and without it the two cases above
      // would pass on a dispatcher that simply stopped re-asking. The contact
      // is still in the conversation, so the question goes back out, whole, and
      // the ask is counted where it always was.
      await install([anchorAutomation(), catalogueAutomation()]);
      await waitingAtConfirmation();

      await createDispatcher(deps)(
        messagePayload({ text: "who is this?" }),
        "event-2",
      );

      expect(await sendsSaying("shall I send you the guide?")).toBe(2);
      expect(texts(await queued())).not.toContain("the catalogue ran");

      const wait = await confirmWait();
      expect(wait?.attempts).toBe(1);
      expect(wait?.status).toBe("pending");
      expect(await waitingRuns()).toHaveLength(1);
    });

    it("REQ-243: an automation stopped by once-per-contact takes nobody, so the question returns", async () => {
      // The boundary between the two halves, and it is decided by whether a run
      // BEGAN rather than by whether a keyword matched (REQ-237). This contact
      // has already had the catalogue, so nothing starts and nothing is
      // superseded: they are still in the confirmation they were in, and
      // dropping them into silence would leave a wait alive with no way for
      // them to see it.
      await install([anchorAutomation(), catalogueAutomation()]);
      // The mark written directly, rather than by dispatching a first message.
      // A message would open the conversation, and an open conversation makes
      // the confirmation skip its question entirely (REQ-068): the case would
      // then be about a wait that never existed.
      await createAutomationRunStore(handle.db).claim(
        "catalogue-automation",
        CONTACT,
        "catalogue-automation:earlier",
        T0,
      );

      await waitingAtConfirmation();

      await createDispatcher(deps)(
        messagePayload({ text: "the catalogue again" }),
        "event-2",
      );

      expect(await sendsSaying("shall I send you the guide?")).toBe(2);
      expect(await sendsSaying("the catalogue ran")).toBe(0);
      expect((await confirmWait())?.attempts).toBe(1);
      expect(await waitingRuns()).toHaveLength(1);
    });

    it("REQ-160: a message a wait already judged gets no second row about matching", async () => {
      // The trail cost of the new order, and it is a decision rather than an
      // omission. An event judged ONLY by matching owes a row when it fires
      // nothing, or an operator asking why a comment produced no message finds
      // an empty record. A refused message already has that row, written by the
      // wait with the step and the reason on it, and a second one saying no
      // automation matched would make one message look like two events to
      // whoever reads them side by side.
      await install([anchorAutomation(), catalogueAutomation()]);
      await waitingAtConfirmation();

      await createDispatcher(deps)(
        messagePayload({ text: "who is this?" }),
        "event-2",
      );

      const trail = await deps.audit.query({ contactId: CONTACT });
      expect(
        trail.filter((entry) => decodeNoMatch(entry.reason) !== undefined),
      ).toHaveLength(0);
      // And what the operator does find is the wait's own verdict, which
      // answers the same question with more in it.
      expect(
        trail.some(
          (entry) =>
            entry.stepId === "confirm" && entry.outcome === "suppressed",
        ),
      ).toBe(true);
    });

    it("REQ-244: the message that spends the LAST question also reaches the trigger", async () => {
      // The ending that used to be a full stop. The contact answered wrongly
      // until the questions ran out, and what they wrote LAST is a message like
      // any other: it is owed the goodbye, because the wait is already over by
      // then, and it is owed the trigger, because nothing is holding it any
      // more.
      await install([anchorAutomation(), catalogueAutomation()]);
      await waitingAtConfirmation();

      const dispatch = createDispatcher(deps);
      await dispatch(messagePayload({ text: "who is this?" }), "event-2");
      now = new Date(T0.getTime() + 2 * HOUR);
      await dispatch(messagePayload({ text: "still no idea" }), "event-3");
      now = new Date(T0.getTime() + 3 * HOUR);
      await dispatch(
        messagePayload({ text: "send me the catalogue" }),
        "event-4",
      );

      const items = texts(await queued());
      // The goodbye, which this ending owes whatever a trigger does next.
      expect(items).toContain(t("instance.closingMessage"));
      // And the automation the same words matched.
      expect(items).toContain("the catalogue ran");
      // Three questions and no fourth: the ceiling is still a ceiling.
      expect(await sendsSaying("shall I send you the guide?")).toBe(3);
      // Nothing was delivered by the run that ran out.
      expect(items).not.toContain(RESOURCE_URL);
      const wait = await confirmWait();
      expect(wait?.status).toBe("done");
    });
  });

  /**
   * REQ-060. A resumed run must pick up the SAME aggregate it started in, and
   * the execution id is what answers that: the suspension record keeps the id
   * and nothing else. When the aggregate it names is gone, or is no longer
   * executable, the run STOPS. Delivering under an automation the operator
   * withdrew would hand over a resource nobody is offering any more.
   */
  describe("REQ-060: a resumed run picks up the aggregate it started in", () => {
    /** The id the dispatcher builds from automation, contact and instant. */
    const EXECUTION = `anchor-automation:${CONTACT}:${T0.getTime().toString(36)}`;

    it("stops the run when the automation that started it is gone", async () => {
      await install([anchorAutomation()]);
      const dispatch = createDispatcher(deps);
      await dispatch(commentPayload(), EVENT);

      // Deleted while the contact was deciding.
      await createAutomationAggregateRepository(handle.db, deps.clock).remove(
        "anchor-automation",
      );

      now = new Date(T0.getTime() + HOUR);
      await dispatch(messagePayload({ text: "yes" }), "event-2");

      const [entry] = await deps.audit.query({
        eventId: "event-2",
        outcome: "failed",
      });
      // The id is rebuilt from its three parts here, which is also the proof
      // that the resume found its automation by reading the id back.
      expect(entry?.reason).toBe(
        t("dispatch.resumeLostAutomation", { execution: EXECUTION }),
      );
      expect(texts(await queued())).not.toContain(RESOURCE_URL);
    });

    it("stops the run when the automation is no longer active", async () => {
      await install([anchorAutomation()]);
      const dispatch = createDispatcher(deps);
      await dispatch(commentPayload(), EVENT);

      // Paused back to a draft while the contact was deciding: a draft is not
      // executable, so the half-finished run must not be carried into it.
      await createAutomationAggregateRepository(handle.db, deps.clock).save(
        anchorAutomation({ state: "draft" }),
      );

      now = new Date(T0.getTime() + HOUR);
      await dispatch(messagePayload({ text: "yes" }), "event-2");

      const [entry] = await deps.audit.query({
        eventId: "event-2",
        outcome: "failed",
      });
      expect(entry?.kind).toBe("event_received");
      expect(entry?.reason).toContain(EXECUTION);
      // The trail says what actually happened. It used to say the automation
      // had been re-pointed at another flow, which after phase 3k cannot occur
      // and never occurred here.
      expect(entry?.reason).toBe(
        t("dispatch.resumeAutomationInactive", { execution: EXECUTION }),
      );
      // Nothing was delivered under an automation nobody is running.
      expect(texts(await queued())).not.toContain(RESOURCE_URL);
    });
  });

  it("REQ-226: carries the aggregate's resource to send time, and refuses it if it vanished", async () => {
    await install([anchorAutomation()]);

    const assets = createMemoryAssets({ [COVER]: RESOURCE_URL });
    const dispatch = createDispatcher({ ...deps, assets });

    // The first pass stops at the confirmation, so no URL resolution happens
    // while the run is being bound or while the question is sent (REQ-066).
    await dispatch(commentPayload(), EVENT);
    expect(texts(await queued())).not.toContain(RESOURCE_URL);

    let requestedName: string | undefined;
    assets.publicUrl = async (name) => {
      requestedName = name;
      throw new Error(`asset "${name}" does not exist`);
    };

    now = new Date(T0.getTime() + HOUR);
    await dispatch(messagePayload({ text: "yes" }), "event-2");

    // The missing object is refused before the sender is called: the contact
    // receives neither a stale URL nor a partial second delivery.
    expect(requestedName).toBe(COVER);
    expect(texts(await queued())).not.toContain(RESOURCE_URL);

    const failed = (await deps.audit.query({ contactId: CONTACT })).find(
      (entry) =>
        entry.kind === "action_executed" &&
        entry.stepId === "deliver" &&
        entry.outcome === "failed",
    );
    // The code says what happened; what the storage answered travels beside it
    // as data, never as a sentence this application chose (REQ-171).
    expect(decodeExecutionFailure(failed?.reason)).toMatchObject({
      reason: "unexpected_error",
      detail: expect.stringContaining(COVER),
    });
  });

  it("records and drops a postback it cannot read, instead of throwing", async () => {
    await install([anchorAutomation()]);

    // No sender: there is no contact to resume for and none to run against, so
    // the only honest thing is to drop it with the fact on the record.
    await expect(
      createDispatcher(deps)(
        {
          object: "instagram",
          entry: [{ id: ACCOUNT, messaging: [{ postback: { title: "Yes" } }] }],
        },
        EVENT,
      ),
    ).resolves.toBeUndefined();

    expect(await queued()).toHaveLength(0);
    const [entry] = await deps.audit.query({ eventId: EVENT });
    expect(entry?.reason).toBe(UNREADABLE_INBOUND_REASON);
  });

  it("creates no execution when nothing matches, and records the fact", async () => {
    await install([anchorAutomation()]);

    await createDispatcher(deps)(
      commentPayload({ text: "nice picture" }),
      EVENT,
    );

    expect(await queued()).toHaveLength(0);
    const [entry] = await deps.audit.query({
      eventId: EVENT,
      outcome: "suppressed",
    });
    expect(entry?.kind).toBe("event_received");
    // The reason the one installed automation gave, and not a sentence about
    // matching in general (REQ-160).
    expect(decodeNoMatch(entry?.reason)).toEqual([
      { reason: "no_keyword", count: 1 },
    ]);
    expect(entry?.contactId).toBe(CONTACT);
  });

  /**
   * REQ-160. `matchAutomation` computes one of the declared reasons for every
   * automation that stays silent, and every one of them used to be dropped by
   * the loop above it. The row that reached the trail said "no automation
   * matched", which is the operator's own question repeated back at them: a
   * keyword that missed, a comment on another publication and an automation
   * somebody paused all read the same.
   */
  describe("REQ-160: the trail says WHY nothing fired", () => {
    /** The one row that accounts for the decision, not the arrival receipt. */
    function decisions(eventId = EVENT) {
      return deps.audit.query({
        kind: "event_received",
        outcome: "suppressed",
        eventId,
      });
    }

    /** A comment automation, made to refuse for one particular reason. */
    function refusing(
      id: string,
      trigger: Record<string, unknown>,
      overrides: Record<string, unknown> = {},
    ): UnifiedAutomation {
      return automation({
        id,
        state: "active",
        trigger,
        steps: [
          {
            id: "menu",
            action: "send_dm",
            message: { text: "the menu ran" },
          },
        ],
        ...overrides,
      });
    }

    const commentOn = (
      target: string,
      keywords: string[],
      mode = "contains",
    ): Record<string, unknown> => ({
      type: "comment",
      target,
      match: { keywords, mode },
    });

    /**
     * Three reasons and not four, and the ceiling is REQ-217 rather than a
     * gap in this test. A publication holds at most ONE comment automation, so
     * the reasons that require the event's own publication (`disabled`,
     * `no_keyword`) compete for a single slot and only one of them can be
     * present in a real store. The remaining two have no ceiling: any number of
     * automations may watch other publications or answer direct messages. Every
     * one of the four is exercised together in `flows/matching.test.ts`, which
     * needs no store to hold them.
     */
    it("names every reason with the count of automations in each, in ONE entry", async () => {
      await install([
        // A draft is the v2 way an automation is switched off: it stays stored
        // and stops being executable. This is the one holding media-1.
        refusing("switched-off", commentOn("media-1", ["guide"]), {
          state: "draft",
        }),
        refusing("only-messages", {
          type: "direct_message",
          match: { keywords: ["guide"], mode: "contains" },
        }),
        refusing("other-publication", commentOn("media-2", ["guide"])),
        refusing("exact-elsewhere", commentOn("media-3", ["guide"], "exact")),
      ]);

      await createDispatcher(deps)(commentPayload(), EVENT);

      const rows = await decisions();
      // ONE row for the event, whatever the number of automations that
      // refused: a row per refusal would be two thousand a day at twenty
      // automations and a hundred comments.
      expect(rows).toHaveLength(1);
      expect(decodeNoMatch(rows[0]?.reason)).toEqual([
        { reason: "disabled", count: 1 },
        { reason: "wrong_origin", count: 1 },
        // Both of the remaining two watch another publication, so the target is
        // what refuses them first and they land under the same reason.
        { reason: "wrong_target", count: 2 },
      ]);
      // Written at the instant of the record, like every other row (REQ-106).
      expect(rows[0]?.subtype).toBe("comment");
      expect(rows[0]?.contactId).toBe(CONTACT);
    });

    it("counts the automations behind each reason rather than listing them", async () => {
      await install(
        Array.from({ length: 20 }, (_, index) =>
          refusing(
            `missed-${String(index + 1)}`,
            commentOn(`media-other-${String(index + 1)}`, ["guide"]),
          ),
        ),
      );

      await createDispatcher(deps)(commentPayload(), EVENT);

      const rows = await decisions();
      expect(rows).toHaveLength(1);
      expect(decodeNoMatch(rows[0]?.reason)).toEqual([
        { reason: "wrong_target", count: 20 },
      ]);
    });

    it("records the event that met no automation at all, refusing nothing", async () => {
      await install([]);

      await createDispatcher(deps)(commentPayload(), EVENT);

      // An empty aggregate is an answer: nothing refused this comment because
      // there was nothing to refuse it. Distinct from a reason a reader cannot
      // parse, which comes back undefined.
      const rows = await decisions();
      expect(rows).toHaveLength(1);
      expect(decodeNoMatch(rows[0]?.reason)).toEqual([]);
    });

    it("writes no decision row for an event that DID fire", async () => {
      await install([anchorAutomation()]);

      await createDispatcher(deps)(commentPayload(), EVENT);

      // The guard on the row above: an aggregate written for every event would
      // report a refusal beside the run that actually happened.
      expect(await decisions()).toHaveLength(0);
    });
  });

  /**
   * REQ-161. The platform echoes back every message the application sends, and
   * each echo used to become a row saying "nothing to dispatch": one line of
   * noise per delivery, written with no subtype, so the panel counted every
   * message the account SENT as an inbound event of unknown type.
   */
  describe("REQ-161: the echo of our own message leaves no trace", () => {
    it("writes nothing at all for a delivery that is only an echo", async () => {
      await install([anchorAutomation()]);

      // The shape the platform actually sends: our own message coming back,
      // with the account as the sender and the echo flag on it.
      await createDispatcher(deps)(
        messagePayload({ from: ACCOUNT, isEcho: true }),
        EVENT,
      );

      expect(await deps.audit.query({ eventId: EVENT })).toHaveLength(0);
      expect(await queued()).toHaveLength(0);
    });

    it("correlates an echo to the accepted outbound message, never as inbound", async () => {
      await deps.audit.record(
        {
          kind: "action_executed",
          subtype: "message_sent",
          outcome: "ok",
          contactId: CONTACT,
          executionId: "guide:contact:run",
          platformMessageId: "mid-echo",
          reason: "platform_accepted",
        },
        T0,
      );

      await createDispatcher(deps)(
        messagePayload({
          from: ACCOUNT,
          recipient: CONTACT,
          isEcho: true,
          mid: "mid-echo",
        }),
        EVENT,
      );

      expect(await deps.audit.query({ eventId: EVENT })).toEqual([
        expect.objectContaining({
          executionId: "guide:contact:run",
          platformMessageId: "mid-echo",
          reason: "platform_echo",
        }),
      ]);
    });

    it("still records a payload it could not read, distinguishably", async () => {
      await install([anchorAutomation()]);

      await createDispatcher(deps)({ object: "instagram", entry: [{}] }, EVENT);

      // The other half of the requirement: this one keeps its row, and the row
      // says what happened. The echo above has none at all, so no reader can
      // confuse the two, which is exactly what the single shared row did.
      const rows = await deps.audit.query({ eventId: EVENT });
      expect(rows).toHaveLength(1);
      expect(rows[0]?.reason).toBe(UNREADABLE_INBOUND_REASON);
    });

    it("dispatches the real message that shared a delivery with an echo", async () => {
      await install([menuAutomation()]);

      // The silence belongs to a delivery that produced NO interaction. One
      // that also carried a contact's message is dispatched as usual, or a
      // batched delivery would swallow somebody's answer.
      await createDispatcher(deps)(
        {
          object: "instagram",
          entry: [
            {
              id: ACCOUNT,
              time: Math.floor(T0.getTime() / 1000),
              messaging: [
                {
                  sender: { id: ACCOUNT },
                  recipient: { id: CONTACT },
                  timestamp: T0.getTime(),
                  message: { mid: "mid-echo", text: "ours", is_echo: true },
                },
                {
                  sender: { id: CONTACT },
                  recipient: { id: ACCOUNT },
                  timestamp: T0.getTime(),
                  message: { mid: "mid-1", text: "yes please" },
                },
              ],
            },
          ],
        },
        EVENT,
      );

      expect(texts(await queued())).toContain("the menu ran");
    });
  });

  it("records and drops a payload it cannot read, instead of throwing", async () => {
    await install([anchorAutomation()]);

    // A shape this build does not know must not reach the webhook's catch: the
    // response has already gone out, so the delivery is never coming again.
    await expect(
      createDispatcher(deps)({ object: "instagram", entry: [{}] }, EVENT),
    ).resolves.toBeUndefined();

    expect(await queued()).toHaveLength(0);
    const [entry] = await deps.audit.query({ eventId: EVENT });
    expect(entry?.reason).toBe(UNREADABLE_INBOUND_REASON);
  });

  it("REQ-015: the same contact firing twice runs once, with the reason kept", async () => {
    await install([plainAutomation()]);
    const dispatch = createDispatcher(deps);

    await dispatch(commentPayload(), EVENT);
    now = new Date(T0.getTime() + HOUR);
    await dispatch(
      commentPayload({ commentId: "comment-2", text: "the guide again" }),
      "event-2",
    );

    // Still the one send of the first run: the second comment added none.
    expect(await queued()).toHaveLength(1);
    const [suppressed] = await deps.audit.query({
      eventId: "event-2",
      outcome: "suppressed",
    });
    expect(suppressed?.automationId).toBe("plain-automation");
    expect(suppressed?.contactId).toBe(CONTACT);
    expect(suppressed?.reason).toBe(
      t("dispatch.alreadyRan", { automation: "plain-automation" }),
    );
  });

  it("REQ-348: a reply-only automation spends once-per-contact on its public reply", async () => {
    await install([
      replying("public-only-automation", "media-1", "the public answer"),
    ]);
    const dispatch = createDispatcher(deps);

    await dispatch(commentPayload(), EVENT);
    now = new Date(T0.getTime() + HOUR);
    await dispatch(
      commentPayload({ commentId: "comment-2", text: "the guide again" }),
      "event-2",
    );

    expect(texts(await queued()).match(/the public answer/g)).toHaveLength(1);
    expect(
      await createAutomationRunStore(handle.db).hasRun(
        "public-only-automation",
        CONTACT,
      ),
    ).toBe(true);
  });

  it("REQ-348: a public acknowledgement does not spend a private delivery early", async () => {
    await install([anchorAutomation()]);
    const dispatch = createDispatcher(deps);

    await dispatch(commentPayload(), EVENT);

    // The public acknowledgement and opt-in question went out, but the
    // material has not: silence here must leave the contact's chance intact.
    expect(
      await createAutomationRunStore(handle.db).hasRun(
        "anchor-automation",
        CONTACT,
      ),
    ).toBe(false);
  });

  it("REQ-015: runs again for a contact when the automation turns the rule off", async () => {
    await install([
      plainAutomation({
        rules: { once_per_contact: false, first_reply_delay_seconds: 0 },
      }),
    ]);
    const dispatch = createDispatcher(deps);

    await dispatch(commentPayload(), EVENT);
    now = new Date(T0.getTime() + HOUR);
    await dispatch(
      commentPayload({ commentId: "comment-2", text: "the guide again" }),
      "event-2",
    );

    // Two runs, so two sends of the same text: the execution ids differ by the
    // instant, which is the only reason the second is not swallowed by the
    // queue as a duplicate of the first.
    expect(await queued()).toHaveLength(2);
  });

  /**
   * REQ-236, REQ-237 and REQ-238: the last automation triggered holds the
   * contact.
   *
   * The defect this replaces was an accident of configuration and never a
   * decision. A contact could be held by two runs at once, because a comment is
   * never offered to a wait (REQ-067 is about messages): they comment on the
   * first publication, are asked a question and go quiet, then comment on the
   * second and are asked another. When they finally answered, `routeInbound`
   * took the wait with the SOONEST deadline, and with the deadline being one
   * number for the whole instance (REQ-252) that is always the older one. They
   * answered thinking of the second publication and received the material of
   * the first.
   *
   * Every case here is driven through the dispatcher and asserts what the
   * CONTACT receives, because that is where the defect was visible and where a
   * reader can check the rule without holding the queue in their head.
   */
  describe("REQ-236: the run that starts takes the contact with it", () => {
    /** The waits still holding this contact, by the run each belongs to. */
    function waitingRuns(): Promise<(string | null)[]> {
      return createDurableWorkStore(handle.db)
        .pendingSuspensionsFor(CONTACT)
        .then((items) => items.map((item) => item.executionId));
    }

    /** The trail's account of every wait that ended with nothing delivered. */
    async function endings(): Promise<{ stepId?: string; reason?: string }[]> {
      const trail = await deps.audit.query({ contactId: CONTACT });
      return trail
        .filter((entry) => entry.subtype === "wait_ended")
        .map((entry) => ({ ...entry }));
    }

    it("does not end its OWN wait when the same event arrives twice", async () => {
      // The guard the supersession needs against itself, and it had none: with
      // it removed the whole suite stayed green, which is how a guard gets
      // deleted by somebody tidying up.
      //
      // An execution id is the automation, the contact and the INSTANT, so a
      // redelivered comment landing on the same millisecond composes the SAME
      // id as the pass that already ran. Without the skip, the second pass
      // reads the wait the first one wrote, does not recognise it as its own,
      // and ends it: the contact is left holding a card that answers nothing,
      // and the trail blames a supersession by the automation they are already
      // in. The platform redelivers, so this is an ordinary Tuesday.
      //
      // The rule has to be OFF for the second pass to reach the supersession at
      // all: with it on, the claim suppresses the run first and the guard is
      // never asked anything. That is why this case reads as it does.
      await install([
        {
          ...anchorAutomation(),
          rules: { once_per_contact: false, first_reply_delay_seconds: 0 },
        },
      ]);
      const dispatch = createDispatcher(deps);

      await dispatch(commentPayload(), EVENT);
      const first = await waitingRuns();
      expect(first).toHaveLength(1);

      // The SAME instant, which is what makes the id collide. A later one would
      // compose a different run, and a different run SHOULD supersede.
      await dispatch(
        commentPayload({ commentId: "comment-again" }),
        "event-redelivered",
      );

      expect(await waitingRuns()).toEqual(first);
      expect(await endings()).toHaveLength(0);
    });

    it("hands the contact the material of the automation they last triggered", async () => {
      // The whole anchor case of this task, as the user described it: the
      // contact is asked by the first automation and does not answer, comments
      // the second publication, and answers THAT question.
      await install([anchorAutomation(), secondAutomation()]);
      const dispatch = createDispatcher(deps);

      await dispatch(commentPayload(), EVENT);
      now = new Date(T0.getTime() + HOUR);
      await dispatch(
        commentPayload({ mediaId: "media-2", commentId: "comment-2" }),
        "event-2",
      );
      now = new Date(T0.getTime() + 2 * HOUR);
      await dispatch(messagePayload({ text: SECOND_BUTTON }), "event-3");

      const sent = texts(await queued());
      // What they asked for, from the automation they were talking to.
      expect(sent).toContain(SECOND_RESOURCE);
      // And never the first automation's file, which is what the older wait
      // used to hand over: it took the answer because it came due first.
      expect(sent).not.toContain(RESOURCE_URL);
    });

    it("leaves the contact in exactly one wait, the newest", async () => {
      await install([anchorAutomation(), secondAutomation()]);
      const dispatch = createDispatcher(deps);

      await dispatch(commentPayload(), EVENT);
      now = new Date(T0.getTime() + HOUR);
      await dispatch(
        commentPayload({ mediaId: "media-2", commentId: "comment-2" }),
        "event-2",
      );

      // The situation the rule exists to make impossible is two rows here.
      const runs = await waitingRuns();
      expect(runs).toHaveLength(1);
      expect(runs[0]).toMatch(/^second-automation:/);
    });

    it("REQ-238: records the ending with a reason of its own", async () => {
      await install([anchorAutomation(), secondAutomation()]);
      const dispatch = createDispatcher(deps);

      await dispatch(commentPayload(), EVENT);
      now = new Date(T0.getTime() + HOUR);
      await dispatch(
        commentPayload({ mediaId: "media-2", commentId: "comment-2" }),
        "event-2",
      );

      const ended = await endings();
      expect(ended).toHaveLength(1);
      // The step the contact was left at, so the operator can see what they
      // were asked before another automation took them.
      expect(ended[0]?.stepId).toBe("confirm");
      expect(ended[0]?.reason).toBe(
        t("suspension.superseded", { automation: "second-automation" }),
      );

      // The three ways a wait ends without delivering, and no two of them read
      // alike: an operator who cannot tell them apart opens the panel, finds a
      // contact who received nothing, and learns nothing about why.
      const sentences = new Set([
        t("suspension.superseded", { automation: "second-automation" }),
        t("suspension.timedOut", { policy: "abandon" }),
        t("suspension.attemptsExhausted", { attempts: 3, policy: "abandon" }),
      ]);
      expect(sentences.size).toBe(3);
    });

    it("REQ-237: an automation suppressed by once-per-contact ends nothing", async () => {
      // The contact comments the second publication AGAIN, and its automation
      // has already run for them. Nothing starts, so nothing may be taken:
      // they would otherwise lose the run that is still waiting for them, in
      // exchange for a comment that got them nothing at all.
      await install([
        anchorAutomation(),
        plainAutomation({
          trigger: {
            type: "comment",
            target: "media-2",
            match: { keywords: ["guide"], mode: "contains" },
          },
        }),
      ]);
      const dispatch = createDispatcher(deps);

      await dispatch(
        commentPayload({ mediaId: "media-2", commentId: "comment-0" }),
        "event-0",
      );
      now = new Date(T0.getTime() + HOUR);
      await dispatch(commentPayload(), EVENT);
      now = new Date(T0.getTime() + 2 * HOUR);
      await dispatch(
        commentPayload({ mediaId: "media-2", commentId: "comment-2" }),
        "event-2",
      );

      // Still waiting, with nothing on the trail claiming otherwise.
      const runs = await waitingRuns();
      expect(runs).toHaveLength(1);
      expect(runs[0]).toMatch(/^anchor-automation:/);
      expect(await endings()).toStrictEqual([]);

      // And still answerable, which is the fact the contact cares about.
      now = new Date(T0.getTime() + 3 * HOUR);
      await dispatch(messagePayload({ text: "Yes" }), "event-3");
      expect(texts(await queued())).toContain(RESOURCE_URL);
    });

    it("REQ-347: supersession retires the prior run's pending sends", async () => {
      await install([anchorAutomation(), secondAutomation()]);
      const dispatch = createDispatcher(deps);

      await dispatch(commentPayload(), EVENT);
      now = new Date(T0.getTime() + HOUR);
      await dispatch(
        commentPayload({ mediaId: "media-2", commentId: "comment-2" }),
        "event-2",
      );

      // The first run no longer exists, so its public reply and question must
      // not reach the contact after the second automation has taken over.
      const sent = texts(await queued());
      expect(sent).not.toContain("check your DMs");
      expect(sent).not.toContain("shall I send you the guide?");
      expect(sent).toContain("shall I send you the second guide?");
    });

    it("REQ-098: supersedes a run that is paused, not only one waiting for an answer", async () => {
      // The pause is the wait nobody can end by writing, so `routeInbound`
      // leaves it alone. Left alone HERE it would come back on its own clock,
      // long after the contact moved to another automation, and deliver the
      // material of the one they left: the very failure the rule is about,
      // arriving through the one door nobody knocks on.
      await install([pausingAutomation(), secondAutomation()]);
      const dispatch = createDispatcher(deps);

      await dispatch(commentPayload(), EVENT);
      now = new Date(T0.getTime() + 10 * SECOND);
      await dispatch(
        commentPayload({ mediaId: "media-2", commentId: "comment-2" }),
        "event-2",
      );

      // Past the pause, with the sweep wired exactly as the process wires it.
      now = new Date(T0.getTime() + 2 * PAUSE_SECONDS * SECOND);
      const report = await runSweep({
        work: deps.work,
        clock: deps.clock,
        handlers: {
          suspension: createSuspensionTimeoutHandler({
            audit: deps.audit,
            clock: deps.clock,
            resume: createPauseResume(deps),
          }),
        },
      });

      // Nothing came due, because the row is concluded, and the message the
      // paused run was going to send never left.
      expect(report.completed).toBe(0);
      expect(texts(await queued())).not.toContain(PAUSED_RESOURCE);
      expect((await endings())[0]?.stepId).toBe("pause");
    });
  });

  /**
   * REQ-239 and REQ-240: the contact's one chance is spent by the run that
   * DELIVERS.
   *
   * The mark used to be written the instant a run began, and that burned the
   * chance of whoever received nothing: they commented, were asked a question,
   * went quiet, and the automation was shut to them for ever. REQ-236 turned
   * that from the rare case into the ordinary one, because a comment on
   * another publication now ENDS the run they were in, so the rule an operator
   * switches on to avoid a second delivery was preventing the first.
   *
   * What the move costs is the race, and it is paid rather than assumed: two
   * events of one contact arriving together both pass the read that replaced
   * the claim, and the atomic INSERT they both reach at the delivery is what
   * lets exactly one of them hand anything over. The send queue does not do it
   * for us: its identity is per execution and step, and two runs of one
   * automation have different execution ids (see `dedupeKeyFor` in
   * `outbox.ts`).
   */
  describe("REQ-239: the delivery spends the chance, not the start", () => {
    /** The wait's deadline is the instance's 168 hours; this is past it. */
    const PAST_THE_DEADLINE = 200 * HOUR;

    /** The sweep, wired exactly as the process wires it. */
    function sweep(): Promise<unknown> {
      return runSweep({
        work: deps.work,
        clock: deps.clock,
        handlers: {
          suspension: createSuspensionTimeoutHandler({
            audit: deps.audit,
            clock: deps.clock,
            resume: createPauseResume(deps),
          }),
        },
      });
    }

    /** How many of the queued sends carry the anchor automation's file. */
    async function deliveries(): Promise<number> {
      return (await queued()).filter((item) =>
        JSON.stringify(item.payload).includes(RESOURCE_URL),
      ).length;
    }

    it("lets a contact who never answered trigger the same automation again", async () => {
      // Acceptance criterion 3 of the phase, and it was unreachable: the run
      // that asked had already spent the mark, so the contact who answered
      // nothing could never be asked again.
      await install([anchorAutomation()]);
      const dispatch = createDispatcher(deps);

      await dispatch(commentPayload(), EVENT);

      // Asked, never answered, and the deadline passes. The wait ends through
      // the path the flow declared, having delivered nothing.
      now = new Date(T0.getTime() + PAST_THE_DEADLINE);
      await sweep();
      expect(await deliveries()).toBe(0);

      await dispatch(
        commentPayload({ commentId: "comment-2", time: now.getTime() }),
        "event-2",
      );

      // Not suppressed: nothing was ever handed over, so nothing was spent.
      expect(
        await deps.audit.query({ eventId: "event-2", outcome: "suppressed" }),
      ).toStrictEqual([]);

      // And the whole point, which a trail assertion alone would not show:
      // this time they answer, and the file reaches them.
      now = new Date(T0.getTime() + PAST_THE_DEADLINE + HOUR);
      await dispatch(messagePayload({ text: "Yes" }), "event-3");
      expect(await deliveries()).toBe(1);
    });

    it("keeps the chance of a run another automation ended (REQ-236)", async () => {
      // The design question REQ-236 raised and this answers: supersession
      // releases nothing, because a superseded run never spent anything. The
      // contact commented the second publication, which ended the first run,
      // and the first automation is still open to them.
      await install([anchorAutomation(), secondAutomation()]);
      const dispatch = createDispatcher(deps);

      await dispatch(commentPayload(), EVENT);
      now = new Date(T0.getTime() + HOUR);
      await dispatch(
        commentPayload({
          mediaId: "media-2",
          commentId: "comment-2",
          time: now.getTime(),
        }),
        "event-2",
      );

      // Back to the first publication, and its automation runs again.
      now = new Date(T0.getTime() + 2 * HOUR);
      await dispatch(
        commentPayload({ commentId: "comment-3", time: now.getTime() }),
        "event-3",
      );
      expect(
        await deps.audit.query({ eventId: "event-3", outcome: "suppressed" }),
      ).toStrictEqual([]);

      now = new Date(T0.getTime() + 3 * HOUR);
      await dispatch(messagePayload({ text: "Yes" }), "event-4");
      expect(await deliveries()).toBe(1);
    });

    it("DOES spend it once the run delivered, so a later comment gets nothing", async () => {
      // The half of the rule that must survive the move: this is a rule that
      // was RELOCATED and not removed, and a build that simply stopped writing
      // the mark would pass every case above.
      await install([anchorAutomation()]);
      const dispatch = createDispatcher(deps);

      await dispatch(commentPayload(), EVENT);
      now = new Date(T0.getTime() + HOUR);
      await dispatch(messagePayload({ text: "Yes" }), "event-2");
      expect(await deliveries()).toBe(1);

      now = new Date(T0.getTime() + 2 * HOUR);
      await dispatch(
        commentPayload({ commentId: "comment-3", time: now.getTime() }),
        "event-3",
      );

      const [refused] = await deps.audit.query({
        eventId: "event-3",
        outcome: "suppressed",
      });
      expect(refused?.reason).toBe(
        t("dispatch.alreadyRan", { automation: "anchor-automation" }),
      );
      // Still one copy of the file, which is what the operator switched the
      // rule on for.
      expect(await deliveries()).toBe(1);
    });

    it("lets ONE run deliver more than once, across the wait in the middle", async () => {
      // The guard the mark's own shape needs. A flow that hands over two
      // things asks the gate twice, and the second ask arrives at a mark this
      // very run wrote: refused there, the contact would receive the first
      // half of a delivery and never the second.
      await install([twoPartAutomation()]);
      const dispatch = createDispatcher(deps);

      await dispatch(commentPayload(), EVENT);
      now = new Date(T0.getTime() + HOUR);
      await dispatch(messagePayload({ text: "Yes" }), "event-2");

      const sent = texts(await queued());
      expect(sent).toContain(FIRST_HALF);
      expect(sent).toContain(SECOND_HALF);
    });

    it("REQ-240: two events arriving together produce one delivery", async () => {
      await install([plainAutomation()]);
      const dispatch = createDispatcher(tickingClock());

      // Genuinely together: the webhook hands every delivery to a detached
      // handler (`src/http/webhook.ts`), so two of them interleave at every
      // await, which is the only honest way to write this case.
      await Promise.all([
        dispatch(commentPayload({ commentId: "comment-a" }), "event-a"),
        dispatch(commentPayload({ commentId: "comment-b" }), "event-b"),
      ]);

      expect(await queued()).toHaveLength(1);
    });

    it("REQ-347: a delivery-race loser retires the reply it already queued", async () => {
      await install([replyThenDeliverAutomation()]);
      const dispatch = createDispatcher(tickingClock());

      await Promise.all([
        dispatch(commentPayload({ commentId: "comment-a" }), "event-a"),
        dispatch(commentPayload({ commentId: "comment-b" }), "event-b"),
      ]);

      const sent = texts(await queued());
      // The winner has both steps. A third row would be the loser's public
      // reply, queued before its direct delivery lost the atomic claim.
      expect(await queued()).toHaveLength(2);
      expect(sent.match(/the race reply/g)).toHaveLength(1);
      expect(sent).toContain("the race delivery");
    });

    it("REQ-240: and it is the claim at the delivery that separates them", async () => {
      await install([plainAutomation()]);
      const racing = tickingClock();
      const store = racing.runs;
      deps = {
        ...racing,
        // The read at the start is held open, because a race is exactly what
        // defeats it: neither run has delivered when the other one looks. What
        // is left to decide the winner is the INSERT below, and this case is
        // about that and nothing else.
        runs: {
          ...store,
          hasRun: (): Promise<boolean> => Promise.resolve(false),
        },
      };
      const dispatch = createDispatcher(deps);

      await Promise.all([
        dispatch(commentPayload({ commentId: "comment-a" }), "event-a"),
        dispatch(commentPayload({ commentId: "comment-b" }), "event-b"),
      ]);

      expect(await queued()).toHaveLength(1);
      // Named by the engine's own code, so the operator reading the trail
      // finds a rule that worked and not an execution that broke.
      const refusals = await deps.audit.query({ outcome: "suppressed" });
      expect(refusals.map((entry) => entry.reason)).toContain(
        "automation_already_delivered",
      );
    });
  });

  /**
   * The operator's wait, applied where it can be seen (REQ-277).
   *
   * Every case here reads the DUE INSTANT of the queued row, because that is
   * the whole mechanism: the messages are composed and persisted the moment the
   * trigger fires, exactly as before, and only the instant the sweep may take
   * them moves. Nothing sleeps, nothing is suspended and nothing is recomputed
   * later, which is what makes a wait cost the process nothing and survive a
   * restart (ADR-005).
   *
   * The wait it replaces was a STEP, and it was assembled last by the only
   * screen that wrote one, so it paused a run that had already sent everything.
   * That is why these cases assert instants and not the presence of a message:
   * the defect being repaired was invisible to every assertion about what a
   * contact receives, and visible only in WHEN.
   */
  describe("REQ-277: the wait holds the first reply, and only the first", () => {
    /** The queued sends with the instant each becomes the sweep's business. */
    async function sendsDue(): Promise<{ text: string; dueAt: Date }[]> {
      const items = await createDurableWorkStore(handle.db).due(
        new Date(8.64e15),
      );
      return items
        .filter((item) => item.kind === "send")
        .map((item) => ({
          text: JSON.stringify(item.payload),
          dueAt: item.dueAt,
        }));
    }

    /** What the sweep would actually take at a given instant. */
    async function dueAt(instant: Date): Promise<number> {
      const items = await createDurableWorkStore(handle.db).due(instant);
      return items.filter((item) => item.kind === "send").length;
    }

    it("holds the public reply and the first direct message TOGETHER", async () => {
      await install([waitingAutomation()]);

      await createDispatcher(deps)(commentPayload(), EVENT);

      const sends = await sendsDue();
      // Both were composed and stored at once: the run did all its work, and
      // only the delivery is held.
      expect(sends).toHaveLength(2);
      expect(sends.map((send) => send.text).join(" | ")).toContain(
        WAITED_RESOURCE,
      );
      // The same instant for both, which is the half the operator sees: the
      // comment is answered and the message arrives, ten seconds later, as one
      // reply rather than as two events at different times.
      for (const send of sends) {
        expect(send.dueAt.getTime()).toBe(
          T0.getTime() + FIRST_REPLY_WAIT * SECOND,
        );
      }
    });

    it("keeps them from the sweep until the wait is over", async () => {
      await install([waitingAutomation()]);

      await createDispatcher(deps)(commentPayload(), EVENT);

      // Nothing for the sweep at the trigger's own instant, nor one second
      // short of the deadline: this is the assertion the old step could never
      // have made, because it paused a run with nothing left to send.
      expect(await dueAt(T0)).toBe(0);
      expect(
        await dueAt(new Date(T0.getTime() + (FIRST_REPLY_WAIT - 1) * SECOND)),
      ).toBe(0);
      expect(
        await dueAt(new Date(T0.getTime() + FIRST_REPLY_WAIT * SECOND)),
      ).toBe(2);
    });

    it("immediate is no hold at all, and not a hold of zero", async () => {
      await install([waitingAutomation(0)]);

      await createDispatcher(deps)(commentPayload(), EVENT);

      // The row an operator who chose immediate gets is the row they got
      // before this rule existed: due at the instant it was queued.
      const sends = await sendsDue();
      expect(sends).toHaveLength(2);
      for (const send of sends) {
        expect(send.dueAt.getTime()).toBe(T0.getTime());
      }
      expect(await dueAt(T0)).toBe(2);
    });

    it("does NOT hold what follows the contact's answer", async () => {
      // The line the user drew, and the reason they drew it: the risk of
      // looking like a machine is in the first contact, and holding back the
      // delivery of somebody who has just tapped the button punishes the person
      // who already did their part.
      await install([waitingAndAskingAutomation()]);
      const dispatch = createDispatcher(deps);

      await dispatch(commentPayload(), EVENT);
      expect(await sendsDue()).toHaveLength(1);

      now = new Date(T0.getTime() + HOUR);
      await dispatch(postbackPayload({ at: now }), "event-2");

      const delivery = (await sendsDue()).find((send) =>
        send.text.includes(WAITED_RESOURCE),
      );
      // At the instant they answered, to the millisecond: not that instant plus
      // the wait, and not the wait recomputed from the comment.
      expect(delivery?.dueAt.getTime()).toBe(now.getTime());
    });

    /*
     * The floor and the pause between two sends of ONE delivery, which is the
     * interaction these two cases measure: the wait must not be charged twice,
     * and the pause must not be swallowed by it.
     *
     * It was written on a delivery of a text AND a file (REQ-231) and lost its
     * fixture when the attachment left the format (REQ-284). The pure link is
     * what makes a delivery several messages again (REQ-286), so the two rules
     * meet again here: the wait is a FLOOR under the whole delivery, and the
     * pause is measured from the message it follows, which is already held.
     */
    it("REQ-231: the pause is measured from the held message, not from the trigger", async () => {
      await install([waitingAndLinkingAutomation()]);

      await createDispatcher(deps)(commentPayload(), EVENT);

      const sends = await sendsDue();
      const first = sends.find((send) => send.text.includes(WAITED_RESOURCE));
      const link = sends.find((send) => send.text.includes(WAITED_LINK));
      expect(sends).toHaveLength(2);

      // The one pair of instants that rules out both ways of getting this
      // wrong. The same instant twice would be the pause lost — two messages
      // in the same second, which is the burst the pause exists to prevent.
      // The wait added a second time (T0 + 10s + 10s + 2s) would be the floor
      // charged twice, holding the link for a wait that has already passed.
      expect(first?.dueAt.getTime()).toBe(
        T0.getTime() + FIRST_REPLY_WAIT * SECOND,
      );
      expect(link?.dueAt.getTime()).toBe(
        T0.getTime() + FIRST_REPLY_WAIT * SECOND + MESSAGE_PAUSE_MS,
      );
    });

    it("REQ-231: the sweep takes them one pass apart, and neither before the wait", async () => {
      await install([waitingAndLinkingAutomation()]);

      await createDispatcher(deps)(commentPayload(), EVENT);

      // Read the way the sweep reads it, because that is what the contact
      // experiences: nothing at all while the wait runs, then the message,
      // then the address behind it.
      expect(await dueAt(T0)).toBe(0);
      expect(
        await dueAt(new Date(T0.getTime() + FIRST_REPLY_WAIT * SECOND)),
      ).toBe(1);
      expect(
        await dueAt(
          new Date(T0.getTime() + FIRST_REPLY_WAIT * SECOND + MESSAGE_PAUSE_MS),
        ),
      ).toBe(2);
    });

    it("REQ-286: the address reaches the queue raw, and spends no private reply", async () => {
      await install([waitingAndLinkingAutomation()]);

      await createDispatcher(deps)(commentPayload(), EVENT);

      const rows = await queued();
      const link = rows.find((row) =>
        JSON.stringify(row.payload).includes(WAITED_LINK),
      );
      // The address travels as the operator declared it. Nothing wraps it on
      // the way out: `/clicks/<id>` is what a card BUTTON's destination becomes
      // so a tap can be attributed, and putting it here would hand the site at
      // the other end an address that is not the one whose preview was wanted.
      expect(link?.payload).toMatchObject({
        message: { text: WAITED_LINK },
        // The private reply is the door and it opens once (REQ-097): the first
        // message of the delivery spends it, and this one travels by contact
        // id into the room that message opened.
        privateReply: false,
      });
      expect(JSON.stringify(link?.payload)).not.toContain("/clicks/");
    });
  });

  /**
   * REQ-036 counts events received BY TYPE, and until this row existed the type
   * reached the trail only where something was refused, suppressed or broken. A
   * comment that matched and ran produced `action_executed` rows and nothing
   * else, so every interaction that simply worked was counted under no type at
   * all. The webhook's own row cannot stand in for it: one delivery may carry a
   * comment and a direct message at once, so it names no origin.
   */
  describe("REQ-036: the accepted interaction is on the trail, with its type", () => {
    /** Receipts only: the rows an aggregation by type would count. */
    function receipts(
      eventId = EVENT,
    ): Promise<{ subtype?: string; contactId?: string; occurredAt: Date }[]> {
      return deps.audit
        .query({ kind: "event_received", outcome: "ok", eventId })
        .then((entries) => entries.map((entry) => ({ ...entry })));
    }

    it("records a comment that matched and ran, naming its origin", async () => {
      await install([anchorAutomation()]);

      await createDispatcher(deps)(commentPayload(), EVENT);

      // The happy path, which is exactly the path that had no receipt: the run
      // queued two actions and the trail could not say what had arrived.
      const rows = await receipts();
      expect(rows).toHaveLength(1);
      expect(rows[0]?.subtype).toBe("comment");
      expect(rows[0]?.contactId).toBe(CONTACT);
    });

    it("records a direct message under its own type", async () => {
      await install([menuAutomation()]);

      await createDispatcher(deps)(
        messagePayload({ text: "yes please" }),
        EVENT,
      );

      expect((await receipts())[0]?.subtype).toBe("direct_message");
    });

    it("counts every interaction of a batched delivery, each by its type", async () => {
      await install([anchorAutomation(), menuAutomation()]);

      // One delivery, a comment and a message together. This is why the
      // delivery-level row has no origin to claim, and why the receipt lives
      // here instead: read from the webhook's row alone, this delivery would be
      // one event of unknown type rather than two events of known ones.
      await createDispatcher(deps)(
        {
          object: "instagram",
          entry: [
            (commentPayload() as { entry: unknown[] }).entry[0],
            (messagePayload({ text: "hello" }) as { entry: unknown[] })
              .entry[0],
          ],
        },
        EVENT,
      );

      expect((await receipts()).map((row) => row.subtype).sort()).toEqual([
        "comment",
        "direct_message",
      ]);
    });

    it("records the receipt at the instant the contact acted", async () => {
      await install([anchorAutomation()]);
      const commented = new Date(T0.getTime() - 10 * 60 * 1000);
      now = T0;

      await createDispatcher(deps)(
        commentPayload({ time: commented.getTime() }),
        EVENT,
      );

      // An aggregation by hour is about when people interacted, not about when
      // the process got round to them.
      expect((await receipts())[0]?.occurredAt).toEqual(commented);
    });

    it("records ONE receipt for an event that fires nothing", async () => {
      await install([anchorAutomation()]);

      await createDispatcher(deps)(
        commentPayload({ text: "nice picture" }),
        EVENT,
      );

      // The receipt says the comment arrived; the suppression below says what
      // was done about it. Counting the second as a receipt too would report
      // one event as two.
      expect(await receipts()).toHaveLength(1);
      const trail = await deps.audit.query({
        kind: "event_received",
        eventId: EVENT,
      });
      expect(trail).toHaveLength(2);
      expect(trail.map((entry) => entry.outcome).sort()).toEqual([
        "ok",
        "suppressed",
      ]);
    });

    it("records ONE receipt for an interaction that resumed a wait", async () => {
      await install([anchorAutomation()]);
      const dispatch = createDispatcher(deps);

      await dispatch(commentPayload(), EVENT);
      now = new Date(T0.getTime() + HOUR);
      await dispatch(messagePayload({ text: "yes" }), "event-2");

      // The resume path writes its own `event_received` row (the answer was
      // consumed by the wait), and it is not a second arrival.
      expect(await receipts("event-2")).toHaveLength(1);
    });

    it("REQ-106: records no receipt for a payload it could not read", async () => {
      await install([anchorAutomation()]);

      await createDispatcher(deps)({ object: "instagram", entry: [{}] }, EVENT);

      // Nothing was received that this build can name, and inventing a type
      // here would put an origin nobody observed into the operator's counts.
      expect(await receipts()).toHaveLength(0);
      const [entry] = await deps.audit.query({ eventId: EVENT });
      expect(entry?.subtype).toBeUndefined();
    });
  });

  /**
   * REQ-162. The trail already said an event of some type arrived from some
   * contact id, which is precisely as much as a stranger's numeric id tells
   * anybody. What it never kept was the two things that answer "who was this
   * and what did they say": the text, which the dispatcher has in hand, and the
   * `username`, which the platform sends on every comment and which
   * `commentOf` used to read past.
   */
  describe("REQ-162: the receipt keeps what the event brought", () => {
    /** The receipt row, whole: this is the record of the arrival itself. */
    async function receipt(eventId = EVENT) {
      const [entry] = await deps.audit.query({
        kind: "event_received",
        outcome: "ok",
        eventId,
      });
      return entry;
    }

    it("keeps the comment's text and the identifier the payload brought", async () => {
      await install([anchorAutomation()]);

      await createDispatcher(deps)(commentPayload(), EVENT);

      const entry = await receipt();
      expect(entry?.eventText).toBe("I want the guide");
      // Read out of `value.from.username`, which is where the platform puts it
      // and where it was being dropped.
      expect(entry?.contactUsername).toBe(USERNAME);
      // Beside the id, never instead of it: everything else joins on the id.
      expect(entry?.contactId).toBe(CONTACT);
    });

    it("keeps the text of a comment that fired nothing", async () => {
      await install([anchorAutomation()]);

      await createDispatcher(deps)(
        commentPayload({ text: "nice picture" }),
        EVENT,
      );

      // The case the operator actually opens the screen for. Without the text
      // the row says a comment arrived and matched nothing, and there is no way
      // to see that the keyword was simply not in it.
      const entry = await receipt();
      expect(entry?.eventText).toBe("nice picture");
      expect(entry?.contactUsername).toBe(USERNAME);
    });

    it("records a direct message's text and the absence of an identifier", async () => {
      await install([menuAutomation()]);

      await createDispatcher(deps)(
        messagePayload({ text: "yes please" }),
        EVENT,
      );

      const entry = await receipt();
      expect(entry?.eventText).toBe("yes please");
      // This payload carries a sender id and no username at all, so the honest
      // record is nothing. Putting the id here under the other name would show
      // the operator a number and call it a handle.
      expect(entry?.contactUsername).toBeUndefined();
      expect(entry?.contactId).toBe(CONTACT);
    });

    it("invents no identifier for a comment that arrived without one", async () => {
      await install([anchorAutomation()]);

      await createDispatcher(deps)(commentPayload({ username: null }), EVENT);

      const entry = await receipt();
      expect(entry?.eventText).toBe("I want the guide");
      expect(entry?.contactUsername).toBeUndefined();
    });

    it("distinguishes an interaction that said nothing from one never recorded", async () => {
      await install([anchorAutomation()]);

      // A button with neither title nor payload: an answer that genuinely
      // carried no text. The row must say so, and `eventText` present-and-empty
      // is what says it. Absent would mean the trail never recorded any, which
      // is what a row written before this column means.
      await createDispatcher(deps)(
        postbackPayload({ title: null, payload: null }),
        EVENT,
      );

      const entry = await receipt();
      expect(entry?.eventText).toBe("");
      expect(entry).toHaveProperty("eventText");
    });
  });
});

describe("REQ-095: a direct message opens the conversation, a comment does not", () => {
  let handle: DatabaseHandle;
  let now: Date;
  let deps: DispatchDeps;

  beforeEach(async () => {
    handle = openDatabase({ databasePath: IN_MEMORY_DATABASE });
    now = T0;
    const clock = { now: () => now };
    const aggregates = createAutomationAggregateRepository(handle.db, clock);
    deps = {
      clock,
      automationAggregates: aggregates,
      work: createDurableWorkStore(handle.db),
      conversations: createConversationStore(handle.db),
      contacts: createContactRepository(handle.db, () => now),
      assets: createMemoryAssets({ [COVER]: RESOURCE_URL }),
      random: { next: (): number => 0 },
      audit: createAuditRepository(handle.db),
      runs: createAutomationRunStore(handle.db),
      messageWindowHours: 24,
      instanceSettings: fixedInstanceSettings(),
    };

    await aggregates.save(anchorAutomation());
  });

  afterEach(() => {
    handle.close();
  });

  it("marks the conversation at the instant of the message", async () => {
    const sent = new Date(T0.getTime() - 5 * 60 * 1000);

    await createDispatcher(deps)(messagePayload({ at: sent }), EVENT);

    // The message's own instant, not the instant the process handled it: the
    // twenty-four hours belong to the contact, not to our latency.
    expect(await deps.conversations.lastInboundAt(CONTACT)).toEqual(sent);
  });

  it("leaves the conversation unmarked for a comment", async () => {
    await createDispatcher(deps)(commentPayload(), EVENT);

    // The finding REQ-066 was written from: commenting does not put the account
    // in the contact's inbox, so it opens nothing.
    expect(await deps.conversations.lastInboundAt(CONTACT)).toBeUndefined();
  });

  it("ignores an echo of our own outbound message", async () => {
    await createDispatcher(deps)(messagePayload({ isEcho: true }), EVENT);

    // An echo counted as inbound would open the window on our own message and
    // suppress the question REQ-068 exists to ask.
    expect(await deps.conversations.lastInboundAt(CONTACT)).toBeUndefined();
  });

  it("REQ-068: the mark suppresses the confirmation of a later run", async () => {
    const dispatch = createDispatcher(deps);
    await dispatch(messagePayload({ text: "hello" }), EVENT);

    now = new Date(T0.getTime() + HOUR);
    await dispatch(commentPayload(), "event-2");

    const trail = await deps.audit.query({ contactId: CONTACT });
    const confirm = trail.find((entry) => entry.stepId === "confirm");
    expect(confirm?.outcome).toBe("suppressed");
    // And because the question was skipped, the run went all the way through.
    expect(trail.some((entry) => entry.stepId === "deliver")).toBe(true);
  });
});

describe("REQ-095: the mark survives the process", () => {
  let directory: string;
  let databasePath: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "mychat-dispatch-"));
    databasePath = join(directory, "mychat.db");
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  it("still reads the conversation as open after a restart", async () => {
    const before = openDatabase({ databasePath });
    const clock = { now: () => T0 };
    await createDispatcher({
      clock,
      automationAggregates: createAutomationAggregateRepository(
        before.db,
        clock,
      ),
      work: createDurableWorkStore(before.db),
      conversations: createConversationStore(before.db),
      contacts: createContactRepository(before.db, () => T0),
      assets: createMemoryAssets(),
      random: { next: (): number => 0 },
      audit: createAuditRepository(before.db),
      runs: createAutomationRunStore(before.db),
      messageWindowHours: 24,
      instanceSettings: fixedInstanceSettings(),
    })(messagePayload({ text: "hello" }), EVENT);
    before.close();

    const after = openDatabase({ databasePath });
    // A restart is not a reason to ask someone a question they already made
    // unnecessary by writing.
    expect(
      await createConversationStore(after.db).lastInboundAt(CONTACT),
    ).toEqual(T0);
    after.close();
  });
});

describe("translating the platform payload", () => {
  /**
   * The interactions half of the translation, which is what these cases are
   * about. The other half (the echoes it dropped) has its own describe below,
   * because it is what the caller decides with rather than what it dispatches.
   */
  function interactionsOf(
    payload: unknown,
    at: Date,
  ): readonly InboundInteraction[] {
    return translateInbound(payload, at).interactions;
  }

  it("reads a comment from entry.changes, in seconds", () => {
    const [interaction] = interactionsOf(commentPayload(), T0);

    expect(interaction?.event).toEqual({
      origin: "comment",
      text: "I want the guide",
      contactId: CONTACT,
      publicationId: "media-1",
      commentId: "comment-1",
    });
    expect(interaction?.occurredAt).toEqual(T0);
  });

  it("REQ-162: carries the comment's public identifier beside the event", () => {
    const [interaction] = interactionsOf(commentPayload(), T0);

    // On the interaction and NOT on the event: matching reads the event, and a
    // username decides nothing about whether an automation fires.
    expect(interaction?.username).toBe(USERNAME);
    expect(interaction?.event).not.toHaveProperty("username");
  });

  it("REQ-162: carries no public identifier when the comment brought none", () => {
    const [interaction] = interactionsOf(
      commentPayload({ username: null }),
      T0,
    );

    expect(interaction?.username).toBeUndefined();
  });

  it("REQ-162: carries no public identifier for a direct message, which has none", () => {
    const [message] = interactionsOf(messagePayload(), T0);
    const [tapped] = interactionsOf(postbackPayload(), T0);

    // Neither payload has a username field, so neither may produce one.
    expect(message?.username).toBeUndefined();
    expect(tapped?.username).toBeUndefined();
  });

  it("reads a message from entry.messaging, in milliseconds", () => {
    const at = new Date(T0.getTime() + 1234);
    const [interaction] = interactionsOf(messagePayload({ at }), T0);

    // Both units in one payload: read alike, one of them lands centuries away.
    expect(interaction?.event.origin).toBe("direct_message");
    expect(interaction?.occurredAt).toEqual(at);
  });

  it("reads a tapped button as an inbound message, with the button's title", () => {
    const at = new Date(T0.getTime() + 5000);
    const [interaction] = interactionsOf(
      postbackPayload({ title: "Unlock the link!", payload: "confirm", at }),
      T0,
    );

    // The title, because it is what the contact saw and pressed, and because a
    // quick reply already arrives as message text carrying the same string.
    expect(interaction?.event).toEqual({
      origin: "direct_message",
      text: "Unlock the link!",
      contactId: CONTACT,
    });
    expect(interaction?.occurredAt).toEqual(at);
  });

  it("falls back to the postback payload when no title came with it", () => {
    const [interaction] = interactionsOf(
      postbackPayload({ title: null, payload: "confirm-optin" }),
      T0,
    );

    expect(interaction?.event.text).toBe("confirm-optin");
  });

  it("keeps a postback that carries neither title nor payload", () => {
    const [interaction] = interactionsOf(
      postbackPayload({ title: null, payload: null }),
      T0,
    );

    // Same rule as a sticker: an answer with no text still ends a wait
    // (REQ-067) and still matches no keyword.
    expect(interaction?.event.text).toBe("");
  });

  it("drops a postback with no sender to attribute it to", () => {
    expect(
      interactionsOf(
        {
          entry: [{ id: ACCOUNT, messaging: [{ postback: { title: "Yes" } }] }],
        },
        T0,
      ),
    ).toHaveLength(0);
  });

  it("drops an echo of a postback the account itself sent", () => {
    expect(interactionsOf(postbackPayload({ from: ACCOUNT }), T0)).toHaveLength(
      0,
    );
  });

  it("drops a change that is not a comment", () => {
    expect(
      interactionsOf(
        {
          entry: [{ id: ACCOUNT, changes: [{ field: "mentions", value: {} }] }],
        },
        T0,
      ),
    ).toHaveLength(0);
  });

  it("drops a read receipt, which carries no message", () => {
    expect(
      interactionsOf(
        {
          entry: [
            { id: ACCOUNT, messaging: [{ sender: { id: CONTACT }, read: {} }] },
          ],
        },
        T0,
      ),
    ).toHaveLength(0);
  });

  it("drops the account's own comment, which would trigger itself", () => {
    expect(interactionsOf(commentPayload({ from: ACCOUNT }), T0)).toHaveLength(
      0,
    );
  });

  it("translates every entry of a batched delivery", () => {
    const batched = {
      entry: [
        (commentPayload() as { entry: unknown[] }).entry[0],
        (
          commentPayload({ from: "contact-2", commentId: "comment-2" }) as {
            entry: unknown[];
          }
        ).entry[0],
      ],
    };

    // Taking entry[0] alone would leave the second contact unanswered, with
    // nothing anywhere saying why.
    expect(interactionsOf(batched, T0)).toHaveLength(2);
  });

  it("falls back to the arrival instant when the payload carries none", () => {
    const [interaction] = interactionsOf(
      {
        entry: [
          {
            id: ACCOUNT,
            changes: [
              {
                field: "comments",
                value: { id: "c", text: "guide", from: { id: CONTACT } },
              },
            ],
          },
        ],
      },
      T0,
    );

    // Late by the delivery's own latency, never early: a window counted from
    // an instant in the future would still be open after it closed.
    expect(interaction?.occurredAt).toEqual(T0);
  });

  it("keeps an answer that carries no text at all", () => {
    const [interaction] = interactionsOf(
      {
        entry: [
          {
            id: ACCOUNT,
            messaging: [{ sender: { id: CONTACT }, message: { mid: "mid-1" } }],
          },
        ],
      },
      T0,
    );

    // A sticker is an answer: it must end a wait (REQ-067) and match no
    // keyword, which is exactly what empty text does.
    expect(interaction?.event.text).toBe("");
  });

  it("returns nothing for a payload with no entry at all", () => {
    expect(interactionsOf({ hello: "world" }, T0)).toHaveLength(0);
    expect(interactionsOf(undefined, T0)).toHaveLength(0);
  });

  describe("REQ-161: what it dropped, and why the caller is told", () => {
    it("counts the echo it dropped instead of losing the fact", () => {
      const { interactions, echoes } = translateInbound(
        messagePayload({ from: ACCOUNT, isEcho: true }),
        T0,
      );

      // Dropped, as it always was: read as an inbound it would open the window
      // on our own message and end the wait our own question started. Counted,
      // which is new: it is how the caller knows this delivery produced nothing
      // for a reason this build understood.
      expect(interactions).toHaveLength(0);
      expect(echoes).toBe(1);
    });

    it("counts no echo for a payload it simply could not read", () => {
      // The distinction REQ-161 rests on. Both produce no interaction; only one
      // of them was understood.
      expect(
        translateInbound({ object: "instagram", entry: [{}] }, T0),
      ).toEqual({ interactions: [], echoes: 0 });
    });
  });
});
