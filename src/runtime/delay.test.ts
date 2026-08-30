import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fixedInstanceSettings } from "../config/instance-settings.js";
import type { UnifiedAutomation } from "../flows/schema.js";
import { validateUnifiedAutomation } from "../flows/validation.js";
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
import { createDispatcher, createPauseResume } from "./dispatch.js";
import type { DispatchDeps } from "./dispatch.js";
import { createSuspensionTimeoutHandler } from "./suspension.js";
import type { SuspensionPayload } from "./suspension.js";
import { runSweep } from "./sweep.js";
import type { SweepReport } from "./sweep.js";

/**
 * Proves REQ-098, and with it REQ-019 and REQ-080 across a pause: the pause
 * runs.
 *
 * The step has been declared in the schema and listed as supported since Phase
 * 0, and the engine had no case for it, so an automation with a pause was
 * accepted on the way in and threw halfway through an execution.
 * `execute.test.ts` proves the engine's half (it suspends, and it continues at
 * the step after the pause); this file proves the half no double can show,
 * which is the one the requirement is really about: that a pause SURVIVES —
 * nobody has to be connected, nobody has to answer, and the process may die in
 * the middle of it.
 *
 * Everything here is durable rows and a sweep pass, with no network, no timer
 * and no waiting for real time: the clock is moved by hand, which is what makes
 * a thirty-second pause and a seven-day one cost the suite the same.
 *
 * Since phase 3l the file carries a SECOND wait, REQ-277's, and the pair is why
 * they share a file: the operator's wait holds the automation's first reply and
 * is a value on the aggregate, while the pause holds a run between two named
 * steps and is a step. Both are a persisted instant and neither is a sleep, so
 * the cases below are written to keep them from being read as one thing.
 */

const T0 = new Date("2026-08-01T10:00:00.000Z");
const SECOND = 1000;
/** The pause the fixture declares, in seconds. */
const PAUSE = 30;
/** The wait the automation declares before its FIRST reply (REQ-277). */
const FIRST_REPLY_WAIT = 10;
const ACCOUNT = "17841400000000000";
const CONTACT = "contact-1";
const EVENT = "event-1";

function validAutomation(input: unknown): UnifiedAutomation {
  const result = validateUnifiedAutomation(input);
  if (!result.ok) throw new Error("fixture automation should be valid");
  return result.value;
}

/**
 * The anchor case with a pause in it: the public reply, a wait for nobody, and
 * then the direct message. Exactly the shape acceptance criterion 16 describes,
 * now owned end to end by one self-contained aggregate (REQ-213).
 */
function pausedAutomation(): UnifiedAutomation {
  return validAutomation({
    schema_version: 2,
    kind: "automation",
    id: "paused-automation",
    state: "active",
    trigger: {
      type: "comment",
      target: "media-1",
      match: { keywords: ["guide"], mode: "contains" },
    },
    // Immediate: every instant this fixture's cases assert is the instant they
    // set, and the automation's own wait (REQ-277) has its own fixture below.
    rules: { once_per_contact: true, first_reply_delay_seconds: 0 },
    steps: [
      { id: "reply", action: "reply_comment", text: "check your DMs" },
      { id: "pause", action: "delay", seconds: PAUSE },
      {
        id: "deliver",
        action: "send_dm",
        message: { text: "here it is" },
      },
    ],
  });
}

/**
 * The SAME flow with the operator's wait on the automation (REQ-277).
 *
 * Two waits of different kinds in one run, which is exactly what makes it
 * worth running: the rule holds the first reply, the step pauses between two
 * named steps (REQ-098), and neither may be mistaken for the other.
 */
function waitingAndPausingAutomation(): UnifiedAutomation {
  return validAutomation({
    schema_version: 2,
    kind: "automation",
    id: "waiting-automation",
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
      { id: "reply", action: "reply_comment", text: "check your DMs" },
      { id: "pause", action: "delay", seconds: PAUSE },
      {
        id: "deliver",
        action: "send_dm",
        message: { text: "here it is" },
      },
    ],
  });
}

