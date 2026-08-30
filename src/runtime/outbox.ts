import type {
  ButtonLinkWriter,
  Clock,
  OutboundMessage,
  Sender,
} from "../engine/ports.js";
import type { SendPayload } from "../platform/sender.js";
import type { ExecutionOrigin } from "../platform/windows.js";
import type {
  DurableWorkStore,
  SendClass,
  WorkItem,
} from "../storage/index.js";

/**
 * The engine's `Sender`, implemented as an enqueue rather than a call.
 *
 * This is what makes REQ-016 true for every message the engine decides: the
 * engine hands over an intent, the intent becomes a persisted row, and the
 * sweep delivers it — surviving a restart in between. A sender that called the
 * platform inline would put an unbounded network wait inside the step loop, and
 * lose the message entirely if the process died mid-call.
 *
 * The run's context (where it came from, which comment, when the interaction
 * happened) is baked in at construction. The engine never learns it, because a
 * `comment_id` recipient is a platform addressing detail and the engine's
 * ignorance of such things is the whole of ADR-003.
 */

export interface OutboxContext {
  /** Automation provenance required by attributed card destinations. */
  readonly automationId?: string;
  readonly origin: ExecutionOrigin;
  /** The comment that started the run, when one did. */
  readonly commentId?: string;
  /** Instant the applicable delivery window counts from. */
  readonly since: Date;
  /** Ties queued work back to its run, for suspension and for the trail. */
  readonly executionId: string;
  /**
   * Which attempt of a repeated question these sends belong to (REQ-023).
   *
   * Absent, or 1, is the first pass through the step and the ordinary case.
   * See `dedupeKeyFor` below for why anything queued for a second attempt
   * cannot share the first attempt's identity.
   */
  readonly attempt?: number;
  /**
   * The instant before which NO send of this run may leave (REQ-277).
   *
   * The automation's wait, expressed where a wait costs nothing: a due instant
   * on a durable row, collected by the sweep (ADR-005). The messages are
   * composed and persisted the moment the trigger fires, exactly as before, and
   * only their DELIVERY is held, so a restart during the wait loses neither the
   * decision nor the text.
   *
   * A floor and not a schedule: `followerDueAt` below already puts the second
   * message of a delivery behind the first, and that offset is measured from
   * what is queued, so the two compose without either knowing about the other.
   *
   * Absent is the ordinary context, and every caller that is not the FIRST pass
   * of a run leaves it absent: what the requirement holds back is the reply to
   * the trigger, never the answer to a contact who has just written.
   */
  readonly notBefore?: Date;
}

export interface OutboxDeps {
  readonly work: DurableWorkStore;
  readonly clock: Clock;
  readonly buttonLinks?: ButtonLinkWriter;
}

/**
 * A message with an attachment is metered under the platform's tighter
 * per-second quota; text and links are not. Getting this wrong does not fail
 * loudly, it just spends the wrong budget.
 *
 * What follows the attachment is the private-reply ceiling of 750/h, and it is
 * spent by the sends that actually TRAVEL as private replies — not by every
 * send of a comment-born run, which would charge the tight ceiling for messages
 * addressed by contact id.
 */
function classOf(message: OutboundMessage, privateReply: boolean): SendClass {
  if (message.attachment !== undefined) {
    return "media";
  }
  return privateReply ? "private_reply" : "direct_message";
}

/**
 * How long a message waits behind the one it follows (REQ-231, REQ-286).
 *
 * A delivery with a text and a pure link is two sends, and both are queued in
 * the same instant by the same step. The sweep takes everything due in one pass
 * and hands it to the adapter back to back (`src/runtime/sweep.ts`), so with no
 * offset the two would leave in the same second — which is the signature a spam
 * filter looks for, and which reads to a person as a machine firing rather than
 * as someone writing to them.
 *
 * Two seconds, and it is a due INSTANT rather than a sleep. Sleeping is what
 * this product refuses to do with a wait: REQ-098's pause is a durable row with
 * a deadline for exactly this reason, because a `setTimeout` inside the step
 * loop would hold the run, would not survive a restart, and — here — would not
 * delay the send at all, since the `Sender` is an enqueue and the sweep is what
 * delivers. The offset is smaller than the sweep interval, so the message that
 * follows simply is not due in the pass that sends the one before it.
 *
 * Not configurable, for the reason `UNCERTAIN_DELIVERY_ATTEMPTS` in
 * `src/runtime/policy.ts` is not: this is not a tuning knob, it is the line
 * between two messages and one burst, and an operator lowering it to zero would
 * be choosing the burst without meaning to.
 *
 * It was `ATTACHMENT_PAUSE_MS` until phase 3n, when the attachment left the
 * format (REQ-284) and the pure link made a delivery several messages again
 * (REQ-286). The rule never was about attachments: it is about two messages of
 * ONE delivery reaching a person one after the other.
 */
