import { describe, expect, it } from "vitest";
import {
  EXECUTION_FAILURE_REASONS,
  isExecutionFailureReason,
  isSuppressionReason,
  runExecution,
  SUPPRESSION_REASONS,
} from "./execute.js";
import type {
  ExecutionFailureReason,
  ExecutionResult,
  ExecutionStart,
  FlowRegistry,
} from "./execute.js";
import type {
  FlowDefinition,
  FlowStep,
  StepCardButton,
  StepConfigValue,
} from "./flow.js";
import { EMAIL_ATTRIBUTE } from "./ports.js";
import type {
  AttributeValue,
  ContactAttributes,
  EnginePorts,
  FollowStatus,
  OutboundMessage,
  SuspensionRequest,
  WaitingSettings,
} from "./ports.js";

/**
 * Proves REQ-009, REQ-011, REQ-012 and REQ-060: the engine runs a flow's steps
 * in the declared order, one at a time, over the definition the run started
 * with, and refuses to half-run a definition that is not in force.
 *
 * Every port here is a double. That is the point of ADR-003 — the whole core
 * is exercised with no network, no store and no platform, which is what makes
 * this suite fast enough to sit in the commit gate.
 */

/**
 * What the instance decided about waiting, for the cases that do not care.
 *
 * A step declares neither of these since phase 3l (REQ-252, REQ-254): they are
 * one setting of the instance, injected as data, and a case that asserts a
 * deadline names its own numbers instead of taking these.
 */
const DEFAULT_WAITING: WaitingSettings = {
  hours: 24,
  questions: 3,
  followButtonLabel: "I followed",
};

/** Records what happened and when, so ordering can be asserted, not assumed. */
interface Trace {
  readonly events: string[];
}

function ports(
  trace: Trace,
  options: {
    readonly attributes?: ContactAttributes;
    readonly delayMs?: number;
    readonly conversationOpen?: boolean;
    /**
     * What the follow query answers. Absent leaves the port itself absent,
     * which is the ordinary case: the engine treats it as `not_configured`.
     */
    readonly followStatus?: FollowStatus;
    /** Collects what each wait asked for, so a deadline can be asserted. */
    readonly suspensions?: SuspensionRequest[];
    /**
     * Collects the messages themselves, in the order they were handed over.
     *
     * The trace above records the TEXT, which is all the ordering cases need;
     * a delivery made of several messages is judged on what each one carries
     * (a card, an address, nothing beside it), so those cases read this.
     */
    readonly sent?: OutboundMessage[];
    /** A clock that does not tick, for asserting an instant to the millisecond. */
    readonly frozenAt?: Date;
    /**
     * What the send port refuses with, in the words of whoever refused. The
     * case REQ-171 draws its line at: this text is nobody's catalogue entry.
     */
    readonly senderError?: string;
    /** What the instance decided about waiting (REQ-252, REQ-254). */
    readonly waiting?: WaitingSettings;
    /**
     * What the once-per-contact gate answers (REQ-239, REQ-240). Absent leaves
     * the port itself absent, which is an automation that never asked for the
     * rule and therefore delivers.
     */
    readonly mayDeliver?: boolean;
  } = {},
): EnginePorts {
  let tick = 0;
  const written: Record<string, AttributeValue> = { ...options.attributes };
  // Read into a local so the port below closes over a value the compiler has
  // already narrowed, rather than over a property it has to re-check.
  const follows = options.followStatus;

  const pause = async (): Promise<void> => {
    if (options.delayMs === undefined) return;
    await new Promise((resolve) => setTimeout(resolve, options.delayMs));
  };

  const record = async (
    label: string,
    message: OutboundMessage,
  ): Promise<void> => {
    if (options.senderError !== undefined) {
      throw new Error(options.senderError);
    }
    options.sent?.push(message);
    trace.events.push(`start:${label}:${message.text}`);
    await pause();
    trace.events.push(`end:${label}:${message.text}`);
  };

  return {
    clock: {
      now: (): Date => {
        if (options.frozenAt !== undefined) return options.frozenAt;
        tick += 1;
        return new Date(Date.UTC(2026, 7, 1, 0, 0, tick));
      },
    },
    contacts: {
      getAttributes: (): Promise<ContactAttributes> => Promise.resolve(written),
      setAttribute: (_contactId, key, value): Promise<void> => {
        written[key] = value;
        trace.events.push(`attribute:${key}=${String(value)}`);
        return Promise.resolve();
      },
    },
    sender: {
      sendDirectMessage: (_contactId, message): Promise<void> =>
        record("dm", message),
      replyToComment: (_commentId, message): Promise<void> =>
        record("reply", message),
    },
    assets: {
      publicUrl: (name): Promise<string> =>
        Promise.resolve(`https://assets.test/${name}`),
    },
    random: { next: (): number => 0 },
    waiting: options.waiting ?? DEFAULT_WAITING,
    ...(follows !== undefined && {
      follow: { status: (): Promise<FollowStatus> => Promise.resolve(follows) },
    }),
    ...(options.mayDeliver !== undefined && {
      delivery: {
        claim: (): Promise<boolean> => {
          trace.events.push("claim");
          return Promise.resolve(options.mayDeliver === true);
        },
      },
    }),
    suspender: {
      suspend: (request): Promise<void> => {
        trace.events.push(`suspend:${request.stepId}`);
        options.suspensions?.push(request);
        return Promise.resolve();
      },
      // Closed by default: the confirmation is the interesting path, and a
      // double that skipped it would quietly test nothing.
      isConversationOpen: (): Promise<boolean> =>
        Promise.resolve(options.conversationOpen ?? false),
    },
  };
}