/**
 * A second automation, so a run started by the wrong path is visible by its
 * text. It fires on a direct message: what a contact writing DURING a pause
 * would hit.
 */
function menuAutomation(): UnifiedAutomation {
  return validAutomation({
    schema_version: 2,
    kind: "automation",
    id: "menu-automation",
    state: "active",
    trigger: {
      type: "direct_message",
      match: { keywords: ["menu"], mode: "contains" },
    },
    // Immediate: this automation exists to be visible by its text, never by
    // when it arrives (REQ-277).
    rules: { once_per_contact: true, first_reply_delay_seconds: 0 },
    steps: [
      {
        id: "menu",
        action: "send_dm",
        message: { text: "the menu ran" },
      },
    ],
  });
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
              from: { id: CONTACT, username: "someone" },
              media: { id: "media-1" },
            },
          },
        ],
      },
    ],
  };
}

function messagePayload(text: string, at: Date): unknown {
  return {
    object: "instagram",
    entry: [
      {
        id: ACCOUNT,
        time: Math.floor(at.getTime() / 1000),
        messaging: [
          {
            sender: { id: CONTACT },
            recipient: { id: ACCOUNT },
            timestamp: at.getTime(),
            message: { mid: "mid-1", text },
          },
        ],
      },
    ],
  };
}

