import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LIMIT_DEFAULTS } from "./limits.js";
import {
  DEFAULT_LOCALE,
  loadCatalogue,
  MISSING_TEXT_KEY,
  useLocale,
} from "../i18n/index.js";
import {
  CLOSING_MESSAGE_TEXT_KEY,
  createInstanceSettingsPreference,
  DEFAULT_QUESTIONS,
  DEFAULT_WAIT_HOURS,
  FOLLOW_BUTTON_LABEL_TEXT_KEY,
  INSTANCE_SETTINGS_REFUSALS,
  MAX_WAIT_HOURS,
  MAX_QUESTIONS,
  MIN_QUESTIONS,
  MIN_WAIT_HOURS,
  createInitialSetupState,
  createIntegrationSettingsPreference,
  defaultInstanceIntegrationDiagnostics,
  readOrCreateLocalEncryptionKey,
} from "./instance-settings.js";
import type {
  InstanceSettingsChange,
  InstanceSettingsPreference,
} from "./instance-settings.js";
import { createSecretCipher } from "../storage/index.js";

/**
 * Proves REQ-252, REQ-254, REQ-255 and REQ-257: four values that stopped being
 * fields of a step and became one document of the instance.
 *
 * What is under test here is the RULE, over a store the test holds in a
 * variable: what the defaults are, which values are refused and with which
 * bound named, and what survives a restart. Two things it deliberately does not
 * do, because they belong where they can be proven and not asserted:
 *
 *   - the deadline reaching a wait, and a wait already counting keeping the one
 *     it was born with (REQ-253), which needs a real engine, a real durable
 *     record and a clock: it lives in `src/runtime/confirmation.test.ts`;
 *   - the values crossing HTTP, which lives in `src/http/api/instance.test.ts`
 *     over the whole composed application.
 */

const NOW = new Date("2026-08-18T09:00:00.000Z");

/** Where the platform truncates a quick reply's title, from the limits. */
const LABEL_CHARS = 20;

interface Harness {
  readonly settings: InstanceSettingsPreference;
  /** A second preference over the SAME row: what a restart is. */
  restart(): InstanceSettingsPreference;
  /** What is actually in the table, for a case that has to write nonsense. */
  put(raw: string): void;
  stored(): string | undefined;
}

/** The byte ceiling a text message is REJECTED past (REQ-344, ADR-028). */
const CLOSING_BYTES = LIMIT_DEFAULTS.messageTextBytes;

function harness(
  labelChars = LABEL_CHARS,
  closingBytes = CLOSING_BYTES,
): Harness {
  let row: string | undefined;

  const build = (): InstanceSettingsPreference =>
    createInstanceSettingsPreference({
      store: {
        read: () => Promise.resolve(row),
        write: (value) => {
          row = value;
          return Promise.resolve();
        },
      },
      now: () => NOW,
      followButtonLabelChars: labelChars,
      closingMessageBytes: closingBytes,
    });

  return {
    settings: build(),
    restart: build,
    put: (raw) => {
      row = raw;
    },
    stored: () => row,
  };
}

/** The sentence a locale carries under a key, read out of the file itself. */
function catalogueText(locale: string, key: string): string {
  const [section, entry] = key.split(".");
  const catalogue = loadCatalogue(locale);
  const group = catalogue[String(section)] as Record<string, string>;
  return group[String(entry)] ?? "";
}

afterEach(async () => {
  // The translator is shared by the whole process: a case that switched the
  // language and left it switched would decide what the NEXT case reads.
  await useLocale(DEFAULT_LOCALE);
});

describe("REQ-447: integration secrets remain encrypted at rest", () => {
  it("round-trips the Meta App Secret without leaving it in the preference row", async () => {
    let row: string | undefined;
    const secret = "Meta-App-Secret-That-Must-Not-Be-Readable";
    const settings = createIntegrationSettingsPreference({
      store: {
        read: () => Promise.resolve(row),
        write: (value) => {
          row = value;
          return Promise.resolve();
        },
      },
      cipher: createSecretCipher(Buffer.alloc(32, 9)),
    });

    await settings.choose({ metaAppSecret: secret }, NOW);

    expect(row).toBeDefined();
    expect(row).not.toContain(secret);
    await expect(settings.read()).resolves.toMatchObject({
      metaAppSecret: secret,
    });
  });
});

