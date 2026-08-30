import { decideNextStep } from "./decide.js";
import type {
  ExecutionState,
  FlowDefinition,
  FlowStep,
  StepCard,
  StepCardButton,
  StepConfigValue,
  StepId,
} from "./flow.js";
import { EMAIL_ATTRIBUTE } from "./ports.js";
import type {
  EnginePorts,
  FollowStatus,
  OutboundCardButton,
  OutboundMessage,
} from "./ports.js";

/**
 * The executing half of the state machine. `decideNextStep` says what should
 * happen; this drives the loop and makes it happen through the injected ports
 * (ADR-003) — no transport, no store, no platform SDK anywhere in here.
 *
 * Two guarantees shape the design:
 *
 * - **Steps run strictly one at a time** (REQ-009). Each step is awaited to
 *   completion before the next is decided, so a slow send can never overlap
 *   the step that follows it. This is not an optimisation to revisit later:
 *   a flow whose steps interleave would deliver a link before the question
 *   that asks for consent.
 * - **A run holds the definition it started with** (REQ-011, REQ-060). The
 *   definition is captured once, at start, and never re-read. Editing a flow
 *   mid-run must not switch the engine to new steps halfway through, which
 *   would leave the contact in a conversation that belongs to neither version.
 */

/** Where the engine gets the definition in force when a run BEGINS. */
export interface FlowRegistry {
  /** The current definition, or `undefined` if the flow is unknown/withdrawn. */
  current(flowId: string): FlowDefinition | undefined;
}

/**
 * Why a step was deliberately not performed (REQ-068), as a stable code
 * (REQ-163).
 *
 * The engine cannot read the catalogue (ADR-003), so a reason it writes in
 * words is a reason nobody downstream can translate: it reaches the operator in
 * whatever language the person who typed it happened to think in, and rewording
 * it later silently changes a value the trail already stored. What travels is
 * the CODE; the words are picked where the catalogue is readable, from the key
 * `src/i18n/engine-reasons.ts` derives. That is the shape `matchAutomation`
 * already gives its refusals, and this is the module that did not.
 *
 * A BARE code here, rather than the JSON envelope `encodeNoMatch` writes into
 * the same trail field, and the difference is what each one has to carry. That
 * envelope exists because a list of refusals with a count on each has to fit in
 * one string; a suppression is one code with no number beside it, so a
 * container would carry nothing and would make an in-memory field, which
 * `ExecutedStep` also is, hold a serialised blob.
 *
 * The reader still tells the cases apart with certainty and with no guess at a
 * prefix, because both tests are total: `JSON.parse` refuses a bare code
 * outright, and this list is closed, so membership answers exactly. No free
 * sentence and no JSON document is a member of it.
 */
export const SUPPRESSION_REASONS = [
  /** The contact wrote recently, so there was no closed conversation to open. */
  "conversation_already_open",
  /** An address is already stored for this contact, from any earlier run. */
  "email_already_known",
  /** The gate had nothing to ask for: the contact already follows. */
  "contact_already_follows",
  /**
   * Another run of this automation has already delivered to this contact, so
   * this one hands nothing over and ends there (REQ-239, REQ-240).
   */
  "automation_already_delivered",
] as const;

export type SuppressionReason = (typeof SUPPRESSION_REASONS)[number];

/** Whether a reason read back from the trail is one of the declared codes. */
export function isSuppressionReason(
  value: unknown,
): value is SuppressionReason {
  return (SUPPRESSION_REASONS as readonly unknown[]).includes(value);
}

/**
 * Why a run, or one step of it, FAILED, as a stable code (REQ-171).
 *
 * The same argument as the suppression list above, applied to the other half of
 * what the trail records. A failure used to be written here in words, and the
 * words then had nowhere to go: the panel's recent activity carries codes
 * because only a code can be translated (REQ-074), so it dropped the sentence
 * and the operator read that an execution failed with no reason beside it. That
 * is the one line on the panel someone opens the panel FOR.
 *
 * Every code below stands for a condition this module can name on its own,
 * which is what makes the list closed. Where a name is not enough (which flow,
 * which step, what the platform answered), the identifier or the quotation
 * travels BESIDE the code, in `detail`, and never inside it.
 *
 * The last one is the honest boundary of the idea. A step calls out through the
 * ports, and what comes back from the other side of a port is not this module's
 * vocabulary: the platform's refusal, an adapter's bug, a driver's error. That
 * cannot become a code without inventing one per sentence somebody else writes,
 * so it becomes ONE code plus the text exactly as it arrived. The screen shows
 * that text as DATA, quoted, the way it shows what a contact wrote (REQ-162),
 * and never as a label: nothing translates it, and nothing pretends to.
 */