function registryOf(...flows: FlowDefinition[]): FlowRegistry {
  return {
    current: (flowId): FlowDefinition | undefined =>
      flows.find((flow) => flow.id === flowId),
  };
}

const START: ExecutionStart = {
  flowId: "welcome",
  contactId: "contact-1",
  origin: "comment",
  commentId: "comment-1",
};

/** Three steps chained by `goto`, ending explicitly. */
function threeStepFlow(): FlowDefinition {
  return {
    id: "welcome",
    steps: [
      {
        id: "a",
        type: "send_message",
        config: { text: "first" },
        transition: { kind: "goto", stepId: "b" },
      },
      {
        id: "b",
        type: "send_message",
        config: { text: "second" },
        transition: { kind: "goto", stepId: "c" },
      },
      {
        id: "c",
        type: "send_message",
        config: { text: "third" },
        transition: { kind: "end" },
      },
    ],
  };
}

const PAUSE_SECONDS = 600;

/**
 * Two sends with a declared pause between them (REQ-098). `null` is a pause
 * step that declares no time at all, which is a definition rather than an
 * omission in the fixture.
 */
function pausedFlow(seconds: number | null = PAUSE_SECONDS): FlowDefinition {
  return {
    id: "welcome",
    steps: [
      {
        id: "before",
        type: "send_message",
        config: { text: "first" },
        transition: { kind: "goto", stepId: "pause" },
      },
      {
        id: "pause",
        type: "delay",
        config: seconds === null ? {} : { seconds },
        transition: { kind: "goto", stepId: "after" },
      },
      {
        id: "after",
        type: "send_message",
        config: { text: "second" },
        transition: { kind: "end" },
      },
    ],
  };
}

/**
 * One step that may suppress itself, and a send after it. The second step is
 * the part that matters: a suppression is not an ending, so the run has to
 * reach it (REQ-068).
 */
function gatedFlow(gate: Omit<FlowStep, "transition">): FlowDefinition {
  return {
    id: "welcome",
    steps: [
      { ...gate, transition: { kind: "goto", stepId: "after" } },
      {
        id: "after",
        type: "send_message",
        config: { text: "second" },
        transition: { kind: "end" },
      },
    ],
  };
}

/**
 * Two pure links declared OUT of every order they could fall into by accident
 * (REQ-286, REQ-288).
 *
 * `zeta` before `alpha`, so a sort — alphabetical on the address or on the
 * host — would swap them, and a case asserting the declared order would catch
 * it. A fixture that happened to be alphabetical would pass under a sort just
 * as happily as under no sort at all, and would prove nothing about order.
 */
const PURE_LINKS = [
  "https://zeta.example/webinar",
  "https://alpha.example/blog-post",
] as const;

/** The file of the catalogue a card button opens (REQ-285). */
const GUIDE_ASSET = "guide~9f2c1a7b.pdf";

/** One delivery: what the operator wrote, and the addresses after it. */
function linkedFlow(
  config: Readonly<Record<string, StepConfigValue>> = {},
): FlowDefinition {
  return {
    id: "welcome",
    steps: [
      {
        id: "deliver",
        type: "send_dm",
        config: {
          text: "here it is",
          links: [...PURE_LINKS],
          ...config,
        },
        transition: { kind: "end" },
      },
    ],
  };
}

describe("REQ-286: the pure link is a message of its own, after the first", () => {
  it("sends the private message, then one message per link, in the declared order", async () => {
    const trace: Trace = { events: [] };
    const sent: OutboundMessage[] = [];

    await runExecution(START, registryOf(linkedFlow()), ports(trace, { sent }));

    // Three messages out of one step, and the order is the operator's: what
    // they wrote, then the addresses as they declared them. The fixture is
    // deliberately not alphabetical, so a sort anywhere on this path shows up
    // right here.
    expect(sent.map((message) => message.text)).toEqual([
      "here it is",
      PURE_LINKS[0],
      PURE_LINKS[1],
    ]);
  });

  it("gives the address the whole message, with nothing around it", async () => {
    const trace: Trace = { events: [] };
    const sent: OutboundMessage[] = [];

    await runExecution(START, registryOf(linkedFlow()), ports(trace, { sent }));

    for (const message of sent.slice(1)) {
      // No card, no button, no wrapper: the address IS the message, because
      // the site at the other end is what draws the preview and it draws it
      // from what it is given. Anything around the address — a card, a
      // `/clicks/<id>` in its place, a sentence introducing it — is the
      // preview never being drawn while the message still arrives.
      expect(message.card).toBeUndefined();
      expect(message.link).toBeUndefined();
      expect(message.quickReplies).toBeUndefined();
      expect(message.attachment).toBeUndefined();
    }
  });

  it("puts the links after the CARD when the message is one", async () => {
    const trace: Trace = { events: [] };
    const sent: OutboundMessage[] = [];

    await runExecution(
      START,
      registryOf(
        linkedFlow({
          card: {
            buttons: [
              { id: "course", label: "See the course", url: "https://c.test" },
            ],
          },
        }),
      ),
      ports(trace, { sent }),
    );

    // Card-or-text first, then each link: the one order, whichever of the two
    // the first message turns out to be.
    expect(sent[0]?.card).toBeDefined();
    expect(sent.slice(1).map((message) => message.text)).toEqual([
      ...PURE_LINKS,
    ]);
  });

  it("says which message of the delivery each one is, after the first", async () => {
    const trace: Trace = { events: [] };
    const sent: OutboundMessage[] = [];

    await runExecution(START, registryOf(linkedFlow()), ports(trace, { sent }));

    // The position is what lets the queue keep the second message from
    // leaving in the same second as the first (REQ-231), and what tells two
    // identical addresses apart when it hashes them. The first carries none,
    // so a delivery of one message is byte for byte what it always was.
    expect(sent.map((message) => message.part)).toEqual([undefined, 2, 3]);
  });
});

