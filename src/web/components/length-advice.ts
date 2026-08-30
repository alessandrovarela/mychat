/**
 * What the length of a value earns below the field, while it is being typed
 * (REQ-307, REQ-308).
 *
 * Not a component: the decision only. `Field` draws the sentence this answers
 * for, and the sentence itself comes from the catalogue, passed by the screen,
 * as every word a component renders does.
 *
 * TWO natures, one layer, and the difference between them is the whole point:
 *
 *   - TRUNCATION is a PREDICTION. The platform accepts the text and cuts what
 *     it SHOWS, so the definition is stored whole and the contact reads less
 *     than was written. Nothing is refused, and an advice drawn like a refusal
 *     would be a lie about what is going to happen.
 *   - LIMIT is a REFUSAL that has not happened yet. Past it the value is turned
 *     away when the definition is saved, so it is said while there is still
 *     something to do about it.
 *
 * The numbers are NOT here. Both ceilings arrive from the caller, which reads
 * them from configuration (`src/config/limits.ts`, and the instance's own
 * bounds over the API): a platform number spelled into a screen is the defect
 * this project forbids outright.
 *
 * Until phase 3o the truncation ceiling was a REFUSAL, in `src/flows/
 * validation.ts`. The measurement on the real account on 2026-08-19 undid it: a
 * quick reply of 67 characters was accepted, the button showed 35 of them with
 * an ellipsis, and the webhook echo came back whole (REQ-306, and the note "O
 * corte do rótulo" in `docs/platform-limits.md`). What the platform cuts on
 * screen is presentation, and presentation is what this file predicts.
 */

/**
 * The two natures, in the order they are DECIDED in: a value past both ceilings
 * is going to be refused, and telling it it will arrive cut is telling it about
 * a delivery that is never going to happen.
 */
export const LENGTH_ADVICE_NATURES = ["limit", "truncation"] as const;

export type LengthAdviceNature = (typeof LENGTH_ADVICE_NATURES)[number];

/**
 * The ceilings of one field, each optional because most fields have one and not
 * the other: a quick reply label is cut and never refused, a card title is
 * refused, and a field with neither asks for no advice at all.
 */
export interface LengthCeilings {
  /** Where the platform starts cutting what it SHOWS. */
  readonly truncatesAt?: number;
  /** Where the value stops being accepted when the definition is saved. */
  readonly refusesAt?: number;
}

/**
 * How long a value is, counted BOTH ways, because the two disagree and nobody
 * has established which one the platform counts.
 *
 * `units` is what `String.length` answers: UTF-16 code units, where an emoji
 * costs two. `graphemes` is what a person counts: one per character they see. A
 * label of twenty visible characters ending in a lock measured twenty-one, and
 * a count that argues with anybody counting by eye was one of the findings that
 * brought down the refusal (REQ-306).
 *
 * Which unit the platform truncates by is NOT settled: the measurement of
 * 2026-08-19 cut at 35 visible against 36 units on the quick reply and 36
 * against 36 on the URL button, one sample of each, and a cut by rendered WIDTH
 * would produce numbers like those too.
 *
 * So the advice fires on whichever count reaches the ceiling FIRST, which is
 * the larger of the two. Erring high costs an advice shown a character early;
 * erring low costs the text arriving cut with NO advice, which is the damage.
 * Said plainly rather than left to be discovered: a grapheme is one or more
 * code units and never fewer, so `units` is the count that arrives first today,
 * and `counted` states that rule instead of assuming it holds. `graphemes` is
 * kept because it is the number to SHOW: a counter beside a field reading 21 of
 * a text its reader counts as 20 is a counter arguing with them.
 */
export interface LengthMeasurement {
  /** What a person counts: the characters they see. */
  readonly graphemes: number;
  /** What `String.length` counts: UTF-16 code units, an emoji worth two. */
  readonly units: number;
  /** The count that reaches a ceiling first, and the one advice is decided on. */
  readonly counted: number;
}

export interface LengthAdvice {
  readonly nature: LengthAdviceNature;
  /** The ceiling that was passed, so the sentence can name the number. */
  readonly limit: number;
  readonly measured: LengthMeasurement;
}

/**
 * The sentence each nature is said in, by catalogue key.
 *
 * Keyed by the union and not by `string`, so a nature added here without a
 * sentence is a compiler error rather than a field that advises nobody.
 */
export const LENGTH_ADVICE_TEXT_KEYS: Readonly<
  Record<LengthAdviceNature, string>
> = {
  limit: "field.limitWarning",
  truncation: "field.truncationWarning",
};

/**
 * Built once: a segmenter allocates its own break iterator, and this runs on
 * every keystroke of every field that has a ceiling.
 *
 * No locale, on purpose. Grapheme breaking is the same everywhere the Unicode
 * algorithm is, and passing the interface's language would make the count of a
 * label depend on the panel's language, which nothing about the platform's cut
 * does.
 */
const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export function measureLength(value: string): LengthMeasurement {
  const graphemes = [...GRAPHEMES.segment(value)].length;
  const units = value.length;

  return { graphemes, units, counted: Math.max(graphemes, units) };
}

/**
 * The advice a value has earned, or nothing while it is inside every ceiling
 * it has.
 *
 * Strictly past, never at: a ceiling of twenty means twenty characters arrive
 * whole, and advising at the twentieth would be advising about a text that is
 * fine.
 */
export function lengthAdvice(
  value: string,
  ceilings: LengthCeilings,
): LengthAdvice | undefined {
  const measured = measureLength(value);

  for (const nature of LENGTH_ADVICE_NATURES) {
    const limit =
      nature === "limit" ? ceilings.refusesAt : ceilings.truncatesAt;

    if (limit !== undefined && measured.counted > limit) {
      return { nature, limit, measured };
    }
  }

  return undefined;
}
