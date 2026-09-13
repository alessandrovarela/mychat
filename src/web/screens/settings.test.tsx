import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import type { ReactElement } from "react";
import en from "../../i18n/locales/en.json";
import pt from "../../i18n/locales/pt-BR.json";
import { createTranslator } from "../../i18n/translator.js";
import { TOAST_VIEWPORT_ID } from "../components/index.js";
import { LocaleProvider } from "../locale.js";
import type { LocaleClient, LocaleState } from "../locale.js";
import { THEME_ATTRIBUTE, THEME_STORAGE_KEY } from "../theme.js";
import { timeZoneOptionLabel } from "../time-zone.js";
import {
  CONVERSATION_REFUSAL_TEXT_KEYS,
  SETTINGS_BLOCKS,
  SettingsScreen,
  THEME_TEXT_KEYS,
} from "./settings.js";
import type {
  ConversationChange,
  ConversationClient,
  ConversationLimits,
  ConversationRefusal,
  ConversationSettings,
  ConversationWrite,
  ConfigurationClient,
  IntegrationClient,
  InstanceClient,
  InstanceState,
  TriggerSwitchName,
  TriggerSwitchState,
} from "./settings.js";

/**
 * Settings (REQ-102, REQ-115, REQ-117, REQ-166, REQ-183), which the language
 * selector became.
 *
 * Four things are proved here that a smaller screen did not have to prove. The
 * preference is stored in the INSTANCE before it is shown, so a write that
 * failed leaves both the language and the selector where they were, and says
 * so in a block of its own rather than in a paragraph that reads like every
 * other paragraph. The settings that are declared but absent are declared with
 * no control attached: a disabled selector would promise something that does
 * not exist. The time zone, which stopped being absent when REQ-153 made it
 * configurable, is NAMED from the instance rather than asserted to be UTC by a
 * sentence nobody updated. And it is CHOSEN here, by the same road the language
 * takes: stored in the instance first, adopted from the answer second.
 *
 * Every word is read from the shipped catalogue, in both languages, never
 * retyped here. Three zone identifiers are written down, and they are not
 * words: they are the data the instance answers with, which is the whole point.
 */

const EN = "en";
const PT = "pt-BR";

/** Three hours behind UTC, so a screen still saying UTC says something false. */
const OPERATOR_ZONE = "America/Sao_Paulo";

/** What an instance that configured nothing is really on. */
const DEFAULT_ZONE = "UTC";

/** The other side of the world, and the zone the operator switches TO. */
const AHEAD_ZONE = "Asia/Tokyo";

/**
 * What the instance offers, which is the list the SERVER builds: the screen
 * renders what it is handed and asks the browser's calendar data for nothing.
 */
const ZONES = [DEFAULT_ZONE, OPERATOR_ZONE, AHEAD_ZONE];

const copy = en.settings;
const copyPt = pt.settings;
const navCopy = en.nav;

interface LocaleDouble extends LocaleClient {
  /** Every locale the screen asked the instance to store, in order. */
  readonly written: string[];
  locale: string;
  writeFails: boolean;
}

function createLocaleDouble(locale = EN): LocaleDouble {
  const double: LocaleDouble = {
    written: [],
    locale,
    writeFails: false,

    read: (): Promise<LocaleState> =>
      Promise.resolve({ locale: double.locale, available: [EN, PT] }),

    write: (wanted: string): Promise<LocaleState> => {
      double.written.push(wanted);

      if (double.writeFails) {
        return Promise.reject(new Error(String(500)));
      }

      double.locale = wanted;
      return Promise.resolve({ locale: wanted, available: [EN, PT] });
    },
  };

  return double;
}

interface InstanceDouble extends InstanceClient {
  /** Every zone the screen asked the instance to store, in order. */
  readonly written: string[];
  timeZone: string;
  writeFails: boolean;
  triggerWrites: { name: TriggerSwitchName; enabled: boolean }[];
  triggers: TriggerSwitchState;
}

/** The instance answering how it is configured, with no network. */
function createInstanceDouble(timeZone = OPERATOR_ZONE): InstanceDouble {
  const state = (): InstanceState => ({
    timeZone: double.timeZone,
    timeZones: ZONES,
  });

  const double: InstanceDouble = {
    written: [],
    timeZone,
    writeFails: false,
    triggerWrites: [],
    triggers: {
      all: { enabled: true },
      comments: { enabled: true },
      directMessages: { enabled: true },
    },

    read: (): Promise<InstanceState> => Promise.resolve(state()),

    write: (wanted: string): Promise<InstanceState> => {
      double.written.push(wanted);

      if (double.writeFails) {
        return Promise.reject(new Error(String(500)));
      }

      double.timeZone = wanted;
      return Promise.resolve(state());
    },
    readTriggers: (): Promise<TriggerSwitchState> =>
      Promise.resolve(double.triggers),
    writeTrigger: (
      name: TriggerSwitchName,
      enabled: boolean,
    ): Promise<TriggerSwitchState> => {
      double.triggerWrites.push({ name, enabled });
      double.triggers = {
        ...double.triggers,
        [name]: { enabled, updatedAt: "2026-08-06T10:00:00.000Z" },
      };
      return Promise.resolve(double.triggers);
    },
  };

  return double;
}

/** An instance that cannot be asked at all: the process is down, or the
 * session expired between the page loading and the panel reading. */
const unreachableInstance: InstanceClient = {
  read: (): Promise<InstanceState> => Promise.reject(new Error(String(500))),
  write: (): Promise<InstanceState> => Promise.reject(new Error(String(500))),
};

/**
 * The bounds the RULE declares (`src/config/instance-settings.ts`), written here
 * as the numbers the route really answers with.
 *
 * They are data and not words: the screen is handed them and puts them into
 * sentences from the catalogue, which is what keeps 168 and 20 out of the
 * browser. A test that invented its own numbers would prove the screen reads
 * SOMETHING; these are what it has to read.
 */
const LIMITS: ConversationLimits = {
  waitHoursMin: 1,
  waitHoursMax: 168,
  questionsMin: 1,
  followButtonLabelChars: 20,
};

/**
 * What a fresh installation answers: the defaults of the rule, and the two
 * texts resolved from the CATALOGUE rather than frozen into the route
 * (REQ-255, REQ-257).
 *
 * English, because that is the language these cases render in: the instance
 * answers its goodbye in the language it is set to, so a double answering the
 * Portuguese sentence to an English screen would be describing an instance that
 * cannot exist.
 */
const STORED_SETTINGS: ConversationSettings = {
  waitHours: 168,
  questions: 3,
  closingMessage: en.instance.closingMessage,
  followButtonLabel: en.instance.followButtonLabel,
  limits: LIMITS,
};

interface ConversationDouble extends ConversationClient {
  /** Every change the screen asked the instance to store, in order. */
  readonly written: ConversationChange[];
  stored: ConversationSettings;
  /** The refusal the next write answers with, when it is not to succeed. */
  refusal?: ConversationRefusal;
}

function createConversationDouble(
  stored: ConversationSettings = STORED_SETTINGS,
): ConversationDouble {
  const double: ConversationDouble = {
    written: [],
    stored,

    read: (): Promise<ConversationSettings> => Promise.resolve(double.stored),

    write: (change: ConversationChange): Promise<ConversationWrite> => {
      double.written.push(change);

      if (double.refusal !== undefined) {
        // Refused as a whole and nothing stored, which is what the route does:
        // the four values stay exactly as they were.
        return Promise.resolve({ ok: false, refusal: double.refusal });
      }

      double.stored = { ...double.stored, ...change };
      return Promise.resolve({ ok: true, settings: double.stored });
    },
  };

  return double;
}

/** A conversation the instance cannot be asked about at all. */
const unreachableConversation: ConversationClient = {
  read: (): Promise<ConversationSettings> =>
    Promise.reject(new Error(String(500))),
  write: (): Promise<ConversationWrite> =>
    Promise.reject(new Error(String(500))),
};

function show(
  client: LocaleClient,
  instance: InstanceClient = createInstanceDouble(),
  conversation: ConversationClient = createConversationDouble(),
  configuration?: ConfigurationClient,
  integrations?: IntegrationClient,
  view: "application" | "instance" = "application",
): ReactElement {
  return (
    <LocaleProvider client={client}>
      <SettingsScreen
        view={view}
        instance={instance}
        conversation={conversation}
        {...(configuration === undefined ? {} : { configuration })}
        {...(integrations === undefined ? {} : { integrations })}
      />
    </LocaleProvider>
  );
}

/** The panel a title belongs to, so a fact can be located by the block that
 * holds it rather than by its position on the page.
 *
 * A block title is written TWICE on the screen since REQ-327: once as the
 * block's own heading, and once as the entry of the menu that jumps to it. The
 * heading is the one that names a panel, and it is told apart by exactly that:
 * the menu sits above every block and is inside none of them. */
function panelOf(title: string): HTMLElement {
  const panel = screen
    .getAllByText(title)
    .map((node) => node.closest(".mc-panel"))
    .find((found) => found !== null);

  if (panel === undefined) {
    throw new Error("no panel carries that title");
  }

  return panel as HTMLElement;
}

/** A catalogue sentence with its named values filled in, as the screen fills them. */
function resolve(
  template: string,
  params: Record<string, string | number> = {},
): string {
  return Object.entries(params).reduce(
    (filled, [name, value]) => filled.split(`{{${name}}}`).join(String(value)),
    template,
  );
}

/**
 * Everything a control's OWN description says, in the order it is announced.
 *
 * Read off `aria-describedby` and never off the page, because the two are
 * different facts: a sentence rendered somewhere near a field is a sentence
 * whoever is typing in that field is never told (REQ-149). What this joins is
 * what a screen reader reads out with the control.
 */
function descriptionOf(control: HTMLElement): string {
  return (control.getAttribute("aria-describedby") ?? "")
    .split(/\s+/)
    .filter(Boolean)
    .map((id) => {
      const node = document.getElementById(id);

      if (node === null) {
        throw new Error(`the control is described by a missing id: ${id}`);
      }

      return node.textContent ?? "";
    })
    .join(" ");
}

/**
 * The advice under one control, or nothing when that control has none.
 *
 * Found through the control's OWN description and not by asking the page for
 * the `status` role: this screen carries several live regions, and a query that
 * swept them all would pass on somebody else's sentence.
 */
function adviceOf(control: HTMLElement): HTMLElement | null {
  const id = (control.getAttribute("aria-describedby") ?? "")
    .split(/\s+/)
    .find((candidate) => candidate.endsWith("-advice"));

  return id === undefined ? null : document.getElementById(id);
}

/**
 * The toast this screen answered the last write with (REQ-312).
 *
 * Looked for inside the strip toasts are portalled into, and NOT by asking the
 * document for its `role="status"`: a pending state and a field's own length
 * advice are polite regions too, so a document-wide query is ambiguous exactly
 * when a refusal lands on a field somebody has been typing in. Scoped, the role
 * is still what identifies it, which is the half of REQ-312 worth asserting.
 */
async function toast(): Promise<HTMLElement> {
  return await waitFor(() => {
    const strip = document.getElementById(TOAST_VIEWPORT_ID);

    if (strip === null) throw new Error("no toast has been raised");

    return within(strip).getByRole("status");
  });
}

/** The classes of the box inside a toast, which is what carries its nature. */
function natureOf(box: HTMLElement): string {
  return box.querySelector(".mc-notice")?.className ?? "";
}

describe("REQ-102: the language of the interface is a setting of the instance", () => {
  it("is the settings screen, not a screen for one preference", async () => {
    render(show(createLocaleDouble()));

    // The place the preferences live, which is what the address under it
    // (`/settings/language`) already said and the screen did not.
    expect(
      await screen.findByRole("heading", { name: copy.title }),
    ).toBeInTheDocument();
    expect(screen.getByText(copy.languageHint)).toBeInTheDocument();
  });

  it("offers every language the instance has, and marks the one in force", async () => {
    render(show(createLocaleDouble(PT)));

    const selector = await screen.findByLabelText(copyPt.languageLabel);

    // A language names itself in its own language, which is what keeps a
    // locale added later from showing up as its bare code.
    expect(screen.getByRole("option", { name: "English" })).toBeInTheDocument();
    expect(
      screen.getByRole("option", { name: "português (Brasil)" }),
    ).toBeInTheDocument();
    // The mark is the control's own value, so it is programmatic and not a
    // colour: the option in force is announced by the platform itself.
    expect(selector).toHaveValue(PT);
  });

  it("stores the choice in the instance and then renders in it", async () => {
    const user = userEvent.setup();
    const client = createLocaleDouble();

    render(show(client));

    await user.selectOptions(
      await screen.findByLabelText(copy.languageLabel),
      PT,
    );

    // Stored first, shown second: a panel that switched language over a
    // preference the instance refused would be corrected by the next reload.
    expect(client.written).toEqual([PT]);
    expect(
      await screen.findByRole("heading", { name: copyPt.title }),
    ).toBeInTheDocument();
  });
});

