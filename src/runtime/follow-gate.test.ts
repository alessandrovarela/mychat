import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fixedInstanceSettings } from "../config/instance-settings.js";
import { runExecution } from "../engine/execute.js";
import type { ExecutionStart, FlowRegistry } from "../engine/execute.js";
import type { EnginePorts, FollowLink, FollowStatus } from "../engine/ports.js";
import { bindActiveAutomation } from "../flows/binding.js";
import type { ActiveAutomation } from "../flows/schema.js";
import { buildSendRequest } from "../platform/sender.js";
import type { SendPayload } from "../platform/sender.js";
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
import type { DatabaseHandle, WorkItem } from "../storage/index.js";
import { readAnswer } from "./answers.js";
import { createDispatcher } from "./dispatch.js";
import type { DispatchDeps } from "./dispatch.js";
import { createQueueingSender } from "./outbox.js";
import {
  createDurableSuspender,
  createSuspensionTimeoutHandler,
  routeInbound,
} from "./suspension.js";
import type { ResumeDeps, SuspensionPayload } from "./suspension.js";

/**
 * Proves REQ-027, and REQ-022/REQ-025 where the gate leans on them: the
 * requirement releases what follows it only for a contact the platform says is
 * a follower, and takes the declared give-up path for everyone else.
 *
 * The mistakes here are not the same size, and the whole design follows from
 * that. Letting a non-follower through hands over a resource that cannot be
 * recalled; holding a follower back costs one message and is undone by their
 * next one. So the gate opens on exactly ONE answer, and a query that could not
 * be made is not it. The field only exists for a contact who is in a
 * conversation (docs/platform-limits.md, item 7), so that is the ordinary case
 * and not the exotic one.
 *
 * The second design point is that the wait is ended by a QUERY and not by a
 * text: nothing the contact types makes them a follower, so every interaction
 * is an occasion to ask the platform again (that is why a single query at the
 * gate would make the step impossible to pass: nobody follows yet when they are
 * first asked to).
 *
 * The aggregate is the version-2 one, self-contained: the gate and the delivery
 * are steps of the AUTOMATION, and the resource is a concrete file on the
 * delivering step rather than a parameter bound from a flow. The requirement is
 * unchanged by that; only the shape the fixtures are written in.
 *
 * The adapter that puts the question to the platform is proved next door, in
 * `src/platform/follow.test.ts`. What lives here is the behaviour of the STEP:
 * what the engine does with each answer, and what it does when there is nobody
 * to ask.
 *
 * TWO REQUIREMENT IDS NAME THE SAME RULES HERE, and the pairing is deliberate
 * rather than a slip. Phase 3o registered the closing loop again, from the
 * behaviour of competing products, as REQ-316, REQ-317 and REQ-318; phase 3l
 * had already built it as REQ-245/REQ-246, REQ-247 and the sender's private
 * reply split. The cases below are therefore labelled with both, so a reader
 * arriving from either register finds the proof instead of an absence, and
 * nobody writes the rule a second time beside the one that is already here.
 */

const T0 = new Date("2026-08-01T10:00:00.000Z");
const HOUR = 60 * 60 * 1000;
const ACCOUNT = "17841400000000000";
const CONTACT = "contact-1";
const ASK = "Follow the account and write back to receive the guide";
/** What the INSTANCE calls the button, which is the only place it is written. */
const FOLLOW_BUTTON = "Já segui";
const RECHECK_ASK =
  "We checked and you still do not follow this account. Follow it, then tap the button below.";
const EMAIL_ASK = "What is your e-mail?";
const ADDRESS = "bob@example.com";
const RESOURCE = "https://cdn.example/guide.pdf";
/** A v2 aggregate runs under its own id: there is no flow beside it. */
const GATE_AUTOMATION = "gate-automation";

const FOLLOWS: FollowStatus = { kind: "follows" };
const DOES_NOT: FollowStatus = { kind: "does_not_follow" };
const REFUSED: FollowStatus = {
  kind: "unknown",
  cause: "refused",
  detail: "400: cannot be loaded due to missing permissions",
};
const ABSENT: FollowStatus = { kind: "unknown", cause: "field_absent" };

interface LinkDouble extends FollowLink {
  readonly asked: readonly string[];
}

/**
 * The message body as the Send API would receive it, in the two shapes a
 * tappable choice can take (REQ-318). Only the parts these cases read.
 */
interface WireMessage {
  readonly quick_replies?: unknown[];
  readonly attachment?: {
    readonly payload?: { readonly elements?: { buttons?: unknown[] }[] };
  };
}

/**
 * A link that answers the given statuses in order and repeats the last one.
 *
 * Repeating matters: the gate asks again at every interaction, so a double that
 * ran out of answers would be describing a platform that stops replying rather
 * than one that keeps saying the same thing.
 */
function linkSaying(...answers: readonly FollowStatus[]): LinkDouble {
  const asked: string[] = [];

  return {
    asked,
    status(contactId: string): Promise<FollowStatus> {
      const answer = answers[Math.min(asked.length, answers.length - 1)];
      asked.push(contactId);
      return Promise.resolve(answer ?? DOES_NOT);
    },
  };
}

