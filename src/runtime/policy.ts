import type { PlatformLimits } from "../config/limits.js";
import type { Clock } from "../engine/ports.js";
import { t } from "../i18n/index.js";
import type {
  AuditActionSubtype,
  AuditOutcome,
  AuditRepository,
} from "../storage/audit.js";
import type { DurableWorkStore, WorkItem } from "../storage/index.js";
import { decideRate, readRateCounts } from "./rate.js";
import type { RateLimits } from "./rate.js";
import { nextRetry } from "./retry.js";
import type { Jitter, RetryPolicy } from "./retry.js";
import type { SweepHandler, SweepOutcome } from "./sweep.js";

/**
 * Where the caps and the backoff meet the queue.
 *
 * The seam matters: the adapter that talks to the platform reports WHAT
 * happened (`SendAttempt`) and knows nothing about budgets; this module turns
 * that into what the queue should do. Neither half has to hold both concerns,
 * and the adapter stays provable without a clock or a cap in sight.
 *
 * It is also the only place that sees every answer the platform gives to a
 * send, which is why the trail's record of a delivery is written here (REQ-039)
 * and not in the sweep: the sweep drives three kinds of durable work and would
 * have to guess which of them was a message.
 */

/** What one attempt against the platform produced. */
export type SendAttempt =
  | { readonly kind: "sent"; readonly platformMessageId?: string }
  /** The platform said too many requests. The signal that actually protects. */
  | { readonly kind: "rate_limited"; readonly retryAfterMs?: number }
  /** Something that may well work next time: a timeout, a 5xx. */
  | {
      readonly kind: "transient";
      readonly reason: string;
      /**
       * The platform answered an error but MAY have delivered anyway.
       *
       * Observed on 2026-08-02: a private reply carrying quick replies got
       * `500` five times and the contact received all five messages. Retrying
       * a send in that state does not recover a lost message, it duplicates a
       * delivered one, and a duplicate to a human being is the defect this
       * product exists to avoid, not an acceptable cost.
       */
      readonly deliveryUncertain?: boolean;
    }
  /** Nothing will fix this by waiting: a refusal, a bad request. */
  | {
      readonly kind: "permanent";
      readonly reason: string;
      /** Credential refusals have their own instance alert and never count. */
      readonly category?: "credential" | "delivery";
    };

export type SendAttemptHandler = (item: WorkItem) => Promise<SendAttempt>;

export interface SendPolicyDeps {
  readonly work: DurableWorkStore;
  readonly clock: Clock;
  readonly limits: RateLimits &
    Pick<PlatformLimits, "retryAttempts" | "retryBaseMs">;
  /** Injected so a deferral lands on an instant a test can assert exactly. */
  readonly jitter?: Jitter;
  /**
   * Where the platform's answer to a send is written down (REQ-039).
   *
   * Optional for the same reason the suspension's is: a policy composed without
   * it still delivers, defers and gives up exactly as it did before, and a
   * required port would make every existing caller a compile error for a
   * concern none of them has. What an installation missing the wiring loses is
   * the dashboard's error and too-many-requests counts, never a message.
   */
  readonly audit?: AuditRepository;
  /** Definitive outcomes by automation; retries are intentionally invisible. */
  readonly conclusions?: SendConclusionSink;
}

export interface SendConclusionSink {
  succeeded(automationId: string): Promise<void>;
  failed(automationId: string, reason: string): Promise<void>;
}

const defaultJitter: Jitter = () => Math.random();

function automationOf(item: WorkItem): string | undefined {
  const [automationId] = item.executionId?.split(":") ?? [];
  return automationId === undefined || automationId === ""
    ? undefined
    : automationId;
}

async function concludeSuccess(
  deps: SendPolicyDeps,
  item: WorkItem,
): Promise<void> {
  const automationId = automationOf(item);
  if (automationId !== undefined) {
    await deps.conclusions?.succeeded(automationId);
  }
}

async function concludeFailure(
  deps: SendPolicyDeps,
  item: WorkItem,
  reason: string,
): Promise<void> {
  const automationId = automationOf(item);
  if (automationId !== undefined) {
    await deps.conclusions?.failed(automationId, reason);
  }
}

/** One delivery outcome, named, so `outcome` and `reason` cannot be swapped. */
interface DeliveryRecord {
  readonly item: WorkItem;
  readonly outcome: AuditOutcome;
  readonly reason: string;
  readonly at: Date;
  readonly platformMessageId?: string;
}

/**
 * What KIND of action the queued row is about, read from the payload the
 * queueing sender wrote.
 *
 * Read structurally instead of through the platform adapter's `SendPayload`:
 * that module already imports `SendAttempt` from this one, and a cycle between
 * the two buys nothing. A payload naming no action records NO subtype, which is
 * the honest absence `audit.ts` describes rather than a default: this queue is
 * shared (ADR-005), and a row this module cannot read is one it must not label.
 */
function deliverySubtypeOf(item: WorkItem): AuditActionSubtype | undefined {
  const action = (item.payload as { readonly action?: unknown } | null)?.action;

  if (action === "reply_comment") return "comment_reply";
  if (action === "direct_message") return "message_sent";
  return undefined;
}

