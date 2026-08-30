import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fixedInstanceSettings } from "../config/instance-settings.js";
import { runExecution } from "../engine/execute.js";
import type { ExecutionStart, FlowRegistry } from "../engine/execute.js";
import type { EnginePorts } from "../engine/ports.js";
import { bindActiveAutomation } from "../flows/binding.js";
import type { ActiveAutomation } from "../flows/schema.js";
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
import { EMAIL_ATTRIBUTE, emailIn, readAnswer } from "./answers.js";
import { createDispatcher } from "./dispatch.js";
import type { DispatchDeps } from "./dispatch.js";
import { createQueueingSender } from "./outbox.js";
import { createDurableSuspender, routeInbound } from "./suspension.js";
import type { ResumeDeps, SuspensionPayload } from "./suspension.js";

/**
 * Proves REQ-022: the step asks, the run stops, and only an answer that IS an
 * address carries it to the next step.
 *
 * What separates this from the confirmation of Phase 1b is the VERDICT. There,
 * any answer ended the wait, so "the contact replied" and "the contact answered
 * the question" were the same event and nothing had to tell them apart. Here
 * they are different events, and a run that treated them alike would store
 * "no thanks" as somebody's e-mail address and deliver the resource on it.
 *
 * The neighbouring suites own the halves this one deliberately does not repeat:
 * `known-email.test.ts` proves REQ-024 (an address already known is not asked
 * for again), and `attempts.test.ts` proves REQ-023 (the ceiling on how many
 * times one step may ask). What is left here is the verdict itself, and the
 * ORDER it takes part in (REQ-241 to REQ-244): the wait has the first word, so
 * an answer it ACCEPTS never reaches trigger matching, and one it REFUSES goes
 * on to matching exactly as if there were no wait.
 */

const T0 = new Date("2026-08-01T10:00:00.000Z");
const HOUR = 60 * 60 * 1000;
const ACCOUNT = "17841400000000000";
const CONTACT = "contact-1";
const ASK = "What is your e-mail?";
const ADDRESS = "bob@example.com";
const RESOURCE_URL = "https://cdn.example/guide.pdf";
const CONFIRM_ASK = "shall I send you the guide?";
const CONFIRM_BUTTON = "Yes";

/**
 * The instance's goodbye (REQ-255), written out rather than taken from the
 * catalogue so the assertions do not turn on which language the suite runs in.
 */
const GOODBYE = "That is all right. Nothing else will be sent.";

/**
 * The aggregate under test: it asks for the address, then delivers.
 *
 * Self-contained (REQ-213): the file it hands over is a value of the step, not
 * a parameter some automation fills in from outside.
 */
