import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import en from "../../i18n/locales/en.json";
import {
  httpPublicationAutomationCoverageClient,
  httpPublicationFinder,
  PublicationsScreen,
} from "./publications.js";
import type {
  PublicationAutomationCoverageClient,
  PublicationListing,
  PublicationPage,
  PublicationsClient,
} from "./publications.js";

/**
 * The target grid (REQ-069 to REQ-072), and the five states REQ-115 asks it to
 * tell apart: reading, empty, unavailable, degraded, and a thumbnail that did
 * not load.
 *
 * The text is read out of the catalogue the screen itself renders from, never
 * retyped here: rewording a sentence must not fail a test about behaviour, and
 * a test that quoted its own copy of the wording would go green against a
 * screen showing something else entirely (REQ-074).
 *
 * No provider is mounted around the screens. `useLocale` answers with the
 * default context when there is none, over the bundled catalogues, which is the
 * documented behaviour of `locale.tsx` and is what keeps these tests about the
 * screen instead of about the language preference.
 */

const IMAGE_ID = "17900000000000001";
const VIDEO_ID = "17900000000000002";
const CACHED_AT = "2026-08-02T11:55:00.000Z";

/**
 * What the operator actually published: a sentence, a line break and a hashtag.
 * The publication beside it carries NO caption, which is ordinary and has to
 * stay usable — between them they are the two rows this screen has to draw.
 */
const CAPTION = "Walking skeleton.\nComenta esqueleto e eu te mando o link.";

/**
 * Text compared exactly as the DOM holds it, line breaks included.
 *
 * The default matcher collapses whitespace before comparing, and a caption is
 * written WITH its line breaks: it would never be found, and worse, a screen
 * that had silently flattened it would still pass. Comparing the raw text is
 * the assertion that says the words arrived as they were published.
 */
const VERBATIM = { normalizer: (value: string): string => value };

const copy = en.screens.publications;
const navCopy = en.nav;

/** Resolves a catalogue entry the way the translator does, for a query. */
function text(
  template: string,
  params: Record<string, string | number>,
): string {
  return Object.entries(params).reduce(
    (resolved, [name, value]) =>
      resolved.split(`{{${name}}}`).join(String(value)),
    template,
  );
}

const LISTING: PublicationListing = {
  items: [
    {
      id: IMAGE_ID,
      caption: CAPTION,
      mediaType: "IMAGE",
      publishedAt: "2026-07-28T18:20:00.000Z",
      thumbnailUrl: "/assets/thumbs/one.jpg",
    },
    {
      id: VIDEO_ID,
      mediaType: "VIDEO",
      publishedAt: "2026-07-20T09:00:00.000Z",
    },
  ],
  total: 2,
  offset: 0,
  limit: 24,
  source: "cache",
  cachedAt: CACHED_AT,
};

interface PublicationsDouble extends PublicationsClient {
  readonly opened: PublicationPage[];
  readonly refreshed: PublicationPage[];
  openAnswer: PublicationListing;
  refreshAnswer: PublicationListing;
  openFails: boolean;
}

function createPublicationsDouble(): PublicationsDouble {
  const double: PublicationsDouble = {
    opened: [],
    refreshed: [],
    openAnswer: LISTING,
    refreshAnswer: { ...LISTING, source: "platform" },
    openFails: false,

    open: async (page = {}) => {
      double.opened.push(page);

      if (double.openFails) {
        throw new Error(String(500));
      }

      return double.openAnswer;
    },

    refresh: async (page = {}) => {
      double.refreshed.push(page);
      return double.refreshAnswer;
    },
  };

  return double;
}

function selectButton(id: string): string {
  return text(copy.selectLabel, { id });
}

/** The one in the block's own head, which is the one every state carries. */
function anyRefreshButton(): HTMLElement {
  const [first] = screen.getAllByRole("button", { name: copy.refresh });

  if (first === undefined) {
    throw new Error("no update control on screen");
  }

  return first;
}

describe("REQ-211: an expired session does not offer another doomed read", () => {
  it("offers sign-in and removes every refresh action after a 401", async () => {
    const client = createPublicationsDouble();
    client.open = (): Promise<PublicationListing> =>
      Promise.reject(new Error("401"));

    render(<PublicationsScreen client={client} />);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(navCopy.sessionExpired);
    expect(alert).not.toHaveTextContent(copy.unavailable);
    expect(screen.getByRole("link", { name: navCopy.signIn })).toHaveAttribute(
      "href",
      "/login",
    );
    expect(screen.queryByRole("button", { name: copy.refresh })).toBeNull();
  });
});

