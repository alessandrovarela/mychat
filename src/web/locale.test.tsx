import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { App } from "./App.js";
import { TOAST_VIEWPORT_ID } from "./components/index.js";
import {
  httpLocaleClient,
  languageName,
  LocaleProvider,
  useLocale,
} from "./locale.js";
import type { LocaleClient, LocaleState } from "./locale.js";
import { routes } from "./routes.js";

/**
 * The interface half of REQ-074, REQ-075 and REQ-102, in the emulated DOM the
 * gate can afford (ADR-017, ADR-018: no browser, no container).
 *
 * What each criterion needs from this file:
 *
 *   43. the screen renders words, and none of them is written in the code. The
 *       suite's guard for that is in `src/i18n/catalogue.test.ts`, which parses
 *       every `.tsx`; here the proof is positive, that what shows up on the
 *       page is the catalogue's own sentence.
 *   44. a fresh mount, which is what a reload is, asks the instance and adopts
 *       whatever it answers. The browser keeps nothing of its own, so there is
 *       no copy left to disagree with a process that restarted.
 *   45. a key the chosen catalogue lacks renders in English, with the internal
 *       key nowhere on the page.
 */

const PT = "pt-BR";
const EN = "en";

/**
 * The LANGUAGE control, picked out by what it OFFERS and not by its label.
 *
 * The settings screen has carried a second selector since REQ-326: the theme,
 * which belongs to the browser rather than to the instance. Neither can be
 * found by its label here, because every label on that screen is itself
 * translated and this file crosses languages on purpose. What separates them is
 * their options: the language offers locale codes, and a code reads the same in
 * every language there is.
 */
function languageControl(): HTMLSelectElement {
  const offering = screen
    .getAllByRole("combobox")
    .filter((control) =>
      [...(control as HTMLSelectElement).options].some(
        (option) => option.value === EN,
      ),
    );

  expect(offering).toHaveLength(1);

  return offering[0] as HTMLSelectElement;
}

/** The instance, as the interface sees it: one row that answers and remembers. */
function createClientDouble(initial: string): LocaleClient & {
  readonly writes: string[];
  stored: string;
} {
  const double = {
    stored: initial,
    writes: [] as string[],

    read: (): Promise<LocaleState> =>
      Promise.resolve({ locale: double.stored, available: [EN, PT] }),

    write: (locale: string): Promise<LocaleState> => {
      double.writes.push(locale);
      double.stored = locale;
      return Promise.resolve({ locale, available: [EN, PT] });
    },
  };

  return double;
}

