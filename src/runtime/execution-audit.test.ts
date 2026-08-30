import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runExecution } from "../engine/execute.js";
import type { ExecutionResult, FlowRegistry } from "../engine/execute.js";
import type { FlowDefinition } from "../engine/flow.js";
import type { Clock, ContactAttributes, EnginePorts } from "../engine/ports.js";
import {
  createAuditRepository,
  openDatabase,
  UNKNOWN_SUBTYPE,
} from "../storage/index.js";
import { IN_MEMORY_DATABASE } from "../storage/index.js";
import type { AuditRepository, DatabaseHandle } from "../storage/index.js";
import { decodeExecutionFailure, recordExecution } from "./execution-audit.js";

/**
 * Proves REQ-093: an execution's result reaches the audit trail with instant,
 * contact, flow, step and desfecho, a step that did not end in plain success
 * carries its reason, and the whole thing is queryable by contact and by flow.
 *
 * The results come from the REAL engine rather than from hand-built objects.
 * A double producing the shape this module hopes for would keep passing on the
 * day the engine stops producing it, and the mapping is the entire point here.
 */

const RUN_LEVEL_INSTANT = new Date("2026-08-01T12:00:00.000Z");

/** Ticks a second per reading, so every step gets an instant of its own. */
function tickingClock(): Clock {
  let tick = 0;
  return {
    now: (): Date => {
      tick += 1;
      return new Date(Date.UTC(2026, 7, 1, 10, 0, tick));
    },
  };
}

function ports(options: { readonly conversationOpen?: boolean } = {}) {
  return {
    clock: tickingClock(),
    contacts: {
      getAttributes: (): Promise<ContactAttributes> => Promise.resolve({}),
      setAttribute: (): Promise<void> => Promise.resolve(),
    },
    sender: {
      sendDirectMessage: (): Promise<void> => Promise.resolve(),
      replyToComment: (): Promise<void> => Promise.resolve(),
    },
    assets: {
      publicUrl: (name: string): Promise<string> =>
        Promise.resolve(`https://assets.test/${name}`),
    },
    random: { next: (): number => 0 },
    // The instance's, since a step declares neither (REQ-252, REQ-254). No case
    // here asserts a deadline: what matters is that it is present.
    waiting: { hours: 24, questions: 3, followButtonLabel: "I followed" },
    suspender: {
      suspend: (): Promise<void> => Promise.resolve(),
      isConversationOpen: (): Promise<boolean> =>
        Promise.resolve(options.conversationOpen ?? false),
    },
  } satisfies EnginePorts;
}

function registryOf(...flows: FlowDefinition[]): FlowRegistry {
  return {
    current: (flowId): FlowDefinition | undefined =>
      flows.find((flow) => flow.id === flowId),
  };
}

const TWO_SENDS: FlowDefinition = {
  id: "welcome",
  steps: [
    {
      id: "greet",
      type: "send_message",
      config: { text: "hello" },
      transition: { kind: "goto", stepId: "deliver" },
    },
    {
      id: "deliver",
      type: "send_message",
      config: { text: "here is the link" },
      transition: { kind: "end" },
    },
  ],
};

/**
 * Two sends with a declared pause between them (REQ-098), which is the flow an
 * operator writes when a message must not land in the same second as the last
 * one. The engine suspends AT the pause, so the run records the send and the
 * pause, and nothing after it.
 */
const PAUSED: FlowDefinition = {
  id: "paced",
  steps: [
    {
      id: "greet",
      type: "send_message",
      config: { text: "hello" },
      transition: { kind: "goto", stepId: "breathe" },
    },
    {
      id: "breathe",
      type: "delay",
      config: { seconds: 30 },
      transition: { kind: "goto", stepId: "deliver" },
    },
    {
      id: "deliver",
      type: "send_message",
      config: { text: "here is the link" },
      transition: { kind: "end" },
    },
  ],
};

/** An unsupported type is what the engine turns into a failed step. */
const BREAKS: FlowDefinition = {
  id: "broken",
  steps: [
    {
      id: "explode",
      type: "no_such_step_type",
      transition: { kind: "end" },
    },
  ],
};