describe("REQ-252: the deadline is one setting of the instance", () => {
  it("answers a week on an installation that never chose", async () => {
    const { settings } = harness();

    // The default IS the maximum, and that is only safe because a confirmation
    // is validated by the text of its button (REQ-250): a long deadline used to
    // turn any stray message into consent.
    expect(DEFAULT_WAIT_HOURS).toBe(MAX_WAIT_HOURS);
    expect((await settings.read()).waitHours).toBe(168);
  });

  it("refuses two hundred hours, naming the maximum", async () => {
    const { settings, stored } = harness();

    const refused = await settings.choose({ waitHours: 200 });

    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.refusal.code).toBe(INSTANCE_SETTINGS_REFUSALS.waitHours);
    // The NUMBER travels, because the sentence naming it belongs to the screen
    // and to the catalogue: a refusal that only said "out of range" would leave
    // the operator guessing what to type instead.
    expect(refused.refusal.limit).toBe(MAX_WAIT_HOURS);
    // And nothing was written on the way to the refusal.
    expect(stored()).toBeUndefined();
    expect((await settings.read()).waitHours).toBe(DEFAULT_WAIT_HOURS);
  });

  it("refuses zero hours, naming the minimum", async () => {
    const { settings } = harness();

    const refused = await settings.choose({ waitHours: 0 });

    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.refusal.code).toBe(INSTANCE_SETTINGS_REFUSALS.waitHours);
    // One hour, and the reason is mechanical: the question is enqueued, the
    // sweep collects it seconds later and a send can be deferred until the
    // hourly cap releases it. A shorter deadline can expire before the contact
    // is ever asked, and the trail would then say they did not answer in time.
    expect(refused.refusal.limit).toBe(MIN_WAIT_HOURS);
  });

  it("refuses a deadline that is not a whole number of hours", async () => {
    const { settings } = harness();

    expect((await settings.choose({ waitHours: 1.5 })).ok).toBe(false);
    expect((await settings.choose({ waitHours: Number.NaN })).ok).toBe(false);
  });

  it("accepts both ends of the range", async () => {
    const { settings } = harness();

    expect((await settings.choose({ waitHours: MIN_WAIT_HOURS })).ok).toBe(
      true,
    );
    expect((await settings.read()).waitHours).toBe(MIN_WAIT_HOURS);
    expect((await settings.choose({ waitHours: MAX_WAIT_HOURS })).ok).toBe(
      true,
    );
    expect((await settings.read()).waitHours).toBe(MAX_WAIT_HOURS);
  });

  it("keeps the choice across a restart", async () => {
    const run = harness();

    await run.settings.choose({ waitHours: 24 });

    // A second preference over the same row, which is what a restart is: the
    // whole point of the setting living in the table rather than in a variable.
    expect((await run.restart().read()).waitHours).toBe(24);
  });

  it("falls back to the default when the stored row cannot be honoured", async () => {
    const run = harness();

    // Nothing the panel can produce: only `choose` writes this row and only a
    // value inside the bounds gets through it. Reaching here means the document
    // was edited outside the application, and honouring it would put a deadline
    // nobody could have chosen on every wait from now on.
    run.put(JSON.stringify({ waitHours: 5000 }));
    expect((await run.settings.read()).waitHours).toBe(DEFAULT_WAIT_HOURS);

    run.put("{not json at all");
    expect((await run.settings.read()).waitHours).toBe(DEFAULT_WAIT_HOURS);
  });
});

