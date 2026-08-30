import type {
  AwaitedAnswer,
  Clock,
  ContactRepo,
  FollowLink,
  FollowStatus,
  Suspender,
  SuspensionRequest,
} from "../engine/ports.js";
import { t } from "../i18n/index.js";
import type { ExecutionOrigin } from "../platform/windows.js";
import type { AuditRepository } from "../storage/audit.js";
import type { ConversationStore } from "../storage/conversations.js";
import type { DurableWorkStore, WorkItem } from "../storage/index.js";
import { isButtonAnswer, readAnswer } from "./answers.js";
import type { SweepOutcome } from "./sweep.js";

/**
 * Waiting for a human, made durable (REQ-022, REQ-025, REQ-026, REQ-067,
 * REQ-068).
 *
 * The wait is a row in the SAME table as the send queue, collected by the same
 * sweep (ADR-005). That is what makes REQ-026 true for free: a suspension is
 * not a promise held in memory that a deploy quietly forgets, it is a record
 * with a due instant, and the process that comes back finds it exactly where
 * the process that died left it.
 *
 * Ending the wait is a VERDICT and not an event (REQ-022). The record carries
 * what the step is waiting for, `routeInbound` judges the answer against it,
 * and only an answer that satisfies it concludes the row. An answer the wait
 * refuses leaves the run at the same step, under the same deadline, and goes on
 * to trigger matching, which may end the run another way (REQ-242).
 *
 * What a refusal MAY move is the count of asks (REQ-023), and the count moves
 * on the record itself. Since REQ-243 it moves when the question is actually
 * SENT, which is the caller's decision and not this module's, so the routing
 * hands back the means of spending it rather than spending it here. That the
 * count lives on the row at all is the same reason the wait is a row: a ceiling
 * of three attempts held in memory is a ceiling that resets at every deploy,
 * and the contact who answers wrongly on either side of a restart would be
 * asked for ever.
 */

export interface SuspensionPayload {
  readonly flowId: string;
  readonly contactId: string;
  readonly stepId: string;
  readonly onTimeout: string;
  /**
   * What ends this wait. Optional ONLY because records written before waits
   * could be conditional carry no such field, and every one of those is a
   * `confirm_optin`, where any answer ends it: `any` is therefore the honest
   * reading of an absent value, not a convenient default.
   */
  readonly expects?: AwaitedAnswer;
  /** The question to put back on the wire when an answer is refused. */
  readonly question?: string;
  /**
   * The words on the button the question went out with, when the button is not
   * what ends the wait (REQ-246).
   *
   * See `SuspensionRequest.buttonLabel` in `../engine/ports.js` for why a card
   * has to be repeated whole, and `buttonOf` below for why a wait the button
   * ANSWERS carries its label inside `expects` and never here.
   */
  readonly buttonLabel?: string;
  /**
   * How many times this step may ask, the first ask included (REQ-023).
   *
   * Absent means the record was written by a step that never re-asks (or
   * before REQ-023 existed), and such a wait ends only at its deadline.
   */
  readonly maxAttempts?: number;
  /**
   * Where the run came from, and when its delivery window counts from
   * (REQ-098, REQ-019, REQ-080).
   *
   * A run resumed by a MESSAGE takes both from the message: the contact wrote
   * now, so now is the only instant a window can honestly be counted from. A
   * run resumed by TIME has no such event, and everything it needs was already
   * true when it started, so the wait carries it. Losing it would resume a
   * comment-born run as if it had come from a direct message, and the message
   * after the pause would be addressed by a contact id the platform refuses.
   *
   * Absent on every record written before pauses existed, and on any wait
   * composed without the run's context. Read as such, never defaulted silently
   * into a claim about a window.
   */
  readonly origin?: ExecutionOrigin;
  /** ISO instant the applicable delivery window counts from. */
  readonly since?: string;
  /** The comment the run answers, when it came from one. */
  readonly commentId?: string;
}

/**
 * What the run was doing when it suspended, so a resume BY TIME can carry it
 * (REQ-098).
 *
 * Handed in at the point the ports are wired rather than travelling through the
 * engine, exactly like the execution id beside it: which comment a run answers
 * and which window it counts from are platform addressing details, and the
 * engine's ignorance of them is the whole of ADR-003.
 */
export interface PausedRunContext {
  readonly origin: ExecutionOrigin;
  /** Instant the applicable delivery window counts from. */
  readonly since: Date;
  readonly commentId?: string;
}

export interface SuspensionDeps {
  readonly work: DurableWorkStore;
  readonly conversations: ConversationStore;
  readonly clock: Clock;
  /** How long a contact's own message keeps the conversation open (REQ-068). */
  readonly messageWindowHours: number;
}

