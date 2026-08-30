import { ANY_WORD_MODE } from "./schema.js";
import type {
  ActiveAutomation,
  AutomationTrigger,
  KeywordMatchMode,
  UnifiedAutomation,
} from "./schema.js";

/**
 * Deciding whether an inbound event fires an automation (REQ-013, REQ-014,
 * REQ-064).
 *
 * This is where being wrong is most expensive in both directions: firing for
 * someone who did not ask is spam, and staying silent for someone who did is
 * the product not working. So the matching is explicit about its semantics
 * rather than clever.
 */

/** What arrived, reduced to what matching actually needs. */
export interface InboundEvent {
  readonly origin: "comment" | "direct_message";
  readonly text: string;
  readonly contactId: string;
  /** Publication the comment belongs to. Absent for a direct message. */
  readonly publicationId?: string;
  readonly commentId?: string;
}

/**
 * Why an automation did not fire (REQ-160).
 *
 * Codes and never sentences: the trail stores them and a screen picks its own
 * words from the catalogue (REQ-074, REQ-163), so rewording what an operator
 * reads can never change what a reader matches on.
 *
 * Declared in the order `matchAutomation` asks the questions, and that order is
 * DATA rather than presentation: it is the order an aggregate of refusals is
 * written in, which is what makes the same set of refusals always produce the
 * same record.
 */
export const MATCH_REFUSALS = [
  /** Switched off by the operator, so nothing else about it is even asked. */
  "disabled",
  /** A comment automation met a direct message, or the other way round. */
  "wrong_origin",
  /** The comment belongs to a publication this automation does not cover. */
  "wrong_target",
  /**
   * Everything else fit, and not one of the keywords was in the text.
   *
   * It cannot be the reason a comment trigger set to "any word" stays silent
   * (REQ-262): that trigger declares no keyword, so nothing about the text can
   * refuse it once the publication is the right one.
   */
  "no_keyword",
] as const;

export type MatchRefusal = (typeof MATCH_REFUSALS)[number];

/** Whether a value read back from somewhere is one of the declared codes. */
export function isMatchRefusal(value: unknown): value is MatchRefusal {
  return (MATCH_REFUSALS as readonly unknown[]).includes(value);
}

export type MatchResult =
  /**
   * `keyword` is absent when the trigger declared none: a comment trigger set
   * to "any word" fires on the publication and not on anything the text says
   * (REQ-262), and an empty string there would read as a word that was matched.
   */
  | { readonly matched: true; readonly keyword?: string }
  | { readonly matched: false; readonly reason: MatchRefusal };

/**
 * Normalises for comparison: case and surrounding blanks never carry intent in
 * a comment, and treating them as significant would make the feature look
 * broken to everyone who capitalises a word.
 *
 * The Unicode FORM is folded, and that is a different thing from folding
 * accents (REQ-136). The same accented letter can be written as one code point
 * (composed, NFC) or as the plain letter followed by a combining mark
 * (decomposed, NFD, which iPhone and macOS keyboards sometimes produce). On
 * screen the two are INDISTINGUISHABLE, so without this a keyword fails to
 * match its own visual twin: the automation does not fire, the trail records
 * "no automation matched", and neither the operator nor the person who
 * commented can see any difference. Delivery lost in silence.
 *
 * Accents themselves are deliberately NOT stripped: in Portuguese they
 * distinguish real words, and folding them would make "e" match "é".
 */
function normalise(value: string): string {
  return value.normalize("NFC").trim().toLowerCase();
}

/** A stable key for the global-match uniqueness constraint (REQ-369). */
export function normaliseGlobalMatch(trigger: AutomationTrigger): string {
  const match = trigger.match;
  const keywords =
    match.mode === ANY_WORD_MODE
      ? []
      : match.keywords
          .map((keyword) =>
            keyword
              .normalize("NFD")
              .replace(/\p{M}/gu, "")
              .trim()
              .replace(/\s+/g, " ")
              .toLowerCase(),
          )
          .sort();
  return JSON.stringify({ type: trigger.type, mode: match.mode, keywords });
}

