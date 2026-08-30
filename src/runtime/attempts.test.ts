import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fixedInstanceSettings } from "../config/instance-settings.js";
import type { InstanceSettings } from "../config/instance-settings.js";
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
import { createDispatcher } from "./dispatch.js";
import type { DispatchDeps } from "./dispatch.js";
import { createQueueingSender } from "./outbox.js";
import {
  createDurableSuspender,
  createSuspensionTimeoutHandler,
  routeInbound,
} from "./suspension.js";
import type { ResumeDeps, SuspensionPayload } from "./suspension.js";
import { runSweep } from "./sweep.js";

/**
 * Proves REQ-023: a wrong answer is asked again, up to the limit the automation
 * declared, and the limit spent ends the execution the way the automation said
 * it should. And with it REQ-060, on the half a wait is answerable for: what a
 * run repeats is the question CAPTURED when the pass started, not whatever the
 * automation says by the time the contact answers.
 *
 * Two things had to be true before any of this could work, and both were
 * broken in ways nothing pointed at:
 *
 * - `max_attempts` was declared and then dropped on the floor. The schema has
 *   carried it since Phase 0, the binding never mapped it, and the engine
 *   never saw it. No test crossed the two halves, which is the same blind spot
 *   that let the engine know only `send_message` while the binding produced
 *   `send_dm`. The tests here cross it deliberately.
 * - the queue's dedupe key would have SWALLOWED the second question. A re-ask
 *   is word for word the first ask, from the same execution and the same step,
 *   so the row it wanted to write was the row already there. `max_attempts`
 *   would then have meant "ask once, then wait in silence", which strands the
 *   contact worse than having no attempts at all.
 *
 * So the assertions are about messages that really left, and about a count
 * that really is in the database.
 */

const T0 = new Date("2026-08-01T10:00:00.000Z");
const HOUR = 60 * 60 * 1000;
const ACCOUNT = "17841400000000000";
const CONTACT = "contact-1";
const ASK = "What is your e-mail?";
const ADDRESS = "bob@example.com";
const WRONG = "no thanks";
const AUTOMATION = "lead-automation";

/** Three asks in total: the first one, and two more after a wrong answer. */
const MAX_ATTEMPTS = 3;

/**
 * The instance's goodbye (REQ-255), in words a case can look for in the queue.
 *
 * A variable and not a constant for the same reason `questions` below is one:
 * it is one setting of the instance, and what an operator can write into it is
 * what the tests have to survive.
 */
const GOODBYE = "No problem. Whenever you feel like it, just comment again.";
let closingMessage = GOODBYE;

/**
 * The instance's number of questions, which a case may move mid-run.
 *
 * A variable and not a constant, because REQ-254 moved this number out of the
 * step and into the instance: what a test used to express by editing the
 * automation it now expresses by changing the setting, which is what an
 * operator would actually do.
 */
let questions = MAX_ATTEMPTS;

/**
 * The self-contained aggregate the run is made of (REQ-213): the question it
 * asks and the file it hands over once answered.
 *
 * The CEILING is not in here any more (REQ-254). It was a field of the step
 * until phase 3l and is one setting of the instance now, so the number the wait
 * is written with comes from `questions` below, not from this document.
 */
