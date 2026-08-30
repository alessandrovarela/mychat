import { t } from "../i18n/index.js";

/**
 * What the INSTANCE decides about waiting, and what a step stopped deciding
 * (REQ-252, REQ-253, REQ-254, REQ-255, REQ-257).
 *
 * Four values in ONE document out of `instance_preferences`, exactly like the
 * emergency switches beside them: one row, one JSON, and an absent row meaning
 * a fresh installation. They are deliberately not environment variables. The
 * environment is where a limit of the PLATFORM is declared (`limits.ts`, and
 * REQ-079 about where those numbers come from); these are policy of whoever
 * operates the account, changed from the panel while the process runs.
 *
 * Why they stopped being fields of a step: the deadline appeared three times on
 * one screen, asking for three numbers nobody has any basis to tell apart, and
 * the author of the product had to ask what they were for. What a step still
 * decides is WHAT COUNTS AS AN ANSWER. How long to wait for one, how many times
 * to insist, how to say goodbye and what the follow button says are hygiene of
 * the instance, and one answer serves every step that waits.
 *
 * Two of the four have their default in the LOCALE CATALOGUE rather than here,
 * and they are read at every read for that reason: an instance whose operator
 * never wrote a closing message says goodbye in the language the instance is
 * in, and switching the language switches the sentence. A default frozen into
 * this file would be English for everybody, for ever.
 */

/** The row that carries the four values in `instance_preferences`. */
export const INSTANCE_SETTINGS_PREFERENCE_KEY = "instanceSettings";

/**
 * The shortest deadline that can be honoured, and the reason is mechanical
 * rather than comfort: the question is ENQUEUED, never sent on the spot. The
 * sweep runs every five seconds by default, and a send can be deferred until
 * the hourly cap's window releases it. A shorter deadline can therefore expire
 * BEFORE the contact is ever asked, and the trail would then record "did not
 * answer in time" about a question nobody received, which is a lie the operator
 * has no way of catching.
 */
export const MIN_WAIT_HOURS = 1;

/**
 * A week, and also the default.
 *
 * The long default is safe only because the confirmation is validated by the
 * text of its button (REQ-250): while any message at all counted as a yes, a
 * long deadline manufactured consent out of whatever happened to arrive days
 * later. It is the maximum too, because past a week the wait stops being
 * hygiene of the system and becomes a run resuming into a definition that has
 * since been edited.
 */
export const MAX_WAIT_HOURS = 168;

export const DEFAULT_WAIT_HOURS = MAX_WAIT_HOURS;

/**
 * At least one, because the count includes the FIRST question (REQ-254): zero
 * would describe a step that asks nothing and then waits for the answer to a
 * question that never went out.
 *
 * There is no maximum, and that absence is deliberate. What bounds the asking
 * is the deadline above, which no number here can outlive, so a ceiling would
 * be a figure invented in this file and defended by nothing.
 */
export const MIN_QUESTIONS = 1;

/**
 * Three: the first question and two more. It is the number every step in this
 * project declared while `max_attempts` was a field of the step, so an
 * installation that never opens Settings behaves exactly as it did.
 */
export const DEFAULT_QUESTIONS = 3;

/**
 * The ceiling of re-asks, which did not exist until 2026-08-20 (REQ-345).
 *
 * REQ-254 declares no maximum, and the executor of task 3l.3 deliberately did
 * not invent one, which was right: it is a product number, not an
 * implementation detail. The consequence was that the panel accepted ten
 * thousand, and a value nobody can mean is a field that refuses nothing.
 *
 * TEN, and the reasoning is written so it can be argued with: every question is
 * a message that spends the hourly cap and the contact's patience, the default
 * is three, and the deadline already ends the insistence in clock time. Ten is
 * generous against a default of three and still a number a person could have
 * meant. Changing it is one line here, and it is the operator's call, not this
 * module's.
 */
export const MAX_QUESTIONS = 10;

/** Catalogue key of the goodbye an operator has not rewritten (REQ-255). */
export const CLOSING_MESSAGE_TEXT_KEY = "instance.closingMessage";

/** Catalogue key of the follow button an operator has not renamed (REQ-257). */
export const FOLLOW_BUTTON_LABEL_TEXT_KEY = "instance.followButtonLabel";

