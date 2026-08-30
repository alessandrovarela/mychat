import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import en from "../../i18n/locales/en.json";
import pt from "../../i18n/locales/pt-BR.json";
import type { UnifiedAutomation } from "../../flows/schema.js";
import { createTranslator } from "../../i18n/translator.js";
import {
  AUTOMATION_START_ADDRESS,
  AutomationsScreen,
  AutomationStartScreen,
  automationPreview,
  emphasised,
  FILTER_THRESHOLD,
  httpAutomationsClient,
  httpUnreadableAutomationsClient,
  identityOf,
} from "./automations.js";
import type {
  AutomationClickMetrics,
  AutomationsClient,
  UnreadableAutomationsClient,
} from "./automations.js";
import { formatDate } from "./publications.js";
import type { PublicationFinder, PublicationRow } from "./publications.js";

/** The screen's own words, read from the catalogue it renders from (REQ-074). */
const copy = en.screens.automations;

/** Resolves a catalogue entry the way the translator does, for a comparison. */
function resolve(
  template: string,
  params: Record<string, string | number>,
): string {
  return Object.entries(params).reduce(
    (resolved, [name, value]) =>
      resolved.split(`{{${name}}}`).join(String(value)),
    template,
  );
}

const CREATED_AT = "2026-08-14T12:00:00Z";
const TARGET = "17900000000000000";
const CAPTION = "Walking skeleton";
const THUMBNAIL = "/thumbs/launch.jpg";

/** What the listing calls the fixture below: derived, never the stored name. */
const DERIVED_TITLE = resolve(copy.nameFromCaption, { caption: CAPTION });

/** The same automation named with no caption to hand: the day, never the id. */
const UNNAMED_TITLE = resolve(copy.nameFromPublicationUnnamed, {
  date: formatDate(CREATED_AT, "en"),
});

const WATCHED: PublicationRow = {
  id: TARGET,
  caption: CAPTION,
  mediaType: "IMAGE",
  publishedAt: "2026-06-09T10:00:00Z",
  thumbnailUrl: THUMBNAIL,
};

/**
 * The lookup the listing uses to name the publication it watches (REQ-278).
 *
 * A double per test rather than one shared instance: the call itself is an
 * assertion in one of the tests below, so the record of what was asked has to
 * belong to that test alone.
 */
function finder(
  items: readonly PublicationRow[] = [WATCHED],
): PublicationFinder {
  return { byIds: vi.fn(async () => ({ items })) };
}

beforeEach(() => window.history.pushState({}, "", "/automations"));

const ACTIVE: UnifiedAutomation = {
  schema_version: 2,
  kind: "automation",
  id: "launch",
  state: "active",
  trigger: {
    type: "comment",
    target: TARGET,
    match: { keywords: ["ebook"], mode: "contains" },
  },
  rules: { once_per_contact: true, first_reply_delay_seconds: 5 },
  steps: [
    {
      id: "private-message",
      action: "send_dm",
      message: {
        buttons: [
          {
            id: "download",
            label: "Download",
            url: "https://example.com/book",
          },
        ],
      },
    },
  ],
};

/**
 * What the listing MEASURED of this automation's buttons (REQ-329).
 *
 * It travels on the listed row, which is the whole of what this phase changed:
 * the counts used to be fetched one automation at a time after the rows were
 * already drawn.
 */
const MEASURED: AutomationClickMetrics = {
  automationId: "launch",
  total: 7,
  buttons: [{ buttonId: "download", total: 7 }],
};

function client(): AutomationsClient {
  return {
    list: vi.fn(async () => [
      {
        definition: ACTIVE,
        createdAt: CREATED_AT,
        updatedAt: CREATED_AT,
        clicks: MEASURED,
      },
    ]),
    read: vi.fn(async () => undefined),
    save: vi.fn(async () => ({
      ok: false as const,
      refusal: { error: "unused" },
    })),
    remove: vi.fn(async () => ({ ok: true as const })),
  };
}

describe("REQ-352: the listing lead describes the cards on today's screen", () => {
  it("carries the approved sentence in both shipped languages", async () => {
    expect(en.screens.automations.aggregateHint).toBe(
      "Each card says what the automation does.",
    );
    expect(pt.screens.automations.aggregateHint).toBe(
      "Cada cartão diz o que a automação faz.",
    );

    render(<AutomationsScreen client={client()} finder={finder()} />);

    expect(
      await screen.findByText(en.screens.automations.aggregateHint),
    ).toBeInTheDocument();
  });
});

describe("REQ-222, REQ-329: the counts arrive with the listing", () => {
  it("shows total and per-button clicks", async () => {
    render(<AutomationsScreen client={client()} finder={finder()} />);
    expect(await screen.findByText("7 clicks in total")).toBeInTheDocument();
    expect(screen.getByText("Download: 7 clicks")).toBeInTheDocument();
    expect(screen.queryByText("download: 7 clicks")).not.toBeInTheDocument();
    expect(FILTER_THRESHOLD).toBe(8);
  });

  it("asks for them once, with the listing", async () => {
    const api = client();
    render(<AutomationsScreen client={api} finder={finder()} />);

    // Drawn from the row the listing carried. A listing of twenty automations
    // costs one request, and the last card's figure arrives with its row.
    expect(await screen.findByText("7 clicks in total")).toBeInTheDocument();
    expect(api.list).toHaveBeenCalledTimes(1);
  });

  it("carries the counts of the listing route through to the caller", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          automations: [
            {
              definition: ACTIVE,
              createdAt: CREATED_AT,
              updatedAt: CREATED_AT,
              clicks: MEASURED,
            },
          ],
        }),
        { status: 200 },
      ),
    );

    expect((await httpAutomationsClient.list())[0]?.clicks).toEqual(MEASURED);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    fetchMock.mockRestore();
  });

  it("reads aggregate CRUD from their concrete endpoints", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ automations: [] }), { status: 200 }),
      );
    await httpAutomationsClient.list();
    expect(fetchMock).toHaveBeenNthCalledWith(1, "/api/automations");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    fetchMock.mockRestore();
  });

  it("says nothing about clicks on a row that carries no count", async () => {
    const api = client();
    // The field is ABSENT, which is what the route answers where nothing was
    // measured: no reader wired, or a read that failed. Absent is not zero, and
    // a card that answered "0 clicks in total" would be putting a number nobody
    // counted in front of the operator.
    api.list = vi.fn(async () => [
      { definition: ACTIVE, createdAt: CREATED_AT, updatedAt: CREATED_AT },
    ]);
    render(<AutomationsScreen client={api} finder={finder()} />);
    expect(await screen.findByText(DERIVED_TITLE)).toBeInTheDocument();
    expect(screen.getByText("Active")).toBeInTheDocument();
    expect(
      screen.queryByLabelText("Button click metrics"),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/clicks in total/)).toBeNull();
  });

  it("posts one self-contained save and preserves refusal codes", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          error: "publication_target_conflict",
          target: "post",
        }),
        { status: 409 },
      ),
    );
    const result = await httpAutomationsClient.save(ACTIVE);
    expect(result).toEqual({
      ok: false,
      refusal: { error: "publication_target_conflict", target: "post" },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const init = fetchMock.mock.calls[0]?.[1];
    expect(JSON.parse(String(init?.body))).toEqual({ definition: ACTIVE });
    fetchMock.mockRestore();
  });

  it("deletes through confirmation and keeps the historical metrics out of the request", async () => {
    const api = client();
    const user = userEvent.setup();
    render(<AutomationsScreen client={api} finder={finder()} />);
    expect(await screen.findByText(DERIVED_TITLE)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Delete" }));
    await user.click(
      screen.getByRole("button", { name: "Delete the automation" }),
    );
    await waitFor(() => expect(api.remove).toHaveBeenCalledWith("launch"));
    expect(screen.queryByText(DERIVED_TITLE)).not.toBeInTheDocument();
  });
});

