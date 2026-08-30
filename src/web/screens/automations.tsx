import { useEffect, useState } from "react";
import type { ReactElement, ReactNode } from "react";
import {
  ANY_WORD_MODE,
  DEFAULT_FIRST_REPLY_DELAY_SECONDS,
} from "../../flows/schema.js";
import type { UnifiedAutomation } from "../../flows/schema.js";
import type { TriggerType } from "../../flows/trigger-compatibility.js";
import {
  Button,
  ButtonLink,
  Card,
  Chip,
  ConfirmDialog,
  EmptyState,
  Notice,
  PendingState,
  StatusBadge,
  Toast,
} from "../components/index.js";
import { isUnauthorizedFailure } from "../http-failure.js";
import { useLocale } from "../locale.js";
import { useNavigation } from "../navigation.js";
import { SessionExpiredNotice } from "../session-expired.js";
import { formatDate, httpPublicationFinder } from "./publications.js";
import type { PublicationFinder, PublicationRow } from "./publications.js";

/** What every composer here needs and nothing more: the catalogue, resolved. */
type Translate = (key: string, params?: Record<string, unknown>) => string;

const AUTOMATIONS_ENDPOINT = "/api/automations";

/**
 * Where the listing asks what it could NOT be told (REQ-294).
 *
 * The same route the publications grid asks for coverage, asked here with no
 * publication at all: this screen is not drawing tiles, it wants the other
 * half of that answer, which is the automations stored under a format this
 * version refuses. Asking the listing route instead would answer with what it
 * managed to read, which is exactly the sentence that cannot be trusted here.
 */
const AUTOMATION_COVERAGE_ENDPOINT = "/api/publications/automation-coverage";

export const AUTOMATIONS_ADDRESS = "/automations";
export const AUTOMATION_START_ADDRESS = "/automations/new";
export const AUTOMATION_FORM_ADDRESS = "/automations/form";
export const AUTOMATION_ID_PARAMETER = "id";
export const AUTOMATION_TRIGGER_PARAMETER = "trigger";
export const AUTOMATION_CREATED_PARAMETER = "created";
export const FILTER_THRESHOLD = 8;
export const REQUEST_FAILED = "request_failed";
export type { TriggerType };
const UNKNOWN_REFUSAL_KEY = "screens.automations.refusalUnknown";

type AutomationListingFilter = "all" | "global" | "next_publication";

const FILTER_LABEL_KEY: Record<AutomationListingFilter, string> = {
  all: "screens.automations.filterAll",
  global: "screens.automations.filterGlobal",
  next_publication: "screens.automations.filterNextPublication",
};

/** The scope as the listing understands it: publication-specific is its default. */
function listingScope(definition: UnifiedAutomation): AutomationListingFilter {
  return definition.scope?.type === "global"
    ? "global"
    : definition.scope?.type === "next_publication"
      ? "next_publication"
      : "all";
}

/**
 * The name of an aggregate that has no publication to borrow a caption from.
 *
 * These are not unfinished drafts: both scopes are complete, recognisable
 * products in their own right. Calling either one an unnamed draft hid the
 * reach the operator deliberately selected.
 */
function listingName(
  definition: UnifiedAutomation,
  identity: AutomationIdentity,
  t: Translate,
  locale: string,
): string {
  const scope = listingScope(definition);

  if (scope === "global") return t("screens.automations.scopeGlobalCard");
  if (scope === "next_publication")
    return t("screens.automations.scopeNextPublicationCard");

  return (
    derivedAutomationName(identity, t, locale) ??
    t("screens.automations.untitled")
  );
}

/** The first visual line is enough to identify a publication in a deletion. */
function firstCaptionLine(caption: string | undefined): string | undefined {
  const first = caption?.split(/\r?\n/, 1)[0]?.trim() ?? "";
  return first === "" ? undefined : first;
}

export function formAddressFor(identifier: string): string {
  return `${AUTOMATION_FORM_ADDRESS}?${AUTOMATION_ID_PARAMETER}=${encodeURIComponent(identifier)}`;
}

/**
 * The editor of a NEW automation, started by `trigger` (REQ-227).
 *
 * The choice travels as a parameter of the address exactly as `id` and `target`
 * already do: the entry is a screen of its own, so what it decided has to
 * survive the move, and the editor reads it back instead of asking again.
 */
export function formAddressForTrigger(trigger: TriggerType): string {
  return `${AUTOMATION_FORM_ADDRESS}?${AUTOMATION_TRIGGER_PARAMETER}=${encodeURIComponent(trigger)}`;
}

/**
 * The trigger an address carries.
 *
 * A comment unless the address says otherwise, and that default is load
 * bearing: the publications screen opens the editor with `?target=<id>` alone
 * (REQ-113), which is the comment entry arrived at from the publication.
 */
export function triggerFromAddress(search: string): TriggerType {
  return new URLSearchParams(search).get(AUTOMATION_TRIGGER_PARAMETER) ===
    "direct_message"
    ? "direct_message"
    : "comment";
}

export function listingAddressAfterCreating(identifier: string): string {
  return `${AUTOMATIONS_ADDRESS}?${AUTOMATION_CREATED_PARAMETER}=${encodeURIComponent(identifier)}`;
}

export interface StoredAutomation {
  readonly definition: UnifiedAutomation;
  readonly createdAt: string;
  readonly updatedAt: string;
  /**
   * What the listing measured of this automation's button clicks (REQ-329).
   *
   * Optional because absent and zero are different answers: the field is there
   * when the counts were read, and gone when they could not be, so nothing here
   * ever shows a number nobody counted.
   */
  readonly clicks?: AutomationClickMetrics;
}