function confirmation(quickReplyLabel?: string): FlowDefinition {
  return {
    id: "optin",
    steps: [
      {
        id: "ask",
        type: "confirm_optin",
        config: {
          text: "may I send it?",
          on_timeout: "end",
          ...(quickReplyLabel !== undefined && {
            quick_reply_label: quickReplyLabel,
          }),
        },
        transition: { kind: "end" },
      },
    ],
  };
}

/** A gate with nobody to ask, which suspends and says why (REQ-027). */
const UNVERIFIED_GATE: FlowDefinition = {
  id: "gate",
  steps: [
    {
      id: "ask",
      type: "follow_gate",
      config: { text: "follow us", on_timeout: "end" },
      transition: { kind: "end" },
    },
  ],
};

function run(
  flows: readonly FlowDefinition[],
  start: { readonly flowId: string; readonly contactId: string },
  options: { readonly conversationOpen?: boolean } = {},
): Promise<ExecutionResult> {
  return runExecution(
    { ...start, origin: "direct_message" },
    registryOf(...flows),
    ports(options),
  );
}

describe("REQ-093: an execution result reaches the audit trail", () => {
  let handle: DatabaseHandle;
  let audit: AuditRepository;

  beforeEach(() => {
    handle = openDatabase({ databasePath: IN_MEMORY_DATABASE });
    audit = createAuditRepository(handle.db);
  });

  afterEach(() => {
    handle.close();
  });

  const context = { clock: { now: (): Date => RUN_LEVEL_INSTANT } };

  it("writes one entry per executed step, with contact, flow, step and outcome", async () => {
    const result = await run([TWO_SENDS], {
      flowId: "welcome",
      contactId: "alice",
    });

    const written = await recordExecution(audit, result, context);

    expect(written).toHaveLength(2);
    expect(written.map((entry) => entry.stepId)).toEqual(["greet", "deliver"]);
    for (const entry of written) {
      expect(entry).toMatchObject({
        kind: "action_executed",
        outcome: "ok",
        contactId: "alice",
        flowId: "welcome",
      });
      expect(entry.occurredAt).toBeInstanceOf(Date);
    }
  });

  it("copies the immutable analytics attribution to every action in a run", async () => {
    const result = await run([TWO_SENDS], {
      flowId: "welcome",
      contactId: "alice",
    });

    const written = await recordExecution(audit, result, {
      ...context,
      automationId: "welcome",
      executionId: "welcome:alice:run",
      automationScope: "publication",
      publicationId: "post-1",
      matchedKeyword: "guide",
    });

    expect(written).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          executionId: "welcome:alice:run",
          automationScope: "publication",
          publicationId: "post-1",
          matchedKeyword: "guide",
        }),
      ]),
    );
    expect(written.every((entry) => entry.publicationId === "post-1")).toBe(
      true,
    );
    expect(written.every((entry) => entry.matchedKeyword === "guide")).toBe(
      true,
    );
  });

  it("stamps each step with its own instant instead of one now for the run", async () => {
    const result = await run([TWO_SENDS], {
      flowId: "welcome",
      contactId: "alice",
    });

    const written = await recordExecution(audit, result, context);

    // The engine's own finishing instants, not this module's idea of "now":
    // collapsing them would make the trail unable to say how long a step took.
    expect(written.map((entry) => entry.occurredAt.toISOString())).toEqual(
      result.steps.map((step) => step.finishedAt.toISOString()),
    );
    expect(written[0]?.occurredAt).not.toEqual(written[1]?.occurredAt);
  });

  it("reads back oldest first in the order the steps ran", async () => {
    const result = await run([TWO_SENDS], {
      flowId: "welcome",
      contactId: "alice",
    });
    await recordExecution(audit, result, context);

    const trail = await audit.query({ contactId: "alice", order: "oldest" });

    expect(trail.map((entry) => entry.stepId)).toEqual(["greet", "deliver"]);
  });

  it("records a failed step as failed, carrying the engine's reason", async () => {
    const result = await run([BREAKS], {
      flowId: "broken",
      contactId: "alice",
    });

    const written = await recordExecution(audit, result, context);

    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({
      outcome: "failed",
      stepId: "explode",
      flowId: "broken",
    });
    // A CODE, read back by the module that wrote it, and the kind the
    // definition asked for beside it (REQ-171). The step's own words are not in
    // the column any more, because there are none: the engine names this
    // condition itself.
    expect(decodeExecutionFailure(written[0]?.reason)).toEqual({
      reason: "step_type_unsupported",
      detail: "no_such_step_type",
    });
  });

  it("does not add a run-level entry when a step already carries the failure", async () => {
    const result = await run([BREAKS], {
      flowId: "broken",
      contactId: "alice",
    });

    await recordExecution(audit, result, context);

    // The run failed BECAUSE the step failed. A second row would count the same
    // failure twice in whatever the operator's panel adds up.
    expect(await audit.query({ outcome: "failed" })).toHaveLength(1);
  });

  it("records a suppressed step as suppressed, with its reason, not as a failure", async () => {
    const result = await run(
      [confirmation("yes")],
      { flowId: "optin", contactId: "alice" },
      { conversationOpen: true },
    );

    const written = await recordExecution(audit, result, context);

    // REQ-068: deliberately not performed. An operator asking why this contact
    // got no question must be able to tell this apart from a breakage.
    expect(written[0]).toMatchObject({ outcome: "suppressed", stepId: "ask" });
    // The reason travels as a code and is stored as one (REQ-163): the trail
    // holds no sentence to translate, and the screen translates the code.
    expect(written[0]?.reason).toBe("conversation_already_open");
  });

  it("records a suspended step as ok: the step did what it was told", async () => {
    const result = await run([confirmation("yes")], {
      flowId: "optin",
      contactId: "alice",
    });

    const written = await recordExecution(audit, result, context);

    expect(result.outcome).toBe("suspended");
    // Waiting for a human is not a failure, and counting it as one would put
    // every well-behaved confirmation in the operator's failure count.
    expect(written[0]).toMatchObject({ outcome: "ok", stepId: "ask" });
    expect(written[0]?.reason).toBeUndefined();
  });

  it("keeps the reason of a suspension the engine had something to say about", async () => {
    // REQ-027: the request went out and the run is waiting, but the platform
    // could not be asked whether this contact follows. Dropping that because the
    // outcome maps to `ok` would lose the only trace of why a gate keeps asking
    // somebody who does follow.
    const result = await run([UNVERIFIED_GATE], {
      flowId: "gate",
      contactId: "alice",
    });

    const written = await recordExecution(audit, result, context);

    expect(written[0]?.outcome).toBe("ok");
    expect(written[0]?.reason).toContain("not_configured");
  });

  it("records a run that failed with no step to blame", async () => {
    // REQ-012: a definition not in force runs nothing at all, so there is no
    // step row, and without this entry the failure leaves no trace whatsoever.
    const result = await run([], { flowId: "missing", contactId: "alice" });

    const written = await recordExecution(audit, result, context);

    expect(result.steps).toHaveLength(0);
    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({
      kind: "action_executed",
      outcome: "failed",
      contactId: "alice",
      flowId: "missing",
    });
    expect(written[0]?.stepId).toBeUndefined();
    // The line REQ-171 was written about. It used to store the sentence the
    // engine had phrased, and the panel could translate no sentence, so the
    // operator read a failed execution and no cause at all.
    expect(decodeExecutionFailure(written[0]?.reason)).toEqual({
      reason: "flow_not_runnable",
      detail: "missing",
    });
    expect(written[0]?.occurredAt.toISOString()).toBe(
      RUN_LEVEL_INSTANT.toISOString(),
    );
  });

  it("adds no run-level entry to a run that finished or suspended", async () => {
    const finished = await run([TWO_SENDS], {
      flowId: "welcome",
      contactId: "alice",
    });
    const suspended = await run([confirmation("yes")], {
      flowId: "optin",
      contactId: "bob",
    });

    const forAlice = await recordExecution(audit, finished, context);
    const forBob = await recordExecution(audit, suspended, context);

    // One row per step and not one more: a stepless summary row would double
    // every action an operator counts.
    expect(forAlice).toHaveLength(finished.steps.length);
    expect(forBob).toHaveLength(suspended.steps.length);
    expect(await audit.query({ outcome: "failed" })).toHaveLength(0);
  });

  it("carries the automation and the event that started the run", async () => {
    const result = await run([TWO_SENDS], {
      flowId: "welcome",
      contactId: "alice",
    });

    const written = await recordExecution(audit, result, {
      ...context,
      automationId: "automation-1",
      eventId: "event-1",
    });

    expect(
      written.every((entry) => entry.automationId === "automation-1"),
    ).toBe(true);
    expect(await audit.query({ eventId: "event-1" })).toHaveLength(2);
  });
});