/** Require the follow, then hand the resource over. */
function gateAutomation(): ActiveAutomation {
  return {
    schema_version: 2,
    kind: "automation",
    id: GATE_AUTOMATION,
    state: "active",
    trigger: {
      type: "comment",
      target: "media-1",
      match: { keywords: ["guide"], mode: "contains" },
    },
    // Immediate: nothing in this file is about WHEN the first reply leaves,
    // and zero is the timing every instant below was written under (REQ-277).
    rules: { once_per_contact: true, first_reply_delay_seconds: 0 },
    steps: [
      {
        id: "require-follow",
        action: "follow_gate",
        ask: ASK,
        on_timeout: "abandon",
      },
      {
        id: "deliver",
        action: "send_dm",
        message: {
          // A card with a cover: the cover is the part that names a RESOURCE
          // and resolves it at send time, which is what these cases are about.
          // The attachment played that role until REQ-284 took it out of the
          // format.
          image: "cover.png",
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
  };
}

/** The phase's closing shape: collect the address, then require the follow. */
function fullAutomation(): ActiveAutomation {
  return {
    schema_version: 2,
    kind: "automation",
    id: "full-automation",
    state: "active",
    trigger: {
      type: "comment",
      target: "media-1",
      match: { keywords: ["guide"], mode: "contains" },
    },
    // Immediate: nothing in this file is about WHEN the first reply leaves,
    // and zero is the timing every instant below was written under (REQ-277).
    rules: { once_per_contact: true, first_reply_delay_seconds: 0 },
    steps: [
      {
        id: "ask-email",
        action: "collect_email",
        ask: EMAIL_ASK,
        on_timeout: "abandon",
      },
      {
        id: "require-follow",
        action: "follow_gate",
        ask: ASK,
        on_timeout: "abandon",
      },
      {
        id: "deliver",
        action: "send_dm",
        message: {
          // A card with a cover: the cover is the part that names a RESOURCE
          // and resolves it at send time, which is what these cases are about.
          // The attachment played that role until REQ-284 took it out of the
          // format.
          image: "cover.png",
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
  };
}

/**
 * A one-step automation on a DIRECT MESSAGE, fired by one keyword.
 *
 * Two of them are what the order of REQ-242 is measured against at this step:
 * one whose keyword nothing here ever says by accident, and one whose keyword
 * is a word printed on the follow button itself. The gate refuses every message
 * there is, so which of the two runs is the whole difference between a contact
 * who can leave a requirement they have decided against and a button of ours
 * that starts somebody else's automation.
 */
function keywordAutomation(id: string, keyword: string): ActiveAutomation {
  return {
    schema_version: 2,
    kind: "automation",
    id,
    state: "active",
    trigger: {
      type: "direct_message",
      match: { keywords: [keyword], mode: "contains" },
    },
    // Immediate: nothing in this file is about WHEN the first reply leaves,
    // and zero is the timing every instant below was written under (REQ-277).
    rules: { once_per_contact: true, first_reply_delay_seconds: 0 },
    steps: [{ id: "send", action: "send_dm", message: { text: `${id} ran` } }],
  };
}

/** Every answer that is not "follows", named for the tables below. */
const UNANSWERABLE: readonly (readonly [string, FollowStatus])[] = [
  ["a refusal by the platform", REFUSED],
  ["an answer that omits the field", ABSENT],
];

describe("REQ-027: the wait is ended by the query, never by the text", () => {
  let handle: DatabaseHandle;
  let now: Date;
  const clock = { now: () => now };

  /**
   * A run already waiting at the gate, written straight into the durable
   * record.
   *
   * Seeded rather than produced by an execution on purpose: what is under test
   * here is the RE-CHECK, and a wait that outlived the process it was created
   * in is the same row this writes (ADR-005). It is also what an upgrade meets
   * in production.
   */
  async function waitingAtGate(
    payload: Partial<SuspensionPayload> = {},
  ): Promise<void> {
    await createDurableWorkStore(handle.db).enqueue(
      {
        kind: "suspension",
        dedupeKey: "suspend:exec-1:require-follow",
        payload: {
          flowId: GATE_AUTOMATION,
          contactId: CONTACT,
          stepId: "require-follow",
          onTimeout: "abandon",
          expects: "follow",
          // The CARD this wait sent, which is what goes back out when the
          // contact asks to be checked again (REQ-246). Written by the step
          // itself, and proved so further down; a fixture that omitted it
          // would be describing a record the engine no longer writes.
          question: ASK,
          buttonLabel: FOLLOW_BUTTON,
          ...payload,
        } satisfies SuspensionPayload,
        dueAt: new Date(T0.getTime() + 24 * HOUR),
        contactId: CONTACT,
        executionId: "exec-1",
      },
      T0,
    );
  }

  function routingDeps(follow?: FollowLink): ResumeDeps {
    return {
      work: createDurableWorkStore(handle.db),
      clock,
      contacts: createContactRepository(handle.db, () => now),
      audit: createAuditRepository(handle.db),
      ...(follow !== undefined && { follow }),
    };
  }

  async function pendingWaits(): Promise<number> {
    const items = await createDurableWorkStore(handle.db).due(
      new Date(8.64e15),
    );
    return items.filter((item) => item.kind === "suspension").length;
  }

  async function queued(): Promise<string> {
    const items = await createDurableWorkStore(handle.db).due(
      new Date(8.64e15),
    );
    return items
      .filter((item) => item.kind === "send")
      .map((item) => JSON.stringify(item.payload))
      .join(" | ");
  }

  /** Suppression rows written against the step, newest last. */
  async function trailAtGate(): Promise<readonly string[]> {
    const entries = await createAuditRepository(handle.db).query({
      contactId: CONTACT,
    });
    return entries
      .filter(
        (entry) =>
          entry.stepId === "require-follow" && entry.outcome === "suppressed",
      )
      .map((entry) => entry.reason ?? "");
  }

  beforeEach(() => {
    handle = openDatabase({ databasePath: IN_MEMORY_DATABASE });
    now = T0;
  });

  afterEach(() => {
    handle.close();
  });

  it("resumes at the next step when the contact has since followed", async () => {
    await waitingAtGate();
    const link = linkSaying(FOLLOWS);

    now = new Date(T0.getTime() + HOUR);
    const routed = await routeInbound(routingDeps(link), {
      contactId: CONTACT,
      text: "done",
    });

    expect(routed.kind).toBe("resume");
    expect(routed.kind === "resume" && routed.resumed.stepId).toBe(
      "require-follow",
    );
    // Asked about THIS contact, and asked at all: a resume that never queried
    // would be a gate opened by a message.
    expect(link.asked).toEqual([CONTACT]);
    // The row is concluded, so a redelivered message cannot resume it twice.
    expect(await pendingWaits()).toBe(0);
  });

  it("holds the run at the same step while the contact still does not follow", async () => {
    await waitingAtGate();

    now = new Date(T0.getTime() + HOUR);
    const routed = await routeInbound(routingDeps(linkSaying(DOES_NOT)), {
      contactId: CONTACT,
      text: "where is my guide?",
    });

    expect(routed.kind).toBe("held");
    expect(routed.kind === "held" && routed.waiting.stepId).toBe(
      "require-follow",
    );
    // The text took the first button off screen, so the gate restores a whole
    // card rather than leaving the contact with no way to request another
    // check. Its words also report this query instead of repeating the first
    // invitation as if it never happened (REQ-341, REQ-343).
    expect(await queued()).toBe("");
    expect(routed.kind === "held" && routed.reask).toMatchObject({
      question: RECHECK_ASK,
      buttonLabel: FOLLOW_BUTTON,
      attempt: 2,
    });
    expect(routed.kind === "held" && routed.consumed).toBe(true);
    // Still waiting, under the same deadline: the contact can go and follow.
    expect(await pendingWaits()).toBe(1);
    expect(await trailAtGate()).toHaveLength(1);
  });

  it("does not let the ANSWER end the wait, however convincing it reads", async () => {
    // The failure this guards is a step whose verdict quietly falls back to
    // "any answer will do": every wait written before REQ-022 reads that way,
    // and this one must not. "I followed you, promise" is a text, and a text
    // cannot make anybody a follower.
    await waitingAtGate();

    const routed = await routeInbound(routingDeps(linkSaying(DOES_NOT)), {
      contactId: CONTACT,
      text: "yes, I followed you already, promise!",
    });

    expect(routed.kind).toBe("held");
    expect(await pendingWaits()).toBe(1);
  });

  it("does not let the BUTTON end the wait either, however it is spelled", async () => {
    // The button REQ-245 added is a request to consult the platform again, and
    // nothing else. Tapping it while the platform says no must hold exactly as
    // any other message does: a gate opened by the words printed on it would be
    // opened by whoever reads them and types them back.
    await waitingAtGate();

    for (const answer of [FOLLOW_BUTTON, "ja segui", "  JÁ SEGUI  "]) {
      const routed = await routeInbound(routingDeps(linkSaying(DOES_NOT)), {
        contactId: CONTACT,
        text: answer,
      });

      expect(routed.kind).toBe("held");
      // The same wait, still open under the same deadline: holding costs the
      // contact nothing but another message, and they can still go and follow.
      expect(await pendingWaits()).toBe(1);
    }
  });

  it.each([
    ["the button's own words", FOLLOW_BUTTON],
    ["them with no accent", "ja segui"],
    ["shouted, with the blanks a paste carries", "  JÁ SEGUI  "],
  ])(
    "REQ-246/REQ-343: %s asks for the card again, whole and with its button",
    async (_label, answer) => {
      // The requirement, and the reason it is not a comfort: the platform
      // attaches a quick reply to the most recent message of the conversation,
      // so the button left this contact's screen the instant they sent this.
      // Without the card going back out, somebody doing exactly what the step
      // asked has no way of asking a second time.
      await waitingAtGate();

      const routed = await routeInbound(routingDeps(linkSaying(DOES_NOT)), {
        contactId: CONTACT,
        text: answer,
      });

      expect(routed.kind).toBe("held");
      // The WHOLE card: the result of the query and the button the instance
      // names. Repeating the initial words alone would hide the result that
      // just sent this card, while omitting the button would strand them.
      expect(routed.kind === "held" && routed.reask).toMatchObject({
        question: RECHECK_ASK,
        buttonLabel: FOLLOW_BUTTON,
        // Ask number two, and the number is not decoration: it is what keeps
        // the queue from recognising the second card as the first one
        // (REQ-247).
        attempt: 2,
        // The count is the caller's to spend, immediately before the send
        // (REQ-243). Asserted as a function rather than left out: a card whose
        // serial nobody could move would be dropped by the queue as a repeat.
        spend: expect.any(Function),
      });
      // REQ-242: this message is a request addressed to THIS wait, so the wait
      // consumes it and the trigger never sees it. The words on our own button
      // starting somebody else's automation is exactly what that prevents.
      expect(routed.kind === "held" && routed.consumed).toBe(true);
      // And the gate is still shut: the card went out, the resource did not.
      expect(await pendingWaits()).toBe(1);
    },
  );

  it("REQ-341/REQ-343: text outside the button restores the card with the query result", async () => {
    // A plain reply also removes the only button. Consuming it is essential:
    // trigger matching could otherwise supersede this run and suppress the
    // card, leaving the contact at a gate with no way to ask again.
    await waitingAtGate();

    for (const answer of [
      "where is my guide?",
      "yes, I followed you already, promise!",
      "",
      "Já",
      "Já segui, e agora?",
    ]) {
      const routed = await routeInbound(routingDeps(linkSaying(DOES_NOT)), {
        contactId: CONTACT,
        text: answer,
      });

      expect(routed.kind === "held" && routed.reask).toMatchObject({
        question: RECHECK_ASK,
        buttonLabel: FOLLOW_BUTTON,
      });
      expect(routed.kind === "held" && routed.consumed).toBe(true);
    }
  });

  it("REQ-246/REQ-316: a wait written before the card was recorded resends nothing", async () => {
    // What an upgrade meets in production: rows written by the previous
    // version carry no card at all. Inventing one here would send a contact a
    // button whose words nobody can prove were ever on their screen, so the
    // wait behaves exactly as it did before, and only the deadline ends it.
    await waitingAtGate({ question: undefined, buttonLabel: undefined });

    const routed = await routeInbound(routingDeps(linkSaying(DOES_NOT)), {
      contactId: CONTACT,
      text: FOLLOW_BUTTON,
    });

    expect(routed.kind).toBe("held");
    expect(routed.kind === "held" && routed.reask).toBeUndefined();
    expect(await pendingWaits()).toBe(1);
  });

  it.each(UNANSWERABLE)(
    "REQ-246/REQ-316: %s resends the card too, because it is not a yes",
    async (_label, status) => {
      // A query that could not be made is read as "does not follow"
      // everywhere else in this file, and the resend follows the same reading:
      // the contact asked to be checked again, the check did not open the
      // gate, so they get the card back and can ask once more.
      await waitingAtGate();

      const routed = await routeInbound(routingDeps(linkSaying(status)), {
        contactId: CONTACT,
        text: FOLLOW_BUTTON,
      });

      expect(routed.kind).toBe("held");
      expect(routed.kind === "held" && routed.reask?.buttonLabel).toBe(
        FOLLOW_BUTTON,
      );
      // The cause still reaches the operator, and the sentence says the card
      // went out again rather than claiming nothing was repeated.
      const [reason] = await trailAtGate();
      expect(reason).toContain(status.kind === "unknown" ? status.cause : "");
      expect(reason).not.toBe("");
    },
  );

  it("REQ-246/REQ-316: the tap that finds a follower opens the gate and repeats nothing", async () => {
    await waitingAtGate();

    const routed = await routeInbound(routingDeps(linkSaying(FOLLOWS)), {
      contactId: CONTACT,
      text: FOLLOW_BUTTON,
    });

    // The two halves of the requirement in one case: the same tap that
    // repeats the card while the platform says no is the tap that resumes the
    // run the moment it says yes, and a card sent after that would ask a
    // follower to follow.
    expect(routed.kind).toBe("resume");
    expect(await queued()).toBe("");
    expect(await pendingWaits()).toBe(0);
  });

  it("REQ-246/REQ-316: repeated cards never move the deadline that ends this wait", async () => {
    // The only ceiling this step has. Each card defers the row, and a defer
    // that stamped a new deadline would let a contact who keeps tapping hold
    // the execution open for ever, which is precisely what "limited only by
    // the deadline" must not mean.
    await waitingAtGate();
    const work = createDurableWorkStore(handle.db);
    const [before] = (await work.due(new Date(8.64e15))).filter(
      (item) => item.kind === "suspension",
    );

    for (const hour of [1, 2, 3]) {
      now = new Date(T0.getTime() + hour * HOUR);
      const routed = await routeInbound(routingDeps(linkSaying(DOES_NOT)), {
        contactId: CONTACT,
        text: FOLLOW_BUTTON,
      });
      // What the dispatcher does before it sends, and the test does it here
      // for the same reason: since REQ-243 the count moves with the SEND and
      // not with the verdict, so a caller that never sends never spends.
      await (routed.kind === "held" ? routed.reask?.spend() : undefined);
    }

    const [after] = (await work.due(new Date(8.64e15))).filter(
      (item) => item.kind === "suspension",
    );
    expect(after?.id).toBe(before?.id);
    expect(after?.dueAt).toStrictEqual(before?.dueAt);
    // Three cards asked for, three counted on the record: the count is what
    // makes each of them a row of its own in the queue (REQ-247).
    expect(after?.attempts).toBe(3);
  });

  it.each([
    ["the button's own words", FOLLOW_BUTTON],
    ["them with no accent", "ja segui"],
    ["a promise", "yes, I followed you already, promise!"],
    ["nothing at all", ""],
    ["an address, which another verdict would accept", "bob@example.com"],
  ])(
    "REQ-100: %s is refused by the reader itself, before any caller",
    (_label, text) => {
      // The guard at the reader, not only at its one careful caller. Every wait
      // written before REQ-022 fell through to "any answer will do", and this
      // one must never: falling through here would open the gate on a typed
      // message, and a resource handed over cannot be taken back.
      expect(readAnswer("follow", text)).toStrictEqual({ kind: "rejected" });
    },
  );

  it("asks the platform again at EVERY interaction, so the gate can be passed", async () => {
    // The reason a single query at the gate would be useless: at that moment
    // nobody follows yet, because they have not been asked to.
    await waitingAtGate();
    const link = linkSaying(DOES_NOT, DOES_NOT, FOLLOWS);
    const deps = routingDeps(link);

    const first = await routeInbound(deps, { contactId: CONTACT, text: "hi" });
    const second = await routeInbound(deps, { contactId: CONTACT, text: "?" });
    now = new Date(T0.getTime() + 2 * HOUR);
    const third = await routeInbound(deps, {
      contactId: CONTACT,
      text: "just followed",
    });

    expect([first.kind, second.kind, third.kind]).toEqual([
      "held",
      "held",
      "resume",
    ]);
    expect(link.asked).toHaveLength(3);
    expect(await pendingWaits()).toBe(0);
  });

  it("holds, and records, when the query itself fails", async () => {
    // REQ-027 read at its most expensive: the platform refused to answer, and
    // the only safe reading of that is "not a follower". Resuming here would
    // deliver the resource to whoever manages to break the query.
    await waitingAtGate();

    const routed = await routeInbound(routingDeps(linkSaying(REFUSED)), {
      contactId: CONTACT,
      text: "hello?",
    });

    expect(routed.kind).toBe("held");
    expect(await queued()).toBe("");
    expect(await pendingWaits()).toBe(1);
    // On the record, or an operator asking why a follower keeps being asked
    // has nothing to find. The sentence itself comes from the catalogue.
    expect(await trailAtGate()).toHaveLength(1);
    expect(routed.kind === "held" && routed.reason).not.toBe("");
  });

  it("holds when there is no link wired at all, rather than assuming a yes", async () => {
    // An installation that never wired the adapter is one more way the query
    // cannot be made, and it takes the same answer as every other. The opposite
    // default would hand the resource to everyone the day a wiring line is
    // forgotten, with every test still green.
    await waitingAtGate();

    const routed = await routeInbound(routingDeps(), {
      contactId: CONTACT,
      text: "hello?",
    });

    expect(routed.kind).toBe("held");
    expect(await pendingWaits()).toBe(1);
    expect(await trailAtGate()).toHaveLength(1);
  });

  it.each([...UNANSWERABLE, ["a plain no", DOES_NOT] as const])(
    "never resumes on %s",
    async (_label, status) => {
      await waitingAtGate();

      const routed = await routeInbound(routingDeps(linkSaying(status)), {
        contactId: CONTACT,
        text: "anything at all",
      });

      expect(routed.kind).not.toBe("resume");
    },
  );

  it("ends through the declared path when the deadline passes", async () => {
    // REQ-025, and the gate uses it unchanged: a contact who never follows is
    // a contact who never answered, and the automation already declares what
    // happens to them. The record names the policy, so the give-up is readable.
    await waitingAtGate();
    const [item] = await createDurableWorkStore(handle.db).due(
      new Date(8.64e15),
    );
    if (item === undefined) throw new Error("the wait should be on the table");

    now = new Date(T0.getTime() + 25 * HOUR);
    const audit = createAuditRepository(handle.db);
    const outcome = await createSuspensionTimeoutHandler({ audit, clock })(
      item,
    );

    expect(outcome).toStrictEqual({ kind: "done" });

    const [record] = await audit.query({
      contactId: CONTACT,
      kind: "action_executed",
    });
    expect(record?.stepId).toBe("require-follow");
    expect(record?.outcome).toBe("suppressed");
    expect(record?.reason).not.toBe("");
  });
});

describe("REQ-027: the step itself, at the gate", () => {
  let handle: DatabaseHandle;
  let now: Date;
  const clock = { now: () => now };

  function wire(
    automation: ActiveAutomation,
    follow?: FollowLink,
    /**
     * What the instance calls the button of this step (REQ-245, REQ-257). A
     * parameter, because the requirement is that the words come from the
     * SETTINGS: a fixture that could only ever send one label would prove the
     * button and never where it was written.
     */
    followButtonLabel: string = FOLLOW_BUTTON,
  ): { ports: EnginePorts; registry: FlowRegistry } {
    const bound = bindActiveAutomation(automation);
    if (!bound.ok) throw new Error("fixture should bind");

    const work = createDurableWorkStore(handle.db);

    return {
      registry: {
        current: (flowId) =>
          flowId === bound.definition.id ? bound.definition : undefined,
      },
      ports: {
        clock,
        contacts: createContactRepository(handle.db, () => now),
        sender: createQueueingSender(
          { work, clock },
          {
            origin: "comment",
            commentId: "comment-1",
            since: T0,
            executionId: "exec-1",
          },
        ),
        assets: createMemoryAssets({ "cover.png": RESOURCE }),
        random: { next: (): number => 0 },
        // What the step stopped declaring: one deadline and one number of
        // questions, from the instance (REQ-252, REQ-254).
        waiting: { hours: 24, questions: 3, followButtonLabel },
        suspender: createDurableSuspender(
          {
            work,
            conversations: createConversationStore(handle.db),
            clock,
            messageWindowHours: 24,
          },
          "exec-1",
        ),
        ...(follow !== undefined && { follow }),
      },
    };
  }

  const start: ExecutionStart = {
    flowId: GATE_AUTOMATION,
    contactId: CONTACT,
    origin: "comment",
    commentId: "comment-1",
  };

  async function queued(): Promise<string> {
    const items = await createDurableWorkStore(handle.db).due(
      new Date(8.64e15),
    );
    return items
      .filter((item) => item.kind === "send")
      .map((item) => JSON.stringify(item.payload))
      .join(" | ");
  }

  async function pendingWaits(): Promise<number> {
    const items = await createDurableWorkStore(handle.db).due(
      new Date(8.64e15),
    );
    return items.filter((item) => item.kind === "suspension").length;
  }

  beforeEach(() => {
    handle = openDatabase({ databasePath: IN_MEMORY_DATABASE });
    now = T0;
  });

  afterEach(() => {
    handle.close();
  });

  it("sends nothing and carries straight on for a contact who follows", async () => {
    const link = linkSaying(FOLLOWS);
    const { ports, registry } = wire(gateAutomation(), link);

    const result = await runExecution(start, registry, ports);

    expect(result.outcome).toBe("finished");
    expect(result.steps.map((step) => step.stepId)).toEqual([
      "require-follow",
      "deliver",
    ]);
    // Suppressed, never silent: an operator asking why this contact was not
    // asked to follow finds the answer on the step's own record.
    expect(result.steps[0]?.outcome).toBe("suppressed");
    expect(result.steps[0]?.reason).toBe("contact_already_follows");
    // The request never went out, and the resource did.
    expect(await queued()).not.toContain(ASK);
    expect(await queued()).toContain(RESOURCE);
    expect(await pendingWaits()).toBe(0);
    expect(link.asked).toEqual([CONTACT]);
  });

  it("sends the declared request and suspends for a contact who does not", async () => {
    const { ports, registry } = wire(gateAutomation(), linkSaying(DOES_NOT));

    const result = await runExecution(start, registry, ports);

    expect(result.outcome).toBe("suspended");
    // The step it stopped at, and NOTHING after it.
    expect(result.steps.map((step) => step.stepId)).toEqual(["require-follow"]);
    expect(result.steps[0]?.outcome).toBe("suspended");
    expect(await queued()).toContain(ASK);
    expect(await queued()).not.toContain(RESOURCE);
    expect(await pendingWaits()).toBe(1);
  });

  it("declares the wait as one the platform ends, not the contact", async () => {
    const { ports, registry } = wire(gateAutomation(), linkSaying(DOES_NOT));

    await runExecution(start, registry, ports);

    const [item] = (
      await createDurableWorkStore(handle.db).due(new Date(8.64e15))
    ).filter((row) => row.kind === "suspension");
    const payload = item?.payload as SuspensionPayload;
    // `follow`, and neither of the other two: `any` would let the contact's
    // next word open the gate, and `email` would judge a text that has nothing
    // to do with following.
    expect(payload.expects).toBe("follow");
    expect(payload.onTimeout).toBe("abandon");
    expect(item?.dueAt.getTime()).toBe(T0.getTime() + 24 * HOUR);
  });

  it.each(UNANSWERABLE)(
    "treats %s as a contact who does not follow, and says which cause",
    async (_label, status) => {
      // The most expensive defect of this task, and the one an optimistic
      // reading produces: a query that failed becomes "well, let them through".
      const { ports, registry } = wire(gateAutomation(), linkSaying(status));

      const result = await runExecution(start, registry, ports);

      expect(result.outcome).toBe("suspended");
      expect(result.steps.map((step) => step.stepId)).toEqual([
        "require-follow",
      ]);
      // Exactly what a non-follower gets: the declared request, and no
      // resource.
      expect(await queued()).toContain(ASK);
      expect(await queued()).not.toContain(RESOURCE);
      expect(await pendingWaits()).toBe(1);
      // And the cause is named, because "we asked and they do not follow" and
      // "we could not ask" send an operator to two different places.
      expect(result.steps[0]?.reason).toContain(
        status.kind === "unknown" ? status.cause : "",
      );
    },
  );

  it("REQ-245/REQ-316: the request always carries the button the INSTANCE names", async () => {
    const { ports, registry } = wire(gateAutomation(), linkSaying(DOES_NOT));

    await runExecution(start, registry, ports);

    const question = (
      await createDurableWorkStore(handle.db).due(new Date(8.64e15))
    ).find((item) => JSON.stringify(item.payload).includes(ASK));
    // Always a button, and never a bare text: a contact who has to type a
    // sentence to be re-checked is a contact who writes something else, and
    // the step has no way of telling that apart from the request being ignored.
    expect(question?.payload).toMatchObject({
      message: { cardButtons: [FOLLOW_BUTTON] },
    });
  });

  it("REQ-245: renaming it in the settings renames the button that goes out", async () => {
    // The words are the INSTANCE's, and this is the case that says so: nothing
    // in the automation declares them, so an operator who renames the button in
    // Settings renames it everywhere, in one place.
    const renamed = "Pronto, segui";
    const { ports, registry } = wire(
      gateAutomation(),
      linkSaying(DOES_NOT),
      renamed,
    );

    await runExecution(start, registry, ports);

    const question = (
      await createDurableWorkStore(handle.db).due(new Date(8.64e15))
    ).find((item) => JSON.stringify(item.payload).includes(ASK));
    expect(question?.payload).toMatchObject({
      message: { cardButtons: [renamed] },
    });
  });

  it("REQ-245: the button does not become what the wait expects", async () => {
    const { ports, registry } = wire(gateAutomation(), linkSaying(DOES_NOT));

    await runExecution(start, registry, ports);

    const [item] = (
      await createDurableWorkStore(handle.db).due(new Date(8.64e15))
    ).filter((row) => row.kind === "suspension");
    const payload = item?.payload as SuspensionPayload;
    // The button asks for the platform to be consulted again; it is not the
    // answer that opens the gate. Declaring its words as what the wait EXPECTS,
    // the way the confirmation declares its own, would hand the resource to
    // whoever reads the button and types it back (REQ-027).
    expect(payload.expects).toBe("follow");
    // They are on the record all the same, and the field they are in is the
    // whole distinction (REQ-246): `buttonLabel` is what the card SAYS, so the
    // card can go back out complete when the contact asks for it, while
    // `expects` is what would END the wait, and nothing typed ever does.
    expect(payload.buttonLabel).toBe(FOLLOW_BUTTON);
    expect(payload.question).toBe(ASK);
  });

  it("holds the gate when no link is wired, naming that as the cause", async () => {
    const { ports, registry } = wire(gateAutomation());

    const result = await runExecution(start, registry, ports);

    expect(result.outcome).toBe("suspended");
    expect(await queued()).toContain(ASK);
    expect(await queued()).not.toContain(RESOURCE);
    expect(result.steps[0]?.reason).toContain("not_configured");
  });
});

describe("REQ-027: end to end, through the dispatcher", () => {
  let handle: DatabaseHandle;
  let now: Date;
  let deps: DispatchDeps;
  let link: LinkDouble;

  function depsOver(open: DatabaseHandle, follow: FollowLink): DispatchDeps {
    const clock = { now: () => now };
    return {
      clock,
      // The version-2 aggregate IS what the runtime reads: no flow catalogue
      // and no parameter values participate in the execution (REQ-213).
      automationAggregates: createAutomationAggregateRepository(open.db, clock),
      work: createDurableWorkStore(open.db),
      conversations: createConversationStore(open.db),
      contacts: createContactRepository(open.db, () => now),
      assets: createMemoryAssets({ "cover.png": RESOURCE }),
      random: { next: (): number => 0 },
      audit: createAuditRepository(open.db),
      runs: createAutomationRunStore(open.db),
      messageWindowHours: 24,
      // The button the instance names, said out loud (REQ-245). What the
      // contact taps and what the wait compares against are the same words, so
      // a fixture that left this to the catalogue's default would be testing
      // the resend against a label nobody in this file ever sends.
      instanceSettings: fixedInstanceSettings({
        followButtonLabel: FOLLOW_BUTTON,
      }),
      follow,
    };
  }

  async function store(automation: ActiveAutomation): Promise<void> {
    const saved = await createAutomationAggregateRepository(handle.db, {
      now: () => now,
    }).save(automation);
    if (!saved.ok) throw new Error("fixture automation should be stored");
  }

  function commentPayload(): unknown {
    return {
      object: "instagram",
      entry: [
        {
          id: ACCOUNT,
          time: Math.floor(T0.getTime() / 1000),
          changes: [
            {
              field: "comments",
              value: {
                id: "comment-1",
                text: "I want the guide",
                from: { id: CONTACT },
                media: { id: "media-1" },
              },
            },
          ],
        },
      ],
    };
  }

  function messagePayload(text: string, mid: string): unknown {
    return {
      object: "instagram",
      entry: [
        {
          id: ACCOUNT,
          time: Math.floor(now.getTime() / 1000),
          messaging: [
            {
              sender: { id: CONTACT },
              recipient: { id: ACCOUNT },
              timestamp: now.getTime(),
              message: { mid, text },
            },
          ],
        },
      ],
    };
  }

  async function sent(): Promise<string> {
    const items = await createDurableWorkStore(handle.db).due(
      new Date(8.64e15),
    );
    return items
      .filter((item) => item.kind === "send")
      .map((item) => JSON.stringify(item.payload))
      .join(" | ");
  }

  /**
   * Every queued row carrying the request, which is one card the contact
   * receives.
   *
   * Counted as ROWS and not as a joined string, because that is the only thing
   * that distinguishes a card that was really sent again from one the queue
   * recognised as work it had already done and dropped in silence (REQ-247).
   */
  async function cards(): Promise<WorkItem[]> {
    const items = await createDurableWorkStore(handle.db).due(
      new Date(8.64e15),
    );
    return items.filter(
      (item) =>
        item.kind === "send" &&
        JSON.stringify(item.payload).includes(FOLLOW_BUTTON),
    );
  }

  /**
   * What the platform would actually receive for one queued row (REQ-318).
   *
   * Built from the row rather than described here, because WHICH primitive
   * carries a tappable choice is the adapter's decision and the point of the
   * case: a fixture that wrote the expected body by hand would agree with
   * itself while the send went out in the shape the platform rejects.
   */
  function wireBody(item: WorkItem | undefined): WireMessage {
    if (item === undefined) throw new Error("expected a queued card");

    const request = buildSendRequest(
      item.payload as SendPayload,
      "graph.example",
      ACCOUNT,
      "token",
    );

    return (request.body as { message: WireMessage }).message;
  }

  /** The buttons inside the single element of a generic template. */
  function buttonsOf(body: WireMessage): unknown[] | undefined {
    return body.attachment?.payload?.elements?.[0]?.buttons;
  }

  async function waiting(): Promise<WorkItem[]> {
    const items = await createDurableWorkStore(handle.db).due(
      new Date(8.64e15),
    );
    return items.filter((item) => item.kind === "suspension");
  }

  beforeEach(() => {
    handle = openDatabase({ databasePath: IN_MEMORY_DATABASE });
    now = T0;
    link = linkSaying(DOES_NOT, DOES_NOT, FOLLOWS);
    deps = depsOver(handle, link);
  });

  afterEach(() => {
    handle.close();
  });

  it("asks, holds every message, and delivers only once the follow is real", async () => {
    await store(gateAutomation());
    const dispatch = createDispatcher(deps);

    await dispatch(commentPayload(), "event-1");
    expect(await sent()).toContain(ASK);
    expect(await sent()).not.toContain(RESOURCE);

    now = new Date(T0.getTime() + HOUR);
    await dispatch(messagePayload("come on, send it", "mid-1"), "event-2");
    expect(await sent()).not.toContain(RESOURCE);

    now = new Date(T0.getTime() + 2 * HOUR);
    await dispatch(messagePayload("followed you", "mid-2"), "event-3");

    expect(await sent()).toContain(RESOURCE);
    // Once per interaction, the first query at the gate included.
    expect(link.asked).toHaveLength(3);
  });

  it("closes the phase: address first, follow second, resource last", async () => {
    // The two waits of this phase in one run, which is where they can
    // contradict each other: a wrong answer to the first must not open the
    // second, and the wait each of them starts must be judged by its OWN rule
    // (REQ-022 for the address, REQ-027 for the gate).
    await store(fullAutomation());
    const dispatch = createDispatcher(deps);

    await dispatch(commentPayload(), "event-1");
    expect(await sent()).toContain(EMAIL_ASK);

    // Not an address: re-asked, and the gate is nowhere in sight.
    now = new Date(T0.getTime() + HOUR);
    await dispatch(messagePayload("no thanks", "mid-1"), "event-2");
    expect(await sent()).not.toContain(ASK);
    expect(await sent()).not.toContain(RESOURCE);

    // An address: the run moves on and meets the gate, which asks.
    now = new Date(T0.getTime() + 2 * HOUR);
    await dispatch(messagePayload(ADDRESS, "mid-2"), "event-3");
    expect(await deps.contacts.getAttributes(CONTACT)).toStrictEqual({
      email: ADDRESS,
    });
    expect(await sent()).toContain(ASK);
    expect(await sent()).not.toContain(RESOURCE);

    // Writing again while still not following changes nothing at all.
    now = new Date(T0.getTime() + 3 * HOUR);
    await dispatch(messagePayload("is it coming?", "mid-3"), "event-4");
    expect(await sent()).not.toContain(RESOURCE);

    // And only the interaction the platform confirms delivers.
    now = new Date(T0.getTime() + 4 * HOUR);
    await dispatch(messagePayload("done, followed", "mid-4"), "event-5");
    expect(await sent()).toContain(RESOURCE);
  });

  it("REQ-246/REQ-247/REQ-316/REQ-317: the card really reaches the contact again, button and all", async () => {
    // The assertion the whole requirement turns on, and the failure it guards
    // is SILENT: a repeated card is word for word the message the first ask
    // queued, from the same run and the same step, so keyed on those alone the
    // second one is recognised as work already done and dropped with no error
    // anywhere. The contact taps, and nothing happens, for ever.
    await store(gateAutomation());
    deps = depsOver(handle, linkSaying(DOES_NOT));
    const dispatch = createDispatcher(deps);

    await dispatch(commentPayload(), "event-1");
    expect(await cards()).toHaveLength(1);

    now = new Date(T0.getTime() + HOUR);
    await dispatch(messagePayload(FOLLOW_BUTTON, "mid-1"), "event-2");

    const rows = await cards();
    // A SECOND row: one row is one message the contact receives.
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((item) => item.dedupeKey)).size).toBe(2);
    // Both are real work, pending delivery: neither is a row the queue
    // recognised as already done.
    expect(rows.every((item) => item.status === "pending")).toBe(true);
    // And the second one is a CARD and not a bare sentence: the button is the
    // whole reason it had to go out again.
    expect(rows[1]?.payload).toMatchObject({
      message: { text: RECHECK_ASK, cardButtons: [FOLLOW_BUTTON] },
    });
  });

  it("REQ-342: the first card and resend both travel as postback templates", async () => {
    // The follow request is a card, not a message with detached chips, whether
    // it opens the conversation from a comment or is resent inside one.
    //
    // The two ends are proved together on purpose: the queued row says which
    // mechanism was CHOSEN, and the built request says what the platform would
    // actually receive. Either one alone can be right while the wire is wrong.
    await store(gateAutomation());
    deps = depsOver(handle, linkSaying(DOES_NOT));
    const dispatch = createDispatcher(deps);

    await dispatch(commentPayload(), "event-1");

    now = new Date(T0.getTime() + HOUR);
    await dispatch(messagePayload(FOLLOW_BUTTON, "mid-1"), "event-2");

    const [opening, answering] = await cards();
    // The first card owns the private reply; the second one must not, or it
    // would be addressed by `comment_id` into a conversation that is already
    // open, which is the double delivery this split exists to stop.
    expect(opening?.payload).toMatchObject({
      privateReply: true,
      commentId: "comment-1",
    });
    expect(answering?.payload).toMatchObject({ privateReply: false });

    const first = wireBody(opening);
    const second = wireBody(answering);

    expect(first.quick_replies).toBeUndefined();
    expect(buttonsOf(first)).toStrictEqual([
      // The payload equals the title deliberately: what comes back from a tap
      // then reads the same whichever mechanism carried it, which is what lets
      // the wait compare the text and nothing else (REQ-248).
      { type: "postback", title: FOLLOW_BUTTON, payload: FOLLOW_BUTTON },
    ]);

    expect(second.quick_replies).toBeUndefined();
    expect(buttonsOf(second)).toStrictEqual([
      { type: "postback", title: FOLLOW_BUTTON, payload: FOLLOW_BUTTON },
    ]);
  });

  it("REQ-246/REQ-316: five taps, five cards, because only the deadline ends this step", async () => {
    // No ceiling, deliberately, and this is the case that says so. The number
    // of questions the instance configures is spent by wrong ANSWERS; here the
    // contact answered nothing wrongly, they asked to be checked again, and a
    // count would close a gate they may be one tap away from passing.
    await store(gateAutomation());
    const stubborn = linkSaying(DOES_NOT);
    deps = depsOver(handle, stubborn);
    const dispatch = createDispatcher(deps);

    await dispatch(commentPayload(), "event-1");

    for (let tap = 1; tap <= 5; tap += 1) {
      now = new Date(T0.getTime() + tap * HOUR);
      await dispatch(
        messagePayload(FOLLOW_BUTTON, `mid-${String(tap)}`),
        `event-${String(tap + 1)}`,
      );
    }

    // The first card plus one for every tap, each a row of its own.
    const rows = await cards();
    expect(rows).toHaveLength(6);
    expect(new Set(rows.map((item) => item.dedupeKey)).size).toBe(6);
    expect(rows.every((item) => item.status === "pending")).toBe(true);
    // Still waiting, and still nothing delivered: the fifth tap is as good as
    // the first, and the platform was asked on every one of them.
    expect(await waiting()).toHaveLength(1);
    expect(await sent()).not.toContain(RESOURCE);
    expect(stubborn.asked).toHaveLength(6);
  });

  it("REQ-246/REQ-316: the tap after all of them still delivers, once the follow is real", async () => {
    // The other half: repeating the card must not cost the contact anything.
    // A ceiling introduced here would end the run of somebody who followed
    // between their fifth tap and their sixth.
    await store(gateAutomation());
    deps = depsOver(
      handle,
      linkSaying(DOES_NOT, DOES_NOT, DOES_NOT, DOES_NOT, DOES_NOT, FOLLOWS),
    );
    const dispatch = createDispatcher(deps);

    await dispatch(commentPayload(), "event-1");

    for (let tap = 1; tap <= 5; tap += 1) {
      now = new Date(T0.getTime() + tap * HOUR);
      await dispatch(
        messagePayload(FOLLOW_BUTTON, `mid-${String(tap)}`),
        `event-${String(tap + 1)}`,
      );
    }

    expect(await sent()).toContain(RESOURCE);
    // And the delivery ends the wait: no card goes out after it.
    expect(await waiting()).toHaveLength(0);
    expect(await cards()).toHaveLength(5);
  });

  it("REQ-341: a text reply is held by the gate before a matching trigger can suppress its card", async () => {
    // REQ-341 deliberately changes the old REQ-242 ordering for a follow
    // gate: the card is the contact's only route through the gate, so a
    // matching trigger cannot be allowed to replace it before it is restored.
    await store(gateAutomation());
    await store(keywordAutomation("catalogue-automation", "catalogue"));
    deps = depsOver(handle, linkSaying(DOES_NOT));
    const dispatch = createDispatcher(deps);

    await dispatch(commentPayload(), "event-1");
    expect(await sent()).toContain(ASK);

    now = new Date(T0.getTime() + HOUR);
    await dispatch(messagePayload("send me the catalogue", "mid-1"), "event-2");

    expect(await sent()).not.toContain("catalogue-automation ran");
    // The gate remains open and its second card is queued with the result of
    // the just-completed query, rather than the initial ask a second time.
    expect(await sent()).not.toContain(RESOURCE);
    expect(await waiting()).toHaveLength(1);
    const rows = await cards();
    expect(rows).toHaveLength(2);
    expect(rows[1]?.payload).toMatchObject({
      message: { text: RECHECK_ASK, cardButtons: [FOLLOW_BUTTON] },
    });
  });

  it("REQ-242: the BUTTON is the wait's own, so its words start no other automation", async () => {
    // The exception, and the reason it is one. This message is a request
    // addressed to THIS wait (REQ-246), and the wait serves it. Offering it to
    // matching afterwards would let the words the instance prints on our own
    // button fire whatever automation happens to contain them, which is a
    // trigger the contact never typed.
    await store(gateAutomation());
    await store(keywordAutomation("button-word-automation", "segui"));
    deps = depsOver(handle, linkSaying(DOES_NOT));
    const dispatch = createDispatcher(deps);

    await dispatch(commentPayload(), "event-1");
    now = new Date(T0.getTime() + HOUR);
    await dispatch(messagePayload(FOLLOW_BUTTON, "mid-1"), "event-2");

    // The card came back, which is what the tap asked for.
    expect(await cards()).toHaveLength(2);
    // And the automation whose keyword is printed on that very button did not.
    expect(await sent()).not.toContain("button-word-automation ran");
    expect(await waiting()).toHaveLength(1);
    expect(await sent()).not.toContain(RESOURCE);
  });

  it("REQ-242: the same words from a contact with no gate DO fire that automation", async () => {
    // The control the case above needs. Without it, both would pass on a build
    // where the keyword simply never matches anything, and the exception would
    // be proving nothing at all.
    await store(keywordAutomation("button-word-automation", "segui"));
    deps = depsOver(handle, linkSaying(DOES_NOT));

    await createDispatcher(deps)(
      messagePayload(FOLLOW_BUTTON, "mid-1"),
      "event-1",
    );

    expect(await sent()).toContain("button-word-automation ran");
  });
});