describe("REQ-069: the publication grid (criterion 28)", () => {
  it("consults the instance once and lists thumbnail, type, date and id", async () => {
    const client = createPublicationsDouble();

    render(<PublicationsScreen client={client} />);

    await screen.findByRole("button", { name: selectButton(IMAGE_ID) });

    // One read on opening, and no second one: the screen asks the instance,
    // and whether the platform was consulted is the catalogue's decision.
    expect(client.opened).toEqual([{ offset: 0 }]);
    expect(client.refreshed).toEqual([]);

    // The picture, with the alternative text every image on this screen
    // carries, and OUR address rather than the platform's (REQ-071).
    const thumbnail = screen.getByRole("img", {
      name: text(copy.thumbnailAlt, { id: IMAGE_ID }),
    });
    expect(thumbnail).toHaveAttribute("src", "/assets/thumbs/one.jpg");

    // Type, date and identifier, for both rows.
    expect(screen.getByText("IMAGE")).toBeInTheDocument();
    expect(screen.getByText("VIDEO")).toBeInTheDocument();
    expect(screen.getByText(IMAGE_ID)).toBeInTheDocument();
    expect(screen.getByText(VIDEO_ID)).toBeInTheDocument();
    expect(
      screen.getByText(
        new Date("2026-07-28T18:20:00.000Z").toLocaleDateString("en"),
      ),
    ).toBeInTheDocument();

    expect(screen.getByText(copy.sourceCache)).toBeInTheDocument();
  });

  it("lists a publication whose thumbnail could not be copied", async () => {
    const client = createPublicationsDouble();

    render(<PublicationsScreen client={client} />);

    // No picture, and still selectable: a copy that could not be made costs a
    // thumbnail, never the target it was standing for (REQ-069).
    const row = await screen.findByRole("button", {
      name: selectButton(VIDEO_ID),
    });

    expect(row).toBeInTheDocument();
    expect(screen.getAllByRole("img")).toHaveLength(1);
    // The gap is a designed state, with a word in it rather than an empty box.
    expect(screen.getByText(copy.thumbnailBroken)).toBeInTheDocument();
  });

  it("puts the chosen publication's identifier in the target field", async () => {
    const user = userEvent.setup();
    const client = createPublicationsDouble();

    render(<PublicationsScreen client={client} />);

    const tile = await screen.findByRole("button", {
      name: selectButton(VIDEO_ID),
    });

    expect(tile).toHaveAttribute("aria-pressed", "false");
    await user.click(tile);

    // The whole reason the grid exists: the operator never typed this.
    expect(screen.getByLabelText(copy.target)).toHaveValue(VIDEO_ID);
    // And the grid says which tile it was, programmatically and not by colour.
    expect(tile).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText(copy.chosen)).toBeInTheDocument();
  });

  it("stops claiming a target was chosen once it is typed over", async () => {
    const user = userEvent.setup();
    const client = createPublicationsDouble();

    render(<PublicationsScreen client={client} />);

    await user.click(
      await screen.findByRole("button", { name: selectButton(VIDEO_ID) }),
    );
    await user.type(screen.getByLabelText(copy.target), "x");

    // The field and the grid would otherwise disagree, with a tile marked as
    // pressed under a value it no longer holds.
    expect(screen.queryByText(copy.chosen)).toBeNull();
    expect(
      screen.getByRole("button", { name: selectButton(VIDEO_ID) }),
    ).toHaveAttribute("aria-pressed", "false");
  });

  it("pages through the listing without consulting the platform", async () => {
    const user = userEvent.setup();
    const client = createPublicationsDouble();
    client.openAnswer = { ...LISTING, total: 30, limit: 24, offset: 0 };

    render(<PublicationsScreen client={client} />);

    await screen.findByRole("button", { name: selectButton(IMAGE_ID) });

    expect(screen.getByRole("button", { name: copy.previous })).toBeDisabled();

    client.openAnswer = { ...LISTING, total: 30, limit: 24, offset: 24 };
    await user.click(screen.getByRole("button", { name: copy.next }));

    await waitFor(() => {
      expect(client.opened).toEqual([{ offset: 0 }, { offset: 24 }]);
    });
    // Still a read of the instance's own store: paging is not a refresh.
    expect(client.refreshed).toEqual([]);
  });
});