describe("REQ-227: a new automation begins by choosing what starts it", () => {
  it("leads from the listing to the entry, and not straight into the editor", async () => {
    const user = userEvent.setup();
    render(<AutomationsScreen client={client()} finder={finder()} />);

    await user.click(await screen.findByRole("button", { name: copy.new }));

    expect(window.location.pathname).toBe(AUTOMATION_START_ADDRESS);
  });

  it("offers the two entrances as destinations a keyboard reaches", () => {
    render(<AutomationStartScreen />);

    // Real links and not clickable boxes (REQ-116): each carries the address
    // its choice becomes, so it is tabbed to, opened in another tab, copied.
    // The way back is a link too since REQ-276, so the two entrances are the
    // links that go INTO the editor rather than every link on the screen.
    const entrances = screen
      .getAllByRole("link")
      .filter((link) => link.getAttribute("href") !== "/automations");

    expect(entrances.map((entrance) => entrance.getAttribute("href"))).toEqual([
      "/automations/form?trigger=comment",
      "/automations/form?trigger=direct_message",
    ]);
  });

  it("promises a result on each entrance, and names no trigger", () => {
    render(<AutomationStartScreen />);

    expect(
      screen.getByRole("link", { name: new RegExp(copy.startCommentTitle) }),
    ).toHaveTextContent(copy.startCommentOutcome);
    expect(
      screen.getByRole("link", { name: new RegExp(copy.startDirectTitle) }),
    ).toHaveTextContent(copy.startDirectOutcome);
    // The word the operator does not have to learn: each card says what
    // HAPPENS, which is the whole reason this screen exists.
    expect(screen.queryByText(/trigger/i)).toBeNull();
  });

  it("carries the choice into the editor's address", async () => {
    const user = userEvent.setup();
    render(<AutomationStartScreen />);

    await user.click(
      screen.getByRole("link", { name: new RegExp(copy.startDirectTitle) }),
    );

    // The address moved, which in this emulated DOM only `pushState` can do: a
    // card that reloaded the page would leave it exactly where it was.
    expect(window.location.pathname).toBe("/automations/form");
    expect(window.location.search).toBe("?trigger=direct_message");
  });
});

/**
 * The stylesheet, as text.
 *
 * Read through `import.meta.glob` and not through an import, for the reason
 * `styles/tokens.test.ts` records: a `?raw` specifier would break
 * `tests/import-extensions.test.ts` (REQ-082). Same reader as
 * `automation-form.test.tsx`, and the same limit: jsdom applies no stylesheet,
 * so what is decided here is that the rule is in the sheet and that the markup
 * carries the class it is written for. The pixels are a pair of eyes.
 */
const SHEETS = import.meta.glob<string>("../components/components.css", {
  eager: true,
  query: "?raw",
  import: "default",
});

const COMPONENT_SHEET = Object.values(SHEETS)[0] ?? "";

/** The body of the first `{ ... }` after `header`, braces balanced. */
function blockAfter(source: string, header: string): string {
  const open = source.indexOf("{", source.indexOf(header));
  let depth = 0;

  for (let index = open; index < source.length; index += 1) {
    depth += source[index] === "{" ? 1 : source[index] === "}" ? -1 : 0;

    if (depth === 0) {
      return source.slice(open + 1, index);
    }
  }

  return "";
}

describe("REQ-227: each entrance is a picture of what it starts", () => {
  it("keeps the drawing's own rules in the sheet", () => {
    // A sweep that read an empty module would pass every assertion below
    // forever: vitest replaces a stylesheet with nothing unless `css` is on.
    expect(COMPONENT_SHEET.length).toBeGreaterThan(0);

    // The frame the three lines sit in: without a surface of its own the
    // drawing is three grey bars loose at the top of a card.
    expect(blockAfter(COMPONENT_SHEET, ".mc-startcard__art")).toContain(
      "background: var(--bg-sunken);",
    );

    // And the line that is the ACCOUNT's: the accent, on the account's side.
    // Take either declaration away and the two entrances draw the same
    // picture, which is the whole information the drawing carries.
    const mine = blockAfter(COMPONENT_SHEET, ".mc-startcard__line--mine");

    expect(mine).toContain("align-self: flex-end;");
    expect(mine).toContain("background: var(--accent);");
  });

  it("draws it on both entrances, and hides it from the reader", () => {
    const { container } = render(<AutomationStartScreen />);

    const arts = container.querySelectorAll(".mc-startcard__art");

    expect(arts).toHaveLength(2);

    for (const art of arts) {
      // Three grey bars have no alternative text worth hearing: the sentence
      // under them says what the entrance does, in words.
      expect(art.getAttribute("aria-hidden")).toBe("true");
      expect(art.querySelectorAll(".mc-startcard__line")).toHaveLength(3);
    }

    // The exchange each entrance starts, as sides: a comment opens with
    // someone ELSE's line, a direct message opens with the account's own.
    const sides = [...arts].map((art) =>
      [...art.querySelectorAll(".mc-startcard__line")].map((line) =>
        line.classList.contains("mc-startcard__line--mine"),
      ),
    );

    expect(sides).toEqual([
      [false, false, true],
      [true, false, true],
    ]);
  });
});

