import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import en from "../../i18n/locales/en.json";
import ptBR from "../../i18n/locales/pt-BR.json";
import {
  DEFAULT_FIRST_REPLY_DELAY_SECONDS,
  draftAutomationSchema,
  FIRST_REPLY_DELAY_CHOICES,
  KEYWORD_MATCH_MODES,
  PURE_LINK_LIMIT,
} from "../../flows/schema.js";
import type { UnifiedAutomation } from "../../flows/schema.js";
import { createTranslator } from "../../i18n/translator.js";
import { TOAST_VIEWPORT_ID } from "../components/index.js";
import { LocaleProvider } from "../locale.js";
import type { LocaleClient, LocaleState } from "../locale.js";
import { App } from "../App.js";
import type { RouteEntry } from "../routes.js";
import { AutomationFormScreen, REFUSAL_TEXT_KEYS } from "./automation-form.js";
import type { AssetsClient } from "./flow-step-fields.js";
import { declaredKeywords } from "./automations.js";
import type { AutomationsClient, StoredAutomation } from "./automations.js";
import { formatDate } from "./publications.js";
import type { ConversationClient, ConversationSettings } from "./settings.js";
import type {
  PublicationFinder,
  PublicationRow,
  PublicationsClient,
} from "./publications.js";

const NOW = "2026-08-14T12:00:00.000Z";

/** The screen's own words, read from the catalogue it renders from (REQ-074). */
const copy = en.screens.automations;

/** The grid's own words, since this screen reuses the grid and its client. */
const gridCopy = en.screens.publications;

const IMAGE_ID = "17900000000000000";
const VIDEO_ID = "17900000000000002";

/**
 * What the operator published, and the reason section 1 can be read at all:
 * `IMAGE · 01 ago · 17900000000000000` names no post to a human.
 */
const CAPTION = "Walking skeleton.\nComenta esqueleto e eu te mando o link.";

/**
 * The caption at the length a real one has: a paragraph, then eighteen
 * hashtags.
 *
 * The heading used to be built out of this, and this is what that looked like
 * on the operator's screen: a title as tall as the window, with the first field
 * of the form below the fold. A short caption in this fixture would let the
 * heading go on carrying one and nothing here would ever fail (REQ-296).
 */
const LONG_CAPTION = [
  "Chegou o guia completo de automação de comentários que eu prometi na semana passada: são quatro fluxos, o passo a passo de cada um e os erros que me custaram dois meses de alcance.",
  "Comenta GUIA aqui embaixo e o link cai no seu direct na hora, sem cadastro e sem grupo de WhatsApp.",
  "#automacao #instagram #marketingdigital #socialmedia #copywriting #conteudo #empreendedorismo #negociosdigitais #vendasonline #trafegopago #reels #engajamento #comunidade #infoproduto #lancamento #funildevendas #whatsapp #directs",
].join("\n");

/**
 * The drawing this screen is approved by, as text (REQ-297).
 *
 * `docs/prototipo-automacao.html` is what the user looks at and approves, so a
 * box taken out of the screen has to leave the drawing with it: a prototype
 * that still shows what the product no longer has is a specification that will
 * put it back. Read through a glob rather than an import for the reason
 * `components.test.tsx` states: every relative specifier in the repository ends
 * in `.js` (REQ-082), and `import.meta.glob` is not a specifier.
 */
const PROTOTYPE_SOURCES = import.meta.glob<string>(
  "../../../docs/prototipo-automacao.html",
  { eager: true, query: "?raw", import: "default" },
);

const PROTOTYPE = Object.values(PROTOTYPE_SOURCES)[0] ?? "";

/**
 * Text compared exactly as the DOM holds it, line breaks included.
 *
 * The default matcher collapses whitespace before comparing, and a caption is
 * written WITH its line breaks: it would never be found, and worse, a screen
 * that had silently flattened it would still pass.
 */
const VERBATIM = { normalizer: (value: string): string => value };

/**
 * Two publications as the instance answers with them, instants as ISO.
 *
 * One carries a caption and one does not, deliberately: a publication with no
 * caption is ordinary, and the section has to close up around the absence
 * instead of leaving a hole where the words would be.
 */
const PUBLICATIONS: readonly PublicationRow[] = [
  {
    id: IMAGE_ID,
    caption: CAPTION,
    mediaType: "IMAGE",
    publishedAt: "2026-08-01T10:00:00.000Z",
    thumbnailUrl: "/thumbs/one.jpg",
  },
  {
    id: VIDEO_ID,
    mediaType: "VIDEO",
    publishedAt: "2026-07-02T10:00:00.000Z",
    thumbnailUrl: "/thumbs/two.jpg",
  },
];

/** The narrow read the editor makes: the ONE publication it already names. */
function finder(
  rows: readonly PublicationRow[] = PUBLICATIONS,
): PublicationFinder {
  return {
    byIds: vi.fn(async (ids: readonly string[]) => ({
      items: rows.filter((row) => ids.includes(row.id)),
    })),
  };
}

/** The grid behind the picker, for the swap. */
function grid(
  rows: readonly PublicationRow[] = PUBLICATIONS,
): PublicationsClient {
  const listing = {
    items: rows,
    total: rows.length,
    offset: 0,
    limit: 12,
    source: "cache" as const,
  };

  return {
    open: vi.fn(async () => listing),
    refresh: vi.fn(async () => listing),
  };
}

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

/**
 * The toast the editor answered the last save with (REQ-312).
 *
 * Looked for inside the strip toasts are portalled into, and NOT by asking the
 * document for its `role="status"`: a field's length advice is a polite region
 * too, so the document-wide query is ambiguous on exactly the screen this file
 * tests. Scoped, the role is still what finds it.
 */
async function toast(): Promise<HTMLElement> {
  return await waitFor(() => {
    const strip = document.getElementById(TOAST_VIEWPORT_ID);

    if (strip === null) throw new Error("no toast has been raised");

    return within(strip).getByRole("status");
  });
}

/**
 * The catalogue's own translator, for the one sentence `resolve` cannot build.
 *
 * The shape of the delivery names a LIST, and which separator goes before its
 * last item is the language's business and not this screen's (`{{names, list}}`,
 * REQ-283). Writing "a and b" here would be writing English into the test and
 * asserting the screen agrees with it; asking the same translator the screen
 * asks leaves the sentence in the catalogue, where the requirement puts it.
 */
const catalogue = createTranslator({ en }, "en");

/** The delivery's shape, named part by part, in the order given. */
function shape(...names: readonly string[]): string {
  return catalogue.t("screens.automations.deliveryShape", {
    count: names.length,
    names,
  });
}

/** Seconds in a minute, so a wait of 60 is read here as the screen reads it. */
const A_MINUTE = 60;

/**
 * What one wait on the ruler is CALLED, resolved from the catalogue (REQ-277).
 *
 * Never written out as "30s" here: a label copied into the test is a label that
 * goes on matching after the screen stops saying it, in either language.
 */
function waitOption(seconds: number): string {
  if (seconds === 0) return copy.firstReplyDelayImmediate;

  return seconds % A_MINUTE === 0
    ? resolve(copy.firstReplyDelayMinutes, { minutes: seconds / A_MINUTE })
    : resolve(copy.firstReplyDelaySeconds, { seconds });
}

/**
 * Turns the confirmation OFF, which a new automation is born asking (REQ-273).
 *
 * For every test that is about something else. The request comes on, and with
 * it on an activation is refused until the button it is answered with is
 * written (REQ-249), so a test about the trigger, the name or the delivery
 * would be refused over a field it never meant to talk about.
 */
async function withoutConfirmation(
  user: ReturnType<typeof userEvent.setup>,
): Promise<void> {
  await user.click(
    screen.getByRole("checkbox", { name: copy.openingConfirmation }),
  );
}

/** Opens the editor at an address, which is where the entry's answer lives. */
function openAt(query: string): void {
  window.history.pushState({}, "", `/automations/form${query}`);
}

/**
 * Opens the editor ON a publication, which since REQ-264 is the only way a
 * target reaches this screen: the entrance carries it, or the grid picks it.
 * There is no field to type one into any more.
 */
function openOnPublication(id: string = IMAGE_ID): void {
  openAt(`?trigger=comment&target=${id}`);
}

// Every test starts from the comment entrance with nothing else in the address:
// the query is what this screen reads its trigger and its target from, and one
// test must not inherit the address another one pushed.
beforeEach(() => openAt(""));

function stored(definition: UnifiedAutomation): StoredAutomation {
  return { definition, createdAt: NOW, updatedAt: NOW };
}

function client(save = vi.fn()): AutomationsClient {
  return {
    list: vi.fn(async () => []),
    read: vi.fn(async () => undefined),
    save: save.mockImplementation(async (definition: UnifiedAutomation) => ({
      ok: true,
      created: false,
      stored: stored(definition),
    })),
    remove: vi.fn(async () => ({ ok: true as const })),
  };
}

/**
 * The instance answering that the automation did not exist before this save.
 *
 * The one answer that makes the editor leave on its own, and the ordinary
 * double above never gives it: everything else in this file edits something
 * already stored, so `created` is false there and the departure it triggers is
 * never exercised.
 */
function creating(): AutomationsClient {
  return {
    ...client(),
    save: vi.fn(async (definition: UnifiedAutomation) => ({
      ok: true as const,
      created: true,
      stored: stored(definition),
    })),
  };
}

/**
 * The cover, chosen the way an operator chooses one since REQ-291: the control
 * opens the catalogue of what was already uploaded, and what is pressed there
 * is the picture. It used to be an option of a dropdown, picked by name.
 */
async function pickCover(
  user: ReturnType<typeof userEvent.setup>,
): Promise<void> {
  await user.click(await screen.findByLabelText(/Card cover/));
  await user.click(
    await screen.findByRole("button", {
      name: en.screens.assets.use.replace("{{name}}", "cover.png"),
    }),
  );
}

const assets: AssetsClient = {
  list: vi.fn(async () => ({
    ok: true as const,
    assets: [
      {
        name: "cover.png",
        fileName: "cover.png",
        publicUrl: "/assets/cover.png",
      },
      {
        name: "guide.pdf",
        fileName: "guide.pdf",
        publicUrl: "/assets/guide.pdf",
      },
    ],
    upload: { contentTypes: ["application/pdf", "image/png"], maxBytes: 1000 },
  })),
  upload: vi.fn(async () => ({
    ok: false as const,
    reason: "failed" as const,
  })),
  usage: vi.fn(async () => ({ ok: true as const, usedBy: 0 })),
  remove: vi.fn(async () => ({ ok: true as const })),
};