describe("REQ-254: the number of questions is one setting of the instance", () => {
  it("answers three on an installation that never chose", async () => {
    const { settings } = harness();

    // Three: the first question and two more, which is the number every step
    // declared while it was a field of the step.
    expect((await settings.read()).questions).toBe(3);
    expect(DEFAULT_QUESTIONS).toBe(3);
  });

  it("accepts one, which is asking once and taking the answer or leaving it", async () => {
    const { settings } = harness();

    expect((await settings.choose({ questions: 1 })).ok).toBe(true);
    expect((await settings.read()).questions).toBe(MIN_QUESTIONS);
  });

  it("refuses zero questions, naming the minimum", async () => {
    const { settings } = harness();

    const refused = await settings.choose({ questions: 0 });

    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.refusal.code).toBe(INSTANCE_SETTINGS_REFUSALS.questions);
    // The count includes the FIRST question, so zero describes a step that asks
    // nothing and then waits for the answer to a question never sent.
    expect(refused.refusal.limit).toBe(MIN_QUESTIONS);
  });

  it("refuses a fraction of a question", async () => {
    const { settings } = harness();

    expect((await settings.choose({ questions: 2.5 })).ok).toBe(false);
  });
});

describe("REQ-255: the closing message has a default from the catalogue", () => {
  it("says goodbye in the language the instance is in", async () => {
    const { settings } = harness();

    await useLocale("pt-BR");
    const portuguese = (await settings.read()).closingMessage;

    await useLocale("en");
    const english = (await settings.read()).closingMessage;

    // The sentence is the catalogue's, and the catalogue's is the file's: an
    // assertion against `t()` here would be the code agreeing with itself.
    expect(portuguese).toBe(catalogueText("pt-BR", CLOSING_MESSAGE_TEXT_KEY));
    expect(english).toBe(catalogueText("en", CLOSING_MESSAGE_TEXT_KEY));
    expect(portuguese).not.toBe(english);
    // A key nobody carries renders as the placeholder, which would ship as the
    // goodbye a contact receives.
    expect(portuguese).not.toContain(CLOSING_MESSAGE_TEXT_KEY);
    expect(portuguese).not.toBe(catalogueText("pt-BR", MISSING_TEXT_KEY));
  });

  it("takes the operator's own wording, and keeps it across a restart", async () => {
    const run = harness();
    const OWN = "That is fine. Comment again whenever you like.";

    expect((await run.settings.choose({ closingMessage: OWN })).ok).toBe(true);

    expect((await run.restart().read()).closingMessage).toBe(OWN);
    // And the language no longer decides it: an operator who wrote their own
    // sentence gets that sentence, in whatever language the panel is in.
    await useLocale("pt-BR");
    expect((await run.settings.read()).closingMessage).toBe(OWN);
  });

  it("refuses a goodbye of nothing", async () => {
    const { settings, stored } = harness();

    const refused = await settings.choose({ closingMessage: "   " });

    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    // An empty message is one the contact never receives, which puts the run
    // back in the silence REQ-256 exists to remove.
    expect(refused.refusal.code).toBe(
      INSTANCE_SETTINGS_REFUSALS.closingMessage,
    );
    expect(stored()).toBeUndefined();
  });

  it("leaves the goodbye following the language when another value is written", async () => {
    const run = harness();

    await run.settings.choose({ waitHours: 24 });

    // The trap this guards: a write that stored the four values as they read at
    // that instant would FREEZE the catalogue's sentence into the row, and the
    // instance would go on saying goodbye in the language it happened to be in
    // when somebody changed the deadline.
    await useLocale("pt-BR");
    expect((await run.settings.read()).closingMessage).toBe(
      catalogueText("pt-BR", CLOSING_MESSAGE_TEXT_KEY),
    );
  });
});