/**
 * The platform's answer to one attempt, on the trail (REQ-039).
 *
 * ONE ROW PER ANSWER, not one per message: a send the platform refused three
 * times is three refusals, and what the requirement counts is the answers given
 * in the period. The row is about the DELIVERY, so it carries no `stepId` and
 * no `flowId`: the queue row knows neither, and pinning the delivery on a step
 * read back from somewhere else would be a guess.
 */
async function recordDelivery(
  deps: SendPolicyDeps,
  delivery: DeliveryRecord,
): Promise<void> {
  const subtype = deliverySubtypeOf(delivery.item);

  await deps.audit?.record(
    {
      kind: "action_executed",
      ...(subtype !== undefined && { subtype }),
      outcome: delivery.outcome,
      ...(delivery.item.contactId !== null && {
        contactId: delivery.item.contactId,
      }),
      ...(delivery.item.executionId !== null && {
        executionId: delivery.item.executionId,
      }),
      ...(delivery.platformMessageId !== undefined && {
        platformMessageId: delivery.platformMessageId,
      }),
      reason: delivery.reason,
    },
    delivery.at,
  );
}

/**
 * How many attempts a send gets when the platform's answer leaves delivery in
 * doubt. One, meaning a single retry after the first uncertain failure.
 *
 * Not configurable on purpose: the number is not a tuning knob, it is the
 * boundary between "recovering a lost message" and "spamming a person". An
 * operator raising it would be choosing the second without meaning to.
 */
const UNCERTAIN_DELIVERY_ATTEMPTS = 1;

/**
 * Error names the JavaScript runtime raises when the PROGRAM is wrong, rather
 * than when the network is. Matched by name and not by `instanceof`, so an
 * error that crossed a module realm is still recognised.
 */
const PROGRAM_ERROR_NAMES: ReadonlySet<string> = new Set([
  "TypeError",
  "ReferenceError",
  "RangeError",
  "SyntaxError",
]);

/**
 * What an exception thrown by the adapter means for the queue (REQ-119).
 *
 * TRANSIENT by default, and the default is the point. A send that throws is a
 * send that reached no status code at all: a reset socket, a name that did not
 * resolve, a connection that timed out. That is the class of failure most
 * likely to succeed on the next attempt, so calling it final treats the most
 * transient failure there is as the most definitive one, and the contact simply
 * never receives. A further attempt costs one call; giving up costs the
 * delivery.
 *
 * PERMANENT is claimed only where the throw is evidence that this program is
 * wrong: the four names above are what the runtime raises for a dereference of
 * something absent, an argument out of range or a body that does not parse, and
 * the same queued row reproduces them on every single attempt. Spending the
 * budget there buys nothing and delays the moment the defect becomes visible.
 *
 * `cause` is what keeps that rule honest, and it is not a detail. Node's
 * `fetch` reports every network failure as `TypeError: fetch failed` carrying
 * the underlying system error in `cause`, so a runtime error name WITH a cause
 * is a network failure wearing a program error's clothes. Requiring the absence
 * of a cause is what stops the commonest production failure of all from being
 * classified as a bug in our code, which is the very mistake being fixed here.
 */
function classifyThrown(error: unknown): SendAttempt {
  const reason = error instanceof Error ? error.message : String(error);

  if (
    error instanceof Error &&
    PROGRAM_ERROR_NAMES.has(error.name) &&
    error.cause === undefined
  ) {
    return { kind: "permanent", reason };
  }

  // No `deliveryUncertain`, deliberately, and this is the one place the two
  // guards could contradict each other. That flag is set from an ANSWER the
  // platform gave to a request it demonstrably processed (a 5xx, observed
  // delivering on 2026-08-02), and a throw is the absence of any answer at all.
  // A reset socket MAY still have been processed and cannot be told apart from
  // one that never arrived, so the choice here is between a possible duplicate
  // and a certain non-delivery, bounded either way by the configured budget.
  // REQ-119 makes it: the full budget, the same one the response-shaped form of
  // this failure gets.
  return { kind: "transient", reason };
}

/**
 * Wraps a send attempt in the rate budget and the retry budget.
 *
 * Order is deliberate: the cap is checked BEFORE the attempt. Asking the
 * platform and being refused would consume a call to learn something already
 * known, and on the one path with a real hourly ceiling that is the difference
 * between pacing and being throttled.
 */
