import { runExecution } from "../engine/execute.js";
import type { FlowRegistry } from "../engine/execute.js";
import type { FlowDefinition } from "../engine/flow.js";
import type {
  AssetStorage,
  ButtonLinkWriter,
  Clock,
  ContactRepo,
  DeliveryGate,
  EnginePorts,
  FollowLink,
  RandomSource,
  Sender,
} from "../engine/ports.js";
import { bindActiveAutomation } from "../flows/binding.js";
import { encodeNoMatch, matchEvent } from "../flows/matching.js";
import type { InboundEvent } from "../flows/matching.js";
import type { ActiveAutomation } from "../flows/schema.js";
import { t } from "../i18n/index.js";
import type { InstanceSettingsReader } from "../config/instance-settings.js";
import type { TriggerSwitchPreference } from "../config/trigger-switches.js";
import type { AuditRepository } from "../storage/audit.js";
import type { AutomationRunStore } from "../storage/automation-runs.js";
import type { ConversationStore } from "../storage/conversations.js";
import type { DurableWorkStore, WorkItem } from "../storage/durable-work.js";
import { isUnreadable } from "../flows/automations.js";
import type { AutomationAggregateStore } from "../flows/automations.js";
import { recordExecution } from "./execution-audit.js";
import { createQueueingSender } from "./outbox.js";
import type { OutboxContext } from "./outbox.js";
import {
  createDurableSuspender,
  routeInbound,
  supersedePreviousWaits,
} from "./suspension.js";
import type {
  ClosingRequest,
  ReaskRequest,
  SuspensionPayload,
  WaitingExecution,
} from "./suspension.js";

/**
 * From an accepted event to a running execution (REQ-092, REQ-095).
 *
 * This is the hook the webhook declared and never filled: everything before it
 * exists (matching, binding, the engine, the queue, the wait), and nothing was
 * joined up. What this module owns is the ORDER, and the order is the
 * requirement rather than an implementation detail:
 *
 *   1. a direct message marks the conversation open, a comment does not;
 *   2. the event is offered to the contact's suspended executions FIRST;
 *   3. the wait has the first word and the trigger has the second, so what the
 *      wait ACCEPTED stops there and what it REFUSED goes on to matching.
 *
 * Step 3 is where getting it wrong costs the most, and the expensive half is
 * the first one (REQ-241). A "yes" that ends a wait would also fire the
 * automation whose keyword it happens to contain, so the same contact receives
 * the resource twice: once from the run that finally unblocked, once from the
 * run that should never have started. That is why an accepted answer returns
 * without ever reaching matching, and why the confirmation now accepts only the
 * words on its own button (REQ-250), which is what makes the second half safe.
 *
 * The second half is REQ-242: a message the wait refused was never an answer,
 * so it is offered to triggers exactly as if no wait existed. A trigger that
 * fires ends the waiting run (through the supersession every starting run
 * performs) and begins its own, and the question of the run that just ended is
 * not asked again, nor is an attempt spent on it (REQ-243).
 */

/**
 * The webhook's `EventHandler`, declared here structurally.
 *
 * Not imported from `src/http`: dependencies point rightwards (KEEL layering),
 * and the runtime importing the HTTP layer would invert exactly the direction
 * that keeps this dispatchable without a server in the test.
 */
export type DispatchHandler = (
  payload: unknown,
  eventId: string,
) => Promise<void>;

export interface DispatchDeps {
  readonly clock: Clock;
  /**
   * The executable aggregate store, and the only one there is: the version-2
   * `automation_aggregates` repository. Nothing reads a flow catalogue here,
   * because after phase 3k there is none (REQ-213).
   */
  readonly automationAggregates: Pick<
    AutomationAggregateStore,
    "list" | "findById"
  > &
    Partial<PendingPublicationBinder>;
  readonly work: DurableWorkStore;
  readonly buttonLinks?: ButtonLinkWriter;
  readonly conversations: ConversationStore;
  readonly contacts: ContactRepo;
  readonly assets: AssetStorage;
  /**
   * Which wording a step declaring several sends (REQ-126). Carried here rather
   * than defaulted inside, so a test scripts the draw and the composition root
   * is the one place that names the real generator.
   */
  readonly random: RandomSource;
  readonly audit: AuditRepository;
  readonly runs: AutomationRunStore;
  /** Instance-wide emergency stop, read for every accepted interaction. */
  readonly triggerSwitches?: TriggerSwitchPreference;
  /** How long a contact's own message keeps the conversation open (REQ-068). */
  readonly messageWindowHours: number;
  /**
   * How long a step waits and how often it asks (REQ-252, REQ-254).
   *
   * A reader and not two numbers, and the difference is the requirement: a pair
   * resolved once at composition would be the pair the PROCESS started with,
   * and the operator's change would take a restart to matter. It is asked at
   * the start of every pass instead, so the wait created next counts under the
   * setting in force when it is created, and the ones already counting keep
   * what they were born with (REQ-253).
   */
  readonly instanceSettings: InstanceSettingsReader;
  /**
   * Reads whether a contact follows the account (REQ-027).
   *
   * Optional here for the same reason it is optional on the engine's ports: a
   * dispatcher wired without it still runs every flow, and a follow gate inside
   * one stays SHUT, recording that it could not ask. An installation missing
   * the adapter asks people to follow needlessly; the opposite default would
   * hand the resource to everyone.
   */
  readonly follow?: FollowLink;
}

export const TRIGGER_SWITCH_SUPPRESSIONS = {
  all: "trigger_switch_all_disabled",
  comment: "trigger_switch_comments_disabled",
  direct_message: "trigger_switch_direct_messages_disabled",
} as const;

/** A machine-readable reason for webhook deliveries this build cannot parse. */
export const UNREADABLE_INBOUND_REASON = "unreadable_inbound";

interface PendingPublicationBinder {
  bindPendingToPublication(publicationId: string): Promise<unknown>;
}

/** One interaction, translated, with the instant it happened. */
export interface InboundInteraction {
  readonly event: InboundEvent;
  /**
   * When the contact acted. Every delivery window counts from this, so it is
   * the interaction's own instant and never the instant we got round to it.
   */
  readonly occurredAt: Date;
  /**
   * The public identifier of whoever acted, when the payload brought one
   * (REQ-162). A comment carries `from.username`; a direct message carries no
   * such field, and there the absence stays.
   *
   * Here rather than on `InboundEvent`, deliberately: that type is what
   * MATCHING reads, and a username decides nothing about whether an automation
   * fires. It is provenance, which belongs to the interaction, and putting it
   * where matching looks would invite a keyword rule that reads it one day.
   */
  readonly username?: string;
}

// --- translation ------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** An identifier: a string that is actually there. Empty is not an id. */
function asId(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function asList(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/**
 * A stamp, whatever unit the platform used for it.
 *
 * The same payload carries `entry.time` in SECONDS and `messaging[].timestamp`
 * in MILLISECONDS. Reading both as seconds lands a message in the year 57000,
 * and a window counted from there never closes, so the magnitude decides:
 * anything past the ceiling is already milliseconds.
 */
const SECONDS_CEILING = 1e11;

function instantOf(value: unknown): Date | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }

  return new Date(value < SECONDS_CEILING ? value * 1000 : value);
}

