import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ReactElement, ReactNode } from "react";
import { createTranslator } from "../i18n/translator.js";
import type { Catalogue, CatalogueSet } from "../i18n/translator.js";
import { isUnauthorizedFailure } from "./http-failure.js";

/**
 * How the interface knows which language it is in, and where its text comes
 * from (REQ-074, REQ-075, REQ-102).
 *
 * Two halves that deliberately travel by different roads:
 *
 *   - the CATALOGUES are bundled. The build discovers them the same way the
 *     Node half discovers them (a file per locale, and adding a language is
 *     adding a file), so the text is in the page from the first paint and a
 *     screen never renders blank while a translation downloads.
 *   - the CHOICE comes from the instance, over `/api/locale`, on every mount.
 *     That is what makes criterion 44 hold across a reload: the browser keeps
 *     no copy to go stale, so the page shows what the instance stores and
 *     nothing else. A restart of the process changes nothing here, because the
 *     answer comes from the database either way.
 *
 * Fallback and missing-key behaviour are NOT reimplemented here: `t` is the
 * translator from `src/i18n/translator.ts`, the same rules the backend applies.
 */

const LOCALE_ENDPOINT = "/api/locale";

/** What the instance answers about its language. */
export interface LocaleState {
  readonly locale: string;
  readonly available: readonly string[];
}

/** The two calls the interface makes, so a test drives them with a double. */
export interface LocaleClient {
  read(): Promise<LocaleState>;
  write(locale: string): Promise<LocaleState>;
}

async function readState(response: Response): Promise<LocaleState> {
  if (!response.ok) {
    throw new Error(String(response.status));
  }

  return (await response.json()) as LocaleState;
}

/** The real client: same origin, so the session cookie travels on its own. */
export const httpLocaleClient: LocaleClient = {
  read: async (): Promise<LocaleState> =>
    readState(await fetch(LOCALE_ENDPOINT)),

  write: async (locale: string): Promise<LocaleState> =>
    readState(
      await fetch(LOCALE_ENDPOINT, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ locale }),
      }),
    ),
};

/**
 * Every catalogue in the repository, resolved by the bundler at build time.
 *
 * A glob rather than a list of imports, and that is REQ-073's second half on
 * this side of the boundary: a new `locales/xx-YY.json` is picked up with no
 * edit here, exactly as the Node half picks it up by reading the directory.
 */
const BUNDLED_CATALOGUES: CatalogueSet = ((): CatalogueSet => {
  const files = import.meta.glob("../i18n/locales/*.json", {
    eager: true,
    import: "default",
  }) as Record<string, Catalogue>;

  const catalogues: Record<string, Catalogue> = {};

  for (const [path, catalogue] of Object.entries(files)) {
    // `../i18n/locales/pt-BR.json` is the `pt-BR` locale: the file name is the
    // single source of what exists, on this side too.
    const name = path.slice(path.lastIndexOf("/") + 1, -".json".length);
    catalogues[name] = catalogue;
  }

  return catalogues;
})();

export interface LocaleContextValue extends LocaleState {
  /** Resolves a catalogue key in the language in force. */
  t(key: string, params?: Record<string, unknown>): string;
  /** Adopts a language already persisted through another trusted boundary. */
  apply(locale: string): Promise<void>;
  /** Stores the choice in the instance, then re-renders in it. */
  choose(locale: string): Promise<void>;
  /** True while the last choice could not be stored. */
  failed: boolean;
  /** Why the initial private read failed, when it did. */
  readFailure?: "failed" | "unauthorized";
  /** Whether the last refused language write lacked a valid session. */
  writeUnauthorized: boolean;
}

/**
 * The value a screen rendered outside the provider sees: the default language,
 * over the bundled catalogues, and a choice that cannot be stored because there
 * is nothing to store it through. English for a screen with no provider is the
 * same rule REQ-075 already states for a text with no translation, which is why
 * it renders rather than throws.
 */
const detached = createTranslator(BUNDLED_CATALOGUES);