/** Identity of the wait: one execution waits at one step, once. */
function keyOf(executionId: string, stepId: string): string {
  return `suspend:${executionId}:${stepId}`;
}

/** Is this row a declared pause, waiting for the clock and for nobody? */
function pausedByTime(item: WorkItem): boolean {
  return (item.payload as SuspensionPayload).expects === "time";
}

/**
 * The engine's `Suspender`, bound to one run.
 *
 * `executionId` is baked in for the same reason the queueing sender bakes in
 * its context: which run this is belongs to whoever wired the ports, not to the
 * engine, which must stay ignorant of identity it did not invent.
 */
export function createDurableSuspender(
  deps: SuspensionDeps,
  executionId: string,
  /**
   * The run's own context, needed only by a wait that resumes on its own
   * (REQ-098). Optional so every caller that composes a wait for a human keeps
   * working unchanged: none of them reads it.
   */
  context?: PausedRunContext,
): Suspender {
  return {
    async suspend(request: SuspensionRequest): Promise<void> {
      const payload: SuspensionPayload = {
        flowId: request.flowId,
        contactId: request.contactId,
        stepId: request.stepId,
        onTimeout: request.onTimeout,
        expects: request.expects,
        origin: context?.origin,
        since: context?.since.toISOString(),
        commentId: context?.commentId,
        // What the wait needs in order to ask again (REQ-023). It is stored
        // WITH the record rather than looked up when the moment comes: the
        // definition can be edited while the contact is answering, and the
        // question a run repeats must be the one it actually asked. The button
        // is stored for the same reason and one more (REQ-246): its words come
        // from the instance's settings, which an operator can rename while this
        // contact is looking at the old card.
        question: request.question,
        buttonLabel: request.buttonLabel,
        maxAttempts: request.maxAttempts,
      };

      await deps.work.enqueue(
        {
          kind: "suspension",
          dedupeKey: keyOf(executionId, request.stepId),
          payload,
          dueAt: request.expiresAt,
          contactId: request.contactId,
          executionId,
        },
        deps.clock.now(),
      );
    },

    async isConversationOpen(contactId: string): Promise<boolean> {
      const last = await deps.conversations.lastInboundAt(contactId);
      if (last === undefined) {
        return false;
      }

      const elapsed = deps.clock.now().getTime() - last.getTime();
      return elapsed <= deps.messageWindowHours * 60 * 60 * 1000;
    },
  };
}

/** One execution, waiting at one step. What the verdict is about. */
export interface WaitingExecution {
  readonly executionId: string;
  readonly flowId: string;
  readonly contactId: string;
  /** The step it waited at. A resumed run continues at the one after it. */
  readonly stepId: string;
}

export interface ResumeDeps {
  readonly work: DurableWorkStore;
  readonly clock: Clock;
  /**
   * Where an accepted answer's value is written. Required, unlike the trail
   * below: a wait whose answer produces an attribute and cannot store it would
   * resume having silently thrown away the thing it asked for.
   */
  readonly contacts: ContactRepo;
  /** Optional so a unit test can drive resumption without a trail. */
  readonly audit?: AuditRepository;
  /**
   * Asks the platform again whether the contact follows (REQ-027).
   *
   * Optional exactly as it is on the engine's ports, and read the same way: an
   * absent link is one more reason the question has no answer, and a wait that
   * needs one then stays shut. It is never treated as a yes.
   */
  readonly follow?: FollowLink;
}

/** The contact's answer, as the thing that has to be judged. */
export interface InboundAnswer {
  readonly contactId: string;
  /** What they wrote, or the label of the button they tapped. May be empty. */
  readonly text: string;
}

/** A question going back out, because the answer was not one (REQ-023). */
export interface ReaskRequest {
  /** The words the run asked the first time. */
  readonly question: string;
  /**
   * The button that went out with them, when the question carried one
   * (REQ-246, REQ-251).
   *
   * The caller MUST put it back on the card. A quick reply lives on the most
   * recent message of the conversation, so by the time this is being decided
   * the contact has written and the button is gone from their screen: sending
   * the words alone would repeat a question they still cannot answer.
   */
  readonly buttonLabel?: string;
  /** The button belongs inside a generic-template card (ADR-027). */
  readonly cardButton?: boolean;
  /**
   * Which ask this is, the first one included: the second question is attempt
   * 2. The caller has to carry it into the send, or the queue recognises the
   * repeat as work it has already done (see `dedupeKeyFor` in `outbox.ts`).
   */
  readonly attempt: number;
  /**
   * Counts this ask on the durable record, and the caller MUST await it
   * IMMEDIATELY BEFORE the send (REQ-243).
   *
   * It used to happen inside the routing, and it could not stay there. A
   * refused message now goes on to trigger matching (REQ-242), and an ask spent
   * before that decision would be an ask spent on a question that never went
   * out, taken from a contact whose run was ending anyway.
   *
   * The ORDER the caller keeps is the safe one and the reason is unchanged: a
   * process dying between the count and the send costs the contact one ask,
   * while the opposite order costs a question nobody counted, and a re-ask
   * nobody counts has no end. Dying between the trigger decision and this call
   * costs neither: the row keeps its count and its deadline, so the contact's
   * next message is judged exactly as this one would have been.
   *
   * A closure rather than a number the caller writes back, because what has to
   * move is the work row this routing found, and re-finding it would be a
   * second lookup that may land on a different wait.
   */
  readonly spend: () => Promise<void>;
}