describe("REQ-214/REQ-215: unified narrative editor", () => {
  it("shows concrete sections without flow, parameter, asset or technical identity", () => {
    render(<AutomationFormScreen client={client()} assets={assets} />);
    // The five, named by what they DO. The step is no longer written into the
    // sentence: it is drawn beside it, in the badge that also says whether the
    // section still holds something incomplete, so a heading is the name of one
    // region and not a name with a number glued to its front.
    for (const title of [
      copy.whenCommentTitle,
      copy.publicReplyTitle,
      copy.openingTitle,
      copy.privateMessageTitle,
      copy.optionalRulesTitle,
    ]) {
      expect(screen.getByRole("heading", { name: title })).toBeInTheDocument();
    }

    expect(screen.queryByText(/flow|parameter|asset/i)).not.toBeInTheDocument();
    // "Identifier" has no place left on this screen at all. REQ-260 took the
    // address out of the product and REQ-264 took the last field with it: the
    // publication is chosen by looking at it, and the seventeen digits that
    // name nothing to a person are neither shown nor typed.
    expect(screen.queryAllByText(/identifier/i)).toEqual([]);
  });

  it("stores an incomplete draft in one aggregate write", async () => {
    const save = vi.fn();
    const api = client(save);
    const user = userEvent.setup();
    render(<AutomationFormScreen client={api} assets={assets} />);
    // A word and nothing else: no publication, no message. What makes this a
    // draft is precisely that it is not activatable.
    await user.type(
      screen.getByPlaceholderText(copy.keywordsPlaceholder),
      "ebook{enter}",
    );
    await user.click(screen.getByRole("button", { name: copy.saveDraft }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    const definition = save.mock.calls[0]?.[0] as UnifiedAutomation;
    expect(definition).toMatchObject({ schema_version: 2, state: "draft" });
    // Derived from the instant it was created and from the entrance it came
    // through, because nobody was asked to name it (REQ-228).
    expect(definition.id).toMatch(/^comment-\d{4}-\d{2}-\d{2}t/);
    expect(definition).not.toHaveProperty("flow");
  });

  it("REQ-372: counts UTF-8 bytes and blocks both saves past the private-message limit", async () => {
    const save = vi.fn();
    const api = client(save);
    const user = userEvent.setup();
    render(<AutomationFormScreen client={api} assets={assets} />);

    const message = screen.getByLabelText(copy.messageBody);
    // It is bytes, not characters: 501 accented letters occupy 1002 UTF-8
    // bytes. The overage tells the operator exactly how far past the ceiling
    // it is, rather than pretending that the value was silently shortened.
    await user.type(message, "é".repeat(501));

    expect(
      screen.getByText(
        resolve(copy.messageBytesOverLimit, { over: 2, limit: 1000 }),
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(resolve(copy.messageByteLimit, { limit: 1000 })),
    ).toBeInTheDocument();
    expect(message).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("button", { name: copy.saveDraft })).toBeDisabled();
    expect(screen.getByRole("button", { name: copy.activate })).toBeDisabled();
    expect(save).not.toHaveBeenCalled();

    await user.clear(message);
    await user.type(message, "é".repeat(500));

    expect(
      screen.getByText(
        resolve(copy.messageBytesRemaining, { remaining: 0, limit: 1000 }),
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: copy.saveDraft })).toBeEnabled();
  });

  it("refuses activation locally and focuses the first incomplete field", async () => {
    const api = client();
    const user = userEvent.setup();
    render(<AutomationFormScreen client={api} assets={assets} />);
    await user.click(screen.getByRole("button", { name: "Activate" }));
    // The publication, which is the first thing missing now that the name is
    // not asked for at all. The caret lands on the ONE control that can answer
    // it, and never on the document: with the typed address gone (REQ-264) the
    // grid button is that control, and a focus with nowhere to go is how this
    // screen would send an operator hunting.
    expect(
      screen.getByRole("button", { name: copy.chooseInGrid }),
    ).toHaveFocus();
    expect(api.save).not.toHaveBeenCalled();
  });

  it("keeps session expiry distinct while opening an aggregate", async () => {
    const api = client();
    api.read = vi.fn(async () => {
      throw new Error("401");
    });
    render(
      <AutomationFormScreen
        automationId="launch"
        client={api}
        assets={assets}
      />,
    );
    expect(await screen.findByText(/session is not open/i)).toBeInTheDocument();
  });

  it("writes public variations and concrete card content in narrative order", async () => {
    const save = vi.fn();
    const user = userEvent.setup();
    openOnPublication();
    render(
      <AutomationFormScreen
        client={client(save)}
        assets={assets}
        finder={finder()}
      />,
    );
    await user.type(
      screen.getByPlaceholderText("Type and press Enter"),
      "ebook{enter}",
    );
    await user.click(
      screen.getByLabelText("Send a public reply to the comment"),
    );
    // Two wordings, in the one box that takes them: each is committed by Enter
    // and becomes a chip, which is the whole gesture (REQ-274).
    await user.type(screen.getByLabelText("Public reply"), "I sent it{enter}");
    await user.type(
      screen.getByLabelText("Public reply"),
      "Check your inbox{enter}",
    );
    await withoutConfirmation(user);
    await user.click(screen.getByRole("button", { name: copy.addButton }));
    await user.type(screen.getByLabelText("Button 1 text"), "Download");
    await user.type(
      screen.getByLabelText("Button 1 address"),
      "https://example.com/guide",
    );
    // The cover is offered only now, because only now is there a card for it
    // to sit on (REQ-232).
    await user.click(screen.getByRole("button", { name: copy.addCover }));
    await pickCover(user);
    await user.type(screen.getByLabelText("Title optional"), "Your guide");
    await user.click(screen.getByRole("button", { name: "Activate" }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    const definition = save.mock.calls[0]?.[0] as UnifiedAutomation;
    expect(definition.state).toBe("active");
    expect(definition.steps?.map((step) => step.action)).toEqual([
      "reply_comment",
      "send_dm",
    ]);
    expect(definition.steps?.[0]).toMatchObject({
      text: ["I sent it", "Check your inbox"],
    });
    expect(definition.steps?.[1]).toMatchObject({
      // The additive contract (REQ-229): the parts sit on the message itself,
      // with no `kind` choosing between them and no card entity in the middle.
      message: {
        image: "cover.png",
        title: "Your guide",
        buttons: [
          {
            id: "button-1",
            label: "Download",
            url: "https://example.com/guide",
          },
        ],
      },
    });
    expect(screen.getByRole("img", { name: "cover.png" })).toHaveAttribute(
      "src",
      "/assets/cover.png",
    );
  });

  /**
   * REQ-134 in the shape phase 3k left it, and the half that goes unnoticed.
   *
   * The requirement has always had two halves in two layers: the instance
   * REFUSES a direct-message automation that replies to a comment (that half
   * lives in `validation.ts` and is proved in `wordings.test.ts`), and the
   * interface does not OFFER the incompatible combination in the first place.
   * The second half used to be a flow list that filtered itself, then a section
   * that appeared and disappeared as a `<Select>` was driven. Since REQ-227 the
   * trigger is answered at the ENTRY and the editor never asks it, so the
   * incompatible combination cannot be assembled here at all: entering by the
   * direct message, the public reply is not on the page and is not saved.
   *
   * Proving only the refusal would leave the operator meeting an error for a
   * control the editor should never have shown, which is exactly how the 3c
   * criterion 35 failed.
   */
  it("REQ-134: the direct message entrance offers no public reply, and saves none", async () => {
    const save = vi.fn();
    const user = userEvent.setup();
    openAt("?trigger=direct_message");
    render(<AutomationFormScreen client={client(save)} assets={assets} />);

    await user.type(
      screen.getByPlaceholderText("Type and press Enter"),
      "guide{enter}",
    );

    // The section is not disabled or marked invalid: it is not there. Neither
    // is the publication, which a direct message does not have.
    expect(
      screen.queryByRole("heading", { name: "2. Reply on the comment" }),
    ).toBeNull();
    expect(screen.queryByLabelText("Public reply")).toBeNull();
    expect(screen.queryByRole("group", { name: copy.targetChosen })).toBeNull();

    await user.type(screen.getByLabelText("Message"), "here is the guide");
    await user.click(screen.getByRole("button", { name: "Activate" }));

    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    const definition = save.mock.calls[0]?.[0] as UnifiedAutomation;
    expect(definition.trigger?.type).toBe("direct_message");
    // No wording is smuggled in as a step the instance would then have to
    // refuse.
    expect(definition.steps?.map((step) => step.action)).toEqual(["send_dm"]);
  });

  /**
   * Criterion 1 and criterion 6 of the phase, end to end and in one screen:
   * "comentou palavra, resposta pública e DM com PDF" — and the words that go
   * with the PDF.
   *
   * THE ANCHOR CASE, and the one this editor used to fail. Choosing "file" was
   * choosing to have no message: the format was exclusive, the text field went
   * away with the choice, and "here is the PDF I promised" reached the contact
   * as a bare attachment. There is no format to choose any more, so the two
   * parts are simply both declared — and the test that matters is the one that
   * reads the text back off the aggregate, beside the file.
   */
  /*
   * The anchor case at the EDITOR: a text and a file, neither of them lost.
   *
   * Written as a text plus an ATTACHMENT, which the format stopped carrying
   * with REQ-284: a file reaches the contact as a card button's destination
   * now (REQ-285), and this editor has no way to declare one yet — a button
   * takes a typed address and nothing else. The case comes back with the two
   * destination labels of REQ-289, in task 3n.5, and what it will assert is a
   * button whose destination is the chosen file.
   */

  it("REQ-226: serializes the rules that are really adjustments, and confirms the save", async () => {
    const save = vi.fn();
    const user = userEvent.setup();
    render(<AutomationFormScreen client={client(save)} assets={assets} />);

    await withoutConfirmation(user);
    await user.click(screen.getByLabelText(copy.fieldOnce));
    await user.click(screen.getByRole("radio", { name: waitOption(30) }));
    await user.click(screen.getByRole("button", { name: copy.saveDraft }));

    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    const definition = save.mock.calls[0]?.[0] as UnifiedAutomation;
    expect(definition.rules?.once_per_contact).toBe(false);
    // Both adjustments in the SAME place, which is what makes the wait an
    // adjustment: it is a rule of the automation, not a step in a list.
    expect(definition.rules?.first_reply_delay_seconds).toBe(30);
    expect(definition.steps?.map((step) => step.action)).toEqual(["send_dm"]);
    expect(
      await screen.findByText("The incomplete draft was saved."),
    ).toBeInTheDocument();
  });
});

/**
 * A stored automation whose message uses every part at once, as the instance
 * holds one: a card with a cover and a link, and a document after it.
 */
const STORED_CARD: UnifiedAutomation = {
  schema_version: 2,
  kind: "automation",
  id: "comment-2026-08-14t12-00-00-000z",
  state: "active",
  trigger: {
    type: "comment",
    target: IMAGE_ID,
    match: { keywords: ["guide"], mode: "contains" },
  },
  rules: { once_per_contact: true, first_reply_delay_seconds: 5 },
  steps: [
    {
      id: "private-message",
      action: "send_dm",
      message: {
        title: "Your guide",
        image: "cover.png",
        buttons: [
          {
            id: "button-1",
            label: "Download",
            url: "https://example.com/guide",
          },
        ],
      },
    },
  ],
};

/**
 * Section 4 as it became in task 3k.18: no format, only parts (REQ-229).
 *
 * What these cases guard is not the drawing but the TRANSITIONS, because every
 * defect this section ever had lived in one: choosing a card made the written
 * text vanish, choosing a file dropped it at the send, and "text and a link"
 * could not be expressed at all. The additive contract makes those combinations
 * expressible; what makes them SAFE is that the editor never assembles a
 * message the instance would refuse — and the instance refuses a text and a
 * heading declared together (`card_title_declared_twice`) exactly so that
 * neither of the two can be dropped in silence.
 *
 * So each case below adds or removes one part and reads the aggregate back.
 */
describe("REQ-229/REQ-230/REQ-232: the message is parts, and no part is lost", () => {
  // The publication arrives with the address, which is what the entrance does
  // (REQ-264): every case here activates, and section 1 is answered before the
  // message is touched.
  beforeEach(() => openOnPublication());

  /** Everything the editor needs to be activatable, minus the message. */
  async function ready(
    user: ReturnType<typeof userEvent.setup>,
  ): Promise<void> {
    await user.type(
      screen.getByPlaceholderText(copy.keywordsPlaceholder),
      "guide{enter}",
    );
    // These tests are about the MESSAGE, and what opens the conversation is a
    // section of its own that a new automation is born asking (REQ-273).
    await withoutConfirmation(user);
  }

  /** The message of the one `send_dm` the editor writes. */
  function messageOf(definition: UnifiedAutomation): Record<string, unknown> {
    const step = definition.steps?.find((entry) => entry.action === "send_dm");

    return ((step as { message?: Record<string, unknown> } | undefined)
      ?.message ?? {}) as Record<string, unknown>;
  }

  it("offers no format at all: a message, and the things to add to it", () => {
    render(
      <AutomationFormScreen
        client={client()}
        assets={assets}
        finder={finder()}
      />,
    );

    const section = screen.getByRole("region", {
      name: copy.privateMessageTitle,
    });

    // The choice that made the text vanish is not disabled or hidden: it is
    // gone, and with it the three words it chose between.
    expect(
      within(section).queryByRole("combobox", { name: /format/i }),
    ).toBeNull();
    // THREE things to add since REQ-287, and the third is the point: a pure
    // link and a card button are different deliveries, so each is offered as
    // itself instead of one control producing both.
    for (const action of [copy.addLink, copy.addButton, copy.addCover])
      expect(
        within(section).getByRole("button", { name: action }),
      ).toBeInTheDocument();

    // And the message is labelled ONCE. It used to be a Field wrapping a
    // TextArea, each drawing a label for the same control, so the word stood
    // on the screen twice and was announced twice.
    expect(
      within(section)
        .getAllByText(copy.messageBody)
        .filter((node) => node.tagName === "LABEL"),
    ).toHaveLength(1);
  });

  it("REQ-230: the first link turns the box into a card and moves the text into the heading", async () => {
    const save = vi.fn();
    const user = userEvent.setup();
    render(
      <AutomationFormScreen
        client={client(save)}
        assets={assets}
        finder={finder()}
      />,
    );
    await ready(user);

    await user.type(screen.getByLabelText(copy.messageBody), "Your free guide");
    await user.click(screen.getByRole("button", { name: copy.addButton }));

    // The loose box is gone, because there is no loose message any more: the
    // delivery is a card, and the card is drawn as one.
    expect(screen.queryByLabelText(copy.messageBody)).toBeNull();
    expect(
      screen.getByRole("group", { name: copy.cardBlock }),
    ).toBeInTheDocument();
    // The words followed, into the field that now carries them.
    expect(
      screen.getByLabelText(`${copy.cardTitle} ${copy.optionalLabel}`),
    ).toHaveValue("Your free guide");

    await user.type(screen.getByLabelText("Button 1 text"), "Download");
    await user.type(
      screen.getByLabelText("Button 1 address"),
      "https://example.com/guide",
    );
    await user.click(screen.getByRole("button", { name: copy.activate }));

    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    const message = messageOf(save.mock.calls[0]?.[0] as UnifiedAutomation);
    // The heading carries the words, and the text is EMPTY rather than a copy
    // of them: declared twice, the instance refuses the whole automation.
    expect(message["title"]).toBe("Your free guide");
    expect(message).not.toHaveProperty("text");
    expect(message["buttons"]).toEqual([
      { id: "button-1", label: "Download", url: "https://example.com/guide" },
    ]);
  });

  it("REQ-346: the migrated text is saved whole past the card display ceiling", async () => {
    const save = vi.fn();
    const user = userEvent.setup();
    render(
      <AutomationFormScreen
        client={client(save)}
        assets={assets}
        finder={finder()}
      />,
    );
    await ready(user);

    // A perfectly good text message: under the thousand bytes a text accepts,
    // and far over the eighty characters a card heading shows.
    const long = "g".repeat(120);
    await user.type(screen.getByLabelText(copy.messageBody), long);
    await user.click(screen.getByRole("button", { name: copy.addButton }));
    await user.type(screen.getByLabelText("Button 1 text"), "Download");
    await user.type(
      screen.getByLabelText("Button 1 address"),
      "https://example.com/guide",
    );
    await user.click(screen.getByRole("button", { name: copy.activate }));

    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    const message = messageOf(save.mock.calls[0]?.[0] as UnifiedAutomation);
    // The template cuts its DISPLAY only. The definition and delivery keep the
    // complete title, while the editor tells the operator what the contact sees.
    expect(message["title"]).toBe(long);
    const title = screen.getByLabelText(
      `${copy.cardTitle} ${copy.optionalLabel}`,
    );
    expect(title).toHaveValue(long);
    expect(title).not.toHaveAttribute("maxLength");
    expect(title).not.toHaveAttribute("aria-invalid");
    expect(
      screen
        .getByText(resolve(en.field.truncationWarning, { max: 80 }))
        .closest(".mc-field__advice"),
    ).toHaveAttribute("role", "status");
  });

  it("REQ-230/REQ-232: removing the last link undoes the card and gives the text back", async () => {
    const save = vi.fn();
    const user = userEvent.setup();
    render(
      <AutomationFormScreen
        client={client(save)}
        assets={assets}
        finder={finder()}
      />,
    );
    await ready(user);

    await user.type(screen.getByLabelText(copy.messageBody), "Your free guide");
    await user.click(screen.getByRole("button", { name: copy.addButton }));
    await user.click(screen.getByRole("button", { name: copy.addCover }));
    await pickCover(user);

    await user.click(
      screen.getByRole("button", {
        name: resolve(copy.buttonRemove, { number: 1 }),
      }),
    );

    // The box is back, with the words in it, and the card is gone with its
    // last link — cover included (REQ-232).
    expect(screen.getByLabelText(copy.messageBody)).toHaveValue(
      "Your free guide",
    );
    expect(screen.queryByRole("group", { name: copy.cardBlock })).toBeNull();
    expect(screen.queryByLabelText(/Card cover/)).toBeNull();

    await user.click(screen.getByRole("button", { name: copy.activate }));

    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    const message = messageOf(save.mock.calls[0]?.[0] as UnifiedAutomation);
    expect(message["text"]).toBe("Your free guide");
    expect(message).not.toHaveProperty("title");
    expect(message).not.toHaveProperty("buttons");
    // The cover left with the card. Kept, it would be an image the instance
    // refuses (`cover_without_button`) for a control the operator cannot see.
    expect(message).not.toHaveProperty("image");
  });

  it("REQ-232: the cover is not offered while there is no link, and says why", async () => {
    const user = userEvent.setup();
    render(
      <AutomationFormScreen
        client={client()}
        assets={assets}
        finder={finder()}
      />,
    );

    const cover = screen.getByRole("button", { name: copy.addCover });
    // Refused rather than hidden, with the reason beside it: a control that
    // appears and disappears teaches nothing about why.
    expect(cover).toBeDisabled();
    expect(screen.getByText(copy.coverNeedsButton)).toBeInTheDocument();
    expect(cover.getAttribute("aria-describedby")).toBe(
      screen.getByText(copy.coverNeedsButton).getAttribute("id"),
    );

    await user.click(screen.getByRole("button", { name: copy.addButton }));

    expect(screen.getByRole("button", { name: copy.addCover })).toBeEnabled();
    expect(screen.queryByText(copy.coverNeedsButton)).toBeNull();
  });

  /*
   * Three cases lived here and left with the attachment (REQ-284): what it
   * declared itself to be, the half-answered draft that held a kind with no
   * file, and the ceiling of one per delivery. The block they drove is gone
   * from the editor, so there is nothing left of them to assert; what replaces
   * them is the file as a button's destination, in task 3n.5.
   */

  it("reads a stored card back into the card, and a stored text into the box", async () => {
    const api = client();
    api.read = vi.fn(async () => stored(STORED_CARD));
    openAt("?id=comment-2026-08-14t12-00-00-000z");
    render(
      <AutomationFormScreen client={api} assets={assets} finder={finder()} />,
    );

    // The BUTTON is what makes it a card (REQ-287), so the editor opens on the
    // card and not on a loose message box the aggregate has no field for.
    expect(
      await screen.findByLabelText(`${copy.cardTitle} ${copy.optionalLabel}`),
    ).toHaveValue("Your guide");
    expect(screen.queryByLabelText(copy.messageBody)).toBeNull();
    expect(screen.getByLabelText("Button 1 text")).toHaveValue("Download");
  });
});

/**
 * A stored automation whose parts are DELIBERATELY out of every other order
 * than the one they were declared in (REQ-286, REQ-288).
 *
 * The buttons are labelled so that alphabetical order, insertion-id order and
 * declared order are three different sequences, and the links are addresses
 * that sort backwards. A fixture that happened to be sorted would let a screen
 * that sorts its parts pass, and the delivery order IS the order the contact
 * lives through: it is the one thing about a list of parts that cannot be
 * re-derived from anything else.
 */
const STORED_PARTS: UnifiedAutomation = {
  schema_version: 2,
  kind: "automation",
  id: "comment-2026-08-14t12-00-00-000z",
  state: "active",
  trigger: {
    type: "comment",
    target: IMAGE_ID,
    match: { keywords: ["guide"], mode: "contains" },
  },
  rules: { once_per_contact: true, first_reply_delay_seconds: 5 },
  steps: [
    {
      id: "private-message",
      action: "send_dm",
      message: {
        title: "Your guide",
        buttons: [
          { id: "button-3", label: "Zebra", asset: "guide.pdf" },
          { id: "button-1", label: "Album", url: "https://example.com/album" },
        ],
        links: ["https://zeta.example/watch", "https://alpha.example/read"],
      },
    },
  ],
};

/**
 * The destination of a card button, in the operator's own two words (REQ-289).
 *
 * The requirement is a pair of LABELS, and that is not a detail of copy: the
 * format's button is an exclusive union (`url` XOR `asset`), so what the screen
 * has to do is ask which of the two and then write down only that one. A screen
 * that offered both fields at once would produce a button that is filled in
 * correctly and refused at activation, and the operator would find that out
 * from the refusal rather than from the question.
 */
describe("REQ-289: a button opens one destination, named in the operator's words", () => {
  beforeEach(() => openOnPublication());

  /** Everything the editor needs to be activatable, minus the message. */
  async function ready(
    user: ReturnType<typeof userEvent.setup>,
  ): Promise<void> {
    await user.type(
      screen.getByPlaceholderText(copy.keywordsPlaceholder),
      "guide{enter}",
    );
    await withoutConfirmation(user);
  }

  /** The message of the one `send_dm` the editor writes. */
  function messageOf(definition: UnifiedAutomation): Record<string, unknown> {
    const step = definition.steps?.find((entry) => entry.action === "send_dm");

    return ((step as { message?: Record<string, unknown> } | undefined)
      ?.message ?? {}) as Record<string, unknown>;
  }

  /** One button's own block, so two buttons never answer for each other. */
  function buttonBlock(number: number): HTMLElement {
    const label = screen.getByLabelText(`Button ${number} text`);
    const block = label.closest(".mc-button-editor");

    expect(block).not.toBeNull();

    return block as HTMLElement;
  }

  /** Presses one of the two destination labels of a given button. */
  async function chooseDestination(
    user: ReturnType<typeof userEvent.setup>,
    number: number,
    label: string,
  ): Promise<void> {
    await user.click(
      within(buttonBlock(number)).getByRole("radio", { name: label }),
    );
  }

  /** Chooses a file for a button, through the catalogue the control opens. */
  async function pickButtonFile(
    user: ReturnType<typeof userEvent.setup>,
    fileName: string,
    number = 1,
  ): Promise<void> {
    await user.click(
      await screen.findByLabelText(resolve(copy.buttonAsset, { number })),
    );
    await user.click(
      await screen.findByRole("button", {
        name: en.screens.assets.use.replace("{{name}}", fileName),
      }),
    );
  }

  it("offers exactly the two labels the requirement names", async () => {
    const user = userEvent.setup();
    render(
      <AutomationFormScreen
        client={client()}
        assets={assets}
        finder={finder()}
      />,
    );
    await user.click(screen.getByRole("button", { name: copy.addButton }));

    const choices = within(buttonBlock(1)).getAllByRole("radio");

    // The two, and nothing beside them: a third destination would be a third
    // branch the format's union does not have.
    expect(
      choices.map((choice) => choice.closest("label")?.textContent),
    ).toEqual([copy.buttonDestinationLink, copy.buttonDestinationFile]);

    // And the two are the WORDS the requirement quotes, held in both
    // catalogues: this is the one place where the sentence itself is the
    // requirement, so a rewording is a regression rather than a translation.
    expect(copy.buttonDestinationLink).toBe("Link");
    expect(copy.buttonDestinationFile).toBe("PDF or image");
    expect(ptBR.screens.automations.buttonDestinationLink).toBe("Link");
    expect(ptBR.screens.automations.buttonDestinationFile).toBe(
      "PDF ou Imagem",
    );
  });

  it("opens on the address, which is the form that needs no upload", async () => {
    const user = userEvent.setup();
    render(
      <AutomationFormScreen
        client={client()}
        assets={assets}
        finder={finder()}
      />,
    );
    await user.click(screen.getByRole("button", { name: copy.addButton }));

    expect(
      within(buttonBlock(1)).getByRole("radio", {
        name: copy.buttonDestinationLink,
      }),
    ).toBeChecked();
    expect(screen.getByLabelText("Button 1 address")).toBeInTheDocument();
    expect(
      screen.queryByLabelText(resolve(copy.buttonAsset, { number: 1 })),
    ).toBeNull();
  });

  /**
   * The handoff of task 3n.2, and the one that BREAKS activation if it is
   * ignored.
   *
   * The editor used to write `url` into every button it saved. With the format
   * refusing "an address and a file" by shape, a correctly filled file button
   * would then be refused at activation over a field the operator never
   * touched. Deep equality and never `toMatchObject`, deliberately: the fault
   * is an EXTRA key, and a partial match is blind to exactly that.
   */
  it("writes ONLY the chosen destination, so a file button can be activated", async () => {
    const save = vi.fn();
    const user = userEvent.setup();
    render(
      <AutomationFormScreen
        client={client(save)}
        assets={assets}
        finder={finder()}
      />,
    );
    await ready(user);
    await user.click(screen.getByRole("button", { name: copy.addButton }));
    await user.type(screen.getByLabelText("Button 1 text"), "Download");
    await chooseDestination(user, 1, copy.buttonDestinationFile);
    await pickButtonFile(user, "guide.pdf");
    await user.click(screen.getByRole("button", { name: copy.activate }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));

    const definition = save.mock.calls[0]?.[0] as UnifiedAutomation;

    expect(definition.state).toBe("active");
    expect(messageOf(definition)["buttons"]).toEqual([
      { id: "button-1", label: "Download", asset: "guide.pdf" },
    ]);
  });

  it("writes only the address when the address is the choice, after a file was touched", async () => {
    const save = vi.fn();
    const user = userEvent.setup();
    render(
      <AutomationFormScreen
        client={client(save)}
        assets={assets}
        finder={finder()}
      />,
    );
    await ready(user);
    await user.click(screen.getByRole("button", { name: copy.addButton }));
    await user.type(screen.getByLabelText("Button 1 text"), "Download");
    // Chosen, filled in, and then abandoned: the value stays in the editor so
    // that changing one's mind twice costs nothing, and never reaches the
    // aggregate.
    await chooseDestination(user, 1, copy.buttonDestinationFile);
    await pickButtonFile(user, "guide.pdf");
    await chooseDestination(user, 1, copy.buttonDestinationLink);
    await user.type(
      screen.getByLabelText("Button 1 address"),
      "https://example.com/guide",
    );
    await user.click(screen.getByRole("button", { name: copy.activate }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));

    expect(
      messageOf(save.mock.calls[0]?.[0] as UnifiedAutomation)["buttons"],
    ).toEqual([
      { id: "button-1", label: "Download", url: "https://example.com/guide" },
    ]);
  });

  it("keeps what was typed on the other form, so changing one's mind costs nothing", async () => {
    const user = userEvent.setup();
    render(
      <AutomationFormScreen
        client={client()}
        assets={assets}
        finder={finder()}
      />,
    );
    await user.click(screen.getByRole("button", { name: copy.addButton }));
    await user.type(
      screen.getByLabelText("Button 1 address"),
      "https://example.com/guide",
    );
    await chooseDestination(user, 1, copy.buttonDestinationFile);
    await chooseDestination(user, 1, copy.buttonDestinationLink);

    expect(screen.getByLabelText("Button 1 address")).toHaveValue(
      "https://example.com/guide",
    );
  });

  /**
   * A DRAFT may hold the chosen destination empty, and may not hold the other.
   *
   * An empty string is a destination ASKED FOR and not yet chosen, exactly as
   * the cover's is, and it is also the record of WHICH label was pressed. The
   * abandoned field is a second declaration, which is the one combination the
   * draft shape refuses by name.
   */
  it("stores a draft with the chosen destination empty, and the other absent", async () => {
    const save = vi.fn();
    const user = userEvent.setup();
    render(
      <AutomationFormScreen
        client={client(save)}
        assets={assets}
        finder={finder()}
      />,
    );
    await user.click(screen.getByRole("button", { name: copy.addButton }));
    await chooseDestination(user, 1, copy.buttonDestinationFile);
    await user.click(screen.getByRole("button", { name: copy.saveDraft }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));

    const definition = save.mock.calls[0]?.[0] as UnifiedAutomation;

    expect(messageOf(definition)["buttons"]).toEqual([
      { id: "button-1", label: "", asset: "" },
    ]);
    // And it really is a draft the contract accepts, half written and all.
    expect(draftAutomationSchema.safeParse(definition).success).toBe(true);
  });

  it("reads a stored file button back onto its own choice, with the file", async () => {
    const api = client();
    api.read = vi.fn(async () => stored(STORED_PARTS));
    openAt("?id=comment-2026-08-14t12-00-00-000z");
    render(
      <AutomationFormScreen client={api} assets={assets} finder={finder()} />,
    );

    expect(await screen.findByLabelText("Button 1 text")).toHaveValue("Zebra");
    // The choice survives the round trip because it is what was WRITTEN down,
    // and not something inferred from the shape of an address.
    expect(
      within(buttonBlock(1)).getByRole("radio", {
        name: copy.buttonDestinationFile,
      }),
    ).toBeChecked();
    expect(
      within(buttonBlock(2)).getByRole("radio", {
        name: copy.buttonDestinationLink,
      }),
    ).toBeChecked();
    expect(screen.getByLabelText("Button 2 address")).toHaveValue(
      "https://example.com/album",
    );
  });

  /**
   * The state an operator really leaves behind: they pressed "PDF or image",
   * saved, and went away before choosing a file.
   *
   * The empty string is the whole record of that choice, and reopening has to
   * read it back as one: read as an address instead, the operator would return
   * to a form they did not pick and the file they were about to choose would
   * have nowhere to go.
   */
  it("reopens a DRAFT on the destination that was chosen and left empty", async () => {
    const api = client();
    api.read = vi.fn(async () =>
      stored({
        schema_version: 2,
        kind: "automation",
        id: "comment-2026-08-14t12-00-00-000z",
        state: "draft",
        trigger: {
          type: "comment",
          target: IMAGE_ID,
          match: { keywords: ["guide"], mode: "contains" },
        },
        steps: [
          {
            id: "private-message",
            action: "send_dm",
            message: { buttons: [{ id: "button-1", label: "", asset: "" }] },
          },
        ],
      } as UnifiedAutomation),
    );
    openAt("?id=comment-2026-08-14t12-00-00-000z");
    render(
      <AutomationFormScreen client={api} assets={assets} finder={finder()} />,
    );
    await screen.findByLabelText("Button 1 text");

    expect(
      within(buttonBlock(1)).getByRole("radio", {
        name: copy.buttonDestinationFile,
      }),
    ).toBeChecked();
    expect(screen.queryByLabelText("Button 1 address")).toBeNull();
    expect(
      screen.getByLabelText(resolve(copy.buttonAsset, { number: 1 })),
    ).toBeInTheDocument();
  });

  /**
   * The label promises a document AND a picture, so the catalogue behind it has
   * to offer both.
   *
   * The cover's control narrows to images and the retired attachment's narrowed
   * to documents; this one narrows to nothing, which is the only reading of
   * "PDF or image" that is not a lie.
   */
  it("offers a document and a picture behind the file destination", async () => {
    const user = userEvent.setup();
    render(
      <AutomationFormScreen
        client={client()}
        assets={assets}
        finder={finder()}
      />,
    );
    await user.click(screen.getByRole("button", { name: copy.addButton }));
    await chooseDestination(user, 1, copy.buttonDestinationFile);
    await user.click(
      await screen.findByLabelText(resolve(copy.buttonAsset, { number: 1 })),
    );

    for (const name of ["guide.pdf", "cover.png"])
      expect(
        await screen.findByRole("button", {
          name: en.screens.assets.use.replace("{{name}}", name),
        }),
      ).toBeInTheDocument();
  });

  it("refuses activation over a file destination nobody chose, at that control", async () => {
    const save = vi.fn();
    const user = userEvent.setup();
    render(
      <AutomationFormScreen
        client={client(save)}
        assets={assets}
        finder={finder()}
      />,
    );
    await ready(user);
    await user.click(screen.getByRole("button", { name: copy.addButton }));
    await user.type(screen.getByLabelText("Button 1 text"), "Download");
    await chooseDestination(user, 1, copy.buttonDestinationFile);
    await user.click(screen.getByRole("button", { name: copy.activate }));

    expect(save).not.toHaveBeenCalled();
    expect(
      await screen.findByLabelText(resolve(copy.buttonAsset, { number: 1 })),
    ).toHaveFocus();
  });
});

/**
 * The other form, and the whole reason the format grew a second list (REQ-286,
 * REQ-288).
 *
 * A pure link is an address that travels ALONE, so the destination site draws
 * its own preview: that is what a button cannot do, and until phase 3n the
 * editor offered only the button and called it a link. What the cases below
 * hold is the separation (a link makes no card), the ORDER (the list is the
 * order the messages land) and the arithmetic (a delivery of links alone is a
 * whole delivery).
 */
describe("REQ-286/REQ-288: a pure link is a message of its own", () => {
  beforeEach(() => openOnPublication());

  async function ready(
    user: ReturnType<typeof userEvent.setup>,
  ): Promise<void> {
    await user.type(
      screen.getByPlaceholderText(copy.keywordsPlaceholder),
      "guide{enter}",
    );
    await withoutConfirmation(user);
  }

  function messageOf(definition: UnifiedAutomation): Record<string, unknown> {
    const step = definition.steps?.find((entry) => entry.action === "send_dm");

    return ((step as { message?: Record<string, unknown> } | undefined)
      ?.message ?? {}) as Record<string, unknown>;
  }

  it("adds a link without turning the message into a card", async () => {
    const save = vi.fn();
    const user = userEvent.setup();
    render(
      <AutomationFormScreen
        client={client(save)}
        assets={assets}
        finder={finder()}
      />,
    );
    await ready(user);
    await user.type(screen.getByLabelText(copy.messageBody), "Here it is");
    await user.click(screen.getByRole("button", { name: copy.addLink }));
    await user.type(
      screen.getByLabelText("Link 1 address"),
      "https://example.com/watch",
    );

    // The written message is still a message: it was the BUTTON that turned it
    // into a heading, and a link is the other form entirely.
    expect(screen.getByLabelText(copy.messageBody)).toHaveValue("Here it is");
    expect(screen.queryByRole("group", { name: copy.cardBlock })).toBeNull();

    await user.click(screen.getByRole("button", { name: copy.activate }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));

    const message = messageOf(save.mock.calls[0]?.[0] as UnifiedAutomation);

    expect(message["links"]).toEqual(["https://example.com/watch"]);
    expect(message["text"]).toBe("Here it is");
    expect(message["buttons"]).toBeUndefined();
  });

  it("activates a delivery that is nothing but links", async () => {
    const save = vi.fn();
    const user = userEvent.setup();
    render(
      <AutomationFormScreen
        client={client(save)}
        assets={assets}
        finder={finder()}
      />,
    );
    await ready(user);
    await user.click(screen.getByRole("button", { name: copy.addLink }));
    await user.type(
      screen.getByLabelText("Link 1 address"),
      "https://example.com/watch",
    );
    await user.click(screen.getByRole("button", { name: copy.activate }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));

    // One message, and it is the link: counting a text that nobody wrote would
    // make the editor ask for one the contract does not want.
    expect(messageOf(save.mock.calls[0]?.[0] as UnifiedAutomation)).toEqual({
      links: ["https://example.com/watch"],
    });
  });

  it("refuses activation over a link row nobody typed into, at that row", async () => {
    const save = vi.fn();
    const user = userEvent.setup();
    render(
      <AutomationFormScreen
        client={client(save)}
        assets={assets}
        finder={finder()}
      />,
    );
    await ready(user);
    await user.type(screen.getByLabelText(copy.messageBody), "Here it is");
    await user.click(screen.getByRole("button", { name: copy.addLink }));
    await user.click(screen.getByRole("button", { name: copy.activate }));

    expect(save).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Link 1 address")).toHaveFocus();
  });

  /**
   * The ORDER, held against a fixture that is deliberately out of every other
   * order (`STORED_PARTS`).
   *
   * Both halves: the card is drawn before the links because that is when it
   * lands, and both lists are written back in the sequence they were declared
   * in. A fixture that happened to be sorted would let a screen that sorts pass
   * this, which is the mistake task 3n.1 caught in itself.
   */
  it("keeps the parts in the order they land, in the drawing and in the save", async () => {
    const save = vi.fn();
    const api = client(save);
    api.read = vi.fn(async () => stored(STORED_PARTS));
    openAt("?id=comment-2026-08-14t12-00-00-000z");
    render(
      <AutomationFormScreen client={api} assets={assets} finder={finder()} />,
    );
    await screen.findByLabelText("Button 1 text");

    const parts = document.querySelector(".mc-parts");

    expect(parts).not.toBeNull();

    const blocks = [...(parts?.children ?? [])];

    // The card first, the links after it, because that is the order they land.
    expect(blocks).toHaveLength(2);
    expect(blocks[0]?.textContent).toContain(copy.cardBlock);
    expect(blocks[1]?.textContent).toContain(copy.linksBlock);
    expect(screen.getByLabelText("Link 1 address")).toHaveValue(
      "https://zeta.example/watch",
    );
    expect(screen.getByLabelText("Link 2 address")).toHaveValue(
      "https://alpha.example/read",
    );

    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: copy.activate }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));

    const message = messageOf(save.mock.calls[0]?.[0] as UnifiedAutomation);

    expect(message["links"]).toEqual([
      "https://zeta.example/watch",
      "https://alpha.example/read",
    ]);
    expect(
      (message["buttons"] as readonly { label: string }[]).map(
        (button) => button.label,
      ),
    ).toEqual(["Zebra", "Album"]);
  });

  it("names every message of the delivery, in the order they land", async () => {
    const user = userEvent.setup();
    render(
      <AutomationFormScreen
        client={client()}
        assets={assets}
        finder={finder()}
      />,
    );
    await user.type(screen.getByLabelText(copy.messageBody), "Here it is");
    await user.click(screen.getByRole("button", { name: copy.addLink }));
    await user.type(
      screen.getByLabelText("Link 1 address"),
      "https://example.com/watch",
    );
    await user.click(screen.getByRole("button", { name: copy.addLink }));
    await user.type(
      screen.getByLabelText("Link 2 address"),
      "https://example.com/read",
    );

    expect(
      within(
        screen.getByRole("region", { name: copy.privateMessageTitle }),
      ).getByText(
        shape(
          copy.deliveryPartMessage,
          resolve(copy.deliveryPartLinkNumbered, { number: 1 }),
          resolve(copy.deliveryPartLinkNumbered, { number: 2 }),
        ),
      ),
    ).toBeInTheDocument();
  });

  it("draws each link as a message of its own, after the written one", async () => {
    const user = userEvent.setup();
    render(
      <AutomationFormScreen
        client={client()}
        assets={assets}
        finder={finder()}
      />,
    );
    await user.type(screen.getByLabelText(copy.messageBody), "Here it is");
    await user.click(screen.getByRole("button", { name: copy.addLink }));
    await user.type(
      screen.getByLabelText("Link 1 address"),
      "https://example.com/watch",
    );

    const drawn = within(screen.getByRole("list", { name: CONVERSATION }))
      .getAllByRole("listitem")
      .map((item) => item.textContent ?? "");

    expect(drawn.findIndex((line) => line.includes("Here it is"))).toBeLessThan(
      drawn.findIndex((line) => line.includes("https://example.com/watch")),
    );
    // The preview the DESTINATION site will draw, which is the whole advantage
    // of a link over a button and the reason it travels alone.
    expect(
      screen.getByText(
        resolve(copy.previewLinkThumbnail, { host: "example.com" }),
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        resolve(copy.previewMessageCount, { number: 2, total: 2 }),
      ),
    ).toBeInTheDocument();
  });

  /**
   * The blank row, which is the boundary the SHARED reader exists for
   * (REQ-319).
   *
   * `declaredLinks` lives once, in the listing, and the editor imports it. Both
   * screens promise a delivery, so both have to drop an address nobody has
   * typed yet: a bubble drawn for an empty address, or a part named in the
   * sentence, is a message the contact would never receive. The listing holds
   * its own half of this; without this case the editor's half rode on a reader
   * only the other screen bit.
   */
  it("draws nothing and names nothing for a link row nobody has typed into", async () => {
    const user = userEvent.setup();
    render(
      <AutomationFormScreen
        client={client()}
        assets={assets}
        finder={finder()}
      />,
    );
    await user.type(screen.getByLabelText(copy.messageBody), "Here it is");

    const drawn = conversation();

    await user.click(screen.getByRole("button", { name: copy.addLink }));
    await screen.findByLabelText("Link 1 address");

    // Held against the conversation BEFORE the row was added, so the case says
    // "nothing changed" instead of counting bubbles a future part could move.
    expect(conversation()).toEqual(drawn);
    // And the sentence under the section names the written message alone: with
    // one part there is no numbering either, which a named link would bring.
    expect(
      within(
        screen.getByRole("region", { name: copy.privateMessageTitle }),
      ).getByText(shape(copy.deliveryPartMessage)),
    ).toBeInTheDocument();
  });

  it("stops offering a link at the ceiling the product accepts", async () => {
    const user = userEvent.setup();
    render(
      <AutomationFormScreen
        client={client()}
        assets={assets}
        finder={finder()}
      />,
    );

    for (let index = 0; index < PURE_LINK_LIMIT; index += 1)
      await user.click(screen.getByRole("button", { name: copy.addLink }));

    expect(screen.getByRole("button", { name: copy.addLink })).toBeDisabled();
    // A different ceiling from the card's, because they count different things:
    // three buttons is one card element, three links is three more messages.
    expect(screen.getByRole("button", { name: copy.addButton })).toBeEnabled();
  });
});

/**
 * The preview, which is the part of the editor that teaches with no explanation
 * at all (REQ-225, REQ-229, REQ-233).
 *
 * What it has to be right about is the ORDER: the platform refuses a link in
 * the first message, so what opens the conversation goes out BEFORE the
 * delivery, and an operator who cannot see that on screen writes the automation
 * that never arrives. The cases below read the drawn conversation as a list of
 * messages and hold it against that order, against the draft it is drawn from,
 * and against the one thing it must never become: a second copy of the editor
 * that a screen reader can walk into and operate.
 */
const CONVERSATION = copy.previewConversation;

/** The preview panel, found by its own heading rather than by a class. */
function previewPanel(): HTMLElement {
  const heading = screen.getByRole("heading", { name: copy.previewTitle });

  expect(heading.parentElement).not.toBeNull();

  return heading.parentElement as HTMLElement;
}

/** The conversation as it is drawn: one entry per message, in order. */
function conversation(): readonly string[] {
  return within(screen.getByRole("list", { name: CONVERSATION }))
    .getAllByRole("listitem")
    .map((item) => item.textContent ?? "");
}

/** Where a message sits in the thread, by something written in it. */
function messageAt(words: string): number {
  return conversation().findIndex((line) => line.includes(words));
}