const LocaleContext = createContext<LocaleContextValue>({
  locale: detached.current(),
  available: detached.locales(),
  t: detached.t,
  apply: (): Promise<void> => Promise.resolve(),
  choose: (): Promise<void> => Promise.resolve(),
  failed: false,
  writeUnauthorized: false,
});

export interface LocaleProviderProps {
  readonly children: ReactNode;
  /** Injected by tests. The running interface always talks to `/api/locale`. */
  readonly client?: LocaleClient;
  /** Injected by tests, which need a gap the real catalogues do not have. */
  readonly catalogues?: CatalogueSet;
}

export function LocaleProvider({
  children,
  client = httpLocaleClient,
  catalogues,
}: LocaleProviderProps): ReactElement {
  const translator = useMemo(
    () => createTranslator(catalogues ?? BUNDLED_CATALOGUES),
    [catalogues],
  );

  const [locale, setLocale] = useState(translator.current());
  const [failed, setFailed] = useState(false);
  const [readFailure, setReadFailure] = useState<
    "failed" | "unauthorized" | undefined
  >(undefined);
  const [writeUnauthorized, setWriteUnauthorized] = useState(false);
  const live = useRef(true);

  const apply = useCallback(
    async (wanted: string): Promise<void> => {
      const applied = await translator.use(wanted);
      if (live.current) {
        setLocale(applied);
      }
    },
    [translator],
  );

  const adopt = useCallback(
    async (state: LocaleState): Promise<void> => apply(state.locale),
    [apply],
  );

  useEffect(() => {
    live.current = true;

    void (async (): Promise<void> => {
      try {
        await adopt(await client.read());
        if (live.current) setReadFailure(undefined);
      } catch (failure) {
        // The instance could not be asked, so the default language stays in
        // force. A panel in English is worse than a panel in Portuguese and far
        // better than a panel that refuses to render.
        if (live.current) {
          setLocale(translator.current());
          setReadFailure(
            isUnauthorizedFailure(failure) ? "unauthorized" : "failed",
          );
        }
      }
    })();

    return (): void => {
      live.current = false;
    };
  }, [adopt, client, translator]);

  const choose = useCallback(
    async (wanted: string): Promise<void> => {
      try {
        await adopt(await client.write(wanted));
        if (live.current) {
          setFailed(false);
          setWriteUnauthorized(false);
        }
      } catch (failure) {
        // Nothing was stored, so nothing changes on screen either: showing the
        // new language over a preference that was refused would be a lie the
        // next reload corrects.
        if (live.current) {
          setFailed(true);
          setWriteUnauthorized(isUnauthorizedFailure(failure));
        }
      }
    },
    [adopt, client],
  );

  const value = useMemo<LocaleContextValue>(
    () => ({
      locale,
      available: translator.locales(),
      // Rebuilt on every language change on purpose: `translator.t` is stable,
      // and a stable function would let React keep a memoised subtree in the
      // previous language.
      t: (key: string, params?: Record<string, unknown>): string =>
        translator.t(key, params),
      apply,
      choose,
      failed,
      readFailure,
      writeUnauthorized,
    }),
    [locale, translator, apply, choose, failed, readFailure, writeUnauthorized],
  );

  return (
    <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>
  );
}

/** What every screen uses to write a word on the page. */
export function useLocale(): LocaleContextValue {
  return useContext(LocaleContext);
}

/**
 * A language's own name, in that language: "English", "português (Brasil)".
 *
 * Taken from the platform's locale data rather than from the catalogue, and
 * that is not a shortcut. A label in the catalogue would have to be translated
 * into every language for every language, and the file a contributor adds for a
 * new locale could not name itself in the ones that already exist: the selector
 * would show the code. This names any locale the browser knows, including one
 * added after this code was written.
 */
export function languageName(locale: string): string {
  try {
    return (
      new Intl.DisplayNames([locale], { type: "language" }).of(locale) ?? locale
    );
  } catch {
    // An invented locale the platform cannot name is still selectable, and its
    // own code is the honest label for it.
    return locale;
  }
}