/**
 * A comment, from `entry[].changes[]` (docs/platform-limits.md, "4 e 5").
 *
 * The field is checked rather than assumed: mentions and live comments arrive
 * with a value of nearly the same shape, and treating one as a comment would
 * run an automation against a publication that is not the operator's.
 */
function commentOf(
  change: Record<string, unknown>,
  accountId: string | undefined,
  at: Date,
): InboundInteraction | undefined {
  if (change["field"] !== "comments") return undefined;

  const value = asRecord(change["value"]);
  if (value === undefined) return undefined;

  const from = asRecord(value["from"]);
  const commentId = asId(value["id"]);
  const contactId = asId(from?.["id"]);
  if (commentId === undefined || contactId === undefined) return undefined;

  // The handle the platform puts beside the id, and the only place in any
  // inbound payload it appears (docs/meta-app-setup.md). Read here because here
  // is where it exists: nothing downstream can ask for it later without
  // spending a platform call on a comment that may already be deleted. Absent
  // when the delivery did not bring one, which stays absent (REQ-162).
  const username = asId(from?.["username"]);

  // The account's own public reply is a comment on the same publication. Left
  // in, a `reply_comment` step that quotes the keyword would trigger the very
  // automation that wrote it, and the loop has no end.
  if (contactId === accountId) return undefined;

  const publicationId = asId(asRecord(value["media"])?.["id"]);

  return {
    event: {
      origin: "comment",
      text: typeof value["text"] === "string" ? value["text"] : "",
      contactId,
      ...(publicationId !== undefined && { publicationId }),
      commentId,
    },
    occurredAt: at,
    ...(username !== undefined && { username }),
  };
}

/**
 * Our OWN outbound message coming back, which the platform marks `is_echo`.
 *
 * Recognised BEFORE anything tries to translate it, and for two separate
 * reasons. Read as an inbound it would mark the conversation open as if the
 * contact had written, and end the wait our own question had just started. And
 * the platform sends one for EVERY message the application sends, so a delivery
 * carrying nothing else is the routine consequence of having answered somebody:
 * the caller counts these to know that a delivery which produced no interaction
 * produced none for a reason this build understood perfectly (REQ-161).
 */
function isEcho(item: Record<string, unknown>): boolean {
  return asRecord(item["message"])?.["is_echo"] === true;
}

/**
 * A direct message, from `entry[].messaging[]`.
 *
 * A read receipt and a delivery report ride the same array and carry no
 * `message`, so they are dropped by construction. So does a tapped button,
 * which `postbackOf` below reads instead. An echo never reaches here at all:
 * `isEcho` above takes it out of the loop first.
 *
 * No public identifier leaves here, and that is the other half of REQ-162: this
 * payload carries `sender.id` and no username at all. The honest record is the
 * absence, not the id repeated under a name it does not have.
 */
function messageOf(
  item: Record<string, unknown>,
  accountId: string | undefined,
  at: Date,
): InboundInteraction | undefined {
  const message = asRecord(item["message"]);
  if (message === undefined || asId(message["mid"]) === undefined) {
    return undefined;
  }

  const contactId = asId(asRecord(item["sender"])?.["id"]);
  if (contactId === undefined || contactId === accountId) return undefined;

  return {
    event: {
      origin: "direct_message",
      // An answer of nothing but a sticker is still an answer: it ends a wait
      // (REQ-067) and matches no keyword, which is what empty text gives.
      text: typeof message["text"] === "string" ? message["text"] : "",
      contactId,
    },
    occurredAt: instantOf(item["timestamp"]) ?? at,
  };
}

/**
 * A tapped button, from `entry[].messaging[]` with a `postback` and NO
 * `message`.
 *
 * This is how the confirmation of a comment-born run comes back. The private
 * reply cannot carry quick replies, so its choices go out as generic template
 * `postback` buttons (see `src/platform/sender.ts`), and a postback is the only
 * thing a tap on one produces. Read only as a message it would never arrive at
 * all: the run would sit waiting for its timeout while the contact watches a
 * button that did nothing.
 *
 * It becomes an ordinary `direct_message` interaction because that is what it
 * is. The tap happens inside the conversation, so everything downstream (the
 * open-conversation mark, the wait it ends, the window it counts from) is the
 * same as for a typed answer, and the resume-before-matching order applies to
 * it unchanged.
 */
function postbackOf(
  item: Record<string, unknown>,
  accountId: string | undefined,
  at: Date,
): InboundInteraction | undefined {
  const postback = asRecord(item["postback"]);
  if (postback === undefined) return undefined;

  const contactId = asId(asRecord(item["sender"])?.["id"]);
  if (contactId === undefined || contactId === accountId) return undefined;

  // The TITLE first, because it is what the contact saw and pressed, and
  // because a quick reply already sends its title back as message text: both
  // mechanisms then reach matching as the same string. The payload is the
  // fallback and nothing more, since a tap finds its run by the contact and
  // never by what the payload says.
  const label = [postback["title"], postback["payload"]].find(
    (value): value is string => typeof value === "string" && value !== "",
  );

  return {
    event: {
      origin: "direct_message",
      // Empty text is a valid answer here for the same reason a sticker is: it
      // ends a wait (REQ-067) and matches no keyword.
      text: label ?? "",
      contactId,
    },
    occurredAt: instantOf(item["timestamp"]) ?? at,
  };
}

/**
 * What one delivery turned into: the interactions to dispatch, and the echoes
 * deliberately dropped on the way.
 *
 * The echoes are COUNTED rather than silently discarded because the caller has
 * a decision to make with them (REQ-161): a delivery that produced no
 * interaction and contained an echo produced none for a reason this build
 * knows, and a delivery that produced none for any other reason did not.
 */
export interface InboundTranslation {
  readonly interactions: readonly InboundInteraction[];
  /** How many items were the account's own message coming back. */
  readonly echoes: number;
}

/** A platform receipt that can advance an outbound message's lifecycle. */
interface PlatformReceipt {
  readonly kind: "echo" | "seen";
  readonly contactId: string;
  readonly occurredAt: Date;
  /** Echoes carry Meta's immutable message id. Seen receipts do not. */
  readonly platformMessageId?: string;
}

/**
 * Extracts only receipts whose actor can be named.  A seen webhook has a
 * watermark rather than the message id it covers, so it is deliberately
 * correlated later to this contact's most recent accepted outbound message.
 */
