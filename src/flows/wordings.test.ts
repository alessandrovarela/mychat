import { describe, expect, it } from "vitest";
import { runExecution } from "../engine/execute.js";
import type { FlowRegistry } from "../engine/execute.js";
import type { EnginePorts, RandomSource } from "../engine/ports.js";
import { bindActiveAutomation } from "./binding.js";
import {
  AUTOMATION_SCHEMA_VERSION,
  SUPPORTED_AUTOMATION_SCHEMA_VERSIONS,
} from "./schema.js";
import type { ActiveAutomation } from "./schema.js";
import { validateAutomationActivation } from "./validation.js";
import type { ValidationIssue, ValidationResult } from "./validation.js";

/**
 * Proves REQ-125, REQ-126, REQ-127 and REQ-134 against the self-contained
 * aggregate of phase 3k: a step that sends text declares one wording or
 * several, the one that goes out is drawn from an injected source, a step left
 * with none is refused at write time BY NAME, and a step no trigger could ever
 * perform is refused the same way.
 *
 * The anchor is a publication receiving fifty comments carrying the keyword.
 * With one wording the account answers the same sentence fifty times, publicly,
 * one under the other: a reader sees a robot, and the platform's own spam
 * filter sees "the same first message repeated in volume", which is the
 * constraint the specification already records.
 *
 * The whole chain is exercised rather than the engine alone, and that is the
 * point of the file living here: what an operator SAVES is one document, so the
 * claim has to be proved by taking that document through validation, through
 * the binding and into a run, with nothing in between.
 *
 * Version 2 owns its steps. There is no flow to reference, no parameter to
 * declare and no value to bind, so every wording travels as the literal text it
 * will be sent as.
 */

const WORDINGS = [
  "thanks for the comment, look in your messages",
  "just sent it over in a direct message",
  "answered you privately, take a look",
] as const;

const AUTOMATION_ID = "keyword-answer";

type SendingAction = "reply_comment" | "send_dm";

/**
 * One step that sends text, carrying whatever wording is under test.
 *
 * The two shapes are deliberately different documents and not one with a flag:
 * a public reply keeps `text` at the top of the step, while a direct message
 * carries it inside `message`, beside the parts that may be added to it
 * (REQ-229). No `kind` discriminates them any more, and that is what makes the
 * reader of REQ-087/REQ-125/REQ-127 reach ONE field instead of one shape.
 */
function stepDocument(
  text: unknown,
  action: SendingAction,
  id = "answer",
): Record<string, unknown> {
  return action === "reply_comment"
    ? { id, action, text }
    : { id, action, message: { text } };
}

/**
 * A whole automation of one step.
 *
 * Raw and unvalidated on purpose: what REQ-127 refuses is a document, and a
 * pre-built `ActiveAutomation` would be one the type system already refused.
 */
function automationDocument(
  text: unknown,
  action: SendingAction = "reply_comment",
): Record<string, unknown> {
  return {
    schema_version: AUTOMATION_SCHEMA_VERSION,
    kind: "automation",
    id: AUTOMATION_ID,
    state: "active",
    // A comment trigger, because a run born from one is the only kind that can
    // reply to a comment at all (REQ-134).
    trigger: {
      type: "comment",
      target: "media-1",
      match: { keywords: ["guide"], mode: "contains" },
    },
    rules: { once_per_contact: true },
    steps: [stepDocument(text, action)],
  };
}

function withSteps(
  steps: readonly Record<string, unknown>[],
  trigger?: Record<string, unknown>,
): Record<string, unknown> {
  return {
    ...automationDocument(WORDINGS[0]),
    steps,
    ...(trigger !== undefined && { trigger }),
  };
}

function rejectionOf<T>(
  result: ValidationResult<T>,
): readonly ValidationIssue[] {
  if (result.ok) {
    throw new Error(
      "expected the definition to be refused, and it was accepted",
    );
  }
  return result.issues;
}

function accepted(document: Record<string, unknown>): ActiveAutomation {
  const result = validateAutomationActivation(document);
  if (!result.ok) {
    throw new Error(
      `expected the automation to be accepted: ${result.issues
        .map((one) => one.message)
        .join("; ")}`,
    );
  }
  return result.value;
}

/**
 * A source the test drives: it answers the numbers given, in that order.
 *
 * It refuses a draw nobody scripted rather than repeating the last number,
 * because a step drawing twice for one send would otherwise look like a pass.
 */
function scriptedRandom(...draws: readonly number[]): RandomSource {
  let taken = 0;
  return {
    next: (): number => {
      const drawn = draws[taken];
      taken += 1;
      if (drawn === undefined) {
        throw new Error(
          `the run drew ${String(taken)} times, and the test scripted ${String(draws.length)}`,
        );
      }
      return drawn;
    },
  };
}

