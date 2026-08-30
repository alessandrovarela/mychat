import i18next from "i18next";

/**
 * The catalogue mechanism itself, with no filesystem anywhere in it.
 *
 * Split out of `index.ts` because the SAME rules have to hold on both sides of
 * the process: the Node half discovers the catalogues by reading `locales/`,
 * and the interface half receives them from its bundler (`src/web/locale.tsx`),
 * which has no `node:fs` and never will. Two translators would be two answers
 * to "what happens when a key is missing", and the operator would meet
 * whichever half was wrong.
 *
 * ADR-008 chose an established catalogue library over a hand-rolled one, so
 * plural forms and interpolation are its business and not this file's.
 */

/** The locale used when none is configured, and the fallback for gaps. */
export const DEFAULT_LOCALE = "en";

/**
 * What is shown when a key resolves in NO catalogue at all (REQ-075).
 *
 * It is a catalogue key like any other, so the sentence is translated and no
 * text is written in this file. Three candidates were weighed:
 *
 *   - the key itself, which is what i18next does by default. Refused by
 *     REQ-075 in as many words: the internal key must not reach the screen.
 *   - the empty string, which hides the gap completely: a button with no
 *     label reads as "there is nothing to say here", and the operator has no
 *     way to tell a blank from a hole.
 *   - a neutral sentence, chosen here: the operator learns this build has no
 *     text for that spot, which is true, and learns nothing about our
 *     internals, which is the requirement.
 *
 * It stays unreachable in a shipped build anyway: `catalogue.test.ts` walks
 * every `t("...")` in the sources and fails when a key is absent from the
 * default catalogue, so a gap is a red gate rather than a placeholder on a
 * screen. The placeholder is what happens when that guard is somehow passed.
 */
export const MISSING_TEXT_KEY = "catalogue.missingText";

export type Catalogue = Record<string, unknown>;

/** Every catalogue this build has, by locale name (`en`, `pt-BR`). */
export type CatalogueSet = Readonly<Record<string, Catalogue>>;

export interface Translator {
  /**
   * Resolves a catalogue key in the locale in force. Interpolation values are
   * named, never positional, so a translator can reorder a sentence without
   * breaking it.
   */
  t(key: string, params?: Record<string, unknown>): string;
  /** Switches the locale in force, answering the one actually adopted. */
  use(locale: string): Promise<string>;
  /** The locale currently in force. */
  current(): string;
  /** The locales this build carries, sorted. */
  locales(): readonly string[];
}

/**
 * The locale that will actually be used for `wanted`: the default whenever
 * this build carries no catalogue for it.
 *
 * A misconfigured language must not stop the process from reporting the very
 * error that would explain it, which is why this answers instead of throwing.
 */
export function knownLocale(
  wanted: string | undefined,
  available: readonly string[],
): string {
  return wanted !== undefined && available.includes(wanted)
    ? wanted
    : DEFAULT_LOCALE;
}

export function createTranslator(
  catalogues: CatalogueSet,
  locale: string = DEFAULT_LOCALE,
): Translator {
  const available = Object.keys(catalogues).sort();
  const resources: Record<string, { translation: Catalogue }> = {};

  for (const name of available) {
    resources[name] = { translation: catalogues[name] ?? {} };
  }

  const instance = i18next.createInstance();

  // Synchronous with inline resources (there is no loader to wait for), so a
  // caller gets a translator that already resolves, and the interface can build
  // one during a render instead of waiting a frame for its own text.
  void instance.init({
    lng: knownLocale(locale, available),
    // The English catalogue is the reference, and this is the whole of the
    // first half of REQ-075: a key the chosen locale does not carry is looked
    // up here, so the operator reads English rather than nothing.
    fallbackLng: DEFAULT_LOCALE,
    resources,
    // The second half of REQ-075, and the ONE branch i18next does not cover on
    // its own: with no handler it renders the key, verified rather than
    // assumed. Called only when neither the chosen locale nor English has the
    // key, so it never intercepts the fallback above.
    parseMissingKeyHandler: (key: string): string =>
      // Guarded against itself: if the placeholder is the missing key, looking
      // it up would call this handler again, forever.
      key === MISSING_TEXT_KEY ? "" : instance.t(MISSING_TEXT_KEY),
    interpolation: {
      // These strings reach a terminal, a log, and React, which escapes on
      // render. Escaping here would corrupt paths and quoted identifiers in the
      // first two for a protection the third already provides.
      escapeValue: false,
    },
  });

  return {
    t: (key: string, params?: Record<string, unknown>): string =>
      instance.t(key, params ?? {}),

    use: async (wanted: string): Promise<string> => {
      const chosen = knownLocale(wanted, available);
      await instance.changeLanguage(chosen);
      return chosen;
    },

    current: (): string => instance.language,

    locales: (): readonly string[] => available,
  };
}