export const EXECUTION_FAILURE_REASONS = [
  /** No definition in force for this flow, or one the guard rejected. */
  "flow_not_runnable",
  /** The run was started against a flow other than the one it belongs to. */
  "execution_belongs_to_another_flow",
  /** The step the run stopped at is not in the definition it is running. */
  "current_step_not_declared",
  /** A transition points at a step the definition does not declare. */
  "transition_target_not_declared",
  /** The transitions never reach an end, so the run was stopped instead. */
  "transitions_form_a_cycle",
  /** A step kind this build cannot perform, which the validator should catch. */
  "step_type_unsupported",
  /** A pause that never says how long it lasts, which is no pause at all. */
  "pause_without_duration",
  /** A confirmation with no button: the answer it waits for cannot be given. */
  "confirmation_without_button",
  /** A comment reply on a run that did not come from a comment. */
  "comment_reply_without_comment",
  /** Something beyond a port threw. What it said travels in `detail`. */
  "unexpected_error",
] as const;

export type ExecutionFailureReason = (typeof EXECUTION_FAILURE_REASONS)[number];

/**
 * The one code that carries somebody else's words, named rather than written
 * twice: the trail writer falls back to it, and a rename has to break both
 * sites at once or the fallback stops meaning what it says.
 */
export const UNEXPECTED_FAILURE: ExecutionFailureReason = "unexpected_error";

/** Whether a failure read back from the trail is one of the declared codes. */
export function isExecutionFailureReason(
  value: unknown,
): value is ExecutionFailureReason {
  return (EXECUTION_FAILURE_REASONS as readonly unknown[]).includes(value);
}

/**
 * Why an action on the trail did what it did: it was deliberately not performed,
 * or it failed. One type because it is one column, and whoever reads that column
 * gets exactly one of these two vocabularies or nothing at all.
 */
export type ActionReason = SuppressionReason | ExecutionFailureReason;

/** Whether a value is a code some catalogue can be asked to translate. */
export function isActionReason(value: unknown): value is ActionReason {
  return isSuppressionReason(value) || isExecutionFailureReason(value);
}

/** What a step did, in the order it happened. The audit trail reads this. */
export interface ExecutedStep {
  readonly stepId: string;
  readonly type: string;
  readonly startedAt: Date;
  readonly finishedAt: Date;
  /**
   * `suspended` ends this pass without ending the run: the flow is waiting for
   * the contact, and the steps after it have not been skipped, only postponed.
   * `suppressed` means the step was deliberately not performed (REQ-068) and
   * the run continued, which an operator must be able to tell from a failure.
   */
  readonly outcome: "done" | "failed" | "suspended" | "suppressed";
  /**
   * A code on a `suppressed` step (`SUPPRESSION_REASONS`) and on a `failed` one
   * (`EXECUTION_FAILURE_REASONS`), never a sentence (REQ-163, REQ-171), and
   * `StepOutcome` below is where the compiler holds both.
   *
   * It stays a plain string here because `suspended` reports something that is
   * not an enumerable set at all: what the platform said about a query that
   * could not be made, on a step that nevertheless did what it was told.
   */
  readonly reason?: string;
  /**
   * The datum the code cannot carry: which step, which target, or the words
   * something beyond a port used to refuse. Never a reason on its own, and
   * never translated by anybody: absent code means absent detail (REQ-171).
   */
  readonly detail?: string;
}

export interface ExecutionResult {
  readonly flowId: string;
  readonly contactId: string;
  /** Every step that ran, in execution order. Empty for a flow with no steps. */
  readonly steps: readonly ExecutedStep[];
  readonly outcome: "finished" | "failed" | "suspended";
  /**
   * Why the run failed, as a code (REQ-171). Narrow here, where every producer
   * is in this file, which is what makes a code renamed or withdrawn stop the
   * build instead of quietly becoming a value no catalogue answers.
   */
  readonly reason?: ExecutionFailureReason;
  /** What the code cannot carry, exactly as `ExecutedStep.detail` holds it. */
  readonly detail?: string;
}

export interface ExecutionStart {
  readonly flowId: string;
  readonly contactId: string;
  /**
   * Where the run came from. The engine only records it; choosing a delivery
   * window from it is REQ-080, in Phase 1b.
   */
  readonly origin: "comment" | "direct_message";
  /** The comment being answered, when the run came from one. */
  readonly commentId?: string;
  /**
   * Where a resumed run picks up: the step it was suspended AT. The run
   * continues at the one after it (REQ-067). Absent on a fresh run.
   */
  readonly resumeAfterStepId?: StepId;
}

/** Guards against a malformed definition reaching the loop (REQ-012). */
function isRunnable(flow: FlowDefinition | undefined): flow is FlowDefinition {
  return (
    flow !== undefined &&
    Array.isArray(flow.steps) &&
    flow.steps.every(
      (step) => typeof step?.id === "string" && typeof step?.type === "string",
    )
  );
}

/**
 * Runs one execution to completion.
 *
 * The definition is resolved ONCE here and passed down by value. Everything
 * after this line works on that snapshot, which is what makes REQ-060 true by
 * construction rather than by discipline.
 */
