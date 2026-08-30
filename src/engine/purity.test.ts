import { describe, expect, it } from "vitest";

import { decideNextStep } from "./decide.js";
import type { FlowDefinition } from "./flow.js";
import type {
  AssetStorage,
  AttributeValue,
  Clock,
  ContactAttributes,
  ContactRepo,
  EnginePorts,
  Sender,
} from "./ports.js";

/**
 * Proves REQ-044 and acceptance criterion 22: the state machine is exercised
 * with doubles written right here, plain objects in memory. No network is
 * opened and no concrete storage is instantiated, because every dependency
 * arrives through an interface.
 */

// --- port doubles -----------------------------------------------------------

/** A clock the test moves by hand, so a decision never depends on wall time. */
function fixedClock(instant: string): Clock & { set(next: string): void } {
  let current = instant;
  return {
    now: () => new Date(current),
    set: (next: string) => {
      current = next;
    },
  };
}

interface ContactRepoDouble extends ContactRepo {
  readonly writes: readonly string[];
}

function inMemoryContactRepo(
  seed: Record<string, Record<string, AttributeValue>> = {},
): ContactRepoDouble {
  const store = new Map<string, Map<string, AttributeValue>>(
    Object.entries(seed).map(([contactId, attributes]) => [
      contactId,
      new Map(Object.entries(attributes)),
    ]),
  );
  const writes: string[] = [];

  return {
    writes,
    getAttributes(contactId) {
      const attributes = store.get(contactId) ?? new Map();
      return Promise.resolve(Object.fromEntries(attributes));
    },
    setAttribute(contactId, key, value) {
      const attributes = store.get(contactId) ?? new Map();
      attributes.set(key, value);
      store.set(contactId, attributes);
      writes.push(`${contactId}.${key}`);
      return Promise.resolve();
    },
  };
}

interface SenderDouble extends Sender {
  readonly calls: readonly string[];
}

function recordingSender(): SenderDouble {
  const calls: string[] = [];
  return {
    calls,
    sendDirectMessage(contactId, message) {
      calls.push(`dm:${contactId}:${message.text}`);
      return Promise.resolve();
    },
    replyToComment(commentId, message) {
      calls.push(`reply:${commentId}:${message.text}`);
      return Promise.resolve();
    },
  };
}

interface AssetStorageDouble extends AssetStorage {
  readonly calls: readonly string[];
}

function inMemoryAssetStorage(): AssetStorageDouble {
  const calls: string[] = [];
  return {
    calls,
    publicUrl(name) {
      calls.push(name);
      return Promise.resolve(`memory://assets/${name}`);
    },
  };
}

function testPorts(
  contacts: ContactRepo = inMemoryContactRepo(),
): EnginePorts & {
  clock: ReturnType<typeof fixedClock>;
  sender: SenderDouble;
  assets: AssetStorageDouble;
} {
  return {
    clock: fixedClock("2026-03-01T10:00:00.000Z"),
    contacts,
    sender: recordingSender(),
    assets: inMemoryAssetStorage(),
    // No step here waits, so the numbers are inert: what they must not be is
    // absent, because the engine takes its deadline from the instance now
    // (REQ-252, REQ-254) and a composition that forgot it should not compile.
    waiting: { hours: 24, questions: 3, followButtonLabel: "I followed" },
    // Scripted, for the same reason the clock is: no step here declares several
    // wordings, so nothing draws, and a real generator would put an unasked
    // source of variation inside a suite about determinism.
    random: { next: (): number => 0 },
    // No flow here suspends, so the double refuses rather than pretends: a
    // silent no-op would let a suspension slip past unnoticed.
    suspender: {
      suspend: () => Promise.reject(new Error("no suspension expected here")),
      isConversationOpen: () => Promise.resolve(false),
    },
  };
}

// --- fixtures ---------------------------------------------------------------

const welcome: FlowDefinition = {
  id: "welcome",
  steps: [
    {
      id: "greet",
      type: "send_message",
      transition: { kind: "goto", stepId: "ask-email" },
    },
    {
      id: "ask-email",
      type: "collect_email",
      transition: {
        kind: "branch",
        attribute: "email",
        equals: null,
        ifTrue: "remind",
        ifFalse: "thanks",
      },
    },
    { id: "remind", type: "send_message", transition: { kind: "end" } },
    { id: "thanks", type: "send_message", transition: { kind: "end" } },
  ],
};

const noAttributes: ContactAttributes = {};