describe("REQ-285: a card button opens a file of the catalogue", () => {
  /** A card whose one button opens a file, declared by NAME. */
  function fileButtonFlow(
    buttons: readonly StepCardButton[] = [
      { id: "guide", label: "Get the guide", asset: GUIDE_ASSET },
    ],
  ): FlowDefinition {
    return {
      id: "welcome",
      steps: [
        {
          id: "deliver",
          type: "send_dm",
          config: { text: "here is the guide", card: { buttons } },
          transition: { kind: "end" },
        },
      ],
    };
  }

  it("resolves the file at send time and delivers it as the button's destination", async () => {
    const trace: Trace = { events: [] };
    const sent: OutboundMessage[] = [];

    await runExecution(
      START,
      registryOf(fileButtonFlow()),
      ports(trace, { sent }),
    );

    // The NAME travels through the definition and becomes a URL of our own
    // CDN in the instant before the send, exactly as the cover does: what
    // leaves is the address, and what was stored is the resource.
    expect(sent[0]?.card?.buttons).toEqual([
      {
        id: "guide",
        label: "Get the guide",
        url: `https://assets.test/${GUIDE_ASSET}`,
      },
    ]);
  });

  it("hands the file over as ONE message, and never as an attachment", async () => {
    const trace: Trace = { events: [] };
    const sent: OutboundMessage[] = [];

    await runExecution(
      START,
      registryOf(fileButtonFlow()),
      ports(trace, { sent }),
    );

    // The message shape is an engine contract; its platform rationale is in
    // `docs/platform-limits.md`.
    expect(sent).toHaveLength(1);
    expect(sent[0]?.text).toBe("here is the guide");
    expect(sent.every((message) => message.attachment === undefined)).toBe(
      true,
    );
  });

  it("keeps a typed address a typed address, beside a file", async () => {
    const trace: Trace = { events: [] };
    const sent: OutboundMessage[] = [];

    await runExecution(
      START,
      registryOf(
        fileButtonFlow([
          { id: "site", label: "Our site", url: "https://example.test/site" },
          { id: "guide", label: "Get the guide", asset: GUIDE_ASSET },
        ]),
      ),
      ports(trace, { sent }),
    );

    // Only the file is resolved. A button that already names an address is
    // left alone — passing it through the catalogue would ask it for a
    // resource nobody ever stored.
    expect(sent[0]?.card?.buttons.map((button) => button.url)).toEqual([
      "https://example.test/site",
      `https://assets.test/${GUIDE_ASSET}`,
    ]);
  });

  it("fails the run when the file is gone, instead of sending a dead button", async () => {
    const trace: Trace = { events: [] };
    const gone = ports(trace, {});
    const result = await runExecution(START, registryOf(fileButtonFlow()), {
      ...gone,
      assets: {
        publicUrl: (): Promise<string> =>
          Promise.reject(new Error(`asset "${GUIDE_ASSET}" does not exist`)),
      },
    });

    // A file deleted after the automation was written is the reason the NAME
    // travels rather than the URL: the send fails loudly, and the operator
    // reads it on the trail, instead of a contact tapping a button that opens
    // nothing.
    expect(result.outcome).toBe("failed");
    expect(trace.events).toEqual([]);
  });
});

describe("REQ-009: steps run in the declared order, one at a time", () => {
  it("touches every step, in order", async () => {
    const trace: Trace = { events: [] };

    const result = await runExecution(
      START,
      registryOf(threeStepFlow()),
      ports(trace),
    );

    expect(result.outcome).toBe("finished");
    expect(result.steps.map((step) => step.stepId)).toEqual(["a", "b", "c"]);
  });

  it("never starts a step before the previous one finished", async () => {
    // The guarantee that matters: with a slow sender, an interleaved
    // implementation would produce start:start:end:end. A flow that overlaps
    // its steps could deliver a link before the question asking for consent.
    const trace: Trace = { events: [] };

    await runExecution(
      START,
      registryOf(threeStepFlow()),
      ports(trace, { delayMs: 5 }),
    );

    expect(trace.events).toEqual([
      "start:dm:first",
      "end:dm:first",
      "start:dm:second",
      "end:dm:second",
      "start:dm:third",
      "end:dm:third",
    ]);
  });

  it("reports each step's start and finish, so the audit trail can order them", async () => {
    const trace: Trace = { events: [] };

    const result = await runExecution(
      START,
      registryOf(threeStepFlow()),
      ports(trace),
    );

    for (const step of result.steps) {
      expect(step.finishedAt.getTime()).toBeGreaterThanOrEqual(
        step.startedAt.getTime(),
      );
      expect(step.outcome).toBe("done");
    }
  });
});