/** What an automation is known by, which is what it listens to (REQ-228). */
export interface AutomationIdentity {
  readonly triggerType: TriggerType;
  /** The publication a comment automation watches. Empty for a direct message. */
  readonly target: string;
  readonly keywords: readonly string[];
  /** When the automation came into being, as an instant. */
  readonly createdOn: string;
  /**
   * The CAPTION of the publication it watches, which is what an operator
   * recognises it by (REQ-278).
   *
   * Absent is ordinary and never an error: a publication may carry no caption
   * at all, the cached row may predate the day captions were asked for, and the
   * lookup that fetches it answers after the listing is already on screen. What
   * absence must never do is bring the identifier back, so the name falls back
   * to the day and not to the seventeen digits.
   */
  readonly caption?: string;
}

/**
 * The words a trigger declares, and an empty list when it declares none.
 *
 * ONE reader, and it exists because the shape has two branches since REQ-262: a
 * comment trigger set to "any word" carries no `keywords` field at all. Every
 * screen that asks for the words has to read that absence the same way, and a
 * second copy of the question is where one of them starts reading `undefined`
 * as "the operator wrote nothing yet".
 */
export function declaredKeywords(
  trigger: UnifiedAutomation["trigger"],
): readonly string[] {
  const match = trigger?.match;

  return match !== undefined && "keywords" in match
    ? (match.keywords ?? [])
    : [];
}

export function identityOf(
  definition: UnifiedAutomation,
  createdOn: string,
  caption?: string,
): AutomationIdentity {
  const trigger = definition.trigger;

  return {
    triggerType: trigger?.type ?? "comment",
    target: watchedTarget(definition),
    keywords: declaredKeywords(trigger),
    createdOn,
    ...(caption !== undefined && { caption }),
  };
}

/**
 * The name of an automation, DERIVED and never typed (REQ-228).
 *
 * No competitor asks an operator to name one, and neither does this product any
 * more: a publication holds at most one automation (REQ-217), so a typed name
 * distinguishes nothing while costing a field on the busiest screen. What
 * identifies an automation is what starts it, so that is what the name is built
 * from: the publication for a comment, the keywords for a direct message.
 *
 * The publication is named by its CAPTION and never by its identifier
 * (REQ-278). Seventeen digits say nothing to whoever wrote the post, and a list
 * of them makes every comment automation the same sentence with a different
 * number in it. Where no caption is known the day the automation was created
 * takes its place: it tells two of them apart, which is all the identifier was
 * ever doing here, and it does it in words.
 *
 * Nothing stores it (REQ-279): the automation holds the publication's
 * identifier, the caption is read from the cache when a screen draws, and the
 * sentence is composed from the two at that instant. A name written once was a
 * copy of a caption, so an operator who fixed a typo in the post went on
 * reading the old wording here forever, and in the language whoever created the
 * automation happened to be using.
 *
 * Nothing, when the automation names neither a publication nor a keyword: that
 * is an empty draft, it has nothing to be named after, and inventing a sentence
 * there would put the same name on every unfinished draft in the product.
 */
export function derivedAutomationName(
  identity: AutomationIdentity,
  t: Translate,
  locale: string,
): string | undefined {
  const keywords = identity.keywords
    .map((keyword) => keyword.trim())
    .filter((keyword) => keyword !== "");

  if (identity.triggerType === "direct_message") {
    return keywords.length === 0
      ? undefined
      : t("screens.automations.nameFromKeywords", {
          keywords: keywords.join(", "),
        });
  }

  const publication = identity.target.trim();

  if (publication === "") {
    return undefined;
  }

  const caption = identity.caption?.trim() ?? "";

  return caption === ""
    ? t("screens.automations.nameFromPublicationUnnamed", {
        date: formatDate(identity.createdOn, locale),
      })
    : t("screens.automations.nameFromCaption", { caption });
}

/**
 * The identifier the trail uses (REQ-228), derived from the instant the
 * automation was created.
 *
 * Not from the name, which used to be the rule: the name is now composed from
 * the catalogue, so an identifier taken from it would read differently in each
 * language, and two drafts named after nothing would claim the SAME identifier
 * and overwrite each other. The creation instant belongs to one automation and
 * to no other, in every language.
 */