function receiptsOf(payload: unknown, receivedAt: Date): PlatformReceipt[] {
  const receipts: PlatformReceipt[] = [];
  for (const rawEntry of asList(asRecord(payload)?.["entry"])) {
    const entry = asRecord(rawEntry);
    if (entry === undefined) continue;
    const accountId = asId(entry["id"]);
    const fallbackAt = instantOf(entry["time"]) ?? receivedAt;
    for (const rawItem of asList(entry["messaging"])) {
      const item = asRecord(rawItem);
      if (item === undefined) continue;
      const at = instantOf(item["timestamp"]) ?? fallbackAt;
      if (isEcho(item)) {
        const contactId = asId(asRecord(item["recipient"])?.["id"]);
        const platformMessageId = asId(asRecord(item["message"])?.["mid"]);
        if (contactId !== undefined && contactId !== accountId) {
          receipts.push({
            kind: "echo",
            contactId,
            occurredAt: at,
            ...(platformMessageId !== undefined && { platformMessageId }),
          });
        }
        continue;
      }
      if (asRecord(item["read"]) !== undefined) {
        const contactId = asId(asRecord(item["sender"])?.["id"]);
        if (contactId !== undefined && contactId !== accountId) {
          receipts.push({ kind: "seen", contactId, occurredAt: at });
        }
      }
    }
  }
  return receipts;
}

/** Writes later platform receipts only when a durable outbound fact exists. */
async function recordReceipts(
  audit: AuditRepository,
  receipts: readonly PlatformReceipt[],
  eventId: string,
): Promise<void> {
  for (const receipt of receipts) {
    const accepted =
      receipt.kind === "echo" && receipt.platformMessageId !== undefined
        ? await audit.query({ platformMessageId: receipt.platformMessageId })
        : await audit.query({ contactId: receipt.contactId, order: "newest" });
    const fact = accepted.find(
      (entry) =>
        entry.kind === "action_executed" &&
        entry.outcome === "ok" &&
        entry.reason === "platform_accepted",
    );
    // Do not attach a receipt to a guessed run. This is especially important
    // for historical rows and for a seen watermark with no message id.
    if (fact?.executionId === undefined) continue;
    await audit.record(
      {
        kind: "action_executed",
        subtype: "message_sent",
        outcome: "ok",
        contactId: receipt.contactId,
        executionId: fact.executionId,
        eventId,
        reason: receipt.kind === "echo" ? "platform_echo" : "platform_seen",
        ...(receipt.platformMessageId !== undefined && {
          platformMessageId: receipt.platformMessageId,
        }),
      },
      receipt.occurredAt,
    );
  }
}

/**
 * The platform payload, reduced to what the rest of the runtime understands.
 *
 * EVERY entry is read, not `entry[0]`. The platform documents batching, and a
 * contact whose comment happened to share a delivery with someone else's would
 * otherwise never be answered, with nothing anywhere saying why.
 *
 * Nothing here throws. A payload this build cannot read is an empty list, and
 * the caller records it: the webhook has already answered 200, so an exception
 * would lose the event and tell the operator nothing.
 */
export function translateInbound(
  payload: unknown,
  receivedAt: Date,
): InboundTranslation {
  const interactions: InboundInteraction[] = [];
  let echoes = 0;

  for (const rawEntry of asList(asRecord(payload)?.["entry"])) {
    const entry = asRecord(rawEntry);
    if (entry === undefined) continue;

    // The entry id is the ACCOUNT the event belongs to, which is what lets an
    // echo of our own comment or message be told apart from a contact's.
    const accountId = asId(entry["id"]);
    const at = instantOf(entry["time"]) ?? receivedAt;

    for (const rawChange of asList(entry["changes"])) {
      const change = asRecord(rawChange);
      const comment =
        change === undefined ? undefined : commentOf(change, accountId, at);
      if (comment !== undefined) interactions.push(comment);
    }

    for (const rawItem of asList(entry["messaging"])) {
      const item = asRecord(rawItem);
      if (item === undefined) continue;

      if (isEcho(item)) {
        echoes += 1;
        continue;
      }

      // A typed message and a tapped button are both the contact answering,
      // and both must leave here in the same shape: whatever the routing below
      // enforces for one, it enforces for the other.
      const interaction =
        messageOf(item, accountId, at) ?? postbackOf(item, accountId, at);
      if (interaction !== undefined) interactions.push(interaction);
    }
  }

  return { interactions, echoes };
}

// --- identity of a run ------------------------------------------------------

const EXECUTION_ID_SEPARATOR = ":";

/**
 * Identity of one run: the automation, the contact, and the instant.
 *
 * The instant is what lets the same pair legitimately run again later (an
 * automation whose `once_per_contact` is off), while staying fixed for the
 * whole of one run. Both matter, because this id is the prefix of the queue's
 * dedupe key and of the suspension's: constant where it must dedupe, distinct
 * where it must not.
 *
 * The automation comes FIRST so it can be read back out. A suspension record
 * keeps the execution id and nothing else, and a resumed run has to bind the
 * SAME automation values it started with, or it delivers a different resource
 * than the one the contact was promised. Encoding the provenance in the id is
 * what answers that without a second table. Automation ids are slugs, so the
 * separator cannot occur inside one.
 */
function executionIdFor(
  automationId: string,
  contactId: string,
  at: Date,
): string {
  return [automationId, contactId, at.getTime().toString(36)].join(
    EXECUTION_ID_SEPARATOR,
  );
}

function automationOf(executionId: string): string | undefined {
  const [automationId] = executionId.split(EXECUTION_ID_SEPARATOR);
  return automationId === undefined || automationId === ""
    ? undefined
    : automationId;
}

/**
 * Snapshots the attribution the dispatcher knows before writing execution
 * facts. The current automation may later be edited or deleted, so a reader
 * must never recover this relationship from its live definition.
 *
 * A global automation can still be triggered by a comment on a publication.
 * Its scope remains global while the publication records where that execution
 * began. For a direct-message continuation, the execution id links the action
 * to the earlier fact that carried the publication, rather than guessing one.
 */
function analyticsAttributionOf(
  automation: ActiveAutomation,
  event: InboundEvent,
) {
  const scope = automation.scope;
  const legacyPublicationId =
    automation.trigger.type === "comment"
      ? automation.trigger.target
      : undefined;
  // The v2 contract made `scope` optional while moving existing comment
  // targets across. A target already means the same fact, so record it as the
  // publication scope instead of making those executions look anonymous.
  const automationScope =
    scope?.type ??
    (legacyPublicationId === undefined ? undefined : "publication");
  const scopedPublicationId =
    scope?.type === "publication" ? scope.publicationId : legacyPublicationId;
  const publicationId = event.publicationId ?? scopedPublicationId;

  return {
    ...(automationScope !== undefined && { automationScope }),
    ...(publicationId !== undefined && { publicationId }),
  };
}

// --- wiring the engine ------------------------------------------------------

function registryOf(definition: FlowDefinition): FlowRegistry {
  // One PASS, one definition, captured before its first step (REQ-060). The
  // registry is deliberately not a repository lookup: re-reading mid-pass would
  // switch the engine to a flow edited while the contact was answering.
  //
  // Honest limit, and it is not covered here: a suspended run has more than one
  // pass, and `execute` reads the definition from the repository at the start
  // of EACH of them. So an edit landing between the question and the answer is
  // picked up, and only the flow ID is checked on the way back in. Holding a
  // snapshot per suspended run is the fix, and it is registered in the INBOX as
  // a prerequisite of the dynamic flow rather than pretended away here.
  return {
    current: (flowId) => (flowId === definition.id ? definition : undefined),
  };
}