describe("REQ-011 / REQ-060: a run holds the definition it started with", () => {
  it("uses the definition in force at the moment the run begins", async () => {
    const trace: Trace = { events: [] };
    let inForce = threeStepFlow();
    const registry: FlowRegistry = { current: () => inForce };

    // The edit lands BEFORE this run starts, so this run must see it.
    inForce = {
      id: "welcome",
      steps: [
        {
          id: "only",
          type: "send_message",
          config: { text: "edited" },
          transition: { kind: "end" },
        },
      ],
    };

    const result = await runExecution(START, registry, ports(trace));

    expect(result.steps.map((step) => step.stepId)).toEqual(["only"]);
    expect(trace.events).toContain("start:dm:edited");
  });

  it("finishes under the old definition when the flow is edited mid-run", async () => {
    // The registry swaps the definition the first time it is asked. A run that
    // re-read the registry between steps would switch versions halfway and
    // leave the contact in a conversation belonging to neither one.
    const trace: Trace = { events: [] };
    let asked = 0;

    const registry: FlowRegistry = {
      current: (): FlowDefinition => {
        asked += 1;
        return asked === 1
          ? threeStepFlow()
          : {
              id: "welcome",
              steps: [
                {
                  id: "replacement",
                  type: "send_message",
                  config: { text: "new version" },
                  transition: { kind: "end" },
                },
              ],
            };
      },
    };

    const result = await runExecution(START, registry, ports(trace));

    expect(result.steps.map((step) => step.stepId)).toEqual(["a", "b", "c"]);
    expect(trace.events).not.toContain("start:dm:new version");
    // Read exactly once: the snapshot is taken at start and never refreshed.
    expect(asked).toBe(1);
  });
});

describe("REQ-012: a definition not in force never half-runs", () => {
  it("runs nothing when the flow is unknown", async () => {
    const trace: Trace = { events: [] };

    const result = await runExecution(START, registryOf(), ports(trace));

    expect(result.outcome).toBe("failed");
    expect(result.steps).toEqual([]);
    expect(trace.events).toEqual([]);
    // A code, and the flow beside it (REQ-171). Which flow is a datum, so it
    // travels as one; naming it inside the reason would make the reason a
    // sentence, and a sentence is what nothing downstream can translate.
    expect(result.reason).toBe("flow_not_runnable");
    expect(result.detail).toBe("welcome");
  });

  it("runs nothing when the definition in force is malformed", async () => {
    const trace: Trace = { events: [] };
    const malformed = {
      id: "welcome",
      steps: [{ id: 42, type: "send_message" }],
    } as unknown as FlowDefinition;

    const result = await runExecution(
      START,
      registryOf(malformed),
      ports(trace),
    );

    expect(result.outcome).toBe("failed");
    expect(result.steps).toEqual([]);
    expect(trace.events).toEqual([]);
  });
});

describe("the engine executes the step kinds this phase declares", () => {
  /*
   * `set_attribute` used to be the first case here, and it left the engine with
   * REQ-258: it wrote a value under a name an operator invented and nothing in
   * this product ever read it back. The contact repository stays, because the
   * e-mail `collect_email` collects is written and read through it (REQ-024);
   * what left is the STEP that let anyone write anything through it. Its
   * removal is proved in `runtime/execution-audit.test.ts`, where the step now
   * reaches the trail as a kind this build cannot perform.
   */

  it("replies to the comment the run came from", async () => {
    const trace: Trace = { events: [] };
    const flow: FlowDefinition = {
      id: "welcome",
      steps: [
        {
          id: "public",
          type: "reply_comment",
          config: { text: "check your DMs" },
          transition: { kind: "end" },
        },
      ],
    };

    const result = await runExecution(START, registryOf(flow), ports(trace));

    expect(result.outcome).toBe("finished");
    expect(trace.events).toContain("start:reply:check your DMs");
  });

  it("fails the run when a comment reply has no comment to answer", async () => {
    const trace: Trace = { events: [] };
    const flow: FlowDefinition = {
      id: "welcome",
      steps: [
        {
          id: "public",
          type: "reply_comment",
          config: { text: "hi" },
          transition: { kind: "end" },
        },
      ],
    };

    const result = await runExecution(
      { ...START, origin: "direct_message", commentId: undefined },
      registryOf(flow),
      ports(trace),
    );

    expect(result.outcome).toBe("failed");
    expect(result.steps[0]?.outcome).toBe("failed");
  });

  it("stops the run at an unsupported step kind instead of skipping it", async () => {
    // Skipping would mean the flow made a promise to the contact and quietly
    // did not keep it.
    const trace: Trace = { events: [] };
    const flow: FlowDefinition = {
      id: "welcome",
      steps: [
        {
          id: "mystery",
          type: "teleport",
          transition: { kind: "goto", stepId: "after" },
        },
        {
          id: "after",
          type: "send_message",
          config: { text: "never sent" },
          transition: { kind: "end" },
        },
      ],
    };

    const result = await runExecution(START, registryOf(flow), ports(trace));

    expect(result.outcome).toBe("failed");
    expect(result.reason).toBe("step_type_unsupported");
    // The kind the definition asked for, which is the one thing an operator
    // needs in order to fix it.
    expect(result.detail).toBe("teleport");
    expect(trace.events).toEqual([]);
  });

  it("stops a flow whose transitions form a cycle", async () => {
    const trace: Trace = { events: [] };
    const flow: FlowDefinition = {
      id: "welcome",
      steps: [
        {
          id: "a",
          type: "send_message",
          config: { text: "loop" },
          transition: { kind: "goto", stepId: "b" },
        },
        {
          id: "b",
          type: "send_message",
          config: { text: "loop" },
          transition: { kind: "goto", stepId: "a" },
        },
      ],
    };

    const result = await runExecution(START, registryOf(flow), ports(trace));

    expect(result.outcome).toBe("failed");
    expect(result.reason).toBe("transitions_form_a_cycle");
    expect(result.detail).toBe("welcome");
  });
});