/**
 * The goodbye owed to a contact whose questions ran out (REQ-256).
 *
 * It carries an ORDINAL and no words, and the split is deliberate. WHAT to say
 * is the instance's setting, which the caller reads when it composes the send
 * (see `sayGoodbye` in `dispatch.ts`); what nobody outside this module can work
 * out is WHICH ask this message comes after, and that is what the caller has to
 * put into the send. Without it the queue may recognise the goodbye as work it
 * already holds (see `dedupeKeyFor` in `outbox.ts`): it leaves from the same
 * run and the same step as every question before it, so nothing inside it is
 * guaranteed to tell the two apart, and a send dropped for that reason fails
 * silently.
 */
export interface ClosingRequest {
  /**
   * The ask this message comes after: with three questions asked, it is 4. No
   * card ever went out under that number, so the goodbye cannot collide with
   * any question this step put on the wire, whatever its words turn out to be.
   */
  readonly attempt: number;
}

/**
 * What an inbound message from a contact should do.
 *
 * Two rules live in this type, and both are requirements rather than details.
 *
 * The first is ORDER, and the order is the requirement (REQ-241, REQ-242): the
 * wait has the FIRST word and the trigger has the SECOND. A message the wait
 * ACCEPTED (`resume`) must NOT also be offered to trigger matching, or the
 * answer that should unblock a run starts a second run beside it and the
 * contact receives the resource twice, which is the protection of REQ-067 and
 * the expensive half to lose. A message the wait REFUSED goes on to matching as
 * if there were no wait at all, and if a trigger takes it the waiting run ends
 * and the new one begins: it was never an answer, and leaving it stuck to a
 * conversation the contact has moved on from is what this replaces.
 *
 * `held` therefore says whether the wait CONSUMED the message, and the caller
 * cannot work that out from anything else here. The one wait that consumes what
 * it refuses is the follow gate answered by its own button (REQ-246): that
 * message is a request addressed to the wait, the wait serves it by sending the
 * card again, and offering it to matching afterwards would let the words
 * printed on our own button start somebody else's automation.
 *
 * The second is the VERDICT (REQ-022): reaching a wait is not the same as
 * ending it. `resume` means the answer was what the step asked for and the run
 * continues at the next step; `held` means it was not, and the run stays
 * suspended at the same step, under the same deadline, one attempt poorer once
 * the caller spends it.
 *
 * Expressed as a function rather than as a comment so a dispatcher cannot
 * honour it by accident and break it by accident either.
 *
 * `abandoned` is the third way a wait can end, and it belongs to REQ-023: the
 * answer was refused and there was no attempt left to spend, so the run ends
 * through the path the flow declared. It is a case of its own rather than a
 * `held` with a flag, because the run is over and a caller that treated it as
 * still-waiting would leave a contact suspended on a wait nothing can end.
 *
 * It is also the one ending that OWES the contact a message (REQ-256), and the
 * caller must send it: the run stops here, and a contact who answered until the
 * questions ran out is otherwise left waiting for a reply that no longer has
 * anything to come from. That message is owed whatever a trigger does with the
 * same words afterwards (REQ-244), because by the time this ending is reached
 * the wait is already concluded.
 */