export interface InstanceSettings {
  /**
   * One deadline for the three steps that wait, in hours (REQ-252). It is
   * counted from the moment the step asks, so each step gets the whole of it.
   */
  readonly waitHours: number;
  /** How many times a step may ask, the first question included (REQ-254). */
  readonly questions: number;
  /** What is said when the questions run out (REQ-255). */
  readonly closingMessage: string;
  /** What the button of "ask to follow" says, and what answers it (REQ-257). */
  readonly followButtonLabel: string;
}

/**
 * Why a value was not stored, as a stable code with the bound it broke.
 *
 * The code travels and the sentence does not: the number is named to the
 * operator by the screen, out of the catalogue (REQ-073), and `limit` is what
 * lets that sentence say 168 without a second copy of it living in the browser.
 */
export const INSTANCE_SETTINGS_REFUSALS = {
  waitHours: "wait_hours_out_of_range",
  questions: "questions_out_of_range",
  closingMessage: "closing_message_empty",
  closingMessageTooLong: "closing_message_too_long",
} as const;

export type InstanceSettingsRefusalCode =
  (typeof INSTANCE_SETTINGS_REFUSALS)[keyof typeof INSTANCE_SETTINGS_REFUSALS];

export interface InstanceSettingsRefusal {
  readonly code: InstanceSettingsRefusalCode;
  /** The bound the value broke: the maximum it passed, or the minimum it fell under. */
  readonly limit?: number;
}

/**
 * What one write carries. Every field is optional, and an absent one leaves
 * the stored value exactly where it was: the screen may offer the four
 * together, but a caller changing the deadline must not have to resend a
 * closing message it never read.
 */
export interface InstanceSettingsChange {
  readonly waitHours?: number;
  readonly questions?: number;
  readonly closingMessage?: string;
  readonly followButtonLabel?: string;
}

export type InstanceSettingsChoice =
  | { readonly ok: true; readonly settings: InstanceSettings }
  | { readonly ok: false; readonly refusal: InstanceSettingsRefusal };

export interface InstanceSettingsStore {
  /** Undefined when nothing was ever written: a fresh installation. */
  read(): Promise<string | undefined>;
  write(value: string, now: Date): Promise<void>;
}

/** The read half, which is all the runtime needs from this. */
export interface InstanceSettingsReader {
  /**
   * Asked on EVERY read, never captured. A caller that keeps the answer has
   * pinned the instance to the moment it asked, which is the defect REQ-183
   * removed from the time zone and must not come back here.
   */
  read(): Promise<InstanceSettings>;
}

/**
 * The bounds a value has to live between, as data rather than as knowledge the
 * screen is expected to already have.
 *
 * Four of them are constants of this module and two are limits of the
 * platform, and the screen needs every one for the same reason it needs the
 * list of time zones: a field that cannot see its own ceiling carries a second
 * copy of 168 (wrong the day the first one moves), or says nothing at all about
 * the one number an operator has no way to guess.
 *
 * They divide by what happens PAST them, which is ADR-028. `waitHours`,
 * `questions` and `closingMessageBytes` are where a value stops being
 * ACCEPTED, because past them the write is refused or the platform rejects the
 * send. `followButtonLabelChars` is where the platform stops DRAWING, and it
 * refuses nothing (REQ-306): the screen warns with it, and the write stores
 * past it.
 */
export interface InstanceSettingsBounds {
  readonly waitHoursMin: number;
  readonly waitHoursMax: number;
  readonly questionsMin: number;
  readonly questionsMax: number;
  /**
   * Where the platform REJECTS a text message, from
   * `PlatformLimits.messageTextBytes` (REQ-344).
   *
   * Unlike the label ceiling below, this one REFUSES, and the difference is
   * the whole of ADR-028: past it the platform returns an error and the
   * message never leaves, so a goodbye written too long would fail at DELIVERY
   * and not at the save, which is the only moment there is still something to
   * do about it. Every step's wording has been measured against it since
   * REQ-087; the closing message is written in the settings and was only ever
   * refused for being EMPTY.
   *
   * Bytes and not characters, because the platform counts UTF-8: in Portuguese
   * every accent costs two, so a goodbye of a thousand characters can be over
   * the limit without looking long.
   */
  readonly closingMessageBytes: number;
  readonly followButtonLabelChars: number;
}

export interface InstanceSettingsPreference extends InstanceSettingsReader {
  /** What a value is allowed to be, for whoever has to offer the field. */
  readonly bounds: InstanceSettingsBounds;
  /** The panel's write: refused as a whole, or stored as a whole. */
  choose(change: InstanceSettingsChange): Promise<InstanceSettingsChoice>;
}