describe("REQ-228: the listing identifies an automation by what it listens to", () => {
  it("names it after the publication it watches", async () => {
    render(<AutomationsScreen client={client()} finder={finder()} />);

    expect(await screen.findByText(DERIVED_TITLE)).toBeInTheDocument();
  });

  it("says the same thing in the confirmation that ends it", async () => {
    const user = userEvent.setup();
    render(<AutomationsScreen client={client()} finder={finder()} />);

    expect(await screen.findByText(DERIVED_TITLE)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: copy.delete }));

    const consequence = document.querySelector(".mc-consequence__lead");
    expect(consequence).toHaveTextContent(
      `The automation ${DERIVED_TITLE} will stop running. Its click history is kept.`,
    );
  });
});

describe("REQ-381, REQ-382: scope cards are recognisable and scannable", () => {
  const GLOBAL: UnifiedAutomation = {
    ...ACTIVE,
    id: "global",
    scope: { type: "global" },
    trigger: {
      type: "comment",
      match: { keywords: ["ebook"], mode: "contains" },
    },
  };
  const NEXT: UnifiedAutomation = {
    ...ACTIVE,
    id: "next",
    scope: { type: "next_publication" },
    trigger: {
      type: "comment",
      match: { keywords: ["guide"], mode: "contains" },
    },
  };

  function scopedClient(): AutomationsClient {
    return {
      ...client(),
      list: vi.fn(async () => [
        {
          definition: ACTIVE,
          createdAt: CREATED_AT,
          updatedAt: "2026-08-13T12:00:00Z",
        },
        {
          definition: GLOBAL,
          createdAt: CREATED_AT,
          updatedAt: "2026-08-15T12:00:00Z",
        },
        {
          definition: NEXT,
          createdAt: CREATED_AT,
          updatedAt: "2026-08-14T12:00:00Z",
        },
      ]),
    };
  }

  it("puts the latest change first and names global and pending reaches", async () => {
    const { container } = render(
      <AutomationsScreen client={scopedClient()} finder={finder()} />,
    );

    await screen.findByText(DERIVED_TITLE);
    const titles = [...container.querySelectorAll(".mc-card__title")].map(
      (title) => title.textContent,
    );
    expect(titles).toEqual(["Global", "Next publication", DERIVED_TITLE]);
    expect(container.querySelector(".mc-cardlist")).toHaveTextContent(
      "comments with ebook on every publication",
    );
    expect(container.querySelector(".mc-cardlist")).toHaveTextContent(
      "comments with guide on the next publication",
    );
    expect(screen.queryByText(copy.untitled)).not.toBeInTheDocument();
  });

  it("filters global and next-publication cards without treating specific cards as either", async () => {
    const user = userEvent.setup();
    render(<AutomationsScreen client={scopedClient()} finder={finder()} />);
    await screen.findAllByRole("button", { name: "Delete" });

    await user.click(screen.getByRole("button", { name: "Global" }));
    expect(document.querySelectorAll(".mc-card__title")).toHaveLength(1);
    expect(document.querySelector(".mc-card__title")).toHaveTextContent(
      "Global",
    );

    await user.click(screen.getByRole("button", { name: "Next publication" }));
    expect(document.querySelectorAll(".mc-card__title")).toHaveLength(1);
    expect(document.querySelector(".mc-card__title")).toHaveTextContent(
      "Next publication",
    );
  });

  it("keeps only the first caption line in the deletion consequence", async () => {
    const longCaption =
      "First line\nThe whole remaining caption must not enter this confirmation";
    const user = userEvent.setup();
    render(
      <AutomationsScreen
        client={client()}
        finder={finder([{ ...WATCHED, caption: longCaption }])}
      />,
    );
    await screen.findByRole("button", { name: copy.delete });
    await user.click(screen.getByRole("button", { name: copy.delete }));

    expect(
      document.querySelector(".mc-consequence__caption"),
    ).toHaveTextContent("Comments on “First line”");
    expect(
      document.querySelector(".mc-consequence__caption"),
    ).not.toHaveTextContent("remaining caption");
  });
});

/**
 * REQ-279: the name is the caption of the moment, and there is no other one.
 *
 * The defect this closes was invisible while the caption never changed: the
 * editor composed a name out of the publication and WROTE it into the
 * aggregate, so an operator who fixed a typo in the post went on reading the
 * old wording here for as long as the automation lived. What is asserted is the
 * only thing that tells a derivation apart from a copy: the same stored
 * automation, byte for byte, under a caption that has since changed.
 */
