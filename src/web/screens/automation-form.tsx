import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  FormEvent,
  InputHTMLAttributes,
  ReactElement,
  ReactNode,
} from "react";
import {
  ANY_WORD_MODE,
  AUTOMATION_SCHEMA_VERSION,
  DEFAULT_FIRST_REPLY_DELAY_SECONDS,
  FIRST_REPLY_DELAY_CHOICES,
  KEYWORD_MATCH_MODES,
  CARD_BUTTON_LIMIT,
  PURE_LINK_LIMIT,
} from "../../flows/schema.js";
import type {
  CommentMatchMode,
  FirstReplyDelaySeconds,
  KeywordMatchMode,
  AutomationScope,
  UnifiedAutomation,
} from "../../flows/schema.js";
import type { TriggerType } from "../../flows/trigger-compatibility.js";
import {
  Button,
  ButtonLink,
  Checkbox,
  Chip,
  ConfirmDialog,
  Field,
  Icon,
  ICON_SIZE,
  KeywordField,
  LENGTH_ADVICE_TEXT_KEYS,
  lengthAdvice,
  Modal,
  Notice,
  PendingState,
  TextArea,
  Toast,
} from "../components/index.js";
import { isUnauthorizedFailure } from "../http-failure.js";
import { useLocale } from "../locale.js";
import { useExitGuard, useNavigation } from "../navigation.js";
import { SessionExpiredNotice } from "../session-expired.js";
import {
  AUTOMATIONS_ADDRESS,
  declaredKeywords,
  declaredLinks,
  derivedAutomationId,
  derivedAutomationName,
  httpAutomationsClient,
  listingAddressAfterCreating,
  triggerFromAddress,
} from "./automations.js";
import type {
  AutomationsClient,
  DefinitionIssue,
  Refusal,
} from "./automations.js";
import { AssetPicker, httpAssetsClient } from "./flow-step-fields.js";
import type { AssetsClient } from "./flow-step-fields.js";
import type { FieldAdvice } from "../components/index.js";
import {
  httpPublicationFinder,
  httpPublicationsClient,
  PUBLICATION_TARGET_PARAMETER,
  PublicationPicker,
} from "./publications.js";
import type {
  PublicationFinder,
  PublicationAutomationCoverageClient,
  PublicationRow,
  PublicationsClient,
} from "./publications.js";
import { httpPublicationAutomationCoverageClient } from "./publications.js";
import { httpConversationClient } from "./settings.js";
import type { ConversationClient, ConversationSettings } from "./settings.js";

/**
 * What the draft holds, which is the WIDER of the two vocabularies: a comment
 * trigger may declare "any word" and a direct message may not (REQ-263). Which
 * of the two is offered is decided where the chooser is drawn, from the trigger
 * the entry already settled.
 */
type MatchMode = CommentMatchMode;

/**
 * Which of the two things a card button opens (REQ-289).
 *
 * The operator's own words are the labels ("Link", "PDF or image"), and this is
 * the state behind them. It is a CHOICE held on the draft and not something
 * inferred from which field happens to be filled in: the format's button is an
 * exclusive union (`url` XOR `asset`), so what is emitted has to be decided by
 * the person and not guessed from a half-typed value.
 */
type ButtonDestination = "url" | "asset";

interface ButtonDraft {
  readonly id: string;
  readonly label: string;
  /** What was chosen, and therefore which field is written when it is saved. */
  readonly dest: ButtonDestination;
  /** The address, kept while the file is chosen, so switching back is free. */
  readonly url: string;
  /** The catalogue's name of the file, kept for the same reason. */
  readonly asset: string;
}

interface Draft {
  readonly id: string;
  readonly state: "draft" | "active";
  /**
   * What starts the automation. Chosen at the ENTRY and read from the address,
   * or read from the stored definition when one is being edited: it is no
   * longer a field, so nothing on this screen writes it (REQ-227).
   */
  readonly triggerType: TriggerType;
  /** The explicit reach of a comment automation (REQ-367). */
  readonly scope: AutomationScope["type"];
  /** The one publication a comment automation watches. Empty for a message. */
  readonly target: string;
  /**
   * The words that start it. Empty under `any`, and empty is not a hole there:
   * the mode says the publication is the whole condition (REQ-262).
   */
  readonly keywords: readonly string[];
  readonly mode: MatchMode;
  readonly publicReply: boolean;
  /**
   * The wordings of the public reply, of which the engine draws one per run
   * (REQ-125). ONE list and not a first plus its variations (REQ-274): they are
   * all the same thing to the person who reads one, and the screen writes them
   * as the chips of a single field.
   */
  readonly publicReplyTexts: readonly string[];
  /**
   * The private message, as PARTS that add to one another (REQ-229).
   *
   * There is no format to choose any more, and the absence is the whole of task
   * 3k.18: the editor used to open with "text, card or file", each shape
   * excluding the other two, which is how "here is the PDF I promised" plus the
   * PDF became a file with no words. What is left is a message and three things
   * that can be added to it, and which MESSAGES the combination becomes is
   * read off the parts, never chosen. The attachment was one of those parts
   * until REQ-284 took it out of the format: a file is a card button's
   * destination now, and this editor no longer offers to attach one.
   *
   * Two of the fields below are mutually exclusive BY INVARIANT rather than by
   * shape, and the invariant is held where the buttons change (`withButton`,
   * `withoutButton`) instead of at the serialisation: with a button the text IS
   * the card's heading (REQ-230), so a draft carrying both a `messageText` and
   * a `cardTitle` is a draft the instance refuses
   * (`card_title_declared_twice`), and refuses precisely so that neither of the
   * two disappears in silence. `stepsOf` therefore writes exactly what it is
   * given, which is what lets a broken migration be caught by a test instead of
   * being papered over.
   */
  readonly messageText: string;
  /** The card's cover. Offered only where a button is (REQ-232, REQ-287). */
  readonly image?: string;
  readonly cardTitle: string;
  readonly cardDescription: string;
  /**
   * Zero to three BUTTONS, which are what make the message a card (REQ-287).
   * Order is the order they sit in the card, never sorted.
   */
  readonly buttons: readonly ButtonDraft[];
  /**
   * Zero to three PURE links, each of which becomes a message of its own
   * (REQ-286, REQ-288).
   *
   * The other of the two forms, and a separate list because they are separate
   * deliveries: a button travels inside the card, a link travels after it and
   * lets the destination site draw its own preview. Plain strings, exactly as
   * the format holds them: a pure link has no label and no id, because there is
   * no click of ours to attribute and no words to put on it.
   *
   * Order is delivery order, never sorted. A blank entry is a link ASKED FOR
   * and not yet typed, which a draft may hold and an activation may not.
   */
  readonly links: readonly string[];
  readonly once: boolean;
  /**
   * How long the automation holds its FIRST reply, in seconds (REQ-277).
   *
   * A value and no longer a step, which is the whole of what this screen gave
   * up: the pause used to be written as a `delay` step and the editor always
   * put it LAST, after everything had already gone out, so switching it on
   * changed nothing the contact ever saw. It is a rule now, taken once, and
   * there is no position to get wrong.
   *
   * A number and never the text of a field, because the contract refuses a
   * string: a screen that stored "5" would hold nothing back at all, and the
   * refusal would arrive at the save rather than here.
   */
  readonly firstReplyDelaySeconds: FirstReplyDelaySeconds;
  /**
   * What OPENS the conversation, in the one order the aggregate writes it.
   *
   * The three carry a question the operator writes, which is why they are not
   * rules: each of them changes what the contact receives, and in which order.
   * The sequence between them is settled (confirmation, then the e-mail, then
   * the follow) and nothing on this screen reorders it.
   *
   * What they no longer carry is a DEADLINE or a number of tries (REQ-252,
   * REQ-254). Three fields on this screen asked for the same number three
   * times, nobody had a basis to tell them apart, and the author of the product
   * had to ask what they were for. They are one setting of the instance now and
   * are offered in Settings, once.
   */
  readonly confirmation: boolean;
  /**
   * The question the confirmation asks.
   *
   * Absent is NOT empty, and the difference is what lets the request come
   * already on (REQ-273): a new automation opens with the confirmation asked,
   * and until the operator writes another sentence the one it asks with is the
   * catalogue's own, exactly as the closing message of the instance is written
   * before anybody writes one (REQ-255).
   *
   * It is resolved where it is READ and never copied into this draft, because
   * the language of the instance arrives over `/api/locale` AFTER the first
   * paint: a sentence frozen into state at mount would be frozen in the
   * language the answer had not corrected yet.
   */
  readonly confirmationText?: string;
  /**
   * What the button says, and therefore what confirms (REQ-249, REQ-250).
   *
   * Absent is NOT empty here for the same reason it is not above (REQ-332): the
   * label a new automation is born offering is the catalogue's own, and it is
   * resolved where it is READ so that the language arriving over `/api/locale`
   * after the first paint reaches it (REQ-333). What activation still refuses
   * is a label the operator EMPTIED, which is a written answer of nothing and
   * not the absence of one.
   */
  readonly confirmationQuickReply?: string;
  readonly email: boolean;
  readonly emailText: string;
  readonly follow: boolean;
  readonly followText: string;
}

/**
 * What the card's heading and its description may hold, in characters.
 *
 * The generic template's own ceiling, an order of magnitude tighter than the
 * thousand bytes a text message accepts, which is exactly why it is shown in
 * the field. It is a visual cut, though: the platform accepts and keeps a title
 * past it, so this is advice rather than `maxLength` (ADR-028 / REQ-346).
 *
 * Written here and not imported, and the reason is a boundary rather than a
 * preference: the number lives in `config/limits.ts` (`cardTitleChars`, tunable
 * through `CARD_TITLE_CHARS`), and that module reads `NodeJS.ProcessEnv` — this
 * program has the DOM and no Node types on purpose, so importing it would not
 * typecheck. Nothing publishes the limits to the browser today. The instance
 * remains the authority. Nothing publishes the limits to the browser today, so
 * the default is the best advice it can give; the saved definition still keeps
 * every character the operator wrote.
 */
const CARD_TEXT_LIMIT = 80;
const MESSAGE_TEXT_BYTES_LIMIT = 1000;

/** The browser-side equivalent of the instance's UTF-8 byte measurement. */
function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function cardTitleAdvice(value: string, t: Translate): FieldAdvice | undefined {
  const advice = lengthAdvice(value, { truncatesAt: CARD_TEXT_LIMIT });
  if (advice === undefined) return undefined;

  return {
    nature: advice.nature,
    message: t(LENGTH_ADVICE_TEXT_KEYS[advice.nature], { max: advice.limit }),
  };
}

/**
 * What a question does when its deadline passes: it abandons the run.
 *
 * The single policy the format declares (`TIMEOUT_POLICIES`), and the one thing
 * about waiting that is still the automation's to say: HOW LONG it waits is a
 * setting of the instance (REQ-252), and this screen no longer asks for it.
 */
const ON_TIMEOUT = "abandon";

const DEFAULT_DRAFT: Draft = {
  id: "",
  state: "draft",
  triggerType: "comment",
  scope: "publication",
  target: "",
  keywords: [],
  mode: "contains",
  publicReply: false,
  publicReplyTexts: [],
  messageText: "",
  cardTitle: "",
  cardDescription: "",
  buttons: [],
  links: [],
  once: true,
  // The product's answer and not the ruler's floor: zero is on the ruler and
  // means immediate, declared by whoever wants it (REQ-277).
  firstReplyDelaySeconds: DEFAULT_FIRST_REPLY_DELAY_SECONDS,
  // Asked, on a new automation, because the platform very nearly obliges it
  // (REQ-273): the first message may carry no link, so without something that
  // opens the conversation the delivery is the message that never arrives, and
  // an operator who did not know the rule found out when nothing went out. The
  // question it asks and the label of its button both come from the catalogue
  // (REQ-332), and neither is written here: both are resolved where they are
  // read, so the language settles them (REQ-333). Activation is still refused
  // for a label the operator EMPTIED (REQ-249).
  confirmation: true,
  email: false,
  emailText: "",
  follow: false,
  followText: "",
};

const FIELD = {
  target: "automation-target",
  keywords: "automation-keywords",
  matchWord: "automation-match-word",
  matchAny: "automation-match-any",
  reply: "automation-public-reply",
  text: "automation-message-text",
  image: "automation-card-image",
  cardTitle: "automation-card-title",
  cardDescription: "automation-card-description",
  addLink: "automation-add-link",
  addButton: "automation-add-button",
  addCover: "automation-add-cover",
  confirmation: "automation-confirmation-text",
  confirmationQuickReply: "automation-confirmation-quick-reply",
  email: "automation-email-text",
  follow: "automation-follow-text",
} as const;

/**
 * The publication block's own two sentences, which are addressed rather than
 * focused: what the block IS and what it is FOR (REQ-267). They are not in
 * `FIELD` because nothing here is a control a refusal can put the caret on.
 */
const TARGET_LABEL = "automation-target-label";
const TARGET_TIP = "automation-target-tip";
/**
 * The refusal of the publication block, which is a paragraph of its own here
 * for the reason the two above are: the block is not a `Field`, so nothing
 * draws its sentence or wires it into the button's description automatically.
 * It carries the same class the component's own refusal does, so the two are
 * one thing to the stylesheet and cannot drift apart.
 */
const TARGET_ERROR = "automation-target-error";

/**
 * The sentence the confirmation asks with while nobody has written another
 * (REQ-273). Named here because two readers resolve it: the field that shows it
 * and the aggregate that is saved, and a second literal is how the two would
 * come to promise different questions.
 */
const CONFIRMATION_QUESTION = "screens.automations.confirmationQuestionDefault";

/**
 * What the button of that question says while nobody has written another
 * (REQ-332).
 *
 * Named here for the reason above it is: the field that shows the label and the
 * aggregate that is saved both resolve it, and a second literal is how the
 * button on the screen and the button that goes out would come to say different
 * things. Resolved at READ and never frozen into the draft, so switching the
 * language switches the suggestion (REQ-333).
 */
const CONFIRMATION_QUICK_REPLY =
  "screens.automations.confirmationQuickReplyDefault";

/**
 * The ruler of waits, as one group. Not in `FIELD` for the reason the two above
 * are not: the choice is closed, so no answer to it can be refused, and there
 * is no caret to send anywhere.
 */
const FIRST_REPLY_DELAY = "automation-first-reply-delay";

/** Seconds in a minute, so the label of 60 is read and not spelled. */
const SECONDS_IN_A_MINUTE = 60;

/**
 * The wait this screen may show, which is only ever one the contract accepts
 * (REQ-277).
 *
 * Two callers and one reason. Reopening a stored automation reads a value this
 * program did not write: `rules` is absent on a draft the editor never reached,
 * and the aggregate itself arrives over HTTP as parsed JSON, so a number off
 * the ruler is a thing that can be HELD even though the type says otherwise.
 * Either way an unmatched value would leave the group with nothing selected,
 * and the operator would then save whatever they happened to press next.
 * Falling back to the product's own answer keeps the screen showing a choice
 * the schema would accept.
 *
 * The other caller is the group itself, which hands back the string an option
 * carries: the ruler is what turns it into the number the contract wants.
 */
function offeredWait(seconds: number | undefined): FirstReplyDelaySeconds {
  return (
    FIRST_REPLY_DELAY_CHOICES.find((choice) => choice === seconds) ??
    DEFAULT_FIRST_REPLY_DELAY_SECONDS
  );
}

/** What one wait is called on its option: "Imediato", "5s", "1 min". */
function waitChoiceLabel(seconds: number, t: Translate): string {
  if (seconds === 0) return t("screens.automations.firstReplyDelayImmediate");

  return seconds % SECONDS_IN_A_MINUTE === 0
    ? t("screens.automations.firstReplyDelayMinutes", {
        minutes: seconds / SECONDS_IN_A_MINUTE,
      })
    : t("screens.automations.firstReplyDelaySeconds", { seconds });
}

/**
 * The same choice said back as a sentence, which is what the ruler owes: "5s"
 * is a length and not a behaviour, and what the operator is deciding is which
 * messages wait and which do not.
 */
function waitEcho(seconds: number, t: Translate): string {
  if (seconds === 0) return t("screens.automations.firstReplyEchoImmediate");

  const written =
    seconds % SECONDS_IN_A_MINUTE === 0
      ? t("screens.automations.firstReplyEchoMinutes", {
          count: seconds / SECONDS_IN_A_MINUTE,
        })
      : t("screens.automations.firstReplyEchoSeconds", { count: seconds });

  return t("screens.automations.firstReplyEcho", { wait: written });
}

