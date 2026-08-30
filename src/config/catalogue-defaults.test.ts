import { describe, expect, it } from "vitest";
import { loadCatalogue } from "../i18n/index.js";
import {
  lengthAdvice,
  measureLength,
} from "../web/components/length-advice.js";
import { LIMIT_DEFAULTS } from "./limits.js";

/**
 * REQ-340: nothing the product SHIPS is predicted as cut.
 *
 * The advice layer exists to warn the operator that what they typed will reach
 * the contact shortened. A value they never typed, because it came out of our
 * own catalogue, earning that warning is the layer accusing the product of a
 * mistake the product made.
 *
 * It happened, and it is why this file exists. `confirmationQuickReplyDefault`
 * measures 20 graphemes and 21 UTF-16 units in pt-BR, because the padlock is a
 * surrogate pair and counts twice, against a ceiling that said 20. The ceiling
 * was the wrong half: twenty came from a secondary source read on 2026-08-01,
 * and the measurement on the operated account on 2026-08-19 saw the button show
 * 35 characters with an ellipsis. Nobody ever saw the warning, because the
 * layer is wired to one field only, which is what made it a trap for whoever
 * wires the second one.
 *
 * A node test, not a web one, although the layer lives under `src/web`: the
 * catalogue and the ceilings are both backend-visible, `length-advice.ts`
 * touches no DOM, and importing `limits.ts` into the emulated DOM pulls the
 * whole configuration reader with it.
 */

/**
 * Read through the loader the application uses, not imported as a module: a
 * relative `.json` import is refused by REQ-082 (every relative specifier
 * carries the extension Node resolves, and that guard reads `.js`), and going
 * through `loadCatalogue` also proves the file the product actually ships
 * rather than a copy the bundler happened to inline.
 */
const CATALOGUES = [
  ["pt-BR", loadCatalogue("pt-BR")],
  ["en", loadCatalogue("en")],
] as const;

/** Only the corner of the catalogue this file reads. */
interface CatalogueSection {
  readonly automations: {
    readonly confirmationQuickReplyDefault: string;
    readonly confirmationQuestionDefault: string;
  };
}

describe("REQ-340: no catalogue default is predicted as cut", () => {
  it.each(CATALOGUES)(
    "keeps the %s confirmation button label inside the quick reply ceiling",
    (_locale, catalogue) => {
      const label = (catalogue.screens as CatalogueSection).automations
        .confirmationQuickReplyDefault;

      // Through the real layer, not through a reimplementation of it: the
      // point is that the operator sees NO advice, and only the layer can say
      // that. `lengthAdvice` returns nothing when a value is inside every
      // ceiling it has.
      expect(
        lengthAdvice(label, {
          truncatesAt: LIMIT_DEFAULTS.quickReplyLabelChars,
        }),
      ).toBeUndefined();
    },
  );

  it.each(CATALOGUES)(
    "keeps the %s confirmation question inside the card title ceiling",
    (_locale, catalogue) => {
      const question = (catalogue.screens as CatalogueSection).automations
        .confirmationQuestionDefault;

      // This one travels as a CARD TITLE when the message carries a button
      // (REQ-346), and that ceiling is an order of magnitude tighter than the
      // 1000 bytes a plain message accepts. Today it sits just inside, which is
      // precisely why it is guarded: the next person to make this copy a few
      // words warmer would ship a default that arrives cut, and nothing else in
      // the suite would notice.
      expect(measureLength(question).counted).toBeLessThanOrEqual(
        LIMIT_DEFAULTS.cardTitleChars,
      );
    },
  );
});
