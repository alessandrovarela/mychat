/**
 * Ports the engine declares and the outside world implements (ADR-003).
 *
 * These are contracts, never implementations. Nothing here may name a
 * transport, an endpoint or a storage mechanism: a protocol detail leaking
 * into a signature drags the whole dependency back into the core, and the
 * core stops being cheap to test.
 */

/** Value a contact attribute can carry. Plain data, not a database type. */
export type AttributeValue = string | number | boolean | null;

export type ContactAttributes = Readonly<Record<string, AttributeValue>>;

/**
 * The attribute a collected address is written to, and read back from
 * (REQ-022, REQ-024).
 *
 * Fixed rather than configurable per step, and that is a decision: a flow that
 * could name the key would let two flows of the same installation store the
 * same person's address under two names, and the "do not ask what we already
 * know" rule would then be false for whichever flow ran second.
 *
 * It sits beside the attributes themselves because both halves of that rule
 * need it: the engine reads the key to suppress a question it already has the
 * answer to, and the answer reader outside writes it. `src/runtime/answers.ts`
 * re-exports it, so callers outside the engine still take it from there.
 */
export const EMAIL_ATTRIBUTE = "email";

/**
 * Time as a dependency. Tests inject a fixed clock instead of waiting for real
 * time to pass, which is what makes an engine decision reproducible.
 */
export interface Clock {
  now(): Date;
}

/**
 * Chance as a dependency, exactly as `Clock` is time (REQ-126).
 *
 * A step may declare several wordings, and which one goes out is DRAWN. Calling
 * `Math.random()` here would put the one thing a test cannot pin down inside the
 * core: the suite could then assert that some wording arrived, never that the
 * declared one did, and the rule for choosing would be provable only by running
 * it enough times to feel sure.
 *
 * Deliberately the raw primitive rather than a chooser. The engine owns HOW a
 * number becomes a choice (the range, the rounding, the bounds), because that
 * is the part with an edge to get wrong, and it is the part a test can then
 * walk end to end.
 */
export interface RandomSource {
  /** A number in `[0, 1)`, the shape every platform's generator already has. */
  next(): number;
}

/**
 * What the INSTANCE decided about waiting, as plain injected data (REQ-252,
 * REQ-254, REQ-257).
 *
 * Not a port: there is nothing to call and nothing to implement, only values
 * the engine has to be TOLD. Two of them used to be fields of the step and
 * arrived through the definition; they are one setting of the instance now, and
 * where that setting is stored is a place the engine may not look (ADR-003). So
 * they come in the same way `messageWindowHours` reaches the durable suspender:
 * resolved by whoever owns the store, handed over as plain data.
 *
 * Read at the moment a step suspends and never before, which is the whole of
 * REQ-253: the deadline is written into the durable record when the wait is
 * created, so a value changed afterwards decides the NEXT wait and cannot reach
 * back into one already counting.
 */
export interface WaitingSettings {
  /** One deadline in hours for every step that waits, counted from the ask. */
  readonly hours: number;
  /** How many times a step may ask, the first question included (REQ-023). */
  readonly questions: number;
  /**
   * What the button of "ask to follow" says (REQ-245, REQ-257).
   *
   * A STRING and not a catalogue key, for the reason every other operator-
   * visible text reaches the engine as a string: the catalogue is read where
   * the catalogue can be read, and the engine may not look there either. The
   * operator renames this button in Settings, so the words also stop being the
   * catalogue's the moment they do, and nothing here could tell the two apart.
   *
   * Beside the deadline rather than on the step because the request is always
   * the same constatation ("I already followed"), while the confirmation's
   * button is part of the offer and stays declared by the step (REQ-249).
   */
  readonly followButtonLabel: string;
}

/** Reads and writes contact attributes. The engine never sees the store. */
export interface ContactRepo {
  getAttributes(contactId: string): Promise<ContactAttributes>;
  setAttribute(
    contactId: string,
    key: string,
    value: AttributeValue,
  ): Promise<void>;
}