describe("REQ-211: Settings distinguishes an expired session", () => {
  it("reports a 401 from its locale read as a closed session", async () => {
    const localeWithoutSession: LocaleClient = {
      read: (): Promise<LocaleState> => Promise.reject(new Error("401")),
      write: (): Promise<LocaleState> => Promise.reject(new Error("401")),
    };

    render(show(localeWithoutSession));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(navCopy.sessionExpired);
    expect(alert).not.toHaveTextContent(copy.timezoneFailed);
    expect(screen.getByRole("link", { name: navCopy.signIn })).toHaveAttribute(
      "href",
      "/login",
    );
  });
});

describe("REQ-115: the one failure this screen has looks like a failure", () => {
  it("says the preference was not stored and keeps the previous choice", async () => {
    const user = userEvent.setup();
    const client = createLocaleDouble();
    client.writeFails = true;

    render(show(client));

    const selector = await screen.findByLabelText(copy.languageLabel);
    await user.selectOptions(selector, PT);

    const answer = await toast();

    expect(answer).toHaveTextContent(copy.languageFailedTitle);
    expect(answer).toHaveTextContent(copy.languageFailed);
    // A block of its own, at the weight of a refusal, and not a sentence that
    // reads like the note under the selector (REQ-115). In the corner since
    // REQ-312, and the weight travelled with it.
    expect(natureOf(answer)).toContain("mc-notice--error");

    // Nothing changed: the instance kept the previous choice and so does the
    // control, which is the sentence the notice just made.
    expect(selector).toHaveValue(EN);
    expect(
      screen.getByRole("heading", { name: copy.title }),
    ).toBeInTheDocument();
  });

  it("raises nothing when there is nothing wrong", async () => {
    render(show(createLocaleDouble()));

    await screen.findByLabelText(copy.languageLabel);

    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("REQ-115: no block of this screen stands for a setting that is absent", () => {
  /*
   * REWRITTEN by REQ-326, not retired, and the reason is that its subject was
   * taken away rather than its rule.
   *
   * This case used to prove that the one absent setting was DECLARED and given
   * no control: a panel titled "what does not exist yet", a card with no
   * selector in it, and a badge reading "follows the system". The theme was the
   * only absence the screen had, so when it stopped being absent the block
   * proving how absences are drawn had nothing left to point at, and the three
   * texts went out of the catalogue with it.
   *
   * What the requirement still asks of this screen is the half that survives:
   * every control here is real, none is disabled while it waits to exist, and
   * nothing is drawn as a promise. That is what is proved below, and it is
   * proved where it now happens.
   */
  it("gives the theme a working control where a declared absence used to be", async () => {
    const { container } = render(show(createLocaleDouble()));

    await screen.findByLabelText(copy.languageLabel);

    const themePanel = panelOf(copy.themeTitle);
    const control = within(themePanel).getByLabelText(copy.themeLabel);

    expect(control).toBeEnabled();

    // One control per setting that exists, and there are three of them now:
    // the language, the zone, and the theme this task added.
    expect(screen.getAllByRole("combobox")).toHaveLength(3);

    // And nothing STANDS IN for the control any more. The badge over this panel
    // was the value in force said as a word, which is what a block with no
    // control has instead of one; the panel now answers with the control
    // itself, so the word would be a second, quieter answer to the same
    // question.
    expect(themePanel.querySelectorAll(".mc-badge")).toHaveLength(0);

    // No disabled control anywhere on the screen, which is the shape a promise
    // takes when it is drawn instead of declared. The trigger switches can
    // disable each other, and this instance has them all enabled.
    expect(
      [...container.querySelectorAll("select, input, button")].filter(
        (node) => (node as HTMLInputElement).disabled,
      ),
    ).toEqual([]);
  });
});

describe("REQ-166: the screen names the zone the instance is really on", () => {
  it("names the zone the instance answers, and claims no other", async () => {
    render(show(createLocaleDouble(), createInstanceDouble()));

    const selector = await screen.findByLabelText(copy.timezoneLabel);

    // The mark is the control's own value, so what is in force is announced by
    // the platform rather than drawn by us.
    expect(selector).toHaveValue(OPERATOR_ZONE);

    // The sentence that stood here said every instant was in UTC. On an
    // instance three hours behind it, no word of this screen may say so — and
    // an OPTION offering UTC says nothing: it is one of the zones this instance
    // could be switched to, which is not a claim about the one in force.
    for (const node of screen.queryAllByText(/UTC/)) {
      expect(selector).toContainElement(node);
    }
  });

  it("says UTC when UTC is what the instance answered", async () => {
    render(show(createLocaleDouble(), createInstanceDouble(DEFAULT_ZONE)));

    // The correction is not "never write UTC": an installation that configured
    // nothing IS on UTC, and the screen owes it the same honesty.
    expect(await screen.findByLabelText(copy.timezoneLabel)).toHaveValue(
      DEFAULT_ZONE,
    );
  });

  it("presents the zone as in force, not as a setting that is missing", async () => {
    const { container } = render(
      show(createLocaleDouble(), createInstanceDouble()),
    );

    await screen.findByLabelText(copy.timezoneLabel);

    // The zone shares a block with the language since REQ-325, so the block it
    // is IN is named by that block's title. What the requirement is about did
    // not move: it is a setting in force, wherever it is drawn, and never a
    // line inside a block that stands for something absent. The screen has no
    // such block left since REQ-326, so the panel held against it is the LAST
    // one, which is where that block used to be.
    const zonePanel = panelOf(copy.languageTitle);
    const themePanel = panelOf(copy.themeTitle);

    expect(zonePanel).not.toBe(themePanel);
    expect(
      within(zonePanel).getByText(timeZoneOptionLabel(OPERATOR_ZONE)),
    ).toBeInTheDocument();
    expect(
      within(themePanel).queryByText(timeZoneOptionLabel(OPERATOR_ZONE)),
    ).toBeNull();
    expect(within(themePanel).queryByText(copy.timezoneLabel)).toBeNull();

    // And the seal is gone from the whole screen rather than moved: every
    // marker left is a FACT and not a promise. All three say the setting beside
    // them reaches every automation. The fourth used to be the theme's value
    // said as a word, which was what that panel had INSTEAD of a control; it
    // went when the control arrived (REQ-326).
    expect(
      [...container.querySelectorAll(".mc-badge")].map((badge) =>
        badge.textContent?.trim(),
      ),
    ).toEqual([
      copy.conversationScope,
      copy.conversationScope,
      copy.conversationScope,
    ]);
  });

  it("says it is reading while the instance has not answered", async () => {
    render(
      show(createLocaleDouble(), {
        read: (): Promise<InstanceState> =>
          new Promise<InstanceState>(() => {}),
        write: (): Promise<InstanceState> =>
          new Promise<InstanceState>(() => {}),
      }),
    );

    expect(await screen.findByText(copy.timezoneLoading)).toBeInTheDocument();
    // Nothing named while nothing is known, which is the whole difference
    // between reading and having read.
    expect(screen.queryByText(OPERATOR_ZONE)).toBeNull();
  });

  it("names no zone at all when the instance could not be asked", async () => {
    render(show(createLocaleDouble(), unreachableInstance));

    const alert = await screen.findByRole("alert");

    expect(alert).toHaveTextContent(copy.timezoneFailedTitle);
    expect(alert).toHaveTextContent(copy.timezoneFailed);

    // Falling back to UTC here would write the removed sentence again, through
    // the failure path: a zone nobody configured, stated as fact.
    expect(screen.queryByText(/UTC/)).toBeNull();
    expect(screen.queryByText(OPERATOR_ZONE)).toBeNull();
  });
});

describe("REQ-183: the zone is changed here, and holds with no restart", () => {
  it("offers the zones the instance answered with, and marks the one in force", async () => {
    render(show(createLocaleDouble(), createInstanceDouble()));

    const selector = await screen.findByLabelText(copy.timezoneLabel);

    // The list came over the wire from the process that has to COUNT in the
    // zone. A list this screen built from the browser's own calendar data
    // would offer names the server refuses.
    expect(
      within(selector)
        .getAllByRole("option")
        .map((option) => option.textContent),
    ).toEqual(ZONES.map((zone) => timeZoneOptionLabel(zone)));
    expect(selector).toHaveValue(OPERATOR_ZONE);
  });

  it("stores the chosen zone in the instance and then shows it", async () => {
    const user = userEvent.setup();
    const instance = createInstanceDouble();

    render(show(createLocaleDouble(), instance));

    await user.selectOptions(
      await screen.findByLabelText(copy.timezoneLabel),
      AHEAD_ZONE,
    );

    // Stored first, shown second: the dashboard counts in what the INSTANCE
    // keeps, so a control that moved on its own would name a zone the numbers
    // beside it were not cut in.
    expect(instance.written).toEqual([AHEAD_ZONE]);
    expect(await screen.findByLabelText(copy.timezoneLabel)).toHaveValue(
      AHEAD_ZONE,
    );
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("keeps the previous zone, and says so, when it could not be stored", async () => {
    const user = userEvent.setup();
    const instance = createInstanceDouble();
    instance.writeFails = true;

    render(show(createLocaleDouble(), instance));

    const selector = await screen.findByLabelText(copy.timezoneLabel);
    await user.selectOptions(selector, AHEAD_ZONE);

    const answer = await toast();

    expect(answer).toHaveTextContent(copy.timezoneNotStoredTitle);
    expect(answer).toHaveTextContent(copy.timezoneNotStored);
    // A refusal at the weight of a refusal, and not a paragraph that reads like
    // the note under the control (REQ-115).
    expect(natureOf(answer)).toContain("mc-notice--error");

    // Nothing changed anywhere: the instance kept the zone, the panel keeps
    // counting in it, and the control still shows it.
    expect(selector).toHaveValue(OPERATOR_ZONE);
  });

  it("does not report the zone unstored when it is the language that failed", async () => {
    const user = userEvent.setup();
    const client = createLocaleDouble();
    client.writeFails = true;

    render(show(client, createInstanceDouble()));

    await user.selectOptions(
      await screen.findByLabelText(copy.languageLabel),
      PT,
    );

    const answer = await toast();

    // Two settings, two failures, and one may never be reported as the other:
    // being told to pick the zone again is being told to fix something that
    // never broke.
    // Still English, because the language was NOT stored: that is the same
    // refusal reported one line above, read from the other end.
    expect(answer).toHaveTextContent(copy.languageFailedTitle);
    expect(screen.queryByText(copy.timezoneNotStoredTitle)).toBeNull();
  });
});

describe("REQ-206: Settings combines language and trigger switches", () => {
  it("shows the master, Comments and Direct messages together with language", async () => {
    render(show(createLocaleDouble()));

    await screen.findByLabelText(copy.languageLabel);
    // The master asks the OPPOSITE question of the one the instance stores
    // (REQ-321): an instance with every trigger enabled is an instance where
    // "disable all" is OFF.
    expect(
      await screen.findByRole("checkbox", { name: copy.triggerAll }),
    ).not.toBeChecked();
    expect(
      screen.getByRole("checkbox", { name: copy.triggerComments }),
    ).toBeChecked();
    expect(
      screen.getByRole("checkbox", { name: copy.triggerDirectMessages }),
    ).toBeChecked();
  });

  it("stores an immediate switch choice and adopts the instance answer", async () => {
    const user = userEvent.setup();
    const instance = createInstanceDouble();
    render(show(createLocaleDouble(), instance));

    await user.click(
      await screen.findByRole("checkbox", { name: copy.triggerComments }),
    );

    expect(instance.triggerWrites).toEqual([
      { name: "comments", enabled: false },
    ]);
    expect(
      screen.getByRole("checkbox", { name: copy.triggerComments }),
    ).not.toBeChecked();
    expect(
      screen.getByRole("checkbox", { name: copy.triggerDirectMessages }),
    ).toBeChecked();
  });
});

describe("REQ-321: the block is Enable / Disable Automations, drawn as switches", () => {
  it("names the block by the decision it offers", async () => {
    render(show(createLocaleDouble()));

    // By ROLE since REQ-327: the block's name is a heading, which is what makes
    // it reachable by the keys a screen reader offers for moving through a
    // document. Asked for by text alone, this would now find the menu entry
    // that jumps here as well.
    expect(
      await screen.findByRole("heading", { name: copy.triggersTitle }),
    ).toBeInTheDocument();
  });

  it("draws all three controls as a switch and not as a box", async () => {
    render(show(createLocaleDouble()));

    const controls = [
      await screen.findByRole("checkbox", { name: copy.triggerAll }),
      screen.getByRole("checkbox", { name: copy.triggerComments }),
      screen.getByRole("checkbox", { name: copy.triggerDirectMessages }),
    ];

    for (const control of controls) {
      // The drawing is the requirement, and in this design system the drawing
      // IS the block: a track the pin travels along, not a box that gets a
      // tick. The role stays `checkbox` on purpose, which `Checkbox.tsx`
      // writes down: a switch that invented `role="switch"` would also promise
      // semantics this product does not have.
      const drawn = control.closest("label");
      expect(drawn).toHaveClass("mc-switch");
      expect(drawn?.querySelector(".mc-switch__track")).not.toBeNull();
      expect(drawn).not.toHaveClass("mc-check");
    }
  });
});

describe("REQ-322: the master switch governs the two channels", () => {
  /** Comments off and direct messages on: two channels a restore can tell apart. */
  function createUnevenInstance(): InstanceDouble {
    const instance = createInstanceDouble();
    instance.triggers = {
      all: { enabled: true },
      comments: { enabled: false },
      directMessages: { enabled: true },
    };

    return instance;
  }

  async function master(): Promise<HTMLElement> {
    return screen.findByRole("checkbox", { name: copy.triggerAll });
  }

  function comments(): HTMLElement {
    return screen.getByRole("checkbox", { name: copy.triggerComments });
  }

  function directMessages(): HTMLElement {
    return screen.getByRole("checkbox", { name: copy.triggerDirectMessages });
  }

  it("turns the two channels off and out of reach when it goes on", async () => {
    const user = userEvent.setup();
    const instance = createInstanceDouble();
    render(show(createLocaleDouble(), instance));

    await user.click(await master());

    // The operator asked to DISABLE everything, so the instance is told the
    // opposite of what the control shows: the stored meaning never moved.
    expect(instance.triggerWrites).toEqual([{ name: "all", enabled: false }]);
    expect(await master()).toBeChecked();
    expect(comments()).not.toBeChecked();
    expect(comments()).toBeDisabled();
    expect(directMessages()).not.toBeChecked();
    expect(directMessages()).toBeDisabled();
  });

  it("says WHO disabled the channel, and not only that it is disabled", async () => {
    const user = userEvent.setup();
    render(show(createLocaleDouble(), createInstanceDouble()));

    await user.click(await master());

    // The requirement's own sentence: a control greyed out in silence is the
    // trap. Both channels carry the reason as their DESCRIPTION, which is what
    // a reader announces after the state, and the reason NAMES the switch that
    // did it rather than saying something vague about being unavailable.
    expect(copy.triggerDisabledByAll).toContain(copy.triggerAll);
    expect(comments()).toHaveAccessibleDescription(copy.triggerDisabledByAll);
    expect(directMessages()).toHaveAccessibleDescription(
      copy.triggerDisabledByAll,
    );
    // And the reason is a description, never part of the name: a channel that
    // absorbed the sentence would be announced as a different control.
    expect(comments()).toHaveAccessibleName(copy.triggerComments);
  });

  it("carries no reason on a channel nobody disabled", async () => {
    render(show(createLocaleDouble(), createInstanceDouble()));

    await screen.findByRole("checkbox", { name: copy.triggerComments });
    expect(comments()).toBeEnabled();
    expect(comments()).not.toHaveAccessibleDescription(
      copy.triggerDisabledByAll,
    );
  });

  it("refuses the channel's own choice while the master holds it", async () => {
    const user = userEvent.setup();
    const instance = createInstanceDouble();
    render(show(createLocaleDouble(), instance));

    await user.click(await master());
    await user.click(comments());

    // Disabled means disabled: the click reached nothing, so the instance was
    // asked exactly once, about the master.
    expect(instance.triggerWrites).toEqual([{ name: "all", enabled: false }]);
  });

  it("gives each channel back the choice it had, not both switched on", async () => {
    const user = userEvent.setup();
    const instance = createUnevenInstance();
    render(show(createLocaleDouble(), instance));

    await user.click(await master());
    await user.click(await master());

    // The whole difference between "returns them to operation" and "turns them
    // on". Comments were off before the master went on, and comments come back
    // OFF: the master overrides the two channels and never rewrites them, so
    // neither the screen nor the instance has anything to restore.
    expect(instance.triggerWrites).toEqual([
      { name: "all", enabled: false },
      { name: "all", enabled: true },
    ]);
    expect(await master()).not.toBeChecked();
    expect(comments()).toBeEnabled();
    expect(comments()).not.toBeChecked();
    expect(directMessages()).toBeEnabled();
    expect(directMessages()).toBeChecked();
  });
});

/* ==========================================================================
 * REQ-323, REQ-324, REQ-325: what left the screen, what it is called, and
 * where the two buttons went.
 *
 * The removal is a CLOSED list of eight texts the operator named, so it is
 * asserted as a closed list: the keys that carried them are gone from both
 * catalogues, and the sentences that merely stood NEXT to them are still
 * rendered. A test that only checked the absences would pass just as happily
 * after somebody took the whole panel out, which is the failure this
 * requirement is really about.
 *
 * The keys are named as strings and not as `copy.something`, for the obvious
 * reason: they no longer exist, so there is nothing to reach through the typed
 * import. That makes this list the one thing here that could rot, so it is
 * guarded from both ends below.
 * ========================================================================== */

/** The catalogue sections, opened for lookup by a key that may not exist. */
const CATALOGUES: Readonly<Record<string, Record<string, unknown>>> = {
  en: en.settings,
  "pt-BR": pt.settings,
};

/**
 * The eight texts the operator listed, by the keys that used to carry them.
 *
 * Five of the global settings block (the lead, "why these four live here", the
 * platform's 24 hour window, whoever is already waiting, and the count that
 * includes the first question), the note about the catalogue, the long
 * paragraph under the time zone, and the preview, which is every key the two
 * handsets on this screen were drawn from.
 */
const REMOVED_TEXT_KEYS: readonly string[] = [
  "conversationLead",
  "conversationWhyTitle",
  "conversationWhy",
  "waitWindowTitle",
  "waitWindow",
  "waitOngoingTitle",
  "waitOngoing",
  "questionsWhyTitle",
  "questionsWhy",
  "catalogueNote",
  "timezoneNote",
  "previewLivedLabel",
  "previewLivedTip",
  "previewQuestionStep",
  "previewClosingStep",
  "previewMoreQuestions",
  "previewQuestionText",
  "previewReplyFirst",
  "previewReplySecond",
  "previewReplyThird",
  "previewClosingEmpty",
];

/**
 * The three the user asked BACK on 2026-08-20, and the reason they are a list
 * of their own (REQ-350, and it undoes one line of REQ-323).
 *
 * He wrote "the preview of the Settings screen goes", in the singular, and the
 * screen had TWO. Task 3p.4 removed both and declared the ambiguity rather than
 * choosing in silence, which is the only reason this could be answered in a
 * minute: the lived conversation of the four global settings stays gone, and
 * the one that draws the follow button comes back. It is the single field here
 * whose value cannot be pictured from the field itself, because the words do
 * not arrive as text but as a button under a message.
 */
const RESTORED_PREVIEW_KEYS: readonly string[] = [
  "previewFollowLabel",
  "previewFollowTip",
  "previewFollowText",
];

/**
 * Every one of `keys` a catalogue still carries, named with its language.
 *
 * Plural families are looked up by their forms too: a base nobody removed the
 * `_other` of is a sentence still shipped, and a check reading only the base
 * would call it gone.
 */
function stillCarried(keys: readonly string[]): string[] {
  return Object.entries(CATALOGUES).flatMap(([locale, section]) =>
    keys
      .filter((key) =>
        [key, `${key}_one`, `${key}_many`, `${key}_other`].some(
          (form) => section[form] !== undefined,
        ),
      )
      .map((key) => `${locale}: settings.${key}`),
  );
}

describe("REQ-323: the block is Global settings, and the eight texts are gone", () => {
  it("names the block by what it holds, in both languages", async () => {
    render(show(createLocaleDouble()));

    // The words themselves, because the rename IS the requirement: a title that
    // kept its key and its old sentence would satisfy a test that only asked
    // whether a heading is on the page.
    expect(copy.conversationTitle).toBe("Global settings");
    expect(copyPt.conversationTitle).toBe("Configurações globais");
    expect(
      await screen.findByRole("heading", { name: copy.conversationTitle }),
    ).toBeInTheDocument();
  });

  it("carries none of the eight in either catalogue", () => {
    expect(stillCarried(REMOVED_TEXT_KEYS)).toStrictEqual([]);
  });

  it("carries the follow preview back, in both languages (REQ-350)", () => {
    // The other direction of the same guard: the removal must not creep back
    // over a text he asked to keep, and an empty catalogue would satisfy the
    // absence above for free.
    expect(stillCarried(RESTORED_PREVIEW_KEYS)).toHaveLength(
      RESTORED_PREVIEW_KEYS.length * 2,
    );
  });

  it("reports a text that is still shipped, naming it and the language", () => {
    // Guards the guard, from both ends. A detector that could see nothing would
    // pass the check above on a catalogue that lost not one word, and a list
    // that had gone empty would pass it on a catalogue that lost all of them.
    expect(REMOVED_TEXT_KEYS.length).toBeGreaterThan(20);
    expect(stillCarried(["questionsTip"])).toStrictEqual([
      "en: settings.questionsTip",
      "pt-BR: settings.questionsTip",
    ]);
    // And the plural family is read by its forms: `previewMoreQuestions` was
    // only ever written as `_one`, `_many` and `_other`.
    expect(stillCarried(["waitEchoHours"])).toHaveLength(2);
  });

  it("draws exactly ONE handset, the follow button's (REQ-350)", async () => {
    await opened();

    // The preview is a THING and not a sentence, so it is asserted on the
    // mockup rather than on the words inside it. ONE and not zero since
    // 2026-08-20: the lived conversation of the global settings is gone, the
    // follow button's came back, and the count is what tells the two apart
    // without naming a class the other one also carries.
    expect(document.querySelectorAll(".mc-phone")).toHaveLength(1);
    expect(
      await screen.findByText(copy.previewFollowLabel),
    ).toBeInTheDocument();
    // The one that stayed out is NOT asserted here, and the omission is the
    // point: `previewLivedLabel` sits in REMOVED_TEXT_KEYS, so the check above
    // already proves neither catalogue carries it. A text that exists nowhere
    // cannot be drawn, and reading the key off `copy` to say so was reading a
    // property the type no longer has: green under the suite, red under the
    // compiler, and proving nothing either way.
  });

  it("keeps every neighbouring sentence the list did not name", async () => {
    const { container } = render(
      show(createLocaleDouble(), createInstanceDouble()),
    );
    await screen.findByLabelText(copy.waitLabel);

    // The other half of the requirement, and the one a list of absences cannot
    // reach: the operator asked for eight texts out, not for a bare screen.
    // Every sentence below sat next to one of the eight and stays.
    //
    // The list held fourteen and holds thirteen. The one that left was the note
    // of the panel standing for what did not exist yet, and it did NOT leave by
    // the operator's list: the control it said had not been designed was
    // designed (REQ-326), which made the sentence false, and a text that DENIES
    // a behaviour the product has is the defect this screen has already paid
    // for twice. `themeNote` below is the same panel's note, rewritten to say
    // what is true now, and it is still here.
    for (const sentence of [
      copy.languageHint,
      copy.triggersHint,
      copy.waitTip,
      copy.waitScopeLabel,
      copy.waitScopeTip,
      copy.questionsTip,
      copy.closingTip,
      copy.closingHint,
      copy.followTip,
      copy.followRetapTitle,
      copy.followRetap,
      copy.conversationSaveHint,
      copy.themeNote,
    ]) {
      expect(screen.getByText(sentence), sentence).toBeInTheDocument();
    }

    // The badge over each of the three panels is a fact about scope and was on
    // no list: it says the setting beside it reaches every automation.
    expect(
      [...container.querySelectorAll(".mc-badge")].filter(
        (badge) => badge.textContent?.trim() === copy.conversationScope,
      ),
    ).toHaveLength(3);
  });
});

describe("REQ-324: the save and discard buttons are at the END of the screen", () => {
  it("puts both after everything else the page draws", async () => {
    const { container } = render(
      show(createLocaleDouble(), createInstanceDouble()),
    );
    await screen.findByLabelText(copy.waitLabel);

    const save = screen.getByRole("button", { name: copy.conversationSave });
    const discard = screen.getByRole("button", {
      name: copy.conversationDiscard,
    });
    // The last panel of the screen, which is the theme since REQ-326 and was
    // the block standing for what did not exist yet before it. The panel
    // CHANGED and its position did not, which is exactly what this case is
    // about: the buttons come after everything the page draws.
    const lastPanel = panelOf(copy.themeTitle);

    // After the LAST panel of the screen, which is the one they used to sit
    // well above: the row was in the middle of the page, between the follow
    // button block and the time zone.
    for (const button of [save, discard]) {
      expect(
        lastPanel.compareDocumentPosition(button) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    }

    // And nothing at all comes after them: the row they are in is the last
    // thing the page holds.
    const page = container.querySelector(".mc-page");

    expect(page?.lastElementChild?.contains(save)).toBe(true);
    expect(page?.lastElementChild?.contains(discard)).toBe(true);
  });

  it("still saves and discards from where they now are", async () => {
    const user = userEvent.setup();
    const conversation = await opened();

    const field = screen.getByLabelText(copy.waitLabel);
    await user.clear(field);
    await user.type(field, "12");
    await save(user);

    // Moving a button is only free if it still does what it did: the write
    // carries the four values, and the discard still puts the controls back.
    expect(conversation.written[0]?.waitHours).toBe(12);

    await user.clear(screen.getByLabelText(copy.waitLabel));
    await user.type(screen.getByLabelText(copy.waitLabel), "3");
    await user.click(
      screen.getByRole("button", { name: copy.conversationDiscard }),
    );

    expect(screen.getByLabelText(copy.waitLabel)).toHaveValue(12);
  });
});

describe("REQ-325: the language and the time zone live in one block", () => {
  it("holds both controls inside the same panel", async () => {
    render(show(createLocaleDouble(), createInstanceDouble()));
    await screen.findByLabelText(copy.timezoneLabel);

    const block = panelOf(copy.languageTitle);
    const language = screen.getByLabelText(copy.languageLabel);
    const zone = screen.getByLabelText(copy.timezoneLabel);

    // The SAME element, which is the requirement said exactly: not two panels
    // that happen to sit next to each other, one block holding both controls.
    expect(language.closest(".mc-panel")).toBe(block);
    expect(zone.closest(".mc-panel")).toBe(block);

    // And the block's own title names both, because the panel that carried the
    // zone had a title of its own and one of the two had to go.
    expect(copy.languageTitle).toBe("Language and time zone");
    expect(copyPt.languageTitle).toBe("Idioma e fuso horário");
  });

  it("keeps the zone's own failure inside that block", async () => {
    render(show(createLocaleDouble(), unreachableInstance));

    const block = panelOf(copy.languageTitle);

    // The zone that could not be READ still names no zone, and says so where
    // the control would have been rather than at the top of the page (REQ-166).
    expect(
      await within(block).findByText(copy.timezoneFailed),
    ).toBeInTheDocument();
    expect(
      within(block).getByLabelText(copy.languageLabel),
    ).toBeInTheDocument();
  });
});

describe("REQ-117: not a word of this screen is written in the code", () => {
  it("renders every one of its texts in the instance's language", async () => {
    render(show(createLocaleDouble(PT)));

    // The whole screen in the second language, block by block: a string left
    // in the code would come out in English right here.
    expect(
      await screen.findByRole("heading", { name: copyPt.title }),
    ).toBeInTheDocument();
    expect(screen.getByText(copyPt.languageHint)).toBeInTheDocument();
    // The block names are asked for as HEADINGS since REQ-327: each of them is
    // written twice on the screen, once as the block's own title and once as
    // the menu entry that jumps to it, and it is the heading that names a
    // block.
    expect(
      screen.getByRole("heading", { name: copyPt.languageTitle }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: copyPt.themeTitle }),
    ).toBeInTheDocument();
    expect(await screen.findByText(copyPt.timezoneLabel)).toBeInTheDocument();
    expect(screen.getByText(copyPt.themeNote)).toBeInTheDocument();
    expect(screen.getByText(copyPt.themeLabel)).toBeInTheDocument();

    // The three answers of the theme, which are the words this task added: a
    // locale code names itself and an IANA zone IS its own name, so these are
    // the only options on the screen that a catalogue has to carry.
    for (const word of [
      copyPt.themeSystem,
      copyPt.themeLight,
      copyPt.themeDark,
    ]) {
      expect(screen.getByRole("option", { name: word })).toBeInTheDocument();
    }
  });
});

/* ==========================================================================
 * The four settings of the automatic conversation, on the screen that holds
 * them (REQ-252, REQ-254, REQ-255, REQ-257).
 *
 * The storage, the bounds and the route were proved by the task that built
 * them (`src/config/instance-settings.test.ts`, `src/http/api/instance.test.ts`).
 * What is proved HERE is the half an operator meets: the four values read and
 * shown, one write that carries them together, the instance's refusal arriving
 * WITH the number it names, and the two sentences these settings cannot ship
 * without.
 *
 * Two of the cases below assert the WORDS of a sentence and not merely that it
 * is on the page, and that is deliberate: a test reading the catalogue for both
 * the expectation and the assertion would go on passing after the sentence was
 * gutted. The requirement names the content, so the content is what is asserted
 * (the same shape `screens/automation-form.test.tsx` uses for REQ-254 there).
 * ========================================================================== */

/**
 * The screen with the four read and the controls filled, which is where every
 * case below starts.
 */
async function opened(
  conversation: ConversationDouble = createConversationDouble(),
): Promise<ConversationDouble> {
  render(show(createLocaleDouble(), createInstanceDouble(), conversation));
  await screen.findByLabelText(copy.waitLabel);

  return conversation;
}

/** Asks the instance to store what the controls hold. */
async function save(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.click(screen.getByRole("button", { name: copy.conversationSave }));
}

/**
 * The refusal codes this route can answer with, taken from the rule that owns
 * them (`INSTANCE_SETTINGS_REFUSALS` in `src/config/instance-settings.ts`).
 *
 * Written here as data rather than imported, for the reason `LIMITS` above is:
 * `src/web` reads no module of the server, and a browser bundle that pulled in
 * `node:fs` through the config would not build. They are three short strings,
 * and a case below drives the screen with every one of them, so a code that
 * lost its sentence is a red test rather than a screen that says nothing.
 *
 * THREE and not four: the button text is no longer among them (REQ-306). Its
 * number is where the platform stops drawing the label, so the route stores
 * past it and the field warns instead of the toast refusing.
 */
const REFUSAL_CODES = [
  "wait_hours_out_of_range",
  "questions_out_of_range",
  "closing_message_empty",
] as const;

describe("REQ-252: one deadline in hours, held by the instance", () => {
  it("reads the deadline in force and the bounds the instance declares", async () => {
    await opened();

    const field = screen.getByLabelText(copy.waitLabel);

    // Value and bounds both came from the instance's answer. Nothing on this
    // screen writes 168 down a second time, so the day the rule moves the field
    // moves with it instead of disagreeing with it.
    expect(field).toHaveValue(STORED_SETTINGS.waitHours);
    expect(field).toHaveAttribute("min", String(LIMITS.waitHoursMin));
    expect(field).toHaveAttribute("max", String(LIMITS.waitHoursMax));
    expect(descriptionOf(field)).toContain(
      resolve(copy.waitHint, {
        min: LIMITS.waitHoursMin,
        max: LIMITS.waitHoursMax,
      }),
    );
  });

  it("says the number back in words, so a week is not read as a hundred and sixty-eight", async () => {
    await opened();

    // A restatement and never a verdict: it says what 168 IS, and refuses
    // nothing. Announced with the control, so it is not a decoration only the
    // sighted operator gets.
    expect(descriptionOf(screen.getByLabelText(copy.waitLabel))).toContain(
      resolve(copy.waitEchoExact, {
        hours: resolve(copy.waitEchoHours_other, { count: 168 }),
        days: resolve(copy.waitEchoDays_other, { count: 7 }),
      }),
    );
  });

  it("is ONE deadline, named for the three requests that wait", async () => {
    await opened();

    // The whole of the requirement's second half: the step stopped declaring a
    // deadline, so there is one field here and not three, and the three that
    // wait are named beside it rather than left to be guessed.
    expect(screen.getAllByLabelText(copy.waitLabel)).toHaveLength(1);

    const wait = panelOf(copy.waitTitle);

    expect(within(wait).getByText(copy.waitScopeLabel)).toBeInTheDocument();
    expect(
      within(wait).getByText(copy.waitStepConfirmation),
    ).toBeInTheDocument();
    expect(within(wait).getByText(copy.waitStepEmail)).toBeInTheDocument();
    expect(within(wait).getByText(copy.waitStepFollow)).toBeInTheDocument();
    // And it is the instance's, not this automation's: the badge says so over
    // the panel, in the same words the other two carry.
    expect(within(wait).getByText(copy.conversationScope)).toBeInTheDocument();
  });

  it("stores a new deadline and then shows what the instance kept", async () => {
    const user = userEvent.setup();
    const conversation = await opened();

    const field = screen.getByLabelText(copy.waitLabel);
    await user.clear(field);
    await user.type(field, "24");
    await save(user);

    expect(conversation.written).toHaveLength(1);
    expect(conversation.written[0]?.waitHours).toBe(24);
    expect(conversation.stored.waitHours).toBe(24);
    // Adopted from the ANSWER: a control that moved on its own would show a
    // value the next reload corrects.
    expect(await screen.findByLabelText(copy.waitLabel)).toHaveValue(24);
    expect(screen.getByText(copy.conversationStored)).toBeInTheDocument();
  });

  it("names the instance's own ceiling when the deadline is refused", async () => {
    const user = userEvent.setup();
    const conversation = createConversationDouble();
    conversation.refusal = {
      error: "wait_hours_out_of_range",
      limit: LIMITS.waitHoursMax,
    };
    await opened(conversation);

    const field = screen.getByLabelText(copy.waitLabel);
    await user.clear(field);
    await user.type(field, "999");
    await save(user);

    const refused = resolve(copy.refusalWaitHours_other, {
      count: LIMITS.waitHoursMax,
    });
    const answer = await toast();

    // The refusal REACHES the operator, and it carries the number the instance
    // named: this sentence is the only place the ceiling is ever said out loud,
    // and a screen that swallowed it would look exactly like one that saved.
    expect(answer).toHaveTextContent(copy.conversationNotStoredTitle);
    expect(answer).toHaveTextContent(refused);
    expect(refused).toContain(String(LIMITS.waitHoursMax));

    // Beside the field too, and announced with it: a refusal drawn only at the
    // top is a refusal whoever is typing is never told about (REQ-149).
    expect(descriptionOf(field)).toContain(refused);
    expect(field).toHaveAttribute("aria-invalid", "true");

    // Nothing was stored, and nothing moved: what was typed stays there to be
    // corrected, which is what the sentence just promised.
    expect(field).toHaveValue(999);
    expect(conversation.stored.waitHours).toBe(STORED_SETTINGS.waitHours);
  });
});

describe("REQ-254: the number of questions counts the FIRST one", () => {
  it("reads the number in force and calls them questions, never attempts", async () => {
    await opened();

    const field = screen.getByLabelText(copy.questionsLabel);

    expect(field).toHaveValue(STORED_SETTINGS.questions);
    expect(field).toHaveAttribute("min", String(LIMITS.questionsMin));

    // The name is half the defect: "number of attempts" is read as "how many
    // times it may try AGAIN", and that reading is exactly what makes an
    // operator ask for 2 and receive 3 questions.
    expect(copy.questionsLabel).toMatch(/questions/i);
    expect(copy.questionsLabel).not.toMatch(/attempt|retr/i);
    expect(copyPt.questionsLabel).toMatch(/perguntas/i);
    expect(copyPt.questionsLabel).not.toMatch(/tentativa/i);
  });

  it("says in the field's own tip that the first question is counted", async () => {
    await opened();

    // The sentence this field cannot ship without, asserted as CONTENT: a tip
    // that kept its shape and lost this clause would still render, and the
    // operator would go on reading the number as a retry counter.
    expect(copy.questionsTip).toMatch(/the first one counted/i);
    expect(copy.questionsTip).toMatch(/2 is the question plus one repeat/i);
    expect(copyPt.questionsTip).toMatch(/contando a primeira/i);
    expect(copyPt.questionsTip).toMatch(/2 é a pergunta mais uma repergunta/i);

    // And it travels WITH the control rather than sitting near it.
    expect(screen.getByText(copy.questionsTip)).toBeInTheDocument();
    expect(descriptionOf(screen.getByLabelText(copy.questionsLabel))).toContain(
      copy.questionsTip,
    );
  });

  /**
   * The case that stood here was "REQ-275: carries the WHOLE explanation, which
   * the editor no longer does", and it asserted a notice this screen no longer
   * draws. It is rewritten rather than deleted, and this is the written reason.
   *
   * REQ-323 took the notice out by name ("o número de perguntas conta a
   * primeira"), and REQ-254 was left exactly where it was: the RULE did not
   * move, only the paragraph arguing for it. Deleting the case would have left
   * the rule with one proof fewer and nothing saying why, so what it asserts
   * now is the pair of facts that replaced it.
   *
   * WHERE THE BEHAVIOUR IS PROVED, and it is not here. A screen cannot show
   * that the first question is counted; the runtime can, and does:
   * `src/runtime/confirmation.test.ts`, "REQ-254: two questions means two
   * cards, and the second mistake ends it" (a ceiling of two sends TWO cards in
   * all, not two after the first), with the minimum of one and its reason in
   * `src/config/instance-settings.test.ts`. This case is about what the SCREEN
   * still tells the operator, which is the half those cannot reach.
   */
  it("REQ-323: drops the notice and still says the first question is counted", async () => {
    await opened();

    // Gone, and gone from the catalogue too: a sentence left behind in
    // `locales/*.json` reads as current to whoever rewords it next (REQ-172).
    expect(en.settings).not.toHaveProperty("questionsWhyTitle");
    expect(en.settings).not.toHaveProperty("questionsWhy");
    expect(pt.settings).not.toHaveProperty("questionsWhyTitle");
    expect(pt.settings).not.toHaveProperty("questionsWhy");

    // And the rule is still stated where the number is typed, by two different
    // sentences: the tip says it in words, and the echo does the arithmetic for
    // the value in force. Both travel WITH the control, which the removed
    // notice never did.
    const field = screen.getByLabelText(copy.questionsLabel);
    const described = descriptionOf(field);

    expect(described).toContain(copy.questionsTip);
    expect(copy.questionsTip).toMatch(/the first one counted/i);
    expect(copyPt.questionsTip).toMatch(/contando a primeira/i);
    expect(described).toContain(
      resolve(copy.questionsEcho_other, {
        questions: STORED_SETTINGS.questions,
        count: STORED_SETTINGS.questions - 1,
      }),
    );
  });

  it("says the count back with the repeats told apart from the first question", async () => {
    await opened();

    // Three is one question and two repeats, and the echo is what makes that
    // arithmetic something the operator reads instead of performs.
    expect(descriptionOf(screen.getByLabelText(copy.questionsLabel))).toContain(
      resolve(copy.questionsEcho_other, { questions: 3, count: 2 }),
    );
  });

  it("names the two requests it holds for", async () => {
    await opened();

    const hint = descriptionOf(screen.getByLabelText(copy.questionsLabel));

    // "Pedir o e-mail" and "Pedir confirmação", in the requirement's own words:
    // the count is not a global tally over everything the automation does.
    expect(hint).toContain(copy.questionsHint);
    expect(copy.questionsHint).toContain(copy.waitStepEmail);
    expect(copy.questionsHint).toContain(copy.waitStepConfirmation);
    expect(copyPt.questionsHint).toContain(copyPt.waitStepEmail);
    expect(copyPt.questionsHint).toContain(copyPt.waitStepConfirmation);
  });

  it("stores a new count and then shows what the instance kept", async () => {
    const user = userEvent.setup();
    const conversation = await opened();

    const field = screen.getByLabelText(copy.questionsLabel);
    await user.clear(field);
    await user.type(field, "2");
    await save(user);

    expect(conversation.written[0]?.questions).toBe(2);
    expect(conversation.stored.questions).toBe(2);
    expect(await screen.findByLabelText(copy.questionsLabel)).toHaveValue(2);
  });

  it("names the minimum when the count is refused", async () => {
    const user = userEvent.setup();
    const conversation = createConversationDouble();
    conversation.refusal = {
      error: "questions_out_of_range",
      limit: LIMITS.questionsMin,
    };
    await opened(conversation);

    const field = screen.getByLabelText(copy.questionsLabel);
    await user.clear(field);
    await save(user);

    const refused = resolve(copy.refusalQuestions_one, {
      count: LIMITS.questionsMin,
    });

    expect(await toast()).toHaveTextContent(refused);
    expect(refused).toContain(String(LIMITS.questionsMin));
    expect(descriptionOf(field)).toContain(refused);
    expect(field).toHaveAttribute("aria-invalid", "true");
  });
});

describe("REQ-255: one closing message, with a default from the catalogue", () => {
  it("reads the message in force and says when the person receives it", async () => {
    await opened();

    const field = screen.getByLabelText(copy.closingLabel);

    expect(field).toHaveValue(STORED_SETTINGS.closingMessage);

    // What the requirement asks the screen to say: it goes out when the
    // questions run out, in the place the silence used to be.
    expect(copy.closingTip).toMatch(/when the questions run out/i);
    expect(copy.closingTip).toMatch(/silence/i);
    expect(copyPt.closingTip).toMatch(/quando as perguntas acabam/i);
    expect(copyPt.closingTip).toMatch(/silêncio/i);
    expect(descriptionOf(field)).toContain(copy.closingTip);
  });

  it("is ONE message for both requests, and it arrives already written", async () => {
    await opened();

    // One field and not one per step, which is the requirement in a sentence.
    expect(screen.getAllByLabelText(copy.closingLabel)).toHaveLength(1);

    // And what it arrives holding is the CATALOGUE's, which is what the route
    // falls back to for an instance whose operator never wrote one.
    expect(screen.getByLabelText(copy.closingLabel)).toHaveValue(
      en.instance.closingMessage,
    );
    expect(descriptionOf(screen.getByLabelText(copy.closingLabel))).toContain(
      copy.closingHint,
    );
  });

  it("takes the operator's own text, and puts the default back on request", async () => {
    const user = userEvent.setup();
    const conversation = await opened();

    const field = screen.getByLabelText(copy.closingLabel);
    const written = "Fica para a próxima.";

    await user.clear(field);
    await user.type(field, written);
    await save(user);

    expect(conversation.written[0]?.closingMessage).toBe(written);
    expect(conversation.stored.closingMessage).toBe(written);
    expect(await screen.findByLabelText(copy.closingLabel)).toHaveValue(
      written,
    );

    // Back to the catalogue's own sentence, which is the same text the instance
    // resolves when nothing was ever written.
    await user.click(screen.getByRole("button", { name: copy.closingReset }));

    expect(screen.getByLabelText(copy.closingLabel)).toHaveValue(
      en.instance.closingMessage,
    );
  });

  it("draws the refusal on the message itself, wired to the control", async () => {
    const user = userEvent.setup();
    const conversation = createConversationDouble();
    conversation.refusal = { error: "closing_message_empty" };
    await opened(conversation);

    const field = screen.getByLabelText(copy.closingLabel);
    await user.clear(field);
    await save(user);

    const answer = await toast();

    expect(answer).toHaveTextContent(copy.refusalClosingMessage);
    // A textarea gets its refusal the same way a field does, or the one control
    // on this screen that is not an input would be the one whose refusal only
    // a sighted operator ever meets.
    expect(descriptionOf(field)).toContain(copy.refusalClosingMessage);
    expect(field).toHaveAttribute("aria-invalid", "true");
    expect(field.classList).toContain("mc-input--invalid");
    expect(conversation.stored.closingMessage).toBe(
      STORED_SETTINGS.closingMessage,
    );
  });
});

describe("REQ-306: the follow button label warns above twenty, and stores past it", () => {
  it("reads the label in force and shows the ceiling as a number", async () => {
    await opened();

    const field = screen.getByLabelText(copy.followLabel);

    expect(field).toHaveValue(STORED_SETTINGS.followButtonLabel);
    // The ceiling is VISIBLE before anything is cut: in the counter beside the
    // label and in the sentence announced with the control. Both numbers are
    // the instance's, and neither is on the control as a `maxLength`.
    expect(
      screen.getByText(
        resolve(copy.followCounter, {
          used: [...STORED_SETTINGS.followButtonLabel].length,
          max: LIMITS.followButtonLabelChars,
        }),
      ),
    ).toBeInTheDocument();
    expect(descriptionOf(field)).toContain(
      resolve(copy.followHint, { max: LIMITS.followButtonLabelChars }),
    );
    expect(
      resolve(copy.followHint, { max: LIMITS.followButtonLabelChars }),
    ).toContain("20");
  });

  it("lets a longer label be typed, with nothing on the control stopping it", async () => {
    const user = userEvent.setup();
    await opened();

    const field = screen.getByLabelText(copy.followLabel);
    const long = `${"a".repeat(LIMITS.followButtonLabelChars)}bcdefg`;

    // The attribute is what USED to be here, and it was the worse half of the
    // refusal: past twenty the keyboard stopped answering, with no sentence
    // anywhere saying why. Asserted as absent AND as ineffective, because the
    // second is the behaviour and the first is only how it was caused.
    expect(field).not.toHaveAttribute("maxLength");

    await user.clear(field);
    await user.type(field, long);

    expect(field).toHaveValue(long);
  });

  it("warns that the longer label will arrive cut, without calling it invalid", async () => {
    const user = userEvent.setup();
    await opened();

    const field = screen.getByLabelText(copy.followLabel);
    await user.clear(field);
    await user.type(field, `${"a".repeat(LIMITS.followButtonLabelChars)}b`);

    const warning = resolve(en.field.truncationWarning, {
      max: LIMITS.followButtonLabelChars,
    });
    const advice = adviceOf(field);

    expect(advice).toHaveTextContent(warning);
    // Announced as it appears and never as an interruption: it comes and goes
    // with the keystrokes, so it is polite and not assertive.
    expect(advice).toHaveAttribute("role", "status");
    // Announced WITH the control, or it is a sentence only a sighted operator
    // ever meets (REQ-149).
    expect(descriptionOf(field)).toContain(warning);
    // And not marked invalid, which is the whole difference between the two
    // natures: the platform ACCEPTS this text, so a field flagged as wrong over
    // it would say the opposite of the sentence beside it.
    expect(field).not.toHaveAttribute("aria-invalid");
    expect(field.classList).not.toContain("mc-input--invalid");
  });

  it("takes the warning back the moment the text is inside the ceiling again", async () => {
    const user = userEvent.setup();
    await opened();

    const field = screen.getByLabelText(copy.followLabel);
    await user.clear(field);
    await user.type(field, `${"a".repeat(LIMITS.followButtonLabelChars)}b`);

    expect(adviceOf(field)).not.toBeNull();

    // Exactly at the ceiling arrives whole, so exactly at the ceiling says
    // nothing: an advice that stayed up would be advising about a text that is
    // fine.
    await user.type(field, "{Backspace}");

    expect(adviceOf(field)).toBeNull();
  });

  it("counts what a person counts, and not what the browser counts", async () => {
    const user = userEvent.setup();
    await opened();

    const field = screen.getByLabelText(copy.followLabel);
    // Nineteen letters and a lock: twenty characters to whoever typed them, and
    // twenty-one UTF-16 units to the browser. The counter shows theirs.
    const typed = `${"a".repeat(LIMITS.followButtonLabelChars - 1)}🔒`;

    await user.clear(field);
    await user.paste(typed);

    expect(typed.length).toBe(LIMITS.followButtonLabelChars + 1);
    expect(
      screen.getByText(
        resolve(copy.followCounter, {
          used: LIMITS.followButtonLabelChars,
          max: LIMITS.followButtonLabelChars,
        }),
      ),
    ).toBeInTheDocument();
  });

  it("stores the longer label whole, and is refused nothing for its length", async () => {
    const user = userEvent.setup();
    const conversation = await opened();

    const field = screen.getByLabelText(copy.followLabel);
    const long = "Já segui a sua conta agora mesmo";
    await user.clear(field);
    await user.type(field, long);
    await save(user);

    // Character for character, and read back off what the instance KEPT: a
    // screen that trimmed the value on the way out would send a shorter label
    // and show the operator no sign of it.
    expect(conversation.written[0]?.followButtonLabel).toBe(long);
    expect(conversation.stored.followButtonLabel).toBe(long);
    expect(await screen.findByLabelText(copy.followLabel)).toHaveValue(long);
  });

  it("counts what is typed against the ceiling as it is typed", async () => {
    const user = userEvent.setup();
    await opened();

    const field = screen.getByLabelText(copy.followLabel);

    await user.clear(field);
    await user.type(field, "segui");

    expect(
      screen.getByText(
        resolve(copy.followCounter, {
          used: "segui".length,
          max: LIMITS.followButtonLabelChars,
        }),
      ),
    ).toBeInTheDocument();
  });

  it("stores a new label and then shows what the instance kept", async () => {
    const user = userEvent.setup();
    const conversation = await opened();

    const field = screen.getByLabelText(copy.followLabel);
    await user.clear(field);
    await user.type(field, "Segui!");
    await save(user);

    expect(conversation.written[0]?.followButtonLabel).toBe("Segui!");
    expect(conversation.stored.followButtonLabel).toBe("Segui!");
    expect(await screen.findByLabelText(copy.followLabel)).toHaveValue(
      "Segui!",
    );
  });

  it("keeps the ceiling out of the browser, and reads it off the instance", async () => {
    // A different instance, tuned to a different platform ceiling. Everything
    // the screen says about the cut has to move with it, or the panel is
    // describing a platform other than the one it is talking to.
    const other = 12;
    const conversation = createConversationDouble();
    conversation.stored = {
      ...STORED_SETTINGS,
      followButtonLabel: "a".repeat(other),
      limits: { ...LIMITS, followButtonLabelChars: other },
    };
    await opened(conversation);

    const field = screen.getByLabelText(copy.followLabel);

    expect(descriptionOf(field)).toContain(
      resolve(copy.followHint, { max: other }),
    );
    expect(
      screen.getByText(
        resolve(copy.followCounter, { used: other, max: other }),
      ),
    ).toBeInTheDocument();
    // At the tuned ceiling and not past it: nothing is advised, which proves
    // the advice is decided on the instance's number and not on twenty.
    expect(adviceOf(field)).toBeNull();
  });
});

describe("REQ-252, REQ-254, REQ-255, REQ-257: the four are one write", () => {
  it("sends the four together, because the instance refuses them as a whole", async () => {
    const user = userEvent.setup();
    const conversation = await opened();

    const wait = screen.getByLabelText(copy.waitLabel);
    const questions = screen.getByLabelText(copy.questionsLabel);
    const closing = screen.getByLabelText(copy.closingLabel);
    const follow = screen.getByLabelText(copy.followLabel);

    await user.clear(wait);
    await user.type(wait, "48");
    await user.clear(questions);
    await user.type(questions, "2");
    await user.clear(closing);
    await user.type(closing, "Até mais.");
    await user.clear(follow);
    await user.type(follow, "Segui");
    await save(user);

    // ONE request carrying four values, and not four requests: the route stores
    // them as a whole, so a screen that sent them one at a time would leave the
    // operator with half of what they asked for.
    expect(conversation.written).toEqual([
      {
        waitHours: 48,
        questions: 2,
        closingMessage: "Até mais.",
        followButtonLabel: "Segui",
      },
    ]);
  });

  it("puts every control back to what the instance holds when asked to discard", async () => {
    const user = userEvent.setup();
    const conversation = await opened();

    const wait = screen.getByLabelText(copy.waitLabel);
    await user.clear(wait);
    await user.type(wait, "3");

    await user.click(
      screen.getByRole("button", { name: copy.conversationDiscard }),
    );

    expect(screen.getByLabelText(copy.waitLabel)).toHaveValue(
      STORED_SETTINGS.waitHours,
    );
    // Nothing was asked of the instance, because nothing was decided.
    expect(conversation.written).toEqual([]);
  });

  it("has a sentence for every refusal the route can answer with", async () => {
    const user = userEvent.setup();

    for (const error of REFUSAL_CODES) {
      const conversation = createConversationDouble();
      conversation.refusal = { error, limit: 20 };
      const view = render(
        show(createLocaleDouble(), createInstanceDouble(), conversation),
      );

      await screen.findByLabelText(copy.waitLabel);
      await save(user);

      const answer = await toast();

      // Not the fallback: a code that lost its sentence would still raise a
      // toast, and the operator would be told only that something went wrong
      // with no idea which of the four it was about.
      expect(answer).not.toHaveTextContent(copy.refusalUnknown);
      expect(answer).toHaveTextContent(copy.conversationNotStoredTitle);

      view.unmount();
    }
  });

  it("still says the four were not stored when the code is one it never heard of", async () => {
    const user = userEvent.setup();
    const conversation = createConversationDouble();
    conversation.refusal = { error: "a_refusal_from_a_newer_instance" };
    await opened(conversation);

    await save(user);

    // The failure that must never be silent: an unknown code is still a refusal,
    // and the four values are still exactly as they were.
    expect(await toast()).toHaveTextContent(copy.refusalUnknown);
  });

  it("carries every refusal sentence in both catalogues", () => {
    const catalogues = { en, "pt-BR": pt };

    for (const locale of Object.keys(catalogues)) {
      const translator = createTranslator(catalogues, locale);

      for (const key of CONVERSATION_REFUSAL_TEXT_KEYS) {
        const sentence = translator.t(key, { count: 20 });

        // Neither the placeholder for a key nothing carries, nor the key
        // itself: a refusal reaching the operator as `settings.refusalWaitHours`
        // is REQ-075 broken on the one screen that names a ceiling.
        expect(sentence).not.toBe(en.catalogue.missingText);
        expect(sentence).not.toBe(key);
        expect(sentence.length).toBeGreaterThan(0);
      }
    }
  });

  it("names no value at all when the instance could not be asked", async () => {
    render(
      show(
        createLocaleDouble(),
        createInstanceDouble(),
        unreachableConversation,
      ),
    );

    const failure = await screen.findByText(copy.conversationFailed);

    expect(failure).toBeInTheDocument();
    expect(screen.getByText(copy.conversationFailedTitle)).toBeInTheDocument();

    // Falling back to the defaults here would state 168 and 3 as if they were
    // what THIS instance holds, which is the defect the zone panel above
    // already paid for once.
    expect(screen.queryByLabelText(copy.waitLabel)).toBeNull();
    expect(screen.queryByLabelText(copy.questionsLabel)).toBeNull();
    expect(screen.queryByLabelText(copy.closingLabel)).toBeNull();
    expect(screen.queryByLabelText(copy.followLabel)).toBeNull();
  });

  it("renders the four in the language the instance is set to", async () => {
    render(
      show(
        createLocaleDouble(PT),
        createInstanceDouble(),
        createConversationDouble(),
      ),
    );

    // A word left in the code would come out in English right here.
    expect(await screen.findByLabelText(copyPt.waitLabel)).toBeInTheDocument();
    expect(screen.getByLabelText(copyPt.questionsLabel)).toBeInTheDocument();
    expect(screen.getByLabelText(copyPt.closingLabel)).toBeInTheDocument();
    expect(screen.getByLabelText(copyPt.followLabel)).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: copyPt.conversationTitle }),
    ).toBeInTheDocument();
    expect(screen.getByText(copyPt.waitTip)).toBeInTheDocument();
    expect(screen.getByText(copyPt.questionsTip)).toBeInTheDocument();
  });
});

/* ==========================================================================
 * REQ-281: the floor of a multi-line box reaches this screen too
 *
 * The floor is 74px for a box that takes more than one line, ANYWHERE in the
 * interface, and one rule of the component sheet declares it. That rule reaches
 * a screen only through the class the screen's box composes, so this is the
 * half neither `components/components.test.tsx` nor `styles/tokens.test.ts` can
 * see: the sheet can carry one perfect rule while a screen quietly stops
 * composing the class that consumes it.
 *
 * The closing message is this screen's only multi-line box, and it is the
 * shorter one on purpose (REQ-266): a public reply is a sentence. That
 * departure is a modifier ON TOP of the shared floor, never instead of it, so
 * what is asserted is that both classes are on the control and that the
 * departure really is downward from what the shared rule declares.
 *
 * jsdom applies no stylesheet, so no rendered height is measured here. The
 * sheet is read as text, the same way `screens/automation-form.test.tsx` reads
 * it, and the classes are read off a real render of the screen.
 * ========================================================================== */

/**
 * The component sheet, through `import.meta.glob` and not through an import,
 * for the reason `styles/tokens.test.ts` records: a `?raw` specifier would
 * break `tests/import-extensions.test.ts` (REQ-082).
 */
const SHEETS = import.meta.glob<string>("../components/components.css", {
  eager: true,
  query: "?raw",
  import: "default",
});

const COMPONENT_SHEET = Object.values(SHEETS)[0] ?? "";

/** What a rem is worth to a reader who changed nothing. */
const ROOT_FONT_PX = 16;

/** The floor a rule declares for this class, in pixels, or NaN if it declares none. */
function floorPxOf(selector: string): number {
  const rule = new RegExp(
    `${selector.replace(/\./g, "\\.")}\\s*\\{([^}]*)\\}`,
  ).exec(COMPONENT_SHEET.replace(/\/\*[\s\S]*?\*\//g, ""));
  const floor = /min-height:\s*([\d.]+)rem\s*;/.exec(rule?.[1] ?? "")?.[1];

  return floor === undefined ? Number.NaN : Number(floor) * ROOT_FONT_PX;
}

describe("REQ-281: the one floor for a multi-line box reaches this screen", () => {
  it("composes the shared rule under the sentence box, and the departure over it", async () => {
    await opened();

    // One multi-line box on this screen, so what follows is about the control
    // the requirement is about rather than about whichever one came first.
    const boxes = document.querySelectorAll("textarea");
    const closing = screen.getByLabelText(copy.closingLabel);

    expect(boxes).toHaveLength(1);
    expect(boxes[0]).toBe(closing);

    // `mc-textarea` is where the floor is written, once, for the whole
    // interface. A screen that dropped it would have a box with no floor at
    // all, and nothing on the screen would say so.
    const classes = [...closing.classList];

    expect(classes).toContain("mc-input");
    expect(classes).toContain("mc-textarea");
    expect(classes).toContain("mc-textarea--compact");
  });

  it("makes the sentence box a departure DOWNWARD from that shared floor", async () => {
    await opened();

    // A sweep that read an empty module would pass this forever: vitest
    // replaces a stylesheet with nothing unless `css` is on.
    expect(COMPONENT_SHEET.length).toBeGreaterThan(0);

    const shared = floorPxOf(".mc-textarea");
    const sentence = floorPxOf(".mc-textarea--compact");

    // Both read off the sheet rather than written down here, so the day the
    // shared floor moves this stops claiming a difference it lost. A public
    // reply is one line under a comment, and the box says so by being shorter
    // than the ordinary one and not by inventing a size of its own (REQ-266).
    expect(shared).toBeGreaterThan(0);
    expect(sentence).toBeLessThan(shared);
  });
});

/* ==========================================================================
 * REQ-326: the operator chooses the theme, and the choice is this machine's.
 *
 * Three answers, an answer that comes back after a reload, and a quotation the
 * theme does not reach. The MECHANISM under this (what the choice is stored in,
 * what marks the document, and the inline script that applies it before the
 * first paint) is proved in `src/web/theme.test.ts`; the palette's own half,
 * that no theme restates the colours of the quoted conversation, is proved in
 * `src/web/styles/tokens.test.ts`. What is proved here is the operator's half:
 * the control on the screen, and what picking an option does.
 * ========================================================================== */

describe("REQ-326: the operator chooses the theme", () => {
  beforeEach(() => {
    // jsdom keeps one document and one store for the whole file. A test that
    // left a theme behind would hand the next one a screen it never set up.
    window.localStorage.clear();
    document.documentElement.removeAttribute(THEME_ATTRIBUTE);
  });

  it("offers the three answers, and starts on the one in force", async () => {
    render(show(createLocaleDouble(), createInstanceDouble()));

    const control = await screen.findByLabelText(copy.themeLabel);

    expect(
      [...(control as HTMLSelectElement).options].map((option) => [
        option.value,
        option.textContent,
      ]),
    ).toEqual([
      ["system", copy.themeSystem],
      ["light", copy.themeLight],
      ["dark", copy.themeDark],
    ]);

    // A machine that has chosen nothing is on the system, and the control says
    // so instead of showing the first option by accident.
    expect(control).toHaveValue("system");
  });

  it("marks the ROOT element with the theme the operator picked", async () => {
    render(show(createLocaleDouble(), createInstanceDouble()));

    const control = await screen.findByLabelText(copy.themeLabel);

    await userEvent.selectOptions(control, "dark");

    // The root and nothing smaller: the semantic aliases of the palette are
    // declared at `:root` in terms of the primitives, so a mark on a region
    // would repaint the primitives and leave the aliases behind. Measured in
    // Chrome, and the sheet now restates them for a region too, but this is
    // where the interface puts the mark.
    expect(document.documentElement.getAttribute(THEME_ATTRIBUTE)).toBe("dark");
    expect(document.body.hasAttribute(THEME_ATTRIBUTE)).toBe(false);
  });

  it("takes the mark off again when the operator goes back to the system", async () => {
    render(show(createLocaleDouble(), createInstanceDouble()));

    const control = await screen.findByLabelText(copy.themeLabel);

    await userEvent.selectOptions(control, "light");
    await userEvent.selectOptions(control, "system");

    expect(document.documentElement.hasAttribute(THEME_ATTRIBUTE)).toBe(false);
    expect(control).toHaveValue("system");
  });

  it("comes back on the choice the last visit made", async () => {
    // What a reload IS, from this screen's side: the store already holds an
    // answer, nothing is held in memory, and the control has to open on it.
    window.localStorage.setItem(THEME_STORAGE_KEY, "dark");

    render(show(createLocaleDouble(), createInstanceDouble()));

    expect(await screen.findByLabelText(copy.themeLabel)).toHaveValue("dark");
  });

  it("stores the choice on this machine and sends it to no instance", async () => {
    const locale = createLocaleDouble();
    const instance = createInstanceDouble();

    render(show(locale, instance));

    const control = await screen.findByLabelText(copy.themeLabel);

    await userEvent.selectOptions(control, "light");

    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("light");

    // And not one write to the instance, which is the whole of "machine and
    // not instance": a second browser signing into this same panel keeps its
    // own theme, because there is nothing here for it to read.
    expect(instance.written).toEqual([]);
    expect(instance.triggerWrites).toEqual([]);
    expect(locale.written).toEqual([]);
  });

  it("carries no save button of its own: the choice is already applied", async () => {
    render(show(createLocaleDouble(), createInstanceDouble()));

    await screen.findByLabelText(copy.themeLabel);

    const themePanel = panelOf(copy.themeTitle);

    // The two buttons at the foot of the page belong to the global settings and
    // are outside this panel (REQ-324). Nothing inside it waits to be saved,
    // and the panel's own note is what says so.
    expect(within(themePanel).queryAllByRole("button")).toHaveLength(0);
    expect(within(themePanel).getByText(copy.themeNote)).toBeInTheDocument();
  });

  it("keeps a word in both catalogues for every answer it offers", () => {
    // A record is invisible to the walker in `catalogue.test.ts`, which reads
    // the arguments of `t("...")`: without this case an option could lose its
    // word in one language and come out as a key on the screen (REQ-174).
    const catalogues = { en, "pt-BR": pt };

    for (const locale of Object.keys(catalogues)) {
      const translator = createTranslator(catalogues, locale);

      for (const key of THEME_TEXT_KEYS) {
        const word = translator.t(key);

        expect(word, `${key} in ${locale}`).not.toBe(key);
        expect(word, `${key} in ${locale}`).not.toBe(en.catalogue.missingText);
      }
    }
  });
});

/* ==========================================================================
 * REQ-327: the screen is navigated by title, and it is operable on a handset
 *
 * Two halves, and only one of them can be proved in this file.
 *
 * The NAVIGATION is structure, so it is proved here from both ends: the menu
 * offers one entry per block, and every entry lands on the block whose heading
 * carries that same name. A menu asserted on its own would go on passing after
 * a block lost its id, and the operator would be pressing a link that scrolls
 * nowhere. It is also proved from the KEYBOARD, because a menu only the pointer
 * can reach is not navigation: the entries are links, Tab reaches them, and
 * activating one puts the focus on the block.
 *
 * The 44px and the absence of sideways scrolling are PIXELS, and jsdom applies
 * no stylesheet: nothing rendered here has a width or a height. What is held
 * here is the STRUCTURE that produces them, read out of the sheet as text (the
 * shape `screens/automation-form.test.tsx` uses), and the numbers themselves
 * were measured in a real browser at 320, 390, 768 and 1440, in both themes.
 * ========================================================================== */

/** Every entry of the menu of block titles, in the order it offers them. */
function jumpEntries(): readonly HTMLAnchorElement[] {
  return within(
    screen.getByRole("navigation", { name: copy.jumpLabel }),
  ).getAllByRole("link") as HTMLAnchorElement[];
}

/** What a rule of the component sheet declares, with its comments stripped. */
function ruleBodyOf(selector: string): string {
  const rule = new RegExp(
    `(?:^|\\})\\s*${selector.replace(/\./g, "\\.")}\\s*\\{([^}]*)\\}`,
  ).exec(COMPONENT_SHEET.replace(/\/\*[\s\S]*?\*\//g, ""));

  return rule?.[1] ?? "";
}

describe("REQ-327: Settings is navigated by the titles of its blocks", () => {
  it("offers one entry per block, including integrations", async () => {
    render(show(createLocaleDouble(), createInstanceDouble()));
    await screen.findByLabelText(copy.timezoneLabel);

    // A landmark with a name of its own, which is what a screen reader lists:
    // the rail of the casing is a navigation too, and two unnamed ones are two
    // entries reading "navigation".
    expect(jumpEntries().map((entry) => entry.textContent)).toEqual([
      copy.languageTitle,
      copy.triggersTitle,
      copy.conversationTitle,
      copy.themeTitle,
    ]);
  });

  it("lands every entry on the block whose heading carries its name", async () => {
    render(show(createLocaleDouble(), createInstanceDouble()));
    await screen.findByLabelText(copy.timezoneLabel);

    const findings = jumpEntries().flatMap((entry) => {
      const address = entry.getAttribute("href") ?? "";
      const block = document.getElementById(address.slice(1));

      if (block === null) {
        return [`${entry.textContent}: ${address} reaches nothing`];
      }

      // The block's own HEADING and not any text inside it: the title of a
      // block is what an assistive technology walks by, and a link that landed
      // on a region whose heading says something else would be a menu naming
      // the screen wrongly.
      const heading = within(block).queryByRole("heading", {
        name: entry.textContent ?? "",
      });

      return heading === null
        ? [`${entry.textContent}: the block it reaches carries no such heading`]
        : [];
    });

    expect(findings).toEqual([]);
  });

  it("is reachable and operable from the keyboard alone", async () => {
    const user = userEvent.setup();
    render(show(createLocaleDouble(), createInstanceDouble()));
    await screen.findByLabelText(copy.timezoneLabel);

    const theme = jumpEntries().at(-1) as HTMLAnchorElement;

    // Tab reaches it because it is a real link and not a click handler on a
    // word: nothing here gives it a tab index of its own.
    theme.focus();
    expect(theme).toHaveFocus();
    expect(theme).not.toHaveAttribute("tabindex");

    await user.keyboard("{Enter}");

    // And the focus arrives on the BLOCK, not merely the scroll: an operator
    // who cannot see the page move learns nothing from a page that only moved.
    const block = document.getElementById(SETTINGS_BLOCKS.theme);

    expect(block).toHaveFocus();
    expect(within(block as HTMLElement).getByLabelText(copy.themeLabel));
  });

  it("makes every block a heading, with the conversation's three under it", async () => {
    await opened();

    const named = (level: number): string[] =>
      screen
        .getAllByRole("heading", { level })
        .map((heading) => heading.textContent ?? "");

    // One screen, four blocks, and three settings inside one of them. Before
    // this requirement the whole page carried a single `h2` and its block names
    // were `<span>`s, so a reader walking the headings found the screen's own
    // name and nothing else.
    expect(named(1)).toEqual([copy.title]);
    expect(named(2)).toEqual([
      copy.languageTitle,
      copy.triggersTitle,
      copy.conversationTitle,
      copy.themeTitle,
    ]);
    expect(named(3)).toEqual([
      copy.waitTitle,
      copy.questionsTitle,
      copy.followTitle,
    ]);
  });

  it("makes every block a region, named by its own title", async () => {
    await opened();

    // The other list an assistive technology offers, and it is not the same
    // one: a heading is a word, a region is an area the reader can jump INTO
    // and read as a unit.
    expect(
      screen.getAllByRole("region").map((block) => block.getAttribute("id")),
    ).toEqual([
      SETTINGS_BLOCKS.language,
      SETTINGS_BLOCKS.triggers,
      SETTINGS_BLOCKS.conversation,
      SETTINGS_BLOCKS.theme,
    ]);
  });

  it("names the menu in the language the instance is set to", async () => {
    render(show(createLocaleDouble(PT), createInstanceDouble()));

    expect(
      await screen.findByRole("navigation", { name: copyPt.jumpLabel }),
    ).toBeInTheDocument();
    expect(copy.jumpLabel).not.toBe(copyPt.jumpLabel);
  });

  it("cuts the menu entries to the tap floor, and lets a title wrap", () => {
    // The sheet as text, because jsdom draws nothing. `min-height` from the one
    // token the product sizes a control with (REQ-268), and no width of its
    // own: a title is a sentence in two languages, and an entry that could not
    // wrap would push the page sideways at 320px.
    const entry = ruleBodyOf(".mc-jump__link");

    expect(entry).toContain("min-height: var(--tap)");
    expect(entry).toContain("max-inline-size: 100%");
    expect(entry).not.toMatch(/white-space:\s*nowrap/);
    expect(ruleBodyOf(".mc-jump__list")).toContain("flex-wrap: wrap");

    // And the block a link lands on clears the top edge of the scrolling
    // column, which on a handset is under the bar the rail folds into.
    expect(ruleBodyOf(".mc-jump-target")).toContain(
      "scroll-margin-block-start",
    );
  });

  it("gives the switches of this screen the same tap floor as a button", () => {
    // The three trigger switches were 24px tall on every width and in both
    // themes, measured in a browser: REQ-268's floor is written for buttons,
    // and a switch is not a button. The floor is on the LABEL, which is the
    // whole clickable area, so the track keeps its own drawing.
    expect(ruleBodyOf(".mc-switch")).toContain("min-block-size: var(--tap)");
  });
});

describe("Settings operates masked integrations in the authenticated panel", () => {
  it("shows persisted credentials without exposing the saved secrets", async () => {
    const configuration: ConfigurationClient = {
      read: () =>
        Promise.resolve({
          meta: {
            configured: true,
            appSecretConfigured: true,
            accountId: "17841465699776281",
          },
          storage: { driver: "local", configured: true },
          publicOrigin: "https://mychat.example.test",
          publicOriginVerifiedAt: "2026-09-06T00:00:00.000Z",
          webhookVerifyToken: true,
          installedVersion: "development",
        }),
      write: () => Promise.resolve({ ok: true }),
    };
    render(
      show(
        createLocaleDouble(),
        createInstanceDouble(),
        createConversationDouble(),
        configuration,
        undefined,
        "instance",
      ),
    );

    expect(await screen.findByLabelText(copy.metaAccountIdLabel)).toHaveValue(
      "17841465699776281",
    );
    expect(screen.getByLabelText(copy.metaAppSecretLabel)).toHaveValue(
      "••••••••••••",
    );
    expect(screen.getByLabelText(copy.metaAccessTokenLabel)).toHaveValue(
      "••••••••••••",
    );
    expect(screen.getByLabelText(copy.webhookTokenLabel)).toHaveValue(
      "••••••••••••",
    );
    expect(screen.getByLabelText(copy.publicOriginLabel)).toBeDisabled();
    expect(screen.getByLabelText(copy.webhookTokenLabel)).toBeDisabled();
    expect(screen.getByLabelText(copy.metaAppSecretLabel)).toBeDisabled();
    expect(screen.getByLabelText(copy.metaAccountIdLabel)).toBeDisabled();
    expect(screen.getByLabelText(copy.metaAccessTokenLabel)).toBeDisabled();
    expect(
      screen.getByRole("button", { name: copy.generateWebhookToken }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: copy.copyWebhookToken }),
    ).toBeDisabled();
  });

  it("confirms when the saved webhook token is copied", async () => {
    const generated = "new-webhook-token";
    let webhookVerifyToken = false;
    const configuration: ConfigurationClient = {
      read: () =>
        Promise.resolve({
          meta: { configured: false, appSecretConfigured: false },
          storage: { driver: "local", configured: true },
          publicOrigin: "https://mychat.example.test",
          publicOriginVerifiedAt: "2026-09-06T00:00:00.000Z",
          webhookVerifyToken,
          installedVersion: "development",
        }),
      write: (change) => {
        if (change.action === "set_webhook_verify_token") {
          webhookVerifyToken = true;
        }
        return Promise.resolve(
          change.action === "generate_webhook_verify_token"
            ? { ok: true, generatedWebhookVerifyToken: generated }
            : { ok: true },
        );
      },
    };
    const user = userEvent.setup();
    render(
      show(
        createLocaleDouble(),
        createInstanceDouble(),
        createConversationDouble(),
        configuration,
        undefined,
        "instance",
      ),
    );

    await screen.findByText(copy.webhookSectionTitle);
    await user.click(
      screen.getByRole("button", { name: copy.generateWebhookToken }),
    );
    await user.click(
      screen.getByRole("button", { name: copy.saveWebhookToken }),
    );
    const copyToken = screen.getByRole("button", {
      name: copy.copyWebhookToken,
    });
    await waitFor(() => expect(copyToken).toBeEnabled());
    await user.click(copyToken);

    expect(
      await screen.findByText(copy.copySucceededTitle),
    ).toBeInTheDocument();
    expect(screen.getByText(copy.webhookTokenCopied)).toBeInTheDocument();
  });

  it("shows a generated webhook token until saving it, then masks it", async () => {
    const generated = "new-webhook-token";
    const writes: Record<string, string>[] = [];
    const configuration: ConfigurationClient = {
      read: () =>
        Promise.resolve({
          meta: { configured: false, appSecretConfigured: false },
          storage: { driver: "local", configured: true },
          publicOrigin: "https://mychat.example.test",
          publicOriginVerifiedAt: "2026-09-06T00:00:00.000Z",
          webhookVerifyToken: false,
          installedVersion: "development",
        }),
      write: (change) => {
        writes.push(change);
        return Promise.resolve(
          change.action === "generate_webhook_verify_token"
            ? { ok: true, generatedWebhookVerifyToken: generated }
            : { ok: true },
        );
      },
    };
    const user = userEvent.setup();
    render(
      show(
        createLocaleDouble(),
        createInstanceDouble(),
        createConversationDouble(),
        configuration,
        undefined,
        "instance",
      ),
    );

    await screen.findByText(copy.webhookSectionTitle);
    await user.click(
      screen.getByRole("button", { name: copy.generateWebhookToken }),
    );
    const field = screen.getByLabelText(copy.webhookTokenLabel);
    await waitFor(() => expect(field).toHaveValue(generated));
    expect(field).toHaveClass("mc-input--mono");
    expect(field).toHaveAttribute("type", "text");
    await user.click(
      screen.getByRole("button", { name: copy.saveWebhookToken }),
    );

    await waitFor(() => expect(writes).toHaveLength(2));
    expect(field).toHaveValue(generated);
    expect(field).toHaveAttribute("type", "password");
  });

  it("keeps a pasted verification token readable until it is saved", async () => {
    const configuration: ConfigurationClient = {
      read: () =>
        Promise.resolve({
          meta: { configured: false, appSecretConfigured: false },
          storage: { driver: "local", configured: true },
          publicOrigin: "https://mychat.example.test",
          publicOriginVerifiedAt: "2026-09-06T00:00:00.000Z",
          webhookVerifyToken: false,
          installedVersion: "development",
        }),
      write: () => Promise.resolve({ ok: true }),
    };
    const user = userEvent.setup();
    render(
      show(
        createLocaleDouble(),
        createInstanceDouble(),
        createConversationDouble(),
        configuration,
        undefined,
        "instance",
      ),
    );

    const field = await screen.findByLabelText(copy.webhookTokenLabel);
    await user.type(field, "pasted-token");
    expect(field).toHaveAttribute("type", "text");
    await user.click(
      screen.getByRole("button", { name: copy.saveWebhookToken }),
    );
    await waitFor(() => expect(field).toHaveAttribute("type", "password"));
  });

  it("only enables public-address actions for the appropriate saved state", async () => {
    let savedOrigin: string | undefined = "https://mychat.example.test";
    const configuration: ConfigurationClient = {
      read: () =>
        Promise.resolve({
          meta: { configured: false, appSecretConfigured: false },
          storage: { driver: "local", configured: true },
          publicOrigin: savedOrigin,
          webhookVerifyToken: false,
          installedVersion: "development",
        }),
      write: (change) => {
        if (change.action === "set_public_origin") {
          savedOrigin = change.publicOrigin ?? savedOrigin;
        }
        if (change.action === "remove_public_origin") savedOrigin = undefined;
        return Promise.resolve({ ok: true });
      },
    };
    const user = userEvent.setup();
    render(
      show(
        createLocaleDouble(),
        createInstanceDouble(),
        createConversationDouble(),
        configuration,
        undefined,
        "instance",
      ),
    );

    const testAddress = await screen.findByRole("button", {
      name: copy.testPublicOrigin,
    });
    const saveAddress = screen.getByRole("button", {
      name: copy.savePublicOrigin,
    });
    expect(testAddress).toBeEnabled();
    expect(saveAddress).toBeDisabled();
    const address = screen.getByLabelText(copy.publicOriginLabel);
    expect(address).toBeDisabled();
    await user.click(
      screen.getByRole("button", { name: copy.removePublicOrigin }),
    );
    await user.click(
      screen.getByRole("button", { name: copy.removeConfigurationConfirm }),
    );
    await waitFor(() => expect(address).toBeEnabled());
    await user.type(address, "https://changed.example.test");
    expect(testAddress).toBeDisabled();
    expect(saveAddress).toBeEnabled();
    await user.click(saveAddress);
    await waitFor(() => expect(testAddress).toBeEnabled());
    expect(saveAddress).toBeDisabled();
  });

  it("allows entered Meta credentials to be saved while callback confirmation is pending", async () => {
    const configuration: ConfigurationClient = {
      read: () =>
        Promise.resolve({
          meta: { configured: false, appSecretConfigured: true },
          storage: { driver: "local", configured: true },
          publicOrigin: "https://mychat.example.test",
          publicOriginVerifiedAt: "2026-09-06T00:00:00.000Z",
          webhookVerifyToken: true,
          installedVersion: "development",
        }),
      write: () => Promise.resolve({ ok: true }),
    };
    const user = userEvent.setup();
    render(
      show(
        createLocaleDouble(),
        createInstanceDouble(),
        createConversationDouble(),
        configuration,
        undefined,
        "instance",
      ),
    );

    expect(
      await screen.findByText(copy.metaCredentialsReadyTitle),
    ).toBeInTheDocument();
    const saveMeta = screen.getByRole("button", { name: copy.saveMeta });
    expect(saveMeta).toBeDisabled();
    await user.type(screen.getByLabelText(copy.metaAccountIdLabel), "1784");
    await user.type(
      screen.getByLabelText(copy.metaAccessTokenLabel),
      "access-token",
    );
    expect(saveMeta).toBeEnabled();
  });

  it("locks saved integration values until the matching remove action", async () => {
    const configuration: ConfigurationClient = {
      read: () =>
        Promise.resolve({
          meta: {
            configured: true,
            appSecretConfigured: true,
            accountId: "1784",
          },
          storage: {
            driver: "r2",
            configured: true,
            endpoint: "https://r2.example.test",
            bucket: "assets",
          },
          publicOrigin: "https://panel.example.test",
          publicOriginVerifiedAt: "2026-09-06T00:00:00.000Z",
          webhookVerifyToken: true,
          webhookConfirmedAt: "2026-09-06T00:00:00.000Z",
          installedVersion: "1.2.3",
        }),
      write: () => {
        return Promise.resolve({ ok: true });
      },
    };
    render(
      show(
        createLocaleDouble(),
        createInstanceDouble(),
        createConversationDouble(),
        configuration,
        undefined,
        "instance",
      ),
    );
    await screen.findByText(copy.metaConfigured);
    expect(screen.queryByLabelText("Current password")).not.toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: copy.metaSectionTitle }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: copy.storageSectionTitle }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: copy.webhookSectionTitle }),
    ).toBeInTheDocument();
    expect(screen.queryByDisplayValue("saved-secret")).not.toBeInTheDocument();
    const appSecret = screen.getByLabelText(copy.metaAppSecretLabel);
    await waitFor(() => expect(appSecret).toHaveValue("••••••••••••"));
    expect(appSecret).toBeDisabled();
    expect(screen.getByLabelText(copy.metaAccountIdLabel)).toBeDisabled();
    expect(screen.getByLabelText(copy.metaAccessTokenLabel)).toBeDisabled();
    expect(screen.getByLabelText(copy.storageDriverLabel)).toBeDisabled();
    expect(screen.getByLabelText(copy.storageAccessKeyLabel)).toHaveValue(
      "••••••••••••",
    );
    expect(screen.getByLabelText(copy.storageAccessKeyLabel)).toBeDisabled();
    expect(screen.getByLabelText(copy.storageSecretKeyLabel)).toHaveValue(
      "••••••••••••",
    );
    expect(screen.getByLabelText(copy.storageSecretKeyLabel)).toBeDisabled();
    expect(screen.getByLabelText(copy.publicOriginLabel)).toBeDisabled();
    expect(screen.getByLabelText(copy.webhookTokenLabel)).toBeDisabled();
    expect(
      screen.getByRole("button", { name: copy.removeMetaAppSecret }),
    ).toBeEnabled();
    expect(screen.getByRole("button", { name: copy.removeMeta })).toBeEnabled();
    expect(
      screen.getByRole("button", { name: copy.removeStorage }),
    ).toBeEnabled();
    expect(
      screen.getByRole("button", { name: copy.removePublicOrigin }),
    ).toBeEnabled();
    expect(
      screen.getByRole("button", { name: copy.removeWebhookToken }),
    ).toBeEnabled();
  });

  it("keeps removal unavailable until a saved value exists and reports an unsuccessful storage test", async () => {
    const configuration: ConfigurationClient = {
      read: () =>
        Promise.resolve({
          meta: { configured: false, appSecretConfigured: false },
          storage: { driver: "r2", configured: false },
          webhookVerifyToken: false,
          installedVersion: "1.2.3",
        }),
      write: (change) =>
        Promise.resolve(
          change.action === "test_storage"
            ? { ok: false, status: "failure", reason: "unreachable" }
            : { ok: true },
        ),
    };
    render(
      show(
        createLocaleDouble(),
        createInstanceDouble(),
        createConversationDouble(),
        configuration,
        undefined,
        "instance",
      ),
    );

    await screen.findByText(copy.metaMissing);
    expect(
      screen.getByRole("button", { name: copy.removeMeta }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: copy.removeStorage }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: copy.removePublicOrigin }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: copy.removeWebhookToken }),
    ).toBeDisabled();

    expect(
      screen.getByRole("button", { name: copy.testStorage }),
    ).toBeDisabled();
  });
});