/**
 * The once-per-contact rule, handed to the engine as the question it can ask
 * (REQ-239, REQ-240).
 *
 * Absent when the automation does not carry the rule, and the absence is the
 * whole configuration: a run with no gate delivers, and no mark is ever
 * written for it, exactly as before this rule moved.
 *
 * The gate closes over the CONTACT and the RUN, because the mark answers for
 * the pair (automation, contact) and has to recognise the run that already
 * took it: a flow delivering twice asks twice, from one run, and must not be
 * refused by its own mark the second time.
 */
function deliveryGateFor(
  deps: DispatchDeps,
  automation: ActiveAutomation,
  contactId: string,
  executionId: string,
): DeliveryGate | undefined {
  if (!automation.rules.once_per_contact) return undefined;

  return {
    claim: () =>
      deps.runs.claim(automation.id, contactId, executionId, deps.clock.now()),
  };
}

/**
 * Whether this comment-only automation hands its one thing over publicly.
 *
 * A private delivery keeps ownership of the mark: it may be preceded by a
 * public acknowledgement or a question, neither of which is the material the
 * contact came for (REQ-239).  Without any `send_dm`, however, the public
 * reply is the whole delivery.  There is no engine delivery step to claim at
 * then, so the dispatcher claims immediately before it starts that reply
 * (REQ-348, ADR-025).
 */
function claimsOnPublicReply(
  automation: ActiveAutomation,
  interaction: InboundInteraction,
): boolean {
  return (
    automation.rules.once_per_contact &&
    interaction.event.commentId !== undefined &&
    automation.steps.some((step) => step.action === "reply_comment") &&
    !automation.steps.some((step) => step.action === "send_dm")
  );
}

async function portsFor(
  deps: DispatchDeps,
  context: OutboxContext,
  delivery: DeliveryGate | undefined,
): Promise<EnginePorts> {
  // Read HERE, at the start of the pass, for the reason the zone is read on
  // every request (REQ-183): the engine is handed the setting in force at the
  // moment the step asks, never one captured when the process booted. What it
  // must NOT do is reach for the store itself, which is ADR-003 whole, so the
  // numbers cross the boundary as numbers.
  const settings = await deps.instanceSettings.read();

  return {
    clock: deps.clock,
    contacts: deps.contacts,
    assets: deps.assets,
    random: deps.random,
    follow: deps.follow,
    delivery,
    waiting: {
      hours: settings.waitHours,
      questions: settings.questions,
      // The words of the follow button cross the boundary as words (REQ-245):
      // the engine can read neither the store they may have been renamed in nor
      // the catalogue they default from (ADR-003).
      followButtonLabel: settings.followButtonLabel,
    },
    sender: createQueueingSender(
      {
        work: deps.work,
        clock: deps.clock,
        ...(deps.buttonLinks !== undefined && {
          buttonLinks: deps.buttonLinks,
        }),
      },
      context,
    ),
    suspender: createDurableSuspender(
      {
        work: deps.work,
        conversations: deps.conversations,
        clock: deps.clock,
        messageWindowHours: deps.messageWindowHours,
      },
      context.executionId,
      // The run's context travels with the wait, because a pause has to resume
      // without an event to take it from (REQ-098). The same object the sends
      // are queued under, so the run continues under the window it started in
      // and never under one invented at the moment the deadline passed.
      context,
    ),
  };
}

/**
 * Everything one run needs, named. Two of these are ids of different things
 * that are both strings, and a positional list would let them be swapped with
 * nothing anywhere objecting.
 */
interface RunRequest {
  readonly automation: ActiveAutomation;
  readonly interaction: InboundInteraction;
  /**
   * The delivery this run answers, for the trail. Absent when no delivery is
   * answering: a pause resumes on its own, and naming an event there would put
   * an id on rows the platform never sent us (REQ-098).
   */
  readonly eventId?: string;
  readonly executionId: string;
  /** The trigger word that matched this run, if this was a keyword trigger. */
  readonly matchedKeyword?: string;
  /** Set only for a resumed run: the step it waited at (REQ-067). */
  readonly resumeAfterStepId?: string;
}

/**
 * When this run's first reply may leave, or `undefined` for at once (REQ-277).
 *
 * The automation's wait, and the ONE place it is decided. Three things are
 * being answered here, and each of them is the requirement rather than a
 * detail:
 *
 * WHICH PASS. Only the first, which is the pass the trigger started. A resumed
 * pass is everything that follows the contact acting (the question after the
 * button, the delivery after the address), and holding those back would punish
 * the person who has just done their part. `resumeAfterStepId` is what tells
 * the two apart, and it is set by every caller that resumes and by no caller
 * that starts.
 *
 * WHAT IMMEDIATE IS. No hold at all, not a hold of zero. A due instant of "now"
 * would be a promise about a clock the send does not need to make, and the row
 * an operator who chose immediate gets is the row they got before this rule
 * existed.
 *
 * WHEN IT COUNTS FROM. The instant the run BEGINS, not the instant the contact
 * commented. Counting from the comment would let a delivery the platform sat on
 * for a minute (or a redelivery of an old event) consume the whole wait, and
 * the operator's choice would silently do nothing on exactly the days the
 * platform is slow. That silence is the defect this rule was written to fix, so
 * it is not reintroduced by the arithmetic.
 */
function firstReplyHold(deps: DispatchDeps, run: RunRequest): Date | undefined {
  if (run.resumeAfterStepId !== undefined) return undefined;

  const seconds = run.automation.rules.first_reply_delay_seconds;

  if (seconds <= 0) return undefined;

  return new Date(deps.clock.now().getTime() + seconds * 1000);
}

/**
 * Runs one execution and writes what it did (REQ-093).
 *
 * `since` is the instant the applicable window counts from, and one expression
 * covers both origins: for a comment it is the comment, for a direct message it
 * is the contact's last inbound, which the mark written moments ago made this
 * very interaction. A payload carrying no stamp falls back to the instant the
 * event arrived, which is late by the delivery's own latency and never early:
 * erring the other way would claim a window that had already closed.
 */