function Probe({ textKey }: { readonly textKey: string }): ReactElement {
  const { locale, t } = useLocale();

  return (
    <div>
      <span data-testid="locale">{locale}</span>
      <span data-testid="text">{t(textKey)}</span>
    </div>
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("REQ-102: the language of the instance drives the interface", () => {
  it("renders the screen in the language the instance answers with", async () => {
    const client = createClientDouble(PT);

    render(
      <LocaleProvider client={client}>
        <App routes={routes} pathname="/settings/language" />
      </LocaleProvider>,
    );

    // The catalogue's own sentence, not a word of it written in a component
    // (criterion 43): the assertion is against the shipped `pt-BR` file.
    expect(
      await screen.findByRole("heading", { name: "Configurações" }),
    ).toBeInTheDocument();
  });

  it("keeps the choice across a reload, because the page never decides it", async () => {
    const user = userEvent.setup();
    const client = createClientDouble(PT);

    const first = render(
      <LocaleProvider client={client}>
        <App routes={routes} pathname="/settings/language" />
      </LocaleProvider>,
    );

    await screen.findByRole("heading", { name: "Configurações" });
    await user.selectOptions(languageControl(), EN);

    // Stored BEFORE the screen changes language: a panel that switched first
    // and wrote afterwards would show a preference the instance refused.
    await waitFor(() => {
      expect(client.writes).toEqual([EN]);
    });
    expect(
      await screen.findByRole("heading", { name: "Settings" }),
    ).toBeInTheDocument();

    // The reload: everything the page held is gone, and the instance is asked
    // again. This is also what a restarted process looks like from here, since
    // the answer comes from the database on both sides of it.
    first.unmount();

    render(
      <LocaleProvider client={client}>
        <App routes={routes} pathname="/settings/language" />
      </LocaleProvider>,
    );

    expect(
      await screen.findByRole("heading", { name: "Settings" }),
    ).toBeInTheDocument();
  });

  it("reads and writes the instance over the declared route", async () => {
    // The default client, which the tests above replace: the address, the
    // method and the body it sends are the contract `/api/locale` declares.
    const fetchStub = vi.fn(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ locale: PT, available: [EN, PT] }),
      } as Response),
    );

    vi.stubGlobal("fetch", fetchStub);

    expect(await httpLocaleClient.read()).toEqual({
      locale: PT,
      available: [EN, PT],
    });
    expect(fetchStub).toHaveBeenCalledWith("/api/locale");

    await httpLocaleClient.write(PT);

    expect(fetchStub).toHaveBeenLastCalledWith("/api/locale", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ locale: PT }),
    });
  });

  it("stays on the previous language when the instance refuses the choice", async () => {
    const user = userEvent.setup();
    const refusing: LocaleClient = {
      read: (): Promise<LocaleState> =>
        Promise.resolve({ locale: PT, available: [EN, PT] }),
      write: (): Promise<LocaleState> => Promise.reject(new Error("422")),
    };

    render(
      <LocaleProvider client={refusing}>
        <App routes={routes} pathname="/settings/language" />
      </LocaleProvider>,
    );

    await screen.findByRole("heading", { name: "Configurações" });
    await user.selectOptions(languageControl(), EN);

    // In the corner and no longer in the page (REQ-312), which is also what
    // separates it from the blocks Settings raises beside it: nothing answers
    // `/api/instance` in this test, so the zone and the switches it could not
    // READ are reported too (REQ-166), and those stay boxes because they are
    // conditions of the screen rather than answers to anything pressed.
    const strip = await waitFor(() => {
      const found = document.getElementById(TOAST_VIEWPORT_ID);

      if (found === null) throw new Error("no toast has been raised");

      return found;
    });

    expect(within(strip).getByRole("status").textContent).toContain(
      "Não foi possível gravar o idioma",
    );
    // Still Portuguese: nothing was stored, so nothing changed on screen.
    expect(
      screen.getByRole("heading", { name: "Configurações" }),
    ).toBeInTheDocument();
  });

  it("renders in the default language when the instance cannot be reached", async () => {
    const offline: LocaleClient = {
      read: (): Promise<LocaleState> => Promise.reject(new Error("offline")),
      write: (): Promise<LocaleState> => Promise.reject(new Error("offline")),
    };

    render(
      <LocaleProvider client={offline}>
        <App routes={routes} pathname="/settings/language" />
      </LocaleProvider>,
    );

    // A panel in English beats a panel that refuses to render.
    expect(
      await screen.findByRole("heading", { name: "Settings" }),
    ).toBeInTheDocument();
  });
});

describe("REQ-075: a key the chosen catalogue lacks (criterion 45)", () => {
  const catalogues = {
    en: {
      probe: "English text",
      catalogue: { missingText: "(no text)" },
    },
    "pt-BR": { catalogue: { missingText: "(sem texto)" } },
  };

  it("shows the English text and never the key, with the screen still up", async () => {
    render(
      <LocaleProvider client={createClientDouble(PT)} catalogues={catalogues}>
        <Probe textKey="probe" />
      </LocaleProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("locale")).toHaveTextContent(PT);
    });

    expect(screen.getByTestId("text")).toHaveTextContent("English text");
    expect(document.body.textContent).not.toContain("probe");
  });

  it("shows no internal key when no catalogue has it at all", async () => {
    render(
      <LocaleProvider client={createClientDouble(PT)} catalogues={catalogues}>
        <Probe textKey="nowhere.at.all" />
      </LocaleProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("locale")).toHaveTextContent(PT);
    });

    expect(screen.getByTestId("text")).toHaveTextContent("(sem texto)");
    expect(document.body.textContent).not.toContain("nowhere.at.all");
  });
});

describe("the language selector names each language in that language", () => {
  it("uses the platform's own names, so a new catalogue needs no label", () => {
    expect(languageName(EN)).toBe("English");
    expect(languageName(PT).toLowerCase()).toContain("portugu");
    // A locale the platform has no name for is still labelled, and a tag it
    // cannot even parse falls back to itself instead of taking the screen down.
    expect(languageName("zz-ZZ")).not.toBe("");
    expect(languageName("not a locale")).toBe("not a locale");
  });
});