export type InboundRouting =
  | { readonly kind: "resume"; readonly resumed: WaitingExecution }
  | {
      readonly kind: "held";
      readonly waiting: WaitingExecution;
      readonly reason: string;
      /**
       * Whether the wait took this message for itself (REQ-242).
       *
       * `false` is the ordinary case and the requirement: the wait refused the
       * message, so the caller MUST offer it to trigger matching, and a trigger
       * that fires ends this wait through the supersession every starting run
       * performs. `true` is the follow gate answered by its own button, which
       * asked for the card and is getting it.
       */
      readonly consumed: boolean;
      /**
       * Set when there is a question left to put back on the wire (REQ-023).
       *
       * The caller sends it only after trigger matching has taken nothing
       * (REQ-243), and spends it (`spend` above) immediately before the send.
       * Sending it anyway would put the question of a dying run beside the
       * first message of the run that just replaced it.
       */
      readonly reask?: ReaskRequest;
    }
  | {
      readonly kind: "abandoned";
      readonly waiting: WaitingExecution;
      readonly reason: string;
      /**
       * The goodbye this ending owes (REQ-256). The caller MUST send it, and
       * under the identity carried here.
       */
      readonly closing: ClosingRequest;
    }
  | { readonly kind: "match" };

/**
 * Judges one inbound message against the wait it found, if it found one.
 *
 * The caller must offer EVERY inbound message here BEFORE matching triggers,
 * and must skip trigger matching for `resume` and for a `held` the wait
 * consumed. Everything else goes on to matching (REQ-242, REQ-244).
 *
 * Concluding the row before the run resumes is deliberate: a redelivered
 * message must not resume the same wait twice, and `complete` is what makes the
 * second attempt find nothing. A REFUSED answer concludes the row only when it
 * was the last attempt the flow allowed (`refuse` below); short of that it
 * leaves the contact waiting at the same step, with the deadline still counting
 * from where it was.
 */
export async function routeInbound(
  deps: ResumeDeps,
  answer: InboundAnswer,
): Promise<InboundRouting> {
  const now = deps.clock.now();
  // Asked about the CONTACT, never by reading the queue (REQ-235). The lookup
  // used to scan the hundred soonest-due pending rows, and a wait sorts to the
  // tail of that order by construction: a send is due now, a wait is due in
  // hours. A hundred pending sends hid every wait, the message fell through to
  // trigger matching, and a contact who had confirmed nothing was handed the
  // resource. Waits that have not come due yet are exactly the ones still
  // waiting, so the query asks for PENDING and not for due.
  const pending = await deps.work.pendingSuspensionsFor(answer.contactId);

  const item = pending.find(
    (candidate) =>
      // A pause is not waiting for this contact (REQ-098), so their message is
      // none of its business. Reading it as a wait would cut the pause short
      // on a message that answered nothing, and would put a re-ask of a
      // question nobody was asked in front of the contact.
      !pausedByTime(candidate),
  );

  if (item === undefined) {
    return { kind: "match" };
  }

  const payload = item.payload as SuspensionPayload;
  const waiting: WaitingExecution = {
    executionId: item.executionId ?? "",
    flowId: payload.flowId,
    contactId: payload.contactId,
    stepId: payload.stepId,
  };
  const expects = payload.expects ?? "any";

  // Judged BEFORE `readAnswer` is ever asked, because `readAnswer` reads text
  // and text cannot answer this question (REQ-027). What the contact wrote is
  // only the occasion to ask the platform again; the platform's answer is the
  // verdict.
  if (expects === "follow") {
    return await recheckFollow(deps, item, payload, waiting, answer.text, now);
  }

  const verdict = readAnswer(expects, answer.text);

  if (verdict.kind === "rejected") {
    return await refuse(deps, item, payload, waiting, now);
  }

  // Written BEFORE the wait is concluded and before the run resumes: the steps
  // after this one are entitled to read what the contact just gave, and a value
  // stored after they ran would be a value they could not see.
  if (verdict.attribute !== undefined) {
    await deps.contacts.setAttribute(
      payload.contactId,
      verdict.attribute.key,
      verdict.attribute.value,
    );
  }

  return await concludeAndResume(deps, item, payload, waiting, now);
}

/** Ends the wait and hands the run back to the caller to pick up (REQ-067). */
async function concludeAndResume(
  deps: ResumeDeps,
  item: WorkItem,
  payload: SuspensionPayload,
  waiting: WaitingExecution,
  now: Date,
): Promise<InboundRouting> {
  await deps.work.complete(item.id, now);

  // The consumption is on the record: without it, an operator looking at why a
  // message produced no new execution would find nothing at all.
  //
  // `direct_message` is a fact and not an assumption here, as it is on every
  // event this module records (REQ-106): only a direct message is ever offered
  // to a wait, because a comment cannot end one (see `handle` in dispatch.ts).
  await deps.audit?.record(
    {
      kind: "event_received",
      subtype: "direct_message",
      outcome: "suppressed",
      contactId: payload.contactId,
      flowId: payload.flowId,
      stepId: payload.stepId,
      reason: t("suspension.consumedByResume"),
    },
    now,
  );

  return { kind: "resume", resumed: waiting };
}