/**
 * The sentence that replaced the count, and the count's absence (REQ-283).
 *
 * Two halves, and the second is the one a "the new text is there" test would
 * miss: naming the messages is worth nothing if the number goes on being shown
 * beside them, because the operator then reads two answers to the same question
 * and the section is louder rather than clearer.
 */
describe("REQ-283: the message section says the FORM of the delivery", () => {
  /** The section that COMPOSES the delivery, which is where the sentence sits. */
  function section(): HTMLElement {
    return screen.getByRole("region", { name: copy.privateMessageTitle });
  }

  it("asks for a message while there is nothing to send", () => {
    render(<AutomationFormScreen client={client()} assets={assets} />);

    // Naming "your message" over an empty field would name a message that
    // carries nothing, which is the one shape the delivery cannot have.
    expect(
      within(section()).getByText(copy.deliveryShapeEmpty),
    ).toBeInTheDocument();
  });

  it("names the one message a plain text goes out as", async () => {
    const user = userEvent.setup();
    render(<AutomationFormScreen client={client()} assets={assets} />);
    await withoutConfirmation(user);
    await user.type(screen.getByLabelText(copy.messageBody), "here it is");

    expect(
      within(section()).getByText(shape(copy.deliveryPartMessage)),
    ).toBeInTheDocument();
  });

  /*
   * The ORDER of SEVERAL messages, which is the other half of REQ-283, has no
   * case here for the moment. The editor's only multi-message delivery was a
   * text with a file behind it, and the attachment left the format (REQ-284):
   * every delivery this editor can assemble today is one message. The pure
   * link is what makes a delivery several again (REQ-286, REQ-288), and the
   * sentence naming them in order belongs with the control that declares one,
   * in task 3n.5.
   */

  it("names the card by the buttons it carries", async () => {
    const user = userEvent.setup();
    render(<AutomationFormScreen client={client()} assets={assets} />);
    await withoutConfirmation(user);
    await user.type(screen.getByLabelText(copy.messageBody), "here it is");

    const add = screen.getByRole("button", { name: copy.addButton });
    await user.click(add);

    // A link makes the whole message a card (REQ-230), and the sentence follows
    // the thing that goes out rather than the field that was typed into.
    expect(
      within(section()).getByText(
        shape(
          catalogue.t("screens.automations.deliveryPartCard", { count: 1 }),
        ),
      ),
    ).toBeInTheDocument();

    await user.click(add);

    expect(
      within(section()).getByText(
        shape(
          catalogue.t("screens.automations.deliveryPartCard", { count: 2 }),
        ),
      ),
    ).toBeInTheDocument();
  });

  it("shows no message count, on this screen or in any catalogue", async () => {
    const user = userEvent.setup();
    render(<AutomationFormScreen client={client()} assets={assets} />);
    await withoutConfirmation(user);
    await user.type(screen.getByLabelText(copy.messageBody), "here it is");

    // The preview holds a title, the handset and the legend, and no sentence
    // over the drawing counting what it draws: the count did not move, it left.
    const preview = screen.getByRole("complementary", {
      name: copy.previewTitle,
    });

    expect(preview.querySelector(".mc-automation-preview__count")).toBeNull();
    expect(
      [...preview.querySelectorAll(":scope > p")].map(
        (line) => line.textContent,
      ),
    ).toEqual([copy.previewLegend]);

    // And it is gone from the catalogues too, in both languages: a sentence
    // left behind is a sentence another screen can start showing again, and the
    // Portuguese one carried a defect of its own ("2 de mensagens privadas").
    for (const [locale, loaded] of [
      ["en", en],
      ["pt-BR", ptBR],
    ] as const) {
      expect(
        Object.keys(loaded.screens.automations).filter((key) =>
          key.startsWith("previewCount"),
        ),
        `locale ${locale}`,
      ).toEqual([]);
    }
  });
});

describe("REQ-225/REQ-229/REQ-233: the preview is the conversation, in order", () => {
  it("REQ-271: draws the private conversation only, and refuses a fourth button", async () => {
    const user = userEvent.setup();
    render(<AutomationFormScreen client={client()} assets={assets} />);

    await user.type(
      screen.getByPlaceholderText(copy.keywordsPlaceholder),
      "ebook{enter}",
    );
    await user.click(screen.getByLabelText(copy.publicReplyToggle));
    await user.type(
      screen.getByLabelText(copy.publicReplyText),
      "Reply here{enter}",
    );
    await withoutConfirmation(user);
    await user.type(screen.getByLabelText(copy.messageBody), "here is the pdf");

    // The private thread and only it (REQ-271): the comment and the public
    // reply happen on the publication, which has no preview, so the delivery is
    // the whole conversation a comment automation with no question draws.
    expect(messageAt("ebook")).toBe(-1);
    expect(messageAt("Reply here")).toBe(-1);
    expect(messageAt("here is the pdf")).toBe(0);
    expect(conversation()).toHaveLength(1);

    // Who says it, in words and never in colour alone.
    expect(conversation()[0]).toContain(copy.previewWhoYou);

    // Three links, and the fourth refused by the interface itself: the control
    // is disabled at the ceiling rather than answering with an error after the
    // fact (REQ-219).
    const add = screen.getByRole("button", { name: copy.addButton });
    await user.click(add);
    await user.click(add);
    await user.click(add);
    expect(add).toBeDisabled();
    expect(screen.getAllByLabelText(/Button \d text/)).toHaveLength(3);
  });

  it("REQ-066: turning the opening on puts the questions BEFORE the delivery, and the delivery stays last", async () => {
    const user = userEvent.setup();
    render(<AutomationFormScreen client={client()} assets={assets} />);

    await user.type(
      screen.getByPlaceholderText(copy.keywordsPlaceholder),
      "ebook{enter}",
    );
    await user.type(screen.getByLabelText(copy.messageBody), "here is the pdf");
    await withoutConfirmation(user);

    // Shut, the delivery is the whole thread: the comment that earned it
    // happened on the publication, which has no preview (REQ-271). This is the
    // state the insertion below is measured against, and it is reached by
    // shutting the confirmation a new automation is born asking (REQ-273).
    expect(conversation()).toHaveLength(1);
    expect(messageAt("here is the pdf")).toBe(0);

    // Turned on in the REVERSE of the order they go out in, so what is drawn is
    // the order the conversation has and not the order the switches were
    // pressed in.
    await user.click(
      screen.getByRole("checkbox", { name: copy.openingFollow }),
    );
    await user.type(screen.getByLabelText(copy.followQuestion), "follow me?");
    await user.click(screen.getByRole("checkbox", { name: copy.openingEmail }));
    await user.type(screen.getByLabelText(copy.emailQuestion), "your email?");
    await user.click(
      screen.getByRole("checkbox", { name: copy.openingConfirmation }),
    );
    await user.clear(screen.getByLabelText(copy.confirmationQuestion));
    await user.type(
      screen.getByLabelText(copy.confirmationQuestion),
      "may I send it?",
    );
    await user.type(screen.getByLabelText(copy.confirmationQuickReply), "Yes");

    const drawn = conversation();

    // Confirmation, then the e-mail, then the follow — each one answered before
    // the next is asked — and the delivery LAST. That last fact is the whole
    // reason the section exists: a delivery drawn before these three is the
    // message the platform never sends.
    expect(messageAt("may I send it?")).toBe(0);
    expect(messageAt("your email?")).toBe(2);
    expect(messageAt("follow me?")).toBe(4);
    expect(messageAt("here is the pdf")).toBe(drawn.length - 1);
    expect(messageAt("may I send it?")).toBeLessThan(
      messageAt("here is the pdf"),
    );

    // The person answers, which is what the delivery is waiting for. The button
    // that was declared is the answer it gets; the other two are answered in
    // words, so the operator sees the shape of the exchange and not a monologue.
    expect(drawn[1]).toContain(copy.previewWhoContact);
    expect(drawn[1]).toContain("Yes");
    expect(drawn[3]).toContain(copy.previewAnswerEmail);
    expect(drawn[5]).toContain(copy.previewAnswerFollowed);

    // And the sentence under the message section is about the DELIVERY, which
    // is the change of subject REQ-283 asks for: four bubbles are the operator's
    // here, three of them questions asked by a section of its own, and what this
    // section composed is one message.
    expect(
      drawn.filter((line) => line.includes(copy.previewWhoYou)),
    ).toHaveLength(4);
    expect(
      screen.getByText(shape(copy.deliveryPartMessage)),
    ).toBeInTheDocument();
  });

  it("REQ-233: reacts to the editing, character by character", async () => {
    const user = userEvent.setup();
    render(<AutomationFormScreen client={client()} assets={assets} />);
    await withoutConfirmation(user);

    // Nothing written yet: the delivery says where the words will appear rather
    // than drawing an empty bubble.
    expect(messageAt(copy.previewMessage)).toBe(0);

    await user.type(screen.getByLabelText(copy.messageBody), "here it is");

    expect(messageAt("here it is")).toBe(0);
    expect(messageAt(copy.previewMessage)).toBe(-1);

    // The confirmation appears the moment it is turned on, asking with the
    // sentence the catalogue carries until somebody writes another (REQ-273).
    await user.click(
      screen.getByRole("checkbox", { name: copy.openingConfirmation }),
    );
    expect(messageAt(copy.confirmationQuestionDefault)).toBe(0);

    // Emptied, it stands in for the wording rather than drawing a blank
    // bubble: what is on screen is what would be sent, either way.
    await user.clear(screen.getByLabelText(copy.confirmationQuestion));
    expect(messageAt(copy.previewConfirmationAsk)).toBe(0);

    // And it follows what is typed into it, with no save in between.
    await user.type(
      screen.getByLabelText(copy.confirmationQuestion),
      "may I send",
    );
    expect(messageAt("may I send")).toBe(0);

    await user.type(screen.getByLabelText(copy.confirmationQuestion), " it?");
    expect(messageAt("may I send it?")).toBe(0);
  });

  it("REQ-233: draws the card as it goes out, and operates nothing", async () => {
    const user = userEvent.setup();
    render(<AutomationFormScreen client={client()} assets={assets} />);

    // Already asking, since a new automation is born with the request on
    // (REQ-273): what is written here is the wording, not the decision.
    await user.clear(screen.getByLabelText(copy.confirmationQuestion));
    await user.type(
      screen.getByLabelText(copy.confirmationQuestion),
      "may I send it?",
    );
    await user.type(screen.getByLabelText(copy.confirmationQuickReply), "Yes");
    await user.click(screen.getByRole("button", { name: copy.addButton }));
    await user.type(screen.getByLabelText("Button 1 text"), "Download");
    await user.type(
      screen.getByLabelText("Button 1 address"),
      "https://example.com/guide",
    );
    await user.click(screen.getByRole("button", { name: copy.addCover }));
    await pickCover(user);
    await user.type(screen.getByLabelText(/Title/), "Your guide");

    const panel = previewPanel();

    // The card, whole: the picture, the heading and the button the CONTACT
    // will press.
    expect(
      within(panel).getByRole("img", { name: "cover.png" }),
    ).toHaveAttribute("src", "/assets/cover.png");
    expect(messageAt("Your guide")).toBe(messageAt("Download"));

    // And none of it is a control. The preview DESCRIBES: a button drawn here
    // is a picture of a button, and a preview that could be tabbed into would
    // be a second editor that does nothing — the trap this must never become.
    expect(within(panel).queryAllByRole("button")).toEqual([]);
    expect(within(panel).queryAllByRole("link")).toEqual([]);
    expect(within(panel).queryAllByRole("textbox")).toEqual([]);
    expect(
      panel.querySelectorAll(
        "a, button, input, select, textarea, [tabindex], [contenteditable]",
      ),
    ).toHaveLength(0);

    // It is still ANNOUNCED: informative content with a name of its own, which
    // is what lets someone listening ask for the conversation and be read it.
    expect(
      screen.getByRole("list", { name: CONVERSATION }),
    ).toBeInTheDocument();
  });
});

/* ------------------------------------------------------------------ *
 * REQ-225: the narrow viewport, where the preview goes last
 * ------------------------------------------------------------------ */

/**
 * The stylesheet, as text.
 *
 * Criterion 18 of the phase is marked `[human]` because jsdom applies no CSS:
 * nothing here can measure that the preview stops covering the editor on a
 * phone. What CAN be decided without a browser is guarded, and it is the half
 * that rots — the rule being in the sheet at all, and the document order that
 * decides what "afterwards" means. The remaining half is a pair of eyes on a
 * real viewport.
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
 * The one narrow-screen rule that changes the editor and its preview together.
 *
 * `components.css` has other 48rem breakpoints. Find this rule by the selectors
 * it owns instead of relying on this rule happening to be the first one.
 */
function mediaBlockWithSelectors(
  source: string,
  media: string,
  selectors: readonly string[],
): string {
  let offset = 0;

  while (offset < source.length) {
    const at = source.indexOf(media, offset);
    if (at < 0) {
      break;
    }

    const body = blockAfter(source.slice(at), media);
    if (selectors.every((selector) => body.includes(selector))) {
      return body;
    }

    offset = at + media.length;
  }

  throw new Error(
    `Could not find ${media} containing ${selectors.join(" and ")}.`,
  );
}

describe("REQ-225: on a narrow viewport the preview comes after the editor", () => {
  it("collapses the editor to one column and unpins the preview", () => {
    // A sweep that read an empty module would pass every assertion below
    // forever: vitest replaces a stylesheet with nothing unless `css` is on.
    expect(COMPONENT_SHEET.length).toBeGreaterThan(0);
    expect(COMPONENT_SHEET).toContain("@media (max-width: 48rem)");

    const narrow = mediaBlockWithSelectors(
      COMPONENT_SHEET,
      "@media (max-width: 48rem)",
      [".mc-automation-editor", ".mc-automation-preview"],
    );

    // One column, so the preview falls below the sections instead of beside
    // them; and static, so it stops standing over the field being typed into.
    expect(blockAfter(narrow, ".mc-automation-editor")).toContain(
      "grid-template-columns: minmax(0, 1fr);",
    );
    expect(blockAfter(narrow, ".mc-automation-preview")).toContain(
      "position: static;",
    );
  });

  it("puts the preview after the last section in the document", () => {
    render(<AutomationFormScreen client={client()} assets={assets} />);

    // What "afterwards" means in one column is the DOM order, and that is a
    // fact jsdom can decide. The last section of the editor is the anchor: a
    // preview written before it would collapse ON TOP of the sections.
    const rules = screen.getByRole("region", {
      name: copy.optionalRulesTitle,
    });
    const panel = previewPanel();

    expect(
      rules.compareDocumentPosition(panel) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });
});

/**
 * REQ-233: the drawing, guarded where a drawing can be guarded.
 *
 * jsdom applies no stylesheet, so nothing here proves that the preview LOOKS
 * like a handset. What it proves is that the three declarations the drawing
 * stands on are still in the sheet, and that the markup still carries the
 * classes those declarations are written for. That pair is what rots: a
 * refactor renames an element, the rule keeps matching nothing, and the screen
 * quietly goes back to being a rectangle with boxes in it — which is exactly
 * how this task came to exist.
 *
 * The three, and what each one is holding up:
 *
 *   - the BEZEL. A thick border and a radius that belongs to a device are the
 *     whole difference between a phone and a panel. Take the border out and the
 *     conversation is a column of paragraphs again;
 *   - the STEP THAT IS ON. `:has(input:checked)` is what makes a question that
 *     will really be asked look different from the two that will not, with no
 *     second copy of that state in the markup;
 *   - the CARD BLOCK. The accent frame is what says the block is the message
 *     and not a setting, before its heading is read.
 */
describe("REQ-233: the preview is a handset, and the blocks say what they are", () => {
  it("keeps the bezel, the lit step and the card block in the sheet", () => {
    // A sweep that read an empty module would pass every assertion below
    // forever: vitest replaces a stylesheet with nothing unless `css` is on.
    expect(COMPONENT_SHEET.length).toBeGreaterThan(0);

    // The handset: a border thick enough to be a body, and the one radius in
    // the product that is not a card's.
    const phone = blockAfter(COMPONENT_SHEET, ".mc-phone {");

    // Fixed since REQ-298: the bezel is the phone's body and not our ink, so
    // it no longer follows the theme the operator happens to be reading in.
    expect(phone).toContain("border: 0.5rem solid var(--direct-bezel);");
    expect(phone).toContain("border-radius: var(--radius-device);");

    // The step that is on, lit from the checkbox it already contains.
    expect(COMPONENT_SHEET).toContain(".mc-opening-step:has(input:checked)");

    const lit = blockAfter(
      COMPONENT_SHEET,
      ".mc-opening-step:has(input:checked)",
    );

    expect(lit).toContain("border-color: var(--accent);");
    expect(lit).toContain("background: var(--accent-soft);");

    // And the card block, framed as the message it is.
    const card = blockAfter(COMPONENT_SHEET, ".mc-card-editor--card");

    expect(card).toContain("border-color: var(--accent);");
    expect(card).toContain("background: var(--accent-soft);");
  });

  it("draws the handset's own furniture, and hides it from the reader", () => {
    render(<AutomationFormScreen client={client()} assets={assets} />);

    const panel = previewPanel();
    const bar = panel.querySelector(".mc-phone__bar");

    // The status bar is what the bezel frames. It says nothing anyone needs to
    // hear, so it is hidden rather than described.
    expect(bar).not.toBeNull();
    expect(bar?.getAttribute("aria-hidden")).toBe("true");
    expect(panel.querySelector(".mc-phone__signal")).not.toBeNull();
    expect(bar?.textContent).toContain(copy.previewClock);
  });

  it("puts the class the lit rule needs on the step that is on", async () => {
    const user = userEvent.setup();
    const { container } = render(
      <AutomationFormScreen client={client()} assets={assets} />,
    );

    // The rule reaches the block through the checkbox inside it, so what the
    // markup owes it is the block and the control in the same element. Counted
    // per SECTION, because the same block draws the two word gates of the
    // trigger since REQ-265, and one of those is on from the first render.
    const opening = screen.getByRole("region", { name: copy.openingTitle });
    const steps = opening.querySelectorAll(".mc-opening-step");

    expect(steps).toHaveLength(3);

    for (const step of steps) {
      expect(step.querySelector("input[type='checkbox']")).not.toBeNull();
    }

    // One of the three is on from the first render, and it is the confirmation
    // (REQ-273): the tint the rule paints is on that block and on no other.
    expect(
      opening.querySelectorAll(
        ".mc-opening-step input[type='checkbox']:checked",
      ),
    ).toHaveLength(1);

    await user.click(
      screen.getByRole("checkbox", { name: copy.openingConfirmation }),
    );

    expect(
      opening.querySelectorAll(
        ".mc-opening-step input[type='checkbox']:checked",
      ),
    ).toHaveLength(0);

    // The trigger's two are the same block, and exactly one of them is lit at
    // any moment: the tint the rule paints cannot show both (REQ-265).
    const trigger = screen.getByRole("region", { name: copy.whenCommentTitle });

    expect(trigger.querySelectorAll(".mc-opening-step")).toHaveLength(2);
    // The checkbox and not any checked input: the gate that is on holds the
    // radio that says how the word appears, which is checked too.
    expect(
      trigger.querySelectorAll(
        ".mc-opening-step input[type='checkbox']:checked",
      ),
    ).toHaveLength(1);
    expect(container.querySelectorAll(".mc-opening-step")).toHaveLength(5);
  });

  it("marks the card block as the card, with the accent frame", async () => {
    const user = userEvent.setup();
    const { container } = render(
      <AutomationFormScreen client={client()} assets={assets} />,
    );

    await user.click(screen.getByRole("button", { name: copy.addButton }));

    // The modifier is what the accent frame is written for. It used to tell
    // the card block from the attachment block, which were the same shape;
    // the attachment left with REQ-284 and the mark stays, because what it
    // says is which block is the message itself.
    expect(container.querySelectorAll(".mc-card-editor--card")).toHaveLength(1);
    expect(
      container.querySelector(".mc-card-editor--card")?.textContent,
    ).toContain(copy.cardBlock);
  });
});

/** The badge of a step, as the catalogue writes it, in both of its states. */
function stepBadge(number: number): string {
  return resolve(copy.sectionStep, { number });
}

function stepBadgeDone(number: number): string {
  return resolve(copy.sectionStepDone, { number });
}

/** Every step badge on the screen, in document order, by what it announces. */
function badges(container: HTMLElement): readonly (string | null)[] {
  return [...container.querySelectorAll(".mc-sechead__num")].map((badge) =>
    badge.getAttribute("aria-label"),
  );
}

/** The label over each stretch of the drawn conversation, in order. */
function stretches(): readonly string[] {
  return [...document.querySelectorAll(".mc-msg__step")].map(
    (label) => label.textContent ?? "",
  );
}

/**
 * REQ-233: the rich components of the approved prototype, guarded where they
 * can be guarded.
 *
 * jsdom applies no stylesheet, so nothing below proves that a switch LOOKS like
 * a switch. What it proves is the pair that rots: the declarations the drawing
 * stands on are still in the sheet, and the markup still carries the classes and
 * the controls those declarations are written for. The pixels are a pair of eyes
 * on a real viewport, in both themes and at both widths.
 *
 * What each of these is holding up, and why it is not decoration:
 *
 *   - the SWITCH. A square box says "one of several things you may tick"; a
 *     track with a pin says "this is on or off". Six of the seven booleans on
 *     this screen change what the contact receives, and the two shapes are how
 *     an operator tells a setting from a step;
 *   - the STEP BADGE. It answers "what is missing before I can activate" from
 *     across the screen, and it answers it in a word as well as in a colour;
 *   - the BAR. The two commits of the screen, above the work and still there
 *     once it is scrolled;
 *   - the HEAD and BODY of a question, which is what makes one read as a block
 *     with contents rather than as an indented field;
 *   - the STRETCH labels in the preview, which are the only thing that says WHY
 *     the delivery is last.
 */
describe("REQ-233: the editor carries the components of the approved drawing", () => {
  it("draws every boolean as a track with a pin, over a real checkbox", () => {
    // A sweep that read an empty module would pass every assertion below
    // forever: vitest replaces a stylesheet with nothing unless `css` is on.
    expect(COMPONENT_SHEET.length).toBeGreaterThan(0);

    // The track, in an ink that clears the 3:1 of REQ-176 on every surface a
    // switch sits on — the line colour the prototype used is 1.52:1 on a card.
    const track = blockAfter(COMPONENT_SHEET, ".mc-switch__track {");

    expect(track).toContain("background: var(--fg-3);");
    expect(track).toContain("border-radius: var(--radius-pill);");

    // The pin, and the travel that is half of what says on from off. It moves
    // by its own inset and not by a transform, so it follows the writing
    // direction instead of always going right.
    const pin = blockAfter(COMPONENT_SHEET, ".mc-switch__track::after {");

    expect(pin).toContain("inset-inline-start: var(--space-1);");

    const lit = blockAfter(
      COMPONENT_SHEET,
      ".mc-switch input:checked + .mc-switch__track {",
    );

    expect(lit).toContain("background: var(--success);");
    expect(
      blockAfter(
        COMPONENT_SHEET,
        ".mc-switch input:checked + .mc-switch__track::after {",
      ),
    ).toContain(
      "inset-inline-start: calc(100% - var(--space-4) - var(--space-1));",
    );

    // The ring the hidden input can no longer draw for itself (REQ-116).
    expect(COMPONENT_SHEET).toContain(
      ".mc-switch input:focus-visible + .mc-switch__track",
    );

    const { container } = render(
      <AutomationFormScreen client={client()} assets={assets} />,
    );

    // Seven: the two ways a comment can start the automation (REQ-265), the
    // public reply, the three questions that open the conversation, and the one
    // adjustment that is still a yes or a no. It was SEVEN until REQ-258 took
    // the attribute rule out of the product, eight when the word became a
    // switch, and seven again with REQ-277: the wait stopped being "on or off
    // plus a number of seconds" and became a closed ruler, which is a choice
    // and not a boolean. The count is written here rather than derived so that
    // a switch disappearing by accident fails instead of passing quietly. Every
    // one of them still an `input[type=checkbox]` with the track as its NEXT
    // sibling, which is what the rules above reach through, and none of them a
    // `div` with a handler.
    const switches = [...container.querySelectorAll(".mc-switch")];

    expect(switches).toHaveLength(7);

    for (const control of switches) {
      const input = control.querySelector("input");

      expect(input?.getAttribute("type")).toBe("checkbox");
      expect(input?.nextElementSibling?.className).toBe("mc-switch__track");
    }

    // And nothing on the editor is drawn as a box any more.
    expect(container.querySelectorAll(".mc-check")).toHaveLength(0);
  });

  it("numbers each section, and turns the number into a check when it holds nothing incomplete", async () => {
    const user = userEvent.setup();
    // With no publication in the address section 1 could never be completed
    // here: since REQ-264 the only way to answer it is the grid, and the grid
    // is a modal of its own.
    openOnPublication();
    const { container } = render(
      <AutomationFormScreen
        client={client()}
        assets={assets}
        finder={finder()}
      />,
    );

    await screen.findByRole("group", { name: copy.targetChosen });

    // The rule, stated: a section is complete when nothing IN IT stands between
    // the draft and activation. So an empty editor already has two (the public
    // reply is off, and the two adjustments want nothing), and the three that
    // are open are the ones that would take the caret if activation were
    // pressed right now. The opening is NOT one of them since REQ-332: it is
    // born asking the confirmation, and both the question and the label of its
    // button come from the catalogue, so nothing in that section is unanswered
    // until the operator empties one of them.
    expect(badges(container)).toEqual([
      stepBadge(1),
      stepBadgeDone(2),
      stepBadgeDone(3),
      stepBadge(4),
      stepBadgeDone(5),
    ]);
    expect(container.querySelectorAll(".mc-sechead--done")).toHaveLength(3);

    await user.type(
      screen.getByPlaceholderText(copy.keywordsPlaceholder),
      "ebook{enter}",
    );
    await user.type(screen.getByLabelText(copy.messageBody), "here it is");

    expect(badges(container)).toEqual([
      stepBadgeDone(1),
      stepBadgeDone(2),
      stepBadgeDone(3),
      stepBadgeDone(4),
      stepBadgeDone(5),
    ]);

    // Turning a question ON opens a wording nobody has written, so the section
    // that was complete stops being complete: the badge tracks the draft and
    // not the operator's progress through the form.
    await user.click(screen.getByRole("checkbox", { name: copy.openingEmail }));

    expect(badges(container)[2]).toBe(stepBadge(3));

    // The check is a colour AND a glyph, and the fill is what the contrast
    // floor measures.
    expect(
      blockAfter(COMPONENT_SHEET, ".mc-sechead--done .mc-sechead__num {"),
    ).toContain("background: var(--success);");
  });

  it("counts the steps over the sections really drawn, at either entrance", () => {
    // A direct message automation answers no comment, so it has no public
    // reply: numbering the rest 3, 4, 5 all the same says a step is missing
    // rather than that one never applied.
    openAt("?trigger=direct_message");

    const { container } = render(
      <AutomationFormScreen client={client()} assets={assets} />,
    );

    expect(badges(container)).toEqual([
      stepBadge(1),
      stepBadgeDone(2),
      stepBadge(3),
      stepBadgeDone(4),
    ]);
  });

  it("keeps the two commits in a bar that stays, above the work", () => {
    expect(COMPONENT_SHEET.length).toBeGreaterThan(0);

    // Sticky and pinned to the top of the scroll, which is the whole of "still
    // there once it is scrolled".
    const bar = blockAfter(COMPONENT_SHEET, ".mc-editorbar {");

    expect(bar).toContain("position: sticky;");
    expect(bar).toContain("inset-block-start: var(--space-0);");
    expect(bar).toContain("background: var(--surface-card);");

    const { container } = render(
      <AutomationFormScreen client={client()} assets={assets} />,
    );
    const found = container.querySelector(".mc-editorbar");

    expect(found).not.toBeNull();

    const inside = within(found as HTMLElement);

    for (const name of [copy.saveDraft, copy.activate]) {
      expect(inside.getByRole("button", { name })).toBeInTheDocument();
    }

    // The way out is in the bar too, and it is a LINK and not a button
    // (REQ-276): it goes somewhere, so it carries the address it goes to.
    expect(inside.getByRole("link", { name: copy.back })).toHaveAttribute(
      "href",
      "/automations",
    );
    expect(inside.queryByRole("button", { name: copy.cancel })).toBeNull();

    // Above the work: the first section comes AFTER it in the document, which
    // is what "above" means once the sheet is applied.
    const first = screen.getByRole("region", { name: copy.whenCommentTitle });

    expect(
      (found as HTMLElement).compareDocumentPosition(first) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    // And the save is still a real submit of the form it lives in, so Enter in
    // a field still saves the draft.
    expect(
      inside.getByRole("button", { name: copy.saveDraft }),
    ).toHaveAttribute("type", "submit");

    // The compact bar keeps the controls named when the visible wording changes
    // on mobile. Its three glyphs are fixed product choices, not a decorative
    // substitute for the accessible name.
    for (const name of [copy.back, copy.saveDraft, copy.activate]) {
      const control = inside.getByRole(name === copy.back ? "link" : "button", {
        name,
      });
      expect(control.querySelector("svg")).not.toBeNull();
      expect(control).toHaveClass("mc-editorbar__action");
    }

    const mobile = blockAfter(COMPONENT_SHEET, "@media (max-width: 48rem) {");
    expect(mobile).toContain(".mc-editorbar__actions {");
    expect(mobile).toContain("flex-wrap: nowrap;");
    expect(mobile).toContain("flex: 1 1 0;");
    expect(mobile).toContain("block-size: var(--tap);");
    expect(mobile).toContain(".mc-editorbar__action-label--back {");
    expect(mobile).toContain("display: none;");
    expect(mobile).toContain(".mc-editorbar__action-label--short {");
    expect(COMPONENT_SHEET).toContain(".mc-editorbar__action--draft > svg {");
    expect(COMPONENT_SHEET).toContain("color: var(--warning-ink);");
    expect(COMPONENT_SHEET).toContain(".mc-editorbar__action--activate {");
    expect(COMPONENT_SHEET).toContain("background: var(--success);");
  });

  it("says where the draft stands, and reports rather than decides", async () => {
    const user = userEvent.setup();
    const save = vi.fn();
    render(<AutomationFormScreen client={client(save)} assets={assets} />);

    // Nothing written and nothing stored: there is no state to report, and a
    // bar that claimed "saved" over an automation the instance has never seen
    // would be furniture that lies.
    expect(screen.queryByText(copy.stateUnsaved)).not.toBeInTheDocument();
    expect(screen.queryByText(copy.stateSaved)).not.toBeInTheDocument();

    await user.type(screen.getByLabelText(copy.messageBody), "here it is");

    expect(screen.getByText(copy.stateUnsaved)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: copy.saveDraft }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));

    expect(await screen.findByText(copy.stateSaved)).toBeInTheDocument();
    expect(screen.queryByText(copy.stateUnsaved)).not.toBeInTheDocument();
  });

  it("gives each question a head and a body, and the body only once it is on", async () => {
    expect(COMPONENT_SHEET.length).toBeGreaterThan(0);
    expect(blockAfter(COMPONENT_SHEET, ".mc-opening-step__body {")).toContain(
      "border-block-start: 1px solid var(--rule);",
    );

    const user = userEvent.setup();
    render(<AutomationFormScreen client={client()} assets={assets} />);

    const opening = screen.getByRole("region", { name: copy.openingTitle });
    const heads = [...opening.querySelectorAll(".mc-opening-step__head")];

    expect(heads).toHaveLength(3);
    // One body, and it belongs to the one question that is on from the first
    // render (REQ-273): the other two are decisions with no contents yet.
    expect(opening.querySelectorAll(".mc-opening-step__body")).toHaveLength(1);
    expect(
      opening.querySelector(".mc-opening-step__body")?.textContent,
    ).toContain(copy.confirmationQuestion);

    // The recommendation belongs to the first question and to no other: it is
    // the one without which the delivery would be a link in the first message.
    expect(heads[0]?.textContent).toContain(copy.openingRecommended);
    expect(heads[1]?.textContent).not.toContain(copy.openingRecommended);
    expect(heads[2]?.textContent).not.toContain(copy.openingRecommended);

    // Shut, the wording is not merely hidden: there is no body at all.
    await withoutConfirmation(user);

    expect(opening.querySelectorAll(".mc-opening-step__body")).toHaveLength(0);

    await user.click(screen.getByRole("checkbox", { name: copy.openingEmail }));

    expect(opening.querySelectorAll(".mc-opening-step__body")).toHaveLength(1);
    expect(
      opening.querySelector(".mc-opening-step__body")?.textContent,
    ).toContain(copy.emailQuestion);
  });

  it("names each stretch of the conversation in the preview", async () => {
    const user = userEvent.setup();
    render(<AutomationFormScreen client={client()} assets={assets} />);

    // One stretch with nothing turned on: what lands in the inbox. The comment
    // that earned it is on the publication, which has no preview (REQ-271).
    await withoutConfirmation(user);
    expect(stretches()).toEqual([copy.previewStepDirect]);

    await user.click(
      screen.getByRole("checkbox", { name: copy.openingConfirmation }),
    );
    await user.click(screen.getByRole("checkbox", { name: copy.openingEmail }));

    // The first question is what OPENS the conversation and the second only
    // continues it; and the delivery is now what the answers earned, which is
    // the one sentence that explains why it is last (REQ-066).
    expect(stretches()).toEqual([
      copy.previewStepOpens,
      copy.previewStepThen,
      copy.previewStepDelivery,
    ]);
  });

  it("draws the exclusive choices as a row of cards, and keeps them radios", () => {
    expect(COMPONENT_SHEET.length).toBeGreaterThan(0);
    expect(blockAfter(COMPONENT_SHEET, ".mc-choices__options {")).toContain(
      "display: flex;",
    );
    expect(blockAfter(COMPONENT_SHEET, ".mc-choice {")).toContain(
      "background: var(--surface-card);",
    );

    const chosen = blockAfter(
      COMPONENT_SHEET,
      ".mc-choice:has(input:checked) {",
    );

    expect(chosen).toContain("border-color: var(--accent);");
    expect(chosen).toContain("background: var(--accent-soft);");
    // The ring the card draws for an input that no longer draws its own.
    expect(COMPONENT_SHEET).toContain(".mc-choice:has(input:focus-visible)");

    const { container } = render(
      <AutomationFormScreen client={client()} assets={assets} />,
    );
    const cards = [...container.querySelectorAll(".mc-choice")];

    // The three explicit scopes, the two ways a declared word may appear, and
    // the five waits all use the same exclusive-choice component.
    expect(cards).toHaveLength(
      3 + KEYWORD_MATCH_MODES.length + FIRST_REPLY_DELAY_CHOICES.length,
    );

    for (const card of cards) {
      expect(card.querySelector("input[type='radio']")).not.toBeNull();
    }
  });
});

