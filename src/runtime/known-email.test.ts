import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runExecution } from "../engine/execute.js";
import type { ExecutionStart, FlowRegistry } from "../engine/execute.js";
import type { EnginePorts } from "../engine/ports.js";
import { bindActiveAutomation } from "../flows/binding.js";
import type { ActiveAutomation } from "../flows/schema.js";
import {
  createAuditRepository,
  createContactRepository,
  createConversationStore,
  createDurableWorkStore,
  createMemoryAssets,
  IN_MEMORY_DATABASE,
  openDatabase,
} from "../storage/index.js";
import type { DatabaseHandle } from "../storage/index.js";
import { EMAIL_ATTRIBUTE } from "./answers.js";
import { recordExecution } from "./execution-audit.js";
import { createQueueingSender } from "./outbox.js";
import { createDurableSuspender, routeInbound } from "./suspension.js";
import type { ResumeDeps } from "./suspension.js";

/**
 * Proves REQ-024: a contact whose address is already known is not asked for it
 * again. The run goes straight to the next step, and the suppression is
 * written down.
 *
 * This is REQ-068 applied to another piece of knowledge, and the reason it is
 * worth its own suite is the SECOND automation. The address lives on the
 * contact, not on the run (REQ-028), so the question that was answered once is
 * answered for every automation that follows. Without that, a contact who
 * subscribed on Monday is asked again on Tuesday by a different flow, which is
 * precisely the nuisance that makes an operator switch collection off.
 */

const T0 = new Date("2026-08-01T10:00:00.000Z");
const HOUR = 60 * 60 * 1000;
const CONTACT = "contact-1";
const ASK = "What is your e-mail?";
const ADDRESS = "bob@example.com";
const RESOURCE_URL = "https://cdn.example/guide.pdf";

/** Asks for the address, then delivers. The same shape both flows use. */
function collectingFlow(id: string): ActiveAutomation {
  return {
    schema_version: 2,
    kind: "automation",
    id,
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

describe("REQ-024: an address already known is not asked for again", () => {
  let handle: DatabaseHandle;
  let now: Date;
  const clock = { now: () => now };

  function wire(
    flow: ActiveAutomation,
    executionId: string,
  ): { ports: EnginePorts; registry: FlowRegistry } {
    const bound = bindActiveAutomation(flow);
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

  function startFor(flowId: string): ExecutionStart {
    return {
      flowId,
      contactId: CONTACT,
      origin: "comment",
      commentId: "comment-1",
    };
  }

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

  /** Waits still on the table. A question that was never asked leaves none. */
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

  it("asks nothing and runs the step after it, for a contact already known", async () => {
    await createContactRepository(handle.db, () => now).setAttribute(
      CONTACT,
      EMAIL_ATTRIBUTE,
      ADDRESS,
    );

    const { ports, registry } = wire(collectingFlow("lead-flow"), "exec-1");
    const result = await runExecution(startFor("lead-flow"), registry, ports);

    // Straight through: the step that would have asked, and the one after it.
    expect(result.outcome).toBe("finished");
    expect(result.steps.map((step) => step.stepId)).toEqual([
      "ask-email",
      "deliver",
    ]);
    expect(result.steps[0]?.outcome).toBe("suppressed");

    // Not one message carrying the question, and no wait to answer: a run that
    // suspended here would strand the contact until the deadline, waiting for
    // an answer nobody asked them for.
    const queued = await sent();
    expect(queued).not.toContain(ASK);
    expect(queued).toContain(RESOURCE_URL);
    expect(await pendingWaits()).toBe(0);
  });

  it("writes the suppression down, with the contact and the reason", async () => {
    await createContactRepository(handle.db, () => now).setAttribute(
      CONTACT,
      EMAIL_ATTRIBUTE,
      ADDRESS,
    );
    const audit = createAuditRepository(handle.db);

    const { ports, registry } = wire(collectingFlow("lead-flow"), "exec-1");
    const result = await runExecution(startFor("lead-flow"), registry, ports);
    await recordExecution(audit, result, { clock });

    // An operator asking why this contact was never asked for their address
    // finds the answer, rather than a step that simply is not there. Suppressed
    // and not failed: nothing broke.
    const entries = await audit.query({ contactId: CONTACT });
    const suppression = entries.find((entry) => entry.stepId === "ask-email");

    expect(suppression).toMatchObject({
      outcome: "suppressed",
      contactId: CONTACT,
      flowId: "lead-flow",
      stepId: "ask-email",
    });
    // A code, and the trail keeps it as one: whoever shows this row picks the
    // words from the catalogue (REQ-163).
    expect(suppression?.reason).toBe("email_already_known");
    expect(await audit.query({ outcome: "failed" })).toStrictEqual([]);
  });

  it("still asks a contact whose address is not known", async () => {
    const { ports, registry } = wire(collectingFlow("lead-flow"), "exec-1");
    const result = await runExecution(startFor("lead-flow"), registry, ports);

    // No regression on REQ-022: with nothing stored, the step asks and the run
    // stops at it.
    expect(result.outcome).toBe("suspended");
    expect(result.steps.map((step) => step.stepId)).toEqual(["ask-email"]);
    expect(result.steps[0]?.outcome).toBe("suspended");
    expect(await sent()).toContain(ASK);
    expect(await sent()).not.toContain(RESOURCE_URL);
    expect(await pendingWaits()).toBe(1);
  });

  it("still asks when the attribute is there but carries no address", async () => {
    // A contact can hold the key with nothing in it: an earlier step may have
    // written it empty or cleared it. Reading the KEY rather than a value would
    // suppress the question for someone whose address nobody has.
    const contacts = createContactRepository(handle.db, () => now);
    await contacts.setAttribute(CONTACT, EMAIL_ATTRIBUTE, null);

    const { ports, registry } = wire(collectingFlow("lead-flow"), "exec-1");
    expect(
      (await runExecution(startFor("lead-flow"), registry, ports)).outcome,
    ).toBe("suspended");

    await contacts.setAttribute(CONTACT, EMAIL_ATTRIBUTE, "");
    const second = wire(collectingFlow("lead-flow"), "exec-2");
    expect(
      (await runExecution(startFor("lead-flow"), second.registry, second.ports))
        .outcome,
    ).toBe("suspended");
  });

  it("does not ask again in a LATER automation, once the contact has answered", async () => {
    // The address arrives the way it really arrives: the contact answers the
    // question of the first automation.
    const first = wire(collectingFlow("lead-flow"), "exec-1");
    await runExecution(startFor("lead-flow"), first.registry, first.ports);

    now = new Date(T0.getTime() + HOUR);
    const routed = await routeInbound(routingDeps(), {
      contactId: CONTACT,
      text: ADDRESS,
    });
    expect(routed.kind).toBe("resume");

    // A different flow, a different automation, the same person. This is the
    // case REQ-024 exists for: the knowledge belongs to the contact (REQ-028),
    // so the second automation asks nothing.
    now = new Date(T0.getTime() + 2 * HOUR);
    const later = wire(collectingFlow("second-flow"), "exec-2");
    const result = await runExecution(
      startFor("second-flow"),
      later.registry,
      later.ports,
    );

    expect(result.outcome).toBe("finished");
    expect(result.steps[0]).toMatchObject({
      stepId: "ask-email",
      outcome: "suppressed",
    });
    expect(result.steps.map((step) => step.stepId)).toEqual([
      "ask-email",
      "deliver",
    ]);
  });
});