export async function runExecution(
  start: ExecutionStart,
  registry: FlowRegistry,
  ports: EnginePorts,
): Promise<ExecutionResult> {
  const flow = registry.current(start.flowId);

  if (!isRunnable(flow)) {
    // A rejected or missing definition must not produce a half-run: no step
    // fires, so the contact sees nothing at all (REQ-012).
    return {
      flowId: start.flowId,
      contactId: start.contactId,
      steps: [],
      outcome: "failed",
      reason: "flow_not_runnable",
      // The identifier beside the code, and not inside it: the operator needs
      // to know WHICH flow, and a code that named one would be a code per flow.
      detail: start.flowId,
    };
  }

  const executed: ExecutedStep[] = [];
  let state: ExecutionState = {
    flowId: flow.id,
    contactId: start.contactId,
    // A resumed run starts as if it had just finished the step it waited at,
    // so the ordinary transition logic carries it to the next one. No second
    // code path, and therefore no second set of rules to keep in step.
    currentStepId: start.resumeAfterStepId ?? null,
  };

  // Bounded by the step count: a flow whose transitions form a cycle must stop
  // rather than spin forever holding the process.
  const budget = flow.steps.length + 1;

  for (let taken = 0; taken < budget; taken += 1) {
    const attributes = await ports.contacts.getAttributes(start.contactId);
    const decision = decideNextStep(
      { flow, execution: state, attributes },
      ports.clock,
    );

    if (decision.kind === "finished") {
      return {
        flowId: flow.id,
        contactId: start.contactId,
        steps: executed,
        outcome: "finished",
      };
    }

    if (decision.kind === "failed") {
      return {
        flowId: flow.id,
        contactId: start.contactId,
        steps: executed,
        outcome: "failed",
        reason: decision.reason,
        ...(decision.detail !== undefined && { detail: decision.detail }),
      };
    }

    // Awaited before the loop turns: this is REQ-009, and it is the only thing
    // enforcing it.
    const { record, ends } = await runStep(decision.step, start, ports);
    executed.push(record);

    if (ends) {
      // Over, and NOT a failure (REQ-240): the rule the operator switched on
      // worked, and the only thing that happened is that another run got there
      // first. Recorded as `finished` for the same reason the step's row is a
      // suppression rather than an error: an operator counting failures must
      // not find this among them.
      return {
        flowId: flow.id,
        contactId: start.contactId,
        steps: executed,
        outcome: "finished",
      };
    }

    if (record.outcome === "failed") {
      return {
        flowId: flow.id,
        contactId: start.contactId,
        steps: executed,
        outcome: "failed",
        // Asked of the value rather than trusted from the type: `ExecutedStep`
        // widens the reason to a string, because a suspension keeps a sentence
        // there, and the run's own reason must not inherit that width. Every
        // failed record this loop can see was built below, from `StepOutcome`
        // or from the catch, so both already carry a code.
        ...(isExecutionFailureReason(record.reason) && {
          reason: record.reason,
        }),
        ...(record.detail !== undefined && { detail: record.detail }),
      };
    }

    if (record.outcome === "suspended") {
      // Not an ending: the run is waiting for the contact, and whatever wakes
      // it starts a new pass with `resumeAfterStepId` set to this step.
      return {
        flowId: flow.id,
        contactId: start.contactId,
        steps: executed,
        outcome: "suspended",
      };
    }

    state = { ...state, currentStepId: decision.step.id };
  }

  return {
    flowId: flow.id,
    contactId: start.contactId,
    steps: executed,
    outcome: "failed",
    reason: "transitions_form_a_cycle",
    detail: flow.id,
  };
}

function text(step: FlowStep, key: string): string {
  const value: StepConfigValue | undefined = step.config?.[key];
  return typeof value === "string" ? value : "";
}

/**
 * Several wordings, rather than one value (REQ-125).
 *
 * Hand written rather than `Array.isArray` at the call sites: the built-in
 * guard answers `any[]`, which does not narrow a READONLY array out of a union,
 * so the compiler would keep the list in the scalar branch below and the type
 * would say nothing true.
 */
function isWordingList(
  value: StepConfigValue | undefined,
): value is readonly string[] {
  return Array.isArray(value);
}

function card(step: FlowStep): StepCard | undefined {
  const value = step.config?.["card"];
  return value !== null && typeof value === "object" && !isWordingList(value)
    ? value
    : undefined;
}

/**
 * The PURE LINKS this step declares, in the order they were declared
 * (REQ-286, REQ-288).
 *
 * Addresses and nothing else: no id, no label, no wrapper. Each one becomes a
 * message of its own below, and the array's order is delivery order — never
 * sorted, never deduplicated. A step that declares none has none; a value that
 * is not a list is not a declaration this key can carry.
 */
function pureLinks(step: FlowStep): readonly string[] {
  const value: StepConfigValue | undefined = step.config?.["links"];
  return isWordingList(value) ? value : [];
}

/** Every wording a step declares for a field, single or several (REQ-125). */
function wordings(step: FlowStep, key: string): readonly string[] {
  const value: StepConfigValue | undefined = step.config?.[key];

  if (typeof value === "string") {
    return [value];
  }

  return isWordingList(value) ? value : [];
}