/**
 * Whether the text matches the keyword under the declared mode.
 *
 * Two modes since REQ-259 took the advanced expression out of the product, and
 * with it the whole class of failure it carried: a pattern is code an operator
 * writes with nothing to test it against, every way of getting it wrong fails
 * silently, and this function had to compile one per call and swallow the
 * throw so a single typo could not take down the handling of an event other
 * automations still wanted.
 */
export function matchesKeyword(
  text: string,
  keyword: string,
  mode: KeywordMatchMode,
): boolean {
  const haystack = normalise(text);
  const needle = normalise(keyword);

  switch (mode) {
    case "contains":
      return haystack.includes(needle);

    case "exact":
      // Whole text equals the keyword. A comment of "quero muito" does NOT
      // match "quero" here, which is the entire reason `exact` exists next to
      // `contains`.
      return haystack === needle;
  }
}

/** True when the trigger's target covers this event's publication (REQ-064). */
function targetCovers(
  automation: ActiveAutomation,
  event: InboundEvent,
): boolean {
  const trigger = automation.trigger;
  if (trigger.type !== "comment") return true;

  // An equality check on ids, and deliberately nothing more. Since REQ-260 the
  // schema accepts nothing else as a target, so there is no second spelling of
  // a publication that could reach here and fail to be equal to the id the
  // webhook carries.
  if (automation.scope?.type === "global") return true;
  if (automation.scope?.type === "next_publication") return false;
  return (
    (automation.scope?.type === "publication"
      ? automation.scope.publicationId
      : trigger.target) === event.publicationId
  );
}

/**
 * Decides whether this automation fires for this event, and says why not when
 * it does not.
 *
 * The reason is what `matchEvent` below aggregates and what the trail then
 * records for an event that fired nothing (REQ-160), so it is what an operator
 * reads when asking "why did nothing happen". That sentence stood here before
 * REQ-160 and was NOT true: the reason was computed here and thrown away one
 * function below, and the trail said only that no automation had matched.
 */
export function matchAutomation(
  automation: UnifiedAutomation,
  event: InboundEvent,
): MatchResult {
  if (automation.state !== "active") {
    return { matched: false, reason: "disabled" };
  }

  const trigger = automation.trigger;

  const expectedOrigin =
    trigger.type === "comment" ? "comment" : "direct_message";
  if (event.origin !== expectedOrigin) {
    return { matched: false, reason: "wrong_origin" };
  }

  if (!targetCovers(automation, event)) {
    return { matched: false, reason: "wrong_target" };
  }

  const match = trigger.match;

  // REQ-262. The publication was the whole question, and it has been answered
  // above: every comment on it fires this automation, so there is no text to
  // read and nothing left that could refuse.
  if (match.mode === ANY_WORD_MODE) {
    return { matched: true };
  }

  const hit = match.keywords.find((keyword) =>
    matchesKeyword(event.text, keyword, match.mode),
  );

  return hit === undefined
    ? { matched: false, reason: "no_keyword" }
    : { matched: true, keyword: hit };
}

/** An automation this event fired, with the keyword that did it when one did. */
export interface FiredAutomation {
  readonly automation: ActiveAutomation;
  /** Absent for a trigger that declared no word at all (REQ-262). */
  readonly keyword?: string;
}

/**
 * One reason, and how many automations it refused (REQ-160).
 *
 * Aggregated on purpose, and the design decision is the count rather than the
 * list: twenty automations and a hundred comments that fire nothing would be
 * two thousand rows a day if each refusal were recorded on its own. Which
 * automations refused is answerable from the automations themselves; how many
 * refused for each reason is what an operator needs at a glance.
 */
export interface MatchTally {
  readonly reason: MatchRefusal;
  readonly count: number;
}

/** Both halves of one decision: what fired, and why the rest did not. */
export interface MatchOutcome {
  /**
   * Every automation this event fires, in declaration order.
   *
   * All of them rather than the first is what REQ-058 needs: two automations
   * may legitimately reference the same flow with different values, and both
   * are supposed to run.
   */
  readonly fired: readonly FiredAutomation[];
  /**
   * Why the others stayed silent, aggregated by reason, one entry per reason
   * present and in the order `MATCH_REFUSALS` declares.
   */
  readonly refused: readonly MatchTally[];
}

