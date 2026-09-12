import { useEffect, useId, useRef, useState } from "react";
import type { CSSProperties, ReactElement, ReactNode } from "react";
import {
  Button,
  Checkbox,
  Chip,
  ConfirmDialog,
  Field,
  LENGTH_ADVICE_TEXT_KEYS,
  lengthAdvice,
  measureLength,
  Notice,
  PendingState,
  Select,
  StatusBadge,
  TextArea,
  Toast,
} from "../components/index.js";
import type { FieldAdvice } from "../components/index.js";
import {
  isUnauthorizedFailure,
  UNAUTHORIZED_FAILURE,
} from "../http-failure.js";
import { languageName, useLocale } from "../locale.js";
import { SessionExpiredNotice } from "../session-expired.js";
import { chooseTheme, readThemeChoice, THEME_CHOICES } from "../theme.js";
import type { ThemeChoice } from "../theme.js";
import { timeZoneOptionLabel } from "../time-zone.js";

/**
 * Settings (REQ-102, REQ-183), which is what the language selector became.
 *
 * The prototype promoted the smallest screen in the product into the place the
 * product will keep its preferences
 * (`mychat-design-system/project/ui_kits/panel/SettingsScreen.jsx`), and the
 * rail already calls the group "Settings". The address stays
 * `/settings/language`, because moving a route is not this task's to move.
 *
 * The FIRST panel holds the language and the time zone together (REQ-325).
 * They were two panels until phase 3p, and they are one decision to the person
 * reading the screen: what language it speaks and which clock it counts in.
 *
 * The language choice is a `Select` rather than one button per language. A list
 * of two buttons is a radio group written by hand, and the native control
 * already carries the value programmatically, opens with the keyboard and
 * announces the option in force with no code of ours (REQ-116). The option
 * words are NOT from the catalogue and that is deliberate: `languageName` asks
 * the platform for a language's own name, so a locale added after this file was
 * written names itself, which a catalogue of names for names could never do.
 *
 * The zone stopped being a plan with REQ-166. It became a setting of the
 * instance with REQ-153, the panel counts and labels in it, and this screen went
 * on saying "every instant is in UTC today" beside a badge reading UTC. That is
 * the defect this repository has already paid for twice, taken from the other
 * end: text that DENIES a behaviour the product has. So the zone is read from
 * the instance (`GET /api/instance`) and NAMED, and with REQ-183 it is CHOSEN
 * here too: the same road the language takes, one setting further along.
 *
 * The control is a `Select` over the list the INSTANCE answers with, and both
 * halves of that are deliberate.
 *
 * A select rather than a validated text field, although the list is long: the
 * operator knows the city they are in and not the spelling of an IANA name, so
 * a text field would make `America/Sao_Paulo` (capitals, underscore and all)
 * something they have to get right from memory, and every miss a refusal and
 * another round trip. The native control cannot produce a name that does not
 * exist, jumps by typing, walks with the arrows and announces the option in
 * force with no code of ours (REQ-116). It is also what this screen already
 * uses for the language: a second kind of control for the same kind of decision
 * would be a divergence bought for nothing.
 *
 * From the instance rather than from `Intl.supportedValuesOf` in the browser,
 * because the zone has to be one the AGGREGATION can count in, and the
 * aggregation runs in the other process. A list drawn here out of the browser's
 * own calendar data would offer names the server refuses, and the refusal would
 * arrive after the operator picked from a list we drew.
 *
 * Two failures of the zone and they are different facts: it could not be READ
 * (nothing is named, and no zone is invented in its place), or it could not be
 * STORED (the previous zone stands, in the control and on the dashboard, and
 * the notice says so). Neither is the other, and a screen that showed one for
 * both would tell the operator to retry something that already worked.
 *
 * The last panel is the THEME, and it used to be this screen's declaration of
 * what did not exist yet: a card with no control, a badge reading "follows the
 * system", and a panel titled "what does not exist yet" over it. REQ-326 gave
 * it a control, so the declaration went with the absence it declared, and the
 * sentence promising that no selector existed went with it: a text that denies
 * a behaviour the product HAS is the defect this file has already paid for
 * twice, and shipping the selector under that sentence would have been the
 * third time.
 *
 * It is a panel of its own and not a fourth control in the global block, and
 * the reason is scope. Everything in that block is a fact about the INSTANCE:
 * whichever browser signs in, it speaks that language, counts in that clock and
 * obeys those trigger switches. The theme is a fact about the MACHINE, so it is
 * stored on the machine (`src/web/theme.ts`) and never sent anywhere, and the
 * panel's note is what tells the operator that. The same note is what keeps the
 * save button at the foot of the page from looking as though it carried this
 * setting too: it applies the moment it is picked, and there is nothing to
 * save.
 *
 * Two failures, and they read as two different things. A preference that could
 * not be STORED is an `error` notice at the top: nothing changed, the instance
 * kept the previous choice, and picking again in the selector is the retry, so
 * no button repeats what the control already offers. A zone that could not be
 * READ is an `error` notice inside its own panel, and it names no zone at all:
 * a screen that fell back to UTC there would be the sentence this task removed,
 * written again by the failure path.
 *
 * ---------------------------------------------------------------------------
 * HOW THE SCREEN IS NAVIGATED, which is what REQ-327 adds.
 *
 * The page is five blocks long and, until this task, none of them was a title
 * to anything but the eye: the block names were `<span>`s, so the four ways an
 * assistive technology offers to move through a document (the heading list, the
 * region list, and the two keys that walk them) reached the screen's own name
 * and nothing else. A menu of block names is the visible half of the same fix,
 * and it is built ON the structure rather than beside it: every entry is a real
 * `<a href="#id">` pointing at the `<section>` whose `<h2>` carries that name,
 * so the pointer, the keyboard and the reader are offered ONE mechanism.
 *
 * The pattern is the dashboard's, ported rather than invented
 * (`src/web/screens/dashboard.tsx`): a block is a `section` with `mc-panel` on
 * it, labelled by its own `h2.mc-panel__title`. What is added here is the id,
 * because a region can only be linked to if it has a name in the document, and
 * `tabIndex={-1}` so the jump can land the FOCUS on the block instead of only
 * the scroll: an operator who cannot see the page move learns nothing from a
 * page that only moved.
 *
 * The ids are written out and are not `useId`. A fragment is an address: it
 * survives a reload, it can be copied to somebody else, and it is in the
 * browser's history. An id regenerated on every mount would be none of those.
 *
 * The three panels of the conversation are `h3` and NOT `h2`, which is the
 * whole of the hierarchy this screen used to lack: four blocks, and one of them
 * holds three settings of its own. That is also why the menu names four entries
 * and not seven.
 *
 * ---------------------------------------------------------------------------
 * What this screen deliberately no longer EXPLAINS (REQ-323). Eight texts were
 * taken out by the operator's own list: the lead and the "why these four live
 * here" notice of the global settings, the platform's 24 hour window, the
 * sentence about whoever is already waiting, the notice saying the count
 * includes the first question, the note about the catalogue, the long paragraph
 * under the time zone, and the two handset previews. The BEHAVIOUR of every one
 * of them is unchanged: the first question still counts, and the field's own tip
 * still says so (REQ-254). The screen simply stopped arguing its own case.
 */

/** A form reads better narrow, and every block of this screen is a form. */
const FORM_WIDTH: CSSProperties = { maxWidth: "var(--measure-form)" };

/**
 * The address of each block, and the id its heading answers to (REQ-327).
 *
 * Written out rather than generated, because a fragment is an address: it goes
 * into the browser's history, it can be copied, and it has to mean the same
 * thing on the next load. `useId` would give a different one every mount.
 *
 * Exported so the test can hold the menu against the blocks by the ONE value
 * both sides use: a link whose target went missing is a link that scrolls
 * nowhere, and nothing in a running browser says so out loud.
 */
export const SETTINGS_BLOCKS = {
  integrations: "settings-integrations",
  language: "settings-language",
  triggers: "settings-triggers",
  conversation: "settings-conversation",
  theme: "settings-theme",
} as const;

/** The heading a block is named by, derived so the two cannot drift apart. */
function headingIdOf(block: string): string {
  return `${block}-title`;
}

/**
 * One entry of the menu: the block's own name, and where it lives.
 *
 * The title is passed already resolved rather than as a key, so every `t()` of
 * this screen stays a literal call the catalogue walker can read (REQ-174).
 */
interface BlockLink {
  readonly id: string;
  readonly title: string;
}

/**
 * The menu of block titles (REQ-327).
 *
 * Real links and not buttons, and that is the requirement rather than a taste:
 * a button that scrolls is a gesture only a pointer and an Enter key know
 * about, while a link to a fragment is an address the browser already knows how
 * to reach, keep in its history, open in another tab and hand to a screen
 * reader as "link, Theme". The click handler adds the one thing the browser
 * does NOT do reliably inside a scrolling column: it puts the FOCUS on the
 * block that was asked for, so the caret and the eye arrive together.
 *
 * `preventDefault` is deliberately absent. The address of this application is
 * its PATHNAME (`src/web/navigation.tsx`), so a fragment changes no screen, and
 * the browser's own jump is what scrolls `.mc-work` for whoever has no
 * JavaScript running yet.
 */