async function execute(deps: DispatchDeps, run: RunRequest): Promise<void> {
  const { automation, interaction, eventId, executionId } = run;
  const { event, occurredAt } = interaction;
  const commentId =
    event.commentId !== undefined ? { commentId: event.commentId } : {};

  const bound = bindActiveAutomation(automation);
  // Read before the first step, so every send this pass composes is queued
  // under the same floor: the public reply and the first direct message wait
  // TOGETHER, which is the half of REQ-277 an operator sees.
  const notBefore = firstReplyHold(deps, run);

  if (!bound.ok) {
    // Refused before a single step ran (REQ-012): a half-delivered flow is a
    // promise made to the contact and then broken halfway through.
    await deps.audit.record(
      {
        kind: "event_received",
        subtype: event.origin,
        outcome: "failed",
        contactId: event.contactId,
        flowId: automation.id,
        automationId: automation.id,
        eventId,
        reason: t("dispatch.bindingRefused", {
          automation: automation.id,
          issues: bound.issues.map((issue) => issue.detail).join("; "),
        }),
      },
      deps.clock.now(),
    );
    return;
  }

  const result = await runExecution(
    {
      flowId: bound.definition.id,
      contactId: event.contactId,
      origin: event.origin,
      ...commentId,
      ...(run.resumeAfterStepId !== undefined && {
        resumeAfterStepId: run.resumeAfterStepId,
      }),
    },
    registryOf(bound.definition),
    await portsFor(
      deps,
      {
        automationId: automation.id,
        origin: event.origin,
        ...commentId,
        since: occurredAt,
        executionId,
        ...(notBefore !== undefined && { notBefore }),
      },
      deliveryGateFor(deps, automation, event.contactId, executionId),
    ),
  );

  await recordExecution(deps.audit, result, {
    clock: deps.clock,
    automationId: automation.id,
    eventId,
    executionId,
    ...(run.matchedKeyword !== undefined && {
      matchedKeyword: run.matchedKeyword,
    }),
    ...analyticsAttributionOf(automation, event),
  });

  // A failed pass cannot be resumed, and a run the delivery gate suppressed
  // has lost the race to another execution. Either way, a send it queued
  // before reaching that ending must not become a stray contact message.
  // Ordinary completed runs deliberately keep their sends: their delivery is
  // the successful result of the run, not an execution that was retired.
  if (
    result.outcome === "failed" ||
    result.steps.some((step) => step.reason === "automation_already_delivered")
  ) {
    await deps.work.retirePendingSends(executionId, deps.clock.now());
  }
}

/**
 * Picks up the run that just became runnable again (REQ-067, REQ-098).
 *
 * When an EVENT unblocked it, the run continues under the window that
 * interaction opened, not the one that started it: the wait ended because the
 * contact acted now, and that is the only instant either window can honestly be
 * counted from. When a PAUSE simply ran out there is no such event, and the
 * caller hands over the context the run already had (see `createPauseResume`).
 */
async function resume(
  deps: DispatchDeps,
  resumed: WaitingExecution,
  interaction: InboundInteraction,
  eventId?: string,
): Promise<void> {
  const automationId = automationOf(resumed.executionId);
  const stored =
    automationId === undefined
      ? undefined
      : await deps.automationAggregates.findById(automationId);
  const automation = isUnreadable(stored) ? undefined : stored?.definition;

  // Three ways the run cannot be picked up, and all of them stop it: the
  // automation was deleted, it went back to draft while the contact was
  // answering, or this version's schema refuses the stored document (REQ-294).
  // A draft is how v2 switches an automation off, and carrying a half-finished
  // run into one would deliver under something nobody is running. The refused
  // document ends the same way and for a stronger reason: there is no
  // definition to continue under, and inventing one is the compatibility layer
  // this project decided against.
  //
  // There used to be a third clause here, comparing `automation.id` with the
  // `flowId` the wait recorded. It could not fire: after phase 3k the id the
  // suspension stores IS the automation's own id (`bound.definition.id`), so
  // the two are the same string by construction. It was carried over from v1,
  // where an automation could be re-pointed at a different flow.
  //
  // Honest limit, unchanged and registered in the INBOX: a run keeps its
  // identity, not a snapshot of its definition. An automation edited in place
  // between the question and the answer IS picked up on resume.
  if (automation === undefined || automation.state !== "active") {
    await deps.audit.record(
      {
        kind: "event_received",
        subtype: interaction.event.origin,
        outcome: "failed",
        contactId: resumed.contactId,
        flowId: resumed.flowId,
        stepId: resumed.stepId,
        eventId,
        reason:
          automation === undefined
            ? t("dispatch.resumeLostAutomation", {
                execution: resumed.executionId,
              })
            : t("dispatch.resumeAutomationInactive", {
                execution: resumed.executionId,
              }),
      },
      deps.clock.now(),
    );
    return;
  }

  await execute(deps, {
    automation,
    interaction,
    eventId,
    // The SAME id the suspended run had: it is the dedupe prefix of everything
    // that run already queued, and a fresh one would let the messages it
    // already sent be queued a second time.
    executionId: resumed.executionId,
    resumeAfterStepId: resumed.stepId,
  });
}

/**
 * Picks a PAUSED run back up when the sweep finds its deadline passed
 * (REQ-098).
 *
 * The same `resume` above, reached by the other door, and what differs is only
 * where the run's context comes from. A contact who writes brings a new instant
 * with them, and the run continues under it. A pause brings nobody: no message,
 * no button, no window opening. So the run continues under the context it
 * already had, which the wait wrote down when it started, and the step after
 * the pause runs with nothing asked of anyone.
 *
 * Handed to the sweep as a plain function (`TimeoutDeps.resume`), so the
 * suspension module keeps knowing only that a wait came due.
 */
export function createPauseResume(
  deps: DispatchDeps,
): (item: WorkItem) => Promise<void> {
  return async (item: WorkItem): Promise<void> => {
    const payload = item.payload as SuspensionPayload;

    await resume(
      deps,
      {
        executionId: item.executionId ?? "",
        flowId: payload.flowId,
        contactId: payload.contactId,
        stepId: payload.stepId,
      },
      {
        event: {
          // The run's OWN origin, because it decides which delivery window the
          // rest of the run answers under (REQ-019, REQ-080). A record written
          // without one falls back to the narrower window rather than claiming
          // the seven days of a comment nobody can prove was there.
          origin: payload.origin ?? "direct_message",
          // Empty, and nothing is missing: nobody said anything. Only a wait
          // for a human ever judges this text, and a pause is not one.
          text: "",
          contactId: payload.contactId,
          ...(payload.commentId !== undefined && {
            commentId: payload.commentId,
          }),
        },
        // The instant the window has counted from all along. Stamping it with
        // now would silently restore a window that may well have closed while
        // the pause was running, and the send would go out to be refused.
        occurredAt:
          payload.since === undefined
            ? deps.clock.now()
            : new Date(payload.since),
      },
    );
  };
}

/**
 * The queue, addressed to the contact of a wait that has just judged their
 * message (REQ-023, REQ-256).
 *
 * ONE composition for both messages a verdict can owe (the question again, and
 * the goodbye), because everything that decides how they travel is the same:
 * the run, the contact, the window they fit in and the reason they go through
 * the queue at all.
 *
 * And it is the ORDINARY queue, so either of them obeys the delivery window,
 * the platform caps and the retry budget exactly like every other message: a
 * second route would be a second set of rules to keep in step, and the one that
 * got forgotten would be this one.
 *
 * The window counts from the message just judged, exactly as a resume does. The
 * contact wrote NOW, and now is the only instant a window can honestly be
 * counted from; the comment that started the run, if there was one, has already
 * spent its private reply on the first question.
 *
 * The attempt is the send's IDENTITY and not decoration: both messages leave
 * from the same run and the same step as the first question, so the queue would
 * otherwise be entitled to read one of them as work it has already done (see
 * `dedupeKeyFor` in `outbox.ts`), and drop it without an error anywhere.
 */