/**
 * Matches one event against every automation, keeping BOTH answers.
 *
 * The refusals used to die here: the loop asked `matchAutomation` why each
 * automation stayed silent and pushed only the ones that fired, so the five
 * reasons were computed once per automation and dropped. That is the whole of
 * REQ-160, and it is why this returns an outcome rather than a list.
 */
export function matchEvent(
  automations: readonly UnifiedAutomation[],
  event: InboundEvent,
): MatchOutcome {
  const fired: FiredAutomation[] = [];
  const counts = new Map<MatchRefusal, number>();

  for (const automation of automations) {
    const result = matchAutomation(automation, event);
    if (result.matched) {
      // A draft is refused above, so every matching v2 aggregate is active.
      // The keyword is carried only when there WAS one: a trigger set to "any
      // word" declares none, and a property holding `undefined` reads as a word
      // nobody can name rather than as the absence it is (REQ-262).
      fired.push({
        automation: automation as ActiveAutomation,
        ...(result.keyword !== undefined && { keyword: result.keyword }),
      });
    } else {
      counts.set(result.reason, (counts.get(result.reason) ?? 0) + 1);
    }
  }

  return {
    fired,
    // The DECLARED order, never the order the automations happened to be
    // stored in: two events refused identically must produce the identical
    // record, or a reader comparing them sees a difference that is not there.
    refused: MATCH_REFUSALS.filter((reason) => counts.has(reason)).map(
      (reason) => ({ reason, count: counts.get(reason) ?? 0 }),
    ),
  };
}

// --- how the aggregate travels ----------------------------------------------

/** The code an entry carries when an event fired nothing at all (REQ-160). */
export const NO_MATCH_CODE = "no_automation_matched";

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * The aggregate as one string, for the single trail entry that records it.
 *
 * JSON, and the choice is about the READER rather than about the writer. The
 * field it lands in also carries sentences written by other paths, so whoever
 * reads it has to tell a structure from a phrase with certainty: `JSON.parse`
 * refuses a sentence outright, which makes that test total instead of a guess
 * at a prefix. It also spares the two sides a hand written parser, which is
 * exactly where a format joined on `:` and `,` drifts the day a value contains
 * one of them.
 *
 * What travels is codes and counts (REQ-163). The screen translates them from
 * the catalogue after `decodeNoMatch` gives the pairs back, so rewording the
 * operator's text never touches a single stored row.
 */
export function encodeNoMatch(refused: readonly MatchTally[]): string {
  return JSON.stringify({ code: NO_MATCH_CODE, refusals: refused });
}

/**
 * The pairs back, or `undefined` when this reason is not one of these records:
 * a row written before REQ-160, or a reason some other path phrased in words.
 *
 * Strict on purpose. A refusal code this build does not know makes the whole
 * value unreadable rather than being quietly skipped, because skipping would
 * under-report a count the operator is reading as complete, while an
 * unreadable value is visible and falls back to showing the reason as it was
 * stored.
 *
 * An empty list is a legitimate answer and is NOT the same as `undefined`: it
 * says the event matched nothing because there was no automation to refuse it.
 */
export function decodeNoMatch(
  reason: string | undefined,
): readonly MatchTally[] | undefined {
  if (reason === undefined) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(reason);
  } catch {
    return undefined;
  }

  const record = asRecord(parsed);
  if (record?.["code"] !== NO_MATCH_CODE) return undefined;

  const refusals = record["refusals"];
  if (!Array.isArray(refusals)) return undefined;

  const tally: MatchTally[] = [];

  for (const raw of refusals) {
    const entry = asRecord(raw);
    const reasonCode = entry?.["reason"];
    const count = entry?.["count"];

    if (
      !isMatchRefusal(reasonCode) ||
      typeof count !== "number" ||
      !Number.isInteger(count) ||
      count <= 0
    ) {
      return undefined;
    }

    tally.push({ reason: reasonCode, count });
  }

  return tally;
}