export function withSendPolicy(
  attempt: SendAttemptHandler,
  deps: SendPolicyDeps,
): SweepHandler {
  const jitter = deps.jitter ?? defaultJitter;
  const retryPolicy: RetryPolicy = {
    attempts: deps.limits.retryAttempts,
    baseMs: deps.limits.retryBaseMs,
  };

  return async (item: WorkItem): Promise<SweepOutcome> => {
    const sendClass = item.sendClass;

    if (sendClass !== null) {
      const now = deps.clock.now();
      const verdict = decideRate(
        sendClass,
        await readRateCounts(deps.work, now),
        deps.limits,
        now,
      );

      if (!verdict.allowed) {
        // Deferred, never dropped: REQ-017 is explicit that no send is
        // discarded because of a cap.
        //
        // Nothing is written to the trail here, deliberately. Our own pacing is
        // not an answer the platform gave, so counting it as one would put a
        // number REQ-039 never asked for inside the very count that tells an
        // operator the account is being throttled. The deferral is on the queue
        // row's own reason, and the consumption REQ-038 shows comes from
        // `readRateCounts` reading the same queue.
        return {
          kind: "defer",
          dueAt: verdict.retryAt,
          reason: t("rate.deferredByCap", { cap: verdict.cap }),
        };
      }
    }

    let result: SendAttempt;
    try {
      result = await attempt(item);
    } catch (error: unknown) {
      // The adapter threw instead of answering, so the throw becomes the answer
      // and walks the SAME path below that a response of the same nature walks:
      // one row on the trail, then the exponential interval with jitter and the
      // configured budget before anything is called final (REQ-119, REQ-018).
      //
      // Rethrowing is what this replaces. `runSweep` catches whatever a handler
      // throws and marks the item failed on the spot, which is the right net for
      // a handler that has no policy of its own, and was exactly wrong here: an
      // identical failure was retried in full when it arrived as a 5xx and given
      // up on at the first try when it arrived as a reset socket.
      result = classifyThrown(error);
    }

    switch (result.kind) {
      case "sent":
        // NO row, and this is the seam where double counting would start. The
        // trail already carries one `message_sent` (or `comment_reply`) entry
        // with outcome `ok` for this send, written when the step queued it, and
        // `audit.ts` defines that pair as the count of messages actually sent.
        // A second entry here would report every delivery twice. The only thing
        // the platform's answer can add to that claim is that the message did
        // NOT go out, which is what the rows below exist to say.
        // This is a separate immutable fact from queueing: the platform
        // accepted the request, not proof that a person received or read it.
        await recordDelivery(deps, {
          item,
          outcome: "ok",
          reason: "platform_accepted",
          at: deps.clock.now(),
          ...(result.platformMessageId !== undefined && {
            platformMessageId: result.platformMessageId,
          }),
        });
        await concludeSuccess(deps, item);
        return { kind: "done" };

      case "permanent":
        // Waiting changes nothing here, so the budget is not spent on it.
        await recordDelivery(deps, {
          item,
          outcome: "failed",
          reason: result.reason,
          at: deps.clock.now(),
        });
        if (result.category !== "credential") {
          await concludeFailure(deps, item, result.reason);
        }
        return { kind: "failed", reason: result.reason };

      case "rate_limited":
      case "transient": {
        const now = deps.clock.now();
        const reason =
          result.kind === "rate_limited"
            ? t("rate.rateLimited")
            : result.reason;

        // Too many requests is `blocked` and an error is `failed`, and that
        // difference is the whole of REQ-039's second half: the trail's
        // vocabulary of subtypes has no value that tells the two apart, so the
        // outcome carries it. Merged into one count, a throttled account would
        // be invisible inside the failure total, which is precisely the number
        // an operator needs to read on its own.
        //
        // This is the only place in the application that writes `blocked`, and
        // the dashboard's count of too-many-requests answers is exactly those
        // rows: a second writer of that outcome would join the count silently.
        //
        // Written BEFORE the retry decision, because the row is about what the
        // platform answered and not about what we chose to do next. The choice
        // is on the queue row, in its reason and its due instant.
        await recordDelivery(deps, {
          item,
          outcome: result.kind === "rate_limited" ? "blocked" : "failed",
          reason,
          at: now,
        });

        // At most ONE further attempt when the platform may already have
        // delivered. The retry budget exists to survive a send that did not
        // happen; spending it on one that may have happened turns a hiccup
        // into a burst of identical messages to the same person. One extra
        // try covers the case where nothing arrived, and stops well short of
        // the volume that trips the spam filter.
        if (
          result.kind === "transient" &&
          result.deliveryUncertain === true &&
          item.attempts >= UNCERTAIN_DELIVERY_ATTEMPTS
        ) {
          const finalReason = t("rate.uncertainDelivery", {
            reason: result.reason,
          });
          await concludeFailure(deps, item, finalReason);
          return {
            kind: "failed",
            reason: finalReason,
          };
        }

        const decision = nextRetry(item.attempts, retryPolicy, now, jitter);

        if (!decision.retry) {
          const finalReason = t("rate.retriesExhausted", {
            attempts: retryPolicy.attempts,
            reason,
          });
          await concludeFailure(deps, item, finalReason);
          return {
            kind: "failed",
            reason: finalReason,
          };
        }

        // The platform's own Retry-After wins when it sends one: it knows
        // when the account is welcome back, and the local curve is a guess.
        const dueAt =
          result.kind === "rate_limited" && result.retryAfterMs !== undefined
            ? new Date(now.getTime() + result.retryAfterMs)
            : decision.dueAt!;

        return { kind: "defer", dueAt, reason };
      }
    }
  };
}