/** A source that must never be consulted at all. */
const REFUSING_RANDOM: RandomSource = {
  next: (): number => {
    throw new Error("a step declaring a single wording must not draw");
  },
};

function portsCollecting(sent: string[], random: RandomSource): EnginePorts {
  return {
    clock: { now: (): Date => new Date("2026-08-03T12:00:00.000Z") },
    contacts: {
      getAttributes: () => Promise.resolve({}),
      setAttribute: () => Promise.resolve(),
    },
    sender: {
      sendDirectMessage: (_contactId, message) => {
        sent.push(message.text);
        return Promise.resolve();
      },
      replyToComment: (_commentId, message) => {
        sent.push(message.text);
        return Promise.resolve();
      },
    },
    assets: { publicUrl: (name) => Promise.resolve(`https://assets/${name}`) },
    random,
    waiting: { hours: 24, questions: 3, followButtonLabel: "I followed" },
    suspender: {
      suspend: () => Promise.reject(new Error("no wait is expected here")),
      isConversationOpen: () => Promise.resolve(false),
    },
  };
}

/** Validation, binding and one run: what the operator's document actually does. */
async function sentBy(
  document: Record<string, unknown>,
  random: RandomSource,
): Promise<readonly string[]> {
  const bound = bindActiveAutomation(accepted(document));

  if (!bound.ok) {
    throw new Error(
      `expected the automation to bind: ${bound.issues
        .map((one) => one.detail)
        .join("; ")}`,
    );
  }

  const registry: FlowRegistry = {
    current: (flowId) =>
      flowId === bound.definition.id ? bound.definition : undefined,
  };
  const sent: string[] = [];
  const result = await runExecution(
    {
      flowId: bound.definition.id,
      contactId: "contact-1",
      origin: "comment",
      commentId: "comment-1",
    },
    registry,
    portsCollecting(sent, random),
  );

  expect(result.outcome).toBe("finished");
  return sent;
}

describe("REQ-125: a step accepts one wording or a list of them", () => {
  it("keeps a definition written with a single wording valid, unrewritten", () => {
    const document = automationDocument(WORDINGS[0]);
    const result = validateAutomationActivation(document);

    expect(result.ok).toBe(true);
    // No normalisation of what the document SAYS: a single wording stays a
    // single wording and is never rewritten into a list, which is the whole of
    // REQ-125. What reading does add is a DECLARED DEFAULT the contract owns
    // (REQ-277's `first_reply_delay_seconds`, absent here and therefore 5).
    //
    // The two are not the same thing, and the difference is what the comment
    // this replaces was actually protecting: a stored aggregate written before
    // that rule existed still READS, in memory, with the default filled in.
    // Nothing in the database has to be touched before it can be read, which is
    // the cost the old wording feared. Rewriting the contact's own words would
    // be a different matter, and that is what the assertion below still holds.
    expect(result.ok && result.value).toStrictEqual({
      ...document,
      // Written out rather than spread from the document: `automationDocument`
      // answers `Record<string, unknown>`, so its `rules` is not an object as
      // far as the compiler is concerned, and the fixture declares exactly this.
      rules: { once_per_contact: true, first_reply_delay_seconds: 5 },
    });
    expect(result.ok && result.value.steps).toStrictEqual(document.steps);
    expect(result.ok && result.value.schema_version).toBe(
      AUTOMATION_SCHEMA_VERSION,
    );
    expect(SUPPORTED_AUTOMATION_SCHEMA_VERSIONS).toStrictEqual([2]);
  });

  it("carries a single wording to the engine as a plain string", () => {
    const bound = bindActiveAutomation(
      accepted(automationDocument(WORDINGS[0])),
    );

    // Not normalised into a list of one on the way through. That is what keeps
    // the two shapes one feature: nothing downstream has to know whether the
    // operator declared alternatives or not.
    expect(bound.ok && bound.definition.steps[0]?.config?.["text"]).toBe(
      WORDINGS[0],
    );
  });

  it("executes a single-wording step without drawing at all", async () => {
    // The source refuses to answer, so this passes only if nothing asked it.
    expect(
      await sentBy(automationDocument(WORDINGS[0]), REFUSING_RANDOM),
    ).toStrictEqual([WORDINGS[0]]);
    expect(
      await sentBy(automationDocument(WORDINGS[0], "send_dm"), REFUSING_RANDOM),
    ).toStrictEqual([WORDINGS[0]]);
  });

  it("accepts a list of wordings on both steps that send text", () => {
    expect(
      validateAutomationActivation(automationDocument([...WORDINGS])).ok,
    ).toBe(true);
    expect(
      validateAutomationActivation(automationDocument([...WORDINGS], "send_dm"))
        .ok,
    ).toBe(true);
  });

  it("carries every declared wording to the engine, and in order", () => {
    // Every wording, not only the one that happens to be first: a list that
    // arrived truncated would still send something plausible on every run, and
    // the alternatives the operator wrote would simply never go out.
    const publicReply = bindActiveAutomation(
      accepted(automationDocument([...WORDINGS])),
    );
    expect(
      publicReply.ok && publicReply.definition.steps[0]?.config?.["text"],
    ).toStrictEqual([...WORDINGS]);

    // The private message keeps its wordings one level down, inside `message`,
    // and the binding has to reach them there or the draw has nothing to draw
    // between.
    const privateMessage = bindActiveAutomation(
      accepted(automationDocument([...WORDINGS], "send_dm")),
    );
    expect(
      privateMessage.ok && privateMessage.definition.steps[0]?.config?.["text"],
    ).toStrictEqual([...WORDINGS]);
  });
});