export const MESSAGE_PAUSE_MS = 2000;

export function createQueueingSender(
  deps: OutboxDeps,
  context: OutboxContext,
): Sender {
  async function enqueue(
    payload: SendPayload,
    step: string,
    sendClass: SendClass,
    dueAt?: Date,
  ): Promise<void> {
    const contactId = payload.contactId;
    const automationId = context.automationId;
    const message = payload.message;
    const attributedPayload =
      message.card !== undefined &&
      contactId !== undefined &&
      automationId !== undefined &&
      deps.buttonLinks !== undefined
        ? {
            ...payload,
            message: {
              ...message,
              card: {
                ...message.card,
                buttons: await deps.buttonLinks.wrap(
                  message.card.buttons,
                  {
                    automationId,
                    contactId,
                    executionId: context.executionId,
                  },
                  deps.clock.now(),
                ),
              },
            },
          }
        : payload;

    const due = held(dueAt);

    await deps.work.enqueue(
      {
        kind: "send",
        dedupeKey: dedupeKeyFor(context, step),
        payload: attributedPayload,
        ...(attributedPayload.contactId !== undefined && {
          contactId: attributedPayload.contactId,
        }),
        executionId: context.executionId,
        sendClass,
        ...(due !== undefined && { dueAt: due }),
      },
      deps.clock.now(),
    );
  }

  /**
   * The automation's wait applied to one send (REQ-277).
   *
   * The LATER of the two instants, never their sum: the wait says "nothing
   * before this", and a send that already had a due instant of its own had it
   * for a reason of its own (the pause behind the message it follows). Adding
   * them would charge the wait twice for every operator who chose one, and
   * taking the earlier one would let the wait be ignored by whichever send
   * happened to carry an offset.
   */
  function held(dueAt: Date | undefined): Date | undefined {
    const notBefore = context.notBefore;

    if (notBefore === undefined) return dueAt;

    return dueAt !== undefined && dueAt.getTime() > notBefore.getTime()
      ? dueAt
      : notBefore;
  }

  /**
   * Is this run still entitled to the private reply, or has it spent it?
   *
   * The private reply OPENS a conversation from a comment; it is not a channel
   * that stays open. Observed on the real platform on 2026-08-02: a run that
   * skipped the confirmation (REQ-068, conversation already open) sent delivery
   * and follow-up back to back, both addressed by `comment_id`, and the second
   * one answered `500` and delivered anyway — reaching the contact twice.
   *
   * The answer is read from the QUEUE, never from a variable: the queue is
   * durable and this sender is not. A run whose second message is decided after
   * a restart must reach the same conclusion as one decided before it, and the
   * only witness that survives both is the row already written.
   *
   * This is also what makes the several messages of one delivery address
   * themselves correctly with no extra rule (REQ-231, REQ-286): the first goes
   * out as the private reply that opens the conversation, and each message
   * behind it travels by contact id, into the room the first one opened.
   */
  function privateReplyAvailable(queued: readonly WorkItem[]): boolean {
    if (context.origin !== "comment" || context.commentId === undefined) {
      return false;
    }

    return !queued.some(
      (item) => (item.payload as SendPayload).privateReply === true,
    );
  }

  /**
   * When a message that FOLLOWS another one may leave (REQ-231, REQ-286).
   *
   * Measured from the send it follows rather than from the clock, so a first
   * message deferred by a cap, by a retry or by the automation's own wait
   * (REQ-277) cannot end up behind the message it was supposed to introduce.
   * A send with nothing queued before it is not a second message at all — it
   * is the whole delivery — and waits for nothing.
   *
   * WHICH sends follow another is not read off the queue, and that is the
   * point: every send of a run is in the queue, including the one a contact's
   * answer produced hours later, and spacing that one would hold back somebody
   * who has just written. The engine says it instead, on the message
   * (`part`), because the engine is the only party that knows a delivery is
   * several messages. The attachment is still recognised beside it: it is the
   * older way of saying the same thing, and the adapter's own cases are
   * written against it.
   */
  function followerDueAt(
    message: OutboundMessage,
    queued: readonly WorkItem[],
    now: Date,
  ): Date | undefined {
    const follows =
      message.attachment !== undefined || message.part !== undefined;

    if (!follows || queued.length === 0) {
      return undefined;
    }

    const after = queued.reduce(
      (latest, item) => (item.dueAt > latest ? item.dueAt : latest),
      now,
    );

    return new Date(after.getTime() + MESSAGE_PAUSE_MS);
  }

  return {
    async sendDirectMessage(
      contactId: string,
      message: OutboundMessage,
    ): Promise<void> {
      // ONE read of the queue for both decisions that depend on what this run
      // has already asked for: which send owns the private reply, and how long
      // an attachment waits behind the message it belongs to.
      const queued = await deps.work.sendsFor(context.executionId);
      const privateReply = privateReplyAvailable(queued);

      await enqueue(
        {
          action: "direct_message",
          message,
          origin: context.origin,
          since: context.since.toISOString(),
          // The comment travels only with the send that answers it. Carrying it
          // further would leave the addressing decision recoverable by accident
          // from a payload that is no longer about the comment.
          ...(privateReply &&
            context.commentId !== undefined && {
              commentId: context.commentId,
            }),
          contactId,
          privateReply,
        },
        `dm:${queueOrdinal(message)}`,
        classOf(message, privateReply),
        followerDueAt(message, queued, deps.clock.now()),
      );
    },

    async replyToComment(
      commentId: string,
      message: OutboundMessage,
    ): Promise<void> {
      await enqueue(
        {
          action: "reply_comment",
          message,
          // A public reply answers under the comment's own window whatever the
          // run's origin, because the comment is what it replies to.
          origin: "comment",
          since: context.since.toISOString(),
          commentId,
        },
        `reply:${commentId}`,
        "private_reply",
      );
    },
  };
}