describe("REQ-306: the follow button's label is stored past the platform's cut", () => {
  it("has a default from the catalogue, in every language", async () => {
    const { settings } = harness();

    for (const locale of ["en", "pt-BR"]) {
      await useLocale(locale);
      const label = (await settings.read()).followButtonLabel;

      expect(label).toBe(catalogueText(locale, FOLLOW_BUTTON_LABEL_TEXT_KEY));
      // Nothing refuses this any more (REQ-306), and it still has to fit: a
      // default longer than the platform draws would ship an instance whose
      // untouched button arrives cut, with an advice under the field about a
      // text the operator never wrote.
      expect(label.length).toBeLessThanOrEqual(LABEL_CHARS);
    }
  });

  it("stores a label past the ceiling, and stores the whole of it", async () => {
    const { settings } = harness();
    // Longer than the ceiling on purpose, and asserted CHARACTER for character:
    // a rule that silently cut the label to twenty would answer `ok` here too,
    // and the operator would only find out on the contact's screen.
    const long = `${"a".repeat(LABEL_CHARS)}bcdefg`;

    expect((await settings.choose({ followButtonLabel: long })).ok).toBe(true);
    expect((await settings.read()).followButtonLabel).toBe(long);
  });

  it("hands a stored label back whole after a restart, however long", async () => {
    // The READ side of REQ-306, and the half that would have survived the
    // refusal's removal on its own: this used to drop a row longer than the
    // ceiling and answer the catalogue's default in its place, so a write that
    // succeeded would come back as a button the operator never wrote.
    const run = harness();
    const long = "Já segui a sua conta agora mesmo, pode mandar";

    await run.settings.choose({ followButtonLabel: long });

    expect((await run.restart().read()).followButtonLabel).toBe(long);
  });

  it("accepts a label of exactly twenty characters", async () => {
    const { settings } = harness();
    const exact = "a".repeat(LABEL_CHARS);

    expect((await settings.choose({ followButtonLabel: exact })).ok).toBe(true);
    expect((await settings.read()).followButtonLabel).toBe(exact);
  });

  it("publishes the ceiling the platform limits declare, not a literal", async () => {
    // The number is `quickReplyLabelChars`, which an installation may tune. It
    // refuses nothing: it travels to the screen, which warns with it that a
    // longer label will arrive cut. A twenty written into this rule would warn
    // about a cut such an instance does not make.
    const { settings } = harness(12);

    expect(settings.bounds.followButtonLabelChars).toBe(12);
    expect(
      (await settings.choose({ followButtonLabel: "a".repeat(13) })).ok,
    ).toBe(true);
    expect((await settings.read()).followButtonLabel).toBe("a".repeat(13));
  });

  it("publishes the bounds every field has to be offered between", async () => {
    const { settings } = harness();

    // Read from here rather than copied into the browser: a second 168 living
    // in a screen is one that goes wrong the day this one moves.
    expect(settings.bounds).toEqual({
      waitHoursMin: MIN_WAIT_HOURS,
      waitHoursMax: MAX_WAIT_HOURS,
      questionsMin: MIN_QUESTIONS,
      questionsMax: MAX_QUESTIONS,
      closingMessageBytes: CLOSING_BYTES,
      followButtonLabelChars: LABEL_CHARS,
    });
    expect((await settings.read()).waitHours).toBeLessThanOrEqual(
      settings.bounds.waitHoursMax,
    );
  });
});

describe("REQ-345: the number of questions has a ceiling", () => {
  it("refuses a value above the maximum, naming it", async () => {
    const { settings } = harness();

    const choice = await settings.choose({ questions: MAX_QUESTIONS + 1 });

    expect(choice.ok).toBe(false);
    if (choice.ok) return;
    expect(choice.refusal.code).toBe(INSTANCE_SETTINGS_REFUSALS.questions);
    // The number travels so the screen can say it without a second copy.
    expect(choice.refusal.limit).toBe(MAX_QUESTIONS);
  });

  it("accepts the maximum itself", async () => {
    const { settings } = harness();

    expect((await settings.choose({ questions: MAX_QUESTIONS })).ok).toBe(true);
    expect((await settings.read()).questions).toBe(MAX_QUESTIONS);
  });
});

