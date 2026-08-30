import { DEFAULT_LOCALE, knownLocale } from "./translator.js";
import type { Translator } from "./translator.js";

/**
 * The language of the instance, and who gets to decide it (REQ-102).
 *
 * The rule is one sentence and the whole design follows from it: the operator's
 * choice is authoritative, and the environment supplies only the INITIAL value,
 * used while no choice has been made. So the stored value is read first, on
 * every start, and the environment variable is consulted exactly when the store
 * is empty. Reading the environment first would work perfectly on the machine
 * that never sets it and would silently overrule the panel on the machine that
 * does, which is the failure this order exists to make impossible.
 *
 * The port is declared here rather than in `src/storage` because this module
 * owns the rule and the table is one way of keeping it. `createPreferenceStore`
 * in `src/storage/preferences.ts` is the binding the process actually uses.
 */

/** The row that carries the language in `instance_preferences`. */
export const LOCALE_PREFERENCE_KEY = "locale";

/**
 * The environment variable that seeds a fresh installation. Named here, beside
 * the rule it belongs to, because it is not configuration the process depends
 * on: an absent or unknown value simply leaves the default in force, and no
 * start-up check has anything to refuse.
 */
export const INITIAL_LOCALE_VARIABLE = "MYCHAT_LOCALE";

/** Refusal code for a language this build carries no catalogue for. */
export const UNKNOWN_LOCALE = "unknown_locale";

export interface LocalePreferenceStore {
  /** Undefined while the operator has never chosen: not the same as English. */
  read(): Promise<string | undefined>;
  write(locale: string, now: Date): Promise<void>;
}

/** Where the locale in force came from, which is what REQ-102 is about. */
export type LocaleSource = "stored" | "environment" | "default";

export interface LocaleInForce {
  readonly locale: string;
  readonly source: LocaleSource;
}

export type LocaleChoice =
  | { readonly ok: true; readonly locale: string }
  | { readonly ok: false; readonly refusal: typeof UNKNOWN_LOCALE };

export interface LocalePreferenceDeps {
  readonly store: LocalePreferenceStore;
  /** The catalogues in this build, and the thing a choice switches. */
  readonly catalogue: Translator;
  /** Read for the initial value only. `process.env` satisfies it. */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Injected so a test asserts an instant instead of racing the machine's. */
  readonly now: () => Date;
}

export interface LocalePreference {
  /** The languages this build can be switched to. */
  available(): readonly string[];
  /** What is in force, and why, without changing anything. */
  inForce(): Promise<LocaleInForce>;
  /** Resolves and switches the process catalogue. Called once, at start-up. */
  apply(): Promise<LocaleInForce>;
  /** The panel's choice: persisted, then applied. Refuses an unknown locale. */
  choose(locale: string): Promise<LocaleChoice>;
}

export function createLocalePreference(
  deps: LocalePreferenceDeps,
): LocalePreference {
  const available = deps.catalogue.locales();

  async function resolve(): Promise<LocaleInForce> {
    const stored = await deps.store.read();

    if (stored !== undefined) {
      // A stored value this build cannot render still counts as a choice that
      // was made: it falls back to English for the text, and the row is left
      // alone. Overwriting it would lose the operator's choice the first time
      // they started a build that happened to ship one catalogue fewer.
      return { locale: knownLocale(stored, available), source: "stored" };
    }

    const seeded = deps.env[INITIAL_LOCALE_VARIABLE];
    if (seeded !== undefined && seeded.trim() !== "") {
      return {
        locale: knownLocale(seeded.trim(), available),
        source: "environment",
      };
    }

    return { locale: DEFAULT_LOCALE, source: "default" };
  }

  return {
    available: (): readonly string[] => available,

    inForce: resolve,

    apply: async (): Promise<LocaleInForce> => {
      const resolved = await resolve();
      await deps.catalogue.use(resolved.locale);
      return resolved;
    },

    choose: async (locale: string): Promise<LocaleChoice> => {
      if (!available.includes(locale)) {
        // Refused rather than quietly stored as English: a row holding a
        // language nothing can render would make the instance permanently
        // English while the table claimed otherwise.
        return { ok: false, refusal: UNKNOWN_LOCALE };
      }

      await deps.store.write(locale, deps.now());
      // Applied here and not by the caller, so the process cannot end up
      // answering in one language and having stored another.
      await deps.catalogue.use(locale);

      return { ok: true, locale };
    },
  };
}