export function derivedAutomationId(
  triggerType: TriggerType,
  createdOn: string,
): string {
  const slug = `${triggerType}-${createdOn}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

  return slug === "" ? "new-automation" : slug;
}

export interface DefinitionIssue {
  readonly path: string;
  readonly code: string;
  readonly message: string;
  /**
   * The ceiling the value went past, when the refusal is about one. Absent
   * otherwise, because there is no honest number to put there.
   *
   * The screen never spells a platform number itself, so a short sentence with
   * a number in it can only be written from this: an installation that tuned
   * the ceiling is answered with ITS ceiling and not with the default this
   * build happens to carry.
   */
  readonly limit?: number;
}

export interface Refusal {
  readonly error: string;
  readonly issues?: readonly DefinitionIssue[];
  readonly target?: string;
}

export interface AutomationClickMetrics {
  readonly automationId: string;
  readonly total: number;
  readonly buttons: readonly {
    readonly buttonId: string;
    readonly total: number;
  }[];
}

export type SaveResult =
  | {
      readonly ok: true;
      readonly created: boolean;
      readonly stored: StoredAutomation;
    }
  | { readonly ok: false; readonly refusal: Refusal };

export type WriteResult =
  { readonly ok: true } | { readonly ok: false; readonly refusal: Refusal };

export interface AutomationsClient {
  list(): Promise<readonly StoredAutomation[]>;
  read(id: string): Promise<StoredAutomation | undefined>;
  save(definition: UnifiedAutomation): Promise<SaveResult>;
  remove(id: string): Promise<WriteResult>;
}

/** A stored automation this version cannot read, as the contract names it. */
export interface UnreadableAutomation {
  readonly id: string;
  readonly publicationId?: string;
}

export interface UnreadableAutomationsClient {
  read(): Promise<readonly UnreadableAutomation[]>;
}

/**
 * The real one: the coverage route with no publication named.
 *
 * `httpPublicationAutomationCoverageClient` cannot serve this question, and the
 * difference is deliberate rather than an oversight: it answers `[]` without
 * making a request when it is given no identifier, which is right for a grid
 * with no tiles and would be silence here.
 */
export const httpUnreadableAutomationsClient: UnreadableAutomationsClient = {
  read: async () => {
    const response = await fetch(AUTOMATION_COVERAGE_ENDPOINT);
    if (!response.ok) throw new Error(String(response.status));
    return (
      (await response.json()) as {
        unreadable: readonly UnreadableAutomation[];
      }
    ).unreadable;
  },
};

async function refusalOf(response: Response): Promise<Refusal> {
  try {
    return (await response.json()) as Refusal;
  } catch {
    return { error: String(response.status) };
  }
}

const JSON_HEADERS = { "content-type": "application/json" };

export const httpAutomationsClient: AutomationsClient = {
  list: async () => {
    const response = await fetch(AUTOMATIONS_ENDPOINT);
    if (!response.ok) throw new Error(String(response.status));
    return ((await response.json()) as { automations: StoredAutomation[] })
      .automations;
  },
  read: async (id) => {
    const response = await fetch(
      `${AUTOMATIONS_ENDPOINT}/${encodeURIComponent(id)}`,
    );
    if (response.status === 404) return undefined;
    if (!response.ok) throw new Error(String(response.status));
    return ((await response.json()) as { automation: StoredAutomation })
      .automation;
  },
  save: async (definition) => {
    const response = await fetch(AUTOMATIONS_ENDPOINT, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ definition }),
    });
    if (!response.ok) return { ok: false, refusal: await refusalOf(response) };
    const body = (await response.json()) as {
      created: boolean;
      automation: StoredAutomation;
    };
    return { ok: true, created: body.created, stored: body.automation };
  },
  remove: async (id) => {
    const response = await fetch(
      `${AUTOMATIONS_ENDPOINT}/${encodeURIComponent(id)}`,
      {
        method: "DELETE",
      },
    );
    return response.ok
      ? { ok: true }
      : { ok: false, refusal: await refusalOf(response) };
  },
};

export function refusalKey(refusal: Refusal): string {
  switch (refusal.error) {
    case "invalid_definition":
      return "screens.automations.refusalInvalidDefinition";
    case "automation_not_found":
      return "screens.automations.refusalAutomationNotFound";
    case "publication_target_conflict":
      return "screens.automations.refusalTargetConflict";
    case REQUEST_FAILED:
      return "screens.automations.refusalRequestFailed";
    default:
      return UNKNOWN_REFUSAL_KEY;
  }
}

function buttonLabelOf(
  definition: UnifiedAutomation,
  buttonId: string,
): string | undefined {
  for (const step of definition.steps ?? []) {
    if (step.action !== "send_dm") continue;
    // The buttons live on the step itself now (REQ-229): there is no card
    // entity between them and the message any more.
    const button = step.message?.buttons?.find(
      (candidate) => candidate.id === buttonId,
    );
    if (button !== undefined) return button.label;
  }
  return undefined;
}

/* ------------------------------------------------------------------ *
 * The card's preview: the automation in the order the other side lives it
 * ------------------------------------------------------------------ */

/**
 * One line of the preview a card carries instead of an identifier (REQ-278).
 *
 * The label travels as a KEY and not as a word, so a caller renders it in the
 * language in force and a test names the line without spelling any language.
 */
export interface AutomationPreviewLine {
  readonly label: string;
  /** The line itself, already composed from the catalogue. */
  readonly sentence: string;
  /** The operator's OWN words inside that sentence, when it carries any. */
  readonly emphasis?: string;
}

const PREVIEW_LABEL = {
  triggers: "screens.automations.previewTriggers",
  replies: "screens.automations.previewReplies",
  asks: "screens.automations.previewAsks",
  delivers: "screens.automations.previewDelivers",
  missing: "screens.automations.previewMissing",
} as const;

const SECONDS_IN_A_MINUTE = 60;

/** The words a step holds, as ONE line: a step may draw between several. */
function firstText(value: string | readonly string[] | undefined): string {
  if (value === undefined) return "";

  return (typeof value === "string" ? value : (value[0] ?? "")).trim();
}

function writtenWords(keywords: readonly string[]): readonly string[] {
  return keywords
    .map((keyword) => keyword.trim())
    .filter((keyword) => keyword !== "");
}

/** Whether the trigger takes every comment, with no word to match (REQ-262). */
function listensToAnyWord(trigger: UnifiedAutomation["trigger"]): boolean {
  return trigger?.match?.mode === ANY_WORD_MODE;
}

/**
 * The publication an automation watches, or nothing when it watches none.
 *
 * ONE reader, for the reason `declaredKeywords` is one: the listing asks it to
 * build the request and the card asks it to read the answer back, and two
 * copies of "where the target lives" is how one of them starts looking up the
 * empty string for every direct-message automation on the screen.
 */
export function watchedTarget(definition: UnifiedAutomation): string {
  const trigger = definition.trigger;

  return definition.scope?.type === "publication"
    ? definition.scope.publicationId
    : trigger?.type === "comment"
      ? (trigger.target ?? "")
      : "";
}

/**
 * What a `send_dm` step carries, draft or active.
 *
 * Taken off the aggregate rather than named: a draft's message is the active
 * one with every field allowed to be blank, and spelling the wider of the two
 * here is how a reader ends up asserting a label that a half written link does
 * not have.
 */
type DeliveredMessage = Extract<
  NonNullable<UnifiedAutomation["steps"]>[number],
  { action: "send_dm" }
>["message"];

/** The private message this automation delivers, or nothing when it has none. */
function deliveredMessage(
  definition: UnifiedAutomation,
): DeliveredMessage | undefined {
  for (const step of definition.steps ?? []) {
    if (step.action === "send_dm") return step.message;
  }

  return undefined;
}

/** The hold before the first reply, in words rather than in seconds (REQ-277). */
function waitWords(seconds: number, t: Translate): string {
  if (seconds === 0) return t("screens.automations.previewWaitImmediate");

  return seconds % SECONDS_IN_A_MINUTE === 0
    ? t("screens.automations.previewWaitMinutes", {
        count: seconds / SECONDS_IN_A_MINUTE,
      })
    : t("screens.automations.previewWaitSeconds", { count: seconds });
}

function triggerLine(
  definition: UnifiedAutomation,
  identity: AutomationIdentity,
  t: Translate,
): AutomationPreviewLine | undefined {
  const words = writtenWords(identity.keywords);
  const named = words.join(` ${t("screens.automations.matchOr")} `);

  if (identity.triggerType === "direct_message") {
    return words.length === 0
      ? undefined
      : {
          label: PREVIEW_LABEL.triggers,
          sentence: t("screens.automations.previewTriggerDirect", {
            words: named,
          }),
          emphasis: named,
        };
  }

  if (definition.scope?.type === "global") {
    return {
      label: PREVIEW_LABEL.triggers,
      sentence:
        words.length === 0
          ? t("screens.automations.previewTriggerGlobalAnyWord")
          : t("screens.automations.previewTriggerGlobal", { words: named }),
      ...(words.length > 0 && { emphasis: named }),
    };
  }
  if (definition.scope?.type === "next_publication") {
    return {
      label: PREVIEW_LABEL.triggers,
      sentence:
        words.length === 0
          ? t("screens.automations.previewTriggerNextPublicationAnyWord")
          : t("screens.automations.previewTriggerNextPublication", {
              words: named,
            }),
      ...(words.length > 0 && { emphasis: named }),
    };
  }
  if (identity.target.trim() === "") return undefined;

  if (listensToAnyWord(definition.trigger)) {
    return {
      label: PREVIEW_LABEL.triggers,
      sentence: t("screens.automations.previewTriggerAnyWord"),
    };
  }

  return words.length === 0
    ? undefined
    : {
        label: PREVIEW_LABEL.triggers,
        sentence: t("screens.automations.previewTriggerComment", {
          words: named,
        }),
        emphasis: named,
      };
}

function replyLine(
  definition: UnifiedAutomation,
  identity: AutomationIdentity,
  t: Translate,
): AutomationPreviewLine {
  const wait = waitWords(
    definition.rules?.first_reply_delay_seconds ??
      DEFAULT_FIRST_REPLY_DELAY_SECONDS,
    t,
  );
  // A public reply exists only where there is a comment to write it under, so
  // the trigger decides the sentence and not merely the presence of the step.
  const onTheComment =
    identity.triggerType === "comment" &&
    [...(definition.steps ?? [])].some(
      (step) => step.action === "reply_comment",
    );

  return {
    label: PREVIEW_LABEL.replies,
    sentence: t(
      onTheComment
        ? "screens.automations.previewRepliesBoth"
        : "screens.automations.previewRepliesDirect",
      { wait },
    ),
  };
}

/**
 * What the automation asks before it delivers, quoted.
 *
 * The FIRST question in the automation's own order, because that is the one the
 * person on the other side reads first, and a card that listed all three would
 * be the editor with a border around it.
 */
function askLine(
  definition: UnifiedAutomation,
  identity: AutomationIdentity,
  t: Translate,
): AutomationPreviewLine | undefined {
  for (const step of definition.steps ?? []) {
    if (
      identity.triggerType === "direct_message" &&
      step.action === "confirm_optin"
    ) {
      continue;
    }
    const written =
      step.action === "confirm_optin"
        ? // Nobody having written one is not an absent question: the
          // confirmation asks with the catalogue's own sentence until somebody
          // writes another (REQ-273), and that is what goes out.
          firstText(step.text) ||
          t("screens.automations.confirmationQuestionDefault")
        : step.action === "collect_email" || step.action === "follow_gate"
          ? firstText(step.ask)
          : "";

    if (written !== "") {
      return {
        label: PREVIEW_LABEL.asks,
        sentence: t("screens.automations.previewAsk", { question: written }),
      };
    }
  }

  return undefined;
}

/**
 * The pure links a message really carries, with the half-typed ones left out.
 *
 * ONE reader, for the reason `declaredKeywords` is one (REQ-319): the listing
 * counts them into the line that describes the delivery, and the editor draws a
 * bubble for each of them and names them in the sentence under the section.
 *
 * Blanks dropped, and only where a delivery is PROMISED: a draft holds an
 * address the operator is still typing, and the empty string is what an
 * added-but-untouched row holds, so a line or a bubble counting one would
 * promise a message the contact would never receive. What keeps the blanks is
 * the aggregate the save writes, because a row asked for and not yet typed is
 * what a draft is allowed to hold, and the walk that refuses activation is what
 * names it.
 *
 * Typed by the field it reads and not by either caller's message: the listing
 * asks it of a stored automation and the editor of the draft it is still
 * assembling, which are the same list in two shapes.
 */
export function declaredLinks(
  message: { readonly links?: unknown } | undefined,
): readonly string[] {
  const links = message?.links;

  return Array.isArray(links)
    ? links.filter(
        (link): link is string =>
          typeof link === "string" && link.trim() !== "",
      )
    : [];
}

/**
 * What the person receives, in the shape it really arrives in (REQ-229): a card
 * when the message carries buttons, a plain message when it does not, and then
 * one message per pure link (REQ-286, REQ-288).
 *
 * The attachment was a third case here and left with REQ-284, along with the
 * two sentences that named it. The pure link is not a fourth shape of the SAME
 * message: it is a message of its own, arriving after the card or the text in
 * the order it was declared, and carrying no card at all so the destination
 * site is the one that draws the preview. That is why the links are named after
 * the written message and never folded into it, and why a delivery of links
 * alone is a delivery rather than a hole: before this, such an automation was
 * described by no line at all and vanished from its own card in silence.
 *
 * Named part by part with the editor's own words (`deliveryPartLink`), so the
 * two screens do not call the same message two different things.
 */
function deliveryLine(
  definition: UnifiedAutomation,
  t: Translate,
): AutomationPreviewLine | undefined {
  const message = deliveredMessage(definition);
  const buttons = [...(message?.buttons ?? [])]
    .map((button) => button.label?.trim() ?? "")
    .filter((label) => label !== "");
  const and = ` ${t("screens.automations.previewAnd")} `;
  const named = buttons.join(and);
  const links = declaredLinks(message);
  const written =
    buttons.length > 0
      ? t("screens.automations.previewDeliveryCard", {
          count: buttons.length,
          buttons: named,
        })
      : firstText(message?.text) !== ""
        ? t("screens.automations.previewDeliveryMessage")
        : undefined;

  // Numbered only when there are several: "the link" is what an operator with
  // one of them calls it, and "link 1" of one is a position nothing else uses.
  const names = links.map((_link, index) =>
    links.length === 1
      ? t("screens.automations.deliveryPartLink")
      : t("screens.automations.deliveryPartLinkNumbered", {
          number: index + 1,
        }),
  );

  const sentence =
    links.length === 0
      ? written
      : written === undefined
        ? t("screens.automations.previewDeliveryLinksAlone", {
            count: links.length,
            names,
          })
        : t("screens.automations.previewDeliveryThenLinks", {
            count: links.length,
            names,
            delivered: written,
          });

  return sentence === undefined
    ? undefined
    : {
        label: PREVIEW_LABEL.delivers,
        sentence,
        ...(buttons.length > 0 && { emphasis: named }),
      };
}

/**
 * What a draft still needs, which is the line that replaces the delivery on a
 * card that cannot run yet.
 *
 * Walked in the order the editor walks it, so the card and the editor never
 * disagree about which hole is the one to go and fill.
 */
function missingLine(
  definition: UnifiedAutomation,
  identity: AutomationIdentity,
  delivers: boolean,
  t: Translate,
): AutomationPreviewLine | undefined {
  if (definition.state !== "draft") return undefined;

  const key =
    identity.triggerType === "comment" && identity.target.trim() === ""
      ? "screens.automations.previewMissingTarget"
      : writtenWords(identity.keywords).length === 0 &&
          !listensToAnyWord(definition.trigger)
        ? "screens.automations.previewMissingWords"
        : delivers
          ? "screens.automations.previewMissingNothing"
          : "screens.automations.previewMissingMessage";

  return { label: PREVIEW_LABEL.missing, sentence: t(key) };
}

/**
 * The automation told in the order the person on the other side lives it
 * (REQ-278): what starts it, how it answers, what it asks, what it delivers.
 *
 * A line with nothing to say is left out rather than written empty, which is
 * what makes a half-written draft read as three short lines instead of as four
 * blanks, and a draft closes with what it is still waiting for.
 */
export function automationPreview(
  definition: UnifiedAutomation,
  identity: AutomationIdentity,
  t: Translate,
): readonly AutomationPreviewLine[] {
  const delivery = deliveryLine(definition, t);

  return [
    triggerLine(definition, identity, t),
    replyLine(definition, identity, t),
    askLine(definition, identity, t),
    delivery,
    missingLine(definition, identity, delivery !== undefined, t),
  ].filter((line) => line !== undefined);
}

/**
 * A sentence from the catalogue with the operator's own words set apart.
 *
 * The catalogue answers with a STRING, so the emphasis cannot travel inside it
 * without putting markup in the translator's hands. The sentence is resolved
 * with the words already in place and then cut around them, which keeps the
 * word order the translator chose and leaves every language free to put the
 * words wherever its grammar wants them.
 *
 * A part the sentence does not contain gives the sentence back whole: a
 * translation that folded the words into something else is a sentence with no
 * emphasis, never a sentence with a hole in it.
 */
export function emphasised(
  sentence: string,
  part: string | undefined,
): ReactNode {
  const at = part === undefined || part === "" ? -1 : sentence.indexOf(part);

  if (at < 0 || part === undefined) return sentence;

  return (
    <>
      {sentence.slice(0, at)}
      <b>{part}</b>
      {sentence.slice(at + part.length)}
    </>
  );
}

/**
 * The entry of a new automation (REQ-227): the two things that can start one,
 * offered as two destinations before the editor opens.
 *
 * The trigger used to be a `<Select>` in the middle of the form, which is part
 * of what made that screen unreadable: the field that decides whether half the
 * editor exists sat between two fields that depend on it. The three products
 * this was measured against treat the two triggers as two different ENTRANCES,
 * and so does this: the choice becomes the address, the editor reads it back,
 * and the question is never asked twice.
 *
 * Each card is a real `<a href>` and not a clickable box: the whole card is the
 * destination, so it is reached with Tab, opened in another tab with the middle
 * button, and copied (REQ-116). What it promises is a RESULT, in the words of
 * someone who has never configured anything.
 */
export function AutomationStartScreen(): ReactElement {
  const { t } = useLocale();
  const { follow } = useNavigation();

  /**
   * The two entrances, and the drawing that tells them apart before a word is
   * read: three lines in the shape of the exchange each one starts. The comment
   * entrance opens with someone else's line, the direct one opens with yours,
   * and `mine` is which of the three sits on the account's own side.
   */
  const entries = [
    {
      trigger: "comment" as const,
      title: t("screens.automations.startCommentTitle"),
      outcome: t("screens.automations.startCommentOutcome"),
      lead: true,
      lines: [
        { width: "wide", mine: false },
        { width: "short", mine: false },
        { width: "half", mine: true },
      ],
    },
    {
      trigger: "direct_message" as const,
      title: t("screens.automations.startDirectTitle"),
      outcome: t("screens.automations.startDirectOutcome"),
      lead: false,
      lines: [
        { width: "short", mine: true },
        { width: "wide", mine: false },
        { width: "half", mine: true },
      ],
    },
  ];

  return (
    <div className="mc-page">
      {/* The way back GOES somewhere, so it is a link (REQ-276): Tab reaches
          it, the middle button opens it in another tab and its address can be
          copied, none of which an `onClick` offers. It wears the button's
          shape, which is what says how big the target is. */}
      <ButtonLink
        href={AUTOMATIONS_ADDRESS}
        onClick={follow(AUTOMATIONS_ADDRESS)}
        className="mc-page__back"
      >
        {t("screens.automations.back")}
      </ButtonLink>
      <div className="mc-page__head">
        <div className="mc-page__titles">
          <h1>{t("screens.automations.new")}</h1>
          <p className="mc-page__lead">{t("screens.automations.startLead")}</p>
        </div>
      </div>
      <div className="mc-card-grid mc-card-grid--entry">
        {entries.map((entry) => {
          const address = formAddressForTrigger(entry.trigger);

          return (
            <a
              key={entry.trigger}
              className="mc-card mc-card--interactive mc-startcard"
              href={address}
              onClick={follow(address)}
            >
              {/* The drawing carries nothing the sentence below does not say
                  in words, so it is hidden rather than described: an
                  alternative text for three grey bars is noise in the ear of
                  someone who is about to be told what the entrance does. */}
              <span className="mc-startcard__art" aria-hidden="true">
                <span className="mc-startcard__conv">
                  {entry.lines.map((line, index) => (
                    <span
                      key={index}
                      className={[
                        "mc-startcard__line",
                        `mc-startcard__line--${line.width}`,
                        line.mine ? "mc-startcard__line--mine" : "",
                      ]
                        .filter(Boolean)
                        .join(" ")}
                    />
                  ))}
                </span>
              </span>
              <span className="mc-card__body">
                <span className="mc-card__title">{entry.title}</span>
                <span className="mc-card__sentence">{entry.outcome}</span>
                {/* A picture of a button and not a button: the card itself is
                    the link, so a control here would be a second tab stop to
                    the same address (REQ-116). */}
                <span
                  className={[
                    "mc-startcard__call",
                    entry.lead ? "" : "mc-startcard__call--quiet",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                >
                  {t("screens.automations.startCall")}
                </span>
              </span>
            </a>
          );
        })}
      </div>
    </div>
  );
}

interface AutomationsScreenProps {
  readonly client?: AutomationsClient;
  /**
   * Where the card gets the publication it shows instead of an identifier
   * (REQ-278). Injected by tests; the running interface asks the same route the
   * editor already asks, which reads the local cache and spends no request of
   * the platform's budget (REQ-070).
   */
  readonly finder?: PublicationFinder;
  /** Where the screen learns that a stored automation exists and is unreadable
   * (REQ-294). Injected by tests; the running interface asks the route above. */
  readonly unreadable?: UnreadableAutomationsClient;
}

export function AutomationsScreen({
  client = httpAutomationsClient,
  finder = httpPublicationFinder,
  unreadable: unreadableClient = httpUnreadableAutomationsClient,
}: AutomationsScreenProps = {}): ReactElement {
  const { t, locale } = useLocale();
  const { navigate } = useNavigation();
  const [rows, setRows] = useState<readonly StoredAutomation[]>([]);
  const [watched, setWatched] = useState<
    Readonly<Record<string, PublicationRow>>
  >({});
  const [phase, setPhase] = useState<
    "loading" | "ready" | "failed" | "unauthorized"
  >("loading");
  const [deleting, setDeleting] = useState<StoredAutomation>();
  const [writeFailure, setWriteFailure] = useState<Refusal>();
  const [filter, setFilter] = useState<AutomationListingFilter>("all");
  const [unreadable, setUnreadable] = useState<readonly UnreadableAutomation[]>(
    [],
  );

  /**
   * The listing, counts included, in ONE request (REQ-329).
   *
   * The counts used to be a second pass over the answer: one request per
   * automation, fired after the rows were on screen, so twenty automations cost
   * twenty one round trips and the numbers arrived one card at a time. They now
   * travel with the row that carries them, measured in a single grouped read on
   * the way out.
   *
   * A row without `clicks` is a row whose counts were NOT measured, and it is
   * drawn without them: the field's absence is the contract of the route, and
   * writing a zero in its place would put a number nobody counted on a card.
   */
  useEffect(() => {
    let alive = true;
    void client
      .list()
      .then((listed) => {
        if (!alive) return;
        setRows(listed);
        setPhase("ready");
      })
      .catch((error: unknown) => {
        if (alive)
          setPhase(isUnauthorizedFailure(error) ? "unauthorized" : "failed");
      });
    return () => {
      alive = false;
    };
  }, [client]);

  /**
   * The publications the listed automations watch, asked for by identifier and
   * in ONE request (REQ-278).
   *
   * It is a second effect and not a step of the one above because it depends on
   * the rows rather than on the client: the listing has to be on screen before
   * anything can be looked up for it, and the card is drawn without waiting.
   *
   * A failure is silent on purpose, and it is the only failure on this screen
   * that is: what it costs is a caption, the name falls back to the day the
   * automation was created, and nothing an operator can act on has been lost. A
   * red notice over a listing that works would be worse than the missing word.
   */
  useEffect(() => {
    const targets = [
      ...new Set(
        rows
          .map(({ definition }) => watchedTarget(definition))
          .filter((target) => target !== ""),
      ),
    ];

    if (targets.length === 0) return;

    let alive = true;

    void finder
      .byIds(targets)
      .then((lookup) => {
        if (alive)
          setWatched(
            Object.fromEntries(lookup.items.map((row) => [row.id, row])),
          );
      })
      .catch(() => undefined);

    return () => {
      alive = false;
    };
  }, [rows, finder]);

  /**
   * What is stored and cannot be read (REQ-294).
   *
   * Asked of the screen's own mounting and NOT of the rows, which is the whole
   * point: an automation this version refuses never reaches `rows`, so a
   * question derived from them would go silent in exactly the state it exists
   * to describe, and an instance whose only automation is unreadable would
   * open on "nothing is stored yet".
   *
   * A failure is silent, for the reason the lookup above is: what it costs is
   * a warning about rows the operator already cannot see, and a red box over a
   * listing that is working would be the wrong sentence about the wrong thing.
   */
  useEffect(() => {
    let alive = true;

    void unreadableClient
      .read()
      .then((found) => {
        if (alive) setUnreadable(found);
      })
      .catch(() => undefined);

    return () => {
      alive = false;
    };
  }, [unreadableClient]);

  if (phase === "loading")
    return (
      <PendingState skeleton={3} label={t("screens.automations.loading")} />
    );
  if (phase === "unauthorized") return <SessionExpiredNotice />;

  const sortedRows = [...rows].sort(
    (left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt),
  );
  const listedRows = sortedRows.filter(
    (row) => filter === "all" || listingScope(row.definition) === filter,
  );

  return (
    <div className="mc-page">
      <div className="mc-page__head">
        <div className="mc-page__titles">
          <h1>{t("screens.automations.title")}</h1>
          <p className="mc-page__lead">
            {t("screens.automations.aggregateHint")}
          </p>
        </div>
        <Button
          variant="primary"
          icon="plus"
          onClick={() => navigate(AUTOMATION_START_ADDRESS)}
        >
          {t("screens.automations.new")}
        </Button>
      </div>
      {phase === "failed" ? (
        <Notice nature="error">
          {t("screens.automations.listUnavailable")}
        </Notice>
      ) : null}
      {/* The answer to a switch the operator just flipped, and nothing else on
          this screen is waiting on it: a toast, because a listing scrolled down
          to the automation being turned on is a listing whose top is off screen
          (REQ-312). */}
      {writeFailure === undefined ? null : (
        <Toast
          nature="error"
          message={t(refusalKey(writeFailure))}
          dismissLabel={t("toast.dismiss")}
          onDismiss={(): void => setWriteFailure(undefined)}
        />
      )}
      {/* An automation that exists and cannot be read says so, above the list
          it is missing from (REQ-294). A warning and not an error, because
          nothing failed and nothing is broken: a format this version refuses is
          a degraded path, which is the nature's own definition.

          It is drawn whatever the listing is doing, and the usual case is now
          the listing WORKING beside it: a refused document no longer takes the
          route down with it (REQ-294), so what the operator sees is every
          automation this version can read, plus the count of the ones it
          cannot. It stays drawn over a listing that failed for any other
          reason too, where the two sentences belong together.

          COUNTED and not named: an automation is recognised by the caption of
          the publication it watches (REQ-278), and reaching that publication
          means reading the very document nobody can parse. What is left is the
          seventeen digits, which say nothing to whoever wrote the post and are
          the one thing this screen refuses to put back. */}
      {unreadable.length === 0 ? null : (
        <Notice
          nature="warning"
          title={t("screens.automations.unreadableAutomationsTitle", {
            count: unreadable.length,
          })}
        >
          {t("screens.automations.unreadableAutomations")}
        </Notice>
      )}
      {phase === "ready" && rows.length === 0 ? (
        <EmptyState title={t("screens.automations.empty")} />
      ) : (
        <>
          <div
            className="mc-automation-filters"
            role="group"
            aria-label={t("screens.automations.filterLabel")}
          >
            {(["all", "global", "next_publication"] as const).map((choice) => (
              <Button
                key={choice}
                variant={filter === choice ? "primary" : "secondary"}
                aria-pressed={filter === choice}
                onClick={() => setFilter(choice)}
              >
                {t(FILTER_LABEL_KEY[choice])}
              </Button>
            ))}
          </div>
          {listedRows.length === 0 ? (
            <EmptyState title={t("screens.automations.emptyFiltered")} />
          ) : null}
          <ul className="mc-cardlist mc-cardlist--automations">
            {listedRows.map((row) => {
              const definition = row.definition;
              const click = row.clicks;
              const publication = watched[watchedTarget(definition)];
              const identity = identityOf(
                definition,
                row.createdAt,
                publication?.caption,
              );
              const picture = publication?.thumbnailUrl;
              return (
                <Card
                  key={definition.id}
                  as="li"
                  // The publication the automation watches, which is half of what
                  // an operator recognises it by (REQ-278). Drawn only where there
                  // IS one: a grey square on every card before the lookup answers
                  // would say "picture missing" about publications that have one.
                  //
                  // The frame around it is 9x16 and the picture is CROPPED into
                  // it (REQ-328): the shape of the screen the post is read on,
                  // which is what makes a row of cards recognisable at a glance,
                  // and a shape whose height this card decides, because the width
                  // is fixed and the ratio does the rest.
                  media={
                    picture === undefined ? undefined : (
                      <img
                        src={picture}
                        alt={t("screens.automations.cardThumbnailAlt")}
                      />
                    )
                  }
                  // What the operator recognises the automation by, composed from
                  // what it listens to (REQ-228). Nobody typed it and nothing
                  // stored it (REQ-279): the caption comes from the lookup this
                  // listing just made, so the card says what the publication is
                  // called today and in the language in force.
                  title={listingName(definition, identity, t, locale)}
                  badge={
                    <StatusBadge
                      state={
                        definition.state === "active" ? "active" : "neutral"
                      }
                    >
                      {definition.state === "active"
                        ? t("screens.automations.stateEnabled")
                        : t("screens.automations.stateDraft")}
                    </StatusBadge>
                  }
                  // Beside the card and not under it: the two actions are the
                  // same two on every row, so a column of them is a column of
                  // repetition, and it was costing the whole card a line of
                  // height (REQ-328). They keep the one tap size (REQ-268) and
                  // fall under the card on a handset, where there is no room
                  // beside it.
                  actions={
                    <>
                      <Button
                        variant="secondary"
                        icon="pencil"
                        onClick={() => navigate(formAddressFor(definition.id))}
                      >
                        {/* A draft is not edited, it is finished: the word says
                          which of the two this card is offering. */}
                        {definition.state === "active"
                          ? t("screens.automations.edit")
                          : t("screens.automations.continueDraft")}
                      </Button>
                      <Button
                        variant="removal"
                        icon="trash-2"
                        onClick={() => setDeleting(row)}
                      >
                        {t("screens.automations.delete")}
                      </Button>
                    </>
                  }
                >
                  {/* What this automation does, in the order the person on the
                    other side lives it (REQ-278). A list and not a paragraph,
                    because each line is a labelled fact and a screen reader
                    announces how many of them there are.

                    Each line is CUT rather than wrapped (the sheet clamps it):
                    the whole sentence stays in the document for whoever reads
                    with their ears, and the card keeps a height that does not
                    depend on how long the operator's own words are. */}
                  <ul
                    className="mc-autosum"
                    aria-label={t("screens.automations.previewSummary")}
                  >
                    {automationPreview(definition, identity, t).map((line) => (
                      <li key={line.label}>
                        <span className="mc-autosum__key">{t(line.label)}</span>
                        <span>{emphasised(line.sentence, line.emphasis)}</span>
                      </li>
                    ))}
                  </ul>
                  {/* What the buttons of this automation were CLICKED (REQ-329),
                    read from the row the listing already carried.

                    Drawn as tokens on one line rather than as a stacked block:
                    the total leads in the accent, each button follows in the
                    quiet weight, and a delivery with three buttons costs the
                    card a line instead of four. Absent when the row carries no
                    count, which is not the same as a count of zero. */}
                  {click === undefined ? null : (
                    <div
                      aria-label={t("screens.automations.clickMetrics")}
                      className="mc-click-metrics"
                    >
                      <Chip tone="accent">
                        {t("screens.automations.clickTotal", {
                          total: click.total,
                        })}
                      </Chip>
                      {click.buttons.map((button) => (
                        <Chip key={button.buttonId}>
                          {t("screens.automations.clickButton", {
                            button:
                              buttonLabelOf(definition, button.buttonId) ??
                              t("screens.automations.clickUnknownButton"),
                            total: button.total,
                          })}
                        </Chip>
                      ))}
                    </div>
                  )}
                </Card>
              );
            })}
          </ul>
        </>
      )}
      {deleting === undefined ? null : (
        <ConfirmDialog
          title={t("screens.automations.deleteTitle")}
          consequence={
            <>
              {t("screens.automations.deleteConsequencePrefix")}{" "}
              <span className="mc-consequence__caption">
                {listingName(
                  deleting.definition,
                  identityOf(
                    deleting.definition,
                    deleting.createdAt,
                    firstCaptionLine(
                      watched[watchedTarget(deleting.definition)]?.caption,
                    ),
                  ),
                  t,
                  locale,
                )}
              </span>{" "}
              {t("screens.automations.deleteConsequenceSuffix")}
            </>
          }
          confirmLabel={t("screens.automations.deleteConfirm")}
          cancelLabel={t("screens.automations.cancel")}
          destructive
          onCancel={() => setDeleting(undefined)}
          onConfirm={() => {
            const id = deleting.definition.id;

            // Cleared before the call, never after, which is the contract every
            // caller of `Toast` keeps: the answer to the previous write is
            // stale the moment another one leaves, and clearing it is what
            // makes the next toast a NEW element with its reading time counted
            // from zero. Without this a second refusal inside the first one's
            // window is only a change of props, so a different sentence would
            // inherit whatever was left of the previous clock.
            setWriteFailure(undefined);
            void client
              .remove(id)
              .then((result) => {
                if (result.ok)
                  setRows((current) =>
                    current.filter((row) => row.definition.id !== id),
                  );
                else setWriteFailure(result.refusal);
                setDeleting(undefined);
              })
              .catch((error: unknown) => {
                if (isUnauthorizedFailure(error)) setPhase("unauthorized");
                else setWriteFailure({ error: REQUEST_FAILED });
                setDeleting(undefined);
              });
          }}
        />
      )}
    </div>
  );
}