/**
 * Identity of the send: the same execution asking for the same step twice (a
 * redelivered event, a retried run) is one message, and the UNIQUE column is
 * what enforces it.
 *
 * The ATTEMPT is the one thing that has to break that identity (REQ-023). A
 * question asked again is word for word the message that already went out,
 * from the same execution and the same step, so nothing inside it can tell the
 * two apart: keyed on execution and step alone, the second question is dropped
 * in silence and `max_attempts` becomes "ask once, then wait without saying
 * why", which strands the contact worse than having no attempts at all.
 *
 * The follow gate's loop rides on the same field and nothing else (REQ-247,
 * registered again as REQ-317). It is the failure with no symptom: the contact
 * taps, the card is composed, the row is refused by the UNIQUE column, and
 * nobody anywhere is told. Whatever else changes about that step, the resend
 * must keep arriving here under an attempt of its own.
 *
 * The attempt enters the key only from the SECOND attempt on, so every key
 * already written keeps the shape it had: a redelivered event replaying a
 * first pass still collides with what that pass queued, which is the whole
 * reason the key exists.
 */
function dedupeKeyFor(context: OutboxContext, step: string): string {
  const attempt = context.attempt ?? 1;

  return attempt <= 1
    ? `${context.executionId}:${step}`
    : `${context.executionId}:try${String(attempt)}:${step}`;
}

/**
 * Distinguishes two direct messages of the same run so both are queued.
 *
 * A flow legitimately sends more than one message (the confirmation, then the
 * delivery), and keying both on the execution alone would silently drop the
 * second as a duplicate. Hashing the content is what separates them without
 * the engine having to number its own steps.
 *
 * It is also what carries the several messages of ONE delivery (REQ-231,
 * REQ-286), and by construction rather than by luck: every message after the
 * first says WHICH one it is (`part`), so two identical pure links declared by
 * the same step can never stringify alike, and the second is not swallowed as a
 * repeat of the first. Numbering the sends of a run inside this sender instead
 * would need a counter that survives a restart, which is the one thing it does
 * not have.
 */
function queueOrdinal(message: OutboundMessage): string {
  const shape = JSON.stringify(message);
  let hash = 0;
  for (let index = 0; index < shape.length; index += 1) {
    hash = (hash * 31 + shape.charCodeAt(index)) | 0;
  }
  return (hash >>> 0).toString(36);
}