function BlockNav(props: {
  readonly label: string;
  readonly blocks: readonly BlockLink[];
}): ReactElement {
  return (
    <nav className="mc-jump" aria-label={props.label}>
      <ul className="mc-jump__list">
        {props.blocks.map((block) => (
          <li key={block.id}>
            <a
              className="mc-jump__link"
              href={`#${block.id}`}
              onClick={(): void => {
                // The block itself and never its heading: the heading is a word,
                // the section is the region, and what a reader announces on
                // arrival is the region and its name.
                document.getElementById(block.id)?.focus();
              }}
            >
              {block.title}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}

/**
 * The word for each theme, by the answer it names (REQ-326).
 *
 * Words and not identifiers, unlike the language and the zone above: a locale
 * code names itself through `languageName` and an IANA zone IS its own name,
 * while "light" and "dark" are interface copy like any other and come from the
 * catalogue (REQ-074).
 */
const THEME_KEYS: Readonly<Record<ThemeChoice, string>> = {
  system: "settings.themeSystem",
  light: "settings.themeLight",
  dark: "settings.themeDark",
};

/**
 * Exported for the test, for the same reason `CONVERSATION_REFUSAL_TEXT_KEYS`
 * below is: the walker in `catalogue.test.ts` reads the arguments of `t("...")`
 * and a record is invisible to it, so the proof that each of the three still
 * has a word lives in a test that names them (REQ-174).
 */
export const THEME_TEXT_KEYS: readonly string[] = Object.values(THEME_KEYS);

const INSTANCE_ENDPOINT = "/api/instance";

/** What the instance answers about how it is configured (REQ-166, REQ-183). */
export interface InstanceState {
  /** An IANA identifier, `America/Sao_Paulo`. Never a sentence about it. */
  readonly timeZone: string;
  /** Every zone it can be switched to, the one in force among them. */
  readonly timeZones: readonly string[];
}

export type TriggerSwitchName = "all" | "comments" | "directMessages";

export interface TriggerSwitchState {
  readonly all: { readonly enabled: boolean; readonly updatedAt?: string };
  readonly comments: { readonly enabled: boolean; readonly updatedAt?: string };
  readonly directMessages: {
    readonly enabled: boolean;
    readonly updatedAt?: string;
  };
}

/** The two calls this screen makes on its own, so a test drives them. */
export interface InstanceClient {
  read(): Promise<InstanceState>;
  write(timeZone: string): Promise<InstanceState>;
  readTriggers?(): Promise<TriggerSwitchState>;
  writeTrigger?(
    name: TriggerSwitchName,
    enabled: boolean,
  ): Promise<TriggerSwitchState>;
}

async function instanceState<T>(response: Response): Promise<T> {
  if (!response.ok) {
    throw new Error(String(response.status));
  }

  return (await response.json()) as T;
}

/** The real client: same origin, so the session cookie travels on its own. */
export const httpInstanceClient: InstanceClient = {
  read: async (): Promise<InstanceState> =>
    instanceState<InstanceState>(await fetch(INSTANCE_ENDPOINT)),

  write: async (timeZone: string): Promise<InstanceState> =>
    instanceState<InstanceState>(
      await fetch(INSTANCE_ENDPOINT, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ timeZone }),
      }),
    ),
  readTriggers: async (): Promise<TriggerSwitchState> =>
    instanceState<TriggerSwitchState>(
      await fetch(`${INSTANCE_ENDPOINT}/triggers`),
    ),
  writeTrigger: async (
    name: TriggerSwitchName,
    enabled: boolean,
  ): Promise<TriggerSwitchState> =>
    instanceState<TriggerSwitchState>(
      await fetch(`${INSTANCE_ENDPOINT}/triggers`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, enabled }),
      }),
    ),
};

/* -------------------------------------------------------------------------- *
 * The four settings of the automatic conversation (REQ-252, REQ-254, REQ-255,
 * REQ-257).
 *
 * They are one block and one write, because they are one decision: how the
 * conversation waits, insists, says goodbye and names the button it offers.
 * They stopped being fields of a STEP when the deadline turned up three times
 * on one screen asking for three numbers nobody has any basis to tell apart,
 * and this panel is the other half of that move: without a screen the operator
 * can read the values and change none of them.
 *
 * The bounds travel WITH the values (`limits`), from the rule that owns them,
 * and nothing here carries a second copy of 168 or of 20. What refuses a value
 * is the instance, at 422, with a code and the number it broke: this screen
 * puts that number into a sentence out of the catalogue (REQ-073) and never
 * decides the refusal itself. A browser that judged the value first would be a
 * second validator, right until the day the two disagreed.
 *
 * THREE of the four can be refused. The button text cannot (REQ-306): its
 * number is where the platform stops DRAWING the label, not where it stops
 * accepting it, so the field warns with it and stores past it. The two are told
 * apart on screen and to a screen reader: a refusal marks the field invalid and
 * a prediction deliberately does not.
 * -------------------------------------------------------------------------- */

const INSTANCE_SETTINGS_ENDPOINT = `${INSTANCE_ENDPOINT}/settings`;
const INSTANCE_CONFIGURATION_ENDPOINT = `${INSTANCE_ENDPOINT}/configuration`;
/** A visible proof that a secret was stored, never a recoverable secret. */
const MASKED_SECRET_VALUE = "••••••••••••";

export interface ConfigurationState {
  readonly meta: {
    readonly configured: boolean;
    readonly appSecretConfigured: boolean;
    readonly accountId?: string;
  };
  readonly storage: {
    readonly driver: string;
    readonly configured: boolean;
    readonly endpoint?: string;
    readonly bucket?: string;
  };
  readonly publicOrigin?: string;
  readonly publicOriginVerifiedAt?: string;
  readonly webhookVerifyToken: boolean;
  readonly webhookConfirmedAt?: string;
  readonly installedVersion: string;
}
export type IntegrationHealth = "pending" | "healthy" | "failure";
type ConfigurationRemovalAction =
  | "remove_meta"
  | "remove_storage"
  | "remove_public_origin"
  | "remove_webhook_verify_token"
  | "remove_meta_app_secret";
export interface ConfigurationWriteResult {
  readonly ok: boolean;
  readonly status?: IntegrationHealth;
  readonly reason?: string;
  readonly generatedWebhookVerifyToken?: string;
}
export interface ConfigurationClient {
  read(): Promise<ConfigurationState>;
  write(change: Record<string, string>): Promise<ConfigurationWriteResult>;
}
export const httpConfigurationClient: ConfigurationClient = {
  read: async () =>
    instanceState<ConfigurationState>(
      await fetch(INSTANCE_CONFIGURATION_ENDPOINT),
    ),
  write: async (change): Promise<ConfigurationWriteResult> =>
    instanceState<ConfigurationWriteResult>(
      await fetch(INSTANCE_CONFIGURATION_ENDPOINT, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(change),
      }),
    ),
};

export interface IntegrationState {
  readonly meta: {
    readonly status: IntegrationHealth;
    readonly reason?: string;
  };
  readonly storage: {
    readonly driver: string;
    readonly status: IntegrationHealth;
    readonly reason?: string;
  };
}
export interface IntegrationClient {
  read(): Promise<IntegrationState>;
}
export const httpIntegrationClient: IntegrationClient = {
  read: async (): Promise<IntegrationState> =>
    instanceState<IntegrationState>(
      await fetch(`${INSTANCE_ENDPOINT}/integrations`),
    ),
};

const INTEGRATION_HEALTH_TEXT_KEYS: Readonly<
  Record<IntegrationHealth, { readonly meta: string; readonly storage: string }>
> = {
  pending: {
    meta: "settings.metaHealthPending",
    storage: "settings.storageHealthPending",
  },
  healthy: {
    meta: "settings.metaHealthHealthy",
    storage: "settings.storageHealthHealthy",
  },
  failure: {
    meta: "settings.metaHealthFailure",
    storage: "settings.storageHealthFailure",
  },
};

const INTEGRATION_HEALTH_BADGE_STATES = {
  pending: "info",
  healthy: "active",
  failure: "critical",
} as const;

/** What a value is allowed to be, as the instance declares it. */
export interface ConversationLimits {
  readonly waitHoursMin: number;
  readonly waitHoursMax: number;
  readonly questionsMin: number;
  readonly followButtonLabelChars: number;
}

/** The four values in force, and the bounds they live between. */
export interface ConversationSettings {
  readonly waitHours: number;
  readonly questions: number;
  readonly closingMessage: string;
  readonly followButtonLabel: string;
  readonly limits: ConversationLimits;
}

/** What one write carries: the four together, refused or stored as a whole. */
export interface ConversationChange {
  readonly waitHours: number;
  readonly questions: number;
  readonly closingMessage: string;
  readonly followButtonLabel: string;
}

/** A refusal as the route answers it: a stable code, and the bound it broke. */
export interface ConversationRefusal {
  readonly error: string;
  readonly limit?: number;
}

export type ConversationWrite =
  | { readonly ok: true; readonly settings: ConversationSettings }
  | { readonly ok: false; readonly refusal: ConversationRefusal };

/** The two calls this panel makes, so a test drives them with a double. */
export interface ConversationClient {
  read(): Promise<ConversationSettings>;
  write(change: ConversationChange): Promise<ConversationWrite>;
}

/**
 * The refused body, or the bare status when there is none.
 *
 * A refusal that could not be read still has to reach the operator as a
 * refusal: a write that answered 500 with an HTML error page must not look like
 * a write that succeeded.
 */
async function conversationRefusalOf(
  response: Response,
): Promise<ConversationRefusal> {
  try {
    return (await response.json()) as ConversationRefusal;
  } catch {
    return { error: String(response.status) };
  }
}

export const httpConversationClient: ConversationClient = {
  read: async (): Promise<ConversationSettings> =>
    instanceState<ConversationSettings>(
      await fetch(INSTANCE_SETTINGS_ENDPOINT),
    ),

  write: async (change: ConversationChange): Promise<ConversationWrite> => {
    const response = await fetch(INSTANCE_SETTINGS_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(change),
    });

    if (!response.ok) {
      // 401 travels as a throw, like every other private read of this screen,
      // so an expired session is told apart from a value the domain refused.
      if (response.status === Number(UNAUTHORIZED_FAILURE)) {
        throw new Error(UNAUTHORIZED_FAILURE);
      }

      return { ok: false, refusal: await conversationRefusalOf(response) };
    }

    return {
      ok: true,
      settings: (await response.json()) as ConversationSettings,
    };
  },
};

/**
 * Which of the four a refusal is about, and what it is called in the catalogue.
 *
 * Two maps and not one record of pairs, because they answer two questions the
 * screen asks in different places: the sentence goes into the notice at the top
 * of the block, and the FIELD is what carries `aria-invalid` and the message a
 * screen reader hears with the control (REQ-149). A refusal drawn only at the
 * top is a refusal nobody typing in the field is told about.
 */
const CONVERSATION_REFUSAL_KEYS: Readonly<Record<string, string>> = {
  wait_hours_out_of_range: "settings.refusalWaitHours",
  questions_out_of_range: "settings.refusalQuestions",
  closing_message_empty: "settings.refusalClosingMessage",
};

/** The sentence for a refusal this build has never heard of. */
const UNKNOWN_CONVERSATION_REFUSAL = "settings.refusalUnknown";

/**
 * Exported for the test, which asserts every key above resolves in the shipped
 * catalogues. A record is invisible to the walker in `catalogue.test.ts`, which
 * reads the arguments of `t("...")`, so the proof that a refusal still has a
 * sentence has to be written somewhere, and here it is (REQ-174).
 */
export const CONVERSATION_REFUSAL_TEXT_KEYS: readonly string[] = [
  ...Object.values(CONVERSATION_REFUSAL_KEYS),
  UNKNOWN_CONVERSATION_REFUSAL,
];