export interface InstanceSettingsDeps {
  /** Where the platform REJECTS a text message, from `PlatformLimits`. */
  readonly closingMessageBytes: number;
  readonly store: InstanceSettingsStore;
  readonly now: () => Date;
  /**
   * Where the platform truncates the title of a quick reply, from
   * `PlatformLimits.quickReplyLabelChars` (REQ-257, `docs/platform-limits.md`).
   *
   * It refuses NOTHING (REQ-306). It is published in `bounds` so the panel can
   * warn, while the text is being typed, that a longer label will arrive cut on
   * the contact's screen. The measurement on the real account on 2026-08-19
   * settled which of the two it is: a quick reply of 67 characters was
   * accepted, the button showed 35 of them with an ellipsis, and the webhook
   * echo came back with all 67.
   *
   * Injected rather than written here as twenty, because it is a limit of the
   * PLATFORM and those live in configuration (KEEL): the number the panel warns
   * with and the number validation predicts a cut at have to be the same one,
   * or a screen and an automation describe different platforms.
   */
  readonly followButtonLabelChars: number;
}

/** The stored document, whose every field may be absent or nonsense. */
interface StoredSettings {
  readonly waitHours?: unknown;
  readonly questions?: unknown;
  readonly closingMessage?: unknown;
  readonly followButtonLabel?: unknown;
}

function storedNumber(
  value: unknown,
  minimum: number,
  maximum: number | undefined,
): number | undefined {
  if (typeof value !== "number" || !Number.isInteger(value)) return undefined;
  if (value < minimum) return undefined;
  if (maximum !== undefined && value > maximum) return undefined;
  return value;
}

/**
 * A stored text, or nothing when the row holds no usable one.
 *
 * NO ceiling here, and that is the read side of REQ-306. Until phase 3o this
 * took a maximum and answered `undefined` past it, so a label longer than the
 * platform's truncation point was quietly replaced by the catalogue's default
 * on the way out. With the refusal gone that would be the worse half of the
 * pair: the write succeeds, the operator's words are kept in the table, and
 * every read hands back a button they never wrote.
 */
function storedText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed === "") return undefined;
  return trimmed;
}

function parse(raw: string | undefined): StoredSettings {
  if (raw === undefined) return {};

  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed))
      return parsed as StoredSettings;
  } catch {
    // A row nothing can read falls back to the defaults rather than throwing,
    // for the reason the emergency switches do the same: this document decides
    // how long a contact is waited for, and a process that refuses to start
    // over a malformed setting helps nobody.
  }

  return {};
}

export function createInstanceSettingsPreference(
  deps: InstanceSettingsDeps,
): InstanceSettingsPreference {
  const read = async (): Promise<InstanceSettings> => {
    const stored = parse(await deps.store.read());

    return {
      waitHours:
        storedNumber(stored.waitHours, MIN_WAIT_HOURS, MAX_WAIT_HOURS) ??
        DEFAULT_WAIT_HOURS,
      questions:
        storedNumber(stored.questions, MIN_QUESTIONS, undefined) ??
        DEFAULT_QUESTIONS,
      // The catalogue's, and looked up HERE rather than at composition time:
      // the instance's language can change without a restart, and so must the
      // sentence an operator never rewrote.
      closingMessage:
        storedText(stored.closingMessage) ?? t(CLOSING_MESSAGE_TEXT_KEY),
      followButtonLabel:
        storedText(stored.followButtonLabel) ?? t(FOLLOW_BUTTON_LABEL_TEXT_KEY),
    };
  };

  return {
    read,

    bounds: {
      waitHoursMin: MIN_WAIT_HOURS,
      waitHoursMax: MAX_WAIT_HOURS,
      questionsMin: MIN_QUESTIONS,
      questionsMax: MAX_QUESTIONS,
      closingMessageBytes: deps.closingMessageBytes,
      followButtonLabelChars: deps.followButtonLabelChars,
    },

    choose: async (
      change: InstanceSettingsChange,
    ): Promise<InstanceSettingsChoice> => {
      const refusal = refuse(change, {
        closingMessageBytes: deps.closingMessageBytes,
      });

      if (refusal !== undefined) {
        // Refused as a WHOLE, and nothing is written: a write carrying a good
        // deadline and an impossible label must not leave the instance half
        // changed, with the screen showing one of the two it asked for.
        return { ok: false, refusal };
      }

      // The document as it STANDS, not as it reads: a field the write does not
      // name stays exactly as absent (or as present) as it was. Composing the
      // new row out of `read()` instead would freeze the catalogue's goodbye
      // into it the first time anybody changed the deadline, and the instance
      // would go on saying goodbye in whatever language it was in that day.
      const previous = parse(await deps.store.read());
      const next = {
        waitHours: change.waitHours ?? previous.waitHours,
        questions: change.questions ?? previous.questions,
        closingMessage:
          change.closingMessage?.trim() ?? previous.closingMessage,
        followButtonLabel:
          change.followButtonLabel?.trim() ?? previous.followButtonLabel,
      };

      await deps.store.write(JSON.stringify(next), deps.now());

      return { ok: true, settings: await read() };
    },
  };
}