/**
 * Draws the wording this run sends (REQ-125, REQ-126).
 *
 * A SIMPLE draw, over all of them, every time. Not a rotation and not "the one
 * used least": the run holds no memory of what earlier runs sent, and inventing
 * one would mean persisting a counter per step per automation to avoid a
 * repetition nobody sees. Two runs in a row drawing the same sentence is
 * acceptable; fifty runs sending the same sentence, one under the other on a
 * publication, is what this exists to stop.
 *
 * One wording is not a draw, and the source is not touched for it. That is what
 * keeps a definition written before this feature behaving to the letter as it
 * did: same wording out, same number of calls to anything.
 */
function drawWording(step: FlowStep, key: string, ports: EnginePorts): string {
  const declared = wordings(step, key);
  const [first] = declared;

  if (first === undefined) {
    return "";
  }
  if (declared.length === 1) {
    return first;
  }

  // Bounded rather than trusted. A source answering exactly 1, or something
  // that is not a number at all, would otherwise index past the end and send
  // an empty message: the arithmetic is the engine's, so the edge is too.
  const drawn = ports.random.next();
  const index = Number.isFinite(drawn)
    ? Math.floor(drawn * declared.length)
    : 0;
  const bounded = Math.min(declared.length - 1, Math.max(0, index));

  return declared[bounded] ?? first;
}

/**
 * Builds what one delivery step SENDS, resolving the resource AT SEND TIME
 * (REQ-020).
 *
 * A LIST, and the length is the whole of task 3k.17 (REQ-231). A delivery that
 * says something AND attaches something is two messages, in that order: what
 * the operator wrote first, the file after it. The platform constraint behind
 * that split is recorded in `docs/platform-limits.md`.
 *
 * The order is decided HERE rather than in the adapter, and the reason is the
 * queue between them. The `Sender` port is an enqueue (`src/runtime/outbox.ts`),
 * so one call is one durable row: one row per message keeps the retry, the
 * quota class and the private-reply accounting of REQ-097 honest. The
 * platform observation behind the private-reply path is in
 * `docs/platform-limits.md`.
 *
 * The ORDER is written once, in `directMessageContentSchema`, and this is
 * where it happens: the card or the text first, then each pure link in the
 * order it was declared (REQ-286, REQ-288). One list, built top to bottom, so
 * the order is the code's shape rather than a sort applied to it afterwards.
 *
 * The asset NAME travels through the definition and becomes a URL only here,
 * in the instant before the message leaves — the card's cover, and since
 * REQ-285 the destination of a button that opens a file. Resolving at load
 * time would deliver a URL that has since expired, which is precisely how
 * platform media links behave.
 *
 * The button label arrives already resolved by the binding, catalogue default
 * included: the engine must not read files, and a default label is text in the
 * operator's language.
 *
 * The wording is DRAWN here too (REQ-126), and drawn once: the same sentence
 * that goes out is the one the trail records.
 */
async function buildDeliveries(
  step: FlowStep,
  ports: EnginePorts,
): Promise<readonly OutboundMessage[]> {
  const wording = drawWording(step, "text", ports);
  const declaredCard = card(step);
  const resource = await resolveResource(step, ports);
  const messages: OutboundMessage[] = [];

  if (declaredCard !== undefined) {
    const imageUrl =
      declaredCard.image === undefined
        ? undefined
        : await ports.assets.publicUrl(declaredCard.image);
    const buttons = await resolveButtons(declaredCard.buttons, ports);
    /*
     * The drawn wording becomes the card's title when the card declares none
     * (REQ-230).
     *
     * It cannot be decided earlier: the wording is DRAWN here, one of several,
     * so a binding that had written it into the title would have frozen one
     * sentence for every run. And it must be decided somewhere, because a card
     * with no title travels with a zero-width space in its place — which is how
     * a message with a link used to lose the text the operator wrote.
     */
    const title = declaredCard.title ?? (wording === "" ? undefined : wording);
    messages.push({
      text: wording,
      card: {
        ...(imageUrl !== undefined && { imageUrl }),
        ...(title !== undefined && { title }),
        ...(declaredCard.description !== undefined && {
          description: declaredCard.description,
        }),
        buttons,
      },
    });
  } else if (resource.link !== undefined) {
    messages.push({ text: wording, link: resource.link });
  } else if (wording !== "") {
    messages.push({ text: wording });
  }

  if (resource.attachment !== undefined) {
    // SECOND, always, and never merged into the one above. The text field is
    // empty because the platform refuses to carry one here; what the operator
    // wrote already left in the message before it.
    messages.push({ text: "", attachment: resource.attachment });
  }

  /*
   * Each pure link AFTER the card or the text, in the order it was declared
   * (REQ-286, REQ-288).
   *
   * The address travels ALONE, as the whole text of a message of its own. No
   * card, no button, no wrapper around it: what the operator chose this form
   * for is the preview, and the site at the other end is what draws it — from
   * the address it is given. Wrapping it (in a card, or in the `/clicks/<id>`
   * a button's destination becomes) means the preview is never drawn, which is
   * the whole of the form disappearing while the message still arrives.
   *
   * Which is also why nothing is added beside it. A sentence introducing the
   * link would be a second author's words inside a message the operator wrote,
   * and it would push the address out of the position the preview is read from.
   */
  for (const url of pureLinks(step)) {
    messages.push({ text: url });
  }

  // A step that declares nothing still sends, exactly as it did before this
  // split: refusing an empty delivery is validation's job (REQ-229), and the
  // engine must not silently turn a definition it was handed into no message
  // at all.
  return numbered(messages.length === 0 ? [{ text: wording }] : messages);
}