/**
 * The words on the button this wait's card carried, if it carried one.
 *
 * TWO waits send a button and only one of them is ANSWERED by it, so the label
 * lives in two different places on purpose. The confirmation's is inside
 * `expects`, because there it is the verdict: a record declaring a button and
 * keeping its words somewhere else could end up judging an answer against a
 * label that is not the one on the card. The follow gate's button opens
 * nothing (REQ-027), so it has nowhere to live but a field of its own, and
 * reading both from here is what keeps the resend from needing to know which
 * step it is repeating.
 */
function buttonOf(payload: SuspensionPayload): string | undefined {
  const expects = payload.expects;

  return typeof expects === "object" ? expects.label : payload.buttonLabel;
}

/**
 * The card this wait would put back on the wire, if it has one to put.
 *
 * Nothing at all to say is the one case that must NOT produce a send: a wait
 * with no question and no button would message the contact an empty line. A
 * wait with a BUTTON and no words still has something to send, and sending it
 * is the point: what the contact lost was the button, not the sentence.
 */
function cardOf(
  payload: SuspensionPayload,
): { question: string; buttonLabel?: string } | undefined {
  const question = payload.question ?? "";
  const buttonLabel = buttonOf(payload);

  if (question === "" && buttonLabel === undefined) {
    return undefined;
  }

  return { question, ...(buttonLabel !== undefined && { buttonLabel }) };
}

/**
 * Which ask the NEXT card of this wait is, counting the first one.
 *
 * The number has to reach the queue or the send is dropped in silence, because
 * a repeated card is word for word the message the first ask queued, from the
 * same run and the same step (see `dedupeKeyFor` in `outbox.ts`). `attempts` is
 * zero on the row the suspension wrote, so the first repeat is ask number two.
 *
 * On the follow gate it is a serial number and nothing else (REQ-317): it only
 * ever goes up, no ceiling is read against it, and the deadline is what ends
 * the loop.
 */
function nextAsk(item: WorkItem): number {
  return item.attempts + 2;
}

/**
 * Asking the platform again, because the contact wrote (REQ-027).
 *
 * The re-ask is the point of the step. A single query when the gate was reached
 * could only ever say no: the contact has not been asked to follow yet. So the
 * question is put again at EVERY interaction, and the interaction that finds a
 * follower is the one that ends the wait.
 *
 * What it does NOT do is spend a ceiling. Attempts count wrong ANSWERS
 * (REQ-023), and here the contact has not answered anything wrongly: they
 * wrote while not yet following. Counting their messages against a limit would
 * let a chatty contact exhaust a gate they were about to pass, on a count they
 * cannot influence by answering better, so the wait this step writes carries no
 * `maxAttempts` and nothing here reads one. Only the deadline ends it
 * (REQ-025, REQ-246).
 *
 * What it does do is put the card back after EVERY textual interaction that
 * still finds a non-follower (REQ-341). The contact's message removes the
 * button from their screen; leaving the wait open without restoring it makes
 * the gate a dead end. This wait owns that interaction, rather than offering
 * it to trigger matching first: a winning trigger would otherwise supersede
 * the wait and silently suppress the very card that gives the contact a way
 * forward.
 *
 * The tap is not distinguishable from the same words typed out, by the
 * platform's own design: a postback comes back as its button's TITLE and a
 * quick reply comes back as message text (`postbackOf` in `dispatch.ts`). So
 * the rule is written over the TEXT, through the one comparison both button
 * steps share (REQ-248). Someone who types the label by hand is served too, and
 * that is a good consequence to keep rather than an accident to close.
 *
 * The row's `attempts` counter moves with each card, spent by the caller as it
 * sends (`spend` on the re-ask), and it is a serial number here rather than a
 * budget: it is what makes the second card a different row in the queue instead
 * of a duplicate the queue drops in silence (REQ-247, registered again as
 * REQ-317).
 */