/**
 * Proves REQ-156: the pause says what it is on the row it writes.
 *
 * The row always existed, with its flow, its step and an `ok` outcome, and it
 * said nothing about what kind of action it was. Every count of this trail
 * groups a subtype-less entry as unknown (`subtypeGroupOf`, REQ-106), which is
 * the group kept for entries that genuinely cannot tell: a delivery whose
 * payload carried two origins at once, a row older than the column. A pause is
 * neither, so an operator running a paced flow watched an unnamed figure grow
 * beside the named types with nothing on the screen able to say what it was.
 *
 * The assertions are on the SUBTYPE written and on the group the trail then
 * puts the row in, never on any wording: the panel's sentence for it is the
 * catalogue's business.
 */
describe("REQ-156: a pause records its own subtype", () => {
  let handle: DatabaseHandle;
  let audit: AuditRepository;

  beforeEach(() => {
    handle = openDatabase({ databasePath: IN_MEMORY_DATABASE });
    audit = createAuditRepository(handle.db);
  });

  afterEach(() => {
    handle.close();
  });

  const context = { clock: { now: (): Date => RUN_LEVEL_INSTANT } };

  it("names the pause instead of leaving the entry with no type", async () => {
    const result = await run([PAUSED], { flowId: "paced", contactId: "alice" });

    const written = await recordExecution(audit, result, context);

    expect(result.outcome).toBe("suspended");
    // The pause is the step that suspended the run, and it is recorded as an
    // action that happened: it did exactly what the flow told it to do.
    expect(written.map((entry) => entry.stepId)).toEqual(["greet", "breathe"]);
    expect(written[1]).toMatchObject({
      kind: "action_executed",
      subtype: "pause_started",
      outcome: "ok",
      stepId: "breathe",
      flowId: "paced",
    });
  });

  it("keeps it out of the group the panel shows as unknown", async () => {
    await recordExecution(
      audit,
      await run([PAUSED], { flowId: "paced", contactId: "alice" }),
      context,
    );

    // Read back through the trail's own query, which is how the aggregation
    // reaches these rows: the unknown group is a NULL column, and the pause
    // must not be in it.
    expect(await audit.query({ subtype: UNKNOWN_SUBTYPE })).toEqual([]);
    expect(await audit.query({ subtype: "pause_started" })).toHaveLength(1);
    // And it is not counted as something else either: a pause sends nothing,
    // so folding it into the messages would report a message nobody received.
    expect(await audit.query({ subtype: "message_sent" })).toHaveLength(1);
  });

  it("still records no type for a step this engine refuses to run", async () => {
    // The other half of the rule, and the reason the map has no default: an
    // unsupported step reaches the trail as a failure carrying its own name,
    // and calling it a pause (or a message) would add an action nobody
    // performed to the operator's totals.
    await recordExecution(
      audit,
      await run([BREAKS], { flowId: "broken", contactId: "bob" }),
      context,
    );

    const written = await audit.query({ flowId: "broken" });

    expect(written).toHaveLength(1);
    expect(written[0]?.subtype).toBeUndefined();
  });
});