/**
 * Says which message of the delivery each one is (REQ-231, REQ-286).
 *
 * Stamped HERE, on the whole batch at once, because this is the only place
 * that has the batch: `Sender` takes one message at a time, so a receiver
 * downstream sees a stream of sends with no way of telling "the second message
 * of one delivery" from "the first message of the next step". The first is
 * left unstamped, which keeps every single-message delivery byte for byte the
 * message it was before this existed.
 */
function numbered(
  messages: readonly OutboundMessage[],
): readonly OutboundMessage[] {
  return messages.map((message, index) =>
    index === 0 ? message : { ...message, part: index + 1 },
  );
}

/**
 * Every button's destination, resolved in the instant before the send
 * (REQ-285, REQ-020).
 *
 * A button opens an ADDRESS or a FILE, and only the file needs resolving: the
 * asset name becomes a URL of our own CDN here, through the same port the
 * card's cover already goes through, and a name that no longer exists throws
 * exactly as a missing cover does. That is the reason the name travels through
 * the definition instead of the URL — a resource deleted after the automation
 * was written fails loudly at the send, instead of reaching the contact as a
 * button that opens nothing.
 *
 * Sequential and not `Promise.all`, for the reason the sends are: what comes
 * back is a LIST whose order is the order of the card, and a step is one thing
 * happening at a time (REQ-009).
 */
async function resolveButtons(
  buttons: readonly StepCardButton[],
  ports: EnginePorts,
): Promise<readonly OutboundCardButton[]> {
  const resolved: OutboundCardButton[] = [];

  for (const button of buttons) {
    resolved.push({
      id: button.id,
      label: button.label,
      url:
        "asset" in button
          ? await ports.assets.publicUrl(button.asset)
          : button.url,
    });
  }

  return resolved;
}

/**
 * The declared resource, resolved to a URL in the instant before the send.
 *
 * Split out of `buildDeliveries` so a card can carry one too: the resolution is
 * the same either way, and the difference is only whether there is a card
 * beside it.
 */
async function resolveResource(
  step: FlowStep,
  ports: EnginePorts,
): Promise<Pick<OutboundMessage, "link" | "attachment">> {
  const asset = text(step, "asset");
  const delivery = text(step, "delivery");

  if (asset === "" || delivery === "" || delivery === "text") {
    return {};
  }

  const url = await ports.assets.publicUrl(asset);

  if (delivery === "link") {
    return { link: { url, label: text(step, "button_label") } };
  }

  /*
   * What the attachment IS, read from the definition and never inferred
   * (REQ-231). The binding writes it from the declared `kind`; a step that
   * carries none is a document, which is what every attachment was before the
   * kind existed and is the safer of the two to be wrong about — a PDF sent as
   * an image is refused by the platform, an image sent as a file still arrives.
   */
  return {
    attachment: {
      url,
      kind: text(step, "asset_kind") === "image" ? "image" : "document",
    },
  };
}

/**
 * The declared pause, in seconds (REQ-098).
 *
 * Absent, not a number, or not positive all read the same way: this step
 * declares no pause. It is answered where it is read, and loudly, rather than
 * turned into a zero here.
 */
function pauseSeconds(step: FlowStep): number | undefined {
  const value: StepConfigValue | undefined = step.config?.["seconds"];
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : undefined;
}

const HOUR_MS = 60 * 60 * 1000;

/**
 * When a wait created NOW comes due (REQ-252, REQ-253).
 *
 * One deadline for the three steps that wait, taken from the instance and not
 * from the step, which stopped declaring one. Computed at the instant the step
 * asks, and that is what makes REQ-253 true without a mechanism of its own: the
 * value is written into the durable record the suspension creates, so an
 * operator who shortens the deadline afterwards decides the next wait and
 * cannot reach into one already counting.
 */
function expiresAt(ports: EnginePorts): Date {
  return new Date(ports.clock.now().getTime() + ports.waiting.hours * HOUR_MS);
}

/**
 * One step's record, and whether the run is over.
 *
 * The second half cannot travel on `ExecutedStep`: that type is what the TRAIL
 * stores, and "the run ended here" is a fact about the loop rather than about
 * the row. Returned beside the record instead, so the loop reads it and
 * nothing downstream has to.
 */
interface StepRun {
  readonly record: ExecutedStep;
  /** True when the step performed says the run stops with it (REQ-240). */
  readonly ends: boolean;
}