async function recheckFollow(
  deps: ResumeDeps,
  item: WorkItem,
  payload: SuspensionPayload,
  waiting: WaitingExecution,
  text: string,
  now: Date,
): Promise<InboundRouting> {
  const status: FollowStatus =
    deps.follow === undefined
      ? { kind: "unknown", cause: "not_configured" }
      : await deps.follow.status(payload.contactId);

  if (status.kind === "follows") {
    return await concludeAndResume(deps, item, payload, waiting, now);
  }

  // Everything else holds the gate, the unanswerable query included. The two
  // mistakes are not the same size: opening for someone who does not follow
  // hands over a resource that cannot be recalled, while holding costs the
  // contact one more message of theirs to be re-checked on.
  const card = cardOf(payload);
  // The card this message ASKED for, or nothing at all. The comparison is the
  // one both steps that send a button use (REQ-248) and never a second copy of
  // it: two definitions of what counts as tapping would drift, and the one
  // that drifted would strand the contact who typed the words out by hand.
  const tapped =
    card?.buttonLabel !== undefined && isButtonAnswer(card.buttonLabel, text);
  const reask =
    card === undefined
      ? undefined
      : {
          ...card,
          // The second card must name the result of THIS query rather than
          // repeat the first invitation as if no check had happened (REQ-343).
          question:
            status.kind === "does_not_follow"
              ? t("follow.stillNotFollowingRecheck")
              : t("follow.notVerifiedRecheck"),
          cardButton: true,
        };

  let reason: string;
  if (status.kind === "does_not_follow") {
    reason = tapped
      ? t("follow.stillNotFollowingResent")
      : t("follow.stillNotFollowing");
  } else {
    // One placeholder for the cause, carrying whatever the platform said about
    // it. Two would leave a dangling "( : )" in every sentence about a cause
    // that came with no detail, in every language.
    const cause =
      status.detail === undefined
        ? status.cause
        : `${status.cause}: ${status.detail}`;

    reason = tapped
      ? t("follow.notVerifiedResent", { cause })
      : t("follow.notVerified", { cause });
  }

  await deps.audit?.record(
    {
      kind: "event_received",
      subtype: "direct_message",
      outcome: "suppressed",
      contactId: payload.contactId,
      flowId: payload.flowId,
      stepId: payload.stepId,
      reason,
    },
    now,
  );

  return reask === undefined
    ? { kind: "held", waiting, reason, consumed: false }
    : {
        kind: "held",
        waiting,
        reason,
        consumed: true,
        reask: {
          ...reask,
          attempt: nextAsk(item),
          // The DEADLINE is passed back unchanged: this wait ends when the
          // operator's hours run out and at no other moment, and `defer` is
          // being used here only for the count it keeps.
          spend: () => deps.work.defer(item.id, item.dueAt, now, reason),
        },
      };
}

/**
 * What happens to an answer the wait would not take (REQ-023).
 *
 * Three outcomes, and what separates them is a NUMBER that has to outlive the
 * process: how many times this wait has already asked. It lives in the work
 * row's own `attempts` column and is moved by the same `defer` the send queue
 * uses (by the caller now, as it sends: see `spend` on `ReaskRequest`), so
 * there is ONE durable mechanism here and not a second one (ADR-005).
 * A counter held in memory would start again from zero at every deploy, and a
 * contact who answers wrongly, waits through a restart and answers wrongly
 * again would have attempts without end: `max_attempts` would be a suggestion,
 * which is exactly what it was before this function existed.
 */
async function refuse(
  deps: ResumeDeps,
  item: WorkItem,
  payload: SuspensionPayload,
  waiting: WaitingExecution,
  now: Date,
): Promise<InboundRouting> {
  // The ask this answer is answering: the first one, plus one per re-ask
  // already sent. `attempts` is zero on the row the suspension wrote, so the
  // very first answer is answering ask number one.
  const asked = item.attempts + 1;
  const limit = payload.maxAttempts;
  // The whole card and not only the words (REQ-251): the confirmation is
  // answered by tapping its button, and the button is exactly what the
  // contact's own message took off their screen.
  const card = cardOf(payload);

  // No ceiling declared, or nothing to put back on the wire: the answer is
  // refused and the run stays exactly where it was, which is everything a wait
  // could do before REQ-023. Giving up on a count the flow did not write down
  // would be a harsher rule than the operator asked for, and re-asking with
  // nothing to say would send the contact an empty message.
  if (limit === undefined || card === undefined) {
    const reason = t("suspension.answerRefused");

    // On the record for the same reason the consumption is: an operator asking
    // why a contact who answered received nothing must find the answer, not an
    // absence.
    await deps.audit?.record(
      {
        kind: "event_received",
        subtype: "direct_message",
        outcome: "suppressed",
        contactId: payload.contactId,
        flowId: payload.flowId,
        stepId: payload.stepId,
        reason,
      },
      now,
    );

    return { kind: "held", waiting, reason, consumed: false };
  }

  if (asked >= limit) {
    // Concluded here rather than left to the deadline: a row left pending
    // would bring the sweep back hours later to record a deadline that was
    // never reached, and the contact would keep an execution open with nothing
    // left that could end it.
    await deps.work.complete(item.id, now);

    const reason = t("suspension.attemptsExhausted", {
      attempts: asked,
      policy: payload.onTimeout,
    });
    await recordWaitEnded(deps.audit, payload, reason, now);

    // REQ-256: the ceiling is spent, and the contact is told rather than left
    // in silence. The ordinal is the one the next question would have carried,
    // because that is the one number no card of this step ever used.
    return {
      kind: "abandoned",
      waiting,
      reason,
      closing: { attempt: nextAsk(item) },
    };
  }

  const attempt = nextAsk(item);
  const reason = t("suspension.answerRefusedAsking", { attempt, max: limit });

  // The refusal is on the record HERE, because the wait judging this message
  // and saying no is a fact already settled: an operator asking why a contact
  // who wrote back received nothing must find it. What the row does NOT claim
  // is that the question went out, because that is no longer decided here
  // (REQ-243): the message goes on to trigger matching first, and the sentence
  // says so.
  await deps.audit?.record(
    {
      kind: "event_received",
      subtype: "direct_message",
      outcome: "suppressed",
      contactId: payload.contactId,
      flowId: payload.flowId,
      stepId: payload.stepId,
      reason,
    },
    now,
  );

  return {
    kind: "held",
    waiting,
    reason,
    consumed: false,
    reask: {
      ...card,
      attempt,
      // Counted by the caller, immediately before the question goes out and
      // never before the trigger decision (REQ-243): a message that started
      // another automation costs this contact nothing, because the run that
      // would have asked again is the one that just ended. The DEADLINE is
      // passed back unchanged: a contact answering wrongly must not be able to
      // hold the execution open past what the flow allowed, and `defer` is only
      // being used here for the count it keeps.
      spend: () => deps.work.defer(item.id, item.dueAt, now, reason),
    },
  };
}