describe("REQ-098: the pause suspends the run, and time alone resumes it", () => {
  let handle: DatabaseHandle;
  let now: Date;

  function depsFor(open: DatabaseHandle): DispatchDeps {
    const clock = { now: (): Date => now };
    return {
      clock,
      automationAggregates: createAutomationAggregateRepository(open.db, clock),
      work: createDurableWorkStore(open.db),
      conversations: createConversationStore(open.db),
      contacts: createContactRepository(open.db, () => now),
      assets: createMemoryAssets({}),
      random: { next: (): number => 0 },
      audit: createAuditRepository(open.db),
      runs: createAutomationRunStore(open.db),
      messageWindowHours: 24,
      instanceSettings: fixedInstanceSettings(),
    };
  }

  async function install(
    open: DatabaseHandle,
    automations: readonly UnifiedAutomation[],
  ): Promise<void> {
    const clock = { now: (): Date => now };
    const repo = createAutomationAggregateRepository(open.db, clock);

    for (const automation of automations) {
      await repo.save(automation);
    }
  }

  /**
   * One sweep pass over this database, wired exactly as `app.ts` wires it: the
   * suspension handler with the resume the pause needs.
   */
  function sweep(deps: DispatchDeps): Promise<SweepReport> {
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

  /** Everything still in the table, whatever its kind. */
  function pending(open: DatabaseHandle): Promise<WorkItem[]> {
    return createDurableWorkStore(open.db).due(new Date(8.64e15));
  }

  async function sends(open: DatabaseHandle): Promise<string> {
    const items = await pending(open);
    return items
      .filter((item) => item.kind === "send")
      .map((item) => JSON.stringify(item.payload))
      .join(" | ");
  }

  beforeEach(() => {
    handle = openDatabase({ databasePath: IN_MEMORY_DATABASE });
    now = T0;
  });

  afterEach(() => {
    handle.close();
  });

  it("stops at the pause: the step after it is not queued before the deadline", async () => {
    const deps = depsFor(handle);
    await install(handle, [pausedAutomation()]);

    await createDispatcher(deps)(commentPayload(), EVENT);

    // The public reply went out and the direct message did not: that is the
    // pause doing its only job.
    expect(await sends(handle)).toContain("check your DMs");
    expect(await sends(handle)).not.toContain("here it is");

    const wait = (await pending(handle)).find(
      (item) => item.kind === "suspension",
    );
    expect(wait?.dueAt.getTime()).toBe(T0.getTime() + PAUSE * SECOND);
    // Waiting for the clock, and for nothing the contact might do.
    expect((wait?.payload as SuspensionPayload).expects).toBe("time");

    // One second short of the deadline the sweep leaves it exactly where it is.
    now = new Date(T0.getTime() + (PAUSE - 1) * SECOND);
    const report = await sweep(deps);

    expect(report.completed).toBe(0);
    expect(await sends(handle)).not.toContain("here it is");
  });

  it("resumes at the step after the pause when the deadline passes, unattended", async () => {
    const deps = depsFor(handle);
    await install(handle, [pausedAutomation()]);
    await createDispatcher(deps)(commentPayload(), EVENT);

    now = new Date(T0.getTime() + (PAUSE + 1) * SECOND);
    const report = await sweep(deps);

    expect(report.completed).toBe(1);
    expect(await sends(handle)).toContain("here it is");
    // Unattended in the literal sense: the contact never wrote, so no inbound
    // message was ever noted. Nothing in this run needed one.
    expect(await deps.conversations.lastInboundAt(CONTACT)).toBeUndefined();
    // And the wait is concluded, so a second pass does not deliver twice.
    expect((await sweep(deps)).completed).toBe(0);
  });

  it("carries the run's own window across the pause", async () => {
    const deps = depsFor(handle);
    await install(handle, [pausedAutomation()]);
    await createDispatcher(deps)(commentPayload(), EVENT);

    now = new Date(T0.getTime() + (PAUSE + 1) * SECOND);
    await sweep(deps);

    const delivery = (await pending(handle)).find(
      (item) =>
        item.kind === "send" &&
        JSON.stringify(item.payload).includes("here it is"),
    );
    // The run came from a comment and still answers under the comment's window,
    // counted from the comment (REQ-019, REQ-080). Resuming under the instant
    // the deadline happened to pass would restore a window that may well have
    // closed, and the send would go out only to be refused.
    expect(delivery?.payload).toMatchObject({
      origin: "comment",
      since: T0.toISOString(),
      commentId: "comment-1",
    });
    // The same execution, so the sends of one run stay keyed together and a
    // repeated resume cannot queue the same message twice.
    expect(delivery?.executionId).toMatch(/^paused-automation:contact-1:/);
  });

  it("a message during the pause is not swallowed by it", async () => {
    const deps = depsFor(handle);
    await install(handle, [pausedAutomation(), menuAutomation()]);
    const dispatch = createDispatcher(deps);
    await dispatch(commentPayload(), EVENT);

    now = new Date(T0.getTime() + 10 * SECOND);
    await dispatch(messagePayload("the menu please", now), "event-2");

    // The pause is not a wait for this contact, so their message reaches
    // matching as it would have with no run in flight at all.
    expect(await sends(handle)).toContain("the menu ran");
  });

  it("REQ-236: the run that message starts takes the contact from the pause", async () => {
    // Until phase 3l the paused run carried on and delivered on its own clock,
    // and this case asserted that it did. It cannot any more: the contact
    // triggered another automation, and the last automation triggered is the
    // one that holds them. A pause left running would come back long after they
    // moved on and hand over the material of the automation they left, which is
    // the accident REQ-236 exists to remove, arriving by the one door nobody
    // knocks on. What ends the pause is the new run STARTING, never the message
    // itself: see the case below, where nothing starts and the pause is intact.
    const deps = depsFor(handle);
    await install(handle, [pausedAutomation(), menuAutomation()]);
    const dispatch = createDispatcher(deps);
    await dispatch(commentPayload(), EVENT);

    now = new Date(T0.getTime() + 10 * SECOND);
    await dispatch(messagePayload("the menu please", now), "event-2");

    now = new Date(T0.getTime() + (PAUSE + 1) * SECOND);
    const report = await sweep(deps);

    // Nothing came due, because the row is concluded, and the step after the
    // pause never ran.
    expect(report.completed).toBe(0);
    expect(await sends(handle)).not.toContain("here it is");
    // REQ-238: the ending says which of the three it was.
    const ended = (await deps.audit.query({ contactId: CONTACT })).filter(
      (entry) => entry.subtype === "wait_ended",
    );
    expect(ended).toHaveLength(1);
    expect(ended[0]?.reason).toBe(
      t("suspension.superseded", { automation: "menu-automation" }),
    );
  });

  it("REQ-098: a message that starts nothing leaves the pause exactly where it was", async () => {
    // The other half, and the one that keeps REQ-236 from swallowing REQ-098: a
    // contact writing during a pause does not end it. Only a run BEGINNING
    // does, and here nothing matches, so the pause keeps its own deadline and
    // the run finishes as it always did.
    const deps = depsFor(handle);
    await install(handle, [pausedAutomation(), menuAutomation()]);
    const dispatch = createDispatcher(deps);
    await dispatch(commentPayload(), EVENT);

    now = new Date(T0.getTime() + 10 * SECOND);
    await dispatch(messagePayload("are you there?", now), "event-2");

    expect(await sends(handle)).not.toContain("the menu ran");
    expect(await sends(handle)).not.toContain("here it is");
    const wait = (await pending(handle)).find(
      (item) => item.kind === "suspension",
    );
    expect(wait?.dueAt.getTime()).toBe(T0.getTime() + PAUSE * SECOND);

    now = new Date(T0.getTime() + (PAUSE + 1) * SECOND);
    await sweep(deps);

    expect(await sends(handle)).toContain("here it is");
  });

  it("says so loudly when the sweep can pause a run and not continue one", async () => {
    const deps = depsFor(handle);
    await install(handle, [pausedAutomation()]);
    await createDispatcher(deps)(commentPayload(), EVENT);

    now = new Date(T0.getTime() + (PAUSE + 1) * SECOND);
    // The handler as it was before REQ-098 existed: no resume wired. A build
    // that composed this would strand every paused run one step from the end,
    // and the row must say so rather than be concluded over it.
    const report = await runSweep({
      work: deps.work,
      clock: deps.clock,
      handlers: {
        suspension: createSuspensionTimeoutHandler({
          audit: deps.audit,
          clock: deps.clock,
        }),
      },
    });

    expect(report.failed).toBe(1);
    expect(await sends(handle)).not.toContain("here it is");
  });
});

describe("REQ-098: the pause survives the process", () => {
  let directory: string;
  let databasePath: string;
  let now: Date;

  function depsFor(open: DatabaseHandle): DispatchDeps {
    const clock = { now: (): Date => now };
    return {
      clock,
      automationAggregates: createAutomationAggregateRepository(open.db, clock),
      work: createDurableWorkStore(open.db),
      conversations: createConversationStore(open.db),
      contacts: createContactRepository(open.db, () => now),
      assets: createMemoryAssets({}),
      random: { next: (): number => 0 },
      audit: createAuditRepository(open.db),
      runs: createAutomationRunStore(open.db),
      messageWindowHours: 24,
      instanceSettings: fixedInstanceSettings(),
    };
  }

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "mychat-delay-"));
    databasePath = join(directory, "mychat.db");
    now = T0;
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  it("is still paused after a restart, and resumes at the instant it was going to", async () => {
    const before = openDatabase({ databasePath });
    const first = depsFor(before);
    await createAutomationAggregateRepository(before.db, first.clock).save(
      pausedAutomation(),
    );
    await createDispatcher(first)(commentPayload(), EVENT);
    // The process ends here, mid-pause, holding nothing.
    before.close();

    const after = openDatabase({ databasePath });
    const second = depsFor(after);
    now = new Date(T0.getTime() + (PAUSE + 1) * SECOND);

    const report = await runSweep({
      work: second.work,
      clock: second.clock,
      handlers: {
        suspension: createSuspensionTimeoutHandler({
          audit: second.audit,
          clock: second.clock,
          resume: createPauseResume(second),
        }),
      },
    });

    // A restart is not a reason to forget a run was paused, nor to forget when
    // the pause was supposed to end. Nothing was held in memory: the process
    // that comes back finds the row the process that died wrote.
    expect(report.completed).toBe(1);
    const queued = (await second.work.due(new Date(8.64e15)))
      .filter((item) => item.kind === "send")
      .map((item) => JSON.stringify(item.payload))
      .join(" | ");
    expect(queued).toContain("here it is");
    after.close();
  });
});