function replySender(
  deps: DispatchDeps,
  waiting: WaitingExecution,
  interaction: InboundInteraction,
  attempt: number,
): Sender {
  const automationId = automationOf(waiting.executionId);

  return createQueueingSender(
    {
      work: deps.work,
      clock: deps.clock,
      ...(deps.buttonLinks !== undefined && { buttonLinks: deps.buttonLinks }),
    },
    {
      ...(automationId !== undefined && { automationId }),
      origin: interaction.event.origin,
      since: interaction.occurredAt,
      executionId: waiting.executionId,
      attempt,
    },
  );
}

/**
 * Puts the question back on the wire after an answer the wait refused
 * (REQ-023), or after a contact asked to be checked again (REQ-246).
 *
 * The whole CARD goes back out, button included, and that is the requirement
 * rather than a nicety (REQ-251): the platform attaches a quick reply to the
 * most recent message of the conversation, so the contact's own message is what
 * took the button off their screen. Repeating the words alone would put the
 * same question in front of somebody who still has no way to answer it.
 *
 * How it travels, and under which identity, is `replySender` above.
 */
async function askAgain(
  deps: DispatchDeps,
  waiting: WaitingExecution,
  reask: ReaskRequest,
  interaction: InboundInteraction,
): Promise<void> {
  await replySender(
    deps,
    waiting,
    interaction,
    reask.attempt,
  ).sendDirectMessage(waiting.contactId, {
    text: reask.question,
    // Only when the first ask carried one. A wait whose question was plain
    // text (the address, REQ-023) is repeated as plain text, and inventing a
    // button here would offer an answer the step does not accept.
    ...(reask.buttonLabel !== undefined &&
      (reask.cardButton
        ? { cardButtons: [reask.buttonLabel] }
        : { quickReplies: [reask.buttonLabel] })),
  });
}

/**
 * Says goodbye to a contact whose questions ran out (REQ-256).
 *
 * This is the one ending of a wait whose message is certain to be sendable, and
 * that is why it is the only ending that sends one. The contact wrote a moment
 * ago, so their own message has just renewed the delivery window this send has
 * to fit in. The OTHER ending, a deadline nobody answered, has no such message
 * behind it and stays silent (see `createSuspensionTimeoutHandler` in
 * `suspension.ts`): hours have passed with nothing arriving, and on a run born
 * from a direct message the window would be closing exactly as the goodbye
 * tried to leave.
 *
 * The words are read HERE rather than carried out of the routing, because they
 * belong to the INSTANCE and not to the wait (REQ-255). The question is the
 * opposite case and the record keeps it, so a run repeats what it actually
 * asked; the goodbye is one sentence for every step and every automation, and
 * the one the operator has written by now is the honest thing to send. Asked
 * for at the moment it is composed, for the reason the reader is asked on every
 * pass: a sentence captured at composition would be the sentence the PROCESS
 * started with, and the default one follows the instance's language.
 *
 * No button goes with it, and nothing is missing: the run is over, so an answer
 * would reach a wait that no longer exists.
 */
async function sayGoodbye(
  deps: DispatchDeps,
  waiting: WaitingExecution,
  closing: ClosingRequest,
  interaction: InboundInteraction,
): Promise<void> {
  const settings = await deps.instanceSettings.read();

  await replySender(
    deps,
    waiting,
    interaction,
    closing.attempt,
  ).sendDirectMessage(waiting.contactId, { text: settings.closingMessage });
}

/**
 * Starts a run for one automation this event fired.
 *
 * The once-per-contact check here is a READ, and the change is deliberate
 * (REQ-239). It used to be the CLAIM, which spent the contact's one chance at
 * the instant the run began: someone who commented, was asked a question and
 * never answered had received nothing and could never receive anything, and
 * REQ-236 turned that from the rare case into the ordinary one, because a
 * comment on another publication now ends the run they were in. The claim is
 * made where the material actually goes out (`deliveryGateFor` above, and the
 * delivery step in `src/engine/execute.ts`).
 *
 * What a read cannot do is separate two events arriving together, and nothing
 * here pretends otherwise: both pass, both run, and the atomic INSERT they
 * both reach at the delivery lets exactly one of them hand anything over
 * (REQ-240). Honouring the automation's own switch is the last clause of
 * REQ-015, which makes the behaviour configurable per automation.
 *
 * This is also the line that separates an automation that FIRED from one that
 * actually STARTS, and since REQ-236 that difference decides what happens to
 * the contact's earlier runs. Everything below the guard is a run beginning,
 * and a run beginning takes the contact with it.
 *
 * Which is why the answer is handed back: `true` means a run began, and that is
 * the same fact as "the contact's earlier waits have just ended". REQ-243 hangs
 * on it. An automation stopped at the guard begins nothing and ends nothing
 * (REQ-237), so a contact whose refused message only reached an automation they
 * had already run is still in the wait they were in, and is owed the question
 * again rather than silence.
 */
async function start(
  deps: DispatchDeps,
  automation: ActiveAutomation,
  interaction: InboundInteraction,
  eventId: string,
  matchedKeyword?: string,
): Promise<boolean> {
  const { event } = interaction;
  const now = deps.clock.now();

  if (
    automation.rules.once_per_contact &&
    (await deps.runs.hasRun(automation.id, event.contactId))
  ) {
    await deps.audit.record(
      {
        kind: "event_received",
        subtype: event.origin,
        outcome: "suppressed",
        contactId: event.contactId,
        automationId: automation.id,
        eventId,
        reason: t("dispatch.alreadyRan", { automation: automation.id }),
      },
      now,
    );
    return false;
  }

  const executionId = executionIdFor(automation.id, event.contactId, now);

  // A reply-only comment automation has no private delivery step for the
  // engine's gate to guard.  Its comment reply is therefore the delivery, and
  // this atomic claim makes concurrent comments choose one reply before either
  // can enqueue it.  Automations that do contain a private delivery must NOT
  // claim here: their chance remains available until that material is handed
  // over, including after an opt-in question that is never answered.
  if (claimsOnPublicReply(automation, interaction)) {
    const claimed = await deps.runs.claim(
      automation.id,
      event.contactId,
      executionId,
      now,
    );
    if (!claimed) {
      await deps.audit.record(
        {
          kind: "event_received",
          subtype: event.origin,
          outcome: "suppressed",
          contactId: event.contactId,
          automationId: automation.id,
          eventId,
          reason: t("dispatch.alreadyRan", { automation: automation.id }),
        },
        now,
      );
      return false;
    }
  }

  // The contact is this run's from here on (REQ-236), and the POSITION is the
  // requirement rather than a detail of the order (REQ-237). Above the guard
  // this would end the earlier execution of a contact whose new automation was
  // then suppressed for having already run: they commented, received nothing in
  // exchange, and would have lost the run that was still waiting for them.
  //
  // Below it there is nothing left that can stop this run from starting, so
  // "the new execution actually begins" and "the previous one ends" are one
  // decision taken at one instant, which is what the rule says.
  const previous = await deps.work.pendingSuspensionsFor(event.contactId);
  for (const item of previous) {
    if (item.executionId !== executionId && item.executionId !== null) {
      await deps.work.retirePendingSends(item.executionId, now);
    }
  }

  await supersedePreviousWaits(
    { work: deps.work, audit: deps.audit },
    { contactId: event.contactId, executionId, automationId: automation.id },
    now,
  );

  await execute(deps, {
    automation,
    interaction,
    eventId,
    executionId,
    ...(matchedKeyword !== undefined && { matchedKeyword }),
  });

  return true;
}