/**
 * The three a refusal can land on. The button text is NOT one of them: its
 * ceiling is where the platform stops drawing the label and not where it stops
 * accepting it, so nothing refuses it and the field says what is coming with
 * `advice` instead (REQ-306, REQ-307).
 */
type ConversationField = "waitHours" | "questions" | "closingMessage";

const CONVERSATION_REFUSAL_FIELDS: Readonly<Record<string, ConversationField>> =
  {
    wait_hours_out_of_range: "waitHours",
    questions_out_of_range: "questions",
    closing_message_empty: "closingMessage",
  };

/**
 * The zone as this screen knows it. `failed` carries no zone on purpose: there
 * is no honest default to show, and the last one this screen invented is the
 * reason REQ-166 exists.
 */
type ZoneLoad =
  | { readonly status: "loading" }
  | { readonly status: "failed" }
  | { readonly status: "unauthorized" }
  | {
      readonly status: "ready";
      readonly timeZone: string;
      readonly timeZones: readonly string[];
    };

type TriggerLoad =
  | { readonly status: "loading" }
  | { readonly status: "failed" }
  | { readonly status: "unauthorized" }
  | { readonly status: "ready"; readonly value: TriggerSwitchState };

/**
 * One instance-wide trigger switch (REQ-321).
 *
 * Named by its LABEL alone. A `<label>` wrapped around a control lends it all
 * of its text, so a subordinate that gained the sentence naming who disabled it
 * would be announced under a different NAME instead of keeping its own name and
 * gaining a reason. `aria-labelledby` pins the name to the label; the sentence
 * stays the description the component wires with `aria-describedby`.
 */
function TriggerSwitch(props: {
  readonly id: string;
  readonly label: string;
  /** The consequence, or the reason this switch cannot be operated. */
  readonly hint?: string;
  readonly checked: boolean;
  readonly disabled?: boolean;
  onCheck(value: boolean): void;
}): ReactElement {
  const nameId = `${props.id}-name`;

  return (
    <Checkbox
      variant="switch"
      id={props.id}
      label={<span id={nameId}>{props.label}</span>}
      hint={props.hint}
      aria-labelledby={nameId}
      checked={props.checked}
      disabled={props.disabled}
      onChange={(event): void => props.onCheck(event.target.checked)}
    />
  );
}

type ConversationLoad =
  | { readonly status: "loading" }
  | { readonly status: "failed" }
  | { readonly status: "unauthorized" }
  | { readonly status: "ready"; readonly stored: ConversationSettings };

/**
 * The four as they sit in the controls, which is not the same thing as the four
 * the instance holds.
 *
 * Text and never numbers, because that is what a field carries: a number kept
 * as a number cannot hold the half-typed state between `1` and `16`, and a
 * control that rewrote what was typed on every keystroke would be unusable.
 * The reading of these strings happens once, at the write.
 */
interface ConversationDraft {
  readonly waitHours: string;
  readonly questions: string;
  readonly closingMessage: string;
  readonly followButtonLabel: string;
}

function draftOf(settings: ConversationSettings): ConversationDraft {
  return {
    waitHours: String(settings.waitHours),
    questions: String(settings.questions),
    closingMessage: settings.closingMessage,
    followButtonLabel: settings.followButtonLabel,
  };
}

/**
 * The number a field holds, or zero when it holds none.
 *
 * Zero and not a default of ours: an empty deadline is not a week, and putting
 * a value there that nobody typed would store a decision the operator never
 * made. Zero is below every minimum this route has, so an empty field gets the
 * instance's own "the minimum is 1" back, which is the sentence it deserves.
 */
function numberFrom(text: string): number {
  const parsed = Number.parseInt(text, 10);

  return Number.isNaN(parsed) ? 0 : parsed;
}

type Translate = (key: string, params?: Record<string, unknown>) => string;

/**
 * The deadline, said back in words.
 *
 * It exists because "168" is a duration to nobody reading it once: the operator
 * should not have to divide by 24 to discover they picked a week. It is a
 * RESTATEMENT of the number in the field and never a verdict on it, so it says
 * nothing about ceilings and refuses nothing. What refuses a value is the
 * instance, and its sentence arrives with the field (REQ-149).
 *
 * A field mid-edit (empty, a minus sign) restates nothing, because there is no
 * number there yet to restate.
 */
function waitEcho(hours: number, t: Translate): string | undefined {
  if (!Number.isInteger(hours) || hours <= 0) return undefined;

  const written = t("settings.waitEchoHours", { count: hours });

  if (hours < 24) return t("settings.waitEchoShort", { hours: written });

  const days = t("settings.waitEchoDays", { count: Math.floor(hours / 24) });
  const rest = hours % 24;

  return rest === 0
    ? t("settings.waitEchoExact", { hours: written, days })
    : t("settings.waitEchoMixed", {
        hours: written,
        days,
        rest: t("settings.waitEchoHours", { count: rest }),
      });
}

/**
 * The count of questions, said back in words, with the FIRST one counted.
 *
 * That is the whole reason this sentence exists: "2" reads as two repeats to
 * anybody who has met a retry counter before, and this says two questions, one
 * of which is a repeat (REQ-254).
 */
function questionsEcho(questions: number, t: Translate): string | undefined {
  if (!Number.isInteger(questions) || questions <= 0) return undefined;

  return questions === 1
    ? t("settings.questionsEchoOnce", { questions })
    : t("settings.questionsEcho", { questions, count: questions - 1 });
}

/**
 * The static sentence under a field, with the echo under it.
 *
 * Both inside `hint`, which is the point: `Field` builds ONE `aria-describedby`
 * out of its own slots, so the number said in words is announced with the
 * control instead of sitting on the page for whoever can see it.
 */
function hintWithEcho(hint: string, echo: string | undefined): ReactNode {
  return echo === undefined ? (
    hint
  ) : (
    <>
      {hint}
      <span className="mc-echo">{echo}</span>
    </>
  );
}

/** One message of a preview thread. `text` absent draws the step label alone. */
interface PreviewLine {
  readonly id: string;
  /** Where the conversation has got to, over the first message of a stretch. */
  readonly step?: string;
  readonly from: "account" | "contact";
  readonly text?: string;
  /** The button that travels with the message, as the contact sees it. */
  readonly quickReply?: string;
}

/**
 * A handset drawn beside the field it explains (REQ-350).
 *
 * Restored on 2026-08-20, and the story is why the comment is here. Task 3p.4
 * read "the preview of the Settings screen goes" and found TWO: the lived
 * conversation of the four global settings, and this one. It removed both and
 * DECLARED the ambiguity instead of choosing in silence, which is the only
 * reason the user could answer it in a minute. He wanted the other one gone
 * and this one back: the label is the single field on this screen whose value
 * the operator cannot picture, because it does not arrive as text but as a
 * button under a message, and the same words read differently there.
 */
function ConversationPreview({
  lines,
  labelledBy,
  t,
}: {
  readonly lines: readonly PreviewLine[];
  readonly labelledBy: string;
  readonly t: Translate;
}): ReactElement {
  return (
    <div className="mc-phone mc-phone--inline">
      {/* Furniture: it is what makes the rectangle read as a screen, and there
        is nothing in it for a screen reader to walk. */}
      <span className="mc-phone__bar" aria-hidden="true">
        <span>{t("screens.automations.previewClock")}</span>
        <span className="mc-phone__signal">
          <span />
          <span />
          <span />
        </span>
      </span>
      <ol className="mc-phone__thread" aria-labelledby={labelledBy}>
        {lines.map((line) => (
          <li
            key={line.id}
            className={[
              "mc-msg",
              line.from === "contact" ? "mc-msg--theirs" : "mc-msg--mine",
            ].join(" ")}
          >
            {line.step === undefined ? null : (
              <span className="mc-msg__step">{line.step}</span>
            )}
            {line.text === undefined ? null : (
              <>
                <span className="mc-msg__who">
                  {t(
                    line.from === "contact"
                      ? "screens.automations.previewWhoContact"
                      : "screens.automations.previewWhoYou",
                  )}
                </span>
                <div className="mc-msg__bubble">
                  <p>{line.text}</p>
                  {line.quickReply === undefined ? null : (
                    <Chip tone="accent">{line.quickReply}</Chip>
                  )}
                </div>
              </>
            )}
          </li>
        ))}
      </ol>
    </div>
  );
}

/**
 * What the button text has earned while it is being typed, or nothing.
 *
 * ONE ceiling and it is `truncatesAt`: the platform accepts a longer label and
 * cuts only what it draws (REQ-306), so there is no `refusesAt` to pass and the
 * advice comes out as a prediction rather than as a refusal to come. The number
 * is the instance's, read from `bounds`, and never written here.
 *
 * This is the first screen to feed the layer the 3o.4 task built. The sentence
 * is the catalogue's, like every word a component renders, and `max` names the
 * ceiling in it so the browser carries no second copy of twenty.
 */
function followLabelAdvice(
  value: string,
  truncatesAt: number,
  t: Translate,
): FieldAdvice | undefined {
  const advice = lengthAdvice(value, { truncatesAt });

  if (advice === undefined) return undefined;

  return {
    nature: advice.nature,
    message: t(LENGTH_ADVICE_TEXT_KEYS[advice.nature], { max: advice.limit }),
  };
}

export interface SettingsScreenProps {
  /** Application behavior, or the connections that belong to this instance. */
  readonly view?: "application" | "instance";
  /** Injected by tests. The running interface always talks to the API. */
  readonly instance?: InstanceClient;
  /** Injected by tests. The running interface always talks to the API. */
  readonly conversation?: ConversationClient;
  readonly configuration?: ConfigurationClient;
  readonly integrations?: IntegrationClient;
}