/**
 * The operator's wait, which is a different wait from the pause above
 * (REQ-277).
 *
 * The pause holds a RUN between two named steps; this holds the automation's
 * FIRST reply, and it is a value on the aggregate rather than a step in a list.
 * What both have in common is the thing this file exists to prove: the wait is
 * a persisted instant collected by the sweep (ADR-005), so it costs the process
 * nothing while it passes and is still there after a restart in the middle
 * of it.
 *
 * The wait it replaced could not have been proven here at all. It was assembled
 * as the LAST step by the only screen that wrote one, so it paused a run with
 * nothing left to send: switched on or off, the contact received the same
 * messages in the same instants, and every assertion in this file would have
 * passed either way.
 */
describe("REQ-277: the wait before the first reply is an instant, not a sleep", () => {
  let handle: DatabaseHandle;
  let now: Date;

  function depsFor(open: DatabaseHandle): DispatchDeps {
    const clock = { now: (): Date => now };
    return {
      clock,
      automationAggregates: createAutomationAggregateRepository(open.db, clock),
      work: createDurableWorkStore(open.db),
      conversations: createConversationStore(open.db),
      contacts: createContactRepository(open.db, () => now),
      assets: createMemoryAssets({}),
      random: { next: (): number => 0 },
      audit: createAuditRepository(open.db),
      runs: createAutomationRunStore(open.db),
      messageWindowHours: 24,
      instanceSettings: fixedInstanceSettings(),
    };
  }

  /** What the sweep would take at a given instant, as one searchable string. */
  async function takeableAt(open: DatabaseHandle, at: Date): Promise<string> {
    const items = await createDurableWorkStore(open.db).due(at);
    return items
      .filter((item) => item.kind === "send")
      .map((item) => JSON.stringify(item.payload))
      .join(" | ");
  }

  /** Every queued send, whatever its instant, with the instant it carries. */
  async function allSends(
    open: DatabaseHandle,
  ): Promise<{ text: string; dueAt: Date }[]> {
    const items = await createDurableWorkStore(open.db).due(new Date(8.64e15));
    return items
      .filter((item) => item.kind === "send")
      .map((item) => ({
        text: JSON.stringify(item.payload),
        dueAt: item.dueAt,
      }));
  }

  beforeEach(() => {
    handle = openDatabase({ databasePath: IN_MEMORY_DATABASE });
    now = T0;
  });

  afterEach(() => {
    handle.close();
  });

  it("writes the reply down at once and lets nothing take it before the wait is over", async () => {
    const deps = depsFor(handle);
    await createAutomationAggregateRepository(handle.db, deps.clock).save(
      waitingAndPausingAutomation(),
    );

    await createDispatcher(deps)(commentPayload(), EVENT);

    // Decided and persisted in the same instant the comment arrived: the run
    // did all its work, and only the delivery is held. Nothing was scheduled in
    // memory, so there is nothing a restart could lose.
    const sends = await allSends(handle);
    expect(sends).toHaveLength(1);
    expect(sends[0]?.dueAt.getTime()).toBe(
      T0.getTime() + FIRST_REPLY_WAIT * SECOND,
    );
    expect(await takeableAt(handle, T0)).toBe("");
    expect(
      await takeableAt(
        handle,
        new Date(T0.getTime() + (FIRST_REPLY_WAIT - 1) * SECOND),
      ),
    ).toBe("");
    expect(
      await takeableAt(
        handle,
        new Date(T0.getTime() + FIRST_REPLY_WAIT * SECOND),
      ),
    ).toContain("check your DMs");
  });

  it("holds the first reply and the run's pause as two separate waits", async () => {
    const deps = depsFor(handle);
    await createAutomationAggregateRepository(handle.db, deps.clock).save(
      waitingAndPausingAutomation(),
    );

    await createDispatcher(deps)(commentPayload(), EVENT);

    // The rule moved the REPLY; the step suspended the RUN. Neither borrowed
    // the other's number: ten seconds for the one, thirty for the other,
    // counted from the same instant and meaning different things.
    const wait = (
      await createDurableWorkStore(handle.db).due(new Date(8.64e15))
    )
      .filter((item) => item.kind === "suspension")
      .at(0);
    expect(wait?.dueAt.getTime()).toBe(T0.getTime() + PAUSE * SECOND);
    expect((wait?.payload as SuspensionPayload).expects).toBe("time");

    now = new Date(T0.getTime() + (PAUSE + 1) * SECOND);
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
    expect(report.completed).toBe(1);

    // And the step AFTER the pause is not held a second time: the wait applies
    // to the pass the trigger started, and a run picked back up by the sweep is
    // not that pass. Held again, every wait in the flow would silently cost the
    // operator's ten seconds too.
    const delivery = (await allSends(handle)).find((send) =>
      send.text.includes("here it is"),
    );
    expect(delivery?.dueAt.getTime()).toBe(now.getTime());
  });
});