describe("REQ-279: the automation stores no name", () => {
  it("follows the caption the cache holds now, on an automation nobody touched", async () => {
    const stored = client();
    const first = render(
      <AutomationsScreen client={stored} finder={finder()} />,
    );

    expect(await screen.findByText(DERIVED_TITLE)).toBeInTheDocument();
    first.unmount();

    // The post was edited on the platform and the cache caught up. The
    // aggregate is the same one: the listing reads it from the same client.
    const edited = "Walking skeleton, corrected";
    render(
      <AutomationsScreen
        client={stored}
        finder={finder([{ ...WATCHED, caption: edited }])}
      />,
    );

    expect(
      await screen.findByText(
        resolve(copy.nameFromCaption, { caption: edited }),
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(DERIVED_TITLE)).toBeNull();
  });
});

/* ------------------------------------------------------------------ *
 * REQ-278: the card is the automation's preview, never its identifier
 * ------------------------------------------------------------------ */

/** A half written automation: it names its publication and nothing else. */
const DRAFT: UnifiedAutomation = {
  schema_version: 2,
  kind: "automation",
  id: "half",
  state: "draft",
  trigger: {
    type: "comment",
    target: TARGET,
    match: { keywords: ["ebook"], mode: "contains" },
  },
  rules: { once_per_contact: true, first_reply_delay_seconds: 0 },
  steps: [],
};

/** The full automation of the prototype: a public reply, a question, a card. */
const COMPLETE: UnifiedAutomation = {
  ...ACTIVE,
  steps: [
    { id: "public", action: "reply_comment", text: "sent!" },
    {
      id: "ask",
      action: "confirm_optin",
      text: "May I send you the walking skeleton guide?",
      quick_reply_label: "Yes",
      on_timeout: "abandon",
    },
    {
      id: "private-message",
      action: "send_dm",
      message: {
        title: "here it is",
        buttons: [
          { id: "download", label: "Get the guide", url: "https://x.test/g" },
        ],
      },
    },
  ],
};

function listing(
  ...definitions: readonly UnifiedAutomation[]
): AutomationsClient {
  return {
    ...client(),
    list: vi.fn(async () =>
      definitions.map((definition) => ({
        definition,
        createdAt: CREATED_AT,
        updatedAt: CREATED_AT,
      })),
    ),
  };
}

/** The preview lines on screen, as `LABEL: sentence`, in document order. */
function previewOnScreen(): readonly string[] {
  return [...document.querySelectorAll(".mc-autosum li")].map((line) =>
    [...line.children].map((part) => part.textContent ?? "").join(": "),
  );
}

describe("REQ-278: the card shows the automation, not its identifier", () => {
  it("names the publication by its caption, and shows the identifier nowhere", async () => {
    const { container } = render(
      <AutomationsScreen client={client()} finder={finder()} />,
    );

    expect(await screen.findByText(DERIVED_TITLE)).toBeInTheDocument();
    // The whole card, not only the title: the seventeen digits were the title
    // AND they must not reappear as a discreet line under it.
    expect(container.textContent).not.toContain(TARGET);
  });

  it("asks for every watched publication in one lookup, by identifier", async () => {
    const lookup = finder();
    render(
      <AutomationsScreen client={listing(ACTIVE, DRAFT)} finder={lookup} />,
    );

    await screen.findAllByText(DERIVED_TITLE);
    // One request for the whole listing, and the two automations watch the same
    // publication: a lookup per card would ask the same question twice.
    expect(lookup.byIds).toHaveBeenCalledTimes(1);
    expect(lookup.byIds).toHaveBeenCalledWith([TARGET]);
  });

  it("falls back to the day when no caption is known, and still shows no identifier", async () => {
    const { container } = render(
      <AutomationsScreen
        client={client()}
        finder={finder([{ ...WATCHED, caption: undefined }])}
      />,
    );

    expect(await screen.findByText(UNNAMED_TITLE)).toBeInTheDocument();
    expect(container.textContent).not.toContain(TARGET);
  });

  it("survives a lookup that fails, with the listing intact", async () => {
    const broken: PublicationFinder = {
      byIds: vi.fn(async () => {
        throw new Error("500");
      }),
    };
    const { container } = render(
      <AutomationsScreen client={client()} finder={broken} />,
    );

    // The caption is what is lost, and nothing else: no notice, no empty list,
    // and above all no identifier put back in its place.
    expect(await screen.findByText(UNNAMED_TITLE)).toBeInTheDocument();
    expect(container.textContent).not.toContain(TARGET);
  });

  it("shows the publication it watches, named for whoever cannot see it", async () => {
    render(<AutomationsScreen client={client()} finder={finder()} />);

    const picture = await screen.findByAltText(copy.cardThumbnailAlt);

    expect(picture).toHaveAttribute("src", THUMBNAIL);
  });

  it("tells the automation in the order the person on the other side lives it", async () => {
    render(<AutomationsScreen client={listing(COMPLETE)} finder={finder()} />);

    await screen.findByText(DERIVED_TITLE);

    expect(previewOnScreen()).toEqual([
      `${copy.previewTriggers}: ${resolve(copy.previewTriggerComment, {
        words: "ebook",
      })}`,
      `${copy.previewReplies}: ${resolve(copy.previewRepliesBoth, {
        wait: resolve(copy.previewWaitSeconds_other, { count: 5 }),
      })}`,
      `${copy.previewAsks}: ${resolve(copy.previewAsk, {
        question: "May I send you the walking skeleton guide?",
      })}`,
      `${copy.previewDelivers}: ${resolve(copy.previewDeliveryCard_one, {
        buttons: "Get the guide",
      })}`,
    ]);
  });

  it("closes a draft with what it is still waiting for", async () => {
    render(<AutomationsScreen client={listing(DRAFT)} finder={finder()} />);

    await screen.findByText(DERIVED_TITLE);

    // Three lines and the last one is the hole: the prototype's draft card.
    expect(previewOnScreen()).toEqual([
      `${copy.previewTriggers}: ${resolve(copy.previewTriggerComment, {
        words: "ebook",
      })}`,
      `${copy.previewReplies}: ${resolve(copy.previewRepliesDirect, {
        wait: copy.previewWaitImmediate,
      })}`,
      `${copy.previewMissing}: ${copy.previewMissingMessage}`,
    ]);
    // And the word on the action says which of the two it offers.
    expect(
      screen.getByRole("button", { name: copy.continueDraft }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: copy.edit })).toBeNull();
  });

  it("sets the operator's own words apart inside the sentence", async () => {
    const { container } = render(
      <AutomationsScreen client={listing(COMPLETE)} finder={finder()} />,
    );

    await screen.findByText(DERIVED_TITLE);

    expect(
      [...container.querySelectorAll(".mc-autosum b")].map(
        (part) => part.textContent,
      ),
    ).toEqual(["ebook", "Get the guide"]);
  });
});