describe("REQ-098: a declared pause suspends the run, and the clock ends it", () => {
  it("pauses for the declared time instead of running the next step", async () => {
    // The step was declared in the schema from Phase 0 and had no case here at
    // all, so a flow with a pause was accepted on the way in and threw halfway
    // through the execution (REQ-098).
    const trace: Trace = { events: [] };

    const result = await runExecution(
      START,
      registryOf(pausedFlow()),
      ports(trace),
    );

    expect(result.outcome).toBe("suspended");
    expect(result.steps.map((step) => step.stepId)).toEqual([
      "before",
      "pause",
    ]);
    expect(result.steps.at(-1)?.outcome).toBe("suspended");
    // The heart of it: the step after the pause has NOT run, and nothing was
    // sent by the pause itself either.
    expect(trace.events).toEqual([
      "start:dm:first",
      "end:dm:first",
      "suspend:pause",
    ]);
  });

  it("asks for the wait to end at the declared instant, by time alone", async () => {
    const trace: Trace = { events: [] };
    const suspensions: SuspensionRequest[] = [];
    const at = new Date("2026-08-01T10:00:00.000Z");

    await runExecution(
      START,
      registryOf(pausedFlow(PAUSE_SECONDS)),
      ports(trace, { suspensions, frozenAt: at }),
    );

    expect(suspensions).toHaveLength(1);
    expect(suspensions[0]?.stepId).toBe("pause");
    // Exactly the declared time, and not a minute the engine chose.
    expect(suspensions[0]?.expiresAt.getTime()).toBe(
      at.getTime() + PAUSE_SECONDS * 1000,
    );
    // What ends it is the clock: no answer, no button and no query from the
    // contact has any part in it.
    expect(suspensions[0]?.expects).toBe("time");
  });

  it("resumes at the step after the pause, with nothing asked of the contact", async () => {
    const trace: Trace = { events: [] };

    const result = await runExecution(
      { ...START, resumeAfterStepId: "pause" },
      registryOf(pausedFlow()),
      ports(trace),
    );

    expect(result.outcome).toBe("finished");
    expect(result.steps.map((step) => step.stepId)).toEqual(["after"]);
    // The step before the pause is not repeated, and the message after it goes
    // out: the run continues where it stopped.
    expect(trace.events).toEqual(["start:dm:second", "end:dm:second"]);
  });

  it("stops the run at a pause that declares no time, instead of not pausing", async () => {
    // A pause of nothing is the one outcome that would look like success and be
    // the failure this step exists to prevent: the step after it would fire in
    // the same instant as the step before.
    const trace: Trace = { events: [] };
    const suspensions: SuspensionRequest[] = [];

    const result = await runExecution(
      START,
      registryOf(pausedFlow(null)),
      ports(trace, { suspensions }),
    );

    expect(result.outcome).toBe("failed");
    expect(result.reason).toBe("pause_without_duration");
    expect(suspensions).toEqual([]);
    expect(trace.events).not.toContain("start:dm:second");
  });
});

describe("REQ-277: the automation's wait is not a step, and no run is held for it", () => {
  it("hands every message over in the first pass, suspending nothing before the first step", async () => {
    // A pin by EXCLUSION, and the design it excludes was the obvious one: the
    // wait before the first reply could have been a suspension created ahead of
    // step one, resumed by the sweep when the deadline passed. It is not, and
    // this asserts that it never becomes one, because held that way the first
    // pass would produce no message at all: everything a contact receives would
    // depend on a resume, so a build that forgot to wire it would deliver
    // NOTHING instead of delivering late, and a wait of five seconds would cost
    // an open execution and a second pass over the definition.
    //
    // Where the wait lives instead is the due instant of the rows the sends
    // become (`notBefore` in `src/runtime/outbox.ts`), which is the same
    // durable mechanism (ADR-005) with nothing suspended and nothing to resume.
    // The engine is not told about it at all: it has no port to ask, and this
    // run finishes exactly as it did before the rule existed.
    const trace: Trace = { events: [] };
    const suspensions: SuspensionRequest[] = [];

    const result = await runExecution(
      START,
      registryOf(threeStepFlow()),
      ports(trace, { suspensions }),
    );

    expect(result.outcome).toBe("finished");
    expect(suspensions).toEqual([]);
    expect(result.steps.map((step) => step.stepId)).toEqual(["a", "b", "c"]);
    // Every message handed to the sender, in one pass, with nobody waited on.
    expect(trace.events).toEqual([
      "start:dm:first",
      "end:dm:first",
      "start:dm:second",
      "end:dm:second",
      "start:dm:third",
      "end:dm:third",
    ]);
  });
});