/**
 * A direct message automation as the instance holds one, for the case where the
 * editor must take the trigger from the DEFINITION and not from the address.
 */
const STORED_DIRECT_MESSAGE: UnifiedAutomation = {
  schema_version: 2,
  kind: "automation",
  id: "direct-2026-08-14t12-00-00-000z",
  state: "active",
  trigger: {
    type: "direct_message",
    match: { keywords: ["guide"], mode: "contains" },
  },
  rules: { once_per_contact: true, first_reply_delay_seconds: 5 },
  steps: [
    {
      id: "private-message",
      action: "send_dm",
      message: { text: "here it is" },
    },
  ],
};

describe("REQ-227: the trigger is chosen before the editor, never inside it", () => {
  it("presents no trigger control, at either entrance", () => {
    for (const entrance of ["?trigger=comment", "?trigger=direct_message"]) {
      openAt(entrance);
      const mounted = render(
        <AutomationFormScreen client={client()} assets={assets} />,
      );

      // The field is not merely disabled or hidden behind a section: the
      // question is answered before this screen opens, so nothing on it asks
      // the question again, by any of the three names a control could carry.
      // Named by the two ENTRANCES, which is where the question is asked and
      // the only vocabulary the product still has for the two triggers: the
      // listing stopped repeating the trigger's type on every card when the
      // card started saying what the automation does (REQ-278).
      expect(screen.queryByLabelText(copy.startCommentTitle)).toBeNull();
      expect(screen.queryByLabelText(copy.startDirectTitle)).toBeNull();
      // `queryAll`, because since task 3k.18 the editor opens carrying no
      // select at all: the private message stopped asking for a format, and
      // that was the last one on the page.
      expect(
        screen
          .queryAllByRole("combobox")
          .map((control) => control.getAttribute("id")),
      ).not.toContain("automation-trigger");

      mounted.unmount();
    }
  });

  it("says what the chosen entrance does, as a result and not as a field", () => {
    openAt("?trigger=direct_message");
    render(<AutomationFormScreen client={client()} assets={assets} />);

    // The same sentence the entry card promised, so the operator recognises
    // where they are without the editor asking anything.
    expect(screen.getByText(copy.startDirectOutcome)).toBeInTheDocument();
    expect(screen.queryByText(copy.startCommentOutcome)).toBeNull();
  });

  it("carries the comment entrance and the publication in the address into the aggregate", async () => {
    const save = vi.fn();
    const user = userEvent.setup();
    openAt("?trigger=comment&target=17900000000000000");
    render(
      <AutomationFormScreen
        client={client(save)}
        assets={assets}
        finder={finder()}
      />,
    );

    // The two parameters travel together: the publications screen opens this
    // editor with the publication already chosen (REQ-113), and since REQ-216
    // the editor SHOWS that publication instead of asking for it a second time.
    expect(
      await screen.findByRole("group", { name: copy.targetChosen }),
    ).toBeInTheDocument();
    expect(screen.queryByDisplayValue("17900000000000000")).toBeNull();

    await user.type(
      screen.getByPlaceholderText("Type and press Enter"),
      "ebook{enter}",
    );
    await user.type(screen.getByLabelText("Message"), "here it is");
    await user.click(screen.getByRole("button", { name: "Activate" }));

    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    const definition = save.mock.calls[0]?.[0] as UnifiedAutomation;
    expect(definition.trigger).toMatchObject({
      type: "comment",
      target: "17900000000000000",
    });
  });

  it("carries the direct message entrance into the aggregate", async () => {
    const save = vi.fn();
    const user = userEvent.setup();
    openAt("?trigger=direct_message");
    render(<AutomationFormScreen client={client(save)} assets={assets} />);

    await user.type(
      screen.getByPlaceholderText("Type and press Enter"),
      "ebook{enter}",
    );
    await user.type(screen.getByLabelText("Message"), "here it is");
    await user.click(screen.getByRole("button", { name: "Activate" }));

    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    const definition = save.mock.calls[0]?.[0] as UnifiedAutomation;
    expect(definition.trigger?.type).toBe("direct_message");
    // A direct message watches no publication, so none is written.
    expect(definition.trigger).not.toHaveProperty("target");
  });

  it("takes the trigger of a stored automation from its definition", async () => {
    const api = client();
    api.read = vi.fn(async () => stored(STORED_DIRECT_MESSAGE));
    // The address of an edit carries the identifier and no trigger at all, so
    // an editor that read only the address would open every stored automation
    // as a comment and silently rewrite it.
    openAt("?id=direct-2026-08-14t12-00-00-000z");
    render(<AutomationFormScreen client={api} assets={assets} />);

    expect(
      await screen.findByText(copy.startDirectOutcome),
    ).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: copy.targetChosen })).toBeNull();
  });
});

