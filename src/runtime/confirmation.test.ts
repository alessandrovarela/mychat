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
import type { DatabaseHandle, WorkItem } from "../storage/index.js";
import { isButtonAnswer } from "./answers.js";
import { createDispatcher } from "./dispatch.js";
import type { DispatchDeps } from "./dispatch.js";
import { createQueueingSender } from "./outbox.js";
import {
  createDurableSuspender,
  createSuspensionTimeoutHandler,
  routeInbound,
  supersedePreviousWaits,
} from "./suspension.js";
import type {
  ResumeDeps,
  SuspensionPayload,
  WaitingExecution,
} from "./suspension.js";
import { runSweep } from "./sweep.js";

/**
 * Proves REQ-066, REQ-067, REQ-068, REQ-025, REQ-026 and, since phase 3l,
 * REQ-248, REQ-249 and REQ-250 — and, with them, the whole point of the phase:
 * the first message carries no link, and only the button counts as a yes.
 *
 * What changed in 3l is WHO the yes belongs to. The step used to accept any
 * answer at all, so a message about something else, from a contact who never
 * read the question, ended the wait and the resource went out on it. With a
 * deadline of a week that stopped being a corner case and became the ordinary
 * one, which is why the two go together: the long deadline is only safe because
 * the confirmation is judged by the text of its own button.
 *
 * This is also the first test in the project that crosses the binding and the
 * engine together. That gap is what let the engine know only `send_message`
 * while the binding produced `send_dm`, so a bound flow would have thrown on
 * delivery and no phase-1 test could see it (registered in the INBOX).
 */

const T0 = new Date("2026-08-01T10:00:00.000Z");
const HOUR = 60 * 60 * 1000;
/** What the step declares on its button, and therefore what confirms. */
const BUTTON = "Yes";
/** The same thing in the language an installation is really operated in. */
const ACCENTED_BUTTON = "Sim, começar";

/**
 * The wait this answer ended, if it ended one.
 *
 * The default is the text of the BUTTON, because that is the only answer that
 * ends this wait since REQ-250: a case here that says nothing about the answer
 * is a case about something else, and it has to send the one answer that works
 * or it would be testing the refusal by accident.
 */
async function resumedBy(
  deps: ResumeDeps,
  contactId: string,
  text = BUTTON,
): Promise<WaitingExecution | undefined> {
  const routed = await routeInbound(deps, { contactId, text });
  return routed.kind === "resume" ? routed.resumed : undefined;
}