describe("REQ-126: the wording that goes out is drawn from an injected source", () => {
  it("sends the wording the injected source chose, and no other", async () => {
    // Three wordings, so the source's answer maps to thirds: 0.5 lands in the
    // second. The assertion is on WHICH sentence arrived, which is only
    // possible because the draw enters through a port.
    expect(
      await sentBy(automationDocument([...WORDINGS]), scriptedRandom(0.5)),
    ).toStrictEqual([WORDINGS[1]]);
    expect(
      await sentBy(
        automationDocument([...WORDINGS], "send_dm"),
        scriptedRandom(0.9),
      ),
    ).toStrictEqual([WORDINGS[2]]);
    expect(
      await sentBy(automationDocument([...WORDINGS]), scriptedRandom(0)),
    ).toStrictEqual([WORDINGS[0]]);
  });

  it("reaches every declared wording as the source sweeps its range", async () => {
    const seen: string[] = [];

    for (let step = 0; step < 20; step += 1) {
      const [only] = await sentBy(
        automationDocument([...WORDINGS]),
        scriptedRandom(step / 20),
      );
      if (only !== undefined) seen.push(only);
    }

    // Each of the three, not merely "more than one": a draw that could never
    // produce the last wording would still look varied on the publication and
    // would still be wrong, and the operator who wrote it would never know.
    for (const wording of WORDINGS) {
      expect(seen, `wording "${wording}" was never drawn`).toContain(wording);
    }
    expect(new Set(seen)).toStrictEqual(new Set(WORDINGS));
  });

  it("draws once per send, and repeating a wording is not an error", async () => {
    // Simple drawing, decided rather than settled for: no rotation, no memory
    // of what went out last. Two runs in a row may repeat, and that is fine.
    const first = await sentBy(
      automationDocument([...WORDINGS]),
      scriptedRandom(0.1),
    );
    const again = await sentBy(
      automationDocument([...WORDINGS]),
      scriptedRandom(0.2),
    );

    expect(first).toStrictEqual(again);
    expect(first).toStrictEqual([WORDINGS[0]]);
  });

  it("sends a declared wording whatever the source answers", async () => {
    // A source is outside code: one answering exactly 1, a negative, or
    // something that is not a number would index past the end and deliver an
    // empty message to a contact. The arithmetic belongs to the engine, so the
    // edge does too.
    for (const answer of [1, -0.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const sent = await sentBy(
        automationDocument([...WORDINGS]),
        scriptedRandom(answer),
      );

      expect(sent).toHaveLength(1);
      expect(WORDINGS as readonly string[]).toContain(sent[0]);
    }
  });
});

describe("REQ-127: a step left with no wording is refused, by name", () => {
  it("refuses a comment reply whose list of wordings is empty, naming the step", () => {
    const issues = rejectionOf(
      validateAutomationActivation(automationDocument([])),
    );

    expect(issues.map((one) => one.code)).toStrictEqual([
      "step_without_wording",
    ]);
    // The step's ID, not its index: the editor removes wordings one at a time
    // from a screen that shows step names, and a path like "steps[0].text"
    // would send the operator counting rows.
    expect(issues[0]?.message).toContain('"answer"');
    expect(issues[0]?.path).toBe("steps[0].text");
  });

  it("names the offending step among several, and every one of them", () => {
    const document = withSteps([
      stepDocument(WORDINGS[0], "send_dm", "greet"),
      stepDocument([], "reply_comment", "answer"),
      stepDocument([], "reply_comment", "follow-up"),
    ]);

    const issues = rejectionOf(validateAutomationActivation(document));

    // Both, because an operator who fixes the one step we chose to mention
    // would only meet the next on the following save.
    expect(issues.map((one) => one.code)).toStrictEqual([
      "step_without_wording",
      "step_without_wording",
    ]);
    expect(issues[0]?.message).toContain('"answer"');
    expect(issues[1]?.message).toContain('"follow-up"');
  });

  it("accepts a list holding a single wording", () => {
    // The shape the editor writes when the operator removed all but one, and
    // the state it must be able to save from.
    expect(
      validateAutomationActivation(automationDocument([WORDINGS[0]])).ok,
    ).toBe(true);
    expect(
      validateAutomationActivation(automationDocument([WORDINGS[0]], "send_dm"))
        .ok,
    ).toBe(true);
  });

  it("still refuses an empty string inside the list, on both steps", () => {
    // A wording that exists and says nothing is not a wording. Caught by the
    // shape layer, which is where a per-item rule belongs, and it has to reach
    // inside `message` for the private one or the empty sentence goes out.
    expect(
      rejectionOf(
        validateAutomationActivation(automationDocument([WORDINGS[0], ""])),
      ).map((one) => one.code),
    ).toStrictEqual(["invalid_shape"]);

    const privateIssues = rejectionOf(
      validateAutomationActivation(
        automationDocument([WORDINGS[0], ""], "send_dm"),
      ),
    );
    expect(privateIssues.map((one) => one.code)).toStrictEqual([
      "invalid_shape",
    ]);
    expect(privateIssues[0]?.path).toBe("steps[0].message.text[1]");
  });
});

/**
 * REQ-134, and only the half that still exists.
 *
 * The requirement was written against version 1 and has two halves in two
 * layers: the SAVE refuses the incompatible combination naming the step, and
 * the form's list of FLOWS does not offer a flow the chosen trigger could not
 * run. Phase 3k removed the second half's subject rather than its rule — an
 * automation owns its steps, there is no flow catalogue and no flow list to
 * filter (REQ-216, proved by `src/web/screens/flows.test.tsx`). What is left of
 * that half is the editor not OFFERING the public reply under a direct-message
 * trigger, which lives in `src/web/screens/automation-form.tsx` and is a screen
 * concern, not this file's.
 *
 * The half proved here is the one that still guards a stored document, and it
 * changed shape with the contract: the refusal now reads the automation's OWN
 * steps against its OWN trigger, with no reference to resolve first.
 */
describe("REQ-134: a step the trigger could never perform is refused, by name", () => {
  const DIRECT_MESSAGE_TRIGGER = {
    type: "direct_message",
    match: { keywords: ["guide"], mode: "contains" },
  };

  it("refuses a direct-message automation that replies to a comment, naming the step", () => {
    const issues = rejectionOf(
      validateAutomationActivation(
        withSteps(
          [stepDocument([...WORDINGS], "reply_comment", "answer")],
          DIRECT_MESSAGE_TRIGGER,
        ),
      ),
    );

    expect(issues.map((one) => one.code)).toStrictEqual([
      "flow_trigger_incompatible",
    ]);
    // By name, for the same reason REQ-127 asks for it: there is no comment to
    // answer in a direct-message run, and the operator has to be told WHICH
    // step is the one to remove.
    expect(issues[0]?.message).toContain('"answer"');
    expect(issues[0]?.path).toBe("steps[0].action");
  });

  it("names every offending step, not only the first", () => {
    const issues = rejectionOf(
      validateAutomationActivation(
        withSteps(
          [
            stepDocument(WORDINGS[0], "send_dm", "greet"),
            stepDocument(WORDINGS[1], "reply_comment", "answer"),
            stepDocument(WORDINGS[2], "reply_comment", "follow-up"),
          ],
          DIRECT_MESSAGE_TRIGGER,
        ),
      ),
    );

    expect(issues.map((one) => one.code)).toStrictEqual([
      "flow_trigger_incompatible",
      "flow_trigger_incompatible",
    ]);
    expect(issues[0]?.message).toContain('"answer"');
    expect(issues[1]?.message).toContain('"follow-up"');
  });

  it("accepts a direct message sent from a comment, because that direction works", () => {
    // The opposite direction is NOT symmetrical and must not be refused: the
    // seven-day private-reply window is exactly what lets a comment produce a
    // direct message, which is the anchor case of the whole product.
    expect(
      validateAutomationActivation(automationDocument([...WORDINGS], "send_dm"))
        .ok,
    ).toBe(true);
    // And a direct-message automation that only sends a direct message is fine.
    expect(
      validateAutomationActivation(
        withSteps(
          [stepDocument([...WORDINGS], "send_dm", "answer")],
          DIRECT_MESSAGE_TRIGGER,
        ),
      ).ok,
    ).toBe(true);
  });
});