describe("REQ-252/REQ-254: the instance decides how long and how often", () => {
  /**
   * The three steps that wait, each asked to wait once, with the deadline and
   * the number of questions coming from OUTSIDE the definition.
   *
   * The step declares neither since phase 3l, and this is the seam where that
   * has to be true: `timeout_hours` and `max_attempts` used to be read off
   * `step.config`, so a step that stopped writing them would have waited zero
   * hours, silently, and every wait would have come due the instant it was
   * created.
   */
  const waits: readonly (readonly [string, Omit<FlowStep, "transition">])[] = [
    [
      "confirm_optin",
      {
        id: "ask",
        type: "confirm_optin",
        // The button is obligatory since REQ-249, and a confirmation without
        // one no longer suspends at all: it fails, which is proved next door.
        config: { text: "may I?", quick_reply_label: "yes" },
      },
    ],
    [
      "collect_email",
      { id: "ask", type: "collect_email", config: { text: "address?" } },
    ],
    [
      "follow_gate",
      { id: "ask", type: "follow_gate", config: { text: "follow us" } },
    ],
  ];

  const HOUR_MS = 60 * 60 * 1000;
  const AT = new Date("2026-08-18T09:00:00.000Z");

  it.each(waits)(
    "gives %s the instance's deadline, counted from the moment it asks",
    async (_action, step) => {
      const suspensions: SuspensionRequest[] = [];

      await runExecution(
        START,
        registryOf(gatedFlow(step)),
        ports(
          { events: [] },
          {
            suspensions,
            frozenAt: AT,
            waiting: { ...DEFAULT_WAITING, hours: 168 },
          },
        ),
      );

      expect(suspensions).toHaveLength(1);
      // The number the operator configured, to the millisecond, and not a
      // default the engine chose for itself.
      expect(suspensions[0]?.expiresAt.getTime()).toBe(
        AT.getTime() + 168 * HOUR_MS,
      );
    },
  );

  it("gives all three the SAME deadline, because there is one setting", async () => {
    const deadlines: number[] = [];

    for (const [, step] of waits) {
      const suspensions: SuspensionRequest[] = [];
      await runExecution(
        START,
        registryOf(gatedFlow(step)),
        ports(
          { events: [] },
          {
            suspensions,
            frozenAt: AT,
            waiting: { ...DEFAULT_WAITING, hours: 12 },
          },
        ),
      );
      deadlines.push(Number(suspensions[0]?.expiresAt.getTime()));
    }

    // Three fields asking for the same number is what the operator had to read
    // before, and what nobody could tell apart. One value, three waits.
    expect(new Set(deadlines).size).toBe(1);
    expect(deadlines[0]).toBe(AT.getTime() + 12 * HOUR_MS);
  });

  it("keeps each re-ask's question together with its configured cap", async () => {
    const carried = new Map<
      string,
      Pick<SuspensionRequest, "question" | "maxAttempts">
    >();

    for (const [action, step] of waits) {
      const suspensions: SuspensionRequest[] = [];
      await runExecution(
        START,
        registryOf(gatedFlow(step)),
        ports(
          { events: [] },
          {
            suspensions,
            frozenAt: AT,
            waiting: { ...DEFAULT_WAITING, questions: 2 },
          },
        ),
      );
      const suspension = suspensions[0];
      carried.set(action, {
        question: suspension?.question,
        maxAttempts: suspension?.maxAttempts,
      });
    }

    // REQ-254 names the e-mail and the confirmation, and the follow gate is
    // deliberately not among them: a contact writing while not yet following is
    // not answering wrongly, and counting their messages would close a gate they
    // were about to pass.
    expect(carried.get("collect_email")).toEqual({
      question: "address?",
      maxAttempts: 2,
    });
    expect(carried.get("confirm_optin")).toEqual({
      question: "may I?",
      maxAttempts: 2,
    });
    expect(carried.get("follow_gate")).toEqual({
      question: "follow us",
      maxAttempts: undefined,
    });
  });
});