function anchorFlow(button: string = BUTTON): ActiveAutomation {
  return {
    schema_version: 2,
    kind: "automation",
    id: "anchor-flow",
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
      { id: "reply", action: "reply_comment", text: "check your DMs" },
      {
        id: "confirm",
        action: "confirm_optin",
        text: "shall I send you the guide?",
        quick_reply_label: button,
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

describe("the anchor case, end to end and without a network", () => {
  let handle: DatabaseHandle;
  let clock: { now: () => Date; set(next: Date): void };

  function movable(at: Date) {
    let now = at;
    return {
      now: () => now,
      set(next: Date) {
        now = next;
      },
    };
  }

  function wire(
    executionId: string,
    /**
     * What the instance says a wait lasts (REQ-252). A parameter, because the
     * point of REQ-253 is what happens when it CHANGES between two passes.
     */
    waitHours = 24,
    /** What this automation's button says, which is what confirms (REQ-250). */
    button: string = BUTTON,
  ): {
    ports: EnginePorts;
    registry: FlowRegistry;
    assets: ReturnType<typeof createMemoryAssets>;
  } {
    const flow = anchorFlow(button);
    const bound = bindActiveAutomation(flow);
    if (!bound.ok) throw new Error("fixture should bind");

    const work = createDurableWorkStore(handle.db);
    const conversations = createConversationStore(handle.db);
    const assets = createMemoryAssets({
      "cover.png": "https://cdn.example/guide.pdf",
    });

    return {
      assets,
      registry: {
        current: (flowId) =>
          flowId === bound.definition.id ? bound.definition : undefined,
      },
      ports: {
        clock,
        contacts: createContactRepository(handle.db, clock.now),
        sender: createQueueingSender(
          { work, clock },
          {
            origin: "comment",
            commentId: "comment-1",
            since: T0,
            executionId,
          },
        ),
        assets,
        random: { next: (): number => 0 },
        // What the step stopped declaring: one deadline and one number of
        // questions, from the instance (REQ-252, REQ-254).
        waiting: {
          hours: waitHours,
          questions: 3,
          followButtonLabel: "I followed",
        },
        suspender: createDurableSuspender(
          { work, conversations, clock, messageWindowHours: 24 },
          executionId,
        ),
      },
    };
  }

  const start: ExecutionStart = {
    flowId: "anchor-flow",
    contactId: "contact-1",
    origin: "comment",
    commentId: "comment-1",
  };

  /** Everything the routing needs, over this test's database. */
  function routingDeps(): ResumeDeps {
    return {
      work: createDurableWorkStore(handle.db),
      clock,
      contacts: createContactRepository(handle.db, clock.now),
    };
  }

  beforeEach(() => {
    handle = openDatabase({ databasePath: IN_MEMORY_DATABASE });
    clock = movable(T0);
  });

  afterEach(() => {
    handle.close();
  });

  it("REQ-066: the first message carries no link at all", async () => {
    const { ports, registry } = wire("exec-1");
    const work = createDurableWorkStore(handle.db);

    const result = await runExecution(start, registry, ports);

    expect(result.outcome).toBe("suspended");
    const queued = await work.due(T0);
    const messages = queued.map((item) => JSON.stringify(item.payload));
    // Not one URL anywhere in what would be sent before the contact answers.
    for (const message of messages) {
      expect(message).not.toMatch(/https?:\/\//);
    }
    // The public reply and the question, and nothing else yet.
    expect(queued).toHaveLength(2);
  });

  it("REQ-067: the button's answer resumes the run at the next step, and delivers", async () => {
    const first = wire("exec-1");
    const work = createDurableWorkStore(handle.db);
    await runExecution(start, first.registry, first.ports);

    clock.set(new Date(T0.getTime() + HOUR));
    const resumed = await resumedBy(routingDeps(), "contact-1");

    expect(resumed?.stepId).toBe("confirm");

    const second = wire("exec-1");
    const after = await runExecution(
      { ...start, resumeAfterStepId: resumed!.stepId },
      second.registry,
      second.ports,
    );

    expect(after.outcome).toBe("finished");
    expect(after.steps.map((step) => step.stepId)).toEqual(["deliver"]);

    // And only NOW is the resource's URL resolved and put in the message.
    const delivered = (await work.due(new Date(8.64e15))).find((item) =>
      JSON.stringify(item.payload).includes("cdn.example"),
    );
    expect(delivered?.payload).toMatchObject({
      message: {
        card: { imageUrl: "https://cdn.example/guide.pdf" },
      },
    });
  });

  it("REQ-020: the URL is the one in force at send time, not at load", async () => {
    const first = wire("exec-1");
    const work = createDurableWorkStore(handle.db);
    await runExecution(start, first.registry, first.ports);
    await resumedBy(routingDeps(), "contact-1");

    // The resource is replaced between the run that suspended and the one
    // that delivers. Early resolution would send the old, expired URL.
    const second = wire("exec-1");
    second.assets.set("cover.png", "https://cdn.example/guide-v2.pdf");

    await runExecution(
      { ...start, resumeAfterStepId: "confirm" },
      second.registry,
      second.ports,
    );

    const delivered = (await work.due(new Date(8.64e15))).find((item) =>
      JSON.stringify(item.payload).includes("guide-v2"),
    );
    expect(delivered).toBeDefined();
  });

  it("REQ-249: a confirmation with no button fails, and asks nothing", async () => {
    // Until phase 3l this went out anyway, as text, and accepted whatever came
    // back. It cannot any more: what the button says IS the answer (REQ-250),
    // so a step with no button opens a wait nothing the contact sends could
    // ever end, and the contact would sit under the whole deadline because of
    // one blank field. Loud here, and refused by name at validation.
    const flow = anchorFlow();
    const stripped = {
      ...flow,
      steps: flow.steps.map((step) =>
        step.id === "confirm"
          ? { ...step, quick_reply_label: undefined }
          : step,
      ),
    };
    const bound = bindActiveAutomation(stripped as ActiveAutomation);
    if (!bound.ok) throw new Error("fixture should bind");

    const work = createDurableWorkStore(handle.db);
    const base = wire("exec-1");
    const result = await runExecution(
      start,
      { current: () => bound.definition },
      base.ports,
    );

    const confirm = result.steps.find((step) => step.stepId === "confirm");
    expect(result.outcome).toBe("failed");
    expect(confirm?.outcome).toBe("failed");
    // The stored code, and the step beside it: an operator reading the trail
    // has to be told WHICH step to go and fix (REQ-171).
    expect(confirm?.reason).toBe("confirmation_without_button");
    expect(confirm?.detail).toBe("confirm");

    const queued = await work.due(new Date(8.64e15));
    // Nothing was asked and nobody is waiting: a question that cannot be
    // answered is worse than no question, because the contact answers it.
    expect(
      queued.filter((item) => JSON.stringify(item.payload).includes("shall I")),
    ).toHaveLength(0);
    expect(queued.filter((item) => item.kind === "suspension")).toHaveLength(0);
    // And the delivery after it never ran: the steps that follow a confirmation
    // assume there was one.
    expect(
      queued.filter((item) =>
        JSON.stringify(item.payload).includes("guide.pdf"),
      ),
    ).toHaveLength(0);
  });

  it("REQ-086: the question goes out with the declared quick reply", async () => {
    const { ports, registry } = wire("exec-1");
    const work = createDurableWorkStore(handle.db);

    await runExecution(start, registry, ports);

    const question = (await work.due(T0)).find((item) =>
      JSON.stringify(item.payload).includes("shall I send"),
    );
    expect(question?.payload).toMatchObject({
      message: { quickReplies: ["Yes"] },
    });
  });

  it("REQ-067: resuming consumes the wait, so a redelivery finds nothing", async () => {
    const { ports, registry } = wire("exec-1");
    await runExecution(start, registry, ports);

    expect(await resumedBy(routingDeps(), "contact-1")).toBeDefined();
    // The platform redelivers on purpose; resuming twice would deliver twice.
    expect(await resumedBy(routingDeps(), "contact-1")).toBeUndefined();
    // And the redelivery is not held either: there is no wait left to hold it.
    expect(
      (
        await routeInbound(routingDeps(), {
          contactId: "contact-1",
          text: "yes",
        })
      ).kind,
    ).toBe("match");
  });

  it("REQ-067: the resuming message never reaches trigger matching", async () => {
    const { ports, registry } = wire("exec-1");
    const audit = createAuditRepository(handle.db);
    await runExecution(start, registry, ports);

    const routed = await routeInbound(
      { ...routingDeps(), audit },
      { contactId: "contact-1", text: "yes" },
    );

    // Matching it too would start a second run beside the one it unblocked,
    // and the contact would receive the resource twice.
    expect(routed.kind).toBe("resume");
    const consumed = (await audit.query({ contactId: "contact-1" })).find(
      (entry) => entry.outcome === "suppressed",
    );
    expect(consumed?.reason).toContain("trigger matching");

    // A message from someone who is not waiting goes to matching, as it must.
    expect(
      (
        await routeInbound(
          { ...routingDeps(), audit },
          { contactId: "contact-9", text: "yes" },
        )
      ).kind,
    ).toBe("match");
  });

  it("REQ-067: another contact's message does not resume this wait", async () => {
    const { ports, registry } = wire("exec-1");
    await runExecution(start, registry, ports);

    expect(await resumedBy(routingDeps(), "contact-2")).toBeUndefined();
  });

  it("REQ-235: the wait is found however long the queue is", async () => {
    // The defect this guards was invisible on a quiet queue and certain on a
    // busy one. The lookup read the hundred soonest-due pending rows, and a
    // wait sorts to the TAIL of that order by construction: a send is due now,
    // a wait is due in hours. A hundred pending sends hid it, the answer fell
    // through to trigger matching, and a second run handed the resource to
    // somebody who had confirmed nothing, which is the whole of REQ-067.
    const first = wire("exec-1");
    const work = createDurableWorkStore(handle.db);
    await runExecution(start, first.registry, first.ports);

    // Due BEFORE the wait, which is what puts them ahead of it in the order
    // the old lookup read. A hundred is the old ceiling exactly; the queue
    // reaches it under the platform's hourly cap, where sends are deferred.
    for (let i = 0; i < 100; i += 1) {
      await work.enqueue(
        {
          kind: "send",
          dedupeKey: `filler:${String(i)}`,
          payload: { message: { text: "filler" } },
          dueAt: T0,
          contactId: `other-contact-${String(i)}`,
          executionId: `filler-exec-${String(i)}`,
        },
        T0,
      );
    }

    clock.set(new Date(T0.getTime() + HOUR));
    const resumed = await resumedBy(routingDeps(), "contact-1");

    expect(resumed?.stepId).toBe("confirm");
  });

  it("REQ-068: a contact already in a conversation is not asked again", async () => {
    const conversations = createConversationStore(handle.db);
    await conversations.noteInbound("contact-1", new Date(T0.getTime() - HOUR));

    const { ports, registry } = wire("exec-1");
    const result = await runExecution(start, registry, ports);

    expect(result.outcome).toBe("finished");
    const confirm = result.steps.find((step) => step.stepId === "confirm");
    // Suppressed, not skipped in silence: an operator must be able to tell
    // this from a step that failed.
    expect(confirm?.outcome).toBe("suppressed");
    // The stored code, not a sentence: the words come from the catalogue where
    // it is read (REQ-163).
    expect(confirm?.reason).toBe("conversation_already_open");
    expect(result.steps.map((step) => step.stepId)).toEqual([
      "reply",
      "confirm",
      "deliver",
    ]);
  });

  it("REQ-068: a conversation older than the window is not open", async () => {
    const conversations = createConversationStore(handle.db);
    await conversations.noteInbound(
      "contact-1",
      new Date(T0.getTime() - 25 * HOUR),
    );

    const { ports, registry } = wire("exec-1");

    expect((await runExecution(start, registry, ports)).outcome).toBe(
      "suspended",
    );
  });

  it("REQ-068: a comment does not open a conversation", async () => {
    // The finding REQ-066 was written from: commenting does not put the
    // account in the contact's inbox, so it must not suppress the question.
    const { ports, registry } = wire("exec-1");

    expect((await runExecution(start, registry, ports)).outcome).toBe(
      "suspended",
    );
  });

  it("REQ-252: the wait comes due at the deadline the instance configured", async () => {
    const work = createDurableWorkStore(handle.db);
    const { ports, registry } = wire("exec-1", 168);

    await runExecution(start, registry, ports);

    const [wait] = (
      await work.due(new Date(T0.getTime() + 1000 * HOUR))
    ).filter((item) => item.kind === "suspension");
    // A week, written into the durable record and not into a variable: the
    // deadline the sweep will honour is the number the operator configured.
    expect(wait?.dueAt.getTime()).toBe(T0.getTime() + 168 * HOUR);
  });

  it("REQ-253: shortening the deadline leaves a wait already counting where it was", async () => {
    const work = createDurableWorkStore(handle.db);
    const first = wire("exec-1", 168);

    await runExecution(start, first.registry, first.ports);

    const born = (await work.due(new Date(T0.getTime() + 1000 * HOUR))).find(
      (item) => item.kind === "suspension",
    );
    expect(born?.dueAt.getTime()).toBe(T0.getTime() + 168 * HOUR);

    // The operator shortens the instance's deadline while this contact is
    // still being waited for, and a second contact starts a run under the new
    // one.
    clock.set(new Date(T0.getTime() + HOUR));
    const second = wire("exec-2", 24);
    await runExecution(
      { ...start, contactId: "contact-2" },
      second.registry,
      second.ports,
    );

    const rows = (await work.due(new Date(T0.getTime() + 1000 * HOUR))).filter(
      (item) => item.kind === "suspension",
    );
    const held = rows.find((item) => item.contactId === "contact-1");
    const fresh = rows.find((item) => item.contactId === "contact-2");

    // The first wait keeps the instant it was BORN with, to the millisecond:
    // the deadline is computed when the step asks and written into the record,
    // so nothing said afterwards can reach back into it. Re-reading the setting
    // at the sweep would have cut this contact's week down to a day, hours
    // after they were told they had one.
    expect(held?.dueAt.getTime()).toBe(T0.getTime() + 168 * HOUR);
    // And the change was not simply ignored: the wait created after it counts
    // its own twenty-four hours, from its own instant.
    expect(fresh?.dueAt.getTime()).toBe(T0.getTime() + HOUR + 24 * HOUR);
  });

  it("REQ-025: a wait that runs out ends through the flow's declared path", async () => {
    const { ports, registry } = wire("exec-1");
    const work = createDurableWorkStore(handle.db);
    const audit = createAuditRepository(handle.db);
    await runExecution(start, registry, ports);

    // Before the deadline: still waiting.
    clock.set(new Date(T0.getTime() + 23 * HOUR));
    let report = await runSweep({
      work,
      clock,
      handlers: {
        suspension: createSuspensionTimeoutHandler({ audit, clock }),
      },
    });
    expect(report.completed).toBe(0);

    clock.set(new Date(T0.getTime() + 25 * HOUR));
    report = await runSweep({
      work,
      clock,
      handlers: {
        suspension: createSuspensionTimeoutHandler({ audit, clock }),
      },
    });

    expect(report.completed).toBe(1);
    const entries = await audit.query({ contactId: "contact-1" });
    expect(entries[0]?.reason).toContain("abandon");
    expect(entries[0]?.outcome).toBe("suppressed");
  });

  it("REQ-236: a wait another run superseded ends once, and takes no answer", async () => {
    // The dispatcher's side of this rule is proved in `dispatch.test.ts`, over
    // two real automations. What is on trial here is the wait itself: a
    // supersession has to CONCLUDE it, so the deadline it was counting never
    // arrives and the button that used to end it finds nothing left to end.
    // A wait merely marked as superseded would end a second time hours later,
    // and the contact would be recorded as having missed a question that had
    // stopped being theirs.
    const { ports, registry } = wire("exec-1");
    const work = createDurableWorkStore(handle.db);
    const audit = createAuditRepository(handle.db);
    await runExecution(start, registry, ports);

    clock.set(new Date(T0.getTime() + HOUR));
    await supersedePreviousWaits(
      { work, audit },
      {
        contactId: "contact-1",
        executionId: "exec-2",
        automationId: "other-automation",
      },
      clock.now(),
    );

    expect(await resumedBy(routingDeps(), "contact-1")).toBeUndefined();

    clock.set(new Date(T0.getTime() + 25 * HOUR));
    const report = await runSweep({
      work,
      clock,
      handlers: {
        suspension: createSuspensionTimeoutHandler({ audit, clock }),
      },
    });
    expect(report.completed).toBe(0);

    // REQ-238: one ending, and it says which of the three it was.
    const ended = (await audit.query({ contactId: "contact-1" })).filter(
      (entry) => entry.subtype === "wait_ended",
    );
    expect(ended).toHaveLength(1);
    expect(ended[0]?.reason).toBe(
      t("suspension.superseded", { automation: "other-automation" }),
    );
  });

  it("REQ-250: the wait carries the words that went out on the button", async () => {
    const { ports, registry } = wire("exec-1");
    const work = createDurableWorkStore(handle.db);

    await runExecution(start, registry, ports);

    const [wait] = (await work.due(new Date(8.64e15))).filter(
      (item) => item.kind === "suspension",
    );
    // The label travels INSIDE what the wait expects, so the answer is judged
    // against the very words the contact was shown. Kept anywhere else, a
    // record could declare a button and carry nothing to compare against, and
    // nothing the contact sent would ever satisfy it.
    expect((wait?.payload as SuspensionPayload).expects).toStrictEqual({
      kind: "button",
      label: BUTTON,
    });
  });

  it.each([
    ["a question of their own, days later", "oi, quanto custa?"],
    ["a bare no", "no"],
    ["a sticker, which arrives as no text", ""],
    ["the button's word inside a sentence", "yes please, send it"],
    ["only part of what the button says", "ye"],
    ["an address, which another step would have taken", "bob@example.com"],
  ])(
    "REQ-250: %s does not confirm, and the run stays where it was",
    async (_label, answer) => {
      // The defect this closes, and the reason the deadline could go to a week:
      // any of these used to END the wait and hand over the resource, so a
      // message from somebody who never read the question was stored as
      // consent.
      const { ports, registry } = wire("exec-1");
      const work = createDurableWorkStore(handle.db);
      await runExecution(start, registry, ports);

      clock.set(new Date(T0.getTime() + HOUR));
      const routed = await routeInbound(routingDeps(), {
        contactId: "contact-1",
        text: answer,
      });

      expect(routed.kind).toBe("held");
      // Still waiting at the same step, and nothing delivered.
      const items = await work.due(new Date(8.64e15));
      expect(items.filter((item) => item.kind === "suspension")).toHaveLength(
        1,
      );
      expect(
        items.filter((item) =>
          JSON.stringify(item.payload).includes("guide.pdf"),
        ),
      ).toHaveLength(0);
    },
  );

  it.each([
    ["the very words", ACCENTED_BUTTON],
    ["with no accent, as anybody in a hurry types it", "sim, comecar"],
    ["shouted", "SIM, COMEÇAR"],
    ["with the blanks a paste carries", "   Sim, começar  "],
    [
      "decomposed, as an iPhone keyboard writes it",
      ACCENTED_BUTTON.normalize("NFD"),
    ],
  ])("REQ-248: %s confirms", async (_label, answer) => {
    // Case, accents and edge blanks are folded, and each of the three is a way
    // the same answer really arrives: the phone capitalises on its own, the
    // accent is what people drop first, and a tap carries no blanks while
    // typing carries them as often as not.
    const { ports, registry } = wire("exec-1", 24, ACCENTED_BUTTON);
    await runExecution(start, registry, ports);

    clock.set(new Date(T0.getTime() + HOUR));
    const resumed = await resumedBy(routingDeps(), "contact-1", answer);

    expect(resumed?.stepId).toBe("confirm");
  });

  it.each([
    ["a prefix of it", "Sim"],
    ["it with something else after", "Sim, começar hoje"],
    ["a different word altogether", "Começar"],
  ])(
    "REQ-250: %s is not the button's text, and does not confirm",
    async (_label, answer) => {
      // What REQ-248 folds is SPELLING, never meaning: the comparison stays an
      // equality, so a message that merely contains the words is refused. A rule
      // that accepted containment would read "não, sim que não" as a yes.
      const { ports, registry } = wire("exec-1", 24, ACCENTED_BUTTON);
      await runExecution(start, registry, ports);

      clock.set(new Date(T0.getTime() + HOUR));

      expect(
        await resumedBy(routingDeps(), "contact-1", answer),
      ).toBeUndefined();
    },
  );
});

describe("REQ-248: one reading of a tapped button, for both steps that send one", () => {
  it.each([
    ["exactly", "Já segui", "Já segui"],
    ["with no accent", "Já segui", "ja segui"],
    ["shouted", "Já segui", "JÁ SEGUI"],
    ["with blanks around it", "Já segui", "  já segui  "],
    ["decomposed", "Já segui", "Já segui".normalize("NFD")],
    [
      "composed against a decomposed label",
      "Já segui".normalize("NFD"),
      "Já segui",
    ],
    ["with a cedilla folded", "Sim, começar", "sim, comecar"],
  ])("takes %s as the button", (_label, button, answer) => {
    expect(isButtonAnswer(button, answer)).toBe(true);
  });

  it.each([
    ["a prefix", "Já segui", "Já"],
    ["a superset", "Já segui", "Já segui, e agora?"],
    ["another phrase", "Já segui", "segui já"],
    ["punctuation that was never on the button", "Já segui", "Já segui!"],
  ])("refuses %s", (_label, button, answer) => {
    expect(isButtonAnswer(button, answer)).toBe(false);
  });

  it.each([
    ["an empty message", ""],
    ["a blank one", "   "],
    ["anything at all", "yes"],
  ])("matches nothing when the button has no words: %s", (_label, answer) => {
    // A wait declaring a button with nothing on it is one no contact could
    // satisfy, and reading it as "anything at all" would restore in silence the
    // loosest rule there is, which is the one REQ-250 removed. The engine
    // refuses to create such a wait; this is the second lock.
    expect(isButtonAnswer("", answer)).toBe(false);
    expect(isButtonAnswer("   ", answer)).toBe(false);
  });
});

describe("REQ-026: a wait survives the process", () => {
  let directory: string;
  let databasePath: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "mychat-suspend-"));
    databasePath = join(directory, "mychat.db");
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  function suspenderFor(handle: DatabaseHandle, now: Date) {
    return createDurableSuspender(
      {
        work: createDurableWorkStore(handle.db),
        conversations: createConversationStore(handle.db),
        clock: { now: () => now },
        messageWindowHours: 24,
      },
      "exec-1",
    );
  }

  it("is still waiting after a restart, and resumes on the answer", async () => {
    const before = openDatabase({ databasePath });
    await suspenderFor(before, T0).suspend({
      contactId: "contact-1",
      flowId: "anchor-flow",
      stepId: "confirm",
      expiresAt: new Date(T0.getTime() + 24 * HOUR),
      onTimeout: "abandon",
      // The words of the button travel WITH the record (REQ-250), so what the
      // process that comes back judges the answer against is what the process
      // that died had actually sent.
      expects: { kind: "button", label: BUTTON },
    });
    before.close();

    const after = openDatabase({ databasePath });
    const later = new Date(T0.getTime() + HOUR);
    const resumed = await resumedBy(
      {
        work: createDurableWorkStore(after.db),
        clock: { now: () => later },
        contacts: createContactRepository(after.db, () => later),
      },
      "contact-1",
    );

    expect(resumed).toMatchObject({
      flowId: "anchor-flow",
      stepId: "confirm",
      contactId: "contact-1",
    });
    after.close();
  });

  it("still times out after a restart, at the instant it was going to", async () => {
    const before = openDatabase({ databasePath });
    await suspenderFor(before, T0).suspend({
      contactId: "contact-1",
      flowId: "anchor-flow",
      stepId: "confirm",
      expiresAt: new Date(T0.getTime() + 24 * HOUR),
      onTimeout: "abandon",
      // The words of the button travel WITH the record (REQ-250), so what the
      // process that comes back judges the answer against is what the process
      // that died had actually sent.
      expects: { kind: "button", label: BUTTON },
    });
    before.close();

    const after = openDatabase({ databasePath });
    const work = createDurableWorkStore(after.db);
    const audit = createAuditRepository(after.db);
    const clock = { now: () => new Date(T0.getTime() + 25 * HOUR) };

    const report = await runSweep({
      work,
      clock,
      handlers: {
        suspension: createSuspensionTimeoutHandler({ audit, clock }),
      },
    });

    // A restart is not a reason to forget someone was waiting, nor to forget
    // when the waiting was supposed to end.
    expect(report.completed).toBe(1);
    after.close();
  });
});

/**
 * REQ-251, and it is the requirement the platform's own behaviour forces.
 *
 * The confirmation is answered by TAPPING its button (REQ-250), and a quick
 * reply is attached to the most recent message of the conversation
 * (`docs/platform-limits.md`): the instant the contact writes anything at all,
 * the button leaves their screen. So a contact who types "yes please" instead
 * of pressing it is refused by the wait, and then sits in front of a
 * conversation with no button, knowing what they want and with no way to say
 * it. What has to go back out is the CARD, not the sentence.
 *
 * The ceiling is the other half, and it is the opposite of the follow gate's
 * (REQ-246): there the resend answers a REQUEST and repeats while the contact
 * insists, here it answers a MISTAKE, so the number of questions the instance
 * configures is what it spends, and the run ends when they are gone.
 */
describe("REQ-251: a refused confirmation brings the card back, up to the ceiling", () => {
  const ACCOUNT = "17841400000000000";
  const CONTACT = "contact-1";
  const CARD = "shall I send you the guide?";
  const RESOURCE = "https://cdn.example/guide.pdf";
  /** Three questions in total: the first one, and two more after a mistake. */
  const QUESTIONS = 3;

  let handle: DatabaseHandle;
  let now: Date;
  let questions: number;
  let deps: DispatchDeps;

  function depsOver(open: DatabaseHandle): DispatchDeps {
    const clock = { now: () => now };
    return {
      clock,
      automationAggregates: createAutomationAggregateRepository(open.db, clock),
      work: createDurableWorkStore(open.db),
      conversations: createConversationStore(open.db),
      contacts: createContactRepository(open.db, () => now),
      assets: createMemoryAssets({ "cover.png": RESOURCE }),
      random: { next: (): number => 0 },
      audit: createAuditRepository(open.db),
      runs: createAutomationRunStore(open.db),
      messageWindowHours: 24,
      // Read on every pass, so a case can set the number of questions the way
      // an operator would (REQ-254).
      instanceSettings: {
        read: (): Promise<InstanceSettings> =>
          fixedInstanceSettings({ questions }).read(),
      },
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

  /**
   * Every queued row carrying the question, which is one card the contact
   * receives.
   *
   * Rows and not a joined string: what tells a card that was really sent again
   * from one the queue recognised as work already done, and dropped in
   * silence, is that there is a SECOND row (REQ-247).
   */
  async function cards(): Promise<WorkItem[]> {
    const items = await createDurableWorkStore(handle.db).due(
      new Date(8.64e15),
    );
    return items.filter(
      (item) =>
        item.kind === "send" && JSON.stringify(item.payload).includes(CARD),
    );
  }

  async function waits(): Promise<WorkItem[]> {
    const items = await createDurableWorkStore(handle.db).due(
      new Date(8.64e15),
    );
    return items.filter((item) => item.kind === "suspension");
  }

  async function delivered(): Promise<WorkItem[]> {
    const items = await createDurableWorkStore(handle.db).due(
      new Date(8.64e15),
    );
    return items.filter((item) =>
      JSON.stringify(item.payload).includes(RESOURCE),
    );
  }

  /** Answers that are not the button, one an hour, each its own message. */
  async function answerWrongly(times: number): Promise<void> {
    const dispatch = createDispatcher(deps);
    for (let index = 1; index <= times; index += 1) {
      now = new Date(T0.getTime() + index * HOUR);
      await dispatch(
        messagePayload("yes please, send it", `mid-${String(index)}`),
        `event-${String(index + 1)}`,
      );
    }
  }

  beforeEach(async () => {
    handle = openDatabase({ databasePath: IN_MEMORY_DATABASE });
    now = T0;
    questions = QUESTIONS;
    deps = depsOver(handle);
    const stored = await createAutomationAggregateRepository(handle.db, {
      now: () => now,
    }).save(anchorFlow());
    if (!stored.ok) throw new Error("fixture automation should be stored");
    await createDispatcher(deps)(commentPayload(), "event-1");
  });

  afterEach(() => {
    handle.close();
  });

  it("really puts the CARD back on the wire, button and all", async () => {
    expect(await cards()).toHaveLength(1);

    await answerWrongly(1);

    const rows = await cards();
    // A second row: one row is one message the contact receives.
    expect(rows).toHaveLength(2);
    // REQ-247: the queue must not recognise the repeat as the first card. The
    // two are word for word the same message, from the same run and the same
    // step, so nothing inside them tells the two apart.
    expect(new Set(rows.map((item) => item.dedupeKey)).size).toBe(2);
    expect(rows.every((item) => item.status === "pending")).toBe(true);
    // And it is a CARD: repeating the words alone would ask the contact a
    // question they still have no way of answering, because their own message
    // is what took the button off their screen.
    expect(rows[1]?.payload).toMatchObject({
      message: { text: CARD, quickReplies: [BUTTON] },
    });
  });

  it("stops at the number of questions the instance configured, and ends the run", async () => {
    await answerWrongly(QUESTIONS);

    // Exactly the configured number of questions, the first one included: the
    // last wrong answer bought nothing.
    expect(await cards()).toHaveLength(QUESTIONS);
    // The wait is concluded here rather than left for the deadline, so nothing
    // can end this execution twice.
    expect(await waits()).toHaveLength(0);
    expect(await delivered()).toHaveLength(0);

    // The ending is the one the automation declared, and it names the step.
    const giveUp = (
      await createAuditRepository(handle.db).query({ contactId: CONTACT })
    ).find((entry) => entry.kind === "action_executed");
    expect(giveUp?.stepId).toBe("confirm");
    expect(giveUp?.outcome).toBe("suppressed");
    expect(giveUp?.reason).toContain("abandon");
    expect(giveUp?.reason).toContain(String(QUESTIONS));

    // And a later message finds no wait at all, so it cannot cost a card.
    now = new Date(T0.getTime() + 10 * HOUR);
    await createDispatcher(deps)(
      messagePayload("hello?", "mid-late"),
      "event-late",
    );
    expect(await cards()).toHaveLength(QUESTIONS);
  });

  it("REQ-254: two questions means two cards, and the second mistake ends it", async () => {
    questions = 2;
    // Re-asked under a ceiling of two, from a wait written when it was three:
    // the wait carries the number it was born with, so this run is driven from
    // its own beginning rather than from the setting changed mid-answer.
    handle.close();
    handle = openDatabase({ databasePath: IN_MEMORY_DATABASE });
    now = T0;
    deps = depsOver(handle);
    const stored = await createAutomationAggregateRepository(handle.db, {
      now: () => now,
    }).save(anchorFlow());
    if (!stored.ok) throw new Error("fixture automation should be stored");
    await createDispatcher(deps)(commentPayload(), "event-1");

    await answerWrongly(2);

    expect(await cards()).toHaveLength(2);
    expect(await waits()).toHaveLength(0);
    expect(await delivered()).toHaveLength(0);
  });

  it("takes the tap on a RESENT card, and delivers", async () => {
    // The point of sending it again. A resend the contact cannot act on would
    // be noise, so the button that comes back has to be the same answer the
    // wait is still holding out for.
    await answerWrongly(QUESTIONS - 1);
    // The first card and one per mistake: the last question of the ceiling is
    // on the contact's screen, and it is the one they are about to answer.
    expect(await cards()).toHaveLength(QUESTIONS);

    now = new Date(T0.getTime() + 5 * HOUR);
    await createDispatcher(deps)(
      messagePayload(BUTTON, "mid-yes"),
      "event-yes",
    );

    expect(await delivered()).toHaveLength(1);
    expect(await waits()).toHaveLength(0);
    // No card followed the confirmation: the wait ended, and a question after
    // the answer would be asking somebody who already said yes.
    expect(await cards()).toHaveLength(QUESTIONS);
  });

  it("keeps the deadline the wait was born with while the cards go out", async () => {
    const [before] = await waits();

    await answerWrongly(1);

    const [after] = await waits();
    expect(after?.id).toBe(before?.id);
    // Moving it would let a contact who keeps answering wrongly hold the
    // execution open past the deadline the instance allowed.
    expect(after?.dueAt).toStrictEqual(before?.dueAt);
    // The count that pays for the card just sent, on the durable record: a
    // ceiling kept in memory would start again at zero after every deploy.
    expect(after?.attempts).toBe(1);
  });
});