describe("REQ-277: the wait survives the process", () => {
  let directory: string;
  let databasePath: string;
  let now: Date;

  function depsFor(open: DatabaseHandle): DispatchDeps {
    const clock = { now: (): Date => now };
    return {
      clock,
      automationAggregates: createAutomationAggregateRepository(open.db, clock),
      work: createDurableWorkStore(open.db),
      conversations: createConversationStore(open.db),
      contacts: createContactRepository(open.db, () => now),
      assets: createMemoryAssets({}),
      random: { next: (): number => 0 },
      audit: createAuditRepository(open.db),
      runs: createAutomationRunStore(open.db),
      messageWindowHours: 24,
      instanceSettings: fixedInstanceSettings(),
    };
  }

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "mychat-first-reply-"));
    databasePath = join(directory, "mychat.db");
    now = T0;
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  it("is still held for the same instant after a restart, with the message intact", async () => {
    const before = openDatabase({ databasePath });
    const first = depsFor(before);
    await createAutomationAggregateRepository(before.db, first.clock).save(
      waitingAndPausingAutomation(),
    );
    await createDispatcher(first)(commentPayload(), EVENT);
    // The process ends here, inside the wait, holding nothing.
    before.close();

    const after = openDatabase({ databasePath });
    const second = depsFor(after);

    // The message the dead process composed is on the table, with the instant
    // it was given. A timer would have died with the process and the reply
    // would never have left; the row does not know the process restarted.
    const held = (await second.work.due(new Date(8.64e15))).filter(
      (item) => item.kind === "send",
    );
    expect(held).toHaveLength(1);
    expect(held[0]?.dueAt.getTime()).toBe(
      T0.getTime() + FIRST_REPLY_WAIT * SECOND,
    );
    expect(JSON.stringify(held[0]?.payload)).toContain("check your DMs");
    // And it becomes the sweep's business at that instant and no earlier.
    expect(await second.work.due(T0)).toHaveLength(0);
    expect(
      await second.work.due(new Date(T0.getTime() + FIRST_REPLY_WAIT * SECOND)),
    ).toHaveLength(1);
    after.close();
  });
});