describe("REQ-278: what each preview line says", () => {
  const t = ((key: string, params?: Record<string, unknown>): string =>
    resolve(
      // The catalogue as the screen reads it, plural forms and all: a fake
      // translator answering the key back would make every assertion below a
      // comparison of two identical strings.
      lookUp(key, params),
      (params ?? {}) as Record<string, string | number>,
    )) as (key: string, params?: Record<string, unknown>) => string;

  function lookUp(key: string, params?: Record<string, unknown>): string {
    const leaf = key.replace("screens.automations.", "");
    const count = params?.["count"];
    const plural =
      count === undefined ? undefined : count === 1 ? "_one" : "_other";
    const table = copy as unknown as Record<string, string>;

    return table[`${leaf}${plural ?? ""}`] ?? table[leaf] ?? key;
  }

  function preview(definition: UnifiedAutomation): readonly string[] {
    return automationPreview(
      definition,
      identityOf(definition, CREATED_AT),
      t,
    ).map((line) => `${lookUp(line.label)}: ${line.sentence}`);
  }

  it("reads a trigger that takes every comment, with no word to match", () => {
    const lines = preview({
      ...ACTIVE,
      trigger: { type: "comment", target: TARGET, match: { mode: "any" } },
    });

    expect(lines[0]).toBe(
      `${copy.previewTriggers}: ${copy.previewTriggerAnyWord}`,
    );
  });

  it("names the words a direct message listens for", () => {
    const lines = preview({
      ...ACTIVE,
      trigger: {
        type: "direct_message",
        match: { keywords: ["price", "cost"], mode: "contains" },
      },
      steps: [
        { id: "private-message", action: "send_dm", message: { text: "hi" } },
      ],
    });

    expect(lines[0]).toBe(
      `${copy.previewTriggers}: ${resolve(copy.previewTriggerDirect, {
        words: `price ${copy.matchOr} cost`,
      })}`,
    );
    // No comment to answer under, so the reply is the inbox alone even if a
    // public reply step were somehow present.
    expect(lines[1]).toBe(
      `${copy.previewReplies}: ${resolve(copy.previewRepliesDirect, {
        wait: resolve(copy.previewWaitSeconds_other, { count: 5 }),
      })}`,
    );
  });

  it("does not announce legacy confirmation a direct-message automation cannot offer", () => {
    const lines = preview({
      ...ACTIVE,
      trigger: {
        type: "direct_message",
        match: { keywords: ["guide"], mode: "contains" },
      },
      steps: [
        {
          id: "confirmation",
          action: "confirm_optin",
          text: "Confirm",
          on_timeout: "abandon",
        },
        { id: "private-message", action: "send_dm", message: { text: "hi" } },
      ],
    });

    expect(lines).not.toContain(`${copy.previewAsks}: “Confirm”`);
  });

  it("says the wait in minutes when it is a whole minute", () => {
    const lines = preview({
      ...ACTIVE,
      rules: { once_per_contact: true, first_reply_delay_seconds: 60 },
    });

    expect(lines[1]).toBe(
      `${copy.previewReplies}: ${resolve(copy.previewRepliesDirect, {
        wait: resolve(copy.previewWaitMinutes_one, { count: 1 }),
      })}`,
    );
  });

  it("asks with the catalogue's own question when nobody wrote one", () => {
    const lines = preview({
      ...ACTIVE,
      steps: [
        {
          id: "ask",
          action: "confirm_optin",
          text: "",
          on_timeout: "abandon",
        },
        { id: "private-message", action: "send_dm", message: { text: "hi" } },
      ],
    } as UnifiedAutomation);

    expect(lines[2]).toBe(
      `${copy.previewAsks}: ${resolve(copy.previewAsk, {
        question: copy.confirmationQuestionDefault,
      })}`,
    );
  });

  it("delivers a plain message when the message carries no link", () => {
    const lines = preview({
      ...ACTIVE,
      steps: [
        { id: "private-message", action: "send_dm", message: { text: "hi" } },
      ],
    });

    expect(lines.at(-1)).toBe(
      `${copy.previewDelivers}: ${copy.previewDeliveryMessage}`,
    );
  });

  it("names both buttons of a card", () => {
    const lines = preview({
      ...ACTIVE,
      steps: [
        {
          id: "private-message",
          action: "send_dm",
          message: {
            buttons: [
              { id: "a", label: "One", url: "https://x.test/a" },
              { id: "b", label: "Two", url: "https://x.test/b" },
            ],
          },
        },
      ],
    });

    expect(lines.at(-1)).toBe(
      `${copy.previewDelivers}: ${resolve(copy.previewDeliveryCard_other, {
        buttons: `One ${copy.previewAnd} Two`,
      })}`,
    );
  });

  it("asks a draft for its publication before it asks for anything else", () => {
    const lines = preview({
      ...DRAFT,
      trigger: { type: "comment", match: { keywords: ["ebook"] } },
    });

    // No trigger line at all: an automation with no publication chosen has
    // nothing to say about what starts it, and the hole is what it says.
    expect(lines.at(-1)).toBe(
      `${copy.previewMissing}: ${copy.previewMissingTarget}`,
    );
    expect(lines.some((line) => line.startsWith(copy.previewTriggers))).toBe(
      false,
    );
  });

  it("asks a draft for its words when the publication is chosen", () => {
    const lines = preview({
      ...DRAFT,
      trigger: { type: "comment", target: TARGET },
    });

    expect(lines.at(-1)).toBe(
      `${copy.previewMissing}: ${copy.previewMissingWords}`,
    );
  });

  it("says nothing is missing from a draft that is only waiting to be turned on", () => {
    const lines = preview({ ...COMPLETE, state: "draft" } as UnifiedAutomation);

    expect(lines.at(-1)).toBe(
      `${copy.previewMissing}: ${copy.previewMissingNothing}`,
    );
  });

  it("puts no missing line on an automation that is already running", () => {
    expect(
      preview(COMPLETE).some((line) => line.startsWith(copy.previewMissing)),
    ).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * REQ-286: a pure link is a message of its own, and the listing says so
 * ------------------------------------------------------------------ */

/**
 * The catalogue's own translator, for the sentences `resolve` cannot build.
 *
 * The delivery names a LIST of messages, and which separator goes before its
 * last item is the language's business rather than this screen's
 * (`{{names, list}}`). Spelling "a and b" here would be writing English into
 * the test and then asserting the screen agrees with it.
 */
const catalogue = createTranslator({ en }, "en");

/** The delivery sentence, asked of the catalogue exactly as the screen asks. */
function delivery(key: string, params: Record<string, unknown>): string {
  return `${copy.previewDelivers}: ${catalogue.t(
    `screens.automations.${key}`,
    params,
  )}`;
}

/** A RUNNING automation whose private message is the given links and nothing else. */
function running(...links: readonly string[]): UnifiedAutomation {
  return {
    ...ACTIVE,
    steps: [
      {
        id: "private-message",
        action: "send_dm",
        message: { links: [...links] },
      },
    ],
  };
}

/** The same message on a DRAFT that has already chosen its publication and words. */
function halfWritten(...links: readonly string[]): UnifiedAutomation {
  return {
    ...DRAFT,
    steps: [
      {
        id: "private-message",
        action: "send_dm",
        message: { links: [...links] },
      },
    ],
  };
}

describe("REQ-286: the listing describes the delivery that carries a pure link", () => {
  /** The preview as the screen composes it, from the catalogue it renders. */
  function preview(definition: UnifiedAutomation): readonly string[] {
    return automationPreview(
      definition,
      identityOf(definition, CREATED_AT),
      catalogue.t,
    ).map((line) => `${catalogue.t(line.label)}: ${line.sentence}`);
  }

  it("describes an automation that is running on links alone", async () => {
    // The defect this closes: with nothing written beside the link, the card
    // of an ACTIVE automation carried no delivery line at all, so the one
    // thing it does went missing from its own description in silence.
    render(
      <AutomationsScreen
        client={listing(running("https://x.test/a"))}
        finder={finder()}
      />,
    );

    await screen.findByText(DERIVED_TITLE);

    expect(previewOnScreen()).toContain(
      delivery("previewDeliveryLinksAlone", {
        count: 1,
        names: [copy.deliveryPartLink],
      }),
    );
  });

  it("puts the link after the written message, as a message of its own", () => {
    const lines = preview({
      ...ACTIVE,
      steps: [
        {
          id: "private-message",
          action: "send_dm",
          message: { text: "hi", links: ["https://x.test/a"] },
        },
      ],
    });

    expect(lines.at(-1)).toBe(
      delivery("previewDeliveryThenLinks", {
        count: 1,
        names: [copy.deliveryPartLink],
        delivered: copy.previewDeliveryMessage,
      }),
    );
  });

  it("names several links by their position, in the order they were declared", () => {
    const lines = preview({
      ...ACTIVE,
      steps: [
        {
          id: "private-message",
          action: "send_dm",
          message: {
            buttons: [{ id: "a", label: "One", url: "https://x.test/a" }],
            links: ["https://x.test/first", "https://x.test/second"],
          },
        },
      ],
    });

    // The card first and then the two links, numbered: the operator reads the
    // order the three messages really arrive in.
    expect(lines.at(-1)).toBe(
      delivery("previewDeliveryThenLinks", {
        count: 2,
        names: [
          resolve(copy.deliveryPartLinkNumbered, { number: 1 }),
          resolve(copy.deliveryPartLinkNumbered, { number: 2 }),
        ],
        delivered: resolve(copy.previewDeliveryCard_one, { buttons: "One" }),
      }),
    );
  });

  it("counts the links a delivery of links alone carries", () => {
    const lines = preview(running("https://x.test/a", "https://x.test/b"));

    expect(lines.at(-1)).toBe(
      delivery("previewDeliveryLinksAlone", {
        count: 2,
        names: [
          resolve(copy.deliveryPartLinkNumbered, { number: 1 }),
          resolve(copy.deliveryPartLinkNumbered, { number: 2 }),
        ],
      }),
    );
  });

  it("asks a draft of links alone for nothing it has already written", () => {
    // The other half of the defect, and the one that LIED: a message carrying
    // only a link is content, the editor activates it, and the card told the
    // operator to go and write the private message that is already there.
    const lines = preview(halfWritten("https://x.test/a"));

    expect(lines).not.toContain(
      `${copy.previewMissing}: ${copy.previewMissingMessage}`,
    );
    expect(lines.at(-1)).toBe(
      `${copy.previewMissing}: ${copy.previewMissingNothing}`,
    );
  });

  it("still asks for the message when the only link is a half-typed address", () => {
    // The boundary that keeps the sentence above honest: an added row nobody
    // has typed into is an empty string, and counting it as a delivery would
    // promise a message the contact would never receive.
    const lines = preview(halfWritten("   "));

    expect(lines.some((line) => line.startsWith(copy.previewDelivers))).toBe(
      false,
    );
    expect(lines.at(-1)).toBe(
      `${copy.previewMissing}: ${copy.previewMissingMessage}`,
    );
  });
});

describe("REQ-278: the emphasis is cut out of the resolved sentence", () => {
  it("sets the words apart where the sentence really carries them", () => {
    const { container } = render(
      <span>{emphasised("comments carrying ebook", "ebook")}</span>,
    );

    expect(container.querySelector("b")?.textContent).toBe("ebook");
    expect(container.textContent).toBe("comments carrying ebook");
  });

  it("gives the sentence back whole when it carries them nowhere", () => {
    // The guard, and it is not theoretical: a translation is free to fold the
    // words into something else, and a cut that assumed they were there would
    // put the emphasis around the wrong half of somebody's language.
    for (const part of [undefined, "", "guide"]) {
      const { container, unmount } = render(
        <span>{emphasised("comments carrying ebook", part)}</span>,
      );

      expect(container.querySelector("b"), String(part)).toBeNull();
      expect(container.textContent).toBe("comments carrying ebook");
      unmount();
    }
  });
});

/* ------------------------------------------------------------------ *
 * REQ-276: a link goes somewhere, a button does something
 * ------------------------------------------------------------------ */

describe("REQ-276: every action of the listing is a button", () => {
  it("draws the two card actions as buttons, and neither as a link", async () => {
    const { container } = render(
      <AutomationsScreen client={client()} finder={finder()} />,
    );

    await screen.findByText(DERIVED_TITLE);

    for (const name of [copy.edit, copy.delete]) {
      const control = screen.getByRole("button", { name });

      expect(control.tagName).toBe("BUTTON");
      expect(control.className).toContain("mc-btn");
      // The weight that used to draw a removal as underlined text is gone: a
      // frame is what says how big the target is.
      expect(control.className).not.toContain("mc-btn--link");
    }

    // And no anchor at all on a screen whose only destinations are actions.
    expect(container.querySelectorAll("a")).toHaveLength(0);
  });

  it("keeps the way out of the entry a real link, wearing the button's shape", () => {
    render(<AutomationStartScreen />);

    const back = screen.getByRole("link", { name: copy.back });

    // It GOES somewhere, so Tab reaches it, the middle button opens it in
    // another tab and the address can be copied. And it carries the frame, so
    // it is the same target size as everything else in the product.
    expect(back).toHaveAttribute("href", "/automations");
    expect(back.className).toContain("mc-btn");
  });

  it("gives every anchor of both screens a destination to go to", () => {
    const listed = render(
      <AutomationsScreen client={client()} finder={finder()} />,
    );
    const entry = render(<AutomationStartScreen />);

    const anchors = [
      ...listed.container.querySelectorAll("a"),
      ...entry.container.querySelectorAll("a"),
    ];

    expect(anchors.length).toBeGreaterThan(0);
    // An anchor with no address, or one pointing at the page it is already on,
    // is an action wearing a link's clothes: it is what escapes the tap floor,
    // and it answers Enter and not Space.
    expect(
      anchors
        .map((anchor) => anchor.getAttribute("href"))
        .filter((href) => href === null || href === "" || href === "#"),
    ).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * REQ-294: an automation that cannot be read appears, instead of vanishing
 * ------------------------------------------------------------------ */

/**
 * The defect these cases exist against is history, not theory.
 *
 * Phase 3l took `name` out of the format with no compatibility layer, by an
 * explicit decision that stands. What was NOT decided is what happened next:
 * the rows written under the old shape stopped parsing, the coverage reader
 * dropped them, and the operator opened this screen to a shorter list with
 * nothing said. He was the one who asked whether he was looking at an old
 * version. The attachment left the format the same way (REQ-284), so the same
 * rows are about to stop parsing again, and this time the screen says so.
 */
function unreadableClient(
  ...found: readonly { id: string; publicationId?: string }[]
): UnreadableAutomationsClient {
  return { read: vi.fn(async () => found) };
}

const UNREADABLE_ONE = resolve(copy.unreadableAutomationsTitle_one, {
  count: 1,
});
const UNREADABLE_TWO = resolve(copy.unreadableAutomationsTitle_other, {
  count: 2,
});

describe("REQ-294: what cannot be read is said, not dropped", () => {
  it("says how many are stored and unreadable, and that nothing was deleted", async () => {
    render(
      <AutomationsScreen
        client={client()}
        finder={finder()}
        unreadable={unreadableClient({
          id: "legacy-attachment",
          publicationId: "17900000000000009",
        })}
      />,
    );

    expect(await screen.findByText(UNREADABLE_ONE)).toBeInTheDocument();
    expect(screen.getByText(copy.unreadableAutomations)).toBeInTheDocument();
  });

  it("counts them, so two do not read as one", async () => {
    render(
      <AutomationsScreen
        client={client()}
        finder={finder()}
        unreadable={unreadableClient(
          { id: "legacy-attachment" },
          { id: "legacy-name" },
        )}
      />,
    );

    expect(await screen.findByText(UNREADABLE_TWO)).toBeInTheDocument();
    expect(screen.queryByText(UNREADABLE_ONE)).not.toBeInTheDocument();
  });

  it("leaves the automations it CAN read listed and usable beside it", async () => {
    render(
      <AutomationsScreen
        client={client()}
        finder={finder()}
        unreadable={unreadableClient({ id: "legacy-attachment" })}
      />,
    );

    // The whole point of the requirement: the bad document costs its own row
    // and no other. The good automation keeps its name, its state and both of
    // its controls, exactly as it has them with no bad row in the instance.
    expect(await screen.findByText(DERIVED_TITLE)).toBeInTheDocument();
    expect(screen.getByText("Active")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: copy.edit })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: copy.delete }),
    ).toBeInTheDocument();
  });

  it("says it as a warning, announced without being asked", async () => {
    render(
      <AutomationsScreen
        client={client()}
        finder={finder()}
        unreadable={unreadableClient({ id: "legacy-attachment" })}
      />,
    );

    const said = await screen.findByRole("alert");

    // Nothing failed and nothing is broken: a format this version refuses is a
    // degraded path, which is what the warning nature is for. An error here
    // would say the screen is not working, and it is.
    expect(said.className).toContain("mc-notice--warning");
    expect(said.textContent).toContain(UNREADABLE_ONE);
  });

  it("says it even when the listing itself could not be read", async () => {
    const broken = client();
    broken.list = vi.fn(async () => {
      throw new Error("500");
    });

    render(
      <AutomationsScreen
        client={broken}
        finder={finder()}
        unreadable={unreadableClient({ id: "legacy-attachment" })}
      />,
    );

    // Not the state an unreadable row produces any more (the route serves the
    // readable ones now), and the case is kept for the listing that fails for
    // any OTHER reason: the two sentences still have to hold together, one
    // saying the list could not be read and the other saying what is stored
    // and refused.
    expect(await screen.findByText(copy.listUnavailable)).toBeInTheDocument();
    expect(screen.getByText(UNREADABLE_ONE)).toBeInTheDocument();
  });

  it("says it above an empty list, where the operator would read 'nothing here'", async () => {
    render(
      <AutomationsScreen
        client={listing()}
        finder={finder()}
        unreadable={unreadableClient({ id: "legacy-attachment" })}
      />,
    );

    expect(await screen.findByText(UNREADABLE_ONE)).toBeInTheDocument();
    expect(screen.getByText(copy.empty)).toBeInTheDocument();
  });

  it("says nothing at all when every stored automation parses", async () => {
    render(
      <AutomationsScreen
        client={client()}
        finder={finder()}
        unreadable={unreadableClient()}
      />,
    );

    await screen.findByText(DERIVED_TITLE);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(
      screen.queryByText(copy.unreadableAutomations),
    ).not.toBeInTheDocument();
  });

  it("keeps the listing intact when the question itself fails", async () => {
    const refused: UnreadableAutomationsClient = {
      read: vi.fn(async () => {
        throw new Error("500");
      }),
    };

    render(
      <AutomationsScreen
        client={client()}
        finder={finder()}
        unreadable={refused}
      />,
    );

    // A red box over a working listing would be the wrong sentence about the
    // wrong thing: what is lost is a warning about rows nobody can see anyway.
    expect(await screen.findByText(DERIVED_TITLE)).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("asks the coverage route with no publication named", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ coverage: [], unreadable: [] }), {
        status: 200,
      }),
    );

    await expect(httpUnreadableAutomationsClient.read()).resolves.toEqual([]);
    // No identifier, on purpose: this screen holds no publication, and the
    // client the grid uses answers `[]` without asking at all when given none.
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/publications/automation-coverage",
    );
    fetchMock.mockRestore();
  });

  it("draws the listing AND the warning from the two real routes", async () => {
    // Every case above injects both clients, which proves what the screen does
    // with two answers and nothing about the answers themselves. This one runs
    // the real clients over the wire the interface actually uses, and it is the
    // half that was false until now: the listing route answered 500 whenever a
    // stored document stopped matching the schema, so the operator got the
    // warning over "the automations could not be read" instead of over his
    // automations. The warning promises the readable ones keep working; here
    // they are, beside it.
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation((input) => {
        const url = String(input);
        const body =
          url === "/api/automations"
            ? {
                automations: [
                  {
                    definition: ACTIVE,
                    createdAt: CREATED_AT,
                    updatedAt: CREATED_AT,
                  },
                ],
              }
            : url === "/api/publications/automation-coverage"
              ? {
                  coverage: [],
                  unreadable: [
                    { id: "legacy-attachment", publicationId: TARGET },
                  ],
                }
              : { automationId: "launch", total: 0, buttons: [] };
        return Promise.resolve(
          new Response(JSON.stringify(body), { status: 200 }),
        );
      });

    render(<AutomationsScreen finder={finder()} />);

    expect(await screen.findByText(DERIVED_TITLE)).toBeInTheDocument();
    expect(screen.getByText(UNREADABLE_ONE)).toBeInTheDocument();
    fetchMock.mockRestore();
  });
});