/**
 * The record of a wait that ended with nothing delivered (REQ-023, REQ-025,
 * REQ-238).
 *
 * THREE different facts end a wait this way now. Two of them take the path the
 * FLOW declared, and the flow declares ONE path for both, which is a decision
 * rather than an omission: the deadline passing and the attempts running out
 * are the same fact to the flow, the contact did not do their part, and a
 * second declared path would mean changing the v1 schema every stored flow is
 * written in. The third takes no declared path at all: a supersession ends the
 * run because another automation took the contact, and `on_timeout` has nothing
 * to say about that.
 *
 * What must NOT be the same is the SENTENCE. An operator asking why a contact
 * received nothing has to be able to tell "they never answered" from "they
 * answered three times and never with an address" from "they went to another
 * automation", because the three say different things about the question the
 * flow is asking and about what to do next. So the reason is a parameter and
 * everything else is shared: same kind, same outcome, same contact, flow and
 * step, one sentence apart.
 *
 * `wait_ended` rather than the subtype of the step that was waiting (REQ-106):
 * what this row records is the wait being closed, and THIS row sends nothing.
 * Calling it a message sent would add a message to the operator's count that no
 * contact ever received. The goodbye one of the three endings then queues
 * (REQ-256) is a send of its own, counted where every other send is.
 */
async function recordWaitEnded(
  audit: AuditRepository | undefined,
  payload: SuspensionPayload,
  reason: string,
  now: Date,
): Promise<void> {
  await audit?.record(
    {
      kind: "action_executed",
      subtype: "wait_ended",
      outcome: "suppressed",
      contactId: payload.contactId,
      flowId: payload.flowId,
      stepId: payload.stepId,
      reason,
    },
    now,
  );
}

export interface SupersessionDeps {
  readonly work: DurableWorkStore;
  /**
   * Required, unlike on the routing above: the record IS the requirement here
   * (REQ-238). A caller that could end somebody's execution with no line
   * anywhere would leave an operator with a contact who received nothing and a
   * trail with nothing to say about it.
   */
  readonly audit: AuditRepository;
}

/** The run taking the contact over, as the endings it causes have to name it. */
export interface SupersedingRun {
  readonly contactId: string;
  /** The run about to begin. Its own rows are not a previous execution's. */
  readonly executionId: string;
  /** Who took the contact, for whoever reads the ending afterwards. */
  readonly automationId: string;
}

/**
 * The contact belongs to the run that is starting, and every wait an earlier
 * run left them in ends here (REQ-236, REQ-238).
 *
 * Which automation a contact belongs to used to be decided by an accident of
 * configuration. Two runs could hold the same person at once, because a comment
 * is never offered to a wait: someone comments on publication A, is asked a
 * question and goes quiet, then comments on publication B and is asked another.
 * When they finally wrote, the answer went to whichever wait came due soonest,
 * which with equal deadlines is the OLDEST one. They answered thinking of B and
 * received the material of A. The rule is now one sentence: the last automation
 * triggered holds the contact, and what was holding them before ends at the
 * step it was waiting on, having delivered nothing.
 *
 * A declared PAUSE ends too, and that is a decision rather than an oversight
 * (REQ-098). `routeInbound` leaves a pause alone because a pause waits for
 * nobody, so a message from the contact is none of its business. Supersession
 * asks a different question: not who is being waited for, but which automation
 * owns the contact. A run left paused comes back on a clock of its own, hours
 * after the contact moved on, and hands over the material of the automation
 * they left. That is the very failure this exists to stop, arriving through the
 * one door nobody knocks on.
 *
 * What it does NOT touch is the QUEUE. Sends the superseded run already decided
 * were decided before this event existed and are promises already made, so they
 * go out as queued (phase 3l spec, assumed premise 2). What ends here is the
 * run's ability to ADVANCE.
 */