/**
 * Offers one event to trigger matching and starts everything it fired
 * (REQ-092), answering whether any run actually began.
 *
 * Reached by three doors since REQ-242, and the answer only matters at one of
 * them: an event with no wait to reach, a message the wait refused, and the
 * message that spent the last question of a wait. The first is the plain case
 * this always was; the other two are the second word the trigger now gets.
 *
 * `recordNoMatch` is what the doors disagree about. An event judged ONLY here
 * owes a row when it fires nothing, or an operator asking why a comment
 * produced no message finds an empty record (REQ-160). A message a wait has
 * already judged has that row: the refusal, or the ending, written with the
 * step and the reason. A second row saying no automation matched would add
 * nothing an operator needs and would make one message look like two events to
 * anyone reading them side by side.
 */
async function offerToTriggers(
  deps: DispatchDeps,
  interaction: InboundInteraction,
  eventId: string,
  { recordNoMatch }: { recordNoMatch: boolean },
): Promise<boolean> {
  const { event } = interaction;
  const stored = await deps.automationAggregates.list();
  const { fired: matched, refused } = matchEvent(
    stored.map((record) => record.definition),
    event,
  );
  // A publication-specific automation owns the comment when both it and an
  // account-wide rule match.  The global is a fallback, not a second reply.
  const hasSpecificMatch =
    event.origin === "comment" &&
    matched.some((item) => item.automation.scope?.type === "publication");
  const fired = hasSpecificMatch
    ? matched.filter((item) => item.automation.scope?.type !== "global")
    : matched;

  if (fired.length === 0) {
    if (recordNoMatch) {
      // An event that fires nothing still leaves a trail (REQ-092). Without it,
      // an operator asking why a comment produced no message finds an empty
      // record and cannot tell a keyword that missed from an event never seen.
      //
      // And it says WHICH reasons, with how many automations in each (REQ-160).
      // The reasons were being computed for every automation and dropped, so
      // the row said "no automation matched" and left the operator with the
      // same question they opened the screen with: a keyword that missed, a
      // comment on another publication and an automation somebody switched off
      // all read the same. ONE row per event, aggregated: with twenty
      // automations and a hundred comments a day, a row per refusal would be
      // two thousand.
      await deps.audit.record(
        {
          kind: "event_received",
          subtype: event.origin,
          outcome: "suppressed",
          contactId: event.contactId,
          eventId,
          reason: encodeNoMatch(refused),
        },
        deps.clock.now(),
      );
    }

    return false;
  }

  let started = false;

  // Sequentially, and every one of them: two automations may legitimately
  // reference the same flow with different values, and both are meant to run
  // (REQ-058). Concurrently would interleave their audit rows into an order no
  // operator could read back.
  for (const { automation, keyword } of fired) {
    if ("state" in automation && automation.state === "active") {
      started =
        (await start(deps, automation, interaction, eventId, keyword)) ||
        started;
    }
  }

  return started;
}