/* ------------------------------------------------------------------ *
 * REQ-328, REQ-330: the card's shape, which lives in the sheet
 * ------------------------------------------------------------------ */

/**
 * The rules below are held as TEXT and not looked at in jsdom, which applies no
 * stylesheet: nothing rendered in this file has a width, a ratio or a line
 * count. What a browser saw is in the task's report, measured at 320, 390, 768
 * and 1440 in both themes. `COMPONENT_SHEET` and `blockAfter` are the readers
 * declared above, for the entrance's own drawing.
 */

/** A declared length in rem, as a number, so two of them can be compared. */
function remOf(block: string, property: string): number {
  return Number(
    new RegExp(`${property}\\s*:\\s*([\\d.]+)rem`).exec(block)?.[1] ??
      Number.NaN,
  );
}

const HANDSET = "@media (max-width: 35rem)";

describe("REQ-328: the card is smaller, and its preview is 9x16", () => {
  it("frames the publication at 9x16, on a width the card chooses", () => {
    // A sweep that read an empty module would pass everything below forever:
    // vitest replaces a stylesheet with nothing unless `css` is on.
    expect(COMPONENT_SHEET.length).toBeGreaterThan(0);

    const frame = blockAfter(
      COMPONENT_SHEET,
      ".mc-cardlist--automations .mc-card__media {",
    );

    // The ratio is the requirement. The width beside it is what makes the ratio
    // safe to ask for: the height follows from the two, so a picture never
    // decides how tall a card is.
    expect(frame).toContain("aspect-ratio: 9 / 16;");
    expect(remOf(frame, "inline-size")).toBeGreaterThan(0);
    expect(frame).toContain("block-size: auto;");
  });

  it("keeps every summary line to one row, and cuts it instead of wrapping", () => {
    const line = blockAfter(COMPONENT_SHEET, ".mc-autosum li {");
    const sentence = blockAfter(
      COMPONENT_SHEET,
      ".mc-autosum li > span:last-child {",
    );

    // The label keeps its column beside the sentence, at every width: wrapped,
    // a four line summary became eight lines on a handset.
    expect(line).toContain("flex-wrap: nowrap;");
    expect(sentence).toContain("-webkit-line-clamp: 2;");
    expect(sentence).toContain("min-inline-size: 0;");
  });

  it("buys the sentence its width back on a handset, instead of stacking", () => {
    expect(COMPONENT_SHEET).toContain(HANDSET);

    const handset = blockAfter(
      blockAfter(COMPONENT_SHEET, HANDSET),
      ".mc-autosum__key {",
    );
    const desktop = blockAfter(COMPONENT_SHEET, ".mc-autosum__key {");

    // Compared as numbers, so a handset rule edited down to the desktop value
    // is a failure and not a detail: what the label column gives up is what the
    // sentence beside it gains, and that is what pays for the line it no longer
    // wraps to.
    expect(remOf(handset, "min-inline-size")).toBeLessThan(
      remOf(desktop, "min-inline-size"),
    );
  });

  it("puts the two actions beside the card and not under its summary", async () => {
    const { container } = render(
      <AutomationsScreen client={client()} finder={finder()} />,
    );

    await screen.findByText(DERIVED_TITLE);

    const actions = container.querySelector(".mc-card__actions");

    // In the card's own action slot, which is the row that costs no height
    // while there is width beside the body. A column of two buttons under the
    // summary cost every card a line of its own.
    expect(actions).not.toBeNull();
    expect(
      within(actions as HTMLElement).getByRole("button", { name: copy.edit }),
    ).toBeInTheDocument();
    expect(
      within(actions as HTMLElement).getByRole("button", { name: copy.delete }),
    ).toBeInTheDocument();
  });
});

