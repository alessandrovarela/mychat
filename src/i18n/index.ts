import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createTranslator, DEFAULT_LOCALE } from "./translator.js";
import type { Catalogue, CatalogueSet, Translator } from "./translator.js";

/**
 * Operator-facing text lives in catalogues, never in code (REQ-073).
 *
 * The catalogues are DISCOVERED at load time by reading `locales/`, which is
 * what makes the requirement's second half true: adding a language is adding a
 * file, with no code change anywhere. A hard-coded list of locales would still
 * satisfy the first half and quietly break the second.
 *
 * This module is the NODE half: it reads the directory and holds the one
 * translator the whole process shares, so a language chosen in the panel also
 * changes what the audit trail and the terminal say (REQ-074). The rules
 * themselves (fallback to English, and what a key missing everywhere renders)
 * live in `translator.js`, because the interface applies exactly the same ones
 * and gets its catalogues from the bundler instead of from disk.
 *
 * Scope note: this covers text the APPLICATION says to the operator. Text the
 * operator writes inside their own flows is content, and is never translated
 * (global constraint of the application spec).
 */

const LOCALES_DIR = fileURLToPath(new URL("locales", import.meta.url));

export { DEFAULT_LOCALE, MISSING_TEXT_KEY } from "./translator.js";

export type { Catalogue, CatalogueSet, Translator } from "./translator.js";

/**
 * Reads the catalogue directory. A locale IS a file: `pt-BR.json` is the
 * `pt-BR` locale, so the file name is the single source of what exists.
 */
export function availableLocales(dir: string = LOCALES_DIR): string[] {
  return readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => name.slice(0, -".json".length))
    .sort();
}

export function loadCatalogue(
  locale: string,
  dir: string = LOCALES_DIR,
): Catalogue {
  return JSON.parse(readFileSync(`${dir}/${locale}.json`, "utf8")) as Catalogue;
}

function loadCatalogues(dir: string): CatalogueSet {
  const catalogues: Record<string, Catalogue> = {};

  for (const locale of availableLocales(dir)) {
    catalogues[locale] = loadCatalogue(locale, dir);
  }

  return catalogues;
}

/**
 * The translator the process shares. Exported so the composition root can hand
 * it to whatever changes the locale, instead of that code importing a mutable
 * module-level function and hoping it is the same one.
 */
export const catalogue: Translator = createTranslator(
  loadCatalogues(LOCALES_DIR),
  DEFAULT_LOCALE,
);

/**
 * Resolves a catalogue key. Interpolation values are named, never positional,
 * so a translator can reorder a sentence without breaking it.
 */
export function t(key: string, params?: Record<string, unknown>): string {
  return catalogue.t(key, params);
}

/**
 * Switches the locale in force. Unknown locale falls back to the default
 * rather than throwing: a misconfigured language must not stop the process
 * from reporting the very error that would explain it.
 */
export async function useLocale(locale: string): Promise<string> {
  return catalogue.use(locale);
}

/** The locale currently in force. */
export function currentLocale(): string {
  return catalogue.current();
}
