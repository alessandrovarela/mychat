import {
  isExecutionFailureReason,
  UNEXPECTED_FAILURE,
} from "../engine/execute.js";
import type {
  ExecutedStep,
  ExecutionFailureReason,
  ExecutionResult,
} from "../engine/execute.js";
import type { Clock } from "../engine/ports.js";
import type {
  AuditActionSubtype,
  AuditEntry,
  AuditOutcome,
  AuditRecord,
  AuditRepository,
} from "../storage/audit.js";

/**
 * What an execution did, written down (REQ-093).
 *
 * The engine hands back an `ExecutionResult` and forgets it. Every decision the
 * run made (which step went out, which one was deliberately not performed,
 * which one broke and why) lives in that return value and nowhere else, so an
 * operator asking "what happened to this contact" has nothing to read. This is
 * the seam that turns the return value into rows.
 *
 * ONE row per executed step, not one per run. A single row could not say which
 * step was suppressed and which one failed, and the trail an operator reads is
 * a sequence of actions rather than a verdict on the run.
 */

/**
 * Engine step outcomes mapped onto audit outcomes.
 *
 * `suspended` becomes `ok`, and that is the only entry worth arguing about. The
 * step did exactly what the flow told it to do: it asked its question and
 * started the wait. Recording it as `failed` would put every well-behaved
 * confirmation into the operator's failure count; recording it as `blocked`
 * would claim the application refused to act, which is the opposite of what
 * happened. Whether the contact ever answers is a different event with a
 * different instant, and the timeout handler (REQ-025) already writes that row.
 *
 * The other three are direct. `suppressed` stays its own outcome instead of
 * collapsing into `ok` because a step deliberately not performed (REQ-068) is
 * precisely what an operator investigating "why did this contact get nothing"
 * needs to tell apart from a step that ran.
 */
const STEP_OUTCOMES: Record<ExecutedStep["outcome"], AuditOutcome> = {
  done: "ok",
  failed: "failed",
  suspended: "ok",
  suppressed: "suppressed",
};

/**
 * Step kinds mapped onto action subtypes (REQ-106).
 *
 * Read from the step the run ACTUALLY took, at the instant it is recorded. That
 * is the whole requirement: the alternative is looking `stepId` up in the flow
 * definition in force at read time, and this phase adds revisions and
 * restoration precisely so that definition changes. A run from yesterday would
 * then be counted as whatever its step happens to be today, or as nothing at
 * all once the flow is deleted.
 *
 * Five kinds collapse into `message_sent` because to an operator counting what
 * left the account they are one thing: a message to the contact. Which question
 * it was is `stepId` and `flowId` on the same row, and nothing is lost.
 *
 * A step kind absent from this map records NO subtype rather than a default.
 * That case is a step the engine refused to run (an unsupported type reaches
 * here as a failure carrying its own name), and calling it a message sent would
 * put a message that never existed into the operator's count.
 *
 * The pause is here for exactly the opposite reason (REQ-156): it IS a kind of
 * action, it ran, and the row it wrote said nothing about itself. An entry with
 * no subtype is grouped as unknown by every count of this trail, so a flow with
 * a pause in it showed the operator an unnamed figure growing beside the types,
 * and nothing on the screen could say what it was made of. It sends nothing, so
 * it is not `message_sent`; it starts a wait rather than closing one, so it is
 * not `wait_ended`.
 */
const STEP_SUBTYPES: Readonly<Record<string, AuditActionSubtype>> = {
  send_dm: "message_sent",
  send_message: "message_sent",
  confirm_optin: "message_sent",
  collect_email: "message_sent",
  follow_gate: "message_sent",
  reply_comment: "comment_reply",
  delay: "pause_started",
};

/* ------------------------------------------------------------------ *
 * How a failure travels in the trail's one reason column (REQ-171)
 * ------------------------------------------------------------------ */

/** The tag that says this reason is an execution failure and not something else. */
export const EXECUTION_FAILURE_CODE = "execution_failure";