describe("REQ-163: a suppressed step reports a code, never a sentence", () => {
  /**
   * The engine has no catalogue and must not have one (ADR-003), so a reason it
   * writes in words arrives at the operator in the language of whoever typed
   * it, and rewording it changes a value the trail already stored. These three
   * assertions are on the stored VALUE for that reason: they are what would
   * break if a sentence were written back in.
   *
   * `src/i18n/catalogue.test.ts` holds the other half, the one this file cannot
   * reach from inside the boundary: that every code here has words in every
   * catalogue, and that a code without them fails rather than showing raw.
   */
  const suppressed = async (
    gate: Omit<FlowStep, "transition">,
    options: Parameters<typeof ports>[1],
  ) => {
    const trace: Trace = { events: [] };
    const result = await runExecution(
      START,
      registryOf(gatedFlow(gate)),
      ports(trace, options),
    );
    return { result, trace };
  };

  const confirmation: Omit<FlowStep, "transition"> = {
    id: "ask",
    type: "confirm_optin",
    config: { text: "may I?", quick_reply_label: "yes" },
  };
  const collector: Omit<FlowStep, "transition"> = {
    id: "ask",
    type: "collect_email",
    config: { text: "your address?" },
  };
  const follower: Omit<FlowStep, "transition"> = {
    id: "ask",
    type: "follow_gate",
    config: { text: "follow us first" },
  };
  /**
   * The delivery itself, as the gated fixture: the step that hands the
   * material over, with one more send after it (REQ-239, REQ-240).
   *
   * The step AFTER is what makes this the interesting one of the four. The
   * other three suppressions continue the run, and this one must not: the
   * steps after a delivery belong to the run that made it.
   */
  const delivery: Omit<FlowStep, "transition"> = {
    id: "ask",
    type: "send_message",
    config: { text: "the material" },
  };

  it("codes the confirmation it did not ask, and runs the step after it", async () => {
    // REQ-068: the contact is already in a conversation, so the question is a
    // message nobody needed.
    const { result, trace } = await suppressed(confirmation, {
      conversationOpen: true,
    });

    expect(result.steps[0]).toMatchObject({
      stepId: "ask",
      outcome: "suppressed",
      reason: "conversation_already_open",
    });
    // Suppression is not an ending, and nothing was sent in place of the
    // question either.
    expect(result.outcome).toBe("finished");
    expect(trace.events).toEqual(["start:dm:second", "end:dm:second"]);
  });

  it("codes the address it did not ask for", async () => {
    // REQ-024: an address given to any earlier automation counts, so this one
    // asks nothing.
    const { result } = await suppressed(collector, {
      attributes: { [EMAIL_ATTRIBUTE]: "someone@example.com" },
    });

    expect(result.steps[0]).toMatchObject({
      outcome: "suppressed",
      reason: "email_already_known",
    });
  });

  it("codes the follow request it did not make", async () => {
    // REQ-027: what the gate exists to obtain is already true.
    const { result } = await suppressed(follower, {
      followStatus: { kind: "follows" },
    });

    expect(result.steps[0]).toMatchObject({
      outcome: "suppressed",
      reason: "contact_already_follows",
    });
  });

  it("REQ-342: asks to follow with a card button, not a detached quick reply", async () => {
    const sent: OutboundMessage[] = [];

    await runExecution(
      START,
      registryOf(gatedFlow(follower)),
      ports(
        { events: [] },
        {
          followStatus: { kind: "does_not_follow" },
          sent,
        },
      ),
    );

    expect(sent).toEqual([
      {
        text: "follow us first",
        cardButtons: [DEFAULT_WAITING.followButtonLabel],
      },
    ]);
  });

  it("REQ-240: codes the delivery a run that got there first already made", async () => {
    const { result, trace } = await suppressed(delivery, {
      mayDeliver: false,
    });

    expect(result.steps[0]).toMatchObject({
      stepId: "ask",
      outcome: "suppressed",
      reason: "automation_already_delivered",
    });
    // Asked BEFORE anything went out, and nothing went out. A gate consulted
    // after the send would separate nothing: the contact would already have
    // the second copy the rule exists to prevent.
    expect(trace.events).toEqual(["claim"]);
  });

  it("REQ-240: stops the run there, unlike the other three suppressions", async () => {
    // The one guard this whole flag exists for. `gatedFlow` puts a send AFTER
    // the gate, and the other three cases assert it RAN; here it must not,
    // because the run that won the claim is already performing it.
    const { result, trace } = await suppressed(delivery, {
      mayDeliver: false,
    });

    expect(result.steps.map((step) => step.stepId)).toEqual(["ask"]);
    expect(trace.events).not.toContain("start:dm:second");
    // Over, and not broken: the rule the operator switched on worked, so an
    // operator counting failures must not find this among them.
    expect(result.outcome).toBe("finished");
  });

  it("REQ-239: delivers, and carries on, when the gate lets the run through", async () => {
    const { result, trace } = await suppressed(delivery, { mayDeliver: true });

    expect(result.outcome).toBe("finished");
    expect(result.steps.map((step) => step.outcome)).toEqual(["done", "done"]);
    // Asked once PER DELIVERY, and both go out. A flow that hands over more
    // than one thing is ordinary, and the gate has to recognise the run that
    // already took the mark, or the second half would never arrive. That
    // recognition lives in the store (`automation-runs.ts`); what this asserts
    // is that the engine really does ask again, so there is something for it
    // to recognise.
    expect(trace.events).toEqual([
      "claim",
      "start:dm:the material",
      "end:dm:the material",
      "claim",
      "start:dm:second",
      "end:dm:second",
    ]);
  });

  it("REQ-239: delivers with no gate at all, which is the rule switched off", async () => {
    // The default has to be DELIVER, and the asymmetry with the follow gate is
    // deliberate: a shut follow gate costs one message, while a delivery gate
    // shut by an absent port would silently withhold the material of every
    // automation that never asked for the rule.
    const { result, trace } = await suppressed(delivery, {});

    expect(result.outcome).toBe("finished");
    expect(trace.events).not.toContain("claim");
    expect(trace.events).toContain("start:dm:the material");
  });

  it("emits a declared code and nothing that reads as a phrase", async () => {
    const runs = [
      await suppressed(confirmation, { conversationOpen: true }),
      await suppressed(collector, {
        attributes: { [EMAIL_ATTRIBUTE]: "someone@example.com" },
      }),
      await suppressed(follower, { followStatus: { kind: "follows" } }),
      await suppressed(delivery, { mayDeliver: false }),
    ];

    const reasons = runs.map(({ result }) => result.steps[0]?.reason);

    // Guards the guard: one run per suppression path, and a fixture that
    // stopped suppressing would leave this checking a shorter list.
    expect(reasons).toHaveLength(SUPPRESSION_REASONS.length);

    for (const reason of reasons) {
      expect(isSuppressionReason(reason)).toBe(true);
      // What "not a sentence" means at the value level, and the shape the
      // catalogue key is derived from: lower case and underscores, no spaces
      // and no punctuation a language would bring with it.
      expect(reason).toMatch(/^[a-z][a-z_]*$/);
    }
    // Each path answers its own code: three steps collapsing onto one would
    // pass every check above and tell the operator nothing.
    expect(new Set(reasons).size).toBe(reasons.length);
  });
});