describe("REQ-070: an explicit update renews what is stored (criterion 30)", () => {
  it("walks the platform only when the operator asks", async () => {
    const user = userEvent.setup();
    const client = createPublicationsDouble();
    client.refreshAnswer = {
      ...LISTING,
      items: [
        {
          id: "17900000000000003",
          mediaType: "IMAGE",
          publishedAt: "2026-08-01T10:00:00.000Z",
        },
      ],
      total: 1,
      source: "platform",
    };

    render(<PublicationsScreen client={client} />);

    await screen.findByRole("button", { name: selectButton(IMAGE_ID) });
    await user.click(anyRefreshButton());

    await screen.findByText(copy.sourcePlatform);

    expect(client.refreshed).toEqual([{ offset: 0 }]);
    // The publication that was cached is gone from the grid, which is what
    // "renews" means: the listing is the platform's answer, not a merge.
    expect(
      screen.queryByRole("button", { name: selectButton(IMAGE_ID) }),
    ).toBeNull();
    expect(
      screen.getByRole("button", { name: selectButton("17900000000000003") }),
    ).toBeInTheDocument();
  });
});

describe("REQ-072: the listing degrades, the target entry does not", () => {
  it("quotes the platform's answer beside the rows that were stored", async () => {
    const client = createPublicationsDouble();
    client.openAnswer = { ...LISTING, failure: "the platform answered 500" };

    render(<PublicationsScreen client={client} />);

    const alert = await screen.findByRole("alert");

    expect(alert).toHaveTextContent("the platform answered 500");
    expect(alert).toHaveTextContent(copy.degradedTitle);
    // What was stored is still on screen and still selectable.
    expect(
      screen.getByRole("button", { name: selectButton(IMAGE_ID) }),
    ).toBeInTheDocument();
  });

  it("keeps the identifier field working when the listing cannot be read", async () => {
    const user = userEvent.setup();
    const client = createPublicationsDouble();
    client.openFails = true;

    render(<PublicationsScreen client={client} />);

    // The grid says it is unavailable, and says what to do instead.
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(copy.unavailable);
    expect(alert).toHaveTextContent(copy.unavailableTitle);

    const field = screen.getByLabelText(copy.target);
    await user.type(field, "https://www.instagram.com/p/CxYz/");

    // Available AND functional: the value the operator typed is held, with no
    // grid behind it at all.
    expect(field).toHaveValue("https://www.instagram.com/p/CxYz/");
    // And the hint under it promised exactly that, before anything broke.
    expect(screen.getByText(copy.targetHint)).toBeInTheDocument();
  });

  it("says the grid is empty rather than broken when nothing is stored", async () => {
    const client = createPublicationsDouble();
    client.openAnswer = { ...LISTING, items: [], total: 0 };

    render(<PublicationsScreen client={client} />);

    expect(await screen.findByText(copy.emptyTitle)).toBeInTheDocument();
    expect(screen.getByText(copy.empty)).toBeInTheDocument();
    // An empty cache is not a fault, so nothing is raised as one.
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("REQ-115: the five states of the grid look like five things", () => {
  /** The nature `Notice` writes onto its block, so one can be read back. */
  function natureOf(element: HTMLElement): string {
    return (
      [...element.classList].find((name) => name.startsWith("mc-notice--")) ??
      ""
    );
  }

  it("announces the read in progress, before any listing exists", async () => {
    const client = createPublicationsDouble();
    let release = (): void => {};
    client.open = () =>
      new Promise<PublicationListing>((resolve) => {
        release = (): void => resolve(LISTING);
      });

    render(<PublicationsScreen client={client} />);

    // A sentence and not only a spinner: a turning shape says something is
    // happening to whoever can see it turn, and nothing at all to anyone else.
    const reading = await screen.findByRole("status");
    expect(reading).toHaveTextContent(copy.loading);

    // The empty state is NOT what a screen shows while it is still reading.
    expect(screen.queryByText(copy.emptyTitle)).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();

    release();
    await screen.findByRole("button", { name: selectButton(IMAGE_ID) });
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("separates an unavailable listing from a degraded one", async () => {
    const unreadable = createPublicationsDouble();
    unreadable.openFails = true;

    const failed = render(<PublicationsScreen client={unreadable} />);
    const unavailable = await screen.findByRole("alert");
    const unavailableReport = {
      nature: natureOf(unavailable),
      text: unavailable.textContent ?? "",
    };
    // Nothing could be read at all, so there is no grid and no empty state
    // pretending the account has no publications.
    expect(screen.queryByText(copy.emptyTitle)).toBeNull();
    expect(screen.queryByRole("list")).toBeNull();

    failed.unmount();

    const stale = createPublicationsDouble();
    stale.openAnswer = { ...LISTING, failure: "rate limit reached" };

    render(<PublicationsScreen client={stale} />);
    const degraded = await screen.findByRole("alert");

    // An error where nothing is usable, a warning where the stored rows are:
    // the two must not be the same block with a different sentence in it.
    expect(unavailableReport.nature).toBe("mc-notice--error");
    expect(natureOf(degraded)).toBe("mc-notice--warning");
    expect(degraded.textContent).not.toBe(unavailableReport.text);
  });

  it("says which store the rows came from, and when", async () => {
    const user = userEvent.setup();
    const client = createPublicationsDouble();

    render(<PublicationsScreen client={client} />);

    // Read from this instance's own store, with the moment it was stored: a
    // stale grid that did not say it was stale would be read as current.
    expect(await screen.findByText(copy.sourceCache)).toBeInTheDocument();
    expect(
      screen.getByText(
        text(copy.cachedAt, {
          at: new Date(CACHED_AT).toLocaleDateString("en"),
        }),
      ),
    ).toBeInTheDocument();

    await user.click(anyRefreshButton());

    // Just walked, so the sentence changes and the stored-on line goes with it.
    expect(await screen.findByText(copy.sourcePlatform)).toBeInTheDocument();
    expect(screen.queryByText(copy.sourceCache)).toBeNull();
  });

  it("keeps a publication selectable when its thumbnail fails to load", async () => {
    const user = userEvent.setup();
    const client = createPublicationsDouble();

    render(<PublicationsScreen client={client} />);

    const thumbnail = await screen.findByRole("img", {
      name: text(copy.thumbnailAlt, { id: IMAGE_ID }),
    });

    // The platform's addresses expire and answer 404 long after the row was
    // stored. A tile that went blank would look like a tile that is broken.
    fireEvent.error(thumbnail);

    expect(screen.getAllByText(copy.thumbnailBroken)).toHaveLength(2);
    expect(screen.queryByRole("img")).toBeNull();

    await user.click(
      screen.getByRole("button", { name: selectButton(IMAGE_ID) }),
    );

    // The picture is what was lost, never the target it was standing for.
    expect(screen.getByLabelText(copy.target)).toHaveValue(IMAGE_ID);
  });
});

describe("REQ-209 and REQ-210: automation coverage belongs to each publication", () => {
  const THIRD_ID = "17900000000000003";
  const FOURTH_ID = "17900000000000004";

  function coverageDouble(): PublicationAutomationCoverageClient {
    return {
      byIds: (ids) => {
        expect(ids).toEqual([IMAGE_ID, VIDEO_ID, THIRD_ID, FOURTH_ID]);
        return Promise.resolve([
          {
            publicationId: IMAGE_ID,
            active: 1,
            inactive: 0,
            automations: [{ id: "launch", enabled: true }],
          },
          {
            publicationId: VIDEO_ID,
            active: 0,
            inactive: 1,
            automations: [{ id: "archive", enabled: false }],
          },
          {
            publicationId: THIRD_ID,
            active: 1,
            inactive: 0,
            automations: [{ id: "announce", enabled: true }],
          },
          {
            publicationId: FOURTH_ID,
            active: 0,
            inactive: 0,
            automations: [],
          },
        ]);
      },
    };
  }

  function coverageListing(): PublicationListing {
    return {
      ...LISTING,
      items: [
        ...LISTING.items,
        {
          id: THIRD_ID,
          mediaType: "CAROUSEL_ALBUM",
          publishedAt: "2026-07-10T09:00:00.000Z",
        },
        {
          id: FOURTH_ID,
          mediaType: "IMAGE",
          publishedAt: "2026-07-01T09:00:00.000Z",
        },
      ],
      total: 4,
    };
  }

  function publication(id: string): HTMLElement {
    const tile = screen.getByRole("button", { name: selectButton(id) });
    const item = tile.closest("li");

    if (item === null) {
      throw new Error(`publication ${id} has no grid item`);
    }

    return item;
  }

  it("distinguishes own active, own inactive and no coverage", async () => {
    const client = createPublicationsDouble();
    client.openAnswer = coverageListing();

    render(
      <PublicationsScreen client={client} coverageClient={coverageDouble()} />,
    );

    await screen.findByRole("button", { name: selectButton(IMAGE_ID) });
    expect(
      await within(publication(IMAGE_ID)).findByText(copy.coverageOneActive),
    ).toBeInTheDocument();
    expect(
      within(publication(VIDEO_ID)).getByText(copy.coverageOneInactive),
    ).toBeInTheDocument();
    expect(
      within(publication(THIRD_ID)).getByText(copy.coverageOneActive),
    ).toBeInTheDocument();
    expect(
      within(publication(FOURTH_ID)).getByText(copy.coverageNone),
    ).toBeInTheDocument();
  });

  /**
   * REQ-216, and criterion 4 of the phase: the entry into the editor FROM the
   * publication, which is the half of the requirement the absence guards in
   * `flows.test.tsx` and `api/flows.test.ts` cannot reach. A free publication
   * carries the target into a new automation, an occupied one opens the
   * automation it already has, and each tile offers exactly one of the two.
   */
  it("offers only Edit when specific coverage exists and only Create when it does not", async () => {
    const client = createPublicationsDouble();
    client.openAnswer = coverageListing();

    render(
      <PublicationsScreen client={client} coverageClient={coverageDouble()} />,
    );

    await screen.findByRole("button", { name: selectButton(THIRD_ID) });
    const item = within(publication(THIRD_ID));

    expect(
      await item.findByRole("link", { name: copy.editAutomation }),
    ).toHaveAttribute("href", "/automations/form?id=announce");
    expect(
      item.queryByRole("link", { name: copy.createAutomation }),
    ).toBeNull();

    const free = within(publication(FOURTH_ID));
    expect(free.queryByRole("link", { name: copy.editAutomation })).toBeNull();
    expect(
      free.getByRole("link", { name: copy.createAutomation }),
    ).toHaveAttribute("href", `/automations/form?target=${FOURTH_ID}`);
  });
});

/**
 * REQ-144: the client half of finding a publication by identifier.
 *
 * The route declares `ids` as an ARRAY, so the address has to repeat the
 * parameter. That is the one seam a screen test with a double cannot see: a
 * client that joined the identifiers with a comma would be perfectly typed,
 * perfectly tested against its own double, and refused by the contract with a
 * 400 the moment it ran against the process.
 */
describe("the identifier lookup client", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("repeats the parameter, one identifier at a time, and unwraps the answer", async () => {
    const asked: string[] = [];
    vi.stubGlobal("fetch", (url: string) => {
      asked.push(url);
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ publications: { items: LISTING.items } }),
      });
    });

    const found = await httpPublicationFinder.byIds([IMAGE_ID, VIDEO_ID]);

    expect(asked).toEqual([
      `/api/publications/by-id?ids=${IMAGE_ID}&ids=${VIDEO_ID}`,
    ]);
    expect(found.items).toEqual(LISTING.items);
  });

  it("sends nothing at all when there is no identifier to look up", async () => {
    const stub = vi.fn();
    vi.stubGlobal("fetch", stub);

    // A listing whose automations all watch the whole account names no
    // publication, and an empty request would still cost a round trip.
    expect(await httpPublicationFinder.byIds([])).toEqual({ items: [] });
    expect(stub).not.toHaveBeenCalled();
  });

  it("raises on a refused request, so the caller keeps what it had", async () => {
    vi.stubGlobal("fetch", () => Promise.resolve({ ok: false, status: 401 }));

    // The screen catches this and loses the thumbnails only: rows the operator
    // could read a second ago must not vanish over a picture (REQ-072).
    await expect(httpPublicationFinder.byIds([IMAGE_ID])).rejects.toThrow(
      "401",
    );
  });

  it("reads page-scoped automation coverage with repeated identifiers", async () => {
    const asked: string[] = [];
    const answer = [
      {
        publicationId: IMAGE_ID,
        active: 0,
        inactive: 0,
        automations: [],
      },
    ];
    vi.stubGlobal("fetch", (url: string) => {
      asked.push(url);
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ coverage: answer }),
      });
    });

    expect(
      await httpPublicationAutomationCoverageClient.byIds([IMAGE_ID, VIDEO_ID]),
    ).toEqual(answer);
    expect(asked).toEqual([
      `/api/publications/automation-coverage?ids=${IMAGE_ID}&ids=${VIDEO_ID}`,
    ]);
  });
});