/**
 * A reader that answers the defaults, or whatever it is told, with no store
 * behind it.
 *
 * Here rather than rewritten wherever a runtime is composed without a database:
 * a caller carrying its own copy of "a week, three questions" would go on
 * answering the old numbers after the defaults above moved, which is exactly
 * the drift that brought these values into one file. It is the same shape as
 * `createMemoryAssets` in storage: the real contract, over nothing.
 */
export function fixedInstanceSettings(
  overrides: Partial<InstanceSettings> = {},
): InstanceSettingsReader {
  return {
    read: (): Promise<InstanceSettings> =>
      Promise.resolve({
        waitHours: DEFAULT_WAIT_HOURS,
        questions: DEFAULT_QUESTIONS,
        closingMessage: t(CLOSING_MESSAGE_TEXT_KEY),
        followButtonLabel: t(FOLLOW_BUTTON_LABEL_TEXT_KEY),
        ...overrides,
      }),
  };
}

/**
 * The first thing wrong with a write, or nothing.
 *
 * One refusal and not a list, because every value judged here has a single
 * bound: an operator meeting "the deadline goes up to 168" fixes the deadline,
 * and a second sentence about the question count they also got wrong is one
 * they will meet the moment they try again.
 */
function refuse(
  change: InstanceSettingsChange,
  ceilings: { readonly closingMessageBytes: number },
): InstanceSettingsRefusal | undefined {
  // The label is deliberately NOT taken out of the change: nothing here judges
  // it (REQ-306), and a name bound to a value nobody reads is the first half of
  // a rule somebody adds back by accident.
  const { waitHours, questions, closingMessage } = change;

  if (waitHours !== undefined) {
    if (!Number.isInteger(waitHours) || waitHours < MIN_WAIT_HOURS) {
      return {
        code: INSTANCE_SETTINGS_REFUSALS.waitHours,
        limit: MIN_WAIT_HOURS,
      };
    }
    if (waitHours > MAX_WAIT_HOURS) {
      return {
        code: INSTANCE_SETTINGS_REFUSALS.waitHours,
        limit: MAX_WAIT_HOURS,
      };
    }
  }

  if (
    questions !== undefined &&
    (!Number.isInteger(questions) || questions < MIN_QUESTIONS)
  ) {
    return {
      code: INSTANCE_SETTINGS_REFUSALS.questions,
      limit: MIN_QUESTIONS,
    };
  }

  if (questions !== undefined && questions > MAX_QUESTIONS) {
    return {
      code: INSTANCE_SETTINGS_REFUSALS.questions,
      limit: MAX_QUESTIONS,
    };
  }

  if (
    closingMessage !== undefined &&
    Buffer.byteLength(closingMessage, "utf8") > ceilings.closingMessageBytes
  ) {
    return {
      code: INSTANCE_SETTINGS_REFUSALS.closingMessageTooLong,
      limit: ceilings.closingMessageBytes,
    };
  }

  if (closingMessage !== undefined && closingMessage.trim() === "") {
    // A goodbye of nothing is a message the contact never receives, and the
    // step that sends it would end in the silence REQ-256 exists to remove.
    return { code: INSTANCE_SETTINGS_REFUSALS.closingMessage };
  }

  // How LONG the label is refuses nothing (REQ-306). The platform accepts the
  // whole of it and cuts only what it draws, so a rule turning that cut into a
  // refusal would turn away a button the platform itself delivers.

  return undefined;
}