describe("REQ-171: a run that fails reports a code, never a sentence", () => {
  /**
   * The other half of the argument the block above makes for suppression, and
   * the one that was missing. A failure was phrased in words here, the trail
   * stored the words, and the panel that shows the recent activity carries only
   * codes (it has to: nothing can translate a phrase an instance wrote). So the
   * phrase was dropped at the last step of the journey and an operator read
   * that an execution failed, with nothing beside it saying why.
   *
   * `src/i18n/catalogue.test.ts` holds the half this file cannot reach from
   * inside the boundary: that every code below has words in every catalogue.
   */
  const noComment: ExecutionStart = {
    flowId: "welcome",
    contactId: "contact-1",
    origin: "direct_message",
  };

  const singleStep = (step: Omit<FlowStep, "transition">): FlowDefinition => ({
    id: "welcome",
    steps: [{ ...step, transition: { kind: "end" } }],
  });

  /** Every failing path this file can drive, each with the code it answers. */
  async function failures(): Promise<readonly ExecutionResult[]> {
    const trace = (): Trace => ({ events: [] });

    return [
      // No definition in force.
      await runExecution(START, registryOf(), ports(trace())),
      // A kind this build cannot perform.
      await runExecution(
        START,
        registryOf(singleStep({ id: "mystery", type: "teleport" })),
        ports(trace()),
      ),
      // A pause that never says how long.
      await runExecution(
        START,
        registryOf(singleStep({ id: "breathe", type: "delay" })),
        ports(trace()),
      ),
      // A confirmation with no button to answer it (REQ-249).
      await runExecution(
        START,
        registryOf(
          singleStep({
            id: "confirm",
            type: "confirm_optin",
            config: { text: "shall I?" },
          }),
        ),
        ports(trace()),
      ),
      // A reply with no comment to reply to.
      await runExecution(
        noComment,
        registryOf(
          singleStep({
            id: "answer",
            type: "reply_comment",
            config: { text: "hi" },
          }),
        ),
        ports(trace()),
      ),
      // A run picked up at a step the definition does not have.
      await runExecution(
        { ...START, resumeAfterStepId: "vanished" },
        registryOf(
          singleStep({
            id: "greet",
            type: "send_message",
            config: { text: "" },
          }),
        ),
        ports(trace()),
      ),
      // A transition that leads nowhere.
      await runExecution(
        START,
        registryOf({
          id: "welcome",
          steps: [
            {
              id: "greet",
              type: "send_message",
              config: { text: "hi" },
              transition: { kind: "goto", stepId: "ghost" },
            },
          ],
        }),
        ports(trace()),
      ),
      // Transitions that never reach an end.
      await runExecution(
        START,
        registryOf({
          id: "welcome",
          steps: [
            {
              id: "a",
              type: "send_message",
              config: { text: "loop" },
              transition: { kind: "goto", stepId: "b" },
            },
            {
              id: "b",
              type: "send_message",
              config: { text: "loop" },
              transition: { kind: "goto", stepId: "a" },
            },
          ],
        }),
        ports(trace()),
      ),
      // Something beyond a port refusing, in its own words.
      await runExecution(
        START,
        registryOf(
          singleStep({
            id: "greet",
            type: "send_message",
            config: { text: "hi" },
          }),
        ),
        ports(trace(), { senderError: "the platform answered 400" }),
      ),
    ];
  }

  /**
   * The one code no run can produce, because it is a disagreement between a run
   * and the flow it is handed, and `runExecution` builds that pairing itself.
   * `purity.test.ts` drives `decideNextStep` directly and covers it.
   */
  const DECIDED_ELSEWHERE: readonly ExecutionFailureReason[] = [
    "execution_belongs_to_another_flow",
  ];

  it("answers a declared code on every failing path", async () => {
    const results = await failures();

    // Guards the guard: a fixture that stopped failing would leave every check
    // below reading an empty list.
    expect(results).not.toHaveLength(0);

    for (const result of results) {
      expect(result.outcome).toBe("failed");
      expect(isExecutionFailureReason(result.reason)).toBe(true);
      // What "not a sentence" means at the value level, and the shape the
      // catalogue key is derived from: lower case and underscores, no spaces
      // and no punctuation a language would bring with it.
      expect(result.reason).toMatch(/^[a-z][a-z_]*$/);
    }
  });

  it("leaves no failure code without a path that produces it", async () => {
    const results = await failures();
    const produced = new Set([
      ...results.map((result) => result.reason),
      ...DECIDED_ELSEWHERE,
    ]);

    // Totality, both ways. A code added to the engine with nothing exercising
    // it is a sentence in two catalogues nobody will ever read, and a path that
    // stopped answering its own code would collapse into another one's.
    expect([...produced].sort()).toEqual([...EXECUTION_FAILURE_REASONS].sort());
  });

  it("keeps what somebody else said out of the code and beside it", async () => {
    const trace: Trace = { events: [] };
    const refusal = "the platform answered 400: unsupported media";

    const result = await runExecution(
      START,
      registryOf(
        singleStep({
          id: "greet",
          type: "send_message",
          config: { text: "hi" },
        }),
      ),
      ports(trace, { senderError: refusal }),
    );

    // THE LIMIT OF THE IDEA, written as a test. What comes back through a port
    // is the platform's wording, not this application's, and no catalogue holds
    // it or could. So the reason stays a code the catalogue answers, and the
    // quotation travels beside it, in a field whose whole contract is that it
    // is data: shown, never translated, never made into a label.
    expect(result.reason).toBe("unexpected_error");
    expect(result.detail).toBe(refusal);
    expect(result.steps[0]).toMatchObject({
      outcome: "failed",
      reason: "unexpected_error",
      detail: refusal,
    });
  });
});