/**
 * The stylesheet, as text.
 *
 * Read through `import.meta.glob` and not through an import, for the reason
 * `styles/tokens.test.ts` records: a `?raw` specifier would break
 * `tests/import-extensions.test.ts` (REQ-082).
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

/**
 * REQ-216: the grid says which publication each tile is.
 *
 * The tile used to read `IMAGE · 09 jun · 17900000000000001`. Nobody recognises
 * their own post by seventeen digits, so ten publications were ten thumbnails
 * to squint at. What is asserted here is the whole of the change: the words are
 * on the card, the identifier is still there and no longer first, and the
 * publication that carries no caption loses nothing.
 */
describe("REQ-216: the publication is named by what was published", () => {
  it("shows the caption, and leaves the tile whole when there is none", async () => {
    const client = createPublicationsDouble();

    render(<PublicationsScreen client={client} />);

    await screen.findByRole("button", { name: selectButton(IMAGE_ID) });

    // The words, whole: nothing was cut on the way to the screen.
    expect(screen.getByText(CAPTION, VERBATIM)).toBeInTheDocument();

    // And the publication with no caption keeps everything it ever had: its
    // date, its identifier and its place as a target. No gap, no invented text.
    const silent = screen.getByRole("button", { name: selectButton(VIDEO_ID) });

    expect(within(silent).getByText(VIDEO_ID)).toBeInTheDocument();
    expect(
      within(silent).getByText(
        new Date("2026-07-20T09:00:00.000Z").toLocaleDateString("en"),
      ),
    ).toBeInTheDocument();
    expect(silent.querySelector(".mc-pubtile__caption")).toBeNull();
  });

  it("reads the caption before the identifier, which stays legible and last", async () => {
    const client = createPublicationsDouble();

    render(<PublicationsScreen client={client} />);

    const tile = await screen.findByRole("button", {
      name: selectButton(IMAGE_ID),
    });

    const caption = within(tile).getByText(CAPTION, VERBATIM);
    const identifier = within(tile).getByText(IMAGE_ID);

    // Still on the card — this task demotes the identifier, it does not hide
    // it: it is what an operator pastes into a support message.
    expect(identifier).toBeInTheDocument();
    expect(
      caption.compareDocumentPosition(identifier) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("keeps a very long caption whole in the document and clamps it in the sheet", async () => {
    const client = createPublicationsDouble();
    const written = `${"palavra ".repeat(300)}fim`;

    client.openAnswer = {
      ...LISTING,
      items: [
        {
          id: IMAGE_ID,
          caption: written,
          mediaType: "IMAGE",
          publishedAt: "2026-07-28T18:20:00.000Z",
          thumbnailUrl: "/assets/thumbs/one.jpg",
        },
      ],
      total: 1,
    };

    render(<PublicationsScreen client={client} />);

    const tile = await screen.findByRole("button", {
      name: selectButton(IMAGE_ID),
    });
    const caption = tile.querySelector(".mc-pubtile__caption");

    // Whole in the document: the clamp is drawing, so a screen reader reads all
    // of it and a wider card shows more of it. Truncating here would be the one
    // cut nothing could undo.
    expect(caption?.textContent).toBe(written);

    // And the clamp is really in the sheet. jsdom applies no CSS, so this is
    // the half of the promise a test can hold: the rule exists, and it is
    // written for the class the markup carries.
    expect(COMPONENT_SHEET.length).toBeGreaterThan(0);

    const clamp = blockAfter(COMPONENT_SHEET, ".mc-pubtile__caption {");

    expect(clamp).toContain("-webkit-line-clamp: 2;");
    expect(clamp).toContain("overflow: hidden;");
  });
});