async function handle(
  deps: DispatchDeps,
  interaction: InboundInteraction,
  eventId: string,
): Promise<void> {
  const { event, occurredAt } = interaction;

  /**
   * The receipt itself: one row per accepted interaction, naming what arrived
   * (REQ-036).
   *
   * Without it the origin reaches the trail only where something went wrong or
   * was deliberately not done, so an interaction that simply worked is counted
   * under no type at all. The delivery-level row `webhook.ts` writes cannot
   * fill that gap and is not meant to: the platform batches, one accepted body
   * may carry a comment AND a direct message, and a row about the DELIVERY has
   * no single origin to claim.
   *
   * `ok` is a claim about receipt and nothing else: this interaction was read
   * and accepted for processing. What was then DONE with it is the business of
   * the rows below, which is why a suppression or a failure recorded further
   * down is not a second receipt but an account of the consequence.
   *
   * Exactly one row per interaction, and a redelivery cannot produce a second:
   * the webhook claims the event id before it ever calls this handler and
   * records the repeat as `duplicate` instead, so a delivery the platform
   * sends twice is dispatched once (REQ-004, see `src/http/webhook.ts`).
   *
   * Stamped with the CONTACT's instant rather than ours. Every window in this
   * module already counts from it, and a count of events by hour is about when
   * people interacted, not about when the process got round to them.
   *
   * It is also the row that carries WHAT arrived (REQ-162): the text, and the
   * public identifier when the payload brought one. The receipt is the right
   * row for it and the only one, because it is the trail's record of the
   * arrival itself; the rows written below account for what was then DONE, and
   * repeating the comment on each of them would make one event look like
   * several to anyone reading them side by side.
   */
  await deps.audit.record(
    {
      kind: "event_received",
      subtype: event.origin,
      outcome: "ok",
      contactId: event.contactId,
      eventId,
      // Always written, empty included: an interaction that said nothing (a
      // sticker, an unlabelled button) is a fact, and a row that stored no text
      // at all is a different one.
      eventText: event.text,
      // Only when there is one. A direct message brings none, and the trail
      // says so by having none rather than by inventing one (REQ-162).
      ...(interaction.username !== undefined && {
        contactUsername: interaction.username,
      }),
      // A received comment is itself an analytics fact about this publication.
      // Capture the id from the payload now: resolving it from an automation
      // later would silently reassign history after an edit.
      ...(event.publicationId !== undefined && {
        publicationId: event.publicationId,
      }),
    },
    occurredAt,
  );

  // REQ-095 and REQ-234, and the POSITION is the requirement. The mark
  // records that the contact WROTE, which is a fact about reception; the
  // switches below stop the CONSEQUENCE of an event and never the fact that
  // it arrived, exactly as their own comment says. So the mark is written
  // after the receipt and BEFORE them: an emergency stop that also swallowed
  // it would leave this instance believing a conversation is closed while the
  // platform, which received the very same message, has counted a fresh
  // window from it. REQ-068 would then ask a question it should have
  // suppressed, and the window guard would refuse a send the platform would
  // have accepted.
  //
  // A COMMENT does not mark: commenting does not put the account in the
  // contact's inbox, which is the finding REQ-066 was written from, and
  // marking it would suppress the very question REQ-068 exists for.
  if (event.origin === "direct_message") {
    await deps.conversations.noteInbound(event.contactId, occurredAt);
  }

  // The webhook has already accepted and acknowledged the delivery before the
  // dispatcher is reached. The switch stops the consequence, not reception:
  // leave one explicit suppressed row so an operator can distinguish an
  // emergency stop from a keyword that missed (REQ-205).
  const switches = await deps.triggerSwitches?.read();
  const channelEnabled =
    event.origin === "comment"
      ? switches?.comments.enabled
      : switches?.directMessages.enabled;
  if (switches !== undefined && (!switches.all.enabled || !channelEnabled)) {
    await deps.audit.record(
      {
        kind: "event_received",
        subtype: event.origin,
        outcome: "suppressed",
        contactId: event.contactId,
        eventId,
        reason: !switches.all.enabled
          ? TRIGGER_SWITCH_SUPPRESSIONS.all
          : TRIGGER_SWITCH_SUPPRESSIONS[event.origin],
      },
      deps.clock.now(),
    );
    return;
  }

  // A comment is the first ordinary interaction that can reveal a publication
  // we have not seen yet. Bind before matching, so that same comment is offered
  // to the newly specific automation instead of falling through to a global.
  if (event.origin === "comment" && event.publicationId !== undefined) {
    await deps.automationAggregates.bindPendingToPublication?.(
      event.publicationId,
    );
  }

  // Only a DIRECT MESSAGE can end a wait. A comment cannot, however tempting
  // the literal reading of "any interaction from the contact" is: REQ-066 says
  // the resource goes out only after interaction WITH THAT MESSAGE, and REQ-067
  // spells the interaction out as a button tap or a typed reply, both of which
  // happen in the conversation.
  //
  // The failure this prevents is the whole point of the phase: someone comments
  // the keyword, receives the question, never answers it, comments again on
  // another post, and would be handed the link having consented to nothing. The
  // confirmation would become a formality that anyone can skip by commenting
  // twice.
  //
  // The TEXT travels with the contact id because the wait may have a verdict to
  // pass on it (REQ-022): "did someone answer" and "did they answer THIS
  // question" are different questions, and only the second one can be asked
  // from here.
  const routing =
    event.origin === "direct_message"
      ? await routeInbound(
          {
            work: deps.work,
            clock: deps.clock,
            contacts: deps.contacts,
            audit: deps.audit,
            // REQ-027: the wait at a follow gate is ended by the PLATFORM's
            // answer, not by what the contact wrote, so the routing needs the
            // link the same way the step that suspended did.
            follow: deps.follow,
          },
          { contactId: event.contactId, text: event.text },
        )
      : ({ kind: "match" } as const);

  if (routing.kind === "resume") {
    // Returns HERE, and that return is the requirement (REQ-241): an event the
    // wait ACCEPTED is never also offered to matching. This is the half of the
    // order that protects the contact from receiving the resource twice, and
    // the half that must survive every reading of the one below it.
    await resume(deps, routing.resumed, interaction, eventId);
    return;
  }

  if (routing.kind === "held") {
    // REQ-242, and the POSITION is the requirement: the trigger gets its word
    // BEFORE the question goes back out, never after. A message the wait
    // refused was never an answer, so it is offered to matching as if there
    // were no wait at all, and a trigger that fires ends this wait through the
    // supersession `start` performs (REQ-236). The one exception is a wait that
    // CONSUMED the message: the follow gate answered by its own button asked
    // for the card and is getting it (REQ-246), and offering our own button's
    // words to matching would let them start somebody else's automation.
    const superseded = routing.consumed
      ? false
      : await offerToTriggers(deps, interaction, eventId, {
          recordNoMatch: false,
        });

    // REQ-243, both halves, and neither is a nicety. The question is NOT asked
    // when another automation took the contact: the run that would ask is the
    // run that just ended, so sending it would put a dying automation's words
    // beside the first message of the one that replaced it. And no attempt is
    // spent, because the count pays for a question, and no question went out.
    //
    // Spent immediately BEFORE the send and never before the decision above: a
    // process dying between the two costs one attempt, while the other order
    // costs a question nobody counted, and a re-ask nobody counts has no end.
    // Dying before `spend` costs nothing at all: the row keeps its count and
    // its deadline, and the contact's next message is judged as this one was.
    if (!superseded && routing.reask !== undefined) {
      await routing.reask.spend();
      await askAgain(deps, routing.waiting, routing.reask, interaction);
    }

    return;
  }

  if (routing.kind === "abandoned") {
    // REQ-023: the attempts are spent and the wait ended through the path the
    // flow declared, which the routing recorded naming contact, step and
    // reason. REQ-256: and the contact is told, instead of being dropped into
    // the silence a spent ceiling used to end in.
    await sayGoodbye(deps, routing.waiting, routing.closing, interaction);

    // REQ-244, and it belongs BELOW the send rather than above it: by the time
    // the routing says `abandoned` the wait is already concluded, so what this
    // contact is owed does not depend on a trigger matching afterwards. The
    // answer is ignored on purpose: there is no question left to hold back.
    await offerToTriggers(deps, interaction, eventId, { recordNoMatch: false });
    return;
  }

  // No wait to reach, so matching is the only judgement this event gets, and it
  // owes a row when it fires nothing.
  await offerToTriggers(deps, interaction, eventId, { recordNoMatch: true });
}

export function createDispatcher(deps: DispatchDeps): DispatchHandler {
  return async (payload: unknown, eventId: string): Promise<void> => {
    const receivedAt = deps.clock.now();
    const { interactions, echoes } = translateInbound(payload, receivedAt);
    await recordReceipts(deps.audit, receiptsOf(payload, receivedAt), eventId);

    if (interactions.length === 0) {
      // An echo, and nothing this build could do anything with: no row at all
      // (REQ-161). The platform sends one for every message the application
      // sends, so recording each of them was a line of noise per delivery, and
      // a line that said nothing true: the payload was read perfectly and there
      // was simply nothing in it to dispatch. Worse, it was written with no
      // subtype, so the panel counted every message the account sent as an
      // inbound event of unknown type.
      //
      // The arrival itself is still on the record: the webhook writes a row for
      // the delivery before this handler is ever called (`src/http/webhook.ts`),
      // so silence here loses no fact. What it drops is the claim that
      // something arrived from a contact and produced nothing.
      //
      // A payload that produced no interaction for ANY OTHER reason keeps its
      // row below, and that is the distinction the requirement asks for:
      // silence means understood and nothing to do, a row means this build
      // could read nothing out of it.
      if (echoes > 0) return;

      await deps.audit.record(
        {
          kind: "event_received",
          // NO subtype, and that absence is the honest answer (REQ-106): this
          // build could read nothing out of the payload, so it knows of no
          // comment and of no message. A guess here would put an origin nobody
          // observed into the operator's counts; the reader groups it as
          // unknown instead.
          outcome: "suppressed",
          eventId,
          reason: UNREADABLE_INBOUND_REASON,
        },
        receivedAt,
      );
      return;
    }

    for (const interaction of interactions) {
      await handle(deps, interaction, eventId);
    }
  };
}