describe("REQ-093: the record is queryable by contact and by flow", () => {
  let handle: DatabaseHandle;
  let audit: AuditRepository;

  const context = { clock: { now: (): Date => RUN_LEVEL_INSTANT } };

  beforeEach(async () => {
    handle = openDatabase({ databasePath: IN_MEMORY_DATABASE });
    audit = createAuditRepository(handle.db);

    await recordExecution(
      audit,
      await run([TWO_SENDS], { flowId: "welcome", contactId: "alice" }),
      context,
    );
    await recordExecution(
      audit,
      await run([BREAKS], { flowId: "broken", contactId: "bob" }),
      context,
    );
  });

  afterEach(() => {
    handle.close();
  });

  it("answers what happened to one contact", async () => {
    const trail = await audit.query({
      contactId: "alice",
      kind: "action_executed",
    });

    expect(trail).toHaveLength(2);
    expect(trail.every((entry) => entry.flowId === "welcome")).toBe(true);
  });

  it("answers what happened in one flow, across contacts", async () => {
    expect(await audit.query({ flowId: "welcome" })).toHaveLength(2);
    expect(await audit.query({ flowId: "broken" })).toHaveLength(1);
  });

  it("narrows to the failures of one flow, which is the operator's question", async () => {
    const trail = await audit.query({ flowId: "broken", outcome: "failed" });

    expect(trail).toHaveLength(1);
    expect(trail[0]?.stepId).toBe("explode");
  });
});