describe("REQ-330: a long caption cannot make the card grow", () => {
  it("clamps the title at two lines AND reserves them", async () => {
    const title = blockAfter(
      COMPONENT_SHEET,
      ".mc-cardlist--automations .mc-card__title {",
    );

    // The clamp is the ceiling: two lines, whatever the caption says.
    expect(title).toContain("-webkit-line-clamp: 2;");
    expect(title).toContain("overflow: hidden;");
    // And the reservation is the floor, which is the half that makes the height
    // equal rather than merely bounded: with the ceiling alone, a card with a
    // short caption was one line shorter than the card under it, so the list's
    // rhythm was decided by how much each author had felt like typing.
    expect(title).toContain("min-block-size: calc(2em * var(--leading-snug));");

    // The head holds them side by side: with free wrapping the badge fell under
    // a long caption and cost the card the very line the clamp had just saved.
    expect(
      blockAfter(COMPONENT_SHEET, ".mc-cardlist--automations .mc-card__head {"),
    ).toContain("flex-wrap: nowrap;");
  });

  it("keeps the whole caption in the document, for whoever reads with ears", async () => {
    const long = `${CAPTION} ${"and more of it".repeat(20)}`;
    render(
      <AutomationsScreen
        client={client()}
        finder={finder([{ ...WATCHED, caption: long }])}
      />,
    );

    // Cut where it is DRAWN and nowhere else: the clamp is presentation, so the
    // sentence a screen reader announces is the caption the operator wrote.
    expect(
      await screen.findByText(resolve(copy.nameFromCaption, { caption: long })),
    ).toBeInTheDocument();
  });
});