async function runStep(
  step: FlowStep,
  start: ExecutionStart,
  ports: EnginePorts,
): Promise<StepRun> {
  const startedAt = ports.clock.now();

  try {
    const outcome = await perform(step, start, ports);

    if (outcome !== undefined) {
      // Narrowed rather than read off the union: only the failed variant
      // declares a detail, and asking the union for one would either not
      // compile or force every variant to carry a field three of them have no
      // use for.
      const detail = outcome.outcome === "failed" ? outcome.detail : undefined;

      return {
        record: {
          stepId: step.id,
          type: step.type,
          startedAt,
          finishedAt: ports.clock.now(),
          outcome: outcome.outcome,
          ...(outcome.reason !== undefined && { reason: outcome.reason }),
          ...(detail !== undefined && { detail }),
        },
        ends: outcome.outcome === "suppressed" && outcome.ends === true,
      };
    }

    return {
      record: {
        stepId: step.id,
        type: step.type,
        startedAt,
        finishedAt: ports.clock.now(),
        outcome: "done",
      },
      ends: false,
    };
  } catch (cause) {
    // A failing step ends the run; it never silently advances to the next one,
    // because the steps after it assume the one before succeeded.
    //
    // The ONE place a throw becomes a record, and therefore the one place the
    // limit of REQ-171 is decided. Everything this module refuses on purpose
    // returns a code above; what reaches here came from the other side of a
    // port, so its words are the platform's or an adapter's and no catalogue
    // has them. The code says what happened, the quotation says what was
    // answered, and the two stay in different fields so nobody mistakes the
    // second for a sentence this application chose.
    return {
      record: {
        stepId: step.id,
        type: step.type,
        startedAt,
        finishedAt: ports.clock.now(),
        outcome: "failed",
        reason: UNEXPECTED_FAILURE,
        detail: cause instanceof Error ? cause.message : String(cause),
      },
      ends: false,
    };
  }
}

/**
 * A step that ended in something other than plain success says so here.
 *
 * Split by outcome so the compiler keeps REQ-163 and REQ-171 where they can be
 * kept: a suppressed step's reason is one of the declared codes, a failed one's
 * is one of the failure codes, and a sentence written back in at any of those
 * sites stops the build instead of reaching a screen in a language the reader
 * may not have.
 *
 * `suspended` keeps a free string on purpose: what it reports is not a closed
 * set, it quotes what the platform said about a query that could not be made,
 * and a code cannot carry that detail. It is also not a failure, so nobody
 * reads it asking why nothing worked.
 *
 * The failed variant exists so that what this module REFUSES stays inside the
 * vocabulary. A malformed step used to be thrown and caught two functions down,
 * where every throw looks alike, and a condition the engine names perfectly
 * well arrived at the trail as an English sentence about it. Refusing by
 * RETURN keeps the naming here; the catch is left for what genuinely comes from
 * outside.
 */
type StepOutcome =
  | { readonly outcome: "suspended"; readonly reason?: string }
  | {
      readonly outcome: "suppressed";
      readonly reason: SuppressionReason;
      /**
       * Whether the RUN is over, and not only this step (REQ-240).
       *
       * Absent on the three suppressions that mean "this step had nothing to
       * do": the contact is already in a conversation, already gave an
       * address, already follows, and each time the run carries straight on to
       * what comes next. Set on the one that means another run has already
       * served this contact, because there the steps AFTER the delivery would
       * repeat what the run that won is doing, and the contact would receive
       * the follow-up of a delivery they never got from here.
       *
       * A flag rather than a fourth `ExecutedStep.outcome`: what the trail has
       * to say is unchanged, this step was deliberately not performed, and the
       * code beside it already says which case it was.
       */
      readonly ends?: true;
    }
  | {
      readonly outcome: "failed";
      readonly reason: ExecutionFailureReason;
      readonly detail?: string;
    };