describe("REQ-171: the reason column tells a failure from everything else in it", () => {
  let handle: DatabaseHandle;
  let audit: AuditRepository;

  beforeEach(() => {
    handle = openDatabase({ databasePath: IN_MEMORY_DATABASE });
    audit = createAuditRepository(handle.db);
  });

  afterEach(() => {
    handle.close();
  });

  const context = { clock: { now: (): Date => RUN_LEVEL_INSTANT } };

  /**
   * Four different things are stored in one column, and a reader has to tell
   * them apart with certainty rather than by a prefix or by the outcome beside
   * them. These are the other three, each of which must NOT decode as a
   * failure, or a suppression would arrive on the panel worded as a breakage.
   */
  it("reads back nothing from a value that is not one of its records", () => {
    expect(decodeExecutionFailure(undefined)).toBeUndefined();
    // A bare suppression code, which is how that vocabulary is stored.
    expect(decodeExecutionFailure("conversation_already_open")).toBeUndefined();
    // A sentence, which is what rows written before this requirement hold.
    expect(
      decodeExecutionFailure('flow "x" has no runnable definition in force'),
    ).toBeUndefined();
    // A record of the right shape carrying a code this build does not know.
    // Refused whole, rather than crossing as a code no catalogue answers.
    expect(
      decodeExecutionFailure(
        JSON.stringify({
          code: "execution_failure",
          reason: "reason_from_another_build",
        }),
      ),
    ).toBeUndefined();
    // Another module's envelope, which shares the column and not the meaning.
    expect(
      decodeExecutionFailure(
        JSON.stringify({ code: "no_automation_matched", refusals: [] }),
      ),
    ).toBeUndefined();
  });

  it("codes a failed step whose stored reason came from outside the engine", async () => {
    // Not reachable through `runExecution`, and that is the point: this is the
    // fallback for a result some other caller built, or a build whose engine
    // has moved on. Losing the words would leave the record with no account of
    // the failure at all, so they are kept where they can be read as somebody
    // else's: in the detail, under the generic code.
    const written = await recordExecution(
      audit,
      {
        flowId: "welcome",
        contactId: "alice",
        outcome: "failed",
        steps: [
          {
            stepId: "greet",
            type: "send_message",
            startedAt: RUN_LEVEL_INSTANT,
            finishedAt: RUN_LEVEL_INSTANT,
            outcome: "failed",
            reason: "something nobody enumerated",
          },
        ],
      },
      context,
    );

    expect(decodeExecutionFailure(written[0]?.reason)).toEqual({
      reason: "unexpected_error",
      detail: "something nobody enumerated",
    });
  });

  it("leaves a suppression and a suspension exactly as the engine wrote them", async () => {
    const written = await recordExecution(
      audit,
      {
        flowId: "welcome",
        contactId: "alice",
        outcome: "suspended",
        steps: [
          {
            stepId: "ask",
            type: "confirm_optin",
            startedAt: RUN_LEVEL_INSTANT,
            finishedAt: RUN_LEVEL_INSTANT,
            outcome: "suppressed",
            reason: "conversation_already_open",
          },
          {
            stepId: "wait",
            type: "follow_gate",
            startedAt: RUN_LEVEL_INSTANT,
            finishedAt: RUN_LEVEL_INSTANT,
            outcome: "suspended",
            // A sentence the engine really writes: it quotes what the platform
            // said about a query that could not be made, which is why this one
            // is not a code (REQ-027).
            reason:
              "the follow relationship could not be verified (refused: 400)",
          },
        ],
      },
      context,
    );

    // The envelope is for failures and for nothing else. A suppression stays
    // the bare code `aggregate.ts` recognises by membership, and wrapping it
    // would break a chain that already works; a suspension is not a failure at
    // all, so its sentence stays where it was.
    expect(written[0]?.reason).toBe("conversation_already_open");
    expect(written[1]?.reason).toContain("could not be verified");
  });
});