describe("REQ-228: the automation is named by what it listens to, not by hand", () => {
  it("offers no name field at either entrance", () => {
    for (const entrance of ["?trigger=comment", "?trigger=direct_message"]) {
      openAt(entrance);
      const mounted = render(
        <AutomationFormScreen client={client()} assets={assets} />,
      );

      expect(screen.queryByLabelText("Name")).toBeNull();
      expect(
        screen.getAllByRole("textbox").map((field) => field.getAttribute("id")),
      ).not.toContain("automation-name");

      mounted.unmount();
    }
  });

  it("REQ-279: writes no name at all into the comment automation it saves", async () => {
    const save = vi.fn();
    const user = userEvent.setup();
    openOnPublication();
    render(
      <AutomationFormScreen
        client={client(save)}
        assets={assets}
        finder={finder()}
      />,
    );

    await user.type(
      screen.getByPlaceholderText("Type and press Enter"),
      "ebook{enter}",
    );
    await user.type(screen.getByLabelText("Message"), "here it is");
    await withoutConfirmation(user);
    await user.click(screen.getByRole("button", { name: "Activate" }));

    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    const definition = save.mock.calls[0]?.[0] as UnifiedAutomation;
    // What identifies it is the publication it watches, which IS stored. The
    // sentence made out of that publication's caption is composed by whichever
    // screen is showing it: written here it would be a copy taken today, and
    // the caption is edited on the platform, not in this product.
    expect(definition).not.toHaveProperty("name");
    expect(
      definition.trigger?.type === "comment" && definition.trigger.target,
    ).toBe(IMAGE_ID);
  });

  it("REQ-279: writes no name into a direct message automation either", async () => {
    const save = vi.fn();
    const user = userEvent.setup();
    openAt("?trigger=direct_message");
    render(<AutomationFormScreen client={client(save)} assets={assets} />);

    await user.type(
      screen.getByPlaceholderText("Type and press Enter"),
      "ebook{enter}guide{enter}",
    );
    await user.type(screen.getByLabelText("Message"), "here it is");
    await user.click(screen.getByRole("button", { name: "Activate" }));

    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    const definition = save.mock.calls[0]?.[0] as UnifiedAutomation;
    // A direct message watches no publication, so what identifies it is the
    // words it answers to, and those are stored: the sentence built from them
    // is composed by the screen, in the language in force when it draws.
    expect(definition).not.toHaveProperty("name");
    expect(
      definition.trigger?.type === "direct_message" &&
        definition.trigger.match?.keywords,
    ).toEqual(["ebook", "guide"]);
  });

  it("REQ-296: heads the editor without the caption, however long the caption is", async () => {
    // What the operator hit: the heading was composed from the publication's
    // caption, a real caption is a paragraph and eighteen hashtags, and the
    // editor opened on a title that filled the window and pushed section 1 out
    // of sight. The publication is identified by its picture instead, which is
    // drawn a finger's width below this heading.
    const api = client();
    api.read = vi.fn(async () => stored(STORED_COMMENT));
    openAt("?id=comment-2026-08-14t12-00-00-000z");
    render(
      <AutomationFormScreen
        client={api}
        assets={assets}
        finder={finder([
          {
            id: IMAGE_ID,
            caption: LONG_CAPTION,
            mediaType: "IMAGE",
            publishedAt: "2026-08-01T10:00:00.000Z",
            thumbnailUrl: "/thumbs/one.jpg",
          },
        ])}
      />,
    );

    // Awaited on the PICTURE and not on the heading: once the thumbnail is
    // drawn the caption is in this screen's hands, so what follows is a heading
    // that had one to spend and did not spend it.
    expect(
      await screen.findByRole("img", { name: copy.targetThumbnailAlt }),
    ).toBeInTheDocument();

    const heading = screen.getByRole("heading", { level: 1 });

    expect(heading).toHaveTextContent(
      resolve(copy.editTitle, {
        name: resolve(copy.nameFromPublicationUnnamed, {
          date: formatDate(NOW, "en"),
        }),
      }),
    );
    // Not the whole caption, not its first line, and not one hashtag: a heading
    // that carried "only" the opening sentence would be the same defect one
    // paragraph shorter.
    for (const fragment of [LONG_CAPTION, LONG_CAPTION.slice(0, 40), "#"]) {
      expect(heading.textContent ?? "").not.toContain(fragment);
    }
  });

  it("keeps the identifier a stored automation was created under", async () => {
    const save = vi.fn();
    const api = client(save);
    const user = userEvent.setup();
    api.read = vi.fn(async () => stored(STORED_DIRECT_MESSAGE));
    openAt("?id=direct-2026-08-14t12-00-00-000z");
    render(<AutomationFormScreen client={api} assets={assets} />);

    expect(
      await screen.findByText(copy.startDirectOutcome),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Activate" }));

    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    const definition = save.mock.calls[0]?.[0] as UnifiedAutomation;
    // The address and the click history are written against it: a name that
    // moves must never move the identifier.
    expect(definition.id).toBe("direct-2026-08-14t12-00-00-000z");
  });
});

/**
 * A comment automation as the instance holds one, for the case where the
 * publication comes from the stored DEFINITION rather than from the address.
 */
const STORED_COMMENT: UnifiedAutomation = {
  schema_version: 2,
  kind: "automation",
  id: "comment-2026-08-14t12-00-00-000z",
  state: "active",
  trigger: {
    type: "comment",
    target: IMAGE_ID,
    match: { keywords: ["ebook"], mode: "contains" },
  },
  rules: { once_per_contact: true, first_reply_delay_seconds: 5 },
  steps: [
    {
      id: "private-message",
      action: "send_dm",
      message: { text: "here it is" },
    },
  ],
};

/**
 * REQ-264 and REQ-265 on the section that starts the automation.
 *
 * The defect these cases exist for was named by the operator twice, a phase
 * apart. First the editor asked again for the publication he had just clicked
 * on. Then, once it had stopped asking, it answered with four facts nobody had
 * asked for: the caption, the kind of post, the day and seventeen digits. What
 * he specified is a picture and the way to another picture, because everything
 * a person recognises a post by is IN the picture and the digits name it to the
 * instance and to nobody else.
 *
 * The words below it are the second half: two switches that exclude each other,
 * which is the shape the aggregate already had (REQ-262) finally drawn as what
 * it is.
 */
describe("REQ-264/REQ-265: the publication is a picture, the word is a switch", () => {
  it("draws the entrance's publication as a picture, and says nothing else", async () => {
    openOnPublication();
    render(
      <AutomationFormScreen
        client={client()}
        assets={assets}
        finder={finder()}
      />,
    );

    const chosen = await screen.findByRole("group", {
      name: copy.targetChosen,
    });

    // The picture, and the one gesture the block has.
    expect(
      within(chosen).getByRole("img", { name: copy.targetThumbnailAlt }),
    ).toHaveAttribute("src", "/thumbs/one.jpg");
    expect(
      within(chosen)
        .getAllByRole("button")
        .map((button) => button.textContent?.trim()),
    ).toEqual([copy.targetChange]);

    // And nothing else whatsoever: not the caption, not the kind, not the day,
    // not the identifier, and no control anywhere holding it.
    expect(within(chosen).queryByText(CAPTION, VERBATIM)).toBeNull();
    expect(within(chosen).queryByText("IMAGE")).toBeNull();
    expect(
      within(chosen).queryByText(formatDate("2026-08-01T10:00:00.000Z", "en")),
    ).toBeNull();
    expect(within(chosen).queryByText(IMAGE_ID)).toBeNull();
    expect(within(chosen).queryByRole("textbox")).toBeNull();
    expect(screen.queryByDisplayValue(IMAGE_ID)).toBeNull();
  });

  it("takes the publication of a stored automation the same way", async () => {
    const api = client();
    api.read = vi.fn(async () => stored(STORED_COMMENT));
    openAt("?id=comment-2026-08-14t12-00-00-000z");
    render(
      <AutomationFormScreen client={api} assets={assets} finder={finder()} />,
    );

    // The address carries no target at all here: what the automation watches
    // comes from the definition, and it is drawn the same way.
    const chosen = await screen.findByRole("group", {
      name: copy.targetChosen,
    });

    expect(
      await within(chosen).findByRole("img", {
        name: copy.targetThumbnailAlt,
      }),
    ).toHaveAttribute("src", "/thumbs/one.jpg");
    expect(within(chosen).queryByText(IMAGE_ID)).toBeNull();
  });

  it("swaps the publication through the grid, and saves the new one", async () => {
    const save = vi.fn();
    const user = userEvent.setup();
    openOnPublication();
    render(
      <AutomationFormScreen
        client={client(save)}
        assets={assets}
        finder={finder()}
        publications={grid()}
      />,
    );

    const chosen = await screen.findByRole("group", {
      name: copy.targetChosen,
    });

    await user.click(
      within(chosen).getByRole("button", { name: copy.targetChange }),
    );

    // The grid opens on the publication in force, so the swap starts from
    // where the operator is rather than from nowhere.
    const inForce = await screen.findByRole("button", {
      name: resolve(gridCopy.selectLabel, { id: IMAGE_ID }),
    });
    expect(inForce).toHaveAttribute("aria-pressed", "true");

    await user.click(
      screen.getByRole("button", {
        name: resolve(gridCopy.selectLabel, { id: VIDEO_ID }),
      }),
    );

    const swapped = await screen.findByRole("group", {
      name: copy.targetChosen,
    });
    // The picture is what changed, because the picture is the whole block.
    await waitFor(() =>
      expect(
        within(swapped).getByRole("img", { name: copy.targetThumbnailAlt }),
      ).toHaveAttribute("src", "/thumbs/two.jpg"),
    );

    await user.type(
      screen.getByPlaceholderText(copy.keywordsPlaceholder),
      "ebook{enter}",
    );
    await user.type(screen.getByLabelText(copy.messageBody), "here it is");
    await withoutConfirmation(user);
    await user.click(screen.getByRole("button", { name: copy.activate }));

    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    const definition = save.mock.calls[0]?.[0] as UnifiedAutomation;
    expect(definition.trigger).toMatchObject({
      type: "comment",
      target: VIDEO_ID,
    });
  });

  it("keeps the block, and blocks nothing, when the picture cannot be read", async () => {
    const save = vi.fn();
    const user = userEvent.setup();
    const unreachable: PublicationFinder = {
      byIds: vi.fn(async () => {
        throw new Error("500");
      }),
    };

    openOnPublication();
    render(
      <AutomationFormScreen
        client={client(save)}
        assets={assets}
        finder={unreachable}
      />,
    );

    const chosen = await screen.findByRole("group", {
      name: copy.targetChosen,
    });

    // Never empty and never a spinner that stays: the frame draws the absence,
    // and the block is not turned into a fault by a thumbnail nobody can fetch.
    expect(within(chosen).getByText(copy.targetNoPicture)).toBeInTheDocument();
    expect(within(chosen).queryByRole("img")).toBeNull();
    expect(
      within(chosen).getByRole("button", { name: copy.targetChange }),
    ).toBeInTheDocument();

    // And the automation is finished and activated over the top of it: the
    // target is held by the draft, never by this block.
    await user.type(
      screen.getByPlaceholderText(copy.keywordsPlaceholder),
      "ebook{enter}",
    );
    await user.type(screen.getByLabelText(copy.messageBody), "here it is");
    await withoutConfirmation(user);
    await user.click(screen.getByRole("button", { name: copy.activate }));

    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    const definition = save.mock.calls[0]?.[0] as UnifiedAutomation;
    expect(definition.state).toBe("active");
    expect(definition.trigger).toMatchObject({
      type: "comment",
      target: IMAGE_ID,
    });
  });

  it("stands the same way when the instance answers and holds nothing", async () => {
    // The other half of the same state, and the reason both end in one branch:
    // a cache that has never been refreshed answers perfectly well with no
    // publications, and to the operator that is not a different situation.
    openOnPublication();
    render(
      <AutomationFormScreen
        client={client()}
        assets={assets}
        finder={finder([])}
      />,
    );

    const chosen = await screen.findByRole("group", {
      name: copy.targetChosen,
    });

    expect(within(chosen).getByText(copy.targetNoPicture)).toBeInTheDocument();
    expect(
      within(chosen).getByRole("button", { name: copy.targetChange }),
    ).toBeInTheDocument();
  });

  it("turns a suggested word into a keyword chip", async () => {
    const save = vi.fn();
    const user = userEvent.setup();
    const word = (copy.keywordSuggestionList.split(",")[0] ?? "").trim();

    render(<AutomationFormScreen client={client(save)} assets={assets} />);

    expect(word).not.toBe("");
    await user.click(
      screen.getByRole("button", {
        name: resolve(copy.keywordAdd, { keyword: word }),
      }),
    );

    // It became a chip, and the chip's removal names the word it removes.
    expect(
      screen.getByRole("button", {
        name: resolve(copy.keywordRemove, { keyword: word }),
      }),
    ).toBeInTheDocument();
    // And it left the suggestions: one that would add nothing is a lie.
    expect(
      screen.queryByRole("button", {
        name: resolve(copy.keywordAdd, { keyword: word }),
      }),
    ).toBeNull();

    await user.click(screen.getByRole("button", { name: copy.saveDraft }));

    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    const definition = save.mock.calls[0]?.[0] as UnifiedAutomation;
    expect(declaredKeywords(definition.trigger)).toEqual([word]);
  });

  it("removes the chip that was asked for, and not the first one", async () => {
    const save = vi.fn();
    const user = userEvent.setup();
    render(<AutomationFormScreen client={client(save)} assets={assets} />);

    await user.type(
      screen.getByPlaceholderText(copy.keywordsPlaceholder),
      "ebook{enter}guide{enter}bonus{enter}",
    );

    await user.click(
      screen.getByRole("button", {
        name: resolve(copy.keywordRemove, { keyword: "guide" }),
      }),
    );

    await user.click(screen.getByRole("button", { name: copy.saveDraft }));

    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    const definition = save.mock.calls[0]?.[0] as UnifiedAutomation;
    // The one named, and the order of the others untouched.
    expect(declaredKeywords(definition.trigger)).toEqual(["ebook", "bonus"]);
  });

  it("REQ-265: opens on the word, contained, and never on both switches", () => {
    render(<AutomationFormScreen client={client()} assets={assets} />);

    const byWord = screen.getByRole("checkbox", { name: copy.matchByWord });
    const anyWord = screen.getByRole("checkbox", { name: copy.matchAnyWord });

    // The default the requirement names, in both halves.
    expect(byWord).toBeChecked();
    expect(anyWord).not.toBeChecked();
    expect(
      screen.getByRole("radio", { name: copy.modeContains }),
    ).toBeChecked();
    // What the other switch would do is readable while it is off, so turning
    // it on is a decision and not a discovery.
    expect(screen.getByText(copy.anyWordNote)).toBeInTheDocument();
  });

  it("REQ-265: turning any word ON turns the word off and takes its fields with it", async () => {
    const save = vi.fn();
    const user = userEvent.setup();
    render(<AutomationFormScreen client={client(save)} assets={assets} />);

    await user.type(
      screen.getByPlaceholderText(copy.keywordsPlaceholder),
      "ebook{enter}",
    );
    await user.click(screen.getByRole("checkbox", { name: copy.matchAnyWord }));

    expect(
      screen.getByRole("checkbox", { name: copy.matchAnyWord }),
    ).toBeChecked();
    expect(
      screen.getByRole("checkbox", { name: copy.matchByWord }),
    ).not.toBeChecked();
    // The words are not merely hidden: there is nowhere left to declare one,
    // because the aggregate has no field for them on this side (REQ-262).
    expect(screen.queryByPlaceholderText(copy.keywordsPlaceholder)).toBeNull();
    expect(screen.queryByRole("radio", { name: copy.modeContains })).toBeNull();

    await user.click(screen.getByRole("button", { name: copy.saveDraft }));

    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    const definition = save.mock.calls[0]?.[0] as UnifiedAutomation;
    // The whole match, compared whole: a stray `keywords` beside `any` is
    // exactly the definition the instance refuses by shape.
    expect(definition.trigger?.match).toEqual({ mode: "any" });
  });

  it("REQ-265: turning the word switch OFF is the same gesture as turning any word on", async () => {
    const user = userEvent.setup();
    render(<AutomationFormScreen client={client()} assets={assets} />);

    // One of the two is always on, so switching the live one off cannot leave
    // the trigger saying nothing about who it fires for.
    await user.click(screen.getByRole("checkbox", { name: copy.matchByWord }));

    expect(
      screen.getByRole("checkbox", { name: copy.matchAnyWord }),
    ).toBeChecked();
    expect(
      screen.getByRole("checkbox", { name: copy.matchByWord }),
    ).not.toBeChecked();
  });

  it("REQ-265: exactly one of the two is on, whichever is pressed and however often", async () => {
    const user = userEvent.setup();
    render(<AutomationFormScreen client={client()} assets={assets} />);

    const lit = (): number =>
      [copy.matchByWord, copy.matchAnyWord].filter(
        (name) =>
          (screen.getByRole("checkbox", { name }) as HTMLInputElement).checked,
      ).length;

    expect(lit()).toBe(1);

    for (const name of [
      copy.matchAnyWord,
      copy.matchAnyWord,
      copy.matchByWord,
      copy.matchByWord,
      copy.matchAnyWord,
    ]) {
      await user.click(screen.getByRole("checkbox", { name }));
      expect(lit()).toBe(1);
    }
  });

  it("REQ-265: turning the word back on returns to the default it opened with", async () => {
    const save = vi.fn();
    const user = userEvent.setup();
    render(<AutomationFormScreen client={client(save)} assets={assets} />);

    await user.click(screen.getByRole("radio", { name: copy.modeExact }));
    await user.click(screen.getByRole("checkbox", { name: copy.matchAnyWord }));
    await user.click(screen.getByRole("checkbox", { name: copy.matchByWord }));

    // Back to the word, and to "contains": the section reopens where it opens
    // for everyone, instead of on a mode chosen before the words were dropped.
    expect(
      screen.getByRole("radio", { name: copy.modeContains }),
    ).toBeChecked();
    await user.type(
      screen.getByPlaceholderText(copy.keywordsPlaceholder),
      "ebook{enter}",
    );
    await user.click(screen.getByRole("button", { name: copy.saveDraft }));

    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    const definition = save.mock.calls[0]?.[0] as UnifiedAutomation;
    expect(definition.trigger?.match).toEqual({
      keywords: ["ebook"],
      mode: "contains",
    });
  });

  it("REQ-263: the direct message entrance offers no any-word switch at all", async () => {
    const save = vi.fn();
    const user = userEvent.setup();
    openAt("?trigger=direct_message");
    render(<AutomationFormScreen client={client(save)} assets={assets} />);

    // Not off, and not disabled: absent. The schema refuses "any word" there,
    // and a switch offering what the instance will refuse is a switch that lies.
    expect(
      screen.queryByRole("checkbox", { name: copy.matchAnyWord }),
    ).toBeNull();
    expect(
      screen.queryByRole("checkbox", { name: copy.matchByWord }),
    ).toBeNull();

    // The words are asked plainly, and so is the way they have to appear.
    const question = screen.getByRole("group", { name: copy.fieldMode });
    expect(
      within(question)
        .getAllByRole("radio")
        .map((radio) => radio.getAttribute("value")),
    ).toEqual(["contains", "exact"]);

    const exact = screen.getByRole("radio", { name: copy.modeExact });
    await user.click(exact);
    expect(exact).toBeChecked();

    await user.type(
      screen.getByPlaceholderText(copy.keywordsPlaceholder),
      "ebook{enter}",
    );
    await user.click(screen.getByRole("button", { name: copy.saveDraft }));

    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    const definition = save.mock.calls[0]?.[0] as UnifiedAutomation;
    expect(definition.trigger?.match).toMatchObject({
      keywords: ["ebook"],
      mode: "exact",
    });
  });

  it("REQ-265: the comment entrance asks how the word appears, with the two the schema keeps", () => {
    render(<AutomationFormScreen client={client()} assets={assets} />);

    const question = screen.getByRole("group", { name: copy.fieldMode });

    // Two, and "any word" is not one of them any more: it is the switch above,
    // and a mode that is also a switch would be the same decision asked twice.
    expect(
      within(question)
        .getAllByRole("radio")
        .map((radio) => radio.getAttribute("value")),
    ).toEqual([...KEYWORD_MATCH_MODES]);
  });
});

/**
 * REQ-272 on the two switches of the trigger.
 *
 * The exclusion has been real in the TYPE since REQ-265 (`commentMatchSchema`
 * has no `keywords` at all under "any word", so "both on" is a state the draft
 * cannot hold) and invisible on the screen: two switches one under the other
 * read as two independent options, and the operator found out that one shuts
 * the other by pressing it. The word between them says so first.
 */
describe("REQ-272: the two ways of firing are named, and the word between them", () => {
  it("names the first switch as a name, and not as a fragment of a sentence", () => {
    // The two locales, because the requirement names the words themselves: it
    // is "A Palavra" and not "a palavra:", which is a label that trails off
    // into the field under it and reads as half a sentence.
    expect(ptBR.screens.automations.matchByWord).toBe("A Palavra");
    expect(copy.matchByWord).toBe("The Word");

    for (const wording of [
      ptBR.screens.automations.matchByWord,
      copy.matchByWord,
    ])
      expect(wording).not.toContain(":");

    render(<AutomationFormScreen client={client()} assets={assets} />);

    // And it is what the switch is really called, read off the accessible name
    // rather than off the markup around it.
    expect(
      screen.getByRole("checkbox", { name: copy.matchByWord }),
    ).toBeInTheDocument();
  });

  it("draws the word BETWEEN the two blocks, and nowhere else", () => {
    const { container } = render(
      <AutomationFormScreen client={client()} assets={assets} />,
    );

    const word = screen.getByText(copy.matchOr);

    expect(ptBR.screens.automations.matchOr).toBe("ou");

    // Between them in the DOCUMENT, which is the order a screen reader walks
    // and the order the eye walks: after the block that is on, before the one
    // that is off. Read off one walk of the trigger section, so a word merely
    // near the two blocks is not mistaken for a word between them.
    const trigger = screen.getByRole("region", { name: copy.whenCommentTitle });
    const walked = [
      ...trigger.querySelectorAll(".mc-opening-step, .mc-or"),
    ].map((element) => element.textContent ?? "");

    expect(walked).toHaveLength(3);
    expect(walked[0]).toContain(copy.matchByWord);
    expect(walked[1]).toBe(copy.matchOr);
    expect(walked[2]).toContain(copy.matchAnyWord);
    expect(word).toBeInTheDocument();

    // Once, and only where two switches really exclude each other: the three
    // questions that open the conversation are independent, and a word saying
    // "or" between them would be a lie about what they do.
    expect(screen.getAllByText(copy.matchOr)).toHaveLength(1);
    expect(container.querySelectorAll(".mc-or")).toHaveLength(1);
  });

  it("says nothing about a choice the direct message entrance does not have", () => {
    openAt("?trigger=direct_message");
    const { container } = render(
      <AutomationFormScreen client={client()} assets={assets} />,
    );

    // There is one way in there and no second one to exclude (REQ-263), so the
    // word has nothing to separate: drawn all the same it would announce a
    // choice the operator will never be offered.
    expect(screen.queryByText(copy.matchOr)).toBeNull();
    expect(container.querySelectorAll(".mc-or")).toHaveLength(0);
  });

  it("draws the two rules with the token that draws every hairline", () => {
    expect(COMPONENT_SHEET.length).toBeGreaterThan(0);

    const line = blockAfter(COMPONENT_SHEET, ".mc-or::before,");

    // A border and not a filled box: `--rule` draws lines in this system and
    // fills no surface, and a background painted with it is a surface the
    // contrast guardian would then have to measure ink against.
    expect(line).toContain("border-block-start: 1px solid var(--rule);");
    expect(line).not.toContain("background:");
  });
});

/**
 * REQ-274, which SUPERSEDES the shape REQ-266 asked for in this block.
 *
 * REQ-266 asked for a compact box and a button that added a variation, and the
 * variation it added was a field the width of the section. Three short
 * sentences therefore took three boxes stacked down a 320px screen, which is
 * what the author of the product saw and asked to be changed. The wordings are
 * the chips of ONE field now, in the gesture the keywords already use, and the
 * approved drawing (`docs/prototipo-automacao.html`) draws no box in this block
 * at all: there is no first wording and no variations of it, there are wordings,
 * and the engine draws between them (REQ-125).
 */
describe("REQ-274: the wordings of the public reply are removable chips", () => {
  /** The editor with the public reply on, which is where the chips live. */
  async function replying(): Promise<ReturnType<typeof userEvent.setup>> {
    const user = userEvent.setup();

    await user.click(screen.getByLabelText(copy.publicReplyToggle));

    return user;
  }

  it("commits what is typed as a chip, and keeps the box that adds on its own line", async () => {
    // A sweep that read an empty module would pass every assertion below
    // forever: vitest replaces a stylesheet with nothing unless `css` is on.
    expect(COMPONENT_SHEET.length).toBeGreaterThan(0);

    render(<AutomationFormScreen client={client()} assets={assets} />);
    const user = await replying();

    // A one-line box and not a paragraph: a public reply is one line under a
    // comment, and the wordings that are already written are chips beside it.
    const box = screen.getByLabelText(copy.publicReplyText);

    expect(box.tagName).toBe("INPUT");
    expect(box).toHaveAttribute("placeholder", copy.publicReplyPlaceholder);
    expect(document.querySelectorAll(".mc-phrases__list")).toHaveLength(0);

    await user.type(box, "check your inbox{enter}");

    // The box empties, so the next wording is typed where the last one was.
    expect(box).toHaveValue("");
    const chip = screen.getByText("check your inbox");

    expect(chip.closest(".mc-chip")).toHaveClass("mc-chip--phrase");
    // The × is a real button, named after the wording it takes away: "remove"
    // alone does not say which of three sentences is about to go.
    expect(
      screen.getByRole("button", {
        name: resolve(copy.publicReplyRemove, { wording: "check your inbox" }),
      }),
    ).toBeInTheDocument();

    // The box that adds the next one sits OUTSIDE the row of chips, which is
    // the one thing the keyword field does differently: a sentence does not
    // share a line with the box that takes the next sentence.
    expect(document.querySelector(".mc-phrases__list")?.contains(box)).toBe(
      false,
    );
  });

  it("keeps a comma inside the wording, where a keyword field would have cut it", async () => {
    const save = vi.fn();
    render(<AutomationFormScreen client={client(save)} assets={assets} />);
    const user = await replying();

    // The whole reason this is a sibling of `KeywordField` and not a call to
    // it: there a comma ENDS the word being typed, and here it is punctuation
    // inside a sentence.
    await user.type(
      screen.getByLabelText(copy.publicReplyText),
      "te mandei, dá uma olhada{enter}",
    );

    expect(screen.getByText("te mandei, dá uma olhada")).toBeInTheDocument();
    expect(document.querySelectorAll(".mc-chip--phrase")).toHaveLength(1);
  });

  it("adds nothing for a wording that is only blanks", async () => {
    render(<AutomationFormScreen client={client()} assets={assets} />);
    const user = await replying();
    const box = screen.getByLabelText(copy.publicReplyText);

    // A stray Enter, and a box holding spaces, are the same thing: nothing was
    // written. A chip carrying blanks would be a wording the engine could draw
    // and send, and it would read as an empty reply under the comment.
    await user.type(box, "{enter}");
    await user.type(box, "   {enter}");

    expect(document.querySelectorAll(".mc-chip--phrase")).toHaveLength(0);
    expect(box).toHaveValue("");
  });

  it("removes the chip that was asked for, and not the one saying the same thing", async () => {
    const save = vi.fn();
    render(<AutomationFormScreen client={client(save)} assets={assets} />);
    const user = await replying();
    const box = screen.getByLabelText(copy.publicReplyText);

    await user.type(box, "sent it over{enter}");
    await user.type(box, "check your inbox{enter}");
    await user.type(box, "sent it over{enter}");

    // Removal is by POSITION and not by text, so the SECOND of two identical
    // wordings is the one that goes.
    const removals = screen.getAllByRole("button", {
      name: resolve(copy.publicReplyRemove, { wording: "sent it over" }),
    });

    expect(removals).toHaveLength(2);
    await user.click(removals[1] as HTMLElement);
    await user.click(screen.getByRole("button", { name: copy.saveDraft }));

    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    const definition = save.mock.calls[0]?.[0] as UnifiedAutomation;

    expect(
      definition.steps?.find((step) => step.action === "reply_comment"),
    ).toMatchObject({ text: ["sent it over", "check your inbox"] });
  });

  it("writes every wording, and one alone in the shape a stored automation carries", async () => {
    const save = vi.fn();
    render(<AutomationFormScreen client={client(save)} assets={assets} />);
    const user = await replying();

    // Left in the box and never committed: blur is what saves a wording typed
    // and abandoned, exactly as it saves a keyword typed and abandoned.
    await user.type(screen.getByLabelText(copy.publicReplyText), "I sent it");
    await user.click(screen.getByRole("button", { name: copy.saveDraft }));

    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    // ONE wording travels as the string every definition ever stored carries,
    // so nothing has to be migrated to be read.
    expect(
      (save.mock.calls[0]?.[0] as UnifiedAutomation).steps?.find(
        (step) => step.action === "reply_comment",
      ),
    ).toMatchObject({ text: "I sent it" });

    await user.type(
      screen.getByLabelText(copy.publicReplyText),
      "check your inbox{enter}",
    );
    await user.click(screen.getByRole("button", { name: copy.saveDraft }));

    await waitFor(() => expect(save).toHaveBeenCalledTimes(2));
    // And several as the list, in the order they were written: the engine
    // draws between them, so the order is the only thing the screen owes them.
    expect(
      (save.mock.calls[1]?.[0] as UnifiedAutomation).steps?.find(
        (step) => step.action === "reply_comment",
      ),
    ).toMatchObject({ text: ["I sent it", "check your inbox"] });
  });

  it("reads the wordings of a stored automation back as chips", async () => {
    const api = client();
    api.read = vi.fn(async () =>
      stored({
        ...STORED_DIRECT_MESSAGE,
        id: "comment-2026-08-14t12-00-00-000z",
        trigger: {
          type: "comment",
          target: IMAGE_ID,
          match: { keywords: ["ebook"], mode: "contains" },
        },
        steps: [
          {
            id: "public-reply",
            action: "reply_comment",
            text: ["check your inbox", "sent it over"],
          },
          {
            id: "private-message",
            action: "send_dm",
            message: { text: "here it is" },
          },
        ],
      }),
    );
    openAt("?id=comment-2026-08-14t12-00-00-000z");
    render(
      <AutomationFormScreen client={api} assets={assets} finder={finder()} />,
    );

    // Both of them, and neither promoted into a box of its own: a list read
    // back as "one plus its variations" is the shape this requirement removed.
    expect(await screen.findByText("check your inbox")).toBeInTheDocument();
    expect(screen.getByText("sent it over")).toBeInTheDocument();
    expect(document.querySelectorAll(".mc-chip--phrase")).toHaveLength(2);
  });

  it("vertically centres a wrapping wording and its × inside the pill", () => {
    expect(COMPONENT_SHEET.length).toBeGreaterThan(0);

    const label = blockAfter(
      COMPONENT_SHEET,
      ".mc-chip--phrase .mc-chip__label {",
    );

    // A SENTENCE wraps. The keyword's own label clips at one line with an
    // ellipsis, which on a wording would hide the half that says what it is,
    // and the two are held against each other so the day the keyword stops
    // clipping this stops claiming a difference it lost.
    expect(label).toContain("white-space: normal;");
    expect(label).toContain("overflow-wrap: anywhere;");
    expect(blockAfter(COMPONENT_SHEET, ".mc-chip__label {")).toContain(
      "white-space: nowrap;",
    );

    // And the × is the chip's own button, so it keeps the one tap size the
    // whole product is cut to (REQ-268) rather than a size of its own.
    expect(blockAfter(COMPONENT_SHEET, ".mc-chip__remove {")).toContain(
      "min-height: var(--tap);",
    );
    expect(
      blockAfter(COMPONENT_SHEET, ".mc-chip--phrase .mc-chip__remove {"),
    ).not.toContain("min-height");

    expect(blockAfter(COMPONENT_SHEET, ".mc-chip--phrase {")).toContain(
      "align-items: center;",
    );
    expect(
      blockAfter(COMPONENT_SHEET, ".mc-chip--phrase .mc-chip__remove {"),
    ).toContain("align-self: center;");
  });
});

/**
 * An automation that already opens its conversation, as the instance holds one.
 *
 * Every number is deliberately NOT the default the editor offers, so a field
 * that quietly showed 24 hours or 2 tries instead of what was stored would be
 * read here as the defect it is.
 */
const STORED_OPENING: UnifiedAutomation = {
  schema_version: 2,
  kind: "automation",
  id: "comment-2026-08-14t12-00-00-000z",
  state: "active",
  trigger: {
    type: "comment",
    target: IMAGE_ID,
    match: { keywords: ["ebook"], mode: "contains" },
  },
  rules: { once_per_contact: true, first_reply_delay_seconds: 5 },
  steps: [
    { id: "public-reply", action: "reply_comment", text: "check your inbox" },
    {
      id: "confirmation",
      action: "confirm_optin",
      text: "may I send it?",
      quick_reply_label: "Yes",
      on_timeout: "abandon",
    },
    {
      id: "email",
      action: "collect_email",
      ask: "what is your email?",
      on_timeout: "abandon",
    },
    {
      id: "follow",
      action: "follow_gate",
      ask: "please follow us",
      on_timeout: "abandon",
    },
    {
      id: "private-message",
      action: "send_dm",
      message: { text: "here it is" },
    },
  ],
};

/**
 * REQ-215 and REQ-226 on what OPENS the conversation.
 *
 * The three questions were switches loose among the "optional rules", which is
 * how the operator came to say he had never seen the opt-in message on screen:
 * each of them carries a wording HE writes and each changes the order of what
 * the contact receives, so none of them is an adjustment. They are a section,
 * with the reason they exist stated in it — the platform refuses a link in the
 * first message (REQ-066), so asking something is what opens the conversation
 * and the delivery is the answer to it.
 */
describe("REQ-215/REQ-226: opening the conversation is a section of its own", () => {
  it("gives the three a section, says why they exist, and leaves the rules to the adjustments", () => {
    render(<AutomationFormScreen client={client()} assets={assets} />);

    const opening = screen.getByRole("region", { name: copy.openingTitle });
    // The restriction in one sentence: without it the three read as arbitrary
    // preferences, which is exactly how they read while they were rules.
    expect(within(opening).getByText(copy.openingWhy)).toBeInTheDocument();

    // Three named blocks, in the one order the aggregate writes them.
    for (const name of [
      copy.openingConfirmation,
      copy.openingEmail,
      copy.openingFollow,
    ])
      expect(within(opening).getByRole("group", { name })).toBeInTheDocument();
    expect(
      within(opening)
        .getAllByRole("checkbox")
        .map((box) => box.getAttribute("id")),
    ).toEqual([
      "automation-confirmation",
      "automation-email",
      "automation-follow",
    ]);

    // And they are gone from where they used to be: what is left under the
    // rules is what really is one.
    const rules = screen.getByRole("region", {
      name: copy.optionalRulesTitle,
    });
    for (const name of [
      copy.openingConfirmation,
      copy.openingEmail,
      copy.openingFollow,
    ])
      expect(within(rules).queryByRole("checkbox", { name })).toBeNull();
    expect(
      within(rules).getByRole("checkbox", { name: copy.fieldOnce }),
    ).toBeInTheDocument();
    // The wait is here too, and it is no longer a switch: it is the closed
    // ruler of REQ-277, which is what makes it an adjustment and not a step.
    expect(
      within(rules).getByRole("group", { name: copy.firstReplyDelay }),
    ).toBeInTheDocument();
  });

  it("REQ-086: turning the confirmation on reveals its own fields, and writes the question and the button", async () => {
    const save = vi.fn();
    const user = userEvent.setup();
    render(<AutomationFormScreen client={client(save)} assets={assets} />);

    const block = screen.getByRole("group", {
      name: copy.openingConfirmation,
    });
    const toggle = within(block).getByRole("checkbox", {
      name: copy.openingConfirmation,
    });

    // Shut, the wording is not merely disabled: it is not there. A question
    // someone can write while nobody will ever be asked it is worse than none.
    await user.click(toggle);
    expect(toggle).not.toBeChecked();
    expect(screen.queryByLabelText(copy.confirmationQuestion)).toBeNull();

    await user.click(toggle);
    // The state is programmatic and not only a revealed shape below it.
    expect(toggle).toBeChecked();

    await user.clear(within(block).getByLabelText(copy.confirmationQuestion));
    await user.type(
      within(block).getByLabelText(copy.confirmationQuestion),
      "may I send it?",
    );
    await user.clear(within(block).getByLabelText(copy.confirmationQuickReply));
    await user.type(
      within(block).getByLabelText(copy.confirmationQuickReply),
      "Yes",
    );
    // No deadline to set here, and that absence is the requirement (REQ-252):
    // three questions asked for the same number three times, and it is one
    // setting of the instance now, offered in Settings. A deadline would be a
    // number field, so the assertion is on the shape and not on a label that no
    // longer exists to be looked up.
    expect(within(block).queryAllByRole("spinbutton")).toEqual([]);

    await user.click(screen.getByRole("button", { name: copy.saveDraft }));

    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    const definition = save.mock.calls[0]?.[0] as UnifiedAutomation;
    expect(
      definition.steps?.find((step) => step.action === "confirm_optin"),
    ).toMatchObject({
      action: "confirm_optin",
      text: "may I send it?",
      quick_reply_label: "Yes",
      // The single policy the format declares, and the one the engine proves:
      // the run is abandoned, it is not held forever.
      on_timeout: "abandon",
    });
  });

  it("REQ-249: a DRAFT may still be holding the button emptied", async () => {
    const save = vi.fn();
    const user = userEvent.setup();
    render(<AutomationFormScreen client={client(save)} assets={assets} />);

    // Already asking, since REQ-273, and asking with the catalogue's own
    // sentence: what is written here is the wording and never the decision.
    await user.clear(screen.getByLabelText(copy.confirmationQuestion));
    await user.type(
      screen.getByLabelText(copy.confirmationQuestion),
      "may I send it?",
    );

    // The sentence under the field says what the button is FOR, which is what
    // makes leaving it empty a thing an operator does on purpose or not at all.
    expect(
      screen.getByText(copy.confirmationQuickReplyHint),
    ).toBeInTheDocument();

    // Emptied on purpose: since REQ-332 the label a new automation is born with
    // is the catalogue's, so the half-written state this test is about is the
    // one an operator has to REACH.
    await user.clear(screen.getByLabelText(copy.confirmationQuickReply));

    await user.click(screen.getByRole("button", { name: copy.saveDraft }));

    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    const definition = save.mock.calls[0]?.[0] as UnifiedAutomation;
    const confirmation = definition.steps?.find(
      (step) => step.action === "confirm_optin",
    );
    expect(confirmation).toMatchObject({ text: "may I send it?" });
    // Not an empty label, which the format refuses: no label at all. A draft
    // exists to hold what is half written, and it is ACTIVATION that refuses a
    // confirmation nobody could answer (REQ-249).
    expect(confirmation).not.toHaveProperty("quick_reply_label");
  });

  it("REQ-249: activating without the button is refused, at the field to fill", async () => {
    const save = vi.fn();
    const user = userEvent.setup();
    openOnPublication();
    render(
      <AutomationFormScreen
        client={client(save)}
        assets={assets}
        finder={finder()}
      />,
    );

    await user.type(
      screen.getByPlaceholderText(copy.keywordsPlaceholder),
      "ebook{enter}",
    );
    await user.type(screen.getByLabelText(copy.messageBody), "here it is");

    // The one state that still earns the refusal since REQ-332: a label the
    // operator EMPTIED. The label a new automation is born with comes from the
    // catalogue, so an untouched confirmation activates.
    await user.clear(screen.getByLabelText(copy.confirmationQuickReply));

    await user.click(screen.getByRole("button", { name: copy.activate }));

    // Nothing was sent, because the editor must not produce an automation the
    // validation refuses by name.
    expect(save).not.toHaveBeenCalled();
    // And the caret is in the field that has to be filled, rather than in a
    // notice the operator has to read and then go looking.
    expect(screen.getByLabelText(copy.confirmationQuickReply)).toHaveFocus();
  });

  it("REQ-066: writes the three in the settled order, after the public reply and before the delivery", async () => {
    const save = vi.fn();
    const user = userEvent.setup();
    openOnPublication();
    render(
      <AutomationFormScreen
        client={client(save)}
        assets={assets}
        finder={finder()}
      />,
    );

    await user.type(
      screen.getByPlaceholderText(copy.keywordsPlaceholder),
      "ebook{enter}",
    );
    await user.click(screen.getByLabelText(copy.publicReplyToggle));
    await user.type(
      screen.getByLabelText(copy.publicReplyText),
      "check your inbox{enter}",
    );

    // Turned on in the reverse of the order they are written in, so what the
    // aggregate carries is the ORDER the section declares and not the order
    // the operator happened to press the switches in.
    await user.click(
      screen.getByRole("checkbox", { name: copy.openingFollow }),
    );
    await user.type(
      screen.getByLabelText(copy.followQuestion),
      "please follow us",
    );
    await user.click(screen.getByRole("checkbox", { name: copy.openingEmail }));
    await user.type(
      screen.getByLabelText(copy.emailQuestion),
      "what is your email?",
    );
    // The confirmation is the one that was already asked (REQ-273), so it is
    // written into LAST of the three and still goes out FIRST.
    await user.clear(screen.getByLabelText(copy.confirmationQuestion));
    await user.type(
      screen.getByLabelText(copy.confirmationQuestion),
      "may I send it?",
    );
    // Obligatory to activate since REQ-249: the button is what the question is
    // answered with, so an automation cannot be turned on without one.
    await user.type(screen.getByLabelText(copy.confirmationQuickReply), "Yes");

    await user.type(screen.getByLabelText(copy.messageBody), "here it is");
    await user.click(screen.getByRole("button", { name: copy.activate }));

    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    const definition = save.mock.calls[0]?.[0] as UnifiedAutomation;
    // The delivery LAST, and that is the whole reason the section exists: a
    // `send_dm` written before these three is the message that never arrives.
    expect(definition.steps?.map((step) => step.action)).toEqual([
      "reply_comment",
      "confirm_optin",
      "collect_email",
      "follow_gate",
      "send_dm",
    ]);
  });

  it("reads a stored opening back into its own fields", async () => {
    const api = client();
    api.read = vi.fn(async () => stored(STORED_OPENING));
    openAt("?id=comment-2026-08-14t12-00-00-000z");
    render(
      <AutomationFormScreen client={api} assets={assets} finder={finder()} />,
    );

    expect(await screen.findByLabelText(copy.confirmationQuestion)).toHaveValue(
      "may I send it?",
    );
    expect(screen.getByLabelText(copy.confirmationQuickReply)).toHaveValue(
      "Yes",
    );
    expect(screen.getByLabelText(copy.emailQuestion)).toHaveValue(
      "what is your email?",
    );
    expect(screen.getByLabelText(copy.followQuestion)).toHaveValue(
      "please follow us",
    );
    // REQ-252, REQ-254: neither a deadline nor a number of tries is read back,
    // because neither is written any more. Both were number fields, and none of
    // the three questions offers one now.
    for (const name of [
      copy.openingConfirmation,
      copy.openingEmail,
      copy.openingFollow,
    ]) {
      expect(
        within(screen.getByRole("group", { name })).queryAllByRole(
          "spinbutton",
        ),
      ).toEqual([]);
    }
  });

  /**
   * REQ-273, and it is a CORRECTION rather than a new idea.
   *
   * The approved drawing has had "Ask for confirmation" on since it was drawn;
   * the screen is what diverged, from the task that created this editor. The
   * platform very nearly obliges it: the first message may carry no link, so
   * without something that opens the conversation the delivery is the message
   * that never arrives, and an operator who did not know the rule found out
   * when the material did not go out.
   */
  it("REQ-273: a new comment automation is born asking the confirmation", () => {
    render(<AutomationFormScreen client={client()} assets={assets} />);

    expect(
      screen.getByRole("checkbox", { name: copy.openingConfirmation }),
    ).toBeChecked();
    // And the other two are not: this is the one the product recommends, not
    // three questions asked by default.
    expect(
      screen.getByRole("checkbox", { name: copy.openingEmail }),
    ).not.toBeChecked();
    expect(
      screen.getByRole("checkbox", { name: copy.openingFollow }),
    ).not.toBeChecked();
  });

  it("REQ-273: asks with the catalogue's own sentence, and writes it into the aggregate", async () => {
    const save = vi.fn();
    const user = userEvent.setup();
    render(<AutomationFormScreen client={client(save)} assets={assets} />);
    await user.click(
      screen.getByRole("radio", { name: copy.scopeNextPublication }),
    );

    // Written into the field and not shown as a placeholder: what is on the
    // screen is what would be sent, and a placeholder promises the opposite.
    const question = screen.getByLabelText(copy.confirmationQuestion);

    expect(question).toHaveValue(copy.confirmationQuestionDefault);
    expect(question).not.toHaveAttribute("placeholder");
    expect(ptBR.screens.automations.confirmationQuestionDefault).not.toBe(
      copy.confirmationQuestionDefault,
    );

    // Anything at all, because the bar refuses to save what has not changed:
    // this is the FIRST save of an ordinary new automation.
    await user.type(
      screen.getByPlaceholderText(copy.keywordsPlaceholder),
      "ebook{enter}",
    );
    await user.click(screen.getByRole("button", { name: copy.saveDraft }));

    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    const definition = save.mock.calls[0]?.[0] as UnifiedAutomation;
    const confirmation = definition.steps?.find(
      (step) => step.action === "confirm_optin",
    );

    // The sentence itself, and NOT an empty text: the shape refuses an empty
    // wording on every save, draft or not, so a request that came on with
    // nothing written would make the first save of every new
    // automation a refusal.
    expect(confirmation).toMatchObject({
      text: copy.confirmationQuestionDefault,
    });
    expect(draftAutomationSchema.safeParse(definition).success).toBe(true);
    // And the BUTTON with it, from the catalogue too (REQ-332): the label the
    // field is showing is the label that is saved, so what the operator read on
    // the screen is what the contact is going to press.
    expect(confirmation).toMatchObject({
      quick_reply_label: copy.confirmationQuickReplyDefault,
    });
  });

  it("REQ-273: leaves a stored automation exactly as it was stored", async () => {
    const api = client();
    api.read = vi.fn(async () =>
      stored({
        ...STORED_OPENING,
        steps: STORED_OPENING.steps?.filter(
          (step) => step.action !== "confirm_optin",
        ),
      }),
    );
    openAt("?id=comment-2026-08-14t12-00-00-000z");
    render(
      <AutomationFormScreen client={api} assets={assets} finder={finder()} />,
    );

    // An automation that asks no confirmation opens asking none: the default
    // belongs to a NEW automation, and reading it over a stored one would
    // turn on, silently, a question the operator had turned off.
    expect(
      await screen.findByLabelText(copy.emailQuestion),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("checkbox", { name: copy.openingConfirmation }),
    ).not.toBeChecked();
    expect(screen.queryByLabelText(copy.confirmationQuestion)).toBeNull();

    // And turning it on offers the sentence a new automation is born with,
    // rather than an empty field: an automation that never asked has no
    // wording of its own to be given back.
    await userEvent
      .setup()
      .click(screen.getByRole("checkbox", { name: copy.openingConfirmation }));

    expect(screen.getByLabelText(copy.confirmationQuestion)).toHaveValue(
      copy.confirmationQuestionDefault,
    );
  });

  it("leaves no step behind when a question is turned off", async () => {
    const save = vi.fn();
    const api = client(save);
    const user = userEvent.setup();
    api.read = vi.fn(async () => stored(STORED_OPENING));
    openAt("?id=comment-2026-08-14t12-00-00-000z");
    render(
      <AutomationFormScreen client={api} assets={assets} finder={finder()} />,
    );

    const toggle = await screen.findByRole("checkbox", {
      name: copy.openingConfirmation,
    });
    expect(toggle).toBeChecked();

    await user.click(toggle);
    expect(toggle).not.toBeChecked();
    // The wording goes with it: a field left on screen would go on being saved.
    expect(screen.queryByLabelText(copy.confirmationQuestion)).toBeNull();

    await user.click(screen.getByRole("button", { name: copy.activate }));

    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    const definition = save.mock.calls[0]?.[0] as UnifiedAutomation;
    expect(definition.steps?.map((step) => step.action)).toEqual([
      "reply_comment",
      "collect_email",
      "follow_gate",
      "send_dm",
    ]);
    // Not merely absent from the list: absent from the aggregate, wording and
    // all. A step kept with its switch off is a question that still goes out.
    expect(JSON.stringify(definition)).not.toContain("confirm_optin");
    expect(JSON.stringify(definition)).not.toContain("may I send it?");
  });
});

/**
 * REQ-332/REQ-333: the message the product suggests, and the language it is
 * suggested in.
 *
 * The WORDS are the requirement here, and that is why they are written out in
 * this file: every other assertion on this screen compares a field to
 * `copy.<key>`, catalogue against catalogue, so a suggestion quietly replaced
 * by some other sentence would pass all of them. Written out once, they are
 * compared against the catalogue, and the catalogue is what the screen renders.
 *
 * Two details of the text are load-bearing and easy to lose in a retype: the
 * BREAK between the two lines, and the skin tone on the pointing hand, which is
 * a modifier of its own and vanishes silently when the emoji is retyped from
 * memory. Both are asserted rather than assumed.
 */
describe("REQ-332/REQ-333: the suggestion the product makes, in the language in force", () => {
  /** The two lines the operator wrote, with the break he wrote between them. */
  const WRITTEN_QUESTION =
    "\u{1F44B} Que bom te ver por aqui! \u{263A}\u{FE0F}\nClica no bot\u{E3}o abaixo que eu te envio o link \u{1F447}\u{1F3FB}";

  /** And the words on the button that answers it. */
  const WRITTEN_BUTTON = "\u{1F512} Desbloquear o link";

  /** The instance answering what language it is in, which is the only source. */
  function speaking(locale: string): LocaleClient {
    const state: LocaleState = { locale, available: ["en", "pt-BR"] };

    return {
      read: (): Promise<LocaleState> => Promise.resolve(state),
      write: (): Promise<LocaleState> => Promise.resolve(state),
    };
  }

  it("REQ-332: carries the operator's own two lines, and his button, in the catalogue", () => {
    expect(ptBR.screens.automations.confirmationQuestionDefault).toBe(
      WRITTEN_QUESTION,
    );
    expect(ptBR.screens.automations.confirmationQuickReplyDefault).toBe(
      WRITTEN_BUTTON,
    );

    // Two lines, and not one long sentence: the break is part of what he wrote,
    // and a message joined into a single line is a different message.
    expect(WRITTEN_QUESTION.split("\n")).toHaveLength(2);
    // The pointing hand keeps its modifier. `.length` counts UTF-16 units, so
    // the pair costs four: an emoji retyped without the tone costs two.
    expect(WRITTEN_QUESTION.endsWith("\u{1F447}\u{1F3FB}")).toBe(true);
  });

  it("REQ-333: says both of them in English too, and never in Portuguese", () => {
    // Present, so switching the language has somewhere to switch TO, and
    // DIFFERENT, so a catalogue that shipped the Portuguese text under the
    // English key fails here instead of on a contact's screen.
    for (const key of [
      "confirmationQuestionDefault",
      "confirmationQuickReplyDefault",
    ] as const) {
      expect(en.screens.automations[key]).not.toBe("");
      expect(en.screens.automations[key]).not.toBe(
        ptBR.screens.automations[key],
      );
    }
  });

  it("REQ-333: offers both suggestions in the language the instance is in", async () => {
    const pt = ptBR.screens.automations;

    render(
      <LocaleProvider client={speaking("pt-BR")}>
        <AutomationFormScreen client={client()} assets={assets} />
      </LocaleProvider>,
    );

    // Found by the Portuguese label as well as holding the Portuguese text: a
    // screen that switched the labels and kept the suggestion in English is
    // exactly the half-translation this requirement is about.
    expect(await screen.findByLabelText(pt.confirmationQuestion)).toHaveValue(
      WRITTEN_QUESTION,
    );
    expect(screen.getByLabelText(pt.confirmationQuickReply)).toHaveValue(
      WRITTEN_BUTTON,
    );
  });

  it("REQ-333: and offers the English ones when English is the language", async () => {
    render(
      <LocaleProvider client={speaking("en")}>
        <AutomationFormScreen client={client()} assets={assets} />
      </LocaleProvider>,
    );

    expect(await screen.findByLabelText(copy.confirmationQuestion)).toHaveValue(
      copy.confirmationQuestionDefault,
    );
    expect(screen.getByLabelText(copy.confirmationQuickReply)).toHaveValue(
      copy.confirmationQuickReplyDefault,
    );
  });

  it("REQ-332: writes the suggestion of that language into the aggregate", async () => {
    const pt = ptBR.screens.automations;
    const save = vi.fn();
    const user = userEvent.setup();

    render(
      <LocaleProvider client={speaking("pt-BR")}>
        <AutomationFormScreen client={client(save)} assets={assets} />
      </LocaleProvider>,
    );

    // Anything at all, because the bar refuses to save what has not changed.
    await user.type(
      await screen.findByPlaceholderText(pt.keywordsPlaceholder),
      "ebook{enter}",
    );
    await user.click(screen.getByRole("button", { name: pt.saveDraft }));

    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    const definition = save.mock.calls[0]?.[0] as UnifiedAutomation;

    // What the field showed is what is saved, in both halves: a suggestion
    // resolved for the SCREEN and not for the aggregate would send the English
    // sentence to a contact who read the Portuguese one on the editor.
    expect(
      definition.steps?.find((step) => step.action === "confirm_optin"),
    ).toMatchObject({
      text: WRITTEN_QUESTION,
      quick_reply_label: WRITTEN_BUTTON,
    });
  });
});

/**
 * REQ-267: every option of the editor says, under its label, what it is for.
 *
 * The author of the product had to ASK what the deadline, the tries and the
 * three rules were for, which is the whole anchor of this: an option whose
 * meaning is only in the head of whoever drew it is an option nobody can set on
 * purpose. The tip is therefore checked for two things and not one: that the
 * sentence is on the screen at all, and that it sits between the name and the
 * control, which is where it is read before anything is typed.
 */
describe("REQ-267: each option says what it is for, under its label", () => {
  /**
   * The editor with EVERY option opened, which is the only state in which the
   * question "does each one say what it is for" can be asked of all of them:
   * half of these fields do not exist until their switch is on.
   */
  async function everythingOpen(): Promise<void> {
    const user = userEvent.setup();
    openOnPublication();
    render(
      <AutomationFormScreen
        client={client()}
        assets={assets}
        finder={finder()}
      />,
    );
    await screen.findByRole("group", { name: copy.targetChosen });

    // The confirmation is NOT among them: it is on from the first render
    // (REQ-273), and pressing it here would shut the one block this sweep most
    // needs open.
    for (const name of [
      copy.publicReplyToggle,
      copy.openingEmail,
      copy.openingFollow,
    ]) {
      await user.click(screen.getByRole("checkbox", { name }));
    }
    await user.click(screen.getByRole("button", { name: copy.addButton }));
    await user.click(screen.getByRole("button", { name: copy.addCover }));
  }

  /** The element that carries a sentence, whatever tag the block drew it in. */
  function carrying(sentence: string): HTMLElement {
    const found = screen.getByText(sentence);

    return found as HTMLElement;
  }

  it("puts a tip under the name of every option, and never after the control", async () => {
    await everythingOpen();

    // The name on the left, the sentence that explains it on the right. Read
    // off the catalogue and never written here: a pair copied into the test is
    // a pair that goes on passing after the screen stops saying it.
    const pairs: readonly (readonly [string, string])[] = [
      [copy.targetLabel, copy.targetTip],
      [copy.matchByWord, copy.matchByWordNote],
      [copy.fieldKeywords, copy.fieldKeywordsTip],
      [copy.fieldMode, copy.fieldModeTip],
      [copy.matchAnyWord, copy.anyWordNote],
      [copy.publicReplyText, copy.publicReplyTip],
      [copy.openingConfirmation, copy.openingConfirmationNote],
      [copy.confirmationQuestion, copy.confirmationQuestionTip],
      [copy.confirmationQuickReply, copy.confirmationQuickReplyTip],
      [copy.openingEmail, copy.openingEmailNote],
      [copy.emailQuestion, copy.emailQuestionTip],
      [copy.openingFollow, copy.openingFollowNote],
      [copy.followQuestion, copy.followQuestionTip],
      [copy.cardTitle, copy.cardTitleTip],
      [copy.cardDescription, copy.cardDescriptionTip],
      [copy.fieldOnce, copy.fieldOnceNote],
      [copy.firstReplyDelay, copy.firstReplyDelayTip],
    ];

    for (const [name, tip] of pairs) {
      const sentence = carrying(tip);
      // Directly after the name and before anything else: a sentence under the
      // FIELD is a hint about the answer, and the operator reading it has
      // already had to decide without it.
      expect(sentence.previousElementSibling?.textContent).toContain(name);
    }

    // The one that explains a ROW of buttons rather than one field: the
    // sentence still comes after the thing it explains, and there is no label
    // to hang it under because the buttons name themselves.
    expect(
      carrying(copy.addPartsTip).previousElementSibling?.textContent,
    ).toContain(copy.addButton);

    // And the one that reports on the ANSWERS rather than on the option: why a
    // second wording is worth writing is read after the wordings, under the
    // field, which is where a hint belongs (REQ-267).
    const wordings = screen.getByLabelText(copy.publicReplyText);

    expect(
      document.getElementById(
        wordings.getAttribute("aria-describedby")?.split(/\s+/).at(-1) ?? "",
      ),
    ).toHaveTextContent(copy.publicReplyAddTip);

    // The link's two halves are one option in the drawing and two fields here,
    // so the sentence is split along the same seam: what is tapped, and what
    // opens when it is.
    expect(
      carrying(copy.buttonLabelTip).previousElementSibling?.textContent,
    ).toContain(resolve(copy.buttonLabel, { number: 1 }));
    expect(
      carrying(copy.buttonUrlTip).previousElementSibling?.textContent,
    ).toContain(resolve(copy.buttonUrl, { number: 1 }));
  });

  it("announces the tip WITH the control it explains, and not beside it", async () => {
    render(<AutomationFormScreen client={client()} assets={assets} />);

    // Described and not merely nearby: a sentence a screen reader never reaches
    // is a sentence that exists only for whoever is looking at the screen. The
    // message box has no link yet, so it is still a message and not a card.
    const message = screen.getByLabelText(copy.messageBody);

    expect(
      document.getElementById(
        message.getAttribute("aria-describedby")?.split(/\s+/)[0] ?? "",
      ),
    ).toHaveTextContent(copy.messageBodyTip);
    expect(
      message.previousElementSibling?.previousElementSibling?.textContent,
    ).toContain(copy.messageBody);

    const question = screen.getByLabelText(copy.confirmationQuestion);

    expect(
      document.getElementById(
        question.getAttribute("aria-describedby")?.split(/\s+/)[0] ?? "",
      ),
    ).toHaveTextContent(copy.confirmationQuestionTip);
  });

  it("says the wait is the FIRST reply's and names what does not wait", async () => {
    await everythingOpen();

    const tip = screen.getByText(copy.firstReplyDelayTip);
    const group = screen.getByRole("group", { name: copy.firstReplyDelay });

    // The sentence REQ-277 asks for BY NAME, asserted as content: a tip that
    // kept its shape and lost this clause would still render, and the operator
    // would go on believing the pause holds the whole conversation.
    expect(copy.firstReplyDelayTip).toMatch(/first reply only/i);
    expect(copy.firstReplyDelayTip).toMatch(/waits for nothing/i);
    expect(ptBR.screens.automations.firstReplyDelayTip).toMatch(
      /só para a primeira resposta/i,
    );
    expect(ptBR.screens.automations.firstReplyDelayTip).toMatch(
      /não espera nada/i,
    );

    // And it travels WITH the choice rather than sitting near it.
    expect(tip).toBeInTheDocument();
    expect(group.getAttribute("aria-describedby")?.split(/\s+/)).toContain(
      tip.id,
    );
  });

  it("only MENTIONS where the deadline and the questions live", async () => {
    await everythingOpen();

    // The whole explanation moved to Settings (REQ-275). What is left here is
    // one sentence saying where the two live, and the assertion is on what it
    // no longer carries: a note that kept the paragraph would still render.
    expect(screen.getByText(copy.openingSettings)).toBeInTheDocument();
    expect(copy.openingSettings).toMatch(/live in Settings/i);
    expect(copy.openingSettings).not.toMatch(/counts the first one/i);
    expect(copy.openingSettings).not.toMatch(/farewell/i);
    expect(ptBR.screens.automations.openingSettings).toMatch(
      /ficam em Ajustes/i,
    );
    expect(ptBR.screens.automations.openingSettings).not.toMatch(
      /conta a primeira/i,
    );
  });
});

/**
 * REQ-313/REQ-314: the preview stops disagreeing with the delivery.
 *
 * Two lies of one screen, both seen by the operator on 2026-08-19. The preview
 * read no instance setting at all, so renaming the follow button in Settings
 * changed nothing here and the catalogue's default went on being shown as if it
 * were the configuration; and it drew the confirmation as words in a bubble
 * when what arrives is a card. "The confirmation message arrives as a card, but
 * the preview shows it as a message with a link", in his words.
 *
 * It is worse than having no preview at all, and that is the whole reason these
 * two are requirements: he approves the design by LOOKING at this handset, so a
 * preview that disagrees with the delivery turns his approval into an approval
 * of something else.
 */
describe("REQ-313/REQ-314: the preview says what really goes out", () => {
  /** What the operator renamed the follow button to, in Settings. */
  const RENAMED = "Followed it";

  /**
   * The instance answering about the conversation, as `/api/instance/settings`
   * answers: the four values, and the bounds beside them.
   *
   * The same client the Settings screen uses, on purpose (REQ-313): the editor
   * reading those values by a second path would be a second thing to keep in
   * step with the route.
   */
  function settings(
    overrides: Partial<ConversationSettings> = {},
  ): ConversationClient {
    const stored: ConversationSettings = {
      waitHours: 168,
      questions: 3,
      closingMessage: en.instance.closingMessage,
      followButtonLabel: en.instance.followButtonLabel,
      limits: {
        waitHoursMin: 1,
        waitHoursMax: 168,
        questionsMin: 1,
        followButtonLabelChars: 20,
      },
      ...overrides,
    };

    return {
      read: vi.fn(async () => stored),
      // The editor SHOWS the instance's settings and never stores them: the one
      // screen that changes them is Settings, a button away in section 3.
      write: vi.fn(() => Promise.reject(new Error("the editor never writes"))),
    };
  }

  /** Turns the follow request on, which is the step that carries the button. */
  async function withFollow(
    user: ReturnType<typeof userEvent.setup>,
  ): Promise<void> {
    await user.click(
      screen.getByRole("checkbox", { name: copy.openingFollow }),
    );
  }

  it("REQ-313: draws the follow button the operator configured, not the catalogue's default", async () => {
    const user = userEvent.setup();
    render(
      <AutomationFormScreen
        client={client()}
        assets={assets}
        instanceSettings={settings({ followButtonLabel: RENAMED })}
      />,
    );
    await withoutConfirmation(user);
    await withFollow(user);

    // The words that will really be on the button, because the engine reads
    // them from the same place this screen just read them from. The index is
    // asserted to be a real one first: "both are missing" is also "both are in
    // the same message", and it would pass a preview drawing no request at all.
    await waitFor(() => expect(messageAt(RENAMED)).toBeGreaterThan(-1));
    expect(messageAt(copy.previewFollowAsk)).toBe(messageAt(RENAMED));
    // And the catalogue's default is nowhere in the thread. This is the half
    // that fails when the preview goes back to reading `t()`: the default is
    // what an instance answers while nobody has renamed the button, so a
    // preview showing it is indistinguishable from a correct one until the day
    // somebody renames it, which is the day the operator found this.
    expect(messageAt(en.instance.followButtonLabel)).toBe(-1);
  });

  it("REQ-313: says nothing about the button while the instance has not answered", async () => {
    const user = userEvent.setup();
    const unreachable: ConversationClient = {
      read: vi.fn(() => Promise.reject(new Error("500"))),
      write: vi.fn(() => Promise.reject(new Error("500"))),
    };
    render(
      <AutomationFormScreen
        client={client()}
        assets={assets}
        instanceSettings={unreachable}
      />,
    );
    await withoutConfirmation(user);
    await withFollow(user);

    await waitFor(() => expect(unreachable.read).toHaveBeenCalled());

    // The request is still drawn, because it is the automation's own words and
    // this screen has them. What is NOT drawn is a button: with the instance
    // unreachable the only label available is the catalogue's, and showing it
    // would be stating a configuration nobody read.
    const request = conversation()[messageAt(copy.previewFollowAsk)] ?? "";

    expect(request).not.toBe("");
    expect(request).not.toContain(en.instance.followButtonLabel);
    expect(
      within(previewPanel()).queryByText(en.instance.followButtonLabel),
    ).not.toBeInTheDocument();
  });

  it("REQ-314: draws the confirmation as the card it arrives as", async () => {
    const user = userEvent.setup();
    render(
      <AutomationFormScreen
        client={client()}
        assets={assets}
        instanceSettings={settings()}
      />,
    );

    // Born asking (REQ-273), so what is typed here is the wording and the words
    // on the button, never the decision.
    await user.clear(screen.getByLabelText(copy.confirmationQuestion));
    await user.type(
      screen.getByLabelText(copy.confirmationQuestion),
      "may I send it?",
    );
    await user.clear(screen.getByLabelText(copy.confirmationQuickReply));
    await user.type(screen.getByLabelText(copy.confirmationQuickReply), "Yes");

    const panel = previewPanel();
    const question = within(panel).getByText("may I send it?");
    const card = question.closest(".mc-preview-card");

    // A generic template: the words are the element's TITLE and the button is a
    // strip across the foot, exactly as `toMessageBody` sends the private reply
    // that opens a conversation from a comment.
    expect(card).not.toBeNull();
    expect(question).toHaveClass("mc-preview-card__title");
    expect(within(card as HTMLElement).getByText("Yes")).toHaveClass(
      "mc-preview-card__button",
    );

    // And NOT a bubble with a chip stuck under it, which is the drawing that
    // was there and the message nobody receives. Asked of the message itself
    // and not of the panel: the requests that are still quick replies keep
    // their chip, and a query over the whole handset would pass on theirs.
    const message = question.closest("li");

    expect(message).not.toBeNull();
    expect((message as HTMLElement).querySelector(".mc-chip")).toBeNull();
  });

  it("REQ-314: draws the card while the button is emptied, without inventing a strip", async () => {
    const user = userEvent.setup();
    render(
      <AutomationFormScreen
        client={client()}
        assets={assets}
        instanceSettings={settings()}
      />,
    );
    await user.clear(screen.getByLabelText(copy.confirmationQuestion));
    await user.type(
      screen.getByLabelText(copy.confirmationQuestion),
      "may I send it?",
    );
    // The label has to be EMPTIED to reach this state since REQ-332: a new
    // automation is born offering the catalogue's own.
    await user.clear(screen.getByLabelText(copy.confirmationQuickReply));

    const card = within(previewPanel())
      .getByText("may I send it?")
      .closest(".mc-preview-card") as HTMLElement;

    // The instance refuses a confirmation with no button by name, so a strip
    // drawn here would be a card that cannot go out.
    expect(card).not.toBeNull();
    expect(card.querySelectorAll(".mc-preview-card__button")).toHaveLength(0);
  });

  /**
   * How the REQUEST TO FOLLOW is drawn, asked of the message it is in.
   *
   * Never of the panel: the handset holds the delivery's card and other
   * bubbles, so a query over all of it answers about the wrong message and
   * answers "yes, there is a card here" whatever this one is.
   */
  function requestShape(): { readonly card: boolean; readonly chip: boolean } {
    const request = within(previewPanel()).getByText(copy.previewFollowAsk);
    const message = request.closest("li");

    expect(message).not.toBeNull();

    return {
      card: (message as HTMLElement).querySelector(".mc-preview-card") !== null,
      chip: (message as HTMLElement).querySelector(".mc-chip") !== null,
    };
  }

  it("REQ-314: draws the request to follow as the bubble with a chip it arrives as", async () => {
    const user = userEvent.setup();
    render(
      <AutomationFormScreen
        client={client()}
        assets={assets}
        instanceSettings={settings({ followButtonLabel: RENAMED })}
      />,
    );
    // The confirmation stays ON, which is how a new automation is born
    // (REQ-273) and what makes this the ordinary case: it is the message that
    // spends the private reply, so everything behind it is addressed by
    // contact and its button is a native quick reply.
    await withFollow(user);

    await waitFor(() => expect(messageAt(RENAMED)).toBeGreaterThan(-1));

    expect(requestShape()).toEqual({ card: false, chip: true });
  });

  it("REQ-314: draws it as the card when it is the first message of the run", async () => {
    const user = userEvent.setup();
    render(
      <AutomationFormScreen
        client={client()}
        assets={assets}
        instanceSettings={settings({ followButtonLabel: RENAMED })}
      />,
    );
    // With nothing before it, the request IS the message that opens the
    // conversation from the comment, and the platform gives that one no quick
    // reply at all: it travels as a generic template with a postback strip.
    await withoutConfirmation(user);
    await withFollow(user);

    await waitFor(() => expect(messageAt(RENAMED)).toBeGreaterThan(-1));

    expect(requestShape()).toEqual({ card: true, chip: false });

    // And the words the instance carries are ON the strip, not beside it.
    expect(within(previewPanel()).getByText(RENAMED)).toHaveClass(
      "mc-preview-card__button",
    );
  });

  it("REQ-314: draws it as the bubble in a direct message automation, first or not", async () => {
    const user = userEvent.setup();
    openAt("?trigger=direct_message");
    render(
      <AutomationFormScreen
        client={client()}
        assets={assets}
        instanceSettings={settings({ followButtonLabel: RENAMED })}
      />,
    );
    // No comment to answer, so there is no private reply to be first in line
    // for: the position that makes a card in the automation above makes none
    // here. A direct message does not offer confirmation either (REQ-349).
    await withFollow(user);

    await waitFor(() => expect(messageAt(RENAMED)).toBeGreaterThan(-1));

    expect(requestShape()).toEqual({ card: false, chip: true });
  });
});

describe("REQ-349 / ADR-026: direct-message automations do not offer confirmation", () => {
  it("omits the confirmation block and activates without its fields", async () => {
    const save = vi.fn();
    const user = userEvent.setup();
    openAt("?trigger=direct_message");
    render(<AutomationFormScreen client={client(save)} assets={assets} />);

    expect(
      screen.queryByRole("group", { name: copy.openingConfirmation }),
    ).toBeNull();
    expect(screen.queryByLabelText(copy.confirmationQuestion)).toBeNull();
    expect(screen.queryByLabelText(copy.confirmationQuickReply)).toBeNull();

    await user.type(
      screen.getByPlaceholderText(copy.keywordsPlaceholder),
      "guide{enter}",
    );
    await user.type(screen.getByLabelText(copy.messageBody), "here it is");
    await user.click(screen.getByRole("button", { name: copy.activate }));

    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    const definition = save.mock.calls[0]?.[0] as UnifiedAutomation;
    expect(definition.steps?.map((step) => step.action)).toEqual(["send_dm"]);
  });

  it("draws no confirmation, and no answer to it, in a direct message automation", () => {
    openAt("?trigger=direct_message");
    render(<AutomationFormScreen client={client()} assets={assets} />);

    // Neither the question the catalogue writes for it nor the answer the
    // preview used to put under it. Both halves matter: a preview that kept
    // the answer would show the contact agreeing to something they were never
    // asked.
    expect(messageAt(copy.confirmationQuestionDefault)).toBe(-1);
    expect(messageAt(copy.previewAnswerConfirmed)).toBe(-1);

    // What the contact really lives: they write, and the delivery lands.
    expect(conversation()).toHaveLength(2);
    expect(messageAt(copy.previewMessage)).toBe(1);
  });

  it("names no stretch the delivery did not earn", async () => {
    const user = userEvent.setup();
    openAt("?trigger=direct_message");
    render(<AutomationFormScreen client={client()} assets={assets} />);

    // "Only then, the delivery" is the sentence that explains why the delivery
    // is last, and it is only true after a question. With the one question
    // suppressed the delivery is simply what lands in the inbox, and the
    // preview that still said "only then" would be arguing for a message
    // order the run does not have.
    expect(stretches()).toEqual([copy.previewStepDirect]);

    // And the moment a question that IS asked joins it, the sentence comes
    // back: the e-mail question is not suppressed by anything.
    await user.click(screen.getByRole("checkbox", { name: copy.openingEmail }));

    expect(stretches()).toEqual([
      copy.previewStepDirect,
      copy.previewStepOpens,
      copy.previewStepDelivery,
    ]);
  });

  it("draws the confirmation of a comment automation, which is asked", async () => {
    const user = userEvent.setup();
    render(<AutomationFormScreen client={client()} assets={assets} />);

    // The other side of the same rule, and the half that fails if the
    // suppression is written as "the confirmation is never drawn": a comment
    // does not open a conversation, so the question goes out, and the preview
    // that swallowed it here would hide the one message the platform obliges.
    expect(messageAt(copy.confirmationQuestionDefault)).toBe(0);
    // The answer is the BUTTON, which a new automation is also born carrying
    // (REQ-332), so the preview no longer stands in for it. Read off the line
    // rather than searched for: the question above carries the same label on
    // its strip, and a search would answer about that message instead.
    expect(conversation()[1]).toContain(copy.confirmationQuickReplyDefault);
    expect(messageAt(copy.previewAnswerConfirmed)).toBe(-1);
    // Including after it is written into, which is the state the operator
    // approves the design in.
    await user.clear(screen.getByLabelText(copy.confirmationQuestion));
    await user.type(
      screen.getByLabelText(copy.confirmationQuestion),
      "may I send it?",
    );

    expect(messageAt("may I send it?")).toBe(0);
  });
});

/**
 * REQ-271: the preview is the PRIVATE conversation, and nothing else.
 *
 * "For the miniature preview we will only do the DM, there will be no preview
 * for the post", wrote the operator on 2026-08-17. What used to be drawn inside
 * the handset was a comment and a public reply, which happen on the publication
 * and are read on Instagram: a phone showing them was showing a screen that
 * does not exist.
 */
describe("REQ-271: the preview holds the private conversation only", () => {
  it("draws neither the comment nor the public reply, whatever is written into them", async () => {
    const user = userEvent.setup();
    render(<AutomationFormScreen client={client()} assets={assets} />);

    await user.type(
      screen.getByPlaceholderText(copy.keywordsPlaceholder),
      "ebook{enter}",
    );
    await user.click(screen.getByLabelText(copy.publicReplyToggle));
    await user.type(
      screen.getByLabelText(copy.publicReplyText),
      "sent you a message{enter}",
    );
    await user.type(screen.getByLabelText(copy.messageBody), "here is the pdf");
    // The delivery alone, which is only true with nothing opening the
    // conversation: a new automation opens with the confirmation on (REQ-273).
    await withoutConfirmation(user);

    const thread = conversation().join(" ");

    // The word the person commented, and the answer that goes under it: both
    // are on the publication, and the publication is not previewed.
    expect(thread).not.toContain("ebook");
    expect(thread).not.toContain("sent you a message");
    expect(thread).toContain("here is the pdf");
    // And no placeholder standing in for either of them while they are empty.
    expect(conversation()).toHaveLength(1);
  });

  it("shapes only the private delivery, so a public reply changes nothing", async () => {
    const user = userEvent.setup();
    render(<AutomationFormScreen client={client()} assets={assets} />);

    await user.type(screen.getByLabelText(copy.messageBody), "here is the pdf");
    await withoutConfirmation(user);
    expect(
      screen.getByText(shape(copy.deliveryPartMessage)),
    ).toBeInTheDocument();

    await user.click(screen.getByLabelText(copy.publicReplyToggle));
    await user.type(
      screen.getByLabelText(copy.publicReplyText),
      "check inbox{enter}",
    );

    // Still the same one message. A reply under the publication is not a
    // message in the inbox at all, and a sentence that grew with it would tell
    // the operator they send one more than they do.
    expect(
      screen.getByText(shape(copy.deliveryPartMessage)),
    ).toBeInTheDocument();
  });

  it("names itself the inbox preview, and says why the publication is missing", () => {
    render(<AutomationFormScreen client={client()} assets={assets} />);

    expect(
      screen.getByRole("heading", { name: copy.previewTitle }),
    ).toBeInTheDocument();
    // An absence nobody explains reads as a defect: the operator who wrote a
    // public reply has to be told where it went, and why.
    expect(copy.previewLegend).toMatch(/publication has no preview/i);
    expect(screen.getByText(copy.previewLegend)).toBeInTheDocument();
  });

  it("keeps the direct message entrance's own first message, which IS private", async () => {
    const user = userEvent.setup();
    openAt("?trigger=direct_message");
    render(<AutomationFormScreen client={client()} assets={assets} />);

    await user.type(
      screen.getByPlaceholderText(copy.keywordsPlaceholder),
      "guide{enter}",
    );

    // What REQ-271 takes out is what happens on the PUBLICATION. A message the
    // person sends to the inbox is the private conversation starting, so it
    // stays: cutting it would leave that entrance's preview beginning with an
    // answer to nothing.
    expect(messageAt("guide")).toBe(0);
    expect(conversation()[0]).toContain(copy.previewWhoContact);
  });
});

/* ------------------------------------------------------------------ *
 * REQ-269: on a handset the chosen publication and its action GROW
 * ------------------------------------------------------------------ */

/**
 * Guarded the way REQ-225 above is guarded, and for the same reason: jsdom
 * applies no stylesheet, so nothing here proves what a phone LOOKS like. What
 * it proves is the half that rots, and here that half is arithmetic rather than
 * a rule merely existing.
 *
 * "Bigger on a handset than on the desktop" is a comparison, so it is COMPUTED
 * from the two declarations rather than restated: the thumbnail's desktop
 * `width` against its handset `max-width`, and the button's ordinary floor
 * against the one the handset rule gives it. A media query that was written and
 * then edited down to the same numbers passes a `toContain` and fails this.
 *
 * The button's handset height is deliberately checked to be DERIVED from
 * `--tap` and not written out. REQ-269 asks for a bigger button; REQ-268 says
 * there is one tap size. A second literal here would satisfy the first and
 * quietly break the second, which is exactly the shape of the defect that put
 * `.mc-btn--sm` in the sheet in the first place.
 *
 * The pixels themselves were read in a browser at 320, 390, 768 and 1440, in
 * both themes.
 */

const SPACING = import.meta.glob<string>("../styles/tokens/spacing.css", {
  eager: true,
  query: "?raw",
  import: "default",
});

const SPACING_SHEET = Object.values(SPACING)[0] ?? "";

/** What a rem is worth to a reader who changed nothing. */
const ROOT_FONT_PX = 16;

/** The value of a spacing token, in pixels at the default root size. */
function tokenPx(name: string): number {
  const written = new RegExp(`${name}\\s*:\\s*([\\d.]+)rem`).exec(
    SPACING_SHEET,
  );

  expect(written, `${name} is not a rem length in the spacing sheet`).not.toBe(
    null,
  );

  return Number(written?.[1] ?? Number.NaN) * ROOT_FONT_PX;
}

/**
 * A length declared in a block, in pixels.
 *
 * The boundary before the property name is what keeps `width` from reading
 * `max-width`: a hyphen is not whitespace, a brace or a semicolon.
 */
function lengthPx(block: string, property: string): number {
  const written = new RegExp(
    `(?:^|[;{\\s])${property}\\s*:\\s*([\\d.]+)rem`,
  ).exec(block);

  expect(written, `${property} is not a rem length in this block`).not.toBe(
    null,
  );

  return Number(written?.[1] ?? Number.NaN) * ROOT_FONT_PX;
}

/** The cutoff of a `max-width` media query, in rem. */
function cutoffOf(query: string): number {
  return Number(/max-width:\s*([\d.]+)rem/.exec(query)?.[1] ?? Number.NaN);
}

const HANDSET = "@media (max-width: 35rem)";
const NARROW = "@media (max-width: 48rem)";

describe("REQ-269: on a handset the publication and its button grow", () => {
  it("asks a narrower question than the one-column cutoff, and nests in it", () => {
    // A sweep that read an empty module would pass everything below forever.
    expect(COMPONENT_SHEET.length).toBeGreaterThan(0);
    expect(COMPONENT_SHEET).toContain(HANDSET);
    expect(COMPONENT_SHEET).toContain(NARROW);

    // Two cutoffs answering two different questions. The wider one asks "is
    // there room for two columns", and a tablet answers no along with a phone;
    // this one asks "is this being held in one hand", and a tablet answers yes
    // to the first and no to the second. Nested rather than competing, so
    // everything true of a phone is already true of the narrow layout.
    expect(cutoffOf(HANDSET)).toBeLessThan(cutoffOf(NARROW));
  });

  it("stacks the strip, so the picture is not sharing 320px with a button", () => {
    const handset = blockAfter(
      blockAfter(COMPONENT_SHEET, HANDSET),
      ".mc-target {",
    );

    expect(handset).toContain("flex-direction: column;");
    expect(handset).toContain("align-items: stretch;");
  });

  it("makes the thumbnail bigger than the one on the desktop", () => {
    const desktop = blockAfter(COMPONENT_SHEET, ".mc-target__frame {");
    const handset = blockAfter(
      blockAfter(COMPONENT_SHEET, HANDSET),
      ".mc-target__frame {",
    );

    // The picture is the only thing on the screen that says WHICH publication
    // this automation answers. Compared as numbers: a handset rule that had
    // been edited down to the desktop size would still contain both properties.
    expect(lengthPx(handset, "max-width")).toBeGreaterThan(
      lengthPx(desktop, "width"),
    );

    // Full width up to that cap, and square, so it fills a 320px screen instead
    // of sitting at a fixed size in the middle of it.
    expect(handset).toContain("width: 100%;");
    expect(handset).toContain("aspect-ratio: 1;");
  });

  it("makes the button bigger than a button anywhere else", () => {
    const handset = blockAfter(
      blockAfter(COMPONENT_SHEET, HANDSET),
      ".mc-target__change {",
    );

    // The whole line, and no longer pushed to the end of a row by free space.
    expect(handset).toContain("width: 100%;");

    // Taller than the ordinary floor, and DERIVED from it: the one tap size
    // plus a step of the spacing ladder, never a second size invented for the
    // phone (REQ-268).
    const step =
      /min-height:\s*calc\(var\(--tap\)\s*\+\s*var\((--space-\d+)\)\)/.exec(
        handset,
      );

    expect(step, "the handset button is not derived from var(--tap)").not.toBe(
      null,
    );

    // And the arithmetic says "bigger", rather than the reader having to.
    const floor = tokenPx("--tap");
    const grown = floor + tokenPx(step?.[1] ?? "");

    expect(grown).toBeGreaterThan(floor);
  });

  it("gives the ordinary button that ordinary floor, which is the token", () => {
    // The other end of the comparison above, read from the sheet rather than
    // assumed: `.mc-btn` is what the button in this block is on every other
    // viewport, and `styles/tokens.test.ts` is what keeps it single.
    expect(blockAfter(COMPONENT_SHEET, ".mc-btn {")).toContain(
      "min-height: var(--tap);",
    );
  });
});

/**
 * REQ-277: the wait is ONE adjustment of the automation, off a closed ruler.
 *
 * The step it replaces did nothing at all. The editor always appended it LAST,
 * after the public reply and the private message had already been composed, so
 * an operator who switched it on and typed thirty seconds got exactly the
 * messages they got with it off, at exactly the same instants. Task 3l.15 moved
 * the decision to `rules.first_reply_delay_seconds` and made the runtime honour
 * it; this is the half the operator can see.
 *
 * The ruler is the CONTRACT's, and that is what these check hardest: the screen
 * may not offer a sixth value, because the schema refuses one at the save, and
 * it may not stop offering one the schema still accepts.
 */
describe("REQ-277: the wait is a closed ruler, before the first reply only", () => {
  /** The ruler as the group draws it, in the order the options are offered. */
  function ruler(): readonly HTMLInputElement[] {
    return within(
      screen.getByRole("group", { name: copy.firstReplyDelay }),
    ).getAllByRole("radio") as HTMLInputElement[];
  }

  it("offers exactly the waits the contract accepts, and no others", () => {
    render(<AutomationFormScreen client={client()} assets={assets} />);

    // Read off the schema, never listed here: a ruler retyped in the test would
    // agree with a ruler retyped in the screen while both disagreed with the
    // one thing that refuses a value at the save.
    expect(ruler().map((option) => Number(option.value))).toEqual([
      ...FIRST_REPLY_DELAY_CHOICES,
    ]);
    expect(
      ruler().map((option) => option.labels?.[0]?.textContent?.trim()),
    ).toEqual(FIRST_REPLY_DELAY_CHOICES.map((seconds) => waitOption(seconds)));

    // And every box, asked of the CONTRACT itself: a sixth one on this screen
    // would be a value refused at the save, which the operator would meet as a
    // failure after choosing rather than as an option that was never offered.
    for (const option of ruler())
      expect(
        draftAutomationSchema.safeParse({
          schema_version: 2,
          kind: "automation",
          id: "comment-2026-08-14t12-00-00-000z",
          state: "draft",
          rules: {
            once_per_contact: true,
            first_reply_delay_seconds: Number(option.value),
          },
        }).success,
        `the ruler offers ${option.value}, which the schema refuses`,
      ).toBe(true);
  });

  it("opens on the contract's default, and writes it as a NUMBER", async () => {
    const save = vi.fn();
    const user = userEvent.setup();
    render(<AutomationFormScreen client={client(save)} assets={assets} />);
    await user.click(
      screen.getByRole("radio", { name: copy.scopeNextPublication }),
    );

    await withoutConfirmation(user);
    expect(
      screen.getByRole("radio", {
        name: waitOption(DEFAULT_FIRST_REPLY_DELAY_SECONDS),
      }),
    ).toBeChecked();

    await user.type(screen.getByLabelText(copy.messageBody), "here it is");
    await user.click(screen.getByRole("button", { name: copy.saveDraft }));

    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    const definition = save.mock.calls[0]?.[0] as UnifiedAutomation;

    // A number and never the text of a field: the schema refuses a string, so
    // a screen that stored "5" would hold nothing back at all, and the refusal
    // would arrive at the save instead of at the choice.
    expect(definition.rules?.first_reply_delay_seconds).toBe(
      DEFAULT_FIRST_REPLY_DELAY_SECONDS,
    );
    expect(typeof definition.rules?.first_reply_delay_seconds).toBe("number");
    // Proven against the contract itself and not only against a number: this
    // is the shape that decides whether the aggregate can be stored at all.
    expect(draftAutomationSchema.safeParse(definition).success).toBe(true);
  });

  it("writes immediate as a DECLARED zero, and leaves no delay step behind", async () => {
    const save = vi.fn();
    const user = userEvent.setup();
    render(<AutomationFormScreen client={client(save)} assets={assets} />);

    await withoutConfirmation(user);
    await user.type(screen.getByLabelText(copy.messageBody), "here it is");
    await user.click(screen.getByRole("radio", { name: waitOption(0) }));
    await user.click(screen.getByRole("button", { name: copy.saveDraft }));

    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    const definition = save.mock.calls[0]?.[0] as UnifiedAutomation;

    // Zero DECLARED and not the field omitted: absence is the default of five,
    // so an editor that wrote nothing for "immediately" would store the one
    // behaviour the requirement exists to prevent.
    expect(definition.rules?.first_reply_delay_seconds).toBe(0);
    expect(definition.steps?.map((step) => step.action)).not.toContain("delay");
  });

  it("reopens a stored automation on the wait it was saved with", async () => {
    const api = client();
    api.read = vi.fn(async () =>
      stored({
        ...STORED_OPENING,
        rules: { once_per_contact: true, first_reply_delay_seconds: 30 },
      }),
    );
    openAt("?id=comment-2026-08-14t12-00-00-000z");
    render(
      <AutomationFormScreen client={api} assets={assets} finder={finder()} />,
    );

    expect(
      await screen.findByRole("radio", { name: waitOption(30) }),
    ).toBeChecked();
    expect(
      screen.getByRole("radio", {
        name: waitOption(DEFAULT_FIRST_REPLY_DELAY_SECONDS),
      }),
    ).not.toBeChecked();
  });

  it("opens on the default when the stored wait is off the ruler", async () => {
    const api = client();
    // A value the TYPE forbids and HTTP can still deliver: the aggregate
    // arrives as parsed JSON, so this is a thing that can be held. Left
    // unmatched the group would draw five options with none of them selected,
    // and whatever the operator pressed next is what they would save.
    api.read = vi.fn(async () =>
      stored({
        ...STORED_OPENING,
        rules: { once_per_contact: true, first_reply_delay_seconds: 7 },
      } as unknown as UnifiedAutomation),
    );
    openAt("?id=comment-2026-08-14t12-00-00-000z");
    render(
      <AutomationFormScreen client={api} assets={assets} finder={finder()} />,
    );

    expect(
      await screen.findByRole("radio", {
        name: waitOption(DEFAULT_FIRST_REPLY_DELAY_SECONDS),
      }),
    ).toBeChecked();
    expect(
      ruler()
        .filter((option) => option.checked)
        .map((option) => option.value),
    ).toEqual([String(DEFAULT_FIRST_REPLY_DELAY_SECONDS)]);
  });

  it("says the choice back in words, and says a different thing for zero", async () => {
    const user = userEvent.setup();
    render(<AutomationFormScreen client={client()} assets={assets} />);

    // Read through the group's own description, so the sentence is the one a
    // screen reader reaches and not merely one drawn nearby.
    const spoken = (): string => {
      const described = screen
        .getByRole("group", { name: copy.firstReplyDelay })
        .getAttribute("aria-describedby")
        ?.split(/\s+/)
        .map((id) => document.getElementById(id)?.textContent ?? "");

      return described?.join(" ") ?? "";
    };

    // Five seconds is a length; what the operator chose is which messages wait.
    expect(spoken()).toContain(
      resolve(copy.firstReplyEcho, {
        wait: resolve(copy.firstReplyEchoSeconds_other, {
          count: DEFAULT_FIRST_REPLY_DELAY_SECONDS,
        }),
      }),
    );
    // The reason the ruler opens at five and not at "immediately" is read with
    // the choice, not looked up somewhere else.
    expect(spoken()).toContain(copy.firstReplyDelayReason);

    await user.click(screen.getByRole("radio", { name: waitOption(60) }));
    expect(spoken()).toContain(
      resolve(copy.firstReplyEcho, {
        wait: resolve(copy.firstReplyEchoMinutes_one, { count: 1 }),
      }),
    );

    // Zero is not "waits zero seconds": it is a different sentence, because it
    // is a different behaviour.
    await user.click(screen.getByRole("radio", { name: waitOption(0) }));
    expect(spoken()).toContain(copy.firstReplyEchoImmediate);
    expect(spoken()).not.toContain(copy.firstReplyEcho.split("{{")[0]);
  });

  it("REQ-297: carries no box about the other two waits, in the screen or in the drawing", () => {
    render(<AutomationFormScreen client={client()} assets={assets} />);

    // The choice keeps its own two sentences, which say what IT decides.
    expect(screen.getByText(copy.firstReplyDelayReason)).toBeInTheDocument();
    // And the editor at rest draws no notice at all: the box explained a pause
    // between a message and its attachment, and the attachment left the product
    // with REQ-284, so it had gone on explaining something that no longer
    // happens. Counted over the document rather than matched by its words: a
    // sentence cannot be asserted absent once the catalogue no longer carries
    // it, and the count fails whatever wording a box came back with.
    expect(document.querySelectorAll(".mc-notice")).toHaveLength(0);

    // Both keys gone from BOTH languages, which is also what keeps the
    // catalogue's own guard quiet: `i18n/catalogue.test.ts` refuses a key no
    // code asks for, in either locale.
    for (const catalogue of [en, ptBR]) {
      expect(catalogue.screens.automations).not.toHaveProperty(
        "firstReplyThreeWaitsTitle",
      );
      expect(catalogue.screens.automations).not.toHaveProperty(
        "firstReplyThreeWaits",
      );
    }

    // And out of the drawing, which is the half that gets forgotten: the
    // prototype is the specification in this project, so a box still drawn
    // there is a box somebody puts back. Matched on the two strings that
    // belonged to the box alone, its heading and the class its layout used.
    expect(PROTOTYPE).not.toContain("Três esperas");
    expect(PROTOTYPE).not.toContain("note-flat");
  });
});

/**
 * REQ-334: the editor MENTIONS the two settings and opens nothing.
 *
 * The note used to carry the whole explanation, three sentences of it, across
 * the path of somebody who only wanted to switch a request on (REQ-275). What
 * replaced the paragraph was a mention AND a button, and the button is what
 * this requirement takes out: a decision of 18/08 asked for it, and a later one
 * about the same control asked for it gone. The mention is the half that stays,
 * so the operator still learns WHERE the deadline and the number of questions
 * are decided, and the rail beside every screen is how they get there.
 *
 * Asserted three times over, because a removal has three places to survive in:
 * the screen, the catalogue (an orphan key is a button somebody restores) and
 * the drawing, which is the specification in this project.
 */
describe("REQ-334: no control on the editor opens Settings", () => {
  /** The optional blocks open too: a control cannot hide inside a shut gate. */
  async function everythingOpen(): Promise<void> {
    const user = userEvent.setup();
    render(<AutomationFormScreen client={client()} assets={assets} />);

    for (const name of [
      copy.publicReplyToggle,
      copy.openingEmail,
      copy.openingFollow,
    ]) {
      await user.click(screen.getByRole("checkbox", { name }));
    }
  }

  it("keeps the mention that says where the two values are decided", async () => {
    await everythingOpen();

    // The half of REQ-275 that survives: the editor still says the deadline and
    // the number of questions live in Settings. Taking the button out must not
    // take the sentence with it.
    expect(screen.getByText(copy.openingSettings)).toBeInTheDocument();
  });

  it("draws no button and no link that goes to Settings", async () => {
    await everythingOpen();

    // Named, in either language, by whatever a restored control would be
    // called: the word is what the operator reads on it.
    for (const name of [/settings/i, /ajustes/i]) {
      expect(screen.queryByRole("button", { name })).toBeNull();
      expect(screen.queryByRole("link", { name })).toBeNull();
    }

    // And by the ADDRESS, which is what a control drawn as neither would still
    // carry: the sentence naming Settings is a paragraph, and a paragraph has
    // no destination.
    expect(document.querySelector('[href="/settings"]')).toBeNull();
  });

  it("leaves no orphan key behind, in either language", () => {
    // The catalogue's own guard refuses a key no code asks for
    // (`i18n/catalogue.test.ts`), and this is the same fact from the other
    // side: the word that was on the button is gone from both locales.
    for (const catalogue of [en, ptBR]) {
      expect(catalogue.screens.automations).not.toHaveProperty(
        "openingSettingsOpen",
      );
      // The mention keeps its key in both, which is what the screen renders.
      expect(catalogue.screens.automations).toHaveProperty("openingSettings");
    }
  });

  it("leaves no button in the drawing either", () => {
    // The half that gets forgotten: a control still drawn in the prototype is a
    // control somebody puts back. Matched on the words that were on it.
    expect(PROTOTYPE).not.toContain("Abrir a tela de Ajustes");
  });
});

/**
 * REQ-282: the three opening questions are boxes for a SENTENCE.
 *
 * The drawing gives them the compact box, 56px, and gives the private message
 * the full one: what is asked to open a conversation is a line, and what is
 * delivered is a paragraph. The height itself is a stylesheet matter and there
 * is no layout here to measure, so what is asserted is what the screen decides
 * and the stylesheet only obeys: which control each field is drawn as, and
 * which of them carry the compact variant. Asserted per field, and with the two
 * that must NOT have it in the same render, because a class checked for
 * anywhere on the page is a class no mistake can lose.
 */
describe("REQ-282: the opening questions use the compact box", () => {
  it("gives the compact box to the three questions and to nothing else", async () => {
    const user = userEvent.setup();
    render(<AutomationFormScreen client={client()} assets={assets} />);

    // The confirmation is already on (REQ-273); the other two are revealed by
    // their own switch, and their fields do not exist until it is pressed.
    for (const name of [copy.openingEmail, copy.openingFollow])
      await user.click(screen.getByRole("checkbox", { name }));

    for (const label of [
      copy.confirmationQuestion,
      copy.emailQuestion,
      copy.followQuestion,
    ]) {
      const question = screen.getByLabelText(label);

      expect(question.tagName).toBe("TEXTAREA");
      // Both classes, and the base one is not a formality: the variant only
      // lowers the floor, so an element carrying it alone has the height and
      // none of the surface, the border or the resizing that make it a box.
      expect(question).toHaveClass("mc-textarea", "mc-textarea--compact");
    }

    // The message is the paragraph the questions are not, and it keeps the full
    // box: the operator writes what is delivered in it.
    const message = screen.getByLabelText(copy.messageBody);

    expect(message.tagName).toBe("TEXTAREA");
    expect(message).not.toHaveClass("mc-textarea--compact");

    // And the button's wording is a couple of words, so it is not a box at all.
    const button = screen.getByLabelText(copy.confirmationQuickReply);

    expect(button.tagName).toBe("INPUT");
    expect(button).not.toHaveClass("mc-textarea--compact");
  });
});

/**
 * REQ-295: the editor asks before it throws away what nobody saved.
 *
 * It used to discard it without a word. The exits of this screen are the way
 * back to the listing and the way out beside the two commits, and both of them
 * left with the work: an operator who wrote a message and reached for the wrong
 * button lost the message. A third one, the shortcut to Settings, was drawn
 * here until REQ-334 took it out; the guard did not change with it, because it
 * is on the function that changes the address and not on the controls.
 *
 * The question is the application's own dialog, which is what the approved
 * drawing draws: `confirm()` carries neither of the two words the drawing names
 * and looks like nothing else on the screen. What it asks about is exactly what
 * the bar already reports, so the screen never warns about work it says is
 * saved, and never stays silent over work it says is not.
 */
const EDITOR = "/automations/form";

/** The shortest real change: a message the operator typed and did not save. */
async function change(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.type(screen.getByLabelText(copy.messageBody), "here it is");
  expect(screen.getByText(copy.stateUnsaved)).toBeInTheDocument();
}

describe("REQ-295: leaving with a pending change asks before discarding it", () => {
  it("holds the way back, and stays where the work is while it asks", async () => {
    const user = userEvent.setup();
    render(<AutomationFormScreen client={client()} assets={assets} />);
    await change(user);

    await user.click(screen.getByRole("link", { name: copy.back }));

    const asked = screen.getByRole("dialog", { name: copy.leaveTitle });

    // The consequence is spelled out, because a question with no consequence is
    // a question nobody can answer.
    expect(within(asked).getByText(copy.leaveConsequence)).toBeInTheDocument();
    expect(window.location.pathname).toBe(EDITOR);

    // And the answer that costs nothing puts the operator back in the editor,
    // with what was typed still in it.
    await user.click(within(asked).getByText(copy.leaveStay));

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(window.location.pathname).toBe(EDITOR);
    expect(screen.getByLabelText(copy.messageBody)).toHaveValue("here it is");
  });

  it("goes where it was asked to go once the answer is the other one", async () => {
    const user = userEvent.setup();
    render(<AutomationFormScreen client={client()} assets={assets} />);
    await change(user);

    await user.click(screen.getByRole("link", { name: copy.back }));
    await user.click(screen.getByRole("button", { name: copy.leaveConfirm }));

    expect(window.location.pathname).toBe("/automations");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  // A case stood here, over the shortcut to Settings: it proved the guard lands
  // on the address that was ASKED for and not always on the listing. It left
  // with the control it pressed (REQ-334), and nothing on this screen replaces
  // it: every exit drawn here now goes to the listing. What still holds the
  // rule is the guard's own shape, which takes the address as its argument.

  it("asks nothing when there is nothing to lose", async () => {
    const user = userEvent.setup();
    render(<AutomationFormScreen client={client()} assets={assets} />);

    await user.click(screen.getByRole("link", { name: copy.back }));

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(window.location.pathname).toBe("/automations");
  });

  it("asks nothing after a save, because the save is what was pending", async () => {
    const user = userEvent.setup();
    const save = vi.fn();
    render(<AutomationFormScreen client={client(save)} assets={assets} />);
    await change(user);

    await user.click(screen.getByRole("button", { name: copy.saveDraft }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(await screen.findByText(copy.stateSaved)).toBeInTheDocument();

    await user.click(screen.getByRole("link", { name: copy.back }));

    // A screen that went on holding the exit here would be a screen asking the
    // operator to confirm the loss of something it had just written down.
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(window.location.pathname).toBe("/automations");
  });

  it("asks nothing on the way out of a save that CREATED the automation", async () => {
    const user = userEvent.setup();

    render(<AutomationFormScreen client={creating()} assets={assets} />);
    await change(user);

    await user.click(screen.getByRole("button", { name: copy.saveDraft }));

    // The instance wrote the automation down and the editor leaves for it in
    // the same breath, before React has rendered the fact: the comparison that
    // decides still reads the draft as it stood one instant earlier. A question
    // here would be asking the operator to confirm the loss of exactly what
    // they had just saved, and it would be asked over an exit nobody chose.
    await waitFor(() => expect(window.location.pathname).toBe("/automations"));
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

/**
 * REQ-295: the warning reaches the tabs of the rail.
 *
 * The way out the operator uses most is not one the editor draws. The shell
 * puts the rail beside the screen, and a tab of it used to replace the editor
 * without a word, which left the requirement promising something the interface
 * did not do: three exits asked, and the commonest one did not.
 *
 * What closes it is a channel and not a fourth copy of the question. The editor
 * hands a guard to the NAVIGATION, which is already the one way the address
 * changes (REQ-146), and the rail arrives at that same function through the
 * shell. So the tabs are covered by the door they were already going through,
 * and the shell needed no knowledge of the editor to do it.
 *
 * The interface is assembled here as it really is, with the root component and
 * the real rail around a real editor: a test that wired a tab of its own would
 * prove a thing about the test.
 */
describe("REQ-295: the tabs of the rail ask before they discard the work", () => {
  const LISTING = "listing";
  const PANEL = "panel";

  /** One client for the table, because the table is built once. */
  const automations = client();

  /**
   * The addresses this proof needs, at the paths the shipped table registers
   * them under. The rail's own destinations come from the shell either way: it
   * draws them, not this table.
   */
  const table: readonly RouteEntry[] = [
    {
      path: EDITOR,
      Screen: () => (
        <AutomationFormScreen client={automations} assets={assets} />
      ),
      rail: false,
      parent: "/automations",
    },
    { path: "/automations", Screen: () => <div data-testid={LISTING} /> },
    { path: "/dashboard", Screen: () => <div data-testid={PANEL} /> },
  ];

  /** The rail's destination, found by where it leads and not by its wording. */
  function tab(path: string): HTMLElement {
    const link = within(screen.getByRole("navigation"))
      .getAllByRole("link")
      .find((candidate) => candidate.getAttribute("href") === path);

    if (link === undefined) {
      throw new Error(`no destination of the rail leads to ${path}`);
    }

    return link;
  }

  function openEditor(): void {
    render(<App routes={table} pathname={EDITOR} />);
  }

  it("holds the tab, and stays where the work is while it asks", async () => {
    const user = userEvent.setup();

    openEditor();
    await change(user);

    await user.click(tab("/automations"));

    expect(
      screen.getByRole("dialog", { name: copy.leaveTitle }),
    ).toBeInTheDocument();
    // Held means held: the address did not move and the screen behind the
    // question is still the editor, with what was typed still in it.
    expect(window.location.pathname).toBe(EDITOR);
    expect(screen.queryByTestId(LISTING)).toBeNull();
    expect(screen.getByLabelText(copy.messageBody)).toHaveValue("here it is");

    await user.click(screen.getByRole("button", { name: copy.leaveConfirm }));

    expect(window.location.pathname).toBe("/automations");
    expect(screen.getByTestId(LISTING)).toBeInTheDocument();
  });

  it("follows the tab at once when there is nothing to lose", async () => {
    const user = userEvent.setup();

    openEditor();

    await user.click(tab("/automations"));

    // Ordinary navigation costs the operator no question at all. A warning that
    // fired over an editor nobody had touched would teach them to answer it
    // without reading it, which is the same as having no warning.
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByTestId(LISTING)).toBeInTheDocument();
  });

  it("takes the warning away with the editor when the editor leaves", async () => {
    const user = userEvent.setup();

    openEditor();
    await change(user);

    await user.click(tab("/automations"));
    await user.click(screen.getByRole("button", { name: copy.leaveConfirm }));

    expect(screen.getByTestId(LISTING)).toBeInTheDocument();

    await user.click(tab("/dashboard"));

    // The listing holds nothing of anybody's, and a guard left behind by the
    // editor would be worse than the defect it closes: the operator would be
    // asked to confirm the loss of work that is not there, on a screen that
    // never held anything, with no way to make the question stop.
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByTestId(PANEL)).toBeInTheDocument();
  });
});

/**
 * REQ-301: the words on the button that saves a draft.
 *
 * Asserted as literals, and that is the point of this case: every other test in
 * this file reads the button's name out of the catalogue, so a wording changed
 * back would move the catalogue and the assertion together and prove nothing.
 */
describe("REQ-301: the draft button says Salvar como Rascunho", () => {
  it("carries the wording that was asked for, in both languages", () => {
    render(<AutomationFormScreen client={client()} assets={assets} />);

    expect(en.screens.automations.saveDraft).toBe("Save as Draft");
    expect(ptBR.screens.automations.saveDraft).toBe("Salvar como Rascunho");
    // And it is the button really drawn in the bar, still the form's submit.
    expect(
      screen.getByRole("button", { name: "Save as Draft" }),
    ).toHaveAttribute("type", "submit");
  });
});

/**
 * REQ-310, REQ-311: what a refused field says, and where it says it.
 *
 * The two halves are one behaviour and are tested as one: a sentence beside a
 * field nobody was sent to is a sentence below the fold, and a caret moved to a
 * field that says nothing is an operator standing in front of a control with no
 * idea what is wrong with it.
 *
 * The third thing these cases hold down is the one that is easiest to lose by
 * "simplifying": the instance's own paragraph, which names the step of the
 * schema, is what somebody importing a definition, calling the API or writing
 * the document by hand is answered with. It is shortened only where this
 * editor knows a field to put the short version in, and it is kept, whole and
 * with its path, everywhere else.
 */
describe("REQ-310/REQ-311: the refusal of a field, beside the field", () => {
  /** The instance turning a save away with the issues it named. */
  function refusing(
    issues: readonly {
      code: string;
      path: string;
      message: string;
      limit?: number;
    }[],
  ): AutomationsClient {
    return {
      ...client(),
      save: vi.fn(async () => ({
        ok: false as const,
        refusal: { error: "invalid_definition", issues },
      })),
    };
  }

  const LONG =
    'steps[0].message.text: the step "private-message" has 1400 bytes of text, above the limit of 1000 bytes. The limit is in BYTES of UTF-8, not characters: every accented character costs two.';

  it("says it in a short sentence under the field the walk turned away", async () => {
    const user = userEvent.setup();
    render(<AutomationFormScreen client={client()} assets={assets} />);
    await user.click(screen.getByRole("button", { name: "Activate" }));

    const control = screen.getByRole("button", { name: copy.chooseInGrid });

    // The three at once, because each alone is the defect: the words, the
    // caret, and the mark that turns the border red.
    expect(screen.getByText(copy.refusalChoosePublication)).toBeInTheDocument();
    expect(control).toHaveFocus();
    expect(control).toHaveAttribute("aria-invalid", "true");
    // And the sentence is announced WITH the control, not left floating beside
    // it (REQ-149): the refusal first, because it is the thing that changed.
    expect(control.getAttribute("aria-describedby")).toBe(
      "automation-target-error automation-target-tip",
    );
    expect(await toast()).toHaveTextContent(copy.refusalCompleteFields);
    expect(await toast()).not.toHaveTextContent(copy.refusalInvalidDefinition);
  });

  it("sends the caret to the one field at fault and leaves the others unmarked", async () => {
    const user = userEvent.setup();
    openOnPublication();
    render(
      <AutomationFormScreen
        client={client()}
        assets={assets}
        finder={finder()}
      />,
    );
    await user.type(
      screen.getByPlaceholderText(copy.keywordsPlaceholder),
      "ebook{enter}",
    );
    // Emptied, which is the one way the button is missing since REQ-332.
    await user.clear(screen.getByLabelText(copy.confirmationQuickReply));
    await user.click(screen.getByRole("button", { name: "Activate" }));

    const button = screen.getByLabelText(copy.confirmationQuickReply);

    expect(button).toHaveFocus();
    expect(button).toHaveAttribute("aria-invalid", "true");
    expect(button.getAttribute("aria-describedby")).toContain(
      `${"automation-confirmation-quick-reply"}-error`,
    );
    expect(screen.getByText(copy.refusalWriteButtonWords)).toBeInTheDocument();
    // The question above it is written and therefore not at fault: one caret,
    // one refusal, and a form that marked every empty field would be a form
    // that marked the field the operator was still on their way to.
    expect(
      screen.getByLabelText(copy.confirmationQuestion),
    ).not.toHaveAttribute("aria-invalid");
  });

  it("shortens a refusal of the instance at the field it belongs to, with the ceiling it sent", async () => {
    const user = userEvent.setup();
    const api = refusing([
      {
        code: "message_text_too_long",
        path: "steps[0].message.text",
        message: LONG,
        limit: 1000,
      },
    ]);
    openOnPublication();
    render(
      <AutomationFormScreen client={api} assets={assets} finder={finder()} />,
    );
    // Something has to have MOVED for the draft button to be pressable: it is
    // disabled while the editor holds exactly what was opened.
    await user.type(
      screen.getByPlaceholderText(copy.keywordsPlaceholder),
      "ebook{enter}",
    );
    await user.click(screen.getByRole("button", { name: copy.saveDraft }));

    const box = await screen.findByLabelText(copy.messageBody);

    // A DRAFT, and the field is drawn and focused all the same: the refusal is
    // about a field whatever the save was for.
    await waitFor(() => expect(box).toHaveFocus());
    expect(box).toHaveAttribute("aria-invalid", "true");
    // The number is the instance's, never this screen's: an installation that
    // tuned the ceiling is answered with the one it runs.
    expect(
      screen.getByText(resolve(copy.refusalMaxBytes, { max: 1000 })),
    ).toBeInTheDocument();
    // And the paragraph that named the step of the schema is not what the
    // operator is reading any more.
    expect(screen.queryByText(LONG)).toBeNull();
    // Nor is it said a SECOND time in a box at the top of the page: the field
    // carries the whole account, so what is left for the toast is the one thing
    // the field cannot say, which is that nothing was written (REQ-312).
    expect(document.querySelectorAll(".mc-page > .mc-notice")).toHaveLength(0);
    expect(await toast()).toHaveTextContent(copy.refusalInvalidDefinition);
  });

  it("keeps the instance's own paragraph, and its path, for a refusal no field here answers", async () => {
    const user = userEvent.setup();
    const duplicate = 'steps[1].id: duplicate step id: "private-message"';
    const api = refusing([
      { code: "duplicate_step_id", path: "steps[1].id", message: duplicate },
    ]);
    openOnPublication();
    render(
      <AutomationFormScreen client={api} assets={assets} finder={finder()} />,
    );
    // Something has to have MOVED for the draft button to be pressable: it is
    // disabled while the editor holds exactly what was opened.
    await user.type(
      screen.getByPlaceholderText(copy.keywordsPlaceholder),
      "ebook{enter}",
    );
    await user.click(screen.getByRole("button", { name: copy.saveDraft }));

    // The net for whoever writes from outside this screen: a definition that
    // came in through an import or the API is refused for things no field here
    // can be put in, and the account of it is this paragraph. Shortened away,
    // there would be nothing left to read.
    expect(await screen.findByText(duplicate)).toBeInTheDocument();
    expect(screen.getByText("steps[1].id")).toBeInTheDocument();
    expect(screen.getByLabelText(copy.messageBody)).not.toHaveAttribute(
      "aria-invalid",
    );
  });

  it("leaves a ceiling refusal that arrived without its number to the instance's own words", async () => {
    const user = userEvent.setup();
    const api = refusing([
      {
        code: "message_text_too_long",
        path: "steps[0].message.text",
        message: LONG,
      },
    ]);
    openOnPublication();
    render(
      <AutomationFormScreen client={api} assets={assets} finder={finder()} />,
    );
    // Something has to have MOVED for the draft button to be pressable: it is
    // disabled while the editor holds exactly what was opened.
    await user.type(
      screen.getByPlaceholderText(copy.keywordsPlaceholder),
      "ebook{enter}",
    );
    await user.click(screen.getByRole("button", { name: copy.saveDraft }));

    // "At most {{max}} characters" with nothing to put in it is a sentence with
    // a hole, and the number this build carries is the default rather than the
    // ceiling the installation runs. So the short sentence is not offered at
    // all, and the paragraph that does carry the numbers stays.
    expect(await screen.findByText(LONG)).toBeInTheDocument();
    expect(screen.getByLabelText(copy.messageBody)).not.toHaveAttribute(
      "aria-invalid",
    );
  });

  it("carries the refusal from one field to the next as each is answered", async () => {
    const user = userEvent.setup();
    openOnPublication();
    render(
      <AutomationFormScreen
        client={client()}
        assets={assets}
        finder={finder()}
      />,
    );
    await user.type(
      screen.getByPlaceholderText(copy.keywordsPlaceholder),
      "ebook{enter}",
    );
    // Emptied, which is the one way the button is missing since REQ-332.
    await user.clear(screen.getByLabelText(copy.confirmationQuickReply));
    await user.click(screen.getByRole("button", { name: "Activate" }));

    expect(screen.getByText(copy.refusalWriteButtonWords)).toBeInTheDocument();

    // Typing does NOT clear it: the answer to a save has to survive being read
    // twice, which is why nothing here listens to the keystrokes. The next
    // save does, and the caret goes on to whatever is missing now.
    await user.type(
      screen.getByLabelText(copy.confirmationQuickReply),
      "I want it",
    );
    expect(screen.getByText(copy.refusalWriteButtonWords)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Activate" }));

    expect(screen.queryByText(copy.refusalWriteButtonWords)).toBeNull();
    expect(screen.getByText(copy.refusalDeliverSomething)).toBeInTheDocument();
    expect(screen.getByLabelText(copy.messageBody)).toHaveFocus();
  });

  it("answers every refusal it can place with a sentence in both catalogues", () => {
    // The two tables are records and arrays of keys, which the walker of
    // `catalogue.test.ts` cannot see through: it reads the arguments of
    // `t("...")`. Without this, a key nobody wrote a sentence for would ship
    // and the operator would meet the placeholder of REQ-075 (REQ-174).
    expect(REFUSAL_TEXT_KEYS.length).toBeGreaterThan(0);
    for (const key of REFUSAL_TEXT_KEYS) {
      const [section = "", screenName = "", name = ""] = key.split(".");

      for (const [locale, catalogueOf] of [
        ["en", en],
        ["pt-BR", ptBR],
      ] as const) {
        const sentence = (
          catalogueOf as unknown as Record<
            string,
            Record<string, Record<string, string>>
          >
        )[section]?.[screenName]?.[name];

        expect(sentence, `${locale}: ${key}`).toBeTruthy();
      }
    }
  });

  it("draws the red border on the controls a field only nests", () => {
    // The mark travels to a nested control and the CLASS does not (REQ-185),
    // so a refusal on the word entry, on the wording entry or on the
    // publication button was announced and drawn nowhere. Token, never a
    // literal colour.
    const rule = blockAfter(
      COMPONENT_SHEET,
      '.mc-input[aria-invalid="true"],\n.mc-keywords__input[aria-invalid="true"],\n.mc-btn[aria-invalid="true"]',
    );

    expect(rule).toContain("border-color: var(--danger)");
  });
});

/* ------------------------------------------------------------------ *
 * REQ-312: the answer leaves the page, the account it cannot carry stays
 * ------------------------------------------------------------------ */

/**
 * The editor is where the band at the top of the page was worst, which is why
 * this requirement is proved here as well as on the component.
 *
 * The mechanism itself (announced, timed, held while read, closable) is held
 * down in `components.test.tsx`. What these two cases hold is the DECISION this
 * screen makes with it, and it is a decision with two sides that would each
 * look correct on its own: an answer that leaves, and an account that must not.
 */
describe("REQ-312: the answer to a save goes to the corner and then goes", () => {
  it("confirms a save in a toast, with no band left at the top of the editor", async () => {
    const user = userEvent.setup();

    render(<AutomationFormScreen client={client()} assets={assets} />);

    await user.type(
      screen.getByPlaceholderText(copy.keywordsPlaceholder),
      "ebook{enter}",
    );
    await user.click(screen.getByRole("button", { name: copy.saveDraft }));

    const answer = await toast();

    expect(answer).toHaveTextContent(copy.draftSaved);
    expect(answer).toHaveAttribute("aria-live", "polite");
    // The page itself carries nothing: the confirmation used to be born here,
    // above a form whose buttons are five sections away.
    expect(document.querySelectorAll(".mc-page > .mc-notice")).toHaveLength(0);
    // And it does not take the caret with it. That was the old answer to being
    // seen (REQ-150), and it cost the operator the place they were working in;
    // a box anchored to the viewport is seen without moving anybody.
    expect(answer).not.toHaveFocus();
  });

  it("leaves the account no field answers in the page, where no clock reaches it", async () => {
    const user = userEvent.setup();
    const duplicate = 'steps[1].id: duplicate step id: "private-message"';
    const api: AutomationsClient = {
      ...client(),
      save: vi.fn(async () => ({
        ok: false as const,
        refusal: {
          error: "invalid_definition",
          issues: [
            {
              code: "duplicate_step_id",
              path: "steps[1].id",
              message: duplicate,
            },
          ],
        },
      })),
    };

    render(<AutomationFormScreen client={api} assets={assets} />);

    await user.type(
      screen.getByPlaceholderText(copy.keywordsPlaceholder),
      "ebook{enter}",
    );
    await user.click(screen.getByRole("button", { name: copy.saveDraft }));

    // This paragraph is the only account anybody importing a definition or
    // calling the API is given, and no control on this screen can hold it. In
    // the page it answers to nothing but the next save; in the corner it would
    // answer to a clock, and a technical paragraph that expires while somebody
    // is still reading the path in it is a message lost.
    expect(await screen.findByText(duplicate)).toBeInTheDocument();
    expect(screen.getByText("steps[1].id")).toBeInTheDocument();
    // And no toast is raised beside it: the sentence one would carry is the
    // paragraph's own first line, and the one that goes would be read as the
    // same message as the one that stays.
    expect(document.getElementById(TOAST_VIEWPORT_ID)?.textContent ?? "").toBe(
      "",
    );
  });
});

describe("REQ-367: the editor keeps the chosen automation scope", () => {
  it("writes global and next-publication comment scopes without a hidden target", async () => {
    const save = vi.fn(async (definition: UnifiedAutomation) => ({
      ok: true as const,
      created: false,
      stored: {
        definition,
        createdAt: "2026-08-22T00:00:00.000Z",
        updatedAt: "2026-08-22T00:00:00.000Z",
      },
    }));
    const user = userEvent.setup();
    render(
      <AutomationFormScreen client={{ ...client(), save }} assets={assets} />,
    );

    await user.click(screen.getByRole("radio", { name: copy.scopeGlobal }));
    await user.type(
      screen.getByPlaceholderText(copy.keywordsPlaceholder),
      "ebook{enter}",
    );
    await user.click(screen.getByRole("button", { name: copy.saveDraft }));

    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save.mock.calls[0]?.[0]).toMatchObject({
      scope: { type: "global" },
      trigger: { type: "comment" },
    });
    const trigger = (save.mock.calls[0]?.[0] as UnifiedAutomation).trigger;
    expect(
      trigger?.type === "comment" ? trigger.target : undefined,
    ).toBeUndefined();
  });

  it("activates a global comment automation without sending focus to its hidden target", async () => {
    const save = vi.fn(async (definition: UnifiedAutomation) => ({
      ok: true as const,
      created: false,
      stored: { definition, createdAt: NOW, updatedAt: NOW },
    }));
    const user = userEvent.setup();
    render(
      <AutomationFormScreen client={{ ...client(), save }} assets={assets} />,
    );

    await user.click(screen.getByRole("radio", { name: copy.scopeGlobal }));
    await user.type(
      screen.getByPlaceholderText(copy.keywordsPlaceholder),
      "ebook{enter}",
    );
    await withoutConfirmation(user);
    await user.type(screen.getByLabelText(copy.messageBody), "here it is");
    await user.click(screen.getByRole("button", { name: copy.activate }));

    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    const definition = save.mock.calls[0]?.[0] as UnifiedAutomation;
    expect(definition.state).toBe("active");
    expect(
      definition.trigger?.type === "comment"
        ? definition.trigger.target
        : undefined,
    ).toBeUndefined();
    expect(
      screen.queryByRole("button", { name: copy.chooseInGrid }),
    ).toBeNull();
  });

  it("keeps a publication scope refused at its visible picker when no target is chosen", async () => {
    const user = userEvent.setup();
    render(<AutomationFormScreen client={client()} assets={assets} />);

    await user.type(
      screen.getByPlaceholderText(copy.keywordsPlaceholder),
      "ebook{enter}",
    );
    await user.click(screen.getByRole("button", { name: copy.activate }));

    const picker = screen.getByRole("button", { name: copy.chooseInGrid });
    expect(picker).toHaveFocus();
    expect(picker).toHaveAttribute("aria-invalid", "true");
  });

  it("saves empty email and follow questions as a draft, then refuses each visible question on activation", async () => {
    const save = vi.fn(async (definition: UnifiedAutomation) => ({
      ok: true as const,
      created: false,
      stored: { definition, createdAt: NOW, updatedAt: NOW },
    }));
    const user = userEvent.setup();
    render(
      <AutomationFormScreen client={{ ...client(), save }} assets={assets} />,
    );

    await user.click(screen.getByRole("radio", { name: copy.scopeGlobal }));
    await user.type(
      screen.getByPlaceholderText(copy.keywordsPlaceholder),
      "ebook{enter}",
    );
    await withoutConfirmation(user);
    await user.type(screen.getByLabelText(copy.messageBody), "here it is");
    await user.click(screen.getByRole("checkbox", { name: copy.openingEmail }));
    await user.click(
      screen.getByRole("checkbox", { name: copy.openingFollow }),
    );

    await user.click(screen.getByRole("button", { name: copy.saveDraft }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));

    await user.click(screen.getByRole("button", { name: copy.activate }));
    expect(screen.getByLabelText(copy.emailQuestion)).toHaveFocus();
    await user.type(screen.getByLabelText(copy.emailQuestion), "Email?");

    await user.click(screen.getByRole("button", { name: copy.activate }));
    expect(screen.getByLabelText(copy.followQuestion)).toHaveFocus();
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("keeps every collection addition made in one React batch", () => {
    render(<AutomationFormScreen client={client()} assets={assets} />);

    const addLink = screen.getByRole("button", { name: copy.addLink });
    const addButton = screen.getByRole("button", { name: copy.addButton });
    act(() => {
      addLink.click();
      addLink.click();
      addButton.click();
      addButton.click();
    });

    expect(screen.getAllByLabelText(/Link \d+ address/)).toHaveLength(2);
    expect(screen.getAllByLabelText(/Button \d+ text/)).toHaveLength(2);
  });
});