/**
 * A button that opens a URL. Deliberately NOT the same type as a quick reply
 * (REQ-085, REQ-086): the platform renders them through different mechanisms,
 * with different ceilings, and one of them does not work on the desktop app.
 * One shared type would make that difference invisible at exactly the layer
 * where it has to be visible.
 */
export interface OutboundLink {
  readonly url: string;
  readonly label: string;
}

/**
 * A resource attached to the conversation, already resolved to a URL.
 *
 * The KIND travels with it, and it is not decoration (REQ-231): the platform
 * carries a document and an image through different attachment types, and it
 * accepts different formats and different sizes for each. Left for the adapter
 * to guess from the URL's extension, the guess would be made at the one moment
 * nothing can be done about being wrong — the contact is already waiting.
 *
 * Declared here as a literal union rather than imported from `src/flows`: the
 * engine describes what it needs and nothing else (ADR-003), exactly as
 * `FlowStep.type` is a plain string rather than the schema's action enum.
 */
export interface OutboundAttachment {
  readonly url: string;
  readonly kind: "document" | "image";
}

/** One ordered destination in a card. Its stable id survives the engine seam. */
export interface OutboundCardButton {
  readonly id: string;
  readonly label: string;
  readonly url: string;
}

/** A single visual unit, with its optional resource already resolved. */
export interface OutboundCard {
  readonly imageUrl?: string;
  readonly title?: string;
  readonly description?: string;
  readonly buttons: readonly OutboundCardButton[];
}

/** Attribution already known when a card is made durable for delivery. */
export interface ButtonLinkContext {
  readonly automationId: string;
  readonly contactId: string;
  readonly executionId: string;
}

/** Replaces authored card destinations with persisted, signed public links. */
export interface ButtonLinkWriter {
  wrap(
    buttons: readonly OutboundCardButton[],
    context: ButtonLinkContext,
    at: Date,
  ): Promise<readonly OutboundCardButton[]>;
}

/**
 * What to deliver, at intent level: no endpoint, no payload shape.
 *
 * ONE message, and one send call. A delivery that has both something to say and
 * something to attach is TWO of these, in that order (REQ-231). The platform
 * constraint is recorded in `docs/platform-limits.md`; this type only preserves
 * the resulting boundary.
 */
export interface OutboundMessage {
  readonly text: string;
  /**
   * Which message of ONE delivery this is, counted from the first (REQ-286).
   *
   * Absent on the first, and on a delivery that is only one message. Present,
   * and 2 or more, on every message that FOLLOWS another one of the same step:
   * the pure links, and the attachment while one still existed.
   *
   * A fact about composition and not about timing, which is why the engine
   * writes it: the engine is the only party that knows a delivery is several
   * messages and in which order they were declared, and it says so without
   * naming a queue, an instant or a pause. What is DONE with the position
   * belongs outside — `src/runtime/outbox.ts` reads it to keep the second
   * message from leaving in the same second as the first (REQ-231), and the
   * adapter ignores it entirely.
   *
   * A NUMBER and not a flag, and the difference is not cosmetic: two identical
   * pure links declared by the same step would stringify alike, and the queue
   * tells its rows apart by hashing the message (`queueOrdinal`), so a boolean
   * marker would let the second of the two be dropped as a duplicate of the
   * first.
   */
  readonly part?: number;
  /**
   * The platform interaction is recorded in `docs/platform-limits.md`;
   * the engine uses the same words for the button and its answer (REQ-245,
   * REQ-250).
   */
  readonly quickReplies?: readonly string[];
  /**
   * Choices drawn in a generic-template card with `postback` buttons.
   *
   * Unlike `quickReplies`, this is a promise about the form the contact sees:
   * it is one card with its call to action, on every conversation path. The
   * follow gate uses it because its request must never arrive as a bubble with
   * detached chips (ADR-027, REQ-342).
   */
  readonly cardButtons?: readonly string[];
  /** Present only for a `link` delivery. */
  readonly link?: OutboundLink;
  /** The whole of this message when present: a second one, after the first. */
  readonly attachment?: OutboundAttachment;
  /** Present only for a version-2 `card` delivery. */
  readonly card?: OutboundCard;
}