export function SettingsScreen({
  view = "application",
  instance = httpInstanceClient,
  conversation = httpConversationClient,
  configuration = httpConfigurationClient,
  integrations = httpIntegrationClient,
}: SettingsScreenProps = {}): ReactElement {
  const {
    locale,
    available,
    choose,
    failed,
    readFailure,
    writeUnauthorized,
    t,
  } = useLocale();
  const languageFieldId = useId();
  const zoneFieldId = useId();
  const allTriggerId = useId();
  const commentsTriggerId = useId();
  const messagesTriggerId = useId();
  /**
   * Whether the language refusal has still to be read.
   *
   * The one answer on this screen the screen does not own: `failed` belongs to
   * the locale context, which no screen clears, and a toast the operator
   * dismisses has to stay dismissed. Raised again by the effect below whenever
   * `failed` turns true, so the NEXT refused choice appears; a second refusal
   * with `failed` already true is the same refusal still standing, and raising
   * it again would be answering a question nobody asked twice.
   */
  const [languageUnread, setLanguageUnread] = useState(false);

  useEffect(() => {
    if (failed) setLanguageUnread(true);
  }, [failed]);

  const [zone, setZone] = useState<ZoneLoad>({ status: "loading" });
  const [configurationState, setConfigurationState] = useState<
    ConfigurationState | undefined
  >();
  const [configurationFailure, setConfigurationFailure] = useState(false);
  const [integrationState, setIntegrationState] = useState<
    IntegrationState | undefined
  >();
  const [integrationFailure, setIntegrationFailure] = useState(false);
  const [configurationNotice, setConfigurationNotice] = useState<
    | {
        readonly nature: "success" | "error";
        readonly title: string;
        readonly message: string;
      }
    | undefined
  >(undefined);
  const [removalAction, setRemovalAction] = useState<
    ConfigurationRemovalAction | undefined
  >(undefined);
  const [publicOrigin, setPublicOrigin] = useState("");
  const [verifyToken, setVerifyToken] = useState("");
  /** A token stays readable until this instance confirms it was saved. */
  const [webhookTokenDraft, setWebhookTokenDraft] = useState(false);
  const [metaAccountId, setMetaAccountId] = useState("");
  const [metaAccessToken, setMetaAccessToken] = useState("");
  const [metaAccessTokenDraft, setMetaAccessTokenDraft] = useState(false);
  const [metaAppSecret, setMetaAppSecret] = useState("");
  const [metaAppSecretDraft, setMetaAppSecretDraft] = useState(false);
  const [storageDriver, setStorageDriver] = useState<"local" | "r2" | "s3">(
    "local",
  );
  const [storageEndpoint, setStorageEndpoint] = useState("");
  const [storageAccessKeyId, setStorageAccessKeyId] = useState("");
  const [storageSecretAccessKey, setStorageSecretAccessKey] = useState("");
  const [storageBucket, setStorageBucket] = useState("");
  const publicOriginIsSaved =
    configurationState?.publicOrigin !== undefined &&
    configurationState.publicOrigin === publicOrigin;
  const publicOriginVerified =
    publicOriginIsSaved &&
    configurationState?.publicOriginVerifiedAt !== undefined;
  // A saved value is an explicit configuration, not an editable draft. The
  // matching removal action is the one deliberate way to replace it.
  const publicOriginLocked = configurationState?.publicOrigin !== undefined;
  const webhookTokenLocked = configurationState?.webhookVerifyToken === true;
  const metaAppSecretLocked =
    configurationState?.meta.appSecretConfigured === true;
  const metaCredentialsLocked = configurationState?.meta.configured === true;
  const storageLocked = configurationState?.storage.configured === true;
  const metaCredentialsEntered =
    metaAccountId.trim() !== "" &&
    metaAccessToken.trim() !== "" &&
    metaAccessToken !== MASKED_SECRET_VALUE;
  /** True while the last zone the operator picked could not be stored. */
  const [zoneNotStored, setZoneNotStored] = useState(false);
  const [triggers, setTriggers] = useState<TriggerLoad>({ status: "loading" });
  const [triggerNotStored, setTriggerNotStored] = useState(false);
  const themeFieldId = useId();
  /**
   * The theme this machine holds, read from the store on the first render and
   * never asked for again (REQ-326).
   *
   * Read rather than assumed, which is what makes the choice survive a reload:
   * the page comes back with `data-theme` already on the root (the inline
   * script in `index.html` puts it there before the first paint), and the
   * selector has to come back showing the same answer instead of the default.
   * Nothing else on the screen can change it, so there is no effect keeping the
   * two in step.
   */
  const [theme, setTheme] = useState<ThemeChoice>(readThemeChoice);
  const waitFieldId = useId();
  const waitScopeId = useId();
  const questionsFieldId = useId();
  const closingFieldId = useId();
  const followFieldId = useId();
  const followPreviewId = useId();
  const [settings, setSettings] = useState<ConversationLoad>({
    status: "loading",
  });
  const [draft, setDraft] = useState<ConversationDraft | undefined>(undefined);
  /**
   * The instance's answer to the last write, kept until the next one.
   *
   * Kept, and that is the whole of it: a refusal that cleared itself on the
   * next keystroke would be gone before the operator finished reading it, and
   * the number it names is the only place the ceiling is ever said out loud.
   * It is replaced by the answer to the next write and by nothing else.
   */
  const [written, setWritten] = useState<
    | { readonly ok: true }
    | { readonly refusal: ConversationRefusal }
    | undefined
  >(undefined);
  const [saving, setSaving] = useState(false);
  const live = useRef(true);

  useEffect(() => {
    // Dropped rather than rendered if the screen is gone: a state set on an
    // unmounted screen is a warning in the console and a leak in the making.
    live.current = true;

    void (async (): Promise<void> => {
      try {
        const state = await instance.read();
        if (live.current) {
          setZone({
            status: "ready",
            timeZone: state.timeZone,
            timeZones: state.timeZones,
          });
        }
      } catch (failure) {
        if (live.current) {
          setZone({
            status: isUnauthorizedFailure(failure) ? "unauthorized" : "failed",
          });
        }
      }
    })();

    void (async (): Promise<void> => {
      try {
        const value = await integrations.read();
        if (live.current) {
          setIntegrationState(value);
          setIntegrationFailure(false);
        }
      } catch {
        if (live.current) setIntegrationFailure(true);
      }
    })();

    void (async (): Promise<void> => {
      try {
        const value = await configuration.read();
        if (live.current) {
          setConfigurationState(value);
          setVerifyToken(value.webhookVerifyToken ? MASKED_SECRET_VALUE : "");
          setWebhookTokenDraft(false);
          setMetaAppSecret(
            value.meta.appSecretConfigured ? MASKED_SECRET_VALUE : "",
          );
          setMetaAppSecretDraft(false);
          setMetaAccountId(value.meta.accountId ?? "");
          setMetaAccessToken(value.meta.configured ? MASKED_SECRET_VALUE : "");
          setMetaAccessTokenDraft(false);
          setPublicOrigin(
            value.publicOrigin ??
              (window.location.protocol === "https:"
                ? window.location.origin
                : ""),
          );
          setStorageDriver(
            value.storage.driver === "r2" || value.storage.driver === "s3"
              ? value.storage.driver
              : "local",
          );
          setStorageEndpoint(value.storage.endpoint ?? "");
          setStorageBucket(value.storage.bucket ?? "");
        }
      } catch {
        if (live.current) setConfigurationFailure(true);
      }
    })();

    void (async (): Promise<void> => {
      if (instance.readTriggers === undefined) return;
      try {
        const value = await instance.readTriggers();
        if (live.current) setTriggers({ status: "ready", value });
      } catch (failure) {
        if (live.current) {
          setTriggers({
            status: isUnauthorizedFailure(failure) ? "unauthorized" : "failed",
          });
        }
      }
    })();

    return (): void => {
      live.current = false;
    };
  }, [instance, configuration, integrations]);

  const writeConfiguration = async (
    change: Record<string, string> & { readonly action: string },
  ): Promise<void> => {
    try {
      const result = await configuration.write(change);
      const value = await configuration.read();
      if (live.current) {
        setConfigurationState(value);
        setConfigurationFailure(false);
        if (change.action === "replace_meta" && result.status !== undefined) {
          setIntegrationState((current) => ({
            meta: { status: result.status ?? "pending" },
            storage: current?.storage ?? {
              driver: value.storage.driver,
              status: "pending",
            },
          }));
        }
        if (change.action === "remove_webhook_verify_token") {
          setVerifyToken("");
          setWebhookTokenDraft(false);
        }
        if (change.action === "remove_public_origin") {
          setPublicOrigin("");
          setVerifyToken("");
          setWebhookTokenDraft(false);
        }
        if (result.generatedWebhookVerifyToken !== undefined) {
          setVerifyToken(result.generatedWebhookVerifyToken);
          setWebhookTokenDraft(true);
        }
        if (change.action === "set_webhook_verify_token" && result.ok) {
          setWebhookTokenDraft(false);
        }
        if (change.action === "set_meta_app_secret" && result.ok) {
          setMetaAppSecretDraft(false);
        }
        if (change.action === "replace_meta" && result.ok) {
          setMetaAccessTokenDraft(false);
        }
        if (change.action === "remove_meta_app_secret") {
          setMetaAppSecret("");
          setMetaAppSecretDraft(false);
        }
        if (change.action === "remove_meta") {
          setMetaAccountId("");
          setMetaAccessToken("");
          setMetaAccessTokenDraft(false);
        }
        if (change.action === "remove_storage") {
          setStorageDriver("local");
          setStorageEndpoint("");
          setStorageAccessKeyId("");
          setStorageSecretAccessKey("");
          setStorageBucket("");
        }
        const isMeta = change.action.includes("meta");
        const isStorage = change.action.endsWith("_storage");
        const isPublicOrigin = change.action.includes("public_origin");
        const isTest = change.action.startsWith("test_");
        const isRemoval = change.action.startsWith("remove_");
        setConfigurationNotice({
          nature: result.ok ? "success" : "error",
          title: result.ok
            ? isTest
              ? t("settings.connectionTestSucceededTitle")
              : isRemoval
                ? t("settings.configurationRemovedTitle")
                : t("settings.configurationSavedTitle")
            : isTest
              ? t("settings.connectionTestFailedTitle")
              : t("settings.configurationNotSavedTitle"),
          message: result.ok
            ? isTest
              ? isPublicOrigin
                ? t("settings.publicOriginTestSucceeded")
                : isMeta
                  ? t("settings.metaConnectionTestSucceeded")
                  : t("settings.storageConnectionTestSucceeded")
              : isRemoval
                ? t("settings.configurationRemoved")
                : isMeta
                  ? t("settings.metaSavedAndVerified")
                  : isStorage
                    ? t("settings.storageSavedAndVerified")
                    : t("settings.configurationSaved")
            : isTest
              ? isPublicOrigin
                ? t("settings.publicOriginTestFailed")
                : isMeta
                  ? t("settings.metaConnectionTestFailed")
                  : t("settings.storageConnectionTestFailed")
              : t("settings.configurationNotSaved"),
        });
      }
    } catch {
      if (live.current) {
        setConfigurationFailure(true);
        setConfigurationNotice({
          nature: "error",
          title: t("settings.configurationNotSavedTitle"),
          message: t("settings.configurationNotSaved"),
        });
      }
    }
  };

  /** Tell the operator whether a value reached the browser clipboard. */
  const copyConfigurationValue = async (
    value: string,
    message: string,
  ): Promise<void> => {
    try {
      if (!("clipboard" in navigator)) throw new Error("clipboard-unavailable");
      await navigator.clipboard.writeText(value);
      if (live.current) {
        setConfigurationNotice({
          nature: "success",
          title: t("settings.copySucceededTitle"),
          message,
        });
      }
    } catch {
      if (live.current) {
        setConfigurationNotice({
          nature: "error",
          title: t("settings.copyFailedTitle"),
          message: t("settings.copyFailed"),
        });
      }
    }
  };

  useEffect(() => {
    live.current = true;

    void (async (): Promise<void> => {
      try {
        const stored = await conversation.read();
        if (live.current) {
          setSettings({ status: "ready", stored });
          setDraft(draftOf(stored));
        }
      } catch (failure) {
        if (live.current) {
          // No value is shown when the read failed, for the reason the zone
          // shows none: a panel that fell back to 168 and 3 would state the
          // defaults as if they were what this instance holds.
          setSettings({
            status: isUnauthorizedFailure(failure) ? "unauthorized" : "failed",
          });
        }
      }
    })();

    return (): void => {
      live.current = false;
    };
  }, [conversation]);

  const chooseZone = async (wanted: string): Promise<void> => {
    try {
      const state = await instance.write(wanted);

      // Adopted from the ANSWER and not from what was picked: the instance is
      // what decides, and a screen that moved on its own would show a zone the
      // next reload corrects — and, worse, a zone the dashboard is not
      // counting in.
      if (live.current) {
        setZone({
          status: "ready",
          timeZone: state.timeZone,
          timeZones: state.timeZones,
        });
        setZoneNotStored(false);
      }
    } catch {
      // Nothing was stored, so nothing moves here either: the control keeps
      // the zone in force, which is exactly what the notice says.
      if (live.current) {
        setZoneNotStored(true);
      }
    }
  };

  /**
   * Whether the master switch is ON, which is the instance being OFF (REQ-322).
   *
   * The instance stores whether automations are ENABLED, and the operator is
   * offered the opposite question, "disable all", so this screen reads and
   * writes `all` inverted and nothing else changes: the dashboard and the
   * dispatch go on reading `all.enabled` with the meaning they always had.
   *
   * While it holds, the two channel switches are drawn OFF and cannot be
   * operated, because nothing they say would be true: no comment and no direct
   * message reaches an automation. Their STORED choices are untouched here, and
   * the instance never rewrites them either, so turning the master off gives
   * each channel back the choice it had rather than turning both on.
   */
  const everythingDisabled =
    triggers.status === "ready" && !triggers.value.all.enabled;

  const chooseTrigger = async (
    name: TriggerSwitchName,
    enabled: boolean,
  ): Promise<void> => {
    if (instance.writeTrigger === undefined) return;
    try {
      const value = await instance.writeTrigger(name, enabled);
      if (live.current) {
        setTriggers({ status: "ready", value });
        setTriggerNotStored(false);
      }
    } catch {
      if (live.current) setTriggerNotStored(true);
    }
  };

  /**
   * The four, written together (REQ-252, REQ-254, REQ-255, REQ-257).
   *
   * One write and not four, because the instance refuses as a whole: a request
   * carrying a good deadline and an impossible label stores neither, so a
   * screen that sent them one at a time would leave the operator with half of
   * what they asked for and one message about the other half.
   */
  const saveConversation = async (): Promise<void> => {
    if (draft === undefined) return;

    setSaving(true);
    // Cleared before the call, never after: the answer to the previous write is
    // stale the moment another one leaves, and clearing it here is also what
    // makes the next toast a NEW element, with its reading time counted from
    // zero instead of resuming whatever was left of the last one.
    setWritten(undefined);

    try {
      const answer = await conversation.write({
        waitHours: numberFrom(draft.waitHours),
        questions: numberFrom(draft.questions),
        closingMessage: draft.closingMessage,
        followButtonLabel: draft.followButtonLabel,
      });

      if (!live.current) return;

      if (answer.ok) {
        // Adopted from the ANSWER and not from what was typed: the instance is
        // what decides, and a screen that moved on its own would show a value
        // the next reload corrects.
        setSettings({ status: "ready", stored: answer.settings });
        setDraft(draftOf(answer.settings));
        setWritten({ ok: true });
      } else {
        // Nothing was stored, so nothing moves in the controls either: what the
        // operator typed stays there to be corrected, and the notice says the
        // four values are as they were.
        setWritten({ refusal: answer.refusal });
      }
    } catch (failure) {
      if (!live.current) return;

      if (isUnauthorizedFailure(failure)) {
        setSettings({ status: "unauthorized" });
      } else {
        setWritten({ refusal: { error: String(failure) } });
      }
    } finally {
      if (live.current) setSaving(false);
    }
  };

  /** Back to what the instance holds, which is the only thing to go back to. */
  const discardConversation = (): void => {
    if (settings.status !== "ready") return;

    setDraft(draftOf(settings.stored));
    setWritten(undefined);
  };

  const refusal =
    written !== undefined && "refusal" in written ? written.refusal : undefined;
  const refusedField =
    refusal === undefined
      ? undefined
      : CONVERSATION_REFUSAL_FIELDS[refusal.error];
  /** The instance's sentence for the refused field, drawn beside it (REQ-149). */
  const refusalOf = (field: ConversationField): string | undefined =>
    refusedField === field
      ? t(
          CONVERSATION_REFUSAL_KEYS[refusal?.error ?? ""] ??
            UNKNOWN_CONVERSATION_REFUSAL,
          { count: refusal?.limit ?? 0 },
        )
      : undefined;

  return (
    <div className="mc-page">
      <div className="mc-page__head">
        <div className="mc-page__titles">
          <h1>
            {view === "instance"
              ? t("settings.instanceTitle")
              : t("settings.title")}
          </h1>
        </div>
      </div>

      {readFailure === "unauthorized" ||
      writeUnauthorized ||
      zone.status === "unauthorized" ||
      triggers.status === "unauthorized" ? (
        <SessionExpiredNotice />
      ) : null}

      {failed && !writeUnauthorized && languageUnread ? (
        <Toast
          nature="error"
          title={t("settings.languageFailedTitle")}
          message={t("settings.languageFailed")}
          dismissLabel={t("toast.dismiss")}
          onDismiss={(): void => setLanguageUnread(false)}
        />
      ) : null}

      {configurationNotice !== undefined ? (
        <Toast
          nature={configurationNotice.nature}
          title={configurationNotice.title}
          message={configurationNotice.message}
          dismissLabel={t("toast.dismiss")}
          onDismiss={(): void => setConfigurationNotice(undefined)}
        />
      ) : null}

      {/* The menu of application-setting block titles (REQ-327). It is
          drawn unconditionally because every one of the four sections below is
          drawn unconditionally: a block that failed to READ still stands, with
          its failure inside it, so no entry here can point at nothing. */}
      {view === "application" ? (
        <BlockNav
          label={t("settings.jumpLabel")}
          blocks={[
            {
              id: SETTINGS_BLOCKS.language,
              title: t("settings.languageTitle"),
            },
            {
              id: SETTINGS_BLOCKS.triggers,
              title: t("settings.triggersTitle"),
            },
            {
              id: SETTINGS_BLOCKS.conversation,
              title: t("settings.conversationTitle"),
            },
            { id: SETTINGS_BLOCKS.theme, title: t("settings.themeTitle") },
          ]}
        />
      ) : null}

      {view === "instance" ? (
        <section
          className="mc-panel mc-jump-target mc-settings-integrations"
          id={SETTINGS_BLOCKS.integrations}
          tabIndex={-1}
          aria-labelledby={headingIdOf(SETTINGS_BLOCKS.integrations)}
        >
          <div className="mc-panel__head">
            <h2
              className="mc-panel__title"
              id={headingIdOf(SETTINGS_BLOCKS.integrations)}
            >
              {t("settings.integrationsTitle")}
            </h2>
            {configurationState === undefined ? null : (
              <StatusBadge state="info" mono dot={false}>
                {configurationState.installedVersion === "development"
                  ? t("settings.developmentVersion")
                  : t("settings.installedVersion", {
                      version: configurationState.installedVersion,
                    })}
              </StatusBadge>
            )}
          </div>
          <p className="mc-panel__note">{t("settings.integrationsHint")}</p>
          {configurationFailure ? (
            <p className="mc-field__tip">{t("settings.integrationsFailed")}</p>
          ) : null}
          {configurationState !== undefined ? (
            <div className="mc-stack">
              {integrationFailure ? (
                <p className="mc-field__tip">
                  {t("settings.integrationHealthFailed")}
                </p>
              ) : null}
              <section className="mc-settings-subsection" style={{ order: 2 }}>
                <div className="mc-settings-subsection__head">
                  <h3>{t("settings.metaSectionTitle")}</h3>
                  <StatusBadge
                    state={
                      !configurationState.meta.configured
                        ? "neutral"
                        : integrationState === undefined
                          ? "info"
                          : INTEGRATION_HEALTH_BADGE_STATES[
                              integrationState.meta.status
                            ]
                    }
                    dot={integrationState?.meta.status === "healthy"}
                  >
                    {!configurationState.meta.configured
                      ? t("settings.metaMissing")
                      : integrationState === undefined
                        ? t("settings.metaConfigured")
                        : t(
                            INTEGRATION_HEALTH_TEXT_KEYS[
                              integrationState.meta.status
                            ].meta,
                          )}
                  </StatusBadge>
                </div>
                <div className="mc-settings-action-group">
                  <h4>{t("settings.metaAppSecretGroupTitle")}</h4>
                  <Field
                    id="settings-meta-app-secret"
                    type={metaAppSecretDraft ? "text" : "password"}
                    label={t("settings.metaAppSecretLabel")}
                    hint={t("settings.secretReplacementHint")}
                    value={metaAppSecret}
                    onChange={(event): void => {
                      setMetaAppSecretDraft(true);
                      setMetaAppSecret(event.target.value);
                    }}
                    disabled={!publicOriginVerified || metaAppSecretLocked}
                  />
                  <div className="mc-row">
                    <Button
                      variant="primary"
                      disabled={
                        !publicOriginVerified ||
                        metaAppSecretLocked ||
                        metaAppSecret.trim() === "" ||
                        metaAppSecret === MASKED_SECRET_VALUE
                      }
                      onClick={(): void => {
                        void writeConfiguration({
                          action: "set_meta_app_secret",
                          metaAppSecret,
                        });
                      }}
                    >
                      {t("settings.saveMetaAppSecret")}
                    </Button>
                    <Button
                      variant="removal"
                      disabled={
                        !publicOriginVerified ||
                        !configurationState.meta.appSecretConfigured
                      }
                      onClick={(): void => {
                        setRemovalAction("remove_meta_app_secret");
                      }}
                    >
                      {t("settings.removeMetaAppSecret")}
                    </Button>
                  </div>
                </div>
                <div className="mc-settings-action-group">
                  <h4>{t("settings.metaCredentialsGroupTitle")}</h4>
                  <p className="mc-field__tip">
                    {t("settings.metaCredentialsHint")}
                  </p>
                  <div className="mc-grid2">
                    <Field
                      id="settings-meta-account-id"
                      label={t("settings.metaAccountIdLabel")}
                      hint={t("settings.instagramAccountIdHint")}
                      value={metaAccountId}
                      onChange={(event): void =>
                        setMetaAccountId(event.target.value)
                      }
                      disabled={!publicOriginVerified || metaCredentialsLocked}
                    />
                    <Field
                      id="settings-meta-access-token"
                      type={metaAccessTokenDraft ? "text" : "password"}
                      label={t("settings.metaAccessTokenLabel")}
                      hint={t("settings.metaAccessTokenHint")}
                      value={metaAccessToken}
                      onChange={(event): void => {
                        setMetaAccessTokenDraft(true);
                        setMetaAccessToken(event.target.value);
                      }}
                      disabled={!publicOriginVerified || metaCredentialsLocked}
                    />
                  </div>
                  <div className="mc-row">
                    <Button
                      variant="primary"
                      disabled={
                        !publicOriginVerified ||
                        metaCredentialsLocked ||
                        !configurationState.meta.appSecretConfigured ||
                        !metaCredentialsEntered
                      }
                      onClick={(): void => {
                        void writeConfiguration({
                          action: "replace_meta",
                          authPath: "instagram_login",
                          accountId: metaAccountId,
                          accessToken: metaAccessToken,
                        });
                      }}
                    >
                      {t("settings.saveMeta")}
                    </Button>
                    <Button
                      variant="removal"
                      disabled={
                        !publicOriginVerified ||
                        !configurationState.meta.configured
                      }
                      onClick={(): void => {
                        setRemovalAction("remove_meta");
                      }}
                    >
                      {t("settings.removeMeta")}
                    </Button>
                  </div>
                </div>
                {!configurationState.meta.appSecretConfigured ? (
                  <Notice nature="info" title={t("settings.metaBlockedTitle")}>
                    {t("settings.metaBlocked")}
                  </Notice>
                ) : !configurationState.meta.configured &&
                  configurationState.webhookConfirmedAt === undefined ? (
                  <Notice
                    nature="info"
                    title={t("settings.metaCredentialsReadyTitle")}
                  >
                    {t("settings.metaCredentialsReady")}
                  </Notice>
                ) : configurationState.webhookConfirmedAt === undefined ? (
                  <Notice
                    nature="info"
                    title={t("settings.metaAwaitingWebhookTitle")}
                  >
                    {t("settings.metaAwaitingWebhook")}
                  </Notice>
                ) : null}
              </section>
              <section className="mc-settings-subsection" style={{ order: 3 }}>
                <div className="mc-settings-subsection__head">
                  <h3>{t("settings.storageSectionTitle")}</h3>
                  <StatusBadge
                    state={
                      !configurationState.storage.configured
                        ? "neutral"
                        : integrationState === undefined
                          ? "info"
                          : INTEGRATION_HEALTH_BADGE_STATES[
                              integrationState.storage.status
                            ]
                    }
                    dot={integrationState?.storage.status === "healthy"}
                  >
                    {!configurationState.storage.configured
                      ? t("settings.storageMissing")
                      : integrationState === undefined
                        ? t("settings.storageConfigured", {
                            driver: configurationState.storage.driver,
                          })
                        : t(
                            INTEGRATION_HEALTH_TEXT_KEYS[
                              integrationState.storage.status
                            ].storage,
                            { driver: integrationState.storage.driver },
                          )}
                  </StatusBadge>
                </div>
                <Field
                  id="settings-storage-driver"
                  label={t("settings.storageDriverLabel")}
                >
                  <Select
                    id="settings-storage-driver"
                    value={storageDriver}
                    options={[
                      { value: "local", label: t("settings.storageLocal") },
                      { value: "r2", label: t("settings.storageR2") },
                      { value: "s3", label: t("settings.storageS3") },
                    ]}
                    onChange={(event): void =>
                      setStorageDriver(
                        event.target.value as "local" | "r2" | "s3",
                      )
                    }
                    disabled={!publicOriginVerified || storageLocked}
                  />
                </Field>
                {storageDriver !== "local" ? (
                  <div className="mc-grid2">
                    <Field
                      id="settings-storage-endpoint"
                      type="url"
                      label={t("settings.storageEndpointLabel")}
                      value={storageEndpoint}
                      onChange={(event): void =>
                        setStorageEndpoint(event.target.value)
                      }
                      disabled={!publicOriginVerified || storageLocked}
                    />
                    <Field
                      id="settings-storage-access-key"
                      label={t("settings.storageAccessKeyLabel")}
                      value={storageAccessKeyId}
                      onChange={(event): void =>
                        setStorageAccessKeyId(event.target.value)
                      }
                      disabled={!publicOriginVerified || storageLocked}
                    />
                    <Field
                      id="settings-storage-secret-key"
                      type="password"
                      label={t("settings.storageSecretKeyLabel")}
                      value={storageSecretAccessKey}
                      onChange={(event): void =>
                        setStorageSecretAccessKey(event.target.value)
                      }
                      disabled={!publicOriginVerified || storageLocked}
                    />
                    <Field
                      id="settings-storage-bucket"
                      label={t("settings.storageBucketLabel")}
                      value={storageBucket}
                      onChange={(event): void =>
                        setStorageBucket(event.target.value)
                      }
                      disabled={!publicOriginVerified || storageLocked}
                    />
                  </div>
                ) : null}
                <p className="mc-field__tip">
                  {t("settings.storageNotBackup")}
                </p>
                <div className="mc-row">
                  <Button
                    variant="primary"
                    disabled={!publicOriginVerified || storageLocked}
                    onClick={(): void => {
                      void writeConfiguration({
                        action: "replace_storage",
                        driver: storageDriver,
                        endpoint: storageEndpoint,
                        accessKeyId: storageAccessKeyId,
                        secretAccessKey: storageSecretAccessKey,
                        bucket: storageBucket,
                      });
                    }}
                  >
                    {t("settings.saveStorage")}
                  </Button>
                  <Button
                    disabled={!publicOriginVerified || storageLocked}
                    onClick={(): void => {
                      void writeConfiguration({
                        action: "test_storage",
                        driver: storageDriver,
                        endpoint: storageEndpoint,
                        accessKeyId: storageAccessKeyId,
                        secretAccessKey: storageSecretAccessKey,
                        bucket: storageBucket,
                      });
                    }}
                  >
                    {t("settings.testStorage")}
                  </Button>
                  <Button
                    variant="removal"
                    disabled={
                      !publicOriginVerified ||
                      !configurationState.storage.configured
                    }
                    onClick={(): void => {
                      setRemovalAction("remove_storage");
                    }}
                  >
                    {t("settings.removeStorage")}
                  </Button>
                </div>
              </section>
              <section className="mc-settings-subsection" style={{ order: 1 }}>
                <div className="mc-settings-subsection__head">
                  <h3>{t("settings.webhookSectionTitle")}</h3>
                  <StatusBadge
                    state={
                      configurationState.webhookConfirmedAt !== undefined
                        ? "active"
                        : configurationState.publicOrigin !== undefined &&
                            configurationState.webhookVerifyToken
                          ? "attention"
                          : "neutral"
                    }
                    dot={configurationState.webhookConfirmedAt !== undefined}
                  >
                    {configurationState.webhookConfirmedAt !== undefined
                      ? t("settings.webhookConfirmed")
                      : configurationState.publicOrigin !== undefined &&
                          configurationState.webhookVerifyToken
                        ? t("settings.webhookAwaitingMeta")
                        : t("settings.webhookMissing")}
                  </StatusBadge>
                </div>
                <Field
                  id="settings-public-origin"
                  type="url"
                  label={t("settings.publicOriginLabel")}
                  hint={t("settings.publicOriginHint")}
                  value={publicOrigin}
                  onChange={(event): void =>
                    setPublicOrigin(event.target.value)
                  }
                  disabled={publicOriginLocked}
                />
                <StatusBadge
                  state={publicOriginVerified ? "active" : "attention"}
                  dot={publicOriginVerified}
                >
                  {publicOriginVerified
                    ? t("settings.publicOriginVerified")
                    : t("settings.publicOriginNotVerified")}
                </StatusBadge>
                <div className="mc-row">
                  <Button
                    variant="primary"
                    disabled={
                      publicOriginLocked ||
                      publicOrigin.trim() === "" ||
                      publicOriginIsSaved
                    }
                    onClick={(): void => {
                      void writeConfiguration({
                        action: "set_public_origin",
                        publicOrigin,
                      });
                    }}
                  >
                    {t("settings.savePublicOrigin")}
                  </Button>
                  <Button
                    disabled={!publicOriginIsSaved}
                    onClick={(): void => {
                      void writeConfiguration({ action: "test_public_origin" });
                    }}
                  >
                    {t("settings.testPublicOrigin")}
                  </Button>
                  <Button
                    variant="removal"
                    disabled={configurationState.publicOrigin === undefined}
                    onClick={(): void => {
                      setRemovalAction("remove_public_origin");
                    }}
                  >
                    {t("settings.removePublicOrigin")}
                  </Button>
                </div>
                <Field
                  id="settings-webhook-token"
                  type={webhookTokenDraft ? "text" : "password"}
                  label={t("settings.webhookTokenLabel")}
                  hint={t("settings.webhookTokenHint")}
                  mono
                  value={verifyToken}
                  disabled={!publicOriginVerified || webhookTokenLocked}
                  onChange={(event): void => {
                    setWebhookTokenDraft(true);
                    setVerifyToken(event.target.value);
                  }}
                  trailingAction={
                    <Button
                      disabled={
                        !configurationState.webhookVerifyToken ||
                        verifyToken === MASKED_SECRET_VALUE
                      }
                      onClick={(): void => {
                        void copyConfigurationValue(
                          verifyToken,
                          t("settings.webhookTokenCopied"),
                        );
                      }}
                    >
                      {t("settings.copyWebhookToken")}
                    </Button>
                  }
                />
                <div className="mc-row">
                  <Button
                    disabled={!publicOriginVerified || webhookTokenLocked}
                    onClick={(): void => {
                      void writeConfiguration({
                        action: "generate_webhook_verify_token",
                      });
                    }}
                  >
                    {t("settings.generateWebhookToken")}
                  </Button>
                  <Button
                    variant="primary"
                    disabled={
                      !publicOriginVerified ||
                      webhookTokenLocked ||
                      verifyToken.trim() === "" ||
                      verifyToken === MASKED_SECRET_VALUE
                    }
                    onClick={(): void => {
                      void writeConfiguration({
                        action: "set_webhook_verify_token",
                        webhookVerifyToken: verifyToken,
                      });
                    }}
                  >
                    {t("settings.saveWebhookToken")}
                  </Button>
                  <Button
                    variant="removal"
                    disabled={
                      !publicOriginVerified ||
                      !configurationState.webhookVerifyToken
                    }
                    onClick={(): void => {
                      setRemovalAction("remove_webhook_verify_token");
                    }}
                  >
                    {t("settings.removeWebhookToken")}
                  </Button>
                </div>
                {configurationState.webhookVerifyToken ? (
                  <>
                    <p className="mc-field__tip">
                      {t("settings.metaCallbackHint")}
                    </p>
                    <div className="mc-copy-value">
                      <code>
                        {`${publicOrigin.endsWith("/") ? publicOrigin.slice(0, -1) : publicOrigin}/webhook`}
                      </code>
                      <Button
                        disabled={configurationState.publicOrigin === undefined}
                        onClick={(): void => {
                          const origin = publicOrigin.endsWith("/")
                            ? publicOrigin.slice(0, -1)
                            : publicOrigin;
                          void copyConfigurationValue(
                            `${origin}/webhook`,
                            t("settings.webhookCallbackCopied"),
                          );
                        }}
                      >
                        {t("settings.copyWebhookCallback")}
                      </Button>
                    </div>
                  </>
                ) : null}
              </section>
              {removalAction !== undefined ? (
                <ConfirmDialog
                  title={t("settings.removeConfigurationTitle")}
                  consequence={t("settings.removeConfigurationConsequence")}
                  confirmLabel={t("settings.removeConfigurationConfirm")}
                  cancelLabel={t("settings.removeConfigurationCancel")}
                  destructive
                  onCancel={(): void => setRemovalAction(undefined)}
                  onConfirm={(): void => {
                    const action = removalAction;

                    setRemovalAction(undefined);
                    void writeConfiguration({ action });
                  }}
                />
              ) : null}
            </div>
          ) : (
            <PendingState label={t("settings.integrationsLoading")} />
          )}
        </section>
      ) : null}

      {view === "application" ? (
        <>
          {/* Language and time zone, in ONE block (REQ-325). The panel's own title
          names both, so nothing inside it needs a second heading to say which
          half a control belongs to. */}
          <section
            className="mc-panel mc-jump-target"
            style={FORM_WIDTH}
            id={SETTINGS_BLOCKS.language}
            tabIndex={-1}
            aria-labelledby={headingIdOf(SETTINGS_BLOCKS.language)}
          >
            <div className="mc-panel__head">
              <h2
                className="mc-panel__title"
                id={headingIdOf(SETTINGS_BLOCKS.language)}
              >
                {t("settings.languageTitle")}
              </h2>
            </div>

            {/* Where the sentence about the language now lives. It was the LEAD of
            the whole screen, from when the whole screen was the language
            selector, so a page holding eleven settings opened with a paragraph
            about one of them. Nothing was taken out: it is the note of the
            block it was always about (REQ-323 keeps it). */}
            <p className="mc-panel__note">{t("settings.languageHint")}</p>

            <Field id={languageFieldId} label={t("settings.languageLabel")}>
              <Select
                id={languageFieldId}
                value={locale}
                options={available.map((code) => ({
                  value: code,
                  label: languageName(code),
                }))}
                onChange={(event): void => {
                  void choose(event.target.value);
                }}
              />
            </Field>

            {/* The control still holds the zone that is really in force (REQ-115),
            so what changed is only that the write did not happen, and that is
            an answer rather than a state of the panel (REQ-312). */}
            {zoneNotStored ? (
              <Toast
                nature="error"
                title={t("settings.timezoneNotStoredTitle")}
                message={t("settings.timezoneNotStored")}
                dismissLabel={t("toast.dismiss")}
                onDismiss={(): void => setZoneNotStored(false)}
              />
            ) : null}

            {/* The options are identifiers the instance answered with, not words:
            `America/Sao_Paulo` names itself in every language, and a catalogue
            of names for zones could never keep up with the runtime's own list.
            The selected one is the control's value, so what is in force is
            announced by the platform rather than drawn by us. */}
            {zone.status === "ready" ? (
              <Field id={zoneFieldId} label={t("settings.timezoneLabel")}>
                <Select
                  id={zoneFieldId}
                  value={zone.timeZone}
                  options={zone.timeZones.map((code) => ({
                    value: code,
                    label: timeZoneOptionLabel(code),
                  }))}
                  onChange={(event): void => {
                    void chooseZone(event.target.value);
                  }}
                />
              </Field>
            ) : null}

            {zone.status === "loading" ? (
              <PendingState label={t("settings.timezoneLoading")} />
            ) : null}

            {zone.status === "failed" ? (
              <Notice nature="error" title={t("settings.timezoneFailedTitle")}>
                {t("settings.timezoneFailed")}
              </Notice>
            ) : null}
          </section>

          <section
            className="mc-panel mc-jump-target"
            style={FORM_WIDTH}
            id={SETTINGS_BLOCKS.triggers}
            tabIndex={-1}
            aria-labelledby={headingIdOf(SETTINGS_BLOCKS.triggers)}
          >
            <div className="mc-panel__head">
              <h2
                className="mc-panel__title"
                id={headingIdOf(SETTINGS_BLOCKS.triggers)}
              >
                {t("settings.triggersTitle")}
              </h2>
            </div>
            <p className="mc-panel__note">{t("settings.triggersHint")}</p>

            {/* The answer to a switch, and the switch still holds what is really in
            force, so there is nothing on the panel this has to sit next to
            (REQ-312). The read that FAILED, below, is a standing condition of
            the panel and stays a box. */}
            {triggerNotStored ? (
              <Toast
                nature="error"
                title={t("settings.triggersNotStoredTitle")}
                message={t("settings.triggersNotStored")}
                dismissLabel={t("toast.dismiss")}
                onDismiss={(): void => setTriggerNotStored(false)}
              />
            ) : null}

            {triggers.status === "loading" ? (
              <PendingState label={t("settings.triggersLoading")} />
            ) : null}
            {triggers.status === "failed" ? (
              <Notice nature="error" title={t("settings.triggersFailedTitle")}>
                {t("settings.triggersFailed")}
              </Notice>
            ) : null}
            {triggers.status === "ready" ? (
              <div className="mc-stack">
                <TriggerSwitch
                  id={allTriggerId}
                  label={t("settings.triggerAll")}
                  hint={t("settings.triggerAllHint")}
                  checked={everythingDisabled}
                  onCheck={(value): void => {
                    void chooseTrigger("all", !value);
                  }}
                />
                <TriggerSwitch
                  id={commentsTriggerId}
                  label={t("settings.triggerComments")}
                  hint={
                    everythingDisabled
                      ? t("settings.triggerDisabledByAll")
                      : undefined
                  }
                  checked={
                    !everythingDisabled && triggers.value.comments.enabled
                  }
                  disabled={everythingDisabled}
                  onCheck={(value): void => {
                    void chooseTrigger("comments", value);
                  }}
                />
                <TriggerSwitch
                  id={messagesTriggerId}
                  label={t("settings.triggerDirectMessages")}
                  hint={
                    everythingDisabled
                      ? t("settings.triggerDisabledByAll")
                      : undefined
                  }
                  checked={
                    !everythingDisabled && triggers.value.directMessages.enabled
                  }
                  disabled={everythingDisabled}
                  onCheck={(value): void => {
                    void chooseTrigger("directMessages", value);
                  }}
                />
              </div>
            ) : null}
          </section>

          {/* The four settings of the automatic conversation, as ONE group: they
        are a single decision about how the conversation behaves, and the
        heading over them is what says the three panels below belong together
        rather than being three more preferences of the panel. */}
          <section
            className="mc-stack mc-jump-target"
            style={FORM_WIDTH}
            id={SETTINGS_BLOCKS.conversation}
            tabIndex={-1}
            aria-labelledby={headingIdOf(SETTINGS_BLOCKS.conversation)}
          >
            <div className="mc-page__titles">
              <h2 id={headingIdOf(SETTINGS_BLOCKS.conversation)}>
                {t("settings.conversationTitle")}
              </h2>
            </div>

            {settings.status === "loading" ? (
              <PendingState label={t("settings.conversationLoading")} />
            ) : null}

            {settings.status === "failed" ? (
              <Notice
                nature="error"
                title={t("settings.conversationFailedTitle")}
              >
                {t("settings.conversationFailed")}
              </Notice>
            ) : null}

            {settings.status === "ready" && draft !== undefined ? (
              <>
                <div className="mc-panel">
                  <div className="mc-panel__head">
                    <h3>{t("settings.waitTitle")}</h3>
                    {/* Repeated over every one of the three, because the operator
                  must never have to wonder whether a value belongs to one
                  automation: there is no deadline of this automation and no
                  goodbye of that one. */}
                    <StatusBadge state="info" dot={false}>
                      {t("settings.conversationScope")}
                    </StatusBadge>
                  </div>

                  <Field
                    id={waitFieldId}
                    type="number"
                    inputMode="numeric"
                    className="mc-input--narrow"
                    label={t("settings.waitLabel")}
                    tip={t("settings.waitTip")}
                    // The bounds are the instance's own, carried in the answer:
                    // nothing here writes 168 down a second time, so the day the
                    // rule moves the field moves with it.
                    min={settings.stored.limits.waitHoursMin}
                    max={settings.stored.limits.waitHoursMax}
                    hint={hintWithEcho(
                      t("settings.waitHint", {
                        min: settings.stored.limits.waitHoursMin,
                        max: settings.stored.limits.waitHoursMax,
                      }),
                      waitEcho(numberFrom(draft.waitHours), t),
                    )}
                    error={refusalOf("waitHours")}
                    value={draft.waitHours}
                    onChange={(event): void => {
                      setDraft({ ...draft, waitHours: event.target.value });
                    }}
                  />

                  <div className="mc-field">
                    <span className="mc-field__label" id={waitScopeId}>
                      {t("settings.waitScopeLabel")}
                    </span>
                    <p className="mc-field__tip">
                      {t("settings.waitScopeTip")}
                    </p>
                    <div className="mc-row" aria-labelledby={waitScopeId}>
                      <Chip tone="accent">
                        {t("settings.waitStepConfirmation")}
                      </Chip>
                      <Chip tone="accent">{t("settings.waitStepEmail")}</Chip>
                      <Chip tone="accent">{t("settings.waitStepFollow")}</Chip>
                    </div>
                  </div>
                </div>

                <div className="mc-panel">
                  <div className="mc-panel__head">
                    <h3>{t("settings.questionsTitle")}</h3>
                    <StatusBadge state="info" dot={false}>
                      {t("settings.conversationScope")}
                    </StatusBadge>
                  </div>

                  {/* The notice that explained the count at length stood here
                until phase 3p and was taken out by name (REQ-323). What the
                operator is still told, and where, did not move: the field's own
                `tip` below says the first question is counted, and the echo
                under it says the arithmetic back for the number typed. The
                RULE is untouched, and it is proved where it happens
                (`src/runtime/confirmation.test.ts`), never by this screen. */}

                  <Field
                    id={questionsFieldId}
                    type="number"
                    inputMode="numeric"
                    className="mc-input--narrow"
                    label={t("settings.questionsLabel")}
                    // The one sentence this field cannot ship without: the count
                    // includes the FIRST question, and "number of attempts" is the
                    // name that made everybody read it as "how many times it may
                    // get it wrong" (REQ-254).
                    tip={t("settings.questionsTip")}
                    min={settings.stored.limits.questionsMin}
                    hint={hintWithEcho(
                      t("settings.questionsHint"),
                      questionsEcho(numberFrom(draft.questions), t),
                    )}
                    error={refusalOf("questions")}
                    value={draft.questions}
                    onChange={(event): void => {
                      setDraft({ ...draft, questions: event.target.value });
                    }}
                  />

                  <TextArea
                    id={closingFieldId}
                    rows={2}
                    className="mc-textarea--compact"
                    label={t("settings.closingLabel")}
                    tip={t("settings.closingTip")}
                    hint={t("settings.closingHint")}
                    error={refusalOf("closingMessage")}
                    toolbar={
                      <Button
                        variant="secondary"
                        onClick={(): void => {
                          // The catalogue's own sentence, the same key the instance
                          // resolves when nothing was written (REQ-255). Restoring
                          // the TEXT is all this can do: the route has no way to
                          // say "hold no value of my own", so a goodbye put back
                          // here and saved is stored explicitly from then on.
                          setDraft({
                            ...draft,
                            closingMessage: t("instance.closingMessage"),
                          });
                        }}
                      >
                        {t("settings.closingReset")}
                      </Button>
                    }
                    value={draft.closingMessage}
                    onChange={(event): void => {
                      setDraft({
                        ...draft,
                        closingMessage: event.target.value,
                      });
                    }}
                  />
                </div>

                <div className="mc-panel">
                  <div className="mc-panel__head">
                    <h3>{t("settings.followTitle")}</h3>
                    <StatusBadge state="info" dot={false}>
                      {t("settings.conversationScope")}
                    </StatusBadge>
                  </div>

                  <Field
                    id={followFieldId}
                    label={t("settings.followLabel")}
                    tip={t("settings.followTip")}
                    // No `maxLength` (REQ-306). It used to carry the instance's
                    // ceiling, and it was the worse half of the pair the refusal
                    // made: past twenty the keyboard simply stopped answering, with
                    // no sentence anywhere saying why. The platform accepts the
                    // longer label and cuts only what it draws, so what the ceiling
                    // earns now is the advice below the field, said while the text
                    // is being typed and with the number in it.
                    toolbar={
                      <span className="mc-source">
                        {t("settings.followCounter", {
                          // What a PERSON counts, and not what `String.length`
                          // answers: an emoji is one character to whoever typed it
                          // and two UTF-16 units to the browser, and a counter
                          // reading 21 beside a label its reader counts as 20 is a
                          // counter arguing with them. The advice below still fires
                          // on the count that reaches the ceiling first, which is
                          // the other one: the two answer different questions.
                          used: measureLength(draft.followButtonLabel)
                            .graphemes,
                          max: settings.stored.limits.followButtonLabelChars,
                        })}
                      </span>
                    }
                    hint={t("settings.followHint", {
                      max: settings.stored.limits.followButtonLabelChars,
                    })}
                    advice={followLabelAdvice(
                      draft.followButtonLabel,
                      settings.stored.limits.followButtonLabelChars,
                      t,
                    )}
                    value={draft.followButtonLabel}
                    onChange={(event): void => {
                      setDraft({
                        ...draft,
                        followButtonLabel: event.target.value,
                      });
                    }}
                  />

                  <div className="mc-field">
                    <span className="mc-field__label" id={followPreviewId}>
                      {t("settings.previewFollowLabel")}
                    </span>
                    <p className="mc-field__tip">
                      {t("settings.previewFollowTip")}
                    </p>
                    <ConversationPreview
                      labelledBy={followPreviewId}
                      t={t}
                      lines={[
                        {
                          id: "follow",
                          step: t("screens.automations.previewStepDirect"),
                          from: "account",
                          text: t("settings.previewFollowText"),
                          quickReply:
                            draft.followButtonLabel.trim() ||
                            t("instance.followButtonLabel"),
                        },
                      ]}
                    />
                  </div>

                  <Notice nature="info" title={t("settings.followRetapTitle")}>
                    {t("settings.followRetap")}
                  </Notice>
                </div>

                {/* The instance's answer to the last write, in the corner and no
              longer in the page (REQ-312). It used to be a box beside the
              button, taking the focus so that it would be seen at all; a toast
              is seen wherever the panel has been scrolled to, which is what
              lets the caret stay on the button the operator is still using.

              The REFUSAL that names a ceiling is still not a field refusal:
              nothing here is drawn under a control, so it goes with the same
              rule as the confirmation. Its sentence is the longest of the two,
              and the reading time is measured from it. */}
                {written !== undefined && "ok" in written ? (
                  <Toast
                    nature="success"
                    title={t("settings.conversationStoredTitle")}
                    message={t("settings.conversationStored")}
                    dismissLabel={t("toast.dismiss")}
                    onDismiss={(): void => setWritten(undefined)}
                  />
                ) : null}

                {refusal !== undefined ? (
                  <Toast
                    nature="error"
                    title={t("settings.conversationNotStoredTitle")}
                    message={t(
                      CONVERSATION_REFUSAL_KEYS[refusal.error] ??
                        UNKNOWN_CONVERSATION_REFUSAL,
                      { count: refusal.limit ?? 0 },
                    )}
                    dismissLabel={t("toast.dismiss")}
                    onDismiss={(): void => setWritten(undefined)}
                  />
                ) : null}
              </>
            ) : null}
          </section>

          {/* The theme, and the one setting on this screen that is not the
          instance's (REQ-326). It is a panel of its own rather than a fourth
          control in the global block for exactly that reason: those hold for
          every browser that signs in, and this one holds for the browser it is
          chosen in. The note says so, and it is the sentence that keeps the
          save button at the foot from looking like it carries this too. */}
          <section
            className="mc-panel mc-jump-target"
            style={FORM_WIDTH}
            id={SETTINGS_BLOCKS.theme}
            tabIndex={-1}
            aria-labelledby={headingIdOf(SETTINGS_BLOCKS.theme)}
          >
            <div className="mc-panel__head">
              <h2
                className="mc-panel__title"
                id={headingIdOf(SETTINGS_BLOCKS.theme)}
              >
                {t("settings.themeTitle")}
              </h2>
            </div>

            <p className="mc-panel__note">{t("settings.themeNote")}</p>

            {/* A `Select`, which is what the two settings above it use: three
            mutually exclusive answers are the same kind of decision as a
            language, and the native control already carries the value
            programmatically, walks with the arrows and announces the option in
            force with no code of ours (REQ-116).

            No pending state and no failure state, because there is no write to
            wait for: `chooseTheme` marks the document and stores the answer on
            this machine, and a store that refuses still leaves the theme
            applied to the page in front of the operator. */}
            <Field id={themeFieldId} label={t("settings.themeLabel")}>
              <Select
                id={themeFieldId}
                value={theme}
                options={THEME_CHOICES.map((choice) => ({
                  value: choice,
                  label: t(THEME_KEYS[choice]),
                }))}
                onChange={(event): void => {
                  const chosen = event.target.value as ThemeChoice;

                  setTheme(chosen);
                  chooseTheme(chosen);
                }}
              />
            </Field>
          </section>

          {/* The two buttons of the global settings, at the END of the screen
          (REQ-324). They are the last thing on the page and no longer a row in
          the middle of it, so whatever the operator changed anywhere above is
          committed from one place, reached by scrolling to the bottom.

          Still drawn only once the four have been READ: a save button over
          values nobody knows would write whatever the empty controls held. */}
          {settings.status === "ready" && draft !== undefined ? (
            <div className="mc-stack" style={FORM_WIDTH}>
              <div className="mc-row">
                <Button
                  variant="primary"
                  pending={saving}
                  onClick={(): void => {
                    void saveConversation();
                  }}
                >
                  {saving
                    ? t("settings.conversationSaving")
                    : t("settings.conversationSave")}
                </Button>
                <Button
                  disabled={saving}
                  onClick={(): void => {
                    discardConversation();
                  }}
                >
                  {t("settings.conversationDiscard")}
                </Button>
              </div>

              <p className="mc-panel__note">
                {t("settings.conversationSaveHint")}
              </p>
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

/** The operational counterpart to application Settings, kept as its own route. */
export function InstanceScreen(): ReactElement {
  return <SettingsScreen view="instance" />;
}