export async function supersedePreviousWaits(
  deps: SupersessionDeps,
  starting: SupersedingRun,
  now: Date,
): Promise<void> {
  const pending = await deps.work.pendingSuspensionsFor(starting.contactId);
  const reason = t("suspension.superseded", {
    automation: starting.automationId,
  });

  for (const item of pending) {
    // The same run rather than a previous one, which two events of one
    // automation reaching the same instant produce (see `executionIdFor` in
    // dispatch.ts): a run must never end its own wait.
    if (item.executionId === starting.executionId) continue;

    const payload = item.payload as SuspensionPayload;

    // Concluded FIRST and recorded after, exactly as the spent attempts are: a
    // process dying in between costs the trail one line about a wait that is
    // genuinely over, while the other order would claim an ending for a wait
    // the sweep still holds and can still resume.
    await deps.work.complete(item.id, now);
    await recordWaitEnded(deps.audit, payload, reason, now);
  }
}

export interface TimeoutDeps {
  readonly audit: AuditRepository;
  readonly clock: Clock;
  /**
   * Picks a PAUSED run back up when its deadline passes (REQ-098).
   *
   * A function rather than the dispatcher itself, and the direction is the
   * reason: this module knows that a wait came due, and what it means to run
   * the step after it belongs to whoever owns flows and automations (see
   * `dispatch.ts`). Optional in the type and required in practice for any build
   * that offers the pause: a sweep composed without it is a wiring mistake, and
   * the handler says so loudly rather than concluding a row whose run nobody
   * continued.
   */
  readonly resume?: (item: WorkItem) => Promise<void>;
}

/**
 * The sweep handler for a wait whose deadline arrived (REQ-025, REQ-098).
 *
 * TWO endings, and they are opposites. A wait for a human that ran out ends the
 * execution through the path the FLOW declared, rather than through a behaviour
 * chosen here: `on_timeout` is the operator's decision about what happens to
 * someone who never answered, and the engine is not entitled to overrule it. A
 * PAUSE that came due ends nothing at all: nobody was asked, so nobody failed
 * to answer, and the deadline is simply the instant the run carries on.
 *
 * Neither of them says goodbye, and that is a decision rather than an omission
 * (REQ-256). The closing message goes out where the questions RUN OUT (see
 * `refuse` above and `sayGoodbye` in `dispatch.ts`), because there the contact
 * has just written and their own message has renewed the delivery window. Here
 * nobody has written for hours: on a run born from a direct message the send
 * would reach the platform at the edge of the window it needs, so the one
 * ending that cannot be delivered is exactly this one.
 */
export function createSuspensionTimeoutHandler(deps: TimeoutDeps) {
  return async (item: WorkItem): Promise<SweepOutcome> => {
    const payload = item.payload as SuspensionPayload;

    if (pausedByTime(item)) {
      if (deps.resume === undefined) {
        // Not a catalogue message, and no operator ever sees it: it says this
        // process composed a sweep that can pause a run and cannot continue
        // one, which is a wiring error. Thrown rather than swallowed, so the
        // row is marked failed carrying the reason instead of being concluded
        // over a run that stopped halfway.
        throw new Error(
          `durable work ${String(item.id)} is a paused execution and this sweep has no resume wired`,
        );
      }

      await deps.resume(item);

      // Concluded only after the run was handed on. A process that dies in
      // between leaves the row pending and the next sweep resumes it again,
      // which is safe rather than duplicate: the resumed run keeps the
      // execution id its sends are keyed on, so the queue recognises a message
      // it already holds (see `dedupeKeyFor` in `outbox.ts`).
      return { kind: "done" };
    }

    const now = deps.clock.now();

    // The same ending the spent attempts take, told apart by its reason alone.
    await recordWaitEnded(
      deps.audit,
      payload,
      t("suspension.timedOut", { policy: payload.onTimeout }),
      now,
    );

    // Concluded, not failed: the wait did exactly what it was told to do.
    return { kind: "done" };
  };
}