/** Delivers messages. Which API call that becomes is the adapter's problem. */
export interface Sender {
  sendDirectMessage(contactId: string, message: OutboundMessage): Promise<void>;
  replyToComment(commentId: string, message: OutboundMessage): Promise<void>;
}

/** Resolves an asset by name. Bucket, disk or memory is the adapter's choice. */
export interface AssetStorage {
  publicUrl(name: string): Promise<string>;
}

/**
 * Why the platform would not say whether a contact follows (REQ-027).
 *
 * Named causes rather than one opaque string, because the operator's next move
 * differs for each: `field_absent` is answered by writing to the contact,
 * `refused` by looking at the permissions, `not_configured` by wiring the
 * adapter. The detail beside the cause carries what the platform itself said.
 */
export const FOLLOW_UNKNOWN_CAUSES = [
  /** No credential is configured, so there is nothing to ask with. */
  "no_credential",
  /** No follow link was wired into this run at all. */
  "not_configured",
  /** The platform answered with an error: permissions, or an id it will not load. */
  "refused",
  /** The request never got an answer, or the platform failed on its own side. */
  "unreachable",
  /**
   * A successful answer that simply does not carry the field. The documented
   * reason is that `is_user_follow_business` belongs to the messaging User
   * Profile API and answers for a contact who is in a CONVERSATION
   * (docs/platform-limits.md, item 7). This names what was observed, and the
   * documented reason is the one to read it by.
   */
  "field_absent",
  /** An answer nobody can read, or a field that is not a boolean. */
  "malformed",
] as const;

export type FollowUnknownCause = (typeof FOLLOW_UNKNOWN_CAUSES)[number];

/**
 * Whether a contact follows the account, as far as the platform will say
 * (REQ-027, REQ-005).
 *
 * THREE answers, not two, and the third is the reason this is a type instead of
 * a boolean. The field that answers this question is only available for a
 * contact who is already in a conversation, so "cannot say" is an ordinary
 * outcome here rather than an exception. A boolean would have to fold it into
 * one of the other two, and both foldings are wrong in different sizes: folded
 * into `follows` it hands over a resource that cannot be taken back, folded
 * silently into `does_not_follow` it hides why a contact who does follow keeps
 * being asked to.
 */
export type FollowStatus =
  | { readonly kind: "follows" }
  | { readonly kind: "does_not_follow" }
  | {
      readonly kind: "unknown";
      readonly cause: FollowUnknownCause;
      /** What the platform, or the failure, actually said. */
      readonly detail?: string;
    };

/**
 * Reading the follow relationship, as a port (REQ-027).
 *
 * The engine decides what an answer MEANS; which endpoint answers it, on which
 * host, with which token, belongs outside (ADR-003, ADR-022). This is the first
 * platform READ the engine needs, and it enters exactly like every send did.
 */
export interface FollowLink {
  status(contactId: string): Promise<FollowStatus>;
}

/**
 * The answer a step recognises when it is the TEXT OF A BUTTON (REQ-245,
 * REQ-249, REQ-250).
 *
 * The label travels INSIDE what the wait expects, rather than beside it, and
 * that is the whole of why this is a shape and not a fifth string. What ends a
 * wait and what the answer has to say are one decision of one step: kept apart,
 * a record could be written declaring a button and carrying no label, and the
 * wait would then be one nothing the contact can send would ever satisfy.
 *
 * Why the label and not a stable id: one value must cover both the button and
 * an equivalent typed answer. The platform observation is in
 * `docs/platform-limits.md`.
 */