/** A failure as the trail carries it: the code, and what the code cannot say. */
export interface ExecutionFailure {
  readonly reason: ExecutionFailureReason;
  /** Which flow, which step, or what somebody outside answered. */
  readonly detail?: string;
}

/**
 * A failure as one string, for the single column the trail gives a reason.
 *
 * JSON, for the reason `encodeNoMatch` in `src/flows/matching.ts` gives at
 * length and which applies unchanged here: that column also holds bare
 * suppression codes and sentences older rows stored, so whoever reads it has to
 * tell a structure from a phrase with CERTAINTY. `JSON.parse` refuses a bare
 * code and refuses a sentence, which makes the test total rather than a guess
 * at a prefix.
 *
 * An envelope even when there is no detail, rather than a bare code in that
 * case: one shape means one decoder, and a reader that had to try two would be
 * the place the two drifted apart. It also keeps the failure vocabulary from
 * ever being mistaken for the suppression vocabulary, which IS written bare and
 * which a screen translates from a different catalogue section.
 */
export function encodeExecutionFailure(failure: ExecutionFailure): string {
  return JSON.stringify({
    code: EXECUTION_FAILURE_CODE,
    reason: failure.reason,
    ...(failure.detail !== undefined && { detail: failure.detail }),
  });
}

/**
 * The failure back, or `undefined` when this reason is not one of these records:
 * a row written before REQ-171, a suppression code, or a phrase.
 *
 * Strict, exactly as `decodeNoMatch` is: a failure code this build does not
 * know makes the whole value unreadable rather than crossing as a code no
 * catalogue answers, which is the state REQ-163 exists to prevent. The stored
 * value stays in the trail either way, untouched.
 */
export function decodeExecutionFailure(
  reason: string | undefined,
): ExecutionFailure | undefined {
  if (reason === undefined) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(reason);
  } catch {
    return undefined;
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return undefined;
  }

  const record = parsed as Record<string, unknown>;
  if (record["code"] !== EXECUTION_FAILURE_CODE) return undefined;

  const code = record["reason"];
  if (!isExecutionFailureReason(code)) return undefined;

  const detail = record["detail"];

  return {
    reason: code,
    ...(typeof detail === "string" && { detail }),
  };
}

/**
 * What a step's reason becomes on the row, which depends on the outcome beside
 * it and on nothing else.
 *
 * Only a FAILURE is wrapped. A suppression stays the bare code the aggregation
 * already recognises by membership, and a suspension stays the sentence it
 * always was, because it is not a failure and nobody reads it asking why
 * nothing worked.
 *
 * The fallback is the interesting half. The engine's own failures all carry a
 * code by construction, so a failed step whose reason is not one came from
 * somewhere else, and dropping it would lose the only account of the failure
 * the record has. It becomes the generic code with the stored words as the
 * detail: still translatable, still nothing invented, and the words stay
 * exactly where they can be read as somebody else's.
 */
function trailReasonOf(step: ExecutedStep): string | undefined {
  if (step.outcome !== "failed") {
    return step.reason;
  }

  return isExecutionFailureReason(step.reason)
    ? encodeExecutionFailure({
        reason: step.reason,
        ...(step.detail !== undefined && { detail: step.detail }),
      })
    : encodeExecutionFailure({
        reason: UNEXPECTED_FAILURE,
        ...(step.reason !== undefined && { detail: step.reason }),
      });
}

export interface ExecutionAuditContext {
  /**
   * Only a run-level failure needs an instant of its own: every step carries
   * the one it finished at. Injected rather than read from `new Date()` so the
   * trail a test asserts on is the trail the caller's clock produced.
   */
  readonly clock: Clock;
  /** The automation the run belongs to, when it came from one. */
  readonly automationId?: string;
  /** The inbound event that triggered the run, when one did. */
  readonly eventId?: string;
  /** Stable run identity, shared by every action the execution records. */
  readonly executionId?: string;
  /** Scope captured from the executable definition before it can be edited. */
  readonly automationScope?: "publication" | "global" | "next_publication";
  /** Publication captured from the event or its executable scope. */
  readonly publicationId?: string;
  /** Keyword that matched the trigger, when the trigger declared one. */
  readonly matchedKeyword?: string;
}