async function perform(
  step: FlowStep,
  start: ExecutionStart,
  ports: EnginePorts,
): Promise<StepOutcome | undefined> {
  switch (step.type) {
    // `send_dm` is what the binding produces from the declared action;
    // `send_message` is the engine's older name for the same thing, kept
    // because hand-built definitions and the engine's own tests use it.
    case "send_dm":
    case "send_message": {
      // The one step that HANDS SOMETHING OVER, so the one step the
      // once-per-contact rule is about (REQ-239). Asked here and not at the
      // start of the run, which is the whole of the change: a run that asks a
      // question and is never answered gave the contact nothing, and must not
      // have spent their one chance at this automation.
      //
      // The three steps that suspend also send, and none of them asks: what
      // they put on the wire is a question, and the public reply under the
      // comment is a signpost to the conversation. Counting either of them
      // would close the automation to a contact who was only ever asked.
      //
      // Before the first send and not after: this is also where two events
      // arriving together are separated (REQ-240), and a gate consulted after
      // the queue already held the message would separate nothing.
      if (ports.delivery !== undefined && !(await ports.delivery.claim())) {
        return {
          outcome: "suppressed",
          reason: "automation_already_delivered",
          // The run stops here. The steps after a delivery belong to the run
          // that made it, and the one that won is already performing them.
          ends: true,
        };
      }

      // Awaited one at a time, and that is the ORDER (REQ-231, REQ-286): the
      // message the operator wrote goes out, and only then what follows it —
      // each pure link, in the order it was declared. A `Promise.all` here
      // would hand them all to the queue in an order nobody chose, and the
      // contact would receive an address with no idea what it is.
      for (const message of await buildDeliveries(step, ports)) {
        await ports.sender.sendDirectMessage(start.contactId, message);
      }
      return undefined;
    }

    case "confirm_optin": {
      // REQ-068: a contact who has written recently is already in a
      // conversation, so asking again is a message nobody needed. The
      // suppression is reported, never silent.
      if (await ports.suspender.isConversationOpen(start.contactId)) {
        return {
          outcome: "suppressed",
          reason: "conversation_already_open",
        };
      }

      // REQ-249: the button is what this question is answered with, so a step
      // that declares none has nothing to be answered. Refused LOUDLY, and
      // before anything goes out: sending the question anyway would open a wait
      // no message could ever satisfy, and the contact would be held for the
      // whole deadline over a field the operator left blank. Validation refuses
      // the same definition by name (`confirmation_without_quick_reply`), so
      // what reaches here is a definition written outside the editor or stored
      // before the label was required.
      const quickReply = text(step, "quick_reply_label");

      if (quickReply === "") {
        return {
          outcome: "failed",
          reason: "confirmation_without_button",
          detail: step.id,
        };
      }

      // REQ-066: the question carries no link and no resource. That is true by
      // construction here — the step has no asset to put one in.
      const question = text(step, "text");

      await ports.sender.sendDirectMessage(start.contactId, {
        text: question,
        quickReplies: [quickReply],
      });

      await ports.suspender.suspend({
        contactId: start.contactId,
        flowId: start.flowId,
        stepId: step.id,
        expiresAt: expiresAt(ports),
        onTimeout: text(step, "on_timeout"),
        // REQ-250: the words on the button are the answer, and the wait carries
        // them so the judgement is made against what actually went out. Until
        // phase 3l this said `any`, and a message about anything else, days
        // after the question, was read as a yes.
        expects: { kind: "button", label: quickReply },
        // What the wait puts back on the wire when an answer is refused
        // (REQ-251). The words only: the button this card carries is already
        // in `expects`, and a second copy could disagree with it.
        question,
        // The retry contract, including persistence before re-enqueueing, is
        // documented in `docs/platform-limits.md` (REQ-023/243/251).
        maxAttempts: ports.waiting.questions,
      });

      return { outcome: "suspended" };
    }

    case "delay": {
      // REQ-098. The simplest of the four waits, and simple by subtraction: it
      // sends nothing, it judges no answer, it re-asks nothing and it refuses
      // nothing. What it needs is the one thing every other wait already gets,
      // a record with a due instant (ADR-005), which is why a pause of an hour
      // costs the process nothing while it passes and is still there after a
      // restart in the middle of it.
      const seconds = pauseSeconds(step);

      if (seconds === undefined) {
        // Loud, for the same reason an unsupported kind is below: a pause that
        // cannot say how long it lasts would otherwise be no pause at all, and
        // the step after it would fire in the same instant as the step before,
        // which is precisely the behaviour a pause exists to prevent.
        return {
          outcome: "failed",
          reason: "pause_without_duration",
          detail: step.id,
        };
      }

      await ports.suspender.suspend({
        contactId: start.contactId,
        flowId: start.flowId,
        stepId: step.id,
        expiresAt: new Date(ports.clock.now().getTime() + seconds * 1000),
        // Nothing to declare: the path a flow chooses for a contact who never
        // answered has no meaning here, because this wait never asked them
        // anything and never gives up on them.
        onTimeout: "",
        // The whole of the difference from the three waits below: what ends
        // this one is the clock, and its deadline RESUMES the run at the next
        // step instead of ending it (REQ-098).
        expects: "time",
      });

      return { outcome: "suspended" };
    }

    case "collect_email": {
      // REQ-024: an address this contact already gave is an answer already
      // given, so the question is not asked and the run carries straight on to
      // the next step. Attributes belong to the CONTACT, not to a run
      // (REQ-028), so an address collected by any earlier automation counts
      // too, which is the whole point: being asked again by every automation
      // is what makes an operator turn collection off.
      //
      // Read through the port at step time rather than taken from the decision
      // above, because a step earlier in this same run may have written it.
      //
      // Known means a non-empty string. `null` is how "no address" reads (the
      // branch transitions compare against exactly that), and the engine does
      // not re-judge a stored value: deciding here that an address written by
      // the collector is not good enough would ask again for one this
      // installation has already accepted.
      const attributes = await ports.contacts.getAttributes(start.contactId);
      const known = attributes[EMAIL_ATTRIBUTE];

      if (typeof known === "string" && known !== "") {
        // Suppressed, never silent, exactly as the confirmation above: an
        // operator asking why this contact was never asked finds the answer.
        return {
          outcome: "suppressed",
          reason: "email_already_known",
        };
      }

      // REQ-022: the declared question goes out, and the run stops here. What
      // the steps after it do depends on an answer that does not exist yet, so
      // advancing would deliver on a promise the contact has not made.
      const question = text(step, "text");

      await ports.sender.sendDirectMessage(start.contactId, {
        text: question,
      });

      await ports.suspender.suspend({
        contactId: start.contactId,
        flowId: start.flowId,
        stepId: step.id,
        expiresAt: expiresAt(ports),
        onTimeout: text(step, "on_timeout"),
        // The difference from `confirm_optin`, and the reason the wait has to
        // carry a verdict at all: here an answer is only an answer when it is
        // an address. Anything else leaves the run at this same step.
        expects: "email",
        // REQ-023: this step refuses answers, so it is also the step that asks
        // again. Both halves of that travel WITH the wait: the words to repeat,
        // which are the step's, and how many times they may be repeated, which
        // is the instance's since REQ-254.
        ...(question !== "" && { question }),
        maxAttempts: ports.waiting.questions,
      });

      return { outcome: "suspended" };
    }

    case "follow_gate": {
      // REQ-027. The gate opens on ONE answer and stays shut on every other,
      // the unanswerable query included, because the two mistakes are not the
      // same size: letting a non-follower through hands over a resource that
      // cannot be recalled, while holding a follower back costs one message
      // and is undone by their next one. The field that answers this only
      // exists for a contact already in a conversation, so being unable to ask
      // is the ORDINARY case here (docs/platform-limits.md, item 7) and is
      // treated as such rather than as an exception.
      const status: FollowStatus =
        ports.follow === undefined
          ? { kind: "unknown", cause: "not_configured" }
          : await ports.follow.status(start.contactId);

      if (status.kind === "follows") {
        // The same shape as REQ-068 above, for the same reason: what the step
        // exists to obtain is already true, so the request is a message nobody
        // needed. Suppressed, never silent, and the run carries on.
        return {
          outcome: "suppressed",
          reason: "contact_already_follows",
        };
      }

      // REQ-245 (registered again as REQ-316): the request always carries a
      // button, and its words come from the instance rather than from the step.
      // The asymmetry with the confirmation is deliberate: what this button
      // says is a constatation that never changes from automation to
      // automation ("I already followed"), while the confirmation's button is
      // part of the offer that one automation makes.
      //
      // This is a card in both conversation paths (ADR-027, REQ-342). Unlike
      // ordinary confirmations, detached quick-reply chips are not the form
      // the contact is being asked to act on here.
      //
      // What the button is FOR is asking the platform to be consulted again,
      // and only that: tapping it is not passing the gate, which is why the
      // wait below still expects `follow` and not the words that went out.
      const request = text(step, "text");

      await ports.sender.sendDirectMessage(start.contactId, {
        text: request,
        cardButtons: [ports.waiting.followButtonLabel],
      });

      await ports.suspender.suspend({
        contactId: start.contactId,
        flowId: start.flowId,
        stepId: step.id,
        expiresAt: expiresAt(ports),
        onTimeout: text(step, "on_timeout"),
        // Neither `any` nor the button above: no text a contact can type makes
        // them a follower, so what ends this wait is the QUERY, asked again at
        // every interaction (REQ-027). Declaring the button's words here would
        // hand the resource to whoever reads them and types them back.
        expects: "follow",
        // Keep the card complete on a re-ask; platform rationale:
        // `docs/platform-limits.md` (REQ-246).
        question: request,
        buttonLabel: ports.waiting.followButtonLabel,
        // No ceiling, and the absence is deliberate. The number of questions
        // the instance configures is NOT applied here (REQ-254 names the other
        // two steps): the contact writing while not yet following is not
        // answering wrongly, and counting their messages would close a gate
        // they were about to pass. Only the deadline ends this one.
      });

      // The unverifiable case is reported, and it is the one an operator most
      // needs to see: a gate that keeps asking a contact who does follow is a
      // permission or a conversation problem, and nothing else in the trail
      // would say so.
      return status.kind === "unknown"
        ? {
            outcome: "suspended",
            reason: `the follow relationship could not be verified (${status.cause}${
              status.detail === undefined ? "" : `: ${status.detail}`
            }): the request went out as it would to a contact who does not follow`,
          }
        : { outcome: "suspended" };
    }

    case "reply_comment": {
      if (start.commentId === undefined) {
        return {
          outcome: "failed",
          reason: "comment_reply_without_comment",
          detail: step.id,
        };
      }
      // REQ-125, and the anchor case of the whole feature: fifty comments
      // carrying the keyword answered with fifty copies of one sentence is what
      // a reader sees as a robot and what the platform's spam filter sees as
      // repetition in volume (docs/platform-limits.md).
      await ports.sender.replyToComment(start.commentId, {
        text: drawWording(step, "text", ports),
      });
      return undefined;
    }

    default:
      // An unknown step kind is a definition the validator should have caught.
      // Failing loudly here beats skipping it: a skipped step is a promise the
      // flow made to the contact and did not keep. The KIND is the detail, and
      // it is the one thing an operator needs in order to fix the definition.
      return {
        outcome: "failed",
        reason: "step_type_unsupported",
        detail: step.type,
      };
  }
}