describe("REQ-439: Settings names server version and verified integration health", () => {
  it("distinguishes pending, healthy and failed results without inventing a version", async () => {
    const configuration: ConfigurationClient = {
      read: () =>
        Promise.resolve({
          meta: { configured: true, appSecretConfigured: true },
          storage: { driver: "r2", configured: true },
          webhookVerifyToken: false,
          installedVersion: "9.8.7",
        }),
      write: () => Promise.resolve({ ok: true }),
    };
    const first: IntegrationClient = {
      read: () =>
        Promise.resolve({
          meta: { status: "pending" },
          storage: { driver: "r2", status: "failure", reason: "unreachable" },
        }),
    };
    render(
      show(
        createLocaleDouble(),
        createInstanceDouble(),
        createConversationDouble(),
        configuration,
        first,
        "instance",
      ),
    );
    expect(
      await screen.findByText("Installed version: 9.8.7"),
    ).toBeInTheDocument();
    expect(screen.getByText(copy.metaHealthPending)).toBeInTheDocument();
    expect(
      screen.getByText(copy.storageHealthFailure.replace("{{driver}}", "r2")),
    ).toBeInTheDocument();
  });

  it("names a healthy check separately from configured state", async () => {
    const configuration: ConfigurationClient = {
      read: () =>
        Promise.resolve({
          meta: { configured: true, appSecretConfigured: true },
          storage: { driver: "local", configured: true },
          webhookVerifyToken: false,
          installedVersion: "9.8.7",
        }),
      write: () => Promise.resolve({ ok: true }),
    };
    const integrations: IntegrationClient = {
      read: () =>
        Promise.resolve({
          meta: { status: "healthy" },
          storage: { driver: "local", status: "healthy" },
        }),
    };
    render(
      show(
        createLocaleDouble(),
        createInstanceDouble(),
        createConversationDouble(),
        configuration,
        integrations,
        "instance",
      ),
    );
    expect(await screen.findByText(copy.metaHealthHealthy)).toBeInTheDocument();
    expect(screen.getByText(copy.metaHealthHealthy)).toHaveClass(
      "mc-badge--active",
    );
    expect(
      screen.getByText(
        copy.storageHealthHealthy.replace("{{driver}}", "local"),
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        copy.storageHealthHealthy.replace("{{driver}}", "local"),
      ),
    ).toHaveClass("mc-badge--active");
    expect(screen.getByText("Installed version: 9.8.7")).toHaveClass(
      "mc-badge--info",
      "mc-badge--square",
    );
  });
});