export async function recordExecution(
  audit: AuditRepository,
  result: ExecutionResult,
  context: ExecutionAuditContext,
): Promise<readonly AuditEntry[]> {
  const common: Pick<
    AuditRecord,
    | "automationId"
    | "eventId"
    | "executionId"
    | "automationScope"
    | "publicationId"
    | "matchedKeyword"
  > = {
    ...(context.automationId !== undefined && {
      automationId: context.automationId,
    }),
    ...(context.eventId !== undefined && { eventId: context.eventId }),
    ...(context.executionId !== undefined && {
      executionId: context.executionId,
    }),
    ...(context.automationScope !== undefined && {
      automationScope: context.automationScope,
    }),
    ...(context.publicationId !== undefined && {
      publicationId: context.publicationId,
    }),
    ...(context.matchedKeyword !== undefined && {
      matchedKeyword: context.matchedKeyword,
    }),
  };

  const written: AuditEntry[] = [];

  for (const step of result.steps) {
    const subtype = STEP_SUBTYPES[step.type];
    const reason = trailReasonOf(step);

    // Written one at a time, in execution order. The trail breaks ties on the
    // row id, so two steps that finished inside the same clock tick still read
    // in the order they ran; issuing the writes concurrently would hand out
    // those ids in whatever order the driver happened to finish.
    written.push(
      await audit.record(
        {
          kind: "action_executed",
          // What KIND of action this was. Whether it happened is `outcome`: a
          // suppressed confirmation is still a message step, recorded as one,
          // that sent nothing.
          ...(subtype !== undefined && { subtype }),
          outcome: STEP_OUTCOMES[step.outcome],
          contactId: result.contactId,
          flowId: result.flowId,
          stepId: step.stepId,
          ...common,
          // The reason is the engine's own account of what happened, already
          // produced. Nothing is invented here: a reason written by this layer
          // would be a sentence no one who was there ever said. What this layer
          // does decide is how the account is WRITTEN DOWN, which is what
          // `trailReasonOf` owns.
          ...(reason !== undefined && { reason }),
        },
        // The step's OWN instant, never one "now" for the whole run. Collapsing
        // them would make an ordered trail lie: four steps stamped alike cannot
        // answer how long the contact waited between two of them.
        step.finishedAt,
      ),
    );
  }

  const stepFailed = result.steps.some((step) => step.outcome === "failed");

  if (result.outcome === "failed" && !stepFailed) {
    // A run can fail with no step to blame: a missing or rejected definition
    // runs nothing at all (REQ-012), and transitions that form a cycle end the
    // run after steps that every one of them succeeded. Without a row of its
    // own that failure is invisible, and the trail shows either nothing at all
    // or a sequence of successes that stops for no stated reason.
    //
    // No `stepId`: the failure belongs to the run. Pinning it on the last step
    // that ran would be a quieter lie than silence, but a lie either way.
    //
    // A finished or suspended run gets no such row: the step entries already
    // say so, and a second row per run would double every action an operator
    // counts.
    written.push(
      await audit.record(
        {
          kind: "action_executed",
          // Its own subtype, not one borrowed from a step: the failure belongs
          // to the run, and counting it as a message or a reply would add an
          // action nobody performed to the operator's totals.
          subtype: "execution_failed",
          outcome: "failed",
          contactId: result.contactId,
          flowId: result.flowId,
          ...common,
          // The defect REQ-171 was written about was exactly this line: it
          // stored whatever sentence the engine had phrased, the panel could
          // translate no sentence, and the operator read a failed execution
          // with no cause beside it. A code goes in now, and the words are
          // picked where a catalogue can be read.
          ...(result.reason !== undefined && {
            reason: encodeExecutionFailure({
              reason: result.reason,
              ...(result.detail !== undefined && { detail: result.detail }),
            }),
          }),
        },
        context.clock.now(),
      ),
    );
  }

  return written;
}