function leadAutomation(ask = ASK): ActiveAutomation {
  return {
    schema_version: 2,
    kind: "automation",
    id: AUTOMATION,
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
        ask,
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
 * The whole queue, including what a sweep has already concluded.
 *
 * Read through `due` with a far-future instant, like the rest of the suite:
 * what matters here is how many ROWS carry the question, because one row is
 * one message the contact receives.
 */
async function queued(handle: DatabaseHandle): Promise<WorkItem[]> {
  return await createDurableWorkStore(handle.db).due(new Date(8.64e15));
}

/** Every queued send carrying these words. One row is one message received. */
async function sendsSaying(
  handle: DatabaseHandle,
  words: string,
): Promise<WorkItem[]> {
  return (await queued(handle)).filter(
    (item) =>
      item.kind === "send" && JSON.stringify(item.payload).includes(words),
  );
}

async function asksSent(
  handle: DatabaseHandle,
  question = ASK,
): Promise<WorkItem[]> {
  return await sendsSaying(handle, question);
}

async function waits(handle: DatabaseHandle): Promise<WorkItem[]> {
  return (await queued(handle)).filter((item) => item.kind === "suspension");
}

describe("REQ-023: the declared ceiling reaches the wait", () => {
  let handle: DatabaseHandle;
  let now: Date;
  const clock = { now: () => now };

  beforeEach(() => {
    handle = openDatabase({ databasePath: IN_MEMORY_DATABASE });
    now = T0;
  });

  afterEach(() => {
    handle.close();
  });

  it("writes the ceiling and the question onto the durable wait", async () => {
    const bound = bindActiveAutomation(leadAutomation());
    if (!bound.ok) throw new Error("fixture should bind");

    const work = createDurableWorkStore(handle.db);
    const ports: EnginePorts = {
      clock,
      contacts: createContactRepository(handle.db, () => now),
      assets: createMemoryAssets({ "cover.png": "https://cdn.example/x.pdf" }),
      sender: createQueueingSender(
        { work, clock },
        {
          origin: "comment",
          commentId: "comment-1",
          since: T0,
          executionId: "exec-1",
        },
      ),
      random: { next: (): number => 0 },
      // What the step stopped declaring, told to the engine instead
      // (REQ-252, REQ-254).
      waiting: {
        hours: 24,
        questions: MAX_ATTEMPTS,
        followButtonLabel: "I followed",
      },
      suspender: createDurableSuspender(
        {
          work,
          conversations: createConversationStore(handle.db),
          clock,
          messageWindowHours: 24,
        },
        "exec-1",
      ),
    };
    const registry: FlowRegistry = {
      current: (flowId) =>
        flowId === bound.definition.id ? bound.definition : undefined,
    };
    const start: ExecutionStart = {
      flowId: AUTOMATION,
      contactId: CONTACT,
      origin: "comment",
      commentId: "comment-1",
    };

    await runExecution(start, registry, ports);

    // Both halves of asking again live ON the record, so a process that comes
    // back after a restart can repeat the question without re-reading a
    // definition that may have been edited meanwhile (REQ-060).
    const [wait] = await waits(handle);
    expect(wait?.payload).toMatchObject({
      stepId: "ask-email",
      maxAttempts: MAX_ATTEMPTS,
      question: ASK,
    });
  });
});

describe("REQ-023: a wrong answer is asked again, and the run does not move", () => {
  let handle: DatabaseHandle;
  let now: Date;
  let deps: DispatchDeps;

  function depsOver(open: DatabaseHandle): DispatchDeps {
    const clock = { now: () => now };
    return {
      clock,
      automationAggregates: createAutomationAggregateRepository(open.db, clock),
      work: createDurableWorkStore(open.db),
      conversations: createConversationStore(open.db),
      contacts: createContactRepository(open.db, () => now),
      assets: createMemoryAssets({
        "cover.png": "https://cdn.example/guide.pdf",
      }),
      random: { next: (): number => 0 },
      audit: createAuditRepository(open.db),
      runs: createAutomationRunStore(open.db),
      messageWindowHours: 24,
      // Read on every pass, so a case can move the ceiling mid-run the way an
      // operator would (REQ-254).
      instanceSettings: {
        read: (): Promise<InstanceSettings> =>
          fixedInstanceSettings({ questions, closingMessage }).read(),
      },
    };
  }

  async function install(automation = leadAutomation()): Promise<void> {
    const result = await createAutomationAggregateRepository(handle.db, {
      now: () => now,
    }).save(automation);
    if (!result.ok) throw new Error("fixture automation should be stored");
  }

  function commentPayload(
    contactId = CONTACT,
    commentId = "comment-1",
  ): unknown {
    return {
      object: "instagram",
      entry: [
        {
          id: ACCOUNT,
          time: Math.floor(now.getTime() / 1000),
          changes: [
            {
              field: "comments",
              value: {
                id: commentId,
                text: "I want the guide",
                from: { id: contactId },
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

  beforeEach(() => {
    handle = openDatabase({ databasePath: IN_MEMORY_DATABASE });
    now = T0;
    questions = MAX_ATTEMPTS;
    closingMessage = GOODBYE;
    deps = depsOver(handle);
  });

  afterEach(() => {
    handle.close();
  });

  it("really puts the question back on the wire, and the queue does not swallow it", async () => {
    await install();
    const dispatch = createDispatcher(deps);

    await dispatch(commentPayload(), "event-1");
    expect(await asksSent(handle)).toHaveLength(1);

    now = new Date(T0.getTime() + HOUR);
    await dispatch(messagePayload(WRONG, "mid-1"), "event-2");

    // The assertion this whole task turns on: a SECOND row carrying the
    // question. One row is one message the contact receives, and the first
    // version of this feature would have produced exactly one row for both
    // asks, leaving the contact waiting for a question that never arrived.
    const asks = await asksSent(handle);
    expect(asks).toHaveLength(2);
    expect(new Set(asks.map((item) => item.dedupeKey)).size).toBe(2);
    // Both are real work, pending delivery: neither is a row the queue
    // recognised as already done.
    expect(asks.every((item) => item.status === "pending")).toBe(true);
  });

  it("REQ-251: a question asked as plain text comes back as plain text", async () => {
    // The other side of the card the confirmation and the follow gate repeat
    // (REQ-246, REQ-251). What goes out again is what went out the first time,
    // and this step asked for an address with no button: attaching one here
    // would offer the contact an answer the step does not accept, and the
    // wait would refuse the very tap it had just invited.
    await install();
    const dispatch = createDispatcher(deps);

    await dispatch(commentPayload(), "event-1");

    now = new Date(T0.getTime() + HOUR);
    await dispatch(messagePayload(WRONG, "mid-1"), "event-2");

    const asks = await asksSent(handle);
    expect(asks).toHaveLength(2);
    for (const ask of asks) {
      expect(JSON.stringify(ask.payload)).not.toContain("quickReplies");
    }
    // And the record says so: no button was ever on this card, so there is
    // none to put back.
    const [wait] = await waits(handle);
    expect((wait?.payload as SuspensionPayload).buttonLabel).toBeUndefined();
  });

  it("keeps the execution suspended at the same step, under the same deadline", async () => {
    await install();
    const dispatch = createDispatcher(deps);

    await dispatch(commentPayload(), "event-1");
    const [before] = await waits(handle);

    now = new Date(T0.getTime() + HOUR);
    await dispatch(messagePayload(WRONG, "mid-1"), "event-2");

    const [after] = await waits(handle);
    expect(after?.id).toBe(before?.id);
    expect((after?.payload as SuspensionPayload).stepId).toBe("ask-email");
    // The deadline does NOT move. Moving it would let a contact who keeps
    // answering wrongly hold the execution open past what the automation
    // allowed.
    expect(after?.dueAt).toStrictEqual(before?.dueAt);
    // The count that pays for the question just sent, on the record itself.
    expect(after?.attempts).toBe(1);

    // And the delivery is still not out: the run went nowhere.
    const sends = (await queued(handle)).filter(
      (item) =>
        item.kind === "send" &&
        JSON.stringify(item.payload).includes("cdn.example"),
    );
    expect(sends).toHaveLength(0);
  });

  it("resumes on an address that arrives after two refusals", async () => {
    await install();
    const dispatch = createDispatcher(deps);

    await dispatch(commentPayload(), "event-1");

    now = new Date(T0.getTime() + HOUR);
    await dispatch(messagePayload(WRONG, "mid-1"), "event-2");
    await dispatch(messagePayload("still not one", "mid-2"), "event-3");
    await dispatch(messagePayload(ADDRESS, "mid-3"), "event-4");

    // Three asks went out, the third answer was an address, and the file
    // followed: re-asking must not cost the contact the delivery.
    expect(await asksSent(handle)).toHaveLength(3);
    expect(await deps.contacts.getAttributes(CONTACT)).toStrictEqual({
      email: ADDRESS,
    });
    const delivered = (await queued(handle)).filter((item) =>
      JSON.stringify(item.payload).includes("cdn.example"),
    );
    expect(delivered).toHaveLength(1);
  });

  it("asks once and never again when the instance allows a single question", async () => {
    questions = 1;
    await install();
    const dispatch = createDispatcher(deps);

    await dispatch(commentPayload(), "event-1");

    now = new Date(T0.getTime() + HOUR);
    await dispatch(messagePayload(WRONG, "mid-1"), "event-2");

    // A ceiling of one is "ask, and take the answer or leave it". Re-asking
    // here would be the application overruling the operator.
    expect(await asksSent(handle)).toHaveLength(1);
    expect(await waits(handle)).toHaveLength(0);
  });

  it("REQ-060/REQ-254: repeats the question the pass captured, under the ceiling the wait was written with", async () => {
    const EDITED = "Type your e-mail address, please";
    await install();
    const dispatch = createDispatcher(deps);

    await dispatch(commentPayload(), "event-1");

    // The operator edits the automation while this contact is mid-answer, and
    // lowers the instance's number of questions to one, which would end the run
    // on the next wrong answer if it reached back into a wait already counting.
    now = new Date(T0.getTime() + HOUR);
    await install(leadAutomation(EDITED));
    questions = 1;

    await dispatch(messagePayload(WRONG, "mid-1"), "event-2");

    // The run in flight concludes under what it started with: the words the
    // contact was actually asked, and the ceiling that was in force when the
    // wait was written. Reading either back here would ask a question nobody
    // was asked and spend a ceiling nobody was told about.
    expect(await asksSent(handle, ASK)).toHaveLength(2);
    expect(await asksSent(handle, EDITED)).toHaveLength(0);
    expect(await waits(handle)).toHaveLength(1);

    // And the other half of REQ-060: a run started AFTER the edit gets the new
    // definition, so the edit was not simply ignored.
    now = new Date(T0.getTime() + 2 * HOUR);
    await dispatch(commentPayload("contact-2", "comment-2"), "event-3");

    expect(await asksSent(handle, EDITED)).toHaveLength(1);
  });
});

describe("REQ-023: the limit spent ends the run the way the automation declared", () => {
  let handle: DatabaseHandle;
  let now: Date;
  let deps: DispatchDeps;

  function depsOver(open: DatabaseHandle): DispatchDeps {
    const clock = { now: () => now };
    return {
      clock,
      automationAggregates: createAutomationAggregateRepository(open.db, clock),
      work: createDurableWorkStore(open.db),
      conversations: createConversationStore(open.db),
      contacts: createContactRepository(open.db, () => now),
      assets: createMemoryAssets({
        "cover.png": "https://cdn.example/guide.pdf",
      }),
      random: { next: (): number => 0 },
      audit: createAuditRepository(open.db),
      runs: createAutomationRunStore(open.db),
      messageWindowHours: 24,
      // Read on every pass, so a case can move the ceiling mid-run the way an
      // operator would (REQ-254).
      instanceSettings: {
        read: (): Promise<InstanceSettings> =>
          fixedInstanceSettings({ questions, closingMessage }).read(),
      },
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

  /** Wrong answers, one after another, each an hour apart. */
  async function answerWrongly(times: number): Promise<void> {
    const dispatch = createDispatcher(deps);
    for (let index = 1; index <= times; index += 1) {
      now = new Date(T0.getTime() + index * HOUR);
      await dispatch(messagePayload(WRONG, `mid-${String(index)}`), "event-x");
    }
  }

  beforeEach(async () => {
    handle = openDatabase({ databasePath: IN_MEMORY_DATABASE });
    now = T0;
    questions = MAX_ATTEMPTS;
    closingMessage = GOODBYE;
    deps = depsOver(handle);
    const stored = await createAutomationAggregateRepository(handle.db, {
      now: () => now,
    }).save(leadAutomation());
    if (!stored.ok) throw new Error("fixture automation should be stored");
    await createDispatcher(deps)(commentPayload(), "event-1");
  });

  afterEach(() => {
    handle.close();
  });

  it("REQ-256: says goodbye, through the queue every other message uses", async () => {
    await answerWrongly(MAX_ATTEMPTS);

    const goodbyes = await sendsSaying(handle, GOODBYE);
    const [goodbye] = goodbyes;
    const asks = await asksSent(handle);

    // The message this requirement is about, and exactly one of it: until now
    // the run ended, the trail recorded it, and the person on the other side
    // was told nothing at all.
    expect(goodbyes).toHaveLength(1);
    // Enqueued and pending, from the same run as the questions, and classed as
    // an ordinary direct message: that class is what puts it under the delivery
    // window, the platform caps and the retry budget (REQ-256). Sent inline
    // from here it would obey none of the three.
    expect(goodbye?.kind).toBe("send");
    expect(goodbye?.status).toBe("pending");
    expect(goodbye?.sendClass).toBe("direct_message");
    expect(goodbye?.executionId).toBe(asks[0]?.executionId);
    // And under an identity of its own. Four messages leave this run, so four
    // keys: a goodbye sharing a key with any question would be dropped by the
    // queue as work already done, with nothing recording that it was.
    expect(
      new Set([...asks, goodbye].map((item) => item?.dedupeKey)).size,
    ).toBe(MAX_ATTEMPTS + 1);
  });

  it("REQ-256: says nothing while there is still a question to ask", async () => {
    await answerWrongly(MAX_ATTEMPTS - 1);

    // Every question has gone out and the wait is still open, holding the last
    // one. Saying goodbye here would close a conversation the contact can still
    // answer, and the answer would then find nothing.
    expect(await asksSent(handle)).toHaveLength(MAX_ATTEMPTS);
    expect(await waits(handle)).toHaveLength(1);
    expect(await sendsSaying(handle, GOODBYE)).toHaveLength(0);
  });

  it("REQ-256: goes out even when it repeats the question word for word", async () => {
    // Nothing forbids an operator from closing with the same sentence the step
    // asks with, and the contact must receive it all the same. The queue keys a
    // send on the run, the step and the words of the message (`dedupeKeyFor` in
    // `outbox.ts`), so the ONLY thing keeping this message out of the identity
    // of the questions before it is the ordinal it goes out under.
    closingMessage = ASK;

    await answerWrongly(MAX_ATTEMPTS);

    // Three questions and the goodbye: four rows, four messages the contact
    // receives. A goodbye keyed like the first ask would be swallowed in
    // silence, and there would be three.
    expect(await sendsSaying(handle, ASK)).toHaveLength(MAX_ATTEMPTS + 1);
  });

  it("REQ-256: a deadline that simply passed says nothing at all", async () => {
    // The OTHER way a wait ends, and the reason the goodbye stops here. Nobody
    // answered, so hours of silence have gone by and nothing has renewed the
    // delivery window: on a run born from a direct message this send would land
    // on the edge of the 24 hours and be refused by the platform. Mandating it
    // would be mandating a message that cannot be delivered.
    const audit = createAuditRepository(handle.db);
    const clock = { now: () => now };
    now = new Date(T0.getTime() + 200 * HOUR);

    await runSweep({
      work: createDurableWorkStore(handle.db),
      clock,
      handlers: {
        suspension: createSuspensionTimeoutHandler({ audit, clock }),
      },
    });

    // The wait really did end this way: the deadline passed, and the run ended
    // through the path the automation declared.
    expect(await waits(handle)).toHaveLength(0);
    expect(
      (await audit.query({ contactId: CONTACT })).some((entry) =>
        entry.reason?.includes("did not answer before the deadline"),
      ),
    ).toBe(true);
    expect(await sendsSaying(handle, GOODBYE)).toHaveLength(0);
  });

  it("stops asking once the attempts are spent", async () => {
    await answerWrongly(MAX_ATTEMPTS);

    // Exactly the declared number of questions, the first one included, and
    // the last wrong answer bought nothing.
    expect(await asksSent(handle)).toHaveLength(MAX_ATTEMPTS);

    // A further answer finds no wait at all, so it cannot cost another
    // question either.
    now = new Date(T0.getTime() + 5 * HOUR);
    await createDispatcher(deps)(messagePayload(WRONG, "mid-late"), "event-9");
    expect(await asksSent(handle)).toHaveLength(MAX_ATTEMPTS);
    expect(await waits(handle)).toHaveLength(0);
  });

  it("leaves no wait behind for the deadline to find later", async () => {
    await answerWrongly(MAX_ATTEMPTS);

    const audit = createAuditRepository(handle.db);
    const clock = { now: () => now };
    now = new Date(T0.getTime() + 30 * HOUR);

    const report = await runSweep({
      work: createDurableWorkStore(handle.db),
      clock,
      handlers: {
        suspension: createSuspensionTimeoutHandler({ audit, clock }),
      },
    });

    // The wait was concluded when the attempts ran out. A row left pending
    // would bring the sweep back hours later to record a deadline nobody
    // reached, and the operator would read two endings for one execution.
    // The suspension handler is the only one registered, so a pass that
    // concludes nothing is a pass that found no wait.
    expect(await waits(handle)).toHaveLength(0);
    expect(report.completed).toBe(0);
    const timedOut = (await audit.query({ contactId: CONTACT })).filter(
      (entry) => entry.reason?.includes("did not answer before the deadline"),
    );
    expect(timedOut).toHaveLength(0);
  });

  it("records the give-up naming contact, step and reason", async () => {
    await answerWrongly(MAX_ATTEMPTS);

    const entries = await createAuditRepository(handle.db).query({
      contactId: CONTACT,
    });
    const giveUp = entries.find((entry) => entry.kind === "action_executed");

    expect(giveUp).toBeDefined();
    expect(giveUp?.contactId).toBe(CONTACT);
    expect(giveUp?.stepId).toBe("ask-email");
    // The aggregate IS the flow now (REQ-213), so the run it names is the
    // automation's own id and there is no second entity to point at.
    expect(giveUp?.flowId).toBe(AUTOMATION);
    expect(giveUp?.outcome).toBe("suppressed");
    // The path the automation declared is named, because that is what the
    // execution actually took: attempts and deadline end in the same place.
    expect(giveUp?.reason).toContain("abandon");
    expect(giveUp?.reason).toContain(String(MAX_ATTEMPTS));
  });

  it("tells the give-up apart from the one a missed deadline produces", async () => {
    await answerWrongly(MAX_ATTEMPTS);
    const audit = createAuditRepository(handle.db);

    const byAttempts = (await audit.query({ contactId: CONTACT })).find(
      (entry) => entry.kind === "action_executed",
    );

    // The same ending for a second contact, reached the other way: nobody
    // answered, and the deadline passed.
    const work = createDurableWorkStore(handle.db);
    const clock = { now: () => now };
    await work.enqueue(
      {
        kind: "suspension",
        dedupeKey: "suspend:exec-2:ask-email",
        payload: {
          flowId: AUTOMATION,
          contactId: "contact-2",
          stepId: "ask-email",
          onTimeout: "abandon",
          expects: "email",
          question: ASK,
          maxAttempts: MAX_ATTEMPTS,
        },
        dueAt: new Date(T0.getTime() + 24 * HOUR),
        contactId: "contact-2",
        executionId: "exec-2",
      },
      T0,
    );

    now = new Date(T0.getTime() + 25 * HOUR);
    await runSweep({
      work,
      clock,
      handlers: {
        suspension: createSuspensionTimeoutHandler({ audit, clock }),
      },
    });

    const byDeadline = (await audit.query({ contactId: "contact-2" })).find(
      (entry) => entry.kind === "action_executed",
    );

    expect(byDeadline?.reason).toBeDefined();
    expect(byAttempts?.reason).toBeDefined();
    // Same ending, and an operator must still be able to tell WHY a contact
    // got nothing: "never answered" and "answered three times, never with an
    // address" say different things about the question being asked.
    expect(byAttempts?.reason).not.toBe(byDeadline?.reason);
    expect(byDeadline?.reason).toContain("did not answer before the deadline");
    expect(byAttempts?.reason).not.toContain(
      "did not answer before the deadline",
    );
  });
});

describe("REQ-023: the count survives the process that started it", () => {
  let directory: string;
  let databasePath: string;

  function resumeDeps(handle: DatabaseHandle, at: Date): ResumeDeps {
    return {
      work: createDurableWorkStore(handle.db),
      clock: { now: () => at },
      contacts: createContactRepository(handle.db, () => at),
      audit: createAuditRepository(handle.db),
    };
  }

  async function suspend(handle: DatabaseHandle): Promise<void> {
    await createDurableWorkStore(handle.db).enqueue(
      {
        kind: "suspension",
        dedupeKey: "suspend:exec-1:ask-email",
        payload: {
          flowId: AUTOMATION,
          contactId: CONTACT,
          stepId: "ask-email",
          onTimeout: "abandon",
          expects: "email",
          question: ASK,
          maxAttempts: MAX_ATTEMPTS,
        },
        dueAt: new Date(T0.getTime() + 24 * HOUR),
        contactId: CONTACT,
        executionId: "exec-1",
      },
      T0,
    );
  }

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "mychat-attempts-"));
    databasePath = join(directory, "mychat.db");
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  it("continues from where the dead process left it, instead of starting over", async () => {
    const before = openDatabase({ databasePath });
    await suspend(before);

    // Two wrong answers, and both are asked again. The count moves when the
    // question is SENT and not when the answer is judged (REQ-243), so the
    // caller spends it here exactly as the dispatcher does: a test that only
    // routed would prove a counter nobody advances.
    for (const index of [1, 2]) {
      const routed = await routeInbound(
        resumeDeps(before, new Date(T0.getTime() + index * HOUR)),
        { contactId: CONTACT, text: WRONG },
      );
      expect(routed.kind).toBe("held");
      expect(routed.kind === "held" && routed.reask?.attempt).toBe(index + 1);
      await (routed.kind === "held" ? routed.reask?.spend() : undefined);
    }
    before.close();

    // A different process, a different store instance, the same file. Nothing
    // of the count was in memory, so nothing of it was lost.
    const after = openDatabase({ databasePath });
    const routed = await routeInbound(
      resumeDeps(after, new Date(T0.getTime() + 3 * HOUR)),
      { contactId: CONTACT, text: WRONG },
    );

    // The third wrong answer is the one that spends the ceiling. A count that
    // had restarted at zero would ask again here, and would go on asking after
    // every deploy, for ever.
    expect(routed.kind).toBe("abandoned");
    expect(
      (
        await createDurableWorkStore(after.db).findByKey(
          "suspend:exec-1:ask-email",
        )
      )?.status,
    ).toBe("done");
    after.close();
  });
});