export interface AwaitedButtonAnswer {
  readonly kind: "button";
  /** Exactly what the button says. Compared tolerantly, never verbatim (REQ-248). */
  readonly label: string;
}

/**
 * What ENDS a wait (REQ-022, REQ-027, REQ-067, REQ-250).
 *
 * `button` is the confirmation's rule since phase 3l: only what the button says
 * is a yes, whatever spelling it arrives in. `email` is a verdict of the same
 * family: an answer that is not an address leaves the run exactly where it was.
 *
 * `any` is what the confirmation USED to declare, and nothing declares it any
 * more. It survives because records written before the button existed carry it,
 * and because it is the honest reading of a wait that has no expectation at
 * all: whatever the contact sends back ends it. That reading is exactly the
 * defect REQ-250 closed, so no new wait may be created with it: a message from
 * a stranger, days later, was being read as consent.
 *
 * `follow` is neither, and that is the whole of its design: no text a contact
 * can type makes them a follower, so what ends this wait is a QUERY and not a
 * message. The message is only what prompts the query to be asked again
 * (REQ-027), which is why the wait must be re-judged at every interaction
 * rather than once at the start. That step sends a button too since REQ-245,
 * and the button changes nothing here: tapping it ASKS for the query to be put
 * again, it does not answer it.
 *
 * `time` is the last, and the only one the contact has no part in at all
 * (REQ-098): a declared pause waits for the CLOCK. Nothing they write ends it,
 * and nothing they fail to write ends it either, which turns the deadline into
 * the opposite of what it means for the others. There it is where the run
 * gives up on someone who never answered; here it is where the run CONTINUES,
 * at the step after the pause, with nobody having been asked anything.
 *
 * The step that suspends is the only place that knows which of these applies,
 * so it declares it here and the wait carries it. Deciding it later, from the
 * step type or from the flow, would mean re-reading a definition the run may no
 * longer be holding (REQ-060).
 */
export type AwaitedAnswer =
  "any" | "email" | "follow" | "time" | AwaitedButtonAnswer;

/** What a run needs remembered while it waits for the contact to answer. */
export interface SuspensionRequest {
  readonly contactId: string;
  readonly flowId: string;
  /** The step that suspended. The run resumes at the one AFTER it. */
  readonly stepId: string;
  /**
   * When the wait ends by itself. Giving up for a wait on a human, and the
   * instant the run carries on for a pause (`expects: "time"`, REQ-098).
   */
  readonly expiresAt: Date;
  /**
   * What the flow declared should happen then. Empty for a pause, which
   * declares no such path: it never gives up on anybody.
   */
  readonly onTimeout: string;
  /**
   * What the step is waiting for. Required, and deliberately so: a step that
   * suspends without saying what would end the wait gets the loosest rule
   * there is, and nobody reviewing the step would see it happen.
   */
  readonly expects: AwaitedAnswer;
  /**
   * The question that just went out, kept so it can go out again (REQ-023).
   *
   * A wait that refuses an answer has to be able to ASK for another one, and
   * what it asks must be the question this run actually asked. Looking it up
   * again later would read a definition the run may no longer be holding
   * (REQ-060), so the wait carries it.
   *
   * Absent for a wait that never re-asks, which is every wait that accepts any
   * answer at all.
   */
  readonly question?: string;
  /**
   * The words on the button that went out WITH the question (REQ-246).
   *
   * A re-ask carries the complete card. The platform observation and rationale
   * are recorded in `docs/platform-limits.md`.
   *
   * Written ONLY by a wait whose button is not what ends it, which today is
   * the follow gate: what its button asks for is the platform to be consulted
   * again (REQ-027). A wait the button ANSWERS carries those words inside
   * `expects` instead, because that is what judges the answer, and writing
   * them here as well would allow a record whose card says one thing and whose
   * verdict expects another.
   */
  readonly buttonLabel?: string;
  /**
   * How many times this step may ask, the first time included (REQ-023).
   *
   * Absent means the wait does not re-ask and does not give up on a count:
   * only the deadline ends it. That is the honest reading for a wait that
   * accepts any answer, because it never refuses one and so never counts.
   */
  readonly maxAttempts?: number;
}