describe("REQ-044: the state machine decides with injected ports only", () => {
  it("decides the first step of a flow that has not started", () => {
    const ports = testPorts();

    const decision = decideNextStep(
      {
        flow: welcome,
        execution: {
          flowId: "welcome",
          contactId: "c-1",
          currentStepId: null,
        },
        attributes: noAttributes,
      },
      ports.clock,
    );

    expect(decision).toMatchObject({ kind: "run-step", step: { id: "greet" } });
  });

  it("decides the step the current transition points at", () => {
    const ports = testPorts();

    const decision = decideNextStep(
      {
        flow: welcome,
        execution: {
          flowId: "welcome",
          contactId: "c-1",
          currentStepId: "greet",
        },
        attributes: noAttributes,
      },
      ports.clock,
    );

    expect(decision).toMatchObject({
      kind: "run-step",
      step: { id: "ask-email", type: "collect_email" },
    });
  });

  it("decides that the execution finished when the current step ends the flow", () => {
    const ports = testPorts();

    const decision = decideNextStep(
      {
        flow: welcome,
        execution: {
          flowId: "welcome",
          contactId: "c-1",
          currentStepId: "thanks",
        },
        attributes: noAttributes,
      },
      ports.clock,
    );

    expect(decision).toMatchObject({ kind: "finished" });
  });

  it("decides that an empty flow finished right away", () => {
    const ports = testPorts();

    const decision = decideNextStep(
      {
        flow: { id: "empty", steps: [] },
        execution: { flowId: "empty", contactId: "c-1", currentStepId: null },
        attributes: noAttributes,
      },
      ports.clock,
    );

    expect(decision).toMatchObject({ kind: "finished" });
  });

  it("branches on contact attributes read through the ContactRepo double", async () => {
    const contacts = inMemoryContactRepo({
      "c-known": { email: "someone@example.com" },
      "c-unknown": { email: null },
    });
    const ports = testPorts(contacts);

    const decide = async (contactId: string) =>
      decideNextStep(
        {
          flow: welcome,
          execution: {
            flowId: "welcome",
            contactId,
            currentStepId: "ask-email",
          },
          attributes: await ports.contacts.getAttributes(contactId),
        },
        ports.clock,
      );

    expect(await decide("c-known")).toMatchObject({
      kind: "run-step",
      step: { id: "thanks" },
    });
    expect(await decide("c-unknown")).toMatchObject({
      kind: "run-step",
      step: { id: "remind" },
    });
  });

  it("reports a broken flow instead of guessing", () => {
    const ports = testPorts();
    const dangling: FlowDefinition = {
      id: "dangling",
      steps: [
        {
          id: "only",
          type: "send_message",
          transition: { kind: "goto", stepId: "ghost" },
        },
      ],
    };

    const unknownCurrent = decideNextStep(
      {
        flow: welcome,
        execution: {
          flowId: "welcome",
          contactId: "c-1",
          currentStepId: "gone",
        },
        attributes: noAttributes,
      },
      ports.clock,
    );
    const missingTarget = decideNextStep(
      {
        flow: dangling,
        execution: {
          flowId: "dangling",
          contactId: "c-1",
          currentStepId: "only",
        },
        attributes: noAttributes,
      },
      ports.clock,
    );

    // A code, and the identifier beside it (REQ-171): a decision phrased in
    // words reaches the trail as a sentence no catalogue can translate, and the
    // operator then reads a failed run with no cause at all.
    expect(unknownCurrent).toMatchObject({
      kind: "failed",
      reason: "current_step_not_declared",
      detail: "gone",
    });
    expect(missingTarget).toMatchObject({
      kind: "failed",
      reason: "transition_target_not_declared",
      detail: "ghost",
    });
  });
});

describe("AC 22: deciding is deterministic and free of effects", () => {
  it("takes its timestamp from the injected clock, never from wall time", () => {
    const ports = testPorts();
    const input = {
      flow: welcome,
      execution: {
        flowId: "welcome",
        contactId: "c-1",
        currentStepId: null,
      },
      attributes: noAttributes,
    };

    const first = decideNextStep(input, ports.clock);
    const again = decideNextStep(input, ports.clock);
    ports.clock.set("2026-03-02T08:30:00.000Z");
    const later = decideNextStep(input, ports.clock);

    expect(first).toStrictEqual(again);
    expect(first.decidedAt.toISOString()).toBe("2026-03-01T10:00:00.000Z");
    expect(later.decidedAt.toISOString()).toBe("2026-03-02T08:30:00.000Z");
  });

  it("touches neither the sender nor the asset storage while deciding", () => {
    const contacts = inMemoryContactRepo({ "c-1": { email: null } });
    const ports = testPorts(contacts);

    for (const currentStepId of [null, "greet", "ask-email", "thanks"]) {
      decideNextStep(
        {
          flow: welcome,
          execution: { flowId: "welcome", contactId: "c-1", currentStepId },
          attributes: noAttributes,
        },
        ports.clock,
      );
    }

    expect(ports.sender.calls).toStrictEqual([]);
    expect(ports.assets.calls).toStrictEqual([]);
    expect(contacts.writes).toStrictEqual([]);
  });

  it("refuses an execution that belongs to another flow", () => {
    const ports = testPorts();

    const decision = decideNextStep(
      {
        flow: welcome,
        execution: { flowId: "other", contactId: "c-1", currentStepId: null },
        attributes: noAttributes,
      },
      ports.clock,
    );

    expect(decision).toMatchObject({ kind: "failed" });
  });
});

describe("the port doubles honour their contracts in memory", () => {
  it("round-trips a contact attribute with no store behind it", async () => {
    const contacts = inMemoryContactRepo();

    await contacts.setAttribute("c-1", "email", "someone@example.com");

    expect(await contacts.getAttributes("c-1")).toStrictEqual({
      email: "someone@example.com",
    });
    expect(await contacts.getAttributes("c-2")).toStrictEqual({});
    expect(contacts.writes).toStrictEqual(["c-1.email"]);
  });

  it("resolves an asset URL and records sent messages without any transport", async () => {
    const ports = testPorts();

    await ports.sender.sendDirectMessage("c-1", { text: "hello" });
    await ports.sender.replyToComment("cm-1", {
      text: "check your inbox",
      quickReplies: ["ok"],
    });

    expect(await ports.assets.publicUrl("welcome.png")).toBe(
      "memory://assets/welcome.png",
    );
    expect(ports.sender.calls).toStrictEqual([
      "dm:c-1:hello",
      "reply:cm-1:check your inbox",
    ]);
  });
});