describe("REQ-344: the closing message is measured against the platform ceiling", () => {
  it("refuses a goodbye past the byte ceiling, naming it", async () => {
    const { settings } = harness();

    const choice = await settings.choose({
      closingMessage: "a".repeat(CLOSING_BYTES + 1),
    });

    expect(choice.ok).toBe(false);
    if (choice.ok) return;
    expect(choice.refusal.code).toBe(
      INSTANCE_SETTINGS_REFUSALS.closingMessageTooLong,
    );
    expect(choice.refusal.limit).toBe(CLOSING_BYTES);
  });

  it("counts BYTES and not characters, because the platform counts UTF-8", async () => {
    const { settings } = harness();

    // Every accent costs two, so this is inside the ceiling in characters and
    // outside it in bytes. Counting characters would let it through and the
    // send would fail at DELIVERY, where nothing can be done about it.
    const accented = "á".repeat(CLOSING_BYTES - 1);
    expect(accented.length).toBeLessThanOrEqual(CLOSING_BYTES);

    const choice = await settings.choose({ closingMessage: accented });

    expect(choice.ok).toBe(false);
    if (choice.ok) return;
    expect(choice.refusal.code).toBe(
      INSTANCE_SETTINGS_REFUSALS.closingMessageTooLong,
    );
  });

  it("still refuses an empty goodbye, for its own reason", async () => {
    const { settings } = harness();

    const choice = await settings.choose({ closingMessage: "   " });

    expect(choice.ok).toBe(false);
    if (choice.ok) return;
    expect(choice.refusal.code).toBe(INSTANCE_SETTINGS_REFUSALS.closingMessage);
  });
});

describe("a write is refused as a whole, or stored as a whole", () => {
  it("stores nothing when one value of several is impossible", async () => {
    const run = harness();
    const change: InstanceSettingsChange = {
      waitHours: 24,
      // The goodbye is what breaks it, not the label: how long a label is
      // refuses nothing any more (REQ-306), so a case built on it would prove
      // the whole write is atomic by never refusing at all.
      closingMessage: "   ",
    };

    expect((await run.settings.choose(change)).ok).toBe(false);

    // Half a write would leave the instance in a state the operator never
    // asked for, with the screen showing one of the two values it sent.
    expect(run.stored()).toBeUndefined();
    expect((await run.settings.read()).waitHours).toBe(DEFAULT_WAIT_HOURS);
  });

  it("leaves untouched every value the write does not name", async () => {
    const run = harness();

    await run.settings.choose({ questions: 2, followButtonLabel: "Done" });
    await run.settings.choose({ waitHours: 48 });

    const after = await run.settings.read();
    expect(after).toMatchObject({
      waitHours: 48,
      questions: 2,
      followButtonLabel: "Done",
    });
  });
});

describe("REQ-441: first setup state and local encryption key", () => {
  const directories: string[] = [];

  afterEach(() => {
    while (directories.length > 0) {
      rmSync(directories.pop() ?? "", { recursive: true, force: true });
    }
  });

  it("marks initial setup durably and never treats another value as complete", async () => {
    let value: string | undefined;
    const state = createInitialSetupState({
      read: () => Promise.resolve(value),
      write: (next) => {
        value = next;
        return Promise.resolve();
      },
    });

    await expect(state.isComplete()).resolves.toBe(false);
    await state.complete(NOW);
    await expect(state.isComplete()).resolves.toBe(true);

    value = "not-complete";
    await expect(state.isComplete()).resolves.toBe(false);
  });

  it("generates the local key once, keeps it after restart, and restricts its mode", () => {
    const directory = mkdtempSync(join(tmpdir(), "mychat-key-"));
    directories.push(directory);
    const path = join(directory, "secrets.key");

    const first = readOrCreateLocalEncryptionKey(path);
    const second = readOrCreateLocalEncryptionKey(path);

    expect(first).toHaveLength(32);
    expect(second.equals(first)).toBe(true);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });
});

describe("REQ-436/REQ-439: integration diagnostic baseline", () => {
  it("identifies local storage without implying it is a database backup", () => {
    expect(defaultInstanceIntegrationDiagnostics()).toEqual({
      meta: { status: "pending" },
      storage: { driver: "local", status: "healthy" },
    });
  });
});