function leadAutomation(): ActiveAutomation {
  return {
    schema_version: 2,
    kind: "automation",
    id: "lead-automation",
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

/** A confirmation, whose yes is the text of its button since REQ-250. */
function confirmAutomation(): ActiveAutomation {
  return {
    schema_version: 2,
    kind: "automation",
    id: "confirm-automation",
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
        id: "confirm",
        action: "confirm_optin",
        text: CONFIRM_ASK,
        quick_reply_label: CONFIRM_BUTTON,
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

/** Fires on a direct message containing "guide": it is what must NOT run. */
function menuAutomation(): ActiveAutomation {
  return {
    schema_version: 2,
    kind: "automation",
    id: "menu-automation",
    state: "active",
    trigger: {
      type: "direct_message",
      match: { keywords: ["guide"], mode: "contains" },
    },
    // Immediate: nothing in this file is about WHEN the first reply leaves,
    // and zero is the timing every instant below was written under (REQ-277).
    rules: { once_per_contact: true, first_reply_delay_seconds: 0 },
    steps: [
      {
        id: "menu",
        action: "send_dm",
        message: { text: "the menu ran" },
      },
    ],
  };
}

describe("REQ-022: what counts as an answer to the question", () => {
  it.each([
    ["a plain address", "bob@example.com", "bob@example.com"],
    ["one written into a sentence", `sure, it is ${ADDRESS}!`, ADDRESS],
    ["one with a plus tag", "bob+news@example.com", "bob+news@example.com"],
    [
      "one on a second-level domain",
      "ana@mail.example.co.uk",
      "ana@mail.example.co.uk",
    ],
    ["one wrapped by a mail client", "<bob@example.com>", "bob@example.com"],
    ["one closing a sentence", "bob@example.com.", "bob@example.com"],
    ["one with surrounding blanks", "  bob@example.com  ", "bob@example.com"],
  ])("takes the address out of %s", (_label, answer, expected) => {
    expect(emailIn(answer)).toBe(expected);
  });

  it.each([
    ["an answer that is not one at all", "no thanks"],
    ["a sticker, which arrives as no text", ""],
    ["a bare word with an at sign", "@bob"],
    ["a host with no domain, which nothing can deliver to", "bob@localhost"],
    ["an address with no local part", "@example.com"],
    ["a sentence with an at sign in it", "call me at 9 @ home"],
    ["two at signs", "bob@@example.com"],
  ])("refuses %s", (_label, answer) => {
    expect(emailIn(answer)).toBeUndefined();
  });

  it("hands the accepted address back under the fixed attribute key", () => {
    // The key is FIXED on purpose: a per-step key would let two automations of
    // the same installation store one person's address twice under two names,
    // and "do not ask what we already know" would then be false for whichever
    // ran second (REQ-024, proved in known-email.test.ts).
    expect(readAnswer("email", `it is ${ADDRESS}`)).toStrictEqual({
      kind: "accepted",
      attribute: { key: EMAIL_ATTRIBUTE, value: ADDRESS },
    });
    expect(EMAIL_ATTRIBUTE).toBe("email");
  });

  it("accepts anything at all when the wait asks for any answer", () => {
    // What the confirmation declared until REQ-250, and what records written
    // before it still carry: the answer was the point, not its content. No step
    // creates such a wait any more, and the reading of the ones that exist is
    // the one they were written under.
    expect(readAnswer("any", "no thanks")).toStrictEqual({ kind: "accepted" });
    expect(readAnswer("any", "")).toStrictEqual({ kind: "accepted" });
  });

  it("REQ-100: refuses every text when the wait is ended by a query", () => {
    // The follow gate is not ended by what the contact writes, and this holds
    // at the function itself rather than only at its one careful caller. The
    // texts below are the ones a person actually sends when asked to follow,
    // and the last two are what the other two verdicts would accept: proving
    // the guard runs BEFORE the address branch and before the catch-all.
    for (const text of [
      "done",
      "i followed you",
      "yes",
      "",
      "bob@example.com",
    ]) {
      expect(readAnswer("follow", text)).toStrictEqual({ kind: "rejected" });
    }
  });
});

describe("REQ-022: the step asks, and the run waits for an address", () => {
  let handle: DatabaseHandle;
  let now: Date;
  const clock = { now: () => now };

  function wire(
    automation: ActiveAutomation,
    executionId: string,
  ): {
    ports: EnginePorts;
    registry: FlowRegistry;
  } {
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
          { origin: "comment", commentId: "comment-1", since: T0, executionId },
        ),
        assets: createMemoryAssets({ "cover.png": RESOURCE_URL }),
        random: { next: (): number => 0 },
        // What the step stopped declaring: one deadline and one number of
        // questions, from the instance (REQ-252, REQ-254).
        waiting: { hours: 24, questions: 3, followButtonLabel: "I followed" },
        suspender: createDurableSuspender(
          {
            work,
            conversations: createConversationStore(handle.db),
            clock,
            messageWindowHours: 24,
          },
          executionId,
        ),
      },
    };
  }

  function routingDeps(): ResumeDeps {
    return {
      work: createDurableWorkStore(handle.db),
      clock,
      contacts: createContactRepository(handle.db, () => now),
      audit: createAuditRepository(handle.db),
    };
  }

  const start: ExecutionStart = {
    flowId: "lead-automation",
    contactId: CONTACT,
    origin: "comment",
    commentId: "comment-1",
  };

  /** Everything queued to be sent, as one searchable string. */
  async function sent(): Promise<string> {
    const items = await createDurableWorkStore(handle.db).due(
      new Date(8.64e15),
    );
    return items
      .filter((item) => item.kind === "send")
      .map((item) => JSON.stringify(item.payload))
      .join(" | ");
  }

  /** The waits still on the table. A held answer must leave its own there. */
  async function waits() {
    const items = await createDurableWorkStore(handle.db).due(
      new Date(8.64e15),
    );
    return items.filter((item) => item.kind === "suspension");
  }

  beforeEach(() => {
    handle = openDatabase({ databasePath: IN_MEMORY_DATABASE });
    now = T0;
  });

  afterEach(() => {
    handle.close();
  });

  it("leaves behind a wait that only an ADDRESS can end, under the declared deadline", async () => {
    const { ports, registry } = wire(leadAutomation(), "exec-1");

    const result = await runExecution(start, registry, ports);

    expect(result.outcome).toBe("suspended");
    // The step it stopped at, and NOTHING after it: the delivery belongs to a
    // contact who has given an address, and no address exists yet.
    expect(result.steps.map((step) => step.stepId)).toEqual(["ask-email"]);
    expect(result.steps[0]?.outcome).toBe("suspended");

    const queued = await sent();
    expect(queued).toContain(ASK);
    expect(queued).not.toContain(RESOURCE_URL);

    // The record itself, and this is what the whole requirement rests on: a
    // wait that did not carry its verdict would be ended by ANY message, so the
    // first "no thanks" would deliver the resource. The deadline and the
    // give-up path are the step's own declaration, stored where the sweep will
    // find them hours later (REQ-025).
    const pending = await waits();
    expect(pending).toHaveLength(1);
    expect(pending[0]?.payload as SuspensionPayload).toMatchObject({
      contactId: CONTACT,
      stepId: "ask-email",
      expects: "email",
      onTimeout: "abandon",
    });
    expect(pending[0]?.dueAt).toStrictEqual(new Date(T0.getTime() + 24 * HOUR));
  });

  it("resumes at the NEXT step on an address, and stores it under `email`", async () => {
    const { ports, registry } = wire(leadAutomation(), "exec-1");
    await runExecution(start, registry, ports);

    now = new Date(T0.getTime() + HOUR);
    const routed = await routeInbound(routingDeps(), {
      contactId: CONTACT,
      text: ADDRESS,
    });

    expect(routed.kind).toBe("resume");
    expect(routed.kind === "resume" && routed.resumed.stepId).toBe("ask-email");

    // Written before the run picks up, because the steps after this one are
    // entitled to read what the contact just gave.
    expect(
      await createContactRepository(handle.db, () => now).getAttributes(
        CONTACT,
      ),
    ).toStrictEqual({ email: ADDRESS });

    const second = wire(leadAutomation(), "exec-1");
    const after = await runExecution(
      { ...start, resumeAfterStepId: "ask-email" },
      second.registry,
      second.ports,
    );

    // The step AFTER the one it waited at, and the question is not asked twice.
    expect(after.outcome).toBe("finished");
    expect(after.steps.map((step) => step.stepId)).toEqual(["deliver"]);
    expect(await sent()).toContain(RESOURCE_URL);
  });

  it("keeps the run exactly where it was when the answer is not an address", async () => {
    const { ports, registry } = wire(leadAutomation(), "exec-1");
    await runExecution(start, registry, ports);
    const audit = createAuditRepository(handle.db);

    now = new Date(T0.getTime() + HOUR);
    const routed = await routeInbound(
      { ...routingDeps(), audit },
      { contactId: CONTACT, text: "no thanks" },
    );

    expect(routed.kind).toBe("held");
    expect(routed.kind === "held" && routed.waiting.stepId).toBe("ask-email");

    // Nothing was stored, nothing was delivered, and the wait is still there:
    // completing it would let the very next answer resume a run that never got
    // what it asked for.
    expect(
      await createContactRepository(handle.db, () => now).getAttributes(
        CONTACT,
      ),
    ).toStrictEqual({});
    expect(await sent()).not.toContain(RESOURCE_URL);
    expect(await waits()).toHaveLength(1);

    // And an operator asking why a contact who wrote back received nothing
    // finds the answer rather than an absence.
    const refusal = (await audit.query({ contactId: CONTACT })).find(
      (entry) => entry.stepId === "ask-email" && entry.outcome === "suppressed",
    );
    expect(refusal?.reason).toContain("not the answer the step is waiting for");
  });

  it("still resumes when the address arrives after a refused answer", async () => {
    const { ports, registry } = wire(leadAutomation(), "exec-1");
    await runExecution(start, registry, ports);

    now = new Date(T0.getTime() + HOUR);
    await routeInbound(routingDeps(), {
      contactId: CONTACT,
      text: "no thanks",
    });
    const routed = await routeInbound(routingDeps(), {
      contactId: CONTACT,
      text: ADDRESS,
    });

    // The proof that the refusal left the record intact: the same wait, ended
    // by the second answer.
    expect(routed.kind).toBe("resume");
    expect(routed.kind === "resume" && routed.resumed.stepId).toBe("ask-email");
    expect(await waits()).toHaveLength(0);
  });

  it("REQ-067: the confirmation ends on ITS OWN answer, which is no address", async () => {
    const { ports, registry } = wire(confirmAutomation(), "exec-2");

    await runExecution(
      { ...start, flowId: "confirm-automation" },
      registry,
      ports,
    );

    now = new Date(T0.getTime() + HOUR);
    // The button's words, which are not an address and were never meant to be:
    // the regression this guards is the address verdict leaking into the step
    // that never asked for one.
    const routed = await routeInbound(routingDeps(), {
      contactId: CONTACT,
      text: "Yes",
    });

    expect(routed.kind).toBe("resume");
    expect(routed.kind === "resume" && routed.resumed.stepId).toBe("confirm");
  });

  it("REQ-067: a wait written before verdicts existed still ends on any answer", async () => {
    // Records already in the database carry no `expects` at all, and every one
    // of them is a confirmation. Reading the absence as anything but `any`
    // would strand those runs at their step until they timed out.
    const work = createDurableWorkStore(handle.db);
    await work.enqueue(
      {
        kind: "suspension",
        dedupeKey: "suspend:exec-old:confirm",
        payload: {
          flowId: "confirm-automation",
          contactId: CONTACT,
          stepId: "confirm",
          onTimeout: "abandon",
        },
        dueAt: new Date(T0.getTime() + 24 * HOUR),
        contactId: CONTACT,
        executionId: "exec-old",
      },
      T0,
    );

    const routed = await routeInbound(routingDeps(), {
      contactId: CONTACT,
      text: "ok",
    });

    expect(routed.kind).toBe("resume");
  });
});

describe("REQ-022: end to end through the dispatcher", () => {
  let handle: DatabaseHandle;
  let now: Date;
  let deps: DispatchDeps;

  function depsOver(open: DatabaseHandle): DispatchDeps {
    const clock = { now: () => now };
    return {
      clock,
      // The runtime reads the self-contained aggregate and nothing else: no
      // catalogue, no parameter binding (REQ-213).
      automationAggregates: createAutomationAggregateRepository(open.db, clock),
      work: createDurableWorkStore(open.db),
      conversations: createConversationStore(open.db),
      contacts: createContactRepository(open.db, () => now),
      assets: createMemoryAssets({ "cover.png": RESOURCE_URL }),
      random: { next: (): number => 0 },
      audit: createAuditRepository(open.db),
      runs: createAutomationRunStore(open.db),
      messageWindowHours: 24,
      instanceSettings: fixedInstanceSettings({ closingMessage: GOODBYE }),
    };
  }

  async function install(
    automations: readonly ActiveAutomation[] = [
      leadAutomation(),
      menuAutomation(),
    ],
  ): Promise<void> {
    const store = createAutomationAggregateRepository(handle.db, {
      now: () => now,
    });
    for (const automation of automations) {
      const saved = await store.save(automation);
      if (!saved.ok) throw new Error("fixture should save");
    }
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

  function messagePayload(text: string, mid = "mid-1"): unknown {
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

  async function sent(open: DatabaseHandle): Promise<string> {
    const items = await createDurableWorkStore(open.db).due(new Date(8.64e15));
    return items
      .filter((item) => item.kind === "send")
      .map((item) => JSON.stringify(item.payload))
      .join(" | ");
  }

  /** Every queued send carrying these words. One row is one message received. */
  async function sendsSaying(words: string): Promise<WorkItem[]> {
    const items = await createDurableWorkStore(handle.db).due(
      new Date(8.64e15),
    );
    return items.filter(
      (item) =>
        item.kind === "send" && JSON.stringify(item.payload).includes(words),
    );
  }

  /** Answers that are neither an address nor the button, one an hour apart. */
  async function answerWrongly(times: number): Promise<void> {
    const dispatch = createDispatcher(deps);
    for (let index = 1; index <= times; index += 1) {
      now = new Date(T0.getTime() + index * HOUR);
      await dispatch(
        messagePayload("no thanks", `mid-${String(index)}`),
        `event-${String(index + 1)}`,
      );
    }
  }

  beforeEach(() => {
    handle = openDatabase({ databasePath: IN_MEMORY_DATABASE });
    now = T0;
    deps = depsOver(handle);
  });

  afterEach(() => {
    handle.close();
  });

  it("asks, holds the wrong answer, and delivers on the right one", async () => {
    await install();
    const dispatch = createDispatcher(deps);

    await dispatch(commentPayload(), "event-1");
    expect(await sent(handle)).toContain(ASK);
    expect(await sent(handle)).not.toContain(RESOURCE_URL);

    // A wrong answer that matches NO trigger, so it stays the wait's business
    // from beginning to end. The one that matches a trigger is the case below,
    // and it now ends differently (REQ-242).
    now = new Date(T0.getTime() + HOUR);
    await dispatch(messagePayload("no thanks"), "event-2");

    expect(await sent(handle)).not.toContain(RESOURCE_URL);
    expect(await sent(handle)).not.toContain("the menu ran");
    expect(await deps.runs.hasRun("menu-automation", CONTACT)).toBe(false);

    // The right answer, and it carries the keyword of the automation standing
    // right there: it is an address AND a match. REQ-241 is what decides
    // between them, and it decides for the wait.
    now = new Date(T0.getTime() + 2 * HOUR);
    await dispatch(
      messagePayload(`send me the guide at ${ADDRESS}`, "mid-2"),
      "event-3",
    );

    expect(await sent(handle)).toContain(RESOURCE_URL);
    expect(await deps.contacts.getAttributes(CONTACT)).toStrictEqual({
      email: ADDRESS,
    });
    // Not the menu: an answer the wait ACCEPTED is never offered to matching,
    // or this contact receives the resource twice, once from the run that
    // finally unblocked and once from a run that should never have started.
    expect(await sent(handle)).not.toContain("the menu ran");
  });

  /**
   * REQ-242, REQ-243. The address wait, on the other side of the same order.
   *
   * A message that is not an address was never an answer to this question, so
   * it goes on to matching as if the contact were waiting for nothing. What
   * makes the pair worth proving HERE and not only on the confirmation is that
   * this step has no button at all: what it refuses is arbitrary text, which is
   * exactly what a trigger keyword is written in.
   */
  it("REQ-242: a refused answer that matches a trigger starts it and ends the wait", async () => {
    await install();
    const dispatch = createDispatcher(deps);

    await dispatch(commentPayload(), "event-1");
    now = new Date(T0.getTime() + HOUR);
    await dispatch(messagePayload("send me the guide"), "event-2");

    // The automation the words matched ran, and the run that was waiting for an
    // address ended without delivering: no address ever arrived.
    expect(await sent(handle)).toContain("the menu ran");
    expect(await sent(handle)).not.toContain(RESOURCE_URL);
    expect(
      await createDurableWorkStore(handle.db).pendingSuspensionsFor(CONTACT),
    ).toHaveLength(0);
  });

  it("REQ-243: the question is not repeated, and no attempt is spent, when a trigger took the contact", async () => {
    await install();
    const dispatch = createDispatcher(deps);

    await dispatch(commentPayload(), "event-1");
    now = new Date(T0.getTime() + HOUR);
    await dispatch(messagePayload("send me the guide"), "event-2");

    // The ask was still pending when the trigger ended its execution, so it
    // is retired rather than arriving below the menu the contact asked for.
    expect(await sendsSaying(ASK)).toHaveLength(0);

    const wait = await createDurableWorkStore(handle.db).findByKey(
      `suspend:lead-automation:${CONTACT}:${T0.getTime().toString(36)}:ask-email`,
    );
    // No question went out, so nothing was taken from the count that pays for
    // one. The routing used to spend it before this decision was even made.
    expect(wait?.attempts).toBe(0);
    expect(wait?.status).toBe("done");
  });

  it("REQ-243: the refused answer that matched nothing IS asked again, and pays for it", async () => {
    // Without this the pair above would pass on a dispatcher that simply
    // stopped asking again: the contact is still in the conversation, so the
    // question goes back out and the ask is counted where it always was.
    await install();
    const dispatch = createDispatcher(deps);

    await dispatch(commentPayload(), "event-1");
    now = new Date(T0.getTime() + HOUR);
    await dispatch(messagePayload("no thanks"), "event-2");

    expect(await sendsSaying(ASK)).toHaveLength(2);
    const wait = await createDurableWorkStore(handle.db).findByKey(
      `suspend:lead-automation:${CONTACT}:${T0.getTime().toString(36)}:ask-email`,
    );
    expect(wait?.attempts).toBe(1);
    expect(wait?.status).toBe("pending");
  });

  it("REQ-244: the answer that spends the LAST question also reaches the trigger", async () => {
    // The ending that used to be a full stop. The wait is already concluded by
    // the time this is decided, so the goodbye is owed whatever a trigger does
    // with the same words, and the words are owed their trigger because nothing
    // is holding them any more.
    await install();
    await createDispatcher(deps)(commentPayload(), "event-1");

    await answerWrongly(2);
    now = new Date(T0.getTime() + 3 * HOUR);
    await createDispatcher(deps)(
      messagePayload("send me the guide", "mid-last"),
      "event-last",
    );

    expect(await sendsSaying(GOODBYE)).toHaveLength(1);
    expect(await sent(handle)).toContain("the menu ran");
    // Three questions and no fourth: the ceiling is still a ceiling.
    expect(await sendsSaying(ASK)).toHaveLength(3);
    expect(await sent(handle)).not.toContain(RESOURCE_URL);
  });

  /**
   * REQ-256, for BOTH steps that can run out of questions.
   *
   * One message and one setting for the two of them, by the user's decision: to
   * a contact, being asked three times for an address and being asked three
   * times to confirm end the same way, and a sentence per step would be two
   * fields on the settings screen asking for the same thing.
   *
   * The pair is here rather than in `attempts.test.ts` because the risk is a
   * goodbye wired into the step that happened to be implemented first: the two
   * cases side by side are what makes that visible.
   */
  it("REQ-256: says goodbye when the ADDRESS questions run out", async () => {
    await install();
    await createDispatcher(deps)(commentPayload(), "event-1");

    await answerWrongly(3);

    expect(await sendsSaying(GOODBYE)).toHaveLength(1);
    // And the goodbye is the END of the run, not a message beside it: the
    // address never arrived, so the resource was never handed over.
    expect(await sent(handle)).not.toContain(RESOURCE_URL);
  });

  it("REQ-256: says goodbye when the CONFIRMATION questions run out", async () => {
    await install([confirmAutomation()]);
    await createDispatcher(deps)(commentPayload(), "event-1");

    await answerWrongly(3);

    // The same sentence, from the same setting, sent the same way: what ran out
    // is the same thing, and only the words of the question differ.
    expect(await sendsSaying(GOODBYE)).toHaveLength(1);
    expect(await sendsSaying(CONFIRM_ASK)).toHaveLength(3);
    expect(await sent(handle)).not.toContain(RESOURCE_URL);
  });
});

describe("REQ-022: the address outlives the process that collected it", () => {
  let directory: string;
  let databasePath: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "mychat-collect-"));
    databasePath = join(directory, "mychat.db");
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  it("is read by a later execution of the same contact after a restart", async () => {
    const before = openDatabase({ databasePath });
    const clock = { now: () => T0 };

    await createDurableWorkStore(before.db).enqueue(
      {
        kind: "suspension",
        dedupeKey: "suspend:exec-1:ask-email",
        payload: {
          flowId: "lead-automation",
          contactId: CONTACT,
          stepId: "ask-email",
          onTimeout: "abandon",
          expects: "email",
        },
        dueAt: new Date(T0.getTime() + 24 * HOUR),
        contactId: CONTACT,
        executionId: "exec-1",
      },
      T0,
    );

    const routed = await routeInbound(
      {
        work: createDurableWorkStore(before.db),
        clock,
        contacts: createContactRepository(before.db, () => T0),
      },
      { contactId: CONTACT, text: `here you go: ${ADDRESS}` },
    );
    expect(routed.kind).toBe("resume");
    before.close();

    // A different process, a different repository instance, the same contact.
    const after = openDatabase({ databasePath });
    const laterRun: EnginePorts["contacts"] = createContactRepository(
      after.db,
      () => new Date(T0.getTime() + 30 * 24 * HOUR),
    );

    // The engine reads attributes through this port on every turn of its loop,
    // so what a later run can branch on is exactly what this returns.
    expect(await laterRun.getAttributes(CONTACT)).toStrictEqual({
      email: ADDRESS,
    });
    after.close();
  });
});
