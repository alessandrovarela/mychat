import {
  EXECUTION_FAILURE_REASONS,
  isSuppressionReason,
  SUPPRESSION_REASONS,
} from "../engine/execute.js";
import type {
  ActionReason,
  ExecutionFailureReason,
  SuppressionReason,
} from "../engine/execute.js";
import { MATCH_REFUSALS } from "../flows/matching.js";
import type { MatchRefusal } from "../flows/matching.js";

/**
 * Where a code meets the catalogue (REQ-163).
 *
 * The application emits codes and never sentences: the engine because it cannot
 * read the catalogue (ADR-003), the matcher and the trail because a value that
 * is COUNTED and stored must not change when somebody rewords a screen.
 * Something has to say which key gives a code its words, and this is that one
 * place: the screen that shows a suppressed step, the panel that shows why an
 * event fired nothing, and the guard that refuses a code without a translation
 * all ask the SAME function, so they cannot drift into disagreeing about a key.
 *
 * Deriving the key from the code, rather than keeping a table beside it, is
 * what makes the guard total: a code added tomorrow addresses a key that does
 * not exist yet, and the check fails on it without anyone having remembered to
 * register it here.
 *
 * No `node:fs` and no catalogue loading in this module, deliberately: the
 * interface bundles it, and `src/i18n/index.ts` is the Node half that reads the
 * locale directory from disk. The same rule decides what may be imported here.
 * `engine/execute.js` and `flows/matching.js` are pure and come in; the trail
 * (`storage/audit.js`) and the aggregation (`dashboard/aggregate.js`) reach a
 * database driver, so their vocabularies are MIRRORED below instead, and
 * `catalogue.test.ts` holds the two copies against each other at compile time.
 */

/** The catalogue section every engine suppression reason is translated under. */
const SUPPRESSION_SECTION = "engine.suppressed";

/** The catalogue key that gives a suppression code its words. */
export function suppressionTextKey(reason: SuppressionReason): string {
  return `${SUPPRESSION_SECTION}.${reason}`;
}

/** The catalogue section every engine failure reason is translated under. */
const FAILURE_SECTION = "engine.failed";

/** The catalogue key that gives a failure code its words (REQ-171). */
export function executionFailureTextKey(
  reason: ExecutionFailureReason,
): string {
  return `${FAILURE_SECTION}.${reason}`;
}

/**
 * The key for whichever of the two vocabularies a reason belongs to.
 *
 * One entry point, because the trail gives the panel ONE field: the reason of
 * an action, which is a suppression code or a failure code and is read from the
 * same place either way. A screen choosing between the two functions itself
 * would be a screen deciding what a value means, which is exactly the decision
 * `aggregate.ts` already made when it recognised the value.
 *
 * The sections are separate, and that is not decoration. `email_already_known`
 * and `flow_not_runnable` are answers to different questions ("why did nothing
 * go out" against "why did this break"), they are worded differently, and a
 * single section would let a code moved between the lists keep a sentence
 * written for the other one.
 */
export function actionReasonTextKey(reason: ActionReason): string {
  return isSuppressionReason(reason)
    ? suppressionTextKey(reason)
    : executionFailureTextKey(reason);
}

/** Every key the catalogues have to carry for the engine's codes. */
export function engineReasonKeys(): readonly string[] {
  return [
    ...SUPPRESSION_REASONS.map(suppressionTextKey),
    ...EXECUTION_FAILURE_REASONS.map(executionFailureTextKey),
  ];
}

/* ------------------------------------------------------------------ *
 * The recent activity (REQ-164, REQ-165)
 * ------------------------------------------------------------------ */

/** The catalogue section the panel's recent activity is translated under. */
const ACTIVITY_SECTION = "dashboard.activity";

/**
 * The verdicts the trail writes, mirrored from `AuditOutcome` in
 * `src/storage/audit.ts`.
 *
 * Mirrored and not imported because that module imports the ORM, and the
 * interface bundles this file. The copy is not left on trust:
 * `catalogue.test.ts` assigns each union to the other, so a sixth outcome added
 * there fails the build here rather than reaching an operator as a code.
 */
export const ACTIVITY_OUTCOMES = [
  "ok",
  "failed",
  "duplicate",
  "suppressed",
  "blocked",
] as const;

export type ActivityOutcome = (typeof ACTIVITY_OUTCOMES)[number];

/**
 * Why an event fired nothing, mirrored from `SILENCE_CODES` in
 * `src/dashboard/aggregate.ts`, and mirrored for the same reason as above.
 */
export const ACTIVITY_SILENCES = ["no_match", "unreadable"] as const;

export type ActivitySilence = (typeof ACTIVITY_SILENCES)[number];

/** What the trail last said about the ARRIVAL of an event. */
export function arrivalTextKey(outcome: ActivityOutcome): string {
  return `${ACTIVITY_SECTION}.arrival.${outcome}`;
}

/** What became of one action the application performed about that event. */
export function actionOutcomeTextKey(outcome: ActivityOutcome): string {
  return `${ACTIVITY_SECTION}.actionOutcome.${outcome}`;
}

/** How this build could read the reason an event fired nothing. */
export function activitySilenceTextKey(code: ActivitySilence): string {
  return `${ACTIVITY_SECTION}.silence.${code}`;
}

/** Why one automation refused an event (REQ-160). */
export function matchRefusalTextKey(reason: MatchRefusal): string {
  return `${ACTIVITY_SECTION}.refusal.${reason}`;
}

/**
 * Every key the catalogues have to carry for the codes the activity list
 * translates.
 *
 * The panel builds each of these by calling the function beside it, so the list
 * a guard checks and the key a screen looks up are the same expression. A key
 * built at runtime is invisible to the walker in `catalogue.test.ts`, which
 * collects the keys written down as `t("...")`, and this is what reaches where
 * that walker cannot.
 */
export function activityReasonKeys(): readonly string[] {
  return [
    ...ACTIVITY_OUTCOMES.map(arrivalTextKey),
    ...ACTIVITY_OUTCOMES.map(actionOutcomeTextKey),
    ...ACTIVITY_SILENCES.map(activitySilenceTextKey),
    ...MATCH_REFUSALS.map(matchRefusalTextKey),
  ];
}