function optional(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

/**
 * The draft after ONE button is added, text and all (REQ-230, REQ-287).
 *
 * The first BUTTON is the moment the loose message stops existing: from here
 * the delivery is a card, and what the operator had written travels as that
 * card's heading. Moving the words is not a convenience: leaving them where
 * they were would mean either dropping them at the send (which is the fault
 * this whole phase exists to end) or declaring a text AND a title, which the
 * instance refuses by name (`card_title_declared_twice`) precisely so that
 * neither of them can vanish quietly.
 *
 * So the migration EMPTIES the box it took the words from, in the same change.
 * It preserves every character: the template only cuts its drawing, while the
 * stored title and the delivery retain the complete wording (ADR-028 / REQ-346).
 *
 * A pure LINK does none of this, and the asymmetry is the requirement rather
 * than an oversight (REQ-287, REQ-288): a link is a message of its own that
 * lands after the written one, so the written one goes on being a message.
 */
function withButton(draft: Draft, button: ButtonDraft): Partial<Draft> {
  const buttons = [...draft.buttons, button];

  return draft.buttons.length > 0
    ? { buttons }
    : {
        buttons,
        cardTitle: draft.messageText.trim(),
        messageText: "",
      };
}

/**
 * The draft after one button is removed, and what leaves with the last of them.
 *
 * The reverse of the migration above, and reversible on purpose: an operator
 * who added a button to see what it looked like gets their message back instead
 * of finding it in a field named "heading". The cover goes with the last button
 * (REQ-232, REQ-287): it belongs to the card, there is no card without a
 * button, and so does the description, which the card was the only thing that
 * could carry.
 */
function withoutButton(draft: Draft, id: string): Partial<Draft> {
  const buttons = draft.buttons.filter((button) => button.id !== id);

  return buttons.length > 0
    ? { buttons }
    : {
        buttons,
        messageText: draft.messageText || draft.cardTitle,
        cardTitle: "",
        cardDescription: "",
        image: undefined,
      };
}

/**
 * What ONE button declares as its destination, and never both (REQ-285).
 *
 * The format's button is an exclusive union, so the abandoned field is not
 * written at all: a card that opens "an address and a file" is a sentence the
 * contract cannot hold, and a screen emitting both would produce a button that
 * is correctly filled in and refused at activation.
 *
 * The chosen field is written even while it is EMPTY, exactly as the cover's
 * is: an empty destination is one asked for and not yet chosen, which is a
 * half-written draft and not a resource named "". It is also the record of
 * WHICH of the two labels the operator pressed, and it is what the editor reads
 * back when the automation is reopened.
 */
function buttonDestination(button: ButtonDraft): Record<string, string> {
  return button.dest === "asset"
    ? { asset: button.asset.trim() }
    : { url: button.url.trim() };
}

/**
 * Whether the destination the operator CHOSE has really been filled in.
 *
 * Asked of the chosen one only, which is the whole point of the choice: an
 * address left behind when the operator switched to a file is not a fault, it
 * is a value nothing will write down.
 */
function buttonDestinationWritten(button: ButtonDraft): boolean {
  return button.dest === "asset"
    ? button.asset.trim() !== ""
    : /^https?:\/\//i.test(button.url.trim());
}

/**
 * Which destination a STORED button was written with (REQ-289).
 *
 * The choice survives the round trip because it is what was written down: a
 * button carrying `asset` is one the operator chose "PDF or image" for, and one
 * carrying `url` is a "Link". Nothing is inferred from the shape of an address,
 * and nothing is guessed from which of the two happens to be longer.
 *
 * A document holding BOTH is one the instance refuses by name
 * (`button_destination_declared_twice`), and it can still be read: the one
 * carrying a value wins, and a tie falls back to the address, which is the
 * older of the two forms and therefore the likelier intention. Reopening it
 * puts the editor on ONE of them, which is the state a save can leave.
 */
function storedDestination(record: Record<string, unknown>): ButtonDestination {
  const asset = textFromStep(record, "asset");
  const url = textFromStep(record, "url");
  if (asset !== "" && url === "") return "asset";
  if (url !== "") return "url";
  return "asset" in record && !("url" in record) ? "asset" : "url";
}

function uniqueStepId(base: string, used: Set<string>): string {
  let id = base;
  let suffix = 2;
  while (used.has(id)) id = `${base}-${suffix++}`;
  used.add(id);
  return id;
}

/**
 * The identity an aggregate is written with, all of it DERIVED (REQ-228).
 *
 * An identifier and nothing more: the name is not written at all any more
 * (REQ-279), it is composed for the screen that is showing it, out of what the
 * publication is called at that moment.
 */
interface Derived {
  /** Used only when the automation has none yet: an id never changes. */
  readonly id: string;
}

/**
 * What the automation DOES, in the one order it does it.
 *
 * The single place that decides what goes out and when. It is a function of its
 * own rather than a stretch of `definitionOf` because two readers need that
 * order and it must be the SAME order for both: the aggregate that is saved,
 * and the preview that promises the operator what the contact will live
 * through (REQ-225). A preview assembled from the draft on its own would be a
 * second opinion about the sequence, and the day the two disagreed the screen
 * would be lying about the thing it exists to show.
 */
function stepsOf(
  draft: Draft,
  t: Translate,
): readonly Record<string, unknown>[] {
  const steps: Record<string, unknown>[] = [];
  const used = new Set<string>();
  if (draft.publicReply) {
    const replies = draft.publicReplyTexts;
    steps.push({
      id: uniqueStepId("public-reply", used),
      action: "reply_comment",
      // One wording travels as the string every stored definition already
      // carries, and several as the list the format also accepts: the shape
      // says how many there are, and nothing has to be migrated to be read.
      text: replies.length === 1 ? replies[0] : [...replies],
    });
  }

  /*
   * What OPENS the conversation, before the delivery and after the public
   * reply (REQ-066).
   *
   * The order is the point and not a detail of assembly: the platform refuses
   * a link in the first message, so the delivery can only be the answer to
   * something the contact replied to. A `send_dm` written before these three
   * would be exactly the message that never arrives.
   *
   * The sequence between the three is fixed here — confirmation, then the
   * e-mail, then the follow — and it is an assumption of the spec rather than
   * a choice on the screen: nothing in this editor reorders them.
   */
  // A direct message is already the contact's reply, so the conversation is
  // open before this automation starts. Confirmation only opens a conversation
  // for a comment-triggered automation (REQ-349 / ADR-026).
  if (draft.triggerType === "comment" && draft.confirmation) {
    // Nullish and not falsy, the same distinction the question is read under:
    // the label nobody has touched is the catalogue's, and the one that was
    // cleared is an answer of nothing.
    const quickReplyLabel = optional(
      draft.confirmationQuickReply ?? t(CONFIRMATION_QUICK_REPLY),
    );

    steps.push({
      id: uniqueStepId("confirmation", used),
      action: "confirm_optin",
      // The catalogue's own question while nobody has written another
      // (REQ-273). Nullish and not falsy on purpose: an operator who EMPTIED
      // the field said something, and what they said is not "use the default".
      text: draft.confirmationText ?? t(CONFIRMATION_QUESTION),
      // The catalogue's own label under the same rule the question follows
      // (REQ-332), and written only when there is something to write: an
      // operator who EMPTIED the field is left with no button, which is what
      // activation refuses by name (REQ-249), while an empty string here would
      // be refused by the shape instead, naming a path and not the step.
      ...(quickReplyLabel !== undefined && {
        quick_reply_label: quickReplyLabel,
      }),
      on_timeout: ON_TIMEOUT,
    });
  }
  if (draft.email)
    steps.push({
      id: uniqueStepId("email", used),
      action: "collect_email",
      ask: draft.emailText,
      on_timeout: ON_TIMEOUT,
    });
  if (draft.follow)
    steps.push({
      id: uniqueStepId("follow", used),
      action: "follow_gate",
      ask: draft.followText,
      on_timeout: ON_TIMEOUT,
    });

  /*
   * The additive message (REQ-229): a text, and the parts that ADD to it.
   *
   * Every part is written exactly as the draft holds it, and nothing is
   * arbitrated here. That is deliberate to the point of being the design: the
   * combinations that cannot go out together are prevented where the operator
   * makes them — the text moves into the heading when the first button arrives,
   * the cover leaves with the last one — so this function has no rule of its
   * own to disagree with them. A guard written here as well would be a second
   * opinion that silently CORRECTED a broken migration, which is the one way a
   * lost text could come back without a single test failing.
   */
  const message = {
    ...(optional(draft.messageText) !== undefined && {
      text: draft.messageText,
    }),
    ...(draft.buttons.length > 0 && {
      // Built field by field and never spread from the draft: the draft holds
      // the destination that was NOT chosen so that switching back is free, and
      // spreading it would put both of them into an aggregate whose button
      // accepts exactly one.
      buttons: draft.buttons.map((button) => ({
        id: button.id,
        label: button.label.trim(),
        ...buttonDestination(button),
      })),
    }),
    // Each one a message of its own, in the order they were declared
    // (REQ-286, REQ-288). Written as the draft holds them, blanks included: a
    // link asked for and not yet typed is a half-written draft, and activation
    // is what refuses it, by the same walk that refuses a half-written button.
    ...(draft.links.length > 0 && {
      links: draft.links.map((link) => link.trim()),
    }),
    // An empty string is the cover ASKED FOR and not yet chosen, which is a
    // half-written draft and not a resource named "".
    ...(optional(draft.image ?? "") !== undefined && { image: draft.image }),
    ...(optional(draft.cardTitle) !== undefined && {
      title: draft.cardTitle.trim(),
    }),
    ...(optional(draft.cardDescription) !== undefined && {
      description: draft.cardDescription.trim(),
    }),
  };
  steps.push({
    id: uniqueStepId("private-message", used),
    action: "send_dm",
    message,
  });
  /*
   * Nothing is appended for the WAIT, and its absence is the requirement
   * (REQ-277). The pause the operator chooses is `rules.first_reply_delay_
   * seconds` now, written beside `once_per_contact` below.
   *
   * The `delay` STEP is untouched in the format and in the engine: it is a
   * pause between two named steps (REQ-098, proven end to end), which is a
   * different thing from the hold before the first reply. What left is this
   * editor's use of it, and only that.
   */
  return steps;
}

/**
 * The aggregate as it is written, with the identifier it was DERIVED into
 * (REQ-228).
 *
 * What it does NOT write is a name (REQ-279). The publication it watches is
 * stored, the caption that publication carries lives in the cache, and the
 * sentence an operator reads is made out of the two when a screen shows them.
 * Writing that sentence here would store today's caption and go on showing it
 * after the operator has edited the post.
 */
function definitionOf(
  draft: Draft,
  state: "draft" | "active",
  derived: Derived,
  t: Translate,
): UnifiedAutomation {
  const steps = stepsOf(draft, t);
  const definition: Record<string, unknown> = {
    schema_version: AUTOMATION_SCHEMA_VERSION,
    kind: "automation",
    // Settled once: an automation already stored keeps the identifier it was
    // created under, because the address and the click history are written
    // against it.
    id: draft.id || derived.id,
    state,
    trigger: {
      type: draft.triggerType,
      ...(draft.triggerType === "comment" &&
        draft.scope === "publication" && {
          target: draft.target.trim(),
        }),
      // One side or the other, never both: under "any word" the aggregate
      // declares no `keywords` field at all, which is how the schema refuses
      // the combination by shape rather than by a rule (REQ-262).
      match:
        draft.mode === ANY_WORD_MODE
          ? { mode: ANY_WORD_MODE }
          : { keywords: [...draft.keywords], mode: draft.mode },
    },
    scope:
      draft.triggerType === "direct_message"
        ? { type: "global" }
        : draft.scope === "publication"
          ? { type: "publication", publicationId: draft.target.trim() }
          : { type: draft.scope },
    // Both decisions that govern the whole run, taken once and written
    // together: whether this contact may receive again, and how long the first
    // reply is held (REQ-277).
    rules: {
      once_per_contact: draft.once,
      first_reply_delay_seconds: draft.firstReplyDelaySeconds,
    },
    steps,
  };
  return definition as UnifiedAutomation;
}

function textFromStep(
  step: Record<string, unknown> | undefined,
  field: string,
): string {
  const value = step?.[field];
  return typeof value === "string"
    ? value
    : Array.isArray(value) && typeof value[0] === "string"
      ? value[0]
      : "";
}

/**
 * Every wording a step declares, read as one list whichever shape it is in.
 *
 * The format's own reading (`stepWordings`), repeated here rather than
 * imported, and the reason is the boundary and not a preference: this program
 * has the DOM and the module that reads the shape is compiled without it.
 */
function wordingsFromStep(
  step: Record<string, unknown> | undefined,
): readonly string[] {
  const value = step?.["text"];
  if (typeof value === "string") return [value];
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

/** Reads a catalogue sentence: the only shape of words this screen has. */
type Translate = (key: string, params?: Record<string, unknown>) => string;

/**
 * One line of the conversation the preview draws, which is the PRIVATE one and
 * only it (REQ-271).
 *
 * There is no "where" beside the speaker any more, and its absence is the
 * requirement: the comment and the public reply happen on the publication, the
 * publication has no preview, and a handset drawing a comment inside it was
 * showing the operator a screen that does not exist. What is left is one thread
 * in one place, so who speaks is the whole of what a line has to say.
 */
interface PreviewLine {
  readonly id: string;
  readonly from: "contact" | "operator";
  /**
   * The stretch of the conversation this message OPENS, when it opens one.
   *
   * Carried by the first line of each stretch and by no other, which is what
   * makes it a heading over what follows instead of a caption beside one
   * bubble. It is the only part of the preview that argues rather than shows:
   * "only then, the delivery" is the sentence that explains why the message
   * that carries a link is last, and without it the three questions above look like
   * an operator's whim instead of what the platform obliges (REQ-066).
   */
  readonly step?: string;
  /** The words, already resolved to a placeholder while none are written. */
  readonly text?: string;
  /** The button that goes out beside a question, when one is declared. */
  readonly quickReply?: string;
  /**
   * Whether this question travels as a CARD (REQ-314).
   *
   * The words become the card's heading and the button a strip across its
   * foot, which is what a generic template is, instead of a bubble with a chip
   * stuck under it. It is a fact about the WIRE and not a decoration: which
   * question arrives that way is decided by the walk in `conversationOf`, and
   * the rule it applies is written beside `PreviewQuestionCard`.
   */
  readonly card?: boolean;
  /**
   * Whether this line IS part of the delivery, and which part.
   *
   * Two kinds since REQ-286: the written message (a card once a button makes
   * one), and each pure link, which lands as a message of its OWN after it.
   * The attachment's kind left with REQ-284 and did not come back: a file is a
   * card button's destination now, so it travels inside the card.
   */
  readonly delivery?: "message" | "link";
  /** The address this line carries, when it is a pure link. */
  readonly link?: string;
  /**
   * Which message of the delivery this is, when the delivery is several.
   *
   * Absent while there is only one, because "message 1 of 1" is a count nobody
   * asked for: the tag exists to say that what was written became more than one
   * thing, and in which order they land.
   */
  readonly ordinal?: {
    readonly number: number;
    readonly total: number;
  };
}

/**
 * Whether the FIRST message carries anything to send.
 *
 * The first one only, and that is the whole of what it decides: the parts of a
 * `send_dm` become one message when there is a text or a card, plus one more
 * for every pure link (REQ-286). So a delivery that is three links and nothing
 * else sends no empty bubble before them.
 *
 * Written once because two readers ask it: the preview, which draws a bubble
 * for it, and the sentence under the section, which names it. A second copy of
 * this expression drifting by one field is a screen whose drawing and whose
 * words disagree about what goes out.
 */
function messageSpeaks(message: Record<string, unknown>): boolean {
  return (
    message["text"] !== undefined ||
    message["title"] !== undefined ||
    message["description"] !== undefined ||
    message["image"] !== undefined ||
    (Array.isArray(message["buttons"]) && message["buttons"].length > 0)
  );
}

/**
 * The PRIVATE conversation, in the order the contact lives it (REQ-225,
 * REQ-271).
 *
 * Built by WALKING `stepsOf`, and that walk is the whole guarantee of the
 * order: the sequence is decided once, where the aggregate is assembled, and
 * this function has no opinion of its own to disagree with it. What it adds is
 * the half the aggregate has no room for: the ANSWER the contact gives to each
 * question, because that is what makes the opening read as a conversation
 * instead of as three switches.
 *
 * What it does NOT add any more is the comment and the public reply. Both
 * happen on the publication, the publication has no preview, and the handset
 * that drew them was drawing a screen the operator will never see. The legend
 * under the preview says so in words, so the absence is a statement rather than
 * a hole.
 *
 * `instance` is what the INSTANCE decides about the conversation (REQ-313), and
 * it is undefined until the instance has answered. Every word of it that the
 * contact reads is drawn from there and never from the catalogue: the catalogue
 * holds the default an operator has not replaced, and a preview reading it
 * directly goes on showing that default after they replace it, which is the
 * whole of what this argument exists to prevent.
 */
function conversationOf(
  draft: Draft,
  t: Translate,
  instance: ConversationSettings | undefined,
): readonly PreviewLine[] {
  const commented = draft.triggerType === "comment";
  const lines: PreviewLine[] = commented
    ? // A comment automation's thread STARTS with what MyChat sends: what the
      // person did to earn it happened under the post, where this preview does
      // not go.
      []
    : [
        {
          id: "trigger",
          from: "contact",
          step: t("screens.automations.previewStepDirect"),
          text:
            draft.keywords[0] ?? t("screens.automations.previewDirectMessage"),
        },
      ];
  /**
   * How many questions have already been asked, which is what names the next
   * stretch: the first one is what OPENS the conversation and the ones after it
   * only continue it. It also decides what the delivery is called — with a
   * question before it the delivery is what the answer earns, and with none it
   * is simply the first thing that lands in the inbox.
   */
  let asked = 0;
  /**
   * Whether the next direct message of the run is still the PRIVATE REPLY, and
   * with it whether a button on that message travels as a card (REQ-314).
   *
   * The one shape rule of this walk, and it is the sender's rule read from the
   * other end (`toMessageBody` in `src/platform/sender.ts`): a message with a
   * button is a generic template with a postback strip when it is addressed by
   * `comment_id`, and a plain message with native quick replies when it is
   * addressed by contact. The private reply is what OPENS a conversation from
   * a comment and is spent by the first direct message that uses it
   * (`privateReplyAvailable` in `src/runtime/outbox.ts`), so it is state that
   * the walk carries and not a property of any one step: the same follow
   * request is a card at the top of a comment automation and a bubble with a
   * chip behind any question that went before it.
   *
   * A direct message automation never has one at all, which is why this starts
   * where it starts.
   */
  let privateReply = commented;

  for (const step of stepsOf(draft, t)) {
    const id = String(step["id"] ?? "");
    const opening =
      asked === 0
        ? t("screens.automations.previewStepOpens")
        : t("screens.automations.previewStepThen");
    switch (step["action"]) {
      case "confirm_optin": {
        const quickReply = textFromStep(step, "quick_reply_label");
        lines.push({
          id,
          from: "operator",
          step: opening,
          text:
            textFromStep(step, "text") ||
            t("screens.automations.previewConfirmationAsk"),
          // The shape it lands in (REQ-314). It is the first direct message of
          // its run whenever it is asked at all, since this editor puts it
          // before the other two questions and before the delivery, so what
          // the walk says here is always the card. Read from the walk anyway:
          // a second statement of the rule is a second thing to keep in step
          // with the sender.
          ...(privateReply && { card: true }),
          ...(quickReply !== "" && { quickReply }),
        });
        privateReply = false;
        asked += 1;
        // The answer the delivery is waiting for, which is the button itself
        // (REQ-250). A draft still being written may not have named it yet, and
        // the preview then stands in for it rather than showing an empty line.
        lines.push({
          id: `${id}-answer`,
          from: "contact",
          text: quickReply || t("screens.automations.previewAnswerConfirmed"),
        });
        break;
      }
      case "collect_email":
        lines.push({
          id,
          from: "operator",
          step: opening,
          text:
            textFromStep(step, "ask") ||
            t("screens.automations.previewEmailAsk"),
        });
        lines.push({
          id: `${id}-answer`,
          from: "contact",
          text: t("screens.automations.previewAnswerEmail"),
        });
        // Nothing to draw differently for it, and it spends the private reply
        // all the same: it is a direct message with no button, so it goes out
        // as words either way and the CARD it takes with it is the one the
        // request behind it would have had.
        privateReply = false;
        asked += 1;
        break;
      case "follow_gate":
        lines.push({
          id,
          from: "operator",
          step: opening,
          text:
            textFromStep(step, "ask") ||
            t("screens.automations.previewFollowAsk"),
          /*
           * The button that always goes out beside this request, in the words
           * the INSTANCE carries (REQ-313, REQ-257).
           *
           * The request is written per automation and the button is not: it
           * says one thing that never changes from automation to automation
           * ("I already followed"), so it lives in Settings and the engine
           * reads it from there (`ports.waiting.followButtonLabel`). Drawing
           * `instance.followButtonLabel` is therefore drawing the words that
           * will really be on the button, and drawing the catalogue's key
           * instead would show the default to an operator who renamed it.
           *
           * Nothing at all while the instance has not answered, and that is
           * deliberate: the catalogue's default IS what an instance answers
           * when nobody renamed the button, so falling back to it here would
           * be indistinguishable from the defect, right up until the operator
           * who did rename it opened this screen.
           */
          ...(instance !== undefined && {
            quickReply: instance.followButtonLabel,
          }),
          /*
           * And the SHAPE that button arrives in, which is the one thing about
           * this request that is not decided by the request (REQ-314).
           *
           * The step states an intent and refuses to name a mechanism, on
           * purpose (ADR-003, and the comment says so at `follow_gate` in
           * `src/engine/execute.ts`): "offer this choice". The mechanism is
           * resolved beside the endpoint, and it resolves to the postback card
           * only while the run still holds its private reply. Behind a
           * confirmation or an e-mail question, and in every direct message
           * automation, what lands is the ordinary bubble with a native quick
           * reply under it.
           *
           * So is every RESEND of it (REQ-246), and that one is invisible from
           * here: the private reply was spent by the first card long before the
           * contact tapped, so the loop the gate holds them in is bubbles with
           * chips whatever the first one was. The preview draws the run's first
           * pass and does not draw the loop at all.
           */
          ...(privateReply && { card: true }),
        });
        privateReply = false;
        lines.push({
          id: `${id}-answer`,
          from: "contact",
          text: t("screens.automations.previewAnswerFollowed"),
        });
        asked += 1;
        break;
      case "send_dm": {
        /*
         * What the delivery is CALLED, which is the sentence the whole section
         * above exists for: after a question it is what the answer earned
         * ("only then, the delivery"), and with no question before it there is
         * nothing to be "only then" about — it is simply what lands in the
         * inbox. A comment automation always says so, because the message
         * crosses from under the publication into a private thread; a direct
         * message automation is already in that thread and the first stretch
         * has said it once.
         */
        const arrives =
          asked > 0
            ? t("screens.automations.previewStepDelivery")
            : commented
              ? t("screens.automations.previewStepDirect")
              : undefined;

        /*
         * What this step really becomes, message by message (REQ-286).
         *
         * The written message, when it carries anything, and then one bubble
         * for every pure link, in the order they were declared. A blank link is
         * drawn by nothing: it is a row the operator has not filled in, and a
         * bubble showing an empty address would be promising a message the
         * contact would not receive.
         *
         * With nothing at all the written message still draws its own bubble,
         * which is where the placeholder lives: an editor showing an empty
         * handset says nothing about what is missing.
         */
        const message = (step["message"] ?? {}) as Record<string, unknown>;
        const links = declaredLinks(message);
        const speaks = messageSpeaks(message) || links.length === 0;
        const total = (speaks ? 1 : 0) + links.length;
        // A COUNTER and not the index of the loop: the tag says which of the
        // messages this is, and only the drawn ones are messages.
        let number = 0;
        const ordinalOf = (): Pick<PreviewLine, "ordinal"> => {
          number += 1;
          return total > 1 ? { ordinal: { number, total } } : {};
        };

        if (speaks)
          lines.push({
            id,
            from: "operator",
            ...(arrives !== undefined && { step: arrives }),
            ...ordinalOf(),
            delivery: "message",
          });
        for (const [linkIndex, link] of links.entries())
          lines.push({
            id: `${id}-link-${linkIndex}`,
            from: "operator",
            // The stretch is named by whichever bubble opens it, so a delivery
            // of links alone still says where the conversation has got to.
            ...(arrives !== undefined && !speaks && linkIndex === 0
              ? { step: arrives }
              : {}),
            ...ordinalOf(),
            delivery: "link",
            link,
          });
        break;
      }
      default:
        // A wait and a contact detail change nothing the person can read, and
        // a preview that drew them would be showing our bookkeeping as a
        // message that never arrives.
        break;
    }
  }

  return lines;
}

/**
 * What the delivery BECOMES, named message by message and in order (REQ-283).
 *
 * The section used to be answered by a number over the preview, and a number is
 * the one thing the handset beside it already shows: an operator who reads "2
 * messages" still does not know whether the file leaves before the words or
 * after them. So the sentence names them instead, in the order they land, and
 * the number survives only as part of that naming.
 *
 * Read off `stepsOf`, which is the assembly the preview walks and the save
 * writes: a sentence built from the draft's fields would be a second opinion
 * about what the combination becomes, and the day the two disagreed it is the
 * sentence, not the delivery, that the operator would believe.
 *
 * The list is joined by the catalogue and never here. Which separator a
 * language puts before its last item is that language's business (`a e b`,
 * `a and b`), and a screen gluing translated fragments together with a comma
 * decides it for every language at once.
 */
function deliveryShapeOf(draft: Draft, t: Translate): string {
  const step = stepsOf(draft, t).find((entry) => entry["action"] === "send_dm");
  const message = (step?.["message"] ?? {}) as Record<string, unknown>;
  const buttons = Array.isArray(message["buttons"]) ? message["buttons"] : [];
  const links = declaredLinks(message);
  const names: string[] = [];

  if (messageSpeaks(message))
    names.push(
      buttons.length > 0
        ? t("screens.automations.deliveryPartCard", { count: buttons.length })
        : t("screens.automations.deliveryPartMessage"),
    );

  // And one name per pure link, AFTER the written message, because that is
  // when they land (REQ-286, REQ-288). Named by their position when there are
  // several: "the 2nd link" is what tells the operator which of the two rows
  // above becomes which message.
  for (const [index] of links.entries())
    names.push(
      links.length === 1
        ? t("screens.automations.deliveryPartLink")
        : t("screens.automations.deliveryPartLinkNumbered", {
            number: index + 1,
          }),
    );

  // Nothing written at all: there is no shape to describe yet,
  // and naming "your message" over an empty field would be naming a message
  // that carries nothing.
  return names.length === 0
    ? t("screens.automations.deliveryShapeEmpty")
    : t("screens.automations.deliveryShape", { count: names.length, names });
}

/** Who is speaking. Never colour alone (REQ-111). */
function speakerLabel(line: PreviewLine, t: Translate): string {
  return line.from === "contact"
    ? t("screens.automations.previewWhoContact")
    : t("screens.automations.previewWhoYou");
}

function draftOf(definition: UnifiedAutomation): Draft {
  const steps = (definition.steps ?? []) as readonly Record<string, unknown>[];
  const reply = steps.find((step) => step["action"] === "reply_comment");
  const dm = steps.find((step) => step["action"] === "send_dm");
  const message = (dm?.["message"] ?? {}) as Record<string, unknown>;
  const buttons = Array.isArray(message["buttons"]) ? message["buttons"] : [];
  /*
   * The card is read off the BUTTONS, because that is what makes one (REQ-287).
   *
   * With a button, the heading is the declared title or, failing that, the text —
   * the same reading the engine makes when it sends, so what the editor shows
   * is what the contact would have received. Whichever of the two becomes the
   * heading, the other is left empty here: a draft carrying both is what the
   * instance refuses by name, and reopening one must not put the editor back
   * into that state silently.
   */
  const carded = buttons.length > 0;
  const declaredTitle = textFromStep(message, "title");
  const declaredText = textFromStep(message, "text");
  const confirmation = steps.find((step) => step["action"] === "confirm_optin");
  const email = steps.find((step) => step["action"] === "collect_email");
  const follow = steps.find((step) => step["action"] === "follow_gate");
  const trigger = definition.trigger;
  return {
    ...DEFAULT_DRAFT,
    id: definition.id,
    state: definition.state,
    triggerType: trigger?.type ?? "comment",
    scope:
      definition.scope?.type ??
      (trigger?.type === "direct_message"
        ? "global"
        : trigger?.target === undefined
          ? "global"
          : "publication"),
    target:
      definition.scope?.type === "publication"
        ? definition.scope.publicationId
        : trigger?.type === "comment"
          ? (trigger.target ?? "")
          : "",
    keywords: declaredKeywords(trigger),
    mode: trigger?.match?.mode ?? "contains",
    publicReply: reply !== undefined,
    publicReplyTexts: wordingsFromStep(reply),
    messageText: carded ? "" : declaredText || declaredTitle,
    image:
      carded && typeof message["image"] === "string"
        ? message["image"]
        : undefined,
    cardTitle: carded ? declaredTitle || declaredText : "",
    cardDescription: carded ? textFromStep(message, "description") : "",
    buttons: buttons.flatMap((button) => {
      const record = button as Record<string, unknown>;
      if (typeof record["id"] !== "string") return [];
      return [
        {
          id: record["id"],
          label: textFromStep(record, "label"),
          dest: storedDestination(record),
          url: textFromStep(record, "url"),
          asset: textFromStep(record, "asset"),
        },
      ];
    }),
    /*
     * The pure links, exactly as they were stored (REQ-288).
     *
     * Order is not re-derived and nothing is sorted: the array IS the delivery
     * order, so reading it back any other way would show the operator a
     * sequence their contacts will not live through.
     */
    links: Array.isArray(message["links"])
      ? message["links"].filter(
          (link): link is string => typeof link === "string",
        )
      : [],
    once: definition.rules?.once_per_contact ?? true,
    // Off the RULE and never off a step: a stored `delay` step is REQ-098's
    // pause between two named steps, which this ruler does not speak for
    // (REQ-277).
    firstReplyDelaySeconds: offeredWait(
      definition.rules?.first_reply_delay_seconds,
    ),
    confirmation: confirmation !== undefined,
    // An automation that asks nothing yet leaves the question UNWRITTEN rather
    // than empty, so turning the request on offers the catalogue's sentence
    // here exactly as a new automation is born with it (REQ-273).
    confirmationText:
      confirmation === undefined
        ? undefined
        : textFromStep(confirmation, "text"),
    // Read under the same rule the question is, and for the same reason: a
    // stored step is given back exactly as it was stored, while an automation
    // that asks nothing leaves the label UNWRITTEN, so turning the request on
    // offers the catalogue's own (REQ-332) instead of an empty button.
    confirmationQuickReply:
      confirmation === undefined
        ? undefined
        : textFromStep(confirmation, "quick_reply_label"),
    email: email !== undefined,
    emailText: textFromStep(email, "ask"),
    follow: follow !== undefined,
    followText: textFromStep(follow, "ask"),
  };
}

/**
 * The five stretches of the editor, in the order they are read.
 *
 * They are a list here and five sections on screen because the SAME division
 * answers two questions that used to be answered separately: which field takes
 * the caret when activation is refused, and whether a section still holds
 * something incomplete. One walk, one verdict, and a section that says it is
 * done cannot be the section that swallows the focus.
 */
const STEPS = ["trigger", "reply", "opening", "delivery", "rules"] as const;

type Step = (typeof STEPS)[number];

/**
 * One field turned away, and the words drawn under it (REQ-310).
 *
 * The field and the sentence travel together because a refusal that names a
 * field and says nothing sends the operator to a control with no idea what is
 * wrong with it, and a sentence with no field is the paragraph at the top of
 * the page this task exists to replace.
 *
 * The sentence is SHORT and it is written from where it sits: the field it
 * hangs under is already labelled, so naming the field again inside it would
 * be reading the label back to whoever is looking at it.
 */
interface Fault {
  /** The id of the control the caret goes to, and the border turns red on. */
  readonly field: string;
  readonly reason: RefusalReason;
}

/**
 * What a field is turned away FOR, in the operator's terms and not the
 * schema's.
 *
 * A closed union rather than the schema's codes, and the two are deliberately
 * not the same list: several codes are one sentence to whoever is looking at
 * the field (a title over its ceiling and a description over its ceiling are
 * both "at most N characters"), and several sentences answer no code at all,
 * because this editor refuses an unfinished draft before the instance is ever
 * asked.
 */
type RefusalReason =
  | "choosePublication"
  | "declareWord"
  | "writeReply"
  | "writeQuestion"
  | "writeButtonWords"
  | "writeAddress"
  | "chooseFile"
  | "writeLink"
  | "deliverSomething"
  | "maxChars"
  | "maxBytes";

/**
 * The sentence each reason is said in UNDER the field.
 *
 * Keyed by the closed union, so a reason added without a sentence is a
 * compiler error rather than a field refused in silence. The words are short
 * on purpose (REQ-310): the label is above the control and the tip beside it,
 * so a sentence repeating either is a sentence read twice.
 */
const REFUSAL_FIELD_KEYS: Readonly<Record<RefusalReason, string>> = {
  choosePublication: "screens.automations.refusalChoosePublication",
  declareWord: "screens.automations.refusalDeclareWord",
  writeReply: "screens.automations.refusalWriteReply",
  writeQuestion: "screens.automations.refusalWriteQuestion",
  writeButtonWords: "screens.automations.refusalWriteButtonWords",
  writeAddress: "screens.automations.refusalWriteAddress",
  chooseFile: "screens.automations.refusalChooseFile",
  writeLink: "screens.automations.refusalWriteLink",
  deliverSomething: "screens.automations.refusalDeliverSomething",
  maxChars: "screens.automations.refusalMaxChars",
  maxBytes: "screens.automations.refusalMaxBytes",
};

/**
 * The first field of ONE stretch that stands between this draft and activation,
 * or nothing when the stretch holds no fault at all.
 *
 * "No fault" is the whole definition of a completed section, and it is
 * deliberately not "the operator touched it": a public reply that is switched
 * off, three questions that are all shut and two rules nobody wanted are
 * complete sections — there is nothing in them left to answer. What the check
 * in the heading promises is exactly what this function decides, so the badge
 * and the refusal can never disagree about what is missing.
 */
function faultIn(draft: Draft, step: Step): Fault | undefined {
  switch (step) {
    case "trigger":
      if (
        draft.triggerType === "comment" &&
        draft.scope === "publication" &&
        draft.target.trim() === ""
      )
        return { field: FIELD.target, reason: "choosePublication" };
      // Under "any word" there is no word to be missing: the publication IS
      // the condition, so a section demanding one would never be completable
      // (REQ-262).
      if (draft.mode === ANY_WORD_MODE) return undefined;
      return draft.keywords.length === 0
        ? { field: FIELD.keywords, reason: "declareWord" }
        : undefined;
    case "reply":
      return draft.publicReply && draft.publicReplyTexts.length === 0
        ? { field: FIELD.reply, reason: "writeReply" }
        : undefined;
    case "opening":
      // Walked in the order the questions go out, so the field that takes the
      // caret is the first one an operator would have got to.
      //
      // A question NOBODY has written is not missing: it is the catalogue's
      // own, which is what the confirmation asks with until somebody writes
      // another (REQ-273). What is missing is a field the operator EMPTIED.
      if (
        draft.triggerType === "comment" &&
        draft.confirmation &&
        draft.confirmationText?.trim() === ""
      )
        return { field: FIELD.confirmation, reason: "writeQuestion" };
      // REQ-249: the button is what the question is answered with, so an
      // automation cannot be activated without one. Asked here as well as at
      // validation, which refuses it by name: this is what puts the caret in
      // the field instead of sending the operator to read a notice.
      //
      // A label NOBODY has written is not missing either (REQ-332): it is the
      // catalogue's own, exactly as the question above it is.
      if (
        draft.triggerType === "comment" &&
        draft.confirmation &&
        draft.confirmationQuickReply?.trim() === ""
      )
        return {
          field: FIELD.confirmationQuickReply,
          reason: "writeButtonWords",
        };
      if (draft.email && draft.emailText.trim() === "")
        return { field: FIELD.email, reason: "writeQuestion" };
      if (draft.follow && draft.followText.trim() === "")
        return { field: FIELD.follow, reason: "writeQuestion" };
      return undefined;
    case "delivery": {
      /*
       * The delivery, walked as the parts really are (REQ-229).
       *
       * There is no format to be wrong about any more: what makes this message
       * incomplete is a part that was started and not finished (a button with
       * no words or no destination, a link row nobody typed into), or a
       * delivery that would go out carrying nothing at all. The last is the
       * only case where the message box itself is at fault, and it is only at
       * fault when nothing else speaks: an automation that offers a button and
       * nothing else is a whole automation, and so is one that is a link.
       *
       * Walked in the order the parts are drawn, so the field that takes the
       * caret is the first one an operator would have got to.
       */
      const faulty = draft.buttons.findIndex(
        (button) =>
          button.label.trim() === "" || !buttonDestinationWritten(button),
      );
      if (faulty >= 0) {
        const button = draft.buttons[faulty];
        if (button === undefined || button.label.trim() === "")
          return {
            field: `automation-button-${faulty}-label`,
            reason: "writeButtonWords",
          };
        return button.dest === "asset"
          ? {
              field: `automation-button-${faulty}-asset`,
              reason: "chooseFile",
            }
          : {
              field: `automation-button-${faulty}-url`,
              reason: "writeAddress",
            };
      }

      const blankLink = draft.links.findIndex(
        (link) => !/^https?:\/\//i.test(link.trim()),
      );
      if (blankLink >= 0)
        return { field: `automation-link-${blankLink}`, reason: "writeLink" };

      /*
       * What this delivery really SENDS, counted the way the instance counts it
       * (`message_without_content`): one first message when there is a text or
       * a card, plus one for every pure link. A links-only delivery is
       * complete, and a screen that asked for a message anyway would be
       * refusing an automation the contract accepts.
       */
      const speaks =
        draft.messageText.trim() !== "" ||
        draft.cardTitle.trim() !== "" ||
        draft.buttons.length > 0;
      return speaks || draft.links.length > 0
        ? undefined
        : { field: FIELD.text, reason: "deliverSomething" };
    }
    case "rules":
      /*
       * Nothing here can be half answered any more, and that is the ruler's
       * doing (REQ-277). Both adjustments of this section are closed choices
       * with one of them always in force: a switch is on or off, and the wait
       * is one of five the contract accepts. The free field of seconds was the
       * only thing this walk ever had to find, and a field that cannot be
       * empty cannot be a fault.
       */
      return undefined;
  }
}

function firstInvalid(draft: Draft): Fault | undefined {
  for (const step of STEPS) {
    const fault = faultIn(draft, step);

    if (fault !== undefined) return fault;
  }

  return undefined;
}

/**
 * One refusal of the instance that this editor knows a FIELD for, and the
 * sentence it is said in.
 *
 * ONE sentence since REQ-312, and it used to be two. The second named the field
 * because it was read in a list at the top of the page, where nothing else said
 * which field it was about; that list is gone, because everything it held is
 * already under the control it belongs to, on a page that renders all five
 * sections at once, with the caret sent to the first of them. A sentence said
 * twice is a sentence read twice.
 *
 * What has NO rule here is not a defect and must not be given one: the schema
 * refuses documents this editor cannot produce — a duplicated step id, an
 * unsupported schema version, a shape nothing on this screen can build — and
 * those arrive from an import, from the API or from a document written by
 * hand. They keep the instance's own paragraph, in the notice, with the path
 * it named. That paragraph is the only account of the refusal anybody writing
 * from outside this screen ever gets, so this table SHORTENS what it can place
 * and takes nothing away from what it cannot.
 */
interface Placement {
  readonly code: string;
  /** A fragment of the path, for a code that reaches more than one field. */
  readonly inPath?: string;
  readonly field: string;
  /** Under the field. */
  readonly reason: RefusalReason;
  /**
   * Whether both sentences spell a ceiling.
   *
   * A refusal about a ceiling that arrives WITHOUT the number is left to the
   * instance's own paragraph rather than shortened into a sentence with a hole
   * in it: this screen holds no platform number to fill it with, and the one
   * it could invent is the default of the build rather than the ceiling the
   * installation runs.
   */
  readonly counted?: true;
}

const PLACEMENTS: readonly Placement[] = [
  // The two the shape refuses on a DRAFT, which is where they are met: the
  // walk above only runs on activation, so a draft saved with no publication
  // and no word is turned away by the instance and by nothing else.
  {
    code: "invalid_shape",
    inPath: "trigger.target",
    field: FIELD.target,
    reason: "choosePublication",
  },
  {
    code: "invalid_shape",
    inPath: "trigger.match.keywords",
    field: FIELD.keywords,
    reason: "declareWord",
  },
  // The heading of a card is written in two different places of a definition,
  // and which one it is decides which field the caret goes to: `message.title`
  // when the operator wrote a heading, and `message.text` when a text became
  // one because a button arrived (REQ-230). Ordered, so the narrower path is
  // tried before the general one.
  {
    code: "card_description_too_long",
    field: FIELD.cardDescription,
    reason: "maxChars",
    counted: true,
  },
  {
    code: "message_text_too_long",
    field: FIELD.text,
    reason: "maxBytes",
    counted: true,
  },
  {
    code: "confirmation_without_quick_reply",
    field: FIELD.confirmationQuickReply,
    reason: "writeButtonWords",
  },
  {
    code: "message_without_content",
    field: FIELD.text,
    reason: "deliverSomething",
  },
  {
    code: "email_question_without_wording",
    field: FIELD.email,
    reason: "writeQuestion",
  },
  {
    code: "follow_question_without_wording",
    field: FIELD.follow,
    reason: "writeQuestion",
  },
];

/**
 * Exported for the test, which asserts every sentence above resolves in both
 * shipped catalogues. The table is a `Record` and is not visible to the walker
 * in `catalogue.test.ts`, which reads the arguments of `t("...")`, so the proof
 * that a refusal still has words has to be written somewhere (REQ-174).
 */
export const REFUSAL_TEXT_KEYS: readonly string[] = [
  ...Object.values(REFUSAL_FIELD_KEYS),
];

function placementOf(issue: DefinitionIssue): Placement | undefined {
  return PLACEMENTS.find(
    (placement) =>
      placement.code === issue.code &&
      (placement.inPath === undefined ||
        issue.path.includes(placement.inPath)) &&
      (placement.counted !== true || issue.limit !== undefined),
  );
}

/** One field turned away, with the words that go under it. */
interface FieldRefusal {
  readonly field: string;
  readonly message: string;
}

/**
 * How a declared word has to appear. Only the two: "any word" is not one of
 * these any more, it is the switch that says there is no word at all (REQ-265).
 */
function modeLabel(mode: KeywordMatchMode, t: (key: string) => string): string {
  switch (mode) {
    case "contains":
      return t("screens.automations.modeContains");
    case "exact":
      return t("screens.automations.modeExact");
  }
}

function refusalMessage(refusal: Refusal, t: (key: string) => string): string {
  switch (refusal.error) {
    case "invalid_definition":
      return t("screens.automations.refusalInvalidDefinition");
    case "automation_not_found":
      return t("screens.automations.refusalAutomationNotFound");
    case "publication_target_conflict":
      return t("screens.automations.refusalTargetConflict");
    case "request_failed":
      return t("screens.automations.refusalRequestFailed");
    default:
      return t("screens.automations.refusalUnknown");
  }
}

export interface AutomationFormScreenProps {
  readonly client?: AutomationsClient;
  readonly publications?: PublicationsClient;
  /** Coverage makes occupied publications unavailable in the picker (REQ-368). */
  readonly coverageClient?: PublicationAutomationCoverageClient;
  /**
   * Reads the ONE publication the automation watches, by identifier (REQ-144).
   *
   * Deliberately the narrow interface and not `PublicationsClient`: this screen
   * has no business paging or renewing the account's whole grid to find out
   * what the target it already holds looks like.
   */
  readonly finder?: PublicationFinder;
  readonly assets?: AssetsClient;
  /**
   * What the INSTANCE decides about the conversation, for the preview to draw
   * (REQ-313).
   *
   * The SAME client the Settings screen reads and writes them with, and that
   * is a rule rather than a convenience: those four values already have one
   * path out of `instance_preferences`, and a second one opened here is a
   * second thing to keep in step with the route the day it changes.
   */
  readonly instanceSettings?: ConversationClient;
  readonly automationId?: string;
}

export function AutomationFormScreen({
  client = httpAutomationsClient,
  publications = httpPublicationsClient,
  coverageClient = httpPublicationAutomationCoverageClient,
  finder = httpPublicationFinder,
  assets = httpAssetsClient,
  instanceSettings = httpConversationClient,
  automationId,
}: AutomationFormScreenProps = {}): ReactElement {
  const { t, locale } = useLocale();
  const { navigate, follow } = useNavigation();
  const editing =
    automationId ??
    new URLSearchParams(window.location.search).get("id") ??
    undefined;
  const targetFromAddress =
    new URLSearchParams(window.location.search).get(
      PUBLICATION_TARGET_PARAMETER,
    ) ?? "";
  // The entry's answer (REQ-227). It is read once, here, and the editor asks
  // the question nowhere: there is no trigger control on this screen.
  const chosenTrigger = triggerFromAddress(window.location.search);
  const [draft, setDraft] = useState<Draft>({
    ...DEFAULT_DRAFT,
    triggerType: chosenTrigger,
    target: chosenTrigger === "comment" ? targetFromAddress : "",
    scope: chosenTrigger === "direct_message" ? "global" : "publication",
  });
  /**
   * The instant the automation came into being: the identifier is derived from
   * it, and so is the heading of one whose publication carries no caption.
   *
   * Settled once, when the editor opens, and replaced by the instance's own
   * `createdAt` while editing: an identifier recomputed from "now" at every save
   * would make a second automation out of every edit.
   */
  const [createdOn] = useState(() => new Date().toISOString());
  const [storedOn, setStoredOn] = useState<string>();
  const [opened, setOpened] = useState("");
  const [phase, setPhase] = useState<
    "loading" | "ready" | "missing" | "failed" | "unauthorized"
  >(editing === undefined ? "ready" : "loading");
  const [busy, setBusy] = useState(false);
  const [assetBusy, setAssetBusy] = useState(false);
  const [picking, setPicking] = useState(false);
  /**
   * Whether the publication is still being CHOSEN (REQ-216).
   *
   * A state and not `draft.target === ""`, and the difference is the whole
   * behaviour: an operator who arrives from a publication, or opens an
   * automation that already watches one, is shown the publication itself and is
   * never asked for it again; one who is choosing keeps the grid and the
   * address field, and typing an address in must not swap the field out from
   * under the caret at the first character.
   */
  const [choosing, setChoosing] = useState(targetFromAddress.trim() === "");
  const [target, setTarget] = useState<PublicationRow>();
  const [refusal, setRefusal] = useState<Refusal>();
  // This is separate from an instance refusal: validation completed before a
  // request leaves the screen is knowledge the screen owns (REQ-361).
  const [localRefusal, setLocalRefusal] = useState(false);
  /**
   * The fields this refusal turned away, each with the words drawn under it
   * (REQ-310, REQ-311).
   *
   * Held beside `refusal` and cleared with it, and deliberately NOT cleared on
   * the next keystroke: a refusal is the answer to a save, and an answer that
   * vanishes while the operator is still reading it is an answer they cannot
   * read twice. What clears it is the next save.
   */
  const [refusedFields, setRefusedFields] = useState<readonly FieldRefusal[]>(
    [],
  );
  const [notice, setNotice] = useState<string>();
  /**
   * Where the operator asked to go while a change was pending (REQ-295).
   *
   * The address itself and not a boolean: the question is asked over every exit
   * of the interface, this screen's own and the rail's alike, and answering
   * "leave anyway" has to go where the operator was going and not to whichever
   * one the screen would have guessed.
   */
  const [leavingTo, setLeavingTo] = useState<string>();
  /**
   * The one address the guard below lets past without asking.
   *
   * A ref and not state, because it is read in the same instant it is written:
   * the guard answers inside the click that navigates, and a state set there
   * would still be the old one when the answer is given.
   *
   * Two moments write it, and both are this screen saying "I have settled this
   * already". The operator answered the question, or the draft has just been
   * written down and React has not re-rendered around the fact yet, which is
   * what happens when a NEW automation is created: `opened` is set and the
   * screen leaves for the listing in the same breath, so the comparison below
   * still reads as a pending change at the moment the address moves.
   */
  const letThrough = useRef<string | undefined>(undefined);
  const buttonSequence = useRef(1);

  useEffect(() => {
    if (editing === undefined) {
      setOpened(
        JSON.stringify({
          ...DEFAULT_DRAFT,
          triggerType: chosenTrigger,
          target: chosenTrigger === "comment" ? targetFromAddress : "",
          scope: chosenTrigger === "direct_message" ? "global" : "publication",
        }),
      );
      return;
    }
    let alive = true;
    void client
      .read(editing)
      .then((stored) => {
        if (!alive) return;
        if (stored === undefined) {
          setPhase("missing");
          return;
        }
        // An automation already stored answers the entry's question itself: the
        // trigger comes from the definition, never from the address.
        const next = draftOf(stored.definition);
        setDraft(next);
        setStoredOn(stored.createdAt);
        setOpened(JSON.stringify(next));
        // An automation that already watches a publication is not asking about
        // it: the editor opens on the publication, not on a field holding it.
        setChoosing(
          next.triggerType === "comment" &&
            next.scope === "publication" &&
            next.target.trim() === "",
        );
        setPhase("ready");
      })
      .catch((error: unknown) => {
        if (alive)
          setPhase(isUnauthorizedFailure(error) ? "unauthorized" : "failed");
      });
    return () => {
      alive = false;
    };
  }, [chosenTrigger, client, editing, targetFromAddress]);

  /**
   * The picture of the publication the automation watches (REQ-264).
   *
   * A lookup that answers nothing and a lookup that fails end the same way,
   * deliberately: an operator does not care whether the cache is empty or the
   * instance is unreachable, and the block says the same thing either way. It
   * keeps the frame, draws the "no picture" fallback in it, and blocks nothing
   * on the screen below. There is no `unauthorized` branch for that reason
   * either: the aggregate's own read already owns that verdict here, and a
   * thumbnail is not worth taking the editor away from someone.
   */
  useEffect(() => {
    const identifier = draft.target.trim();
    if (
      choosing ||
      draft.triggerType !== "comment" ||
      draft.scope !== "publication" ||
      identifier === ""
    ) {
      setTarget(undefined);
      return;
    }
    let alive = true;
    void finder
      .byIds([identifier])
      .then((found) => {
        if (!alive) return;
        setTarget(found.items.find((item) => item.id === identifier));
      })
      .catch(() => {
        if (alive) setTarget(undefined);
      });
    return () => {
      alive = false;
    };
  }, [choosing, draft.scope, draft.target, draft.triggerType, finder]);

  /**
   * What the instance decides about the conversation, so the preview can draw
   * what is CONFIGURED instead of what the catalogue ships (REQ-313).
   *
   * Read once, when the editor opens, and never written from here: this screen
   * shows those values and does not own them, and the one place they are
   * changed is Settings, which section 3 names and which the rail reaches.
   *
   * A read that fails leaves them undefined and blocks nothing, exactly like
   * the thumbnail above: the operator is editing an automation, and an
   * unreachable preference is not worth taking the editor away from them. What
   * the preview does with the absence is the requirement, and it is stated
   * where the words are drawn: it says nothing rather than saying the default.
   */
  const [instance, setInstance] = useState<ConversationSettings>();

  useEffect(() => {
    let alive = true;
    void instanceSettings
      .read()
      .then((settings) => {
        if (alive) setInstance(settings);
      })
      .catch(() => {
        if (alive) setInstance(undefined);
      });
    return () => {
      alive = false;
    };
  }, [instanceSettings]);

  /**
   * The identity the aggregate is written with (REQ-228): derived from what the
   * automation listens to and from when it was created, and from nothing anyone
   * typed. There is no name field on this screen, and this is the only place an
   * `id` comes from.
   */
  const derived: Derived = {
    id: derivedAutomationId(draft.triggerType, storedOn ?? createdOn),
  };

  /**
   * What the heading calls this automation, composed HERE, stored nowhere
   * (REQ-279) and WITHOUT the publication's caption (REQ-296).
   *
   * The caption used to travel in, so that this heading and the listing said
   * the same sentence about the same automation. What that overlooked is the
   * difference between the two containers: on the card the name is clamped to
   * two lines, and a heading has no ceiling at all. A real caption is a
   * paragraph followed by eighteen hashtags, so opening the editor produced a
   * title the height of the window and pushed every field of the form below the
   * fold: the operator arrived to edit an automation and could see no control.
   *
   * Nothing takes its place, because nothing has to. The publication's own
   * picture is drawn in section 1, a finger's width below this line, and it
   * answers "which post is this" better than the first words of its text ever
   * did. What is left names the automation by what STARTS it, the trigger and
   * the day it was created, and that sentence has a length.
   */
  const shownName = derivedAutomationName(
    {
      triggerType: draft.triggerType,
      target: draft.target,
      keywords: draft.keywords,
      createdOn: storedOn ?? createdOn,
    },
    t,
    locale,
  );

  const changed = JSON.stringify(draft) !== opened;
  /**
   * The question every exit out of this screen asks (REQ-295).
   *
   * Leaving with a change nobody saved used to discard the work without a word.
   * Nothing here decides that the work is lost: `changed` is the same
   * comparison the bar reports the state with, so the screen warns exactly when
   * it says there is something to warn about.
   *
   * It is handed to the NAVIGATOR rather than wired into the controls of this
   * file, and that is what reaches the exits this screen cannot see. The way
   * back beside the two commits is drawn here (the shortcut to Settings left
   * with REQ-334 and this guard did not have to change); the rail is drawn
   * beside the screen, by the shell, and the tab
   * of the listing is the commonest way of all to abandon an editor. One guard
   * on the one function that changes the address covers every one of them, and
   * the day another exit is drawn it is covered before it is written.
   *
   * The question is the application's own dialog and not `confirm()`: the
   * browser's box carries neither of the two words the drawing names ("leave
   * anyway" and "cancel"), looks like nothing else on the screen, and stops the
   * page dead while it is open.
   */
  const askBeforeLeaving = useCallback((address: string): boolean => {
    if (letThrough.current === address) {
      letThrough.current = undefined;
      return true;
    }

    setLeavingTo(address);

    return false;
  }, []);

  // Armed only while the form is really on the screen with work in it. A draft
  // still being read is not a pending change, and it compares as one: `opened`
  // is empty until the instance answers, so a guard armed on `changed` alone
  // would ask an operator crossing a loading screen to confirm the loss of
  // something nobody has typed. The same is true of the states that draw a
  // notice instead of a form, where the only sensible move left is out.
  useExitGuard(phase === "ready" && changed ? askBeforeLeaving : undefined);

  const set = (change: Partial<Draft>): void =>
    setDraft((current) => ({ ...current, ...change }));
  /** One door for a word, whether it was typed or clicked out of a suggestion. */
  const addKeyword = (keyword: string): void =>
    setDraft((current) =>
      current.keywords.includes(keyword)
        ? current
        : { ...current, keywords: [...current.keywords, keyword] },
    );
  /**
   * How a declared word has to appear, which is asked only where words are
   * declared: the two the schema keeps for both triggers (REQ-263).
   */
  const chooseMode = (chosen: string): void =>
    set({
      mode: KEYWORD_MATCH_MODES.includes(chosen as KeywordMatchMode)
        ? (chosen as KeywordMatchMode)
        : "contains",
    });
  /**
   * The two switches of the trigger, which are ONE piece of state (REQ-265).
   *
   * "The word" and "Any word" exclude each other and one of them is always on,
   * and that is not a rule this screen invents to keep two booleans in step: it
   * is the shape of `commentMatchSchema`, whose `any` branch has no `keywords`
   * field at all (REQ-262). So there is no second boolean. The mode decides
   * which switch is on, each switch writes the mode, and "both on" is a state
   * the draft cannot hold.
   *
   * Choosing "any word" DROPS the words, and turning it back off does not bring
   * them back: the aggregate declares one side or the other and never both, so
   * words kept out of sight would be words silently written into nothing, or
   * refused at activation for a field nobody can see. Turning it off returns to
   * the default the section opens with, which is the word, contained.
   */
  const chooseAnyWord = (any: boolean): void =>
    set(any ? { mode: ANY_WORD_MODE, keywords: [] } : { mode: "contains" });
  const messageTextBytes = utf8ByteLength(draft.messageText);
  /**
   * Sends the caret to the first field a refusal named, and draws the rest.
   *
   * Focus and not a scroll (REQ-311): the operator who reached the button with
   * the keyboard goes on from the field they have to fix, and moving the caret
   * brings it into view as a side effect, while a scroll leaves the caret on
   * the button that just refused them. The FIRST is the one focused because
   * there is only one caret; every field turned away wears the border and the
   * sentence, so the others are not lost, only further down.
   */
  const refuseFields = (refused: readonly FieldRefusal[]): void => {
    setRefusedFields(refused);
    const first = refused[0];
    if (first !== undefined) document.getElementById(first.field)?.focus();
  };
  const save = async (state: "draft" | "active"): Promise<void> => {
    setRefusal(undefined);
    setLocalRefusal(false);
    setRefusedFields([]);
    setNotice(undefined);
    if (messageTextBytes > MESSAGE_TEXT_BYTES_LIMIT) {
      refuseFields([
        {
          field: FIELD.text,
          message: t("screens.automations.messageByteLimit", {
            limit: MESSAGE_TEXT_BYTES_LIMIT,
          }),
        },
      ]);
      setRefusal({ error: "invalid_definition" });
      setLocalRefusal(true);
      return;
    }
    if (state === "active") {
      const invalid = firstInvalid(draft);
      if (invalid !== undefined) {
        refuseFields([
          {
            field: invalid.field,
            message: t(REFUSAL_FIELD_KEYS[invalid.reason]),
          },
        ]);
        setRefusal({ error: "invalid_definition" });
        setLocalRefusal(true);
        return;
      }
    }
    setBusy(true);
    try {
      const result = await client.save(definitionOf(draft, state, derived, t));
      if (!result.ok) {
        setLocalRefusal(false);
        setRefusal(result.refusal);
        // Whatever the save was FOR: a draft refused by the shape is refused
        // about a field like any other, and leaving its border undrawn made
        // "nothing was written" the whole of what the operator was told.
        refuseFields(
          (result.refusal.issues ?? []).flatMap((issue) => {
            const placement = placementOf(issue);

            return placement === undefined
              ? []
              : [
                  {
                    field: placement.field,
                    // The ceiling only where there is one to spell: a
                    // placement that counts is not chosen at all without it.
                    message: t(REFUSAL_FIELD_KEYS[placement.reason], {
                      max: issue.limit,
                    }),
                  },
                ];
          }),
        );
        return;
      }
      const next = draftOf(result.stored.definition);
      setDraft(next);
      setOpened(JSON.stringify(next));
      if (result.created) {
        const listing = listingAddressAfterCreating(
          result.stored.definition.id,
        );

        // The work is written down, so the guard has nothing left to hold: it
        // is told so here because the two lines above have not been rendered
        // yet, and it would answer a question about the draft as it stood one
        // instant ago (REQ-295).
        letThrough.current = listing;
        navigate(listing);
      } else {
        setNotice(
          state === "active"
            ? t("screens.automations.activated")
            : t("screens.automations.draftSaved"),
        );
      }
    } catch (error) {
      if (isUnauthorizedFailure(error)) setPhase("unauthorized");
      else setRefusal({ error: "request_failed" });
    } finally {
      setBusy(false);
    }
  };

  /**
   * The common words offered beside the field, minus the ones already there.
   *
   * They arrive from the catalogue as one sentence and are split here: which
   * words a person types under a post is a fact about a LANGUAGE, so the list
   * is translated rather than transliterated, and no word of it lives in this
   * file.
   */
  const suggestions = useMemo(
    () =>
      t("screens.automations.keywordSuggestionList")
        .split(",")
        .map((word) => word.trim())
        .filter((word) => word !== "" && !draft.keywords.includes(word)),
    [draft.keywords, t],
  );

  /**
   * The conversation the preview draws, recomputed from the draft (REQ-233).
   *
   * The whole draft is the dependency and that is not laziness: every field of
   * the editor can change what the contact reads or when, so a list of the ones
   * that "matter" would be a list to keep in step with the form forever, and
   * the first entry forgotten is a preview that quietly stops reacting.
   */
  const conversation = useMemo(
    () => conversationOf(draft, t, instance),
    [draft, instance, t],
  );
  /**
   * The sentence drawn under ONE field, when the last save turned it away.
   *
   * Handed to `error`, which is the slot that already draws it in the refusal's
   * red, marks the control `aria-invalid` and joins the sentence into the
   * field's description (REQ-149, REQ-185) — including on the controls a
   * `Field` merely nests, which it clones. Nothing here draws a border or a
   * colour of its own: a second way of saying "refused" is a second thing to
   * keep in step with the first.
   */
  const refusalOf = (field: string): string | undefined =>
    refusedFields.find((refused) => refused.field === field)?.message;
  /**
   * The FORM of the delivery, said under the section that composes it
   * (REQ-283).
   *
   * The delivery and not the whole thread, which is the change of subject the
   * requirement asks for: the questions that open the conversation are a
   * section of their own, and what this sentence answers is "what did the parts
   * I just added become".
   */
  const deliveryShape = useMemo(() => deliveryShapeOf(draft, t), [draft, t]);

  /**
   * What each section is NUMBERED, counted over the sections really drawn.
   *
   * A direct message automation has no public reply — there is no comment to
   * answer — so the numbers are not constants: written into the catalogue as
   * "3. Open the conversation" they were, and that entrance read 1, 3, 4, 5,
   * which says a step is missing rather than that one never applied.
   */
  const steps = {
    opening: draft.triggerType === "comment" ? 3 : 2,
    delivery: draft.triggerType === "comment" ? 4 : 3,
    rules: draft.triggerType === "comment" ? 5 : 4,
  };

  /**
   * The words that start the automation, and how one has to appear.
   *
   * One element and two places, because it is the same question in both: a
   * comment trigger asks it INSIDE the switch that says the words are what
   * decides (REQ-265), and a direct message asks it plainly, having no second
   * way to fire at all (REQ-263).
   */
  const words = (
    <div className="mc-stack">
      <Field
        id={FIELD.keywords}
        label={t("screens.automations.fieldKeywords")}
        tip={t("screens.automations.fieldKeywordsTip")}
        error={refusalOf(FIELD.keywords)}
      >
        <KeywordField
          id={FIELD.keywords}
          keywords={draft.keywords}
          placeholder={t("screens.automations.keywordsPlaceholder")}
          removeLabel={(keyword) =>
            t("screens.automations.keywordRemove", { keyword })
          }
          onAdd={addKeyword}
          onRemove={(keyword) =>
            set({
              keywords: draft.keywords.filter((value) => value !== keyword),
            })
          }
        />
      </Field>
      {/* The words nobody thinks of on an empty field, one click from being
        one (REQ-233). Already-added words leave the list: a suggestion that
        does nothing is a control that lies. */}
      {suggestions.length === 0 ? null : (
        <div className="mc-suggestions">
          <span className="mc-suggestions__label">
            {t("screens.automations.keywordSuggestions")}
          </span>
          {suggestions.map((word) => (
            <Button
              key={word}
              variant="ghost"
              icon="plus"
              // Drawn as an offer and not as a decision: a dashed outline that
              // closes under the pointer, beside chips that are solid because
              // they are already keywords (REQ-198 is what lets this class add
              // to the button's own).
              className="mc-suggestion"
              // The word is what is read and the sentence is what is
              // announced: "want" alone says nothing about what pressing it
              // does, and the name contains the visible word.
              aria-label={t("screens.automations.keywordAdd", {
                keyword: word,
              })}
              onClick={() => addKeyword(word)}
            >
              {word}
            </Button>
          ))}
        </div>
      )}
      {/* Asked under the words and not above them: it qualifies words that
        are already there, and a comment trigger can be firing on the
        publication alone, in which case the question is not asked at all. */}
      <ChoiceGroup
        id="automation-mode"
        legend={t("screens.automations.fieldMode")}
        tip={t("screens.automations.fieldModeTip")}
        value={draft.mode}
        options={KEYWORD_MATCH_MODES.map((mode) => ({
          value: mode,
          label: modeLabel(mode, t),
        }))}
        onChoose={chooseMode}
      />
    </div>
  );

  /**
   * Where the draft stands, in the bar, in words.
   *
   * It reports and never decides: `changed` is the very comparison that
   * disables the save button, and an automation with no identifier yet has
   * never been written at all, so there is nothing to call saved. Nothing here
   * claims a moment ("saved just now") — no clock on this screen is told when
   * the instance wrote, and a sentence about a time nobody measured is the kind
   * of furniture that goes on lying after it stops being true.
   */
  const draftState = changed
    ? t("screens.automations.stateUnsaved")
    : draft.id === ""
      ? undefined
      : t("screens.automations.stateSaved");

  /**
   * What the last refusal named that NO field on this screen answers.
   *
   * The rest is already under its control, drawn in red and pointed at by the
   * caret, so the page has nothing left to add about it; these are the ones
   * with nowhere else to be, and they decide whether the refusal is a box that
   * stays or a toast that goes (REQ-312).
   */
  const unplaced =
    refusal === undefined
      ? []
      : (refusal.issues ?? []).filter(
          (issue) => placementOf(issue) === undefined,
        );

  if (phase === "loading")
    return (
      <PendingState skeleton={3} label={t("screens.automations.loading")} />
    );
  if (phase === "unauthorized") return <SessionExpiredNotice />;
  if (phase === "missing" || phase === "failed")
    return (
      <Notice nature="error">
        {phase === "missing"
          ? t("screens.automations.notFound", { id: editing ?? "" })
          : t("screens.automations.refusalRequestFailed")}
      </Notice>
    );

  return (
    <div className="mc-page">
      <div className="mc-page__head">
        <div className="mc-page__titles">
          <h1>
            {/* The derived name and never a typed one (REQ-228). It is NOT
                word for word the sentence the listing shows: that one is the
                publication's caption, which a card clamps and a heading cannot
                (REQ-296). */}
            {editing === undefined
              ? t("screens.automations.new")
              : t("screens.automations.editTitle", {
                  name: shownName ?? t("screens.automations.untitled"),
                })}
          </h1>
          <p className="mc-page__lead">
            {t("screens.automations.narrativeLead")}
          </p>
        </div>
      </div>
      {notice === undefined ? null : (
        <Toast
          nature="success"
          message={notice}
          dismissLabel={t("toast.dismiss")}
          onDismiss={(): void => setNotice(undefined)}
        />
      )}
      {/* A refusal goes to one of two places, and which one is decided by
          whether anything in it is left OVER after the fields have taken what
          they can (REQ-312).

          Nothing left over: the account is complete under the controls, where
          it stays until they are fixed, and what the toast adds is the one
          thing the fields cannot say, which is that the save did not happen.

          Something left over: the schema refused something this editor cannot
          place (a duplicated step id, an unsupported schema version, a ceiling
          that arrived without its number), and the instance's own paragraph
          with the path it named is the ONLY account of it anybody gets. It is
          long, it is technical, and it is what somebody importing a definition,
          calling the API or writing the document by hand has to read: a text
          like that in a box that takes itself away is a message lost. So it
          stays in the page, and no toast is raised beside it, because the
          sentence the toast would carry is the paragraph's own first line. */}
      {refusal !== undefined && unplaced.length > 0 ? (
        <Notice
          nature="error"
          issues={unplaced.map((issue) => ({
            path: issue.path,
            message: issue.message,
          }))}
        >
          {localRefusal
            ? t("screens.automations.refusalCompleteFields")
            : refusalMessage(refusal, t)}
        </Notice>
      ) : null}
      {refusal !== undefined && unplaced.length === 0 ? (
        <Toast
          nature="error"
          message={
            localRefusal
              ? t("screens.automations.refusalCompleteFields")
              : refusalMessage(refusal, t)
          }
          dismissLabel={t("toast.dismiss")}
          onDismiss={(): void => setRefusal(undefined)}
        />
      ) : null}

      <form
        className="mc-editor"
        onSubmit={(event: FormEvent) => {
          event.preventDefault();
          void save("draft");
        }}
      >
        {/* The two commits of this screen, and the way out, ABOVE the work and
            still there once it is scrolled (REQ-233). They used to be at the
            foot of a page five sections long, which is where an operator finds
            them by giving up on finding them.

            It is a child of the form and not of the page, and that is what
            keeps "Save draft" a real submit: the button commits the form it
            lives in, so pressing Enter in any field of the editor still saves
            the draft. A sticky bar in the editor's own GRID would have been
            confined to its row and travelled nowhere, which is why the form is
            a column with the grid inside it. */}
        <div className="mc-editorbar">
          {/* The way out GOES somewhere, so it is a link and not a button
              (REQ-276): it is reachable with Tab, opens in another tab on the
              middle button and can be copied, which no `onClick` offers. It
              wears the button's shape because everything else in this bar does,
              and a bare underlined word here had no frame to say how big it
              was.

              The plain handler, and the pending change is held all the same
              (REQ-295): `follow` only routes the activation that would REPLACE
              this screen, and what it routes with is the navigator, which asks
              the guard. A click that opens another tab never reaches either,
              and it leaves the editor open behind it with the work still in
              it, so there is nothing to warn anybody about. */}
          {/* Where the draft stands, said rather than guessed from whether a
              button is greyed out. It reports a state the screen already holds
              and decides nothing: `changed` is the same comparison that
              disables the save. */}
          {draftState === undefined ? null : (
            <span className="mc-editorbar__state">{draftState}</span>
          )}
          <span className="mc-editorbar__actions">
            <ButtonLink
              href={AUTOMATIONS_ADDRESS}
              onClick={follow(AUTOMATIONS_ADDRESS)}
              icon="arrow-left"
              aria-label={t("screens.automations.back")}
              className="mc-editorbar__action mc-editorbar__action--back"
            >
              <span className="mc-editorbar__action-label mc-editorbar__action-label--back">
                {t("screens.automations.back")}
              </span>
            </ButtonLink>
            <Button
              type="submit"
              variant="secondary"
              pending={busy}
              disabled={
                !changed ||
                assetBusy ||
                messageTextBytes > MESSAGE_TEXT_BYTES_LIMIT
              }
              icon="file-pen"
              aria-label={t("screens.automations.saveDraft")}
              className="mc-editorbar__action mc-editorbar__action--draft"
            >
              <span className="mc-editorbar__action-label mc-editorbar__action-label--full">
                {t("screens.automations.saveDraft")}
              </span>
              <span className="mc-editorbar__action-label mc-editorbar__action-label--short">
                {t("screens.automations.saveDraftShort")}
              </span>
            </Button>
            <Button
              variant="primary"
              pending={busy}
              disabled={
                assetBusy || messageTextBytes > MESSAGE_TEXT_BYTES_LIMIT
              }
              onClick={() => void save("active")}
              icon="circle-check"
              aria-label={t("screens.automations.activate")}
              className="mc-editorbar__action mc-editorbar__action--activate"
            >
              {t("screens.automations.activate")}
            </Button>
          </span>
        </div>

        <div className="mc-automation-editor">
          <div className="mc-automation-editor__fields mc-stack">
            <Section
              id="automation-trigger"
              step={1}
              done={faultIn(draft, "trigger") === undefined}
              // Named after the moment it really is, per entrance: "when they
              // comment" is a moment an operator recognises, and it is only
              // true of one of the two entrances.
              title={t(
                draft.triggerType === "comment"
                  ? "screens.automations.whenCommentTitle"
                  : "screens.automations.whenDirectTitle",
              )}
            >
              {/* What the entry already decided, said back as the RESULT it
                promises and not as a control (REQ-227). The operator is told
                which entrance they are in; they are not asked a second time. */}
              <p className="mc-panel__note">
                {draft.triggerType === "direct_message"
                  ? t("screens.automations.startDirectOutcome")
                  : t("screens.automations.startCommentOutcome")}
              </p>
              {draft.triggerType === "comment" ? (
                <ChoiceGroup
                  id="automation-scope"
                  legend={t("screens.automations.scopeLabel")}
                  tip={t("screens.automations.scopeTip")}
                  value={draft.scope}
                  options={[
                    {
                      value: "publication",
                      label: t("screens.automations.scopePublication"),
                    },
                    {
                      value: "global",
                      label: t("screens.automations.scopeGlobal"),
                    },
                    {
                      value: "next_publication",
                      label: t("screens.automations.scopeNextPublication"),
                    },
                  ]}
                  onChoose={(scope) => {
                    const next = scope as AutomationScope["type"];
                    set({
                      scope: next,
                      ...(next === "publication" ? {} : { target: "" }),
                    });
                    setPicking(false);
                    setChoosing(next === "publication");
                  }}
                />
              ) : null}
              {draft.triggerType === "comment" &&
              draft.scope === "publication" ? (
                // Named and explained like every other option of the editor
                // (REQ-267): the picture answers "is this the right post", and
                // the two lines above it answer "what is this block for", which
                // a picture cannot. The label is not a `<label for>` because
                // what it names is a block and not one control: it is a picture
                // and a button while a publication is chosen, and a single
                // button while none is.
                <div
                  className="mc-field"
                  role="group"
                  aria-labelledby={TARGET_LABEL}
                >
                  <span className="mc-field__label" id={TARGET_LABEL}>
                    {t("screens.automations.targetLabel")}
                  </span>
                  <p className="mc-field__tip" id={TARGET_TIP}>
                    {t("screens.automations.targetTip")}
                  </p>
                  {choosing ? (
                    // Nothing chosen yet, and the grid is the ONE way in:
                    // pasting an address stopped being a feature of the product
                    // (REQ-260) and no field replaced it (REQ-264). The button
                    // carries the id a refused activation focuses, so "no
                    // publication" puts the caret on the only control that can
                    // answer it instead of dropping it on the document.
                    <div className="mc-row">
                      <Button
                        id={FIELD.target}
                        variant="secondary"
                        icon="image"
                        // The refusal FIRST, because it is the thing that
                        // changed, exactly as `Field` orders its own
                        // description.
                        aria-describedby={
                          refusalOf(FIELD.target) === undefined
                            ? TARGET_TIP
                            : `${TARGET_ERROR} ${TARGET_TIP}`
                        }
                        aria-invalid={
                          refusalOf(FIELD.target) === undefined
                            ? undefined
                            : true
                        }
                        onClick={() => setPicking(true)}
                      >
                        {t("screens.automations.chooseInGrid")}
                      </Button>
                    </div>
                  ) : (
                    <ChosenPublication
                      publication={target}
                      describedBy={TARGET_TIP}
                      onChange={() => {
                        setChoosing(true);
                        setPicking(true);
                      }}
                    />
                  )}
                  {refusalOf(FIELD.target) === undefined ? null : (
                    <p className="mc-field__error" id={TARGET_ERROR}>
                      <Icon name="circle-alert" size={ICON_SIZE.text} />
                      <span>{refusalOf(FIELD.target)}</span>
                    </p>
                  )}
                </div>
              ) : draft.triggerType === "comment" ? (
                <Notice nature="info">
                  {t(
                    draft.scope === "global"
                      ? "screens.automations.scopeGlobalNote"
                      : "screens.automations.scopeNextPublicationNote",
                  )}
                </Notice>
              ) : null}
              {/* The two ways a comment can start the automation, as two
                switches that exclude each other (REQ-265). They are one state
                and not two booleans: see `chooseAnyWord`. The words live INSIDE
                the first one, because turning it off is precisely the statement
                that there are none to declare.

                A direct message has no second way: "any word" there would be
                the whole inbox, the schema refuses it (REQ-263), and a switch
                offering what the instance refuses is a switch that lies. So
                that entrance gets the words with no switch above them. */}
              {draft.triggerType === "comment" ? (
                <>
                  <Gate
                    id={FIELD.matchWord}
                    checked={draft.mode !== ANY_WORD_MODE}
                    label={t("screens.automations.matchByWord")}
                    note={t("screens.automations.matchByWordNote")}
                    onCheck={(on) => chooseAnyWord(!on)}
                  >
                    {draft.mode === ANY_WORD_MODE ? null : words}
                  </Gate>
                  {/* The word BETWEEN the two blocks, which is what makes the
                    exclusion something an operator sees instead of something
                    they discover by pressing (REQ-272). Two switches one under
                    the other read as two independent options, and these are
                    one: turning either on turns the other off. It is real
                    text and not a drawn rule, so it is announced between the
                    two groups as well as seen between them. */}
                  <p className="mc-or">
                    <span>{t("screens.automations.matchOr")}</span>
                  </p>
                  <Gate
                    id={FIELD.matchAny}
                    checked={draft.mode === ANY_WORD_MODE}
                    label={t("screens.automations.matchAnyWord")}
                    note={t("screens.automations.anyWordNote")}
                    onCheck={chooseAnyWord}
                  >
                    {null}
                  </Gate>
                </>
              ) : (
                words
              )}
            </Section>

            {draft.triggerType === "comment" ? (
              <Section
                id="automation-reply"
                step={2}
                done={faultIn(draft, "reply") === undefined}
                title={t("screens.automations.publicReplyTitle")}
                /* The switch belongs to the SECTION and not to a line inside it:
                 "reply publicly" is the whole of what this block decides, so it
                 is decided in the heading and the body is what the answer
                 opens. Its sentence is the accessible name and the heading
                 beside it is what a sighted operator reads, which is why the
                 words are carried and clipped rather than repeated. */
                control={
                  <Checkbox
                    variant="switch"
                    labelHidden
                    id="automation-public-reply-enabled"
                    checked={draft.publicReply}
                    label={t("screens.automations.publicReplyToggle")}
                    onChange={(event) =>
                      set({ publicReply: event.target.checked })
                    }
                  />
                }
              >
                {draft.publicReply ? (
                  <Field
                    id={FIELD.reply}
                    label={t("screens.automations.publicReplyText")}
                    tip={t("screens.automations.publicReplyTip")}
                    /* Why a second wording is worth writing at all, under the
                       field where the answers are and announced with the box
                       that takes them (REQ-267): without this line the field
                       offers work with no reason to do it. */
                    hint={t("screens.automations.publicReplyAddTip")}
                    error={refusalOf(FIELD.reply)}
                  >
                    <PhraseField
                      id={FIELD.reply}
                      phrases={draft.publicReplyTexts}
                      placeholder={t(
                        "screens.automations.publicReplyPlaceholder",
                      )}
                      removeLabel={(wording) =>
                        t("screens.automations.publicReplyRemove", { wording })
                      }
                      onAdd={(wording) =>
                        setDraft((current) => ({
                          ...current,
                          publicReplyTexts: [
                            ...current.publicReplyTexts,
                            wording,
                          ],
                        }))
                      }
                      /* By POSITION and not by text: two runs may perfectly
                         well say the same sentence, and removing by value
                         would take the first one away while the operator
                         pressed the second. */
                      onRemove={(index) =>
                        setDraft((current) => ({
                          ...current,
                          publicReplyTexts: current.publicReplyTexts.filter(
                            (_, at) => at !== index,
                          ),
                        }))
                      }
                    />
                  </Field>
                ) : null}
              </Section>
            ) : null}

            {/* Why the section exists at all, said once and in the operator's
              terms (REQ-066): the platform refuses a link in the first message,
              so what opens the conversation is a question, and the delivery is
              the answer to it. Without the sentence these three read as
              arbitrary preferences, which is how they were read while they sat
              among the rules. */}
            <Section
              id="automation-opening"
              step={steps.opening}
              done={faultIn(draft, "opening") === undefined}
              title={t("screens.automations.openingTitle")}
              hint={t("screens.automations.openingHint")}
            >
              <p className="mc-panel__note">
                {t("screens.automations.openingWhy")}
              </p>

              {draft.triggerType === "comment" ? (
                <Gate
                  id="automation-confirmation"
                  checked={draft.confirmation}
                  label={t("screens.automations.openingConfirmation")}
                  note={t("screens.automations.openingConfirmationNote")}
                  // The one of the three the product recommends, said in the head
                  // where the decision is made rather than in a paragraph nobody
                  // reads twice: without a confirmation the delivery is a link in
                  // the first message, which is the message the platform drops.
                  hint={t("screens.automations.openingRecommended")}
                  onCheck={(checked) => set({ confirmation: checked })}
                >
                  {draft.confirmation ? (
                    <>
                      {/* The three questions below are boxes for a SENTENCE, and
                      the compact variant is the height reserved for one
                      (REQ-282). A question the operator can wrap, because the
                      platform lets it run long, and never the paragraph the
                      message box is: what is asked here fits in a line, and a
                      field the height of an essay invites an essay. */}
                      <TextArea
                        id={FIELD.confirmation}
                        name={FIELD.confirmation}
                        rows={1}
                        className="mc-textarea--compact"
                        label={t("screens.automations.confirmationQuestion")}
                        tip={t("screens.automations.confirmationQuestionTip")}
                        // What will really be sent, shown as such: the sentence
                        // the aggregate carries while nobody has written another
                        // (REQ-273), and never a placeholder, which would promise
                        // that nothing goes out.
                        value={
                          draft.confirmationText ?? t(CONFIRMATION_QUESTION)
                        }
                        error={refusalOf(FIELD.confirmation)}
                        onChange={(event) =>
                          set({ confirmationText: event.target.value })
                        }
                      />
                      <Field
                        id={FIELD.confirmationQuickReply}
                        name={FIELD.confirmationQuickReply}
                        label={t("screens.automations.confirmationQuickReply")}
                        tip={t("screens.automations.confirmationQuickReplyTip")}
                        // What the tip cannot be read off: the comparison ignores
                        // case, accents and blanks, so "ja segui" confirms and an
                        // operator who was not told would think it does not.
                        hint={t(
                          "screens.automations.confirmationQuickReplyHint",
                        )}
                        error={refusalOf(FIELD.confirmationQuickReply)}
                        // The label that would really go out, shown as such: the
                        // catalogue's own while nobody has written another
                        // (REQ-332), and never a placeholder, which would promise
                        // a button that nothing sends.
                        value={
                          draft.confirmationQuickReply ??
                          t(CONFIRMATION_QUICK_REPLY)
                        }
                        onChange={(event) =>
                          set({ confirmationQuickReply: event.target.value })
                        }
                      />
                    </>
                  ) : null}
                </Gate>
              ) : null}

              <Gate
                id="automation-email"
                checked={draft.email}
                label={t("screens.automations.openingEmail")}
                note={t("screens.automations.openingEmailNote")}
                onCheck={(checked) => set({ email: checked })}
              >
                {draft.email ? (
                  <>
                    <TextArea
                      id={FIELD.email}
                      name={FIELD.email}
                      rows={1}
                      className="mc-textarea--compact"
                      label={t("screens.automations.emailQuestion")}
                      tip={t("screens.automations.emailQuestionTip")}
                      hint={t("screens.automations.emailQuestionHint")}
                      error={refusalOf(FIELD.email)}
                      value={draft.emailText}
                      onChange={(event) =>
                        set({ emailText: event.target.value })
                      }
                    />
                  </>
                ) : null}
              </Gate>

              <Gate
                id="automation-follow"
                checked={draft.follow}
                label={t("screens.automations.openingFollow")}
                note={t("screens.automations.openingFollowNote")}
                onCheck={(checked) => set({ follow: checked })}
              >
                {draft.follow ? (
                  <>
                    <TextArea
                      id={FIELD.follow}
                      name={FIELD.follow}
                      rows={1}
                      className="mc-textarea--compact"
                      label={t("screens.automations.followQuestion")}
                      tip={t("screens.automations.followQuestionTip")}
                      error={refusalOf(FIELD.follow)}
                      value={draft.followText}
                      onChange={(event) =>
                        set({ followText: event.target.value })
                      }
                    />
                  </>
                ) : null}
              </Gate>

              {/* A MENTION, and only that (REQ-275).

                This paragraph used to carry the whole explanation: what counts
                as a question, why the first one is one of them, what happens
                when they run out. It lives in Settings now, which is where the
                values are changed and therefore where the question is actually
                asked. Repeated here it was three sentences across the path of
                somebody who only wanted to switch a request on, and two places
                that could come to say different things about one number.

                The mention is ALL of it: this editor carries no button that
                opens Settings (REQ-334). One stood under this line and was
                taken out by the operator's own decision, which reversed the
                one that had put it there. What is left says where the two
                values live, which is the half REQ-275 asks for, and the way
                there is the rail the shell draws beside every screen. */}
              <p className="mc-panel__note">
                {t("screens.automations.openingSettings")}
              </p>
            </Section>

            {/* The private message, as PARTS (REQ-229).

              There is no "format" here any more, and its absence is the point:
              a message, and three things that can be added to it. What the
              combination BECOMES is never asked — it is read off the parts, and
              said back at the foot of the section, which names the messages
              they produce in the order they land (REQ-283). */}
            <Section
              id="automation-dm"
              step={steps.delivery}
              done={faultIn(draft, "delivery") === undefined}
              title={t("screens.automations.privateMessageTitle")}
              hint={t("screens.automations.deliveryHint")}
            >
              {draft.buttons.length === 0 ? (
                // The message on its own: one text field, labelled once. It used
                // to be a `Field` wrapping a `TextArea`, and both of them drew a
                // label for the same control, so the word "Message" appeared
                // twice on the screen and was announced twice.
                <TextArea
                  id={FIELD.text}
                  label={t("screens.automations.messageBody")}
                  tip={t("screens.automations.messageBodyTip")}
                  hint={
                    messageTextBytes > MESSAGE_TEXT_BYTES_LIMIT
                      ? t("screens.automations.messageBytesOverLimit", {
                          over: messageTextBytes - MESSAGE_TEXT_BYTES_LIMIT,
                          limit: MESSAGE_TEXT_BYTES_LIMIT,
                        })
                      : t("screens.automations.messageBytesRemaining", {
                          remaining:
                            MESSAGE_TEXT_BYTES_LIMIT - messageTextBytes,
                          limit: MESSAGE_TEXT_BYTES_LIMIT,
                        })
                  }
                  rows={4}
                  error={
                    messageTextBytes > MESSAGE_TEXT_BYTES_LIMIT
                      ? t("screens.automations.messageByteLimit", {
                          limit: MESSAGE_TEXT_BYTES_LIMIT,
                        })
                      : refusalOf(FIELD.text)
                  }
                  value={draft.messageText}
                  onChange={(event) => set({ messageText: event.target.value })}
                />
              ) : null}

              {/* The parts, in the order they LAND (REQ-286, REQ-288): the card
                first, because it is the message itself, and the pure links
                after it, because each of them is a message that follows. The
                list is the order, so nothing here sorts and nothing chooses. */}
              <div className="mc-parts">
                {draft.buttons.length === 0 ? null : (
                  // With a button the message IS a card, so it is drawn as one:
                  // enclosed, named, with the ceilings of the template on the
                  // two fields it really has and the buttons inside it rather
                  // than floating under the section (REQ-230).
                  <div
                    className="mc-card-editor mc-card-editor--card"
                    role="group"
                    aria-labelledby="automation-card-block"
                  >
                    <span className="mc-card-editor__head">
                      <span
                        className="mc-card-editor__title"
                        id="automation-card-block"
                      >
                        {t("screens.automations.cardBlock")}
                      </span>
                      <span className="mc-card-editor__count">
                        {t("screens.automations.cardBlockNote")}
                      </span>
                    </span>
                    <p className="mc-panel__note">
                      {t("screens.automations.cardWhy")}
                    </p>
                    {draft.image === undefined ? null : (
                      <AssetPicker
                        id={FIELD.image}
                        label={t("screens.automations.cardImage")}
                        hint={t("screens.automations.imageHint")}
                        value={draft.image === "" ? undefined : draft.image}
                        optional
                        client={assets}
                        t={t}
                        disabled={busy}
                        onBusy={setAssetBusy}
                        onChange={(image) => set({ image: image ?? "" })}
                        // Taking the cover away is the SAME gesture as removing
                        // the file, so it is the control's own button and not a
                        // second one under it: two removals side by side left
                        // the operator deciding which of them meant what.
                        onRemove={() => set({ image: undefined })}
                        accept="image"
                      />
                    )}
                    <Field
                      id={FIELD.cardTitle}
                      name={FIELD.cardTitle}
                      label={t("screens.automations.cardTitle")}
                      tip={t("screens.automations.cardTitleTip")}
                      optional
                      optionalLabel={t("screens.automations.optionalLabel")}
                      // Visible AND enforced while typing: the ceiling is the
                      // template's, and a heading refused at activation for a
                      // length nobody was shown is a silence in another costume.
                      hint={t("screens.automations.cardLimit", {
                        limit: CARD_TEXT_LIMIT,
                      })}
                      advice={cardTitleAdvice(draft.cardTitle, t)}
                      error={refusalOf(FIELD.cardTitle)}
                      value={draft.cardTitle}
                      onChange={(event) =>
                        set({ cardTitle: event.target.value })
                      }
                    />
                    <Field
                      id={FIELD.cardDescription}
                      name={FIELD.cardDescription}
                      label={t("screens.automations.cardDescription")}
                      tip={t("screens.automations.cardDescriptionTip")}
                      optional
                      optionalLabel={t("screens.automations.optionalLabel")}
                      hint={t("screens.automations.cardLimit", {
                        limit: CARD_TEXT_LIMIT,
                      })}
                      maxLength={CARD_TEXT_LIMIT}
                      error={refusalOf(FIELD.cardDescription)}
                      value={draft.cardDescription}
                      onChange={(event) =>
                        set({ cardDescription: event.target.value })
                      }
                    />
                    {draft.buttons.map((button, index) => (
                      <div className="mc-button-editor" key={button.id}>
                        <Field
                          id={`automation-button-${index}-label`}
                          name={`automation-button-${index}-label`}
                          label={t("screens.automations.buttonLabel", {
                            number: index + 1,
                          })}
                          tip={t("screens.automations.buttonLabelTip")}
                          error={refusalOf(`automation-button-${index}-label`)}
                          value={button.label}
                          onChange={(event) =>
                            setDraft((current) => ({
                              ...current,
                              buttons: current.buttons.map((item) =>
                                item.id === button.id
                                  ? { ...item, label: event.target.value }
                                  : item,
                              ),
                            }))
                          }
                        />
                        {/* The destination is a CHOICE and not two fields
                          competing (REQ-289). The format's button opens exactly
                          one thing, so asking which one is what keeps the
                          editor from writing a button that is filled in
                          correctly and refused at activation. */}
                        <ChoiceGroup
                          id={`automation-button-${index}-dest`}
                          legend={t("screens.automations.buttonDestination", {
                            number: index + 1,
                          })}
                          tip={t("screens.automations.buttonDestinationTip")}
                          value={button.dest}
                          options={[
                            {
                              value: "url",
                              label: t(
                                "screens.automations.buttonDestinationLink",
                              ),
                            },
                            {
                              value: "asset",
                              label: t(
                                "screens.automations.buttonDestinationFile",
                              ),
                            },
                          ]}
                          onChoose={(dest) =>
                            setDraft((current) => ({
                              ...current,
                              buttons: current.buttons.map((item) =>
                                item.id === button.id
                                  ? {
                                      ...item,
                                      dest: dest === "asset" ? "asset" : "url",
                                    }
                                  : item,
                              ),
                            }))
                          }
                        />
                        {button.dest === "url" ? (
                          <Field
                            id={`automation-button-${index}-url`}
                            name={`automation-button-${index}-url`}
                            type="url"
                            label={t("screens.automations.buttonUrl", {
                              number: index + 1,
                            })}
                            tip={t("screens.automations.buttonUrlTip")}
                            // The scheme the contract demands, shown where it
                            // is typed: an address refused at activation for a
                            // prefix nobody was asked for is a silence in
                            // another costume.
                            placeholder={t(
                              "screens.automations.urlPlaceholder",
                            )}
                            error={refusalOf(`automation-button-${index}-url`)}
                            value={button.url}
                            onChange={(event) =>
                              setDraft((current) => ({
                                ...current,
                                buttons: current.buttons.map((item) =>
                                  item.id === button.id
                                    ? { ...item, url: event.target.value }
                                    : item,
                                ),
                              }))
                            }
                          />
                        ) : (
                          // Either of the two, because the label promises both:
                          // this is the one control on the screen that takes a
                          // document AND a picture (REQ-289).
                          <AssetPicker
                            id={`automation-button-${index}-asset`}
                            label={t("screens.automations.buttonAsset", {
                              number: index + 1,
                            })}
                            hint={t("screens.automations.buttonAssetHint")}
                            value={
                              button.asset === "" ? undefined : button.asset
                            }
                            optional={false}
                            client={assets}
                            t={t}
                            disabled={busy}
                            onBusy={setAssetBusy}
                            onChange={(asset) =>
                              setDraft((current) => ({
                                ...current,
                                buttons: current.buttons.map((item) =>
                                  item.id === button.id
                                    ? { ...item, asset: asset ?? "" }
                                    : item,
                                ),
                              }))
                            }
                            accept="any"
                          />
                        )}
                        <Button
                          variant="removal"
                          onClick={() =>
                            setDraft((current) => ({
                              ...current,
                              ...withoutButton(current, button.id),
                            }))
                          }
                        >
                          {t("screens.automations.buttonRemove", {
                            number: index + 1,
                          })}
                        </Button>
                      </div>
                    ))}
                  </div>
                )}

                {draft.links.length === 0 ? null : (
                  /* The pure links, as the messages they are (REQ-286): a block
                    of their own, after the card, because that is where they
                    land. Each one is an address and nothing else, so the row
                    holds one field and the removal beside it. */
                  <div
                    className="mc-card-editor"
                    role="group"
                    aria-labelledby="automation-links-block"
                  >
                    <span className="mc-card-editor__head">
                      <span
                        className="mc-card-editor__title"
                        id="automation-links-block"
                      >
                        {t("screens.automations.linksBlock")}
                      </span>
                      <span className="mc-card-editor__count">
                        {t("screens.automations.linksBlockCount", {
                          count: draft.links.length,
                        })}
                      </span>
                    </span>
                    <p className="mc-panel__note">
                      {t("screens.automations.linksWhy")}
                    </p>
                    {draft.links.map((link, index) => (
                      <div
                        className="mc-link-row"
                        // The format holds a pure link as a bare address, so
                        // there is no id to key on and inventing one would be
                        // inventing a field the aggregate cannot carry.
                        key={`link-${index}`}
                      >
                        <Field
                          id={`automation-link-${index}`}
                          name={`automation-link-${index}`}
                          type="url"
                          label={t("screens.automations.linkAddress", {
                            number: index + 1,
                          })}
                          tip={t("screens.automations.linkAddressTip")}
                          placeholder={t("screens.automations.urlPlaceholder")}
                          error={refusalOf(`automation-link-${index}`)}
                          value={link}
                          onChange={(event) =>
                            setDraft((current) => ({
                              ...current,
                              links: current.links.map((item, position) =>
                                position === index ? event.target.value : item,
                              ),
                            }))
                          }
                        />
                        <Button
                          variant="removal"
                          onClick={() =>
                            setDraft((current) => ({
                              ...current,
                              links: current.links.filter(
                                (_, position) => position !== index,
                              ),
                            }))
                          }
                        >
                          {t("screens.automations.linkRemove", {
                            number: index + 1,
                          })}
                        </Button>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* What can be ADDED, in one row and always in the same place,
                so the section reads as one message being built rather than as
                formats being chosen between. THREE of them since REQ-287: a
                pure link and a card button are different deliveries, and while
                one control produced both neither could be offered as itself. */}
              <div className="mc-row">
                <Button
                  id={FIELD.addLink}
                  variant="secondary"
                  icon="link"
                  disabled={draft.links.length >= PURE_LINK_LIMIT}
                  onClick={() =>
                    setDraft((current) => ({
                      ...current,
                      links: [...current.links, ""],
                    }))
                  }
                >
                  {t("screens.automations.addLink")}
                </Button>
                <Button
                  id={FIELD.addButton}
                  variant="secondary"
                  icon="plus"
                  disabled={draft.buttons.length >= CARD_BUTTON_LIMIT}
                  onClick={() => {
                    setDraft((current) => {
                      let id: string;
                      do {
                        id = `button-${buttonSequence.current++}`;
                      } while (
                        current.buttons.some((button) => button.id === id)
                      );
                      return {
                        ...current,
                        ...withButton(current, {
                          id,
                          label: "",
                          // The address, because it is the form that needs no
                          // upload: an operator who wanted the other one is one
                          // tap away, and one who wanted this one is already
                          // typing.
                          dest: "url",
                          url: "",
                          asset: "",
                        }),
                      };
                    });
                  }}
                >
                  {t("screens.automations.addButton")}
                </Button>
                <Button
                  id={FIELD.addCover}
                  variant="secondary"
                  icon="image"
                  // REQ-232, REQ-287: the cover belongs to the card, and there
                  // is no card without a BUTTON. Offered and refused rather
                  // than hidden, with the reason beside it: a control that
                  // appears and disappears teaches nothing about why.
                  disabled={
                    draft.buttons.length === 0 || draft.image !== undefined
                  }
                  aria-describedby={
                    draft.buttons.length === 0
                      ? "automation-cover-why"
                      : undefined
                  }
                  onClick={() => set({ image: "" })}
                >
                  {t("screens.automations.addCover")}
                </Button>
              </div>
              {/* What each of the three DOES to the message, said once under
                the row instead of three times inside it (REQ-267): the three
                are one decision about the shape of what goes out. */}
              <p className="mc-field__tip">
                {t("screens.automations.addPartsTip")}
              </p>
              {draft.buttons.length === 0 ? (
                <p className="mc-panel__note" id="automation-cover-why">
                  {t("screens.automations.coverNeedsButton")}
                </p>
              ) : (
                <p className="mc-panel__note">
                  {t("screens.automations.buttonLimit", {
                    count: draft.buttons.length,
                    limit: CARD_BUTTON_LIMIT,
                  })}
                </p>
              )}
              {/* Two ceilings and not one, because they count different things
                (REQ-287, REQ-288): three buttons is what ONE card element
                carries, three links is three extra messages, which is where a
                delivery stops being a delivery and becomes a burst. */}
              {draft.links.length === 0 ? null : (
                <p className="mc-panel__note">
                  {t("screens.automations.linkLimit", {
                    count: draft.links.length,
                    limit: PURE_LINK_LIMIT,
                  })}
                </p>
              )}
              {/* The parts, said back as the messages they became (REQ-283).
                Last in the section and not over the preview, because it is the
                answer to what was just built here: the handset beside it shows
                the same delivery, and what a drawing cannot say is which of
                those bubbles is a card and which is the file behind it. */}
              <p className="mc-delivery-shape">{deliveryShape}</p>
            </Section>

            <Section
              id="automation-rules"
              step={steps.rules}
              done={faultIn(draft, "rules") === undefined}
              title={t("screens.automations.optionalRulesTitle")}
              hint={t("screens.automations.optionalRulesHint")}
            >
              <Rule
                checked={draft.once}
                id="automation-once"
                label={t("screens.automations.fieldOnce")}
                // The mark is spent at the DELIVERY and not at the trigger
                // (REQ-240), so the sentence is about receiving: an automation
                // that only replies on the comment is not limited by this at
                // all, and one that said "fires once" would be describing a
                // rule this product stopped having.
                note={t("screens.automations.fieldOnceNote")}
                onCheck={(checked) => set({ once: checked })}
              >
                {null}
              </Rule>
              {/* The wait, as the ONE adjustment it is (REQ-277).

                A closed ruler and not a number to invent: what is being chosen
                here is "do not answer in the same second", and every useful
                answer to that is one of these five. A free field invited 3600,
                which is not a politeness but an abandoned contact.

                The five come from the CONTRACT (`FIRST_REPLY_DELAY_CHOICES`)
                and are never retyped here. A sixth box written on this screen
                would offer a value the schema refuses at the save, and a value
                dropped from the contract would go on being offered. */}
              <ChoiceGroup
                id={FIRST_REPLY_DELAY}
                legend={t("screens.automations.firstReplyDelay")}
                // The sentence REQ-277 asks for by name: the pause is the
                // FIRST reply's and nothing else's, and what does not wait is
                // named rather than left to be inferred.
                tip={t("screens.automations.firstReplyDelayTip")}
                value={String(draft.firstReplyDelaySeconds)}
                options={FIRST_REPLY_DELAY_CHOICES.map((seconds) => ({
                  value: String(seconds),
                  label: waitChoiceLabel(seconds, t),
                }))}
                hint={
                  <>
                    {t("screens.automations.firstReplyDelayReason")}
                    {/* The choice restated in words, under the reason, exactly
                      as the deadline is restated in Settings: "5s" is a length,
                      and what the operator decided is which messages wait. */}
                    <span className="mc-echo">
                      {waitEcho(draft.firstReplyDelaySeconds, t)}
                    </span>
                  </>
                }
                onChoose={(chosen) =>
                  set({ firstReplyDelaySeconds: offeredWait(Number(chosen)) })
                }
              />
              {/* A box about the OTHER two waits of this product used to sit
                here, and it is gone (REQ-297): the operator asked for it twice,
                first to be laid flat and then to be taken out. It explained a
                pause between a message and its attachment, and the attachment
                left the product with REQ-284, so what was left was a paragraph
                of furniture explaining a thing that no longer happens. The
                choice above says what it decides in its own words, and the
                deadline in hours is explained where it is set, in Settings. */}
              {/* The three questions that OPEN the conversation used to sit here,
                as switches among the adjustments. They carry a wording the
                operator writes and they change the order of what the contact
                receives, so they are a section of their own now: what is left
                here is what really is an adjustment.

                "Save a contact detail" used to sit here too, and left the
                product with REQ-258: it wrote a value under a name the operator
                invented, and nothing in this product ever read it back. What
                DOES read an attribute is the e-mail the run collects, which is
                written by `collect_email` and not by anybody typing a name. */}
            </Section>
          </div>

          {/* The preview, which is the part of this screen that teaches with no
            explanation at all: the conversation as the person receives it, on
            the thing they read it on. It DESCRIBES and never operates, so
            nothing inside it is focusable — a card button here is a picture of
            a button, and a preview one can tab into is a second copy of the
            editor that does nothing. */}
          <aside
            className="mc-automation-preview"
            aria-labelledby="automation-preview-title"
          >
            <h2
              className="mc-automation-preview__title"
              id="automation-preview-title"
            >
              {t("screens.automations.previewTitle")}
            </h2>
            <div className="mc-phone">
              {/* The handset itself carries no information: it is the context
                that makes a thread read as messages rather than as paragraphs,
                and there is nothing in it for a screen reader to walk. */}
              <span className="mc-phone__bar" aria-hidden="true">
                <span>{t("screens.automations.previewClock")}</span>
                <span className="mc-phone__signal">
                  <span />
                  <span />
                  <span />
                </span>
              </span>
              <ol
                className="mc-phone__thread"
                aria-label={t("screens.automations.previewConversation")}
              >
                {conversation.map((line) => (
                  <li
                    key={line.id}
                    className={[
                      "mc-msg",
                      line.from === "contact"
                        ? "mc-msg--theirs"
                        : "mc-msg--mine",
                    ].join(" ")}
                  >
                    {/* Where the conversation has got to, over the first message
                      of each stretch. It is drawn INSIDE the message it opens
                      rather than as a row of its own, so the thread stays one
                      list of messages: a preview whose items are sometimes a
                      heading and sometimes a bubble is no longer a thread of
                      messages at all. */}
                    {line.step === undefined ? null : (
                      <span className="mc-msg__step">{line.step}</span>
                    )}
                    <span className="mc-msg__who">{speakerLabel(line, t)}</span>
                    {/* Which of the delivery's messages this is, when what was
                      written became more than one (REQ-286). Over the bubble,
                      because it is a caption on the thing about to be read. */}
                    {line.ordinal === undefined ? null : (
                      <span className="mc-msg__count">
                        {t("screens.automations.previewMessageCount", {
                          number: line.ordinal.number,
                          total: line.ordinal.total,
                        })}
                      </span>
                    )}
                    <div className="mc-msg__bubble">
                      {line.card === true ? (
                        <PreviewQuestionCard
                          question={line.text ?? ""}
                          button={line.quickReply}
                        />
                      ) : line.delivery === undefined ? (
                        <p>{line.text}</p>
                      ) : line.delivery === "link" ? (
                        <PreviewLink url={line.link ?? ""} />
                      ) : (
                        <PreviewDelivery draft={draft} />
                      )}
                      {/* The button, when it is NOT carried by a card: a
                        question drawn as a card has its button as a strip
                        across the card's foot, which is where the template
                        really puts it, and a chip under it as well would be
                        two drawings of one button. */}
                      {line.card === true ||
                      line.quickReply === undefined ? null : (
                        <Chip tone="accent">{line.quickReply}</Chip>
                      )}
                    </div>
                  </li>
                ))}
              </ol>
            </div>
            {/* What the handset shows, and what it deliberately does not
              (REQ-271). An absence nobody explains reads as a defect: the
              operator who wrote a public reply and cannot find it in the
              preview has to be told that the publication is not previewed
              here, and why. */}
            <p className="mc-automation-preview__legend">
              {t("screens.automations.previewLegend")}
            </p>
          </aside>
        </div>
      </form>

      {picking ? (
        <Modal
          size="lg"
          title={t("screens.automations.gridTitle")}
          lead={t("screens.automations.gridLead")}
          closeLabel={t("screens.automations.gridClose")}
          onClose={() => setPicking(false)}
        >
          <PublicationPicker
            client={publications}
            coverageClient={coverageClient}
            excludeAutomated
            selectedId={draft.target.trim() || undefined}
            onSelect={(identifier) => {
              set({ target: identifier });
              // Chosen, so the section stops asking and starts showing.
              setChoosing(false);
              setPicking(false);
            }}
          />
        </Modal>
      ) : null}

      {/* The question the way out asks while a change is pending (REQ-295).
          Destructive, because the button that ends it throws away what the
          operator wrote, and the one that does nothing is the safe one. */}
      {leavingTo === undefined ? null : (
        <ConfirmDialog
          title={t("screens.automations.leaveTitle")}
          consequence={t("screens.automations.leaveConsequence")}
          confirmLabel={t("screens.automations.leaveConfirm")}
          cancelLabel={t("screens.automations.leaveStay")}
          destructive
          onCancel={() => setLeavingTo(undefined)}
          onConfirm={() => {
            setLeavingTo(undefined);
            // The question has been answered, so the guard stands aside for
            // this one address and holds every other exit until it is asked
            // again.
            letThrough.current = leavingTo;
            navigate(leavingTo);
          }}
        />
      )}
    </div>
  );
}

/**
 * The publication the automation watches: its picture, and the way to another
 * one (REQ-264).
 *
 * The whole block, and the shortness is the specification. It used to carry the
 * caption, the kind of post, the day it went out and the seventeen digits of
 * its identifier, and the operator who approved this drawing struck all four:
 * the publication arrives already chosen, from the grid or from the entrance,
 * so nothing here is a question. What is left answers the only one there is,
 * "is this the right post", and the picture answers it faster than any line of
 * text could.
 *
 * A picture that cannot be read does not turn the block into a fault. The frame
 * stays, the fallback is drawn in it, and the automation is edited and
 * activated over the top of it: the target is held in the draft and never in
 * this component.
 */
function ChosenPublication({
  publication,
  describedBy,
  onChange,
}: {
  readonly publication?: PublicationRow;
  /** The block's tip, which describes this group and does not name it. */
  readonly describedBy?: string;
  onChange(): void;
}): ReactElement {
  const { t } = useLocale();
  // A thumbnail address the platform expired answers 404, and the publication
  // behind it is still a perfectly good target: remembered per session, because
  // a URL that failed once fails again on every keystroke of the form above.
  const [broken, setBroken] = useState(false);
  const picture = publication?.thumbnailUrl;

  return (
    <div
      className="mc-target"
      role="group"
      aria-label={t("screens.automations.targetChosen")}
      aria-describedby={describedBy}
    >
      <span className="mc-target__frame">
        {picture === undefined || broken ? (
          <span className="mc-target__missing">
            <Icon name="image-off" size={ICON_SIZE.control} />
            {t("screens.automations.targetNoPicture")}
          </span>
        ) : (
          <img
            src={picture}
            alt={t("screens.automations.targetThumbnailAlt")}
            onError={() => setBroken(true)}
          />
        )}
      </span>
      <Button
        className="mc-target__change"
        variant="secondary"
        icon="image"
        onClick={onChange}
      >
        {t("screens.automations.targetChange")}
      </Button>
    </div>
  );
}

/**
 * One numbered stretch of the editor: the step in a circle, its name, what
 * qualifies it, and — where the whole stretch is one decision — the switch that
 * turns it on, at the end of the same line.
 *
 * The circle is the part that earns the component. It says whether the section
 * still holds something incomplete, which is what turns "why will this not
 * activate" from a hunt through five panels into a glance down one column; and
 * it says it in a WORD as well as in a colour and a glyph, because a green
 * check is exactly the kind of state that is invisible to half the people who
 * need it. The badge therefore carries its own sentence ("Step 4, nothing
 * missing") as its accessible name, and it sits BESIDE the heading rather than
 * inside it: the heading names the section, and a region whose name grew a
 * status would be announced differently every time a field was typed into.
 */
function Section(props: {
  readonly id: string;
  readonly step: number;
  readonly done: boolean;
  readonly title: string;
  /** A word that qualifies the section: "optional", "before the delivery". */
  readonly hint?: string;
  /** The switch that decides the whole section, when one does. */
  readonly control?: ReactElement;
  readonly children: ReactNode;
}): ReactElement {
  const { t } = useLocale();
  const titleId = `${props.id}-title`;

  return (
    <section className="mc-panel mc-stack" aria-labelledby={titleId}>
      <div
        className={props.done ? "mc-sechead mc-sechead--done" : "mc-sechead"}
      >
        <span
          className="mc-sechead__num"
          role="img"
          aria-label={t(
            props.done
              ? "screens.automations.sectionStepDone"
              : "screens.automations.sectionStep",
            { number: props.step },
          )}
        >
          {props.done ? (
            <Icon name="check" size={ICON_SIZE.dense} />
          ) : (
            props.step
          )}
        </span>
        <h2 id={titleId}>{props.title}</h2>
        {props.hint === undefined ? null : (
          <span className="mc-hint">{props.hint}</span>
        )}
        {props.control}
      </div>
      {props.children}
    </section>
  );
}

/**
 * One exclusive choice, as options (REQ-233).
 *
 * A `<select>` hides every alternative behind the one in force, which is what
 * made the match mode unreadable: the operator could not see that "is exactly
 * the word" existed without opening a menu. Real radios show the three at once,
 * and they carry the state programmatically rather than in colour — `checked`
 * is what a screen reader announces, arrow keys walk the group, and the
 * `<fieldset>` gives all three the one question they answer.
 *
 * They are DRAWN as cards in a row, and the radio each card wraps is untouched:
 * the input is taken out of the flow and not out of the document, so the group
 * is still walked with the arrow keys, still announces `checked`, and still
 * shows a focus ring — drawn by the card, since the input can no longer draw
 * its own. Three alternatives side by side read as three alternatives; the same
 * three as a column of dots read as three unrelated lines.
 */
function ChoiceGroup({
  id,
  legend,
  tip,
  hint,
  value,
  options,
  onChoose,
}: {
  readonly id: string;
  readonly legend: string;
  /** What the choice is FOR, under the question (REQ-267). */
  readonly tip?: string;
  /**
   * What reports on the ANSWER, under the options: why the ruler opens where it
   * does, and what the choice in force means in words. Under and never over,
   * for the reason `Field` splits the same two slots: a tip is read before the
   * decision, a hint after it.
   */
  readonly hint?: ReactNode;
  readonly value: string;
  readonly options: readonly {
    readonly value: string;
    readonly label: string;
  }[];
  onChoose(value: string): void;
}): ReactElement {
  const tipId = tip === undefined ? undefined : `${id}-tip`;
  const hintId = hint === undefined ? undefined : `${id}-hint`;

  return (
    // Described and not named by the tip: the question is the group's name, and
    // a fieldset whose name grew a whole sentence is announced in full before
    // each of its options.
    <fieldset
      className="mc-choices"
      aria-describedby={
        [tipId, hintId].filter((one) => one !== undefined).join(" ") ||
        undefined
      }
    >
      <legend className="mc-choices__legend">{legend}</legend>
      {tip === undefined ? null : (
        <p className="mc-field__tip" id={tipId}>
          {tip}
        </p>
      )}
      <div className="mc-choices__options">
        {options.map((option) => (
          <label
            className="mc-choice"
            key={option.value}
            htmlFor={`${id}-${option.value}`}
          >
            <input
              className="mc-choice__input"
              type="radio"
              id={`${id}-${option.value}`}
              name={id}
              value={option.value}
              checked={value === option.value}
              onChange={() => onChoose(option.value)}
            />
            <span className="mc-choice__label">{option.label}</span>
          </label>
        ))}
      </div>
      {hint === undefined ? null : (
        // The same class the hint of a `Field` carries, because it is the same
        // slot doing the same job: a group is not a second kind of question.
        <p className="mc-field__hint" id={hintId}>
          {hint}
        </p>
      )}
    </fieldset>
  );
}

/**
 * One adjustment: what it does at the start of the line, the switch at the end
 * of it, and whatever the answer opens underneath.
 *
 * The switch reaches the end of the row so that the rules of a section line
 * their tracks up in one column and the block can be read straight down its
 * edge. The words are not repeated beside the control: the row IS the label, so
 * the whole line answers to the pointer and the accessible name has one source.
 *
 * Named by the NAME alone, exactly as `Gate` is and for the same reason: a
 * `<label>` wrapped around a control lends it all of its text, so a rule
 * carrying a sentence under its name would be announced as name-plus-sentence
 * and then have the same sentence read again as its description.
 */
function Rule(props: {
  readonly checked: boolean;
  readonly id: string;
  readonly label: string;
  /** The line under the name, saying what the rule is for (REQ-267). */
  readonly note?: string;
  readonly children: ReactElement | null;
  onCheck(value: boolean): void;
}): ReactElement {
  const titleId = `${props.id}-title`;

  return (
    <div className="mc-rule">
      <div className="mc-rule__line">
        <Checkbox
          variant="switch"
          id={props.id}
          checked={props.checked}
          label={<span id={titleId}>{props.label}</span>}
          hint={props.note}
          aria-labelledby={titleId}
          onChange={(event) => props.onCheck(event.target.checked)}
        />
      </div>
      {props.children}
    </div>
  );
}

/**
 * The wordings of a step, as removable chips, and one box that adds the next.
 *
 * The gesture of `KeywordField` (type it, Enter, an × on each), with the shape
 * a SENTENCE needs, and a sibling of it rather than a call to it (REQ-274).
 * Four things separate them, and each one is a defect if it is ignored: there a
 * comma ENDS the word being typed, which would cut "Te mandei, dá uma olhada"
 * in two; the chip is monospace, which a sentence is not; its label clips at
 * one line with an ellipsis, so half of a wording would be hidden; and the box
 * that takes the next word sits in the row with the chips, which is a row a
 * sentence does not fit in.
 *
 * What the two really share is the CHIP, so the × is the same button, with the
 * same accessible name naming what goes and the same tap floor (REQ-268).
 *
 * The box commits on Enter and on BLUR, exactly as the keywords do: a wording
 * typed and left behind is not silently dropped when the operator saves.
 */
function PhraseField({
  id,
  phrases,
  placeholder,
  removeLabel,
  onAdd,
  onRemove,
  // The description and the refusal of the surrounding `Field` (REQ-185),
  // forwarded to the box: a signature naming only the props it knows would
  // swallow them here, leaving the refusal drawn and announced to nobody.
  ...rest
}: {
  readonly id: string;
  readonly phrases: readonly string[];
  readonly placeholder: string;
  /** Names the wording being removed, from the catalogue. */
  readonly removeLabel: (phrase: string) => string;
  onAdd(phrase: string): void;
  /** By POSITION: two wordings may be the same sentence. */
  onRemove(index: number): void;
} & Omit<
  InputHTMLAttributes<HTMLInputElement>,
  "id" | "type" | "placeholder" | "value" | "onChange" | "onKeyDown" | "onBlur"
>): ReactElement {
  const [draft, setDraft] = useState("");
  const commit = (): void => {
    const wording = draft.trim();

    if (wording !== "") onAdd(wording);
    setDraft("");
  };

  return (
    <div className="mc-phrases">
      {phrases.length === 0 ? null : (
        <div className="mc-phrases__list">
          {phrases.map((wording, index) => (
            // Keyed by position because that is what the list IS here: the
            // same sentence may be written twice, so the text is not an
            // identity, and a chip holds no state of its own to lose.
            <Chip
              key={index}
              tone="accent"
              className="mc-chip--phrase"
              onRemove={() => onRemove(index)}
              removeLabel={removeLabel(wording)}
            >
              {wording}
            </Chip>
          ))}
        </div>
      )}
      <input
        id={id}
        type="text"
        className="mc-input mc-phrases__input"
        placeholder={placeholder}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            // Enter would submit the editor, which saves the draft: here it
            // means "this wording is finished", and nothing else.
            event.preventDefault();
            commit();
          }
        }}
        onBlur={commit}
        {...rest}
      />
    </div>
  );
}

/**
 * A switch that decides a block, and whatever the decision opens under it.
 *
 * The approved drawing calls it a gate and uses it in two places: the three
 * questions that open the conversation, and the two ways a comment can start
 * the automation (REQ-265). Both are the same thing to an operator, a decision
 * with contents, so both are the same block on the screen.
 *
 * A `Rule` and this are not the same block and the difference is the point. A
 * rule is an adjustment and a checkbox says the whole of it; a gate holds
 * fields, so it is a named region, and the fields are not there at all while it
 * is off: a disabled wording field would be a question the operator can write
 * and nobody will ever be asked.
 *
 * The region takes its accessible name from the switch's own label, which is
 * what makes "Ask for confirmation" the name of the group AND the name of the
 * control that turns it on; and `checked` carries the state programmatically,
 * so nothing here is announced by position or by colour alone.
 *
 * A HEAD and a BODY, and the rule between them is not decoration: the head is
 * the decision and the body is what the decision opened, so a gate that is on
 * reads as a block with contents while the ones beside it read as one line
 * each. Turned off there is no body at all, as above.
 *
 * The class keeps the name of the first block it drew. It is the selector the
 * contrast floor of REQ-176 measures the switch track against, by name, in
 * `styles/tokens.test.ts`.
 */
function Gate(props: {
  readonly checked: boolean;
  readonly id: string;
  readonly label: string;
  /** A word beside the name: "recommended", and nothing else so far. */
  readonly hint?: string;
  /** The sentence under the name, saying what turning this on does. */
  readonly note?: string;
  readonly children: ReactElement | null;
  onCheck(value: boolean): void;
}): ReactElement {
  const titleId = `${props.id}-title`;

  return (
    <div className="mc-opening-step" role="group" aria-labelledby={titleId}>
      <div className="mc-opening-step__head">
        <Checkbox
          variant="switch"
          id={props.id}
          checked={props.checked}
          label={<span id={titleId}>{props.label}</span>}
          hint={props.note}
          // Named by the title alone. A `<label>` wrapped around a control
          // lends it ALL of its text, so a gate carrying a sentence under its
          // name would be announced as name-plus-sentence and then have the
          // same sentence read again as its description.
          aria-labelledby={titleId}
          onChange={(event) => props.onCheck(event.target.checked)}
        />
        {props.hint === undefined ? null : (
          <span className="mc-hint">{props.hint}</span>
        )}
      </div>
      {props.children === null ? null : (
        <div className="mc-opening-step__body">{props.children}</div>
      )}
    </div>
  );
}

/**
 * A QUESTION, drawn in the shape the platform really delivers it in (REQ-314).
 *
 * The confirmation used to be drawn as words in a bubble with a chip stuck
 * under it, and that is not what lands in the inbox. What lands is a generic
 * template: the words as the element's title, the button as a strip across the
 * foot. The operator approves the design by LOOKING at this preview, so a
 * preview that disagrees with the delivery turns their approval into an
 * approval of something else.
 *
 * WHICH questions arrive that way, which is the part worth reading twice,
 * because it is not "the confirmation" and it is not "the ones with buttons".
 * `toMessageBody` in `src/platform/sender.ts` sends a question with a button as
 * a generic template when the message is the PRIVATE REPLY that opens a
 * conversation from a comment, and as a plain message with native quick
 * replies when it is addressed by contact. The private reply belongs to the
 * first direct message of a comment-born run and to no other
 * (`privateReplyAvailable`, `src/runtime/outbox.ts`), so the shape follows the
 * POSITION and not the step:
 *
 *  - the confirmation is this card whenever it is asked, because this editor
 *    puts it before every other message of the run;
 *  - the request to follow is this card only when it is the first message, so
 *    with no confirmation and no e-mail question before it. Behind either of
 *    them it is a bubble with a chip, and so is every resend of it (REQ-246);
 *  - nothing in a direct message automation is ever this card, there being no
 *    comment to answer.
 *
 * Task 3o.7 drew the card unconditionally on the argument that a confirmation
 * is either the first message or suppressed. That is true of the confirmation
 * and only of it, and the request to follow, which the same argument would have
 * made a card, receives the shape from the walk instead.
 *
 * Nothing here is operable, for the reason the delivery's card below states.
 */
function PreviewQuestionCard({
  question,
  button,
}: {
  readonly question: string;
  readonly button?: string;
}): ReactElement {
  return (
    <span className="mc-preview-card">
      <span className="mc-preview-card__body">
        <strong className="mc-preview-card__title">{question}</strong>
      </span>
      {/* The strip only once the words are written. A draft may still be
        holding the field empty, and the instance refuses a confirmation with
        no button by name (`confirmation_without_quick_reply`), so an invented
        strip here would draw a card that cannot go out. */}
      {button === undefined ? null : (
        <span className="mc-preview-card__button">{button}</span>
      )}
    </span>
  );
}

/**
 * The delivery, drawn as it will go out.
 *
 * The one line of the conversation that is not a sentence: it is whatever the
 * message section holds at this instant, which is why it takes the draft rather
 * than a resolved string.
 *
 * A BUTTON is what makes it a card, here exactly as everywhere else (REQ-230,
 * REQ-287): without one the words go out as a plain message, with one they are
 * the card's heading. Nothing in the draft says "card", so nothing here asks.
 * The pure links are not drawn here at all, and their absence is the same rule
 * read from the other end: each of them is a message of its own, so each of
 * them gets a bubble of its own.
 *
 * Nothing here is operable. The card's buttons used to be real anchors with
 * their click swallowed, which is the worst of both: a screen reader announced
 * links that go nowhere, and Tab walked out of the editor into a picture. They
 * are drawn as what they are: the shape of a button the CONTACT will press.
 */
function PreviewDelivery({ draft }: { readonly draft: Draft }): ReactElement {
  const { t } = useLocale();
  const cover =
    draft.image === undefined || draft.image === "" ? undefined : draft.image;

  if (draft.buttons.length === 0)
    return (
      <p>{draft.messageText || t("screens.automations.previewMessage")}</p>
    );

  const empty =
    cover === undefined &&
    draft.cardTitle === "" &&
    draft.cardDescription === "";

  return (
    <span className="mc-preview-card">
      {cover === undefined ? null : (
        <img
          className="mc-preview-card__image"
          src={`/assets/${encodeURIComponent(cover)}`}
          alt={cover}
        />
      )}
      {/* The words of the card, in the one part of it that is padded: the
          cover fills the top edge to edge and the buttons are strips across
          the foot, exactly as the template sends them. */}
      {empty || draft.cardTitle !== "" || draft.cardDescription !== "" ? (
        <span className="mc-preview-card__body">
          {empty ? (
            <span>{t("screens.automations.previewMessage")}</span>
          ) : null}
          {draft.cardTitle === "" ? null : (
            <strong className="mc-preview-card__title">
              {draft.cardTitle}
            </strong>
          )}
          {draft.cardDescription === "" ? null : (
            <span className="mc-preview-card__text">
              {draft.cardDescription}
            </span>
          )}
        </span>
      ) : null}
      {draft.buttons.map((button) => (
        <span className="mc-preview-card__button" key={button.id}>
          {/* What the strip really says, which is the LABEL and nothing else:
              the destination is not written on a button, so falling back to it
              drew an address the contact would never see, and a button whose
              destination is a file had nothing to fall back to at all. */}
          {button.label || t("screens.automations.previewButtonUnnamed")}
        </span>
      ))}
    </span>
  );
}

/**
 * One pure link, drawn as the contact receives it (REQ-286).
 *
 * The address in a bubble of its own and, stuck to it, the card the DESTINATION
 * SITE builds out of that address. That second block is not ours and cannot be:
 * it is the whole advantage of a pure link over a button, so the preview stands
 * in for it rather than pretending it does not happen. What it shows is what
 * will be there (a picture, a title, the site's name) and never what they say,
 * because only the site knows that.
 *
 * Nothing here is operable, exactly as the card above is not: it is the shape
 * of a message, and a real anchor inside an editor is a place for Tab to fall
 * out of the form into a drawing.
 */
function PreviewLink({ url }: { readonly url: string }): ReactElement {
  const { t } = useLocale();
  // The site, as the address names it. Read off the string and never parsed
  // with `URL`: this is drawn while the operator is still typing, and a half
  // written address throws there and would take the whole preview with it.
  const host = url.replace(/^https?:\/\//i, "").split("/")[0] ?? "";

  return (
    <span className="mc-preview-link">
      <span className="mc-preview-link__url">{url}</span>
      <span className="mc-preview-link__og">
        <span className="mc-preview-link__image">
          {t("screens.automations.previewLinkThumbnail", { host })}
        </span>
        <span className="mc-preview-link__body">
          <strong className="mc-preview-link__title">
            {t("screens.automations.previewLinkTitle")}
          </strong>
          <span className="mc-preview-link__host">{host}</span>
        </span>
      </span>
    </span>
  );
}