/**
 * Waiting for a human, as a port (REQ-025, REQ-026, REQ-067, REQ-068).
 *
 * The engine decides THAT a run should wait and what would end the wait; where
 * that wait is written down, and what wakes it, belongs outside — which is what
 * lets the same wait survive a restart without the engine knowing a database
 * exists (ADR-003, ADR-005).
 */
export interface Suspender {
  suspend(request: SuspensionRequest): Promise<void>;
  /**
   * Is a conversation with this contact already open (REQ-068)?
   *
   * True only when the CONTACT has written recently. A comment does not open a
   * conversation, which is the finding REQ-066 was written from.
   */
  isConversationOpen(contactId: string): Promise<boolean>;
}

/** Everything the engine needs from the outside, injected as one bundle. */
export interface EnginePorts {
  readonly clock: Clock;
  readonly contacts: ContactRepo;
  readonly sender: Sender;
  readonly assets: AssetStorage;
  readonly suspender: Suspender;
  /**
   * Required, and NOT for symmetry (REQ-126).
   *
   * Optional with a fallback to the first wording, every composition that
   * forgot to wire it would send the SAME sentence to every contact, which is
   * the exact behaviour the several wordings exist to prevent, and it would be
   * invisible: every message goes out, every test of anything else passes. A
   * required port turns that omission into a compile error instead.
   */
  readonly random: RandomSource;
  /**
   * Required, and for the same kind of reason `random` is (REQ-252, REQ-254).
   *
   * A deadline the engine could default would be a deadline nobody chose, and
   * the one number that decides how long a contact is held would then be
   * invisible: every message still goes out, every other test still passes, and
   * the operator's setting is silently not in force. Required makes a
   * composition that forgot it fail to compile.
   */
  readonly waiting: WaitingSettings;
  /**
   * Optional, and NOT as a convenience (REQ-027).
   *
   * A run with no follow link is one more way the question cannot be answered,
   * and it is answered the same way as every other: the gate stays shut, the
   * request goes out, and the cause is recorded as `not_configured`. Making it
   * required would say the opposite is possible, that a step could assume an
   * answer exists; making it optional and OPENING the gate when it is absent
   * would be the one mistake this whole step is written to avoid.
   */
  readonly follow?: FollowLink;
  /**
   * Whether this run may hand the material over (REQ-239, REQ-240).
   *
   * Optional, and the absence means NO RULE rather than a refusal: an
   * automation whose "once per contact" is off wires no gate, and a run with
   * no gate delivers. That is the opposite default from `follow` above, and
   * the asymmetry is the requirement rather than an oversight: a shut follow
   * gate costs one message, while a shut delivery gate silently withholds the
   * material of an automation that never asked for the rule.
   */
  readonly delivery?: DeliveryGate;
}

/**
 * The once-per-contact rule, as the engine can ask it (REQ-239, REQ-240).
 *
 * A PORT and not a store, because ADR-003 is what it is: the engine knows
 * which step hands the material over and knows nothing about automations,
 * contacts' marks or SQLite. So it asks, at the only instant the answer can be
 * asked for honestly, and whoever composed the run answers.
 *
 * Asked immediately BEFORE the send and never after: the answer decides
 * whether the message is queued at all, and a run that asked afterwards would
 * have already handed the contact a copy it then had to apologise for.
 */
export interface DeliveryGate {
  /**
   * Takes the contact's one chance at this automation, or refuses.
   *
   * Idempotent for the run that already took it, so a flow that delivers more
   * than once is not stopped halfway by its own mark.
   */
  claim(): Promise<boolean>;
}