/**
 * REQ-258, at the layer that would keep the step alive after the format stopped
 * declaring it.
 *
 * The trail had a subtype of its own for it (`attribute_set`), and a subtype is
 * a column an operator counts: leaving it behind would mean a panel offering a
 * total for an action nothing can perform, and a map from a step kind no
 * definition can carry. So the step's whole path out is asserted here: the
 * engine refuses it as a kind it does not know, the row carries no subtype at
 * all, and nothing reaches the contact repository on the way.
 *
 * What is NOT removed is the repository itself: the e-mail collected by
 * `collect_email` is written and read through the same two methods (REQ-024),
 * and this asserts that the WRITE this step used to make no longer happens, not
 * that the port is gone.
 */
describe("REQ-258: the attribute step is not a step this build performs", () => {
  let handle: DatabaseHandle;
  let audit: AuditRepository;

  beforeEach(() => {
    handle = openDatabase({ databasePath: IN_MEMORY_DATABASE });
    audit = createAuditRepository(handle.db);
  });

  afterEach(() => {
    handle.close();
  });

  const WRITES_ATTRIBUTE: FlowDefinition = {
    id: "tagging",
    steps: [
      {
        id: "mark",
        type: "set_attribute",
        config: { name: "source", value: "guide" },
        transition: { kind: "end" },
      },
    ],
  };

  it("refuses it as an unknown kind, and writes no attribute on the way", async () => {
    const written: string[] = [];
    const spying = {
      ...ports(),
      contacts: {
        getAttributes: (): Promise<ContactAttributes> => Promise.resolve({}),
        setAttribute: (_contactId: string, key: string): Promise<void> => {
          written.push(key);
          return Promise.resolve();
        },
      },
    } satisfies EnginePorts;

    const result = await runExecution(
      { flowId: "tagging", contactId: "alice", origin: "direct_message" },
      registryOf(WRITES_ATTRIBUTE),
      spying,
    );

    expect(result.outcome).toBe("failed");
    // The engine's own code for a kind it cannot perform, which is what the
    // step became the moment it left the vocabulary: not a silent skip, which
    // would be a promise the flow made and did not keep.
    expect(result.steps[0]?.reason).toBe("step_type_unsupported");
    expect(written).toEqual([]);
  });

  it("records the row with no subtype, which is the unknown group", async () => {
    await recordExecution(
      audit,
      await runExecution(
        { flowId: "tagging", contactId: "alice", origin: "direct_message" },
        registryOf(WRITES_ATTRIBUTE),
        ports(),
      ),
      { clock: { now: (): Date => RUN_LEVEL_INSTANT } },
    );

    const rows = await audit.query({ flowId: "tagging" });

    expect(rows).toHaveLength(1);
    // No subtype at all, and specifically not one borrowed from a neighbour: an
    // attribute step counted as a message would report a message nobody
    // received, which is the exact defect REQ-156 fixed for the pause.
    expect(rows[0]?.subtype).toBeUndefined();
    expect(await audit.query({ subtype: UNKNOWN_SUBTYPE })).toHaveLength(1);
    expect(await audit.query({ subtype: "message_sent" })).toEqual([]);
  });
});
