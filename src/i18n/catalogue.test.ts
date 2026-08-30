import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { globSync } from "node:fs";
import ts from "typescript";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SilenceCode } from "../dashboard/aggregate.js";
import {
  EXECUTION_FAILURE_REASONS,
  SUPPRESSION_REASONS,
} from "../engine/execute.js";
import type {
  ExecutionFailureReason,
  SuppressionReason,
} from "../engine/execute.js";
import { MATCH_REFUSALS } from "../flows/matching.js";
import type { AuditOutcome } from "../storage/audit.js";
import {
  actionOutcomeTextKey,
  ACTIVITY_OUTCOMES,
  ACTIVITY_SILENCES,
  activityReasonKeys,
  activitySilenceTextKey,
  arrivalTextKey,
  actionReasonTextKey,
  engineReasonKeys,
  executionFailureTextKey,
  matchRefusalTextKey,
  suppressionTextKey,
} from "./engine-reasons.js";
import type { ActivityOutcome, ActivitySilence } from "./engine-reasons.js";
import {
  availableLocales,
  currentLocale,
  DEFAULT_LOCALE,
  loadCatalogue,
  MISSING_TEXT_KEY,
  t,
  useLocale,
} from "./index.js";
import { createTranslator } from "./translator.js";

/**
 * Proves REQ-073: no operator-facing text is embedded in the code, and adding
 * a language means adding a catalogue rather than changing code.
 *
 * The requirement has two halves, and only testing both is worth anything. A
 * project can move every string into a catalogue and still hard-code the list
 * of locales, which satisfies the first half while quietly breaking the second
 * — the half that actually decides whether a contributor can ship a
 * translation without touching TypeScript.
 */

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const localesDir = fileURLToPath(new URL("locales", import.meta.url));

describe("REQ-073: operator-facing text lives in catalogues", () => {
  it("ships at least the two locales the v0.1 promises", () => {
    expect(availableLocales()).toEqual(expect.arrayContaining(["en", "pt-BR"]));
  });

  it("resolves a key through the catalogue, interpolating by name", () => {
    const message = t("config.missingEnvVariables", { variables: "A, B" });

    expect(message).toContain("A, B");
    // The key itself leaking into operator-facing output means the lookup
    // silently missed, which is worse than an obvious failure.
    expect(message).not.toContain("config.missingEnvVariables");
  });

  it("keeps every locale at key parity with the default (criterion 46)", () => {
    /**
     * A gap here is a sentence that silently falls back to English in the
     * middle of an otherwise translated message.
     *
     * Parity is on the key a CALLER names, which for a plural sentence is the
     * base: how many forms sit under it is the language's business and not a
     * thing two catalogues have to agree on. Portuguese selects a category
     * English has no use for (`_many`, from a million on), so path parity would
     * make writing the Portuguese sentence correctly a red gate. What holds the
     * forms themselves to their language is REQ-190 below, and that check is
     * stricter than parity ever was: parity would have accepted `_one`/`_other`
     * in pt-BR, which is exactly the shape that ships English.
     */
    const reference = [...bases(flatten(loadCatalogue(DEFAULT_LOCALE)))].sort();

    for (const locale of availableLocales()) {
      expect(
        [...bases(flatten(loadCatalogue(locale)))].sort(),
        `locale ${locale}`,
      ).toEqual(reference);
    }
  });

  it("carries the placeholder itself in every locale", () => {
    // Guards the guard of REQ-075: the text shown when a key is missing
    // everywhere is a catalogue entry like any other, and a build that lost it
    // would answer an empty string instead.
    for (const locale of availableLocales()) {
      expect(flatten(loadCatalogue(locale)), `locale ${locale}`).toContain(
        MISSING_TEXT_KEY,
      );
    }
  });
});

describe("REQ-075: a gap in the chosen catalogue (criterion 45)", () => {
  /**
   * Invented catalogues, because the shipped ones are at parity and a gap is
   * exactly what this has to exercise. The rules under test belong to
   * `createTranslator`, which is the same code the interface runs.
   */
  const TRANSLATED = "translated";
  const ONLY_ENGLISH = "onlyEnglish";
  const NOWHERE = "nowhere.at.all";

  const catalogues = {
    en: {
      [TRANSLATED]: "English text",
      [ONLY_ENGLISH]: "English only",
      catalogue: { missingText: "(no text)" },
    },
    "pt-BR": {
      [TRANSLATED]: "Texto em português",
      catalogue: { missingText: "(sem texto)" },
    },
  };

  it("shows the English text for a key the chosen locale does not carry", () => {
    const translator = createTranslator(catalogues, "pt-BR");

    expect(translator.t(TRANSLATED)).toBe("Texto em português");
    expect(translator.t(ONLY_ENGLISH)).toBe("English only");
  });

  it("never shows the internal key when no catalogue has it", () => {
    const translator = createTranslator(catalogues, "pt-BR");

    const shown = translator.t(NOWHERE);

    // The defect this task was written to fix: i18next renders the key by
    // default, and REQ-075 forbids exactly that. The assertion is on the KEY
    // and not on the placeholder's wording, so choosing different words later
    // does not need this test rewritten.
    expect(shown).not.toContain(NOWHERE);
    expect(shown).toBe("(sem texto)");
  });

  it("does not fail the operation over a missing key", () => {
    const translator = createTranslator(catalogues, "pt-BR");

    // Interpolation values for a key that does not exist, which is what a
    // half-renamed call site looks like: still a string, still no throw.
    expect(() => translator.t(NOWHERE, { count: 3 })).not.toThrow();
    expect(typeof translator.t(NOWHERE, { count: 3 })).toBe("string");
  });

  it("shows the placeholder in the language in force", async () => {
    const translator = createTranslator(catalogues, "pt-BR");

    await translator.use("en");

    expect(translator.t(NOWHERE)).toBe("(no text)");
  });

  it("answers a string even when the placeholder itself is missing", () => {
    // The recursion guard: looking the placeholder up would call the missing
    // key handler again, and again.
    const stripped = createTranslator({ en: { [TRANSLATED]: "text" } });

    expect(stripped.t(NOWHERE)).toBe("");
    expect(stripped.t(MISSING_TEXT_KEY)).toBe("");
  });
});

describe("REQ-073: adding a language is adding a catalogue", () => {
  const invented = `zz-ZZ`;
  /**
   * A directory of its own, and that is the point rather than tidiness.
   *
   * Writing the invented locale into the REAL `locales/` folder made this suite
   * flaky: `src/i18n/index.ts` reads that directory at import time, every test
   * file imports it, and Vitest runs files in parallel. A sibling file
   * importing i18n between the write and the cleanup would list `zz-ZZ` and
   * then fail to read it, taking down a suite that has nothing to do with
   * locales. That happened, twice, and blocked a commit at the gate.
   *
   * Discovery is directory-driven, so proving it against a directory the test
   * owns proves exactly the same thing: a file appears, and the application
   * knows the language.
   */
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "mychat-locales-"));
    for (const locale of availableLocales()) {
      writeFileSync(
        `${dir}/${locale}.json`,
        readFileSync(`${localesDir}/${locale}.json`, "utf8"),
        "utf8",
      );
    }
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("discovers a locale that did not exist when the code was written", () => {
    // The proof proper: a file appears, and the application knows the language.
    // No registry to edit, no switch to extend, no code touched.
    expect(availableLocales(dir)).not.toContain(invented);

    writeFileSync(
      `${dir}/${invented}.json`,
      readFileSync(`${localesDir}/en.json`, "utf8"),
      "utf8",
    );

    expect(availableLocales(dir)).toContain(invented);
  });
});

describe("REQ-073: locale selection never blocks the process", () => {
  it("falls back to the default when asked for a locale that does not exist", async () => {
    // A misconfigured language must not stop the process from reporting the
    // very error that would explain the misconfiguration.
    const chosen = await useLocale("xx-XX");

    expect(chosen).toBe(DEFAULT_LOCALE);
    expect(currentLocale()).toBe(DEFAULT_LOCALE);
  });

  it("switches to a locale that exists and renders its text", async () => {
    await useLocale("pt-BR");
    const translated = t("config.missingEnvVariables", { variables: "A" });

    await useLocale(DEFAULT_LOCALE);
    const original = t("config.missingEnvVariables", { variables: "A" });

    expect(translated).not.toBe(original);
    expect(translated).toContain("A");
  });
});

describe("REQ-073: no operator-facing literal survives in the code", () => {
  /**
   * Walks every `new SomethingError(...)` and demands its message argument be
   * a call (the catalogue lookup) rather than a literal. Parsing, not matching
   * text: a regex over source would flag the catalogue keys themselves, the
   * test fixtures, and every comment that happens to quote a message.
   */
  function literalErrorMessages(file: string): string[] {
    const source = ts.createSourceFile(
      file,
      readFileSync(file, "utf8"),
      ts.ScriptTarget.ESNext,
      true,
    );

    const offenders: string[] = [];

    const visit = (node: ts.Node): void => {
      if (ts.isNewExpression(node) && ts.isIdentifier(node.expression)) {
        const constructor = node.expression.text;
        const [message] = node.arguments ?? [];

        const isProjectError =
          constructor.endsWith("Error") && constructor !== "Error";
        const isLiteral =
          message !== undefined &&
          (ts.isStringLiteral(message) ||
            ts.isTemplateExpression(message) ||
            ts.isNoSubstitutionTemplateLiteral(message));

        if (isProjectError && isLiteral) {
          offenders.push(
            `${file.replace(repoRoot, "")}: new ${constructor}(<literal>)`,
          );
        }
      }
      ts.forEachChild(node, visit);
    };

    visit(source);
    return offenders;
  }

  it("finds production sources to check", () => {
    // Guards the guard: a glob matching nothing would pass while proving
    // nothing at all.
    expect(productionFiles().length).toBeGreaterThan(5);
  });

  it("throws no error built from a hard-coded message", () => {
    expect(productionFiles().flatMap(literalErrorMessages)).toStrictEqual([]);
  });
});

describe("REQ-074: every key the code asks for exists in the catalogue", () => {
  it("finds sources on both sides of the boundary to check", () => {
    // Guards the guard, twice: the backend glob and the interface glob each
    // have to match something, or half the application goes unchecked while
    // the suite stays green.
    expect(productionFiles().length).toBeGreaterThan(5);
    expect(interfaceFiles().length).toBeGreaterThan(0);
  });

  it("recognises a catalogue lookup when it sees one", () => {
    // The walker itself, on a fixture: a check that silently found no lookups
    // would pass the test below while proving nothing.
    const found = catalogueKeysIn(
      parseSource(
        "fixture.ts",
        `t("a.plain"); t(flag ? "a.yes" : "a.no"); t(variable);`,
      ),
    );

    expect(found).toEqual([
      { file: "fixture.ts", key: "a.plain" },
      { file: "fixture.ts", key: "a.yes" },
      { file: "fixture.ts", key: "a.no" },
    ]);
  });

  it("follows a key a constant carries into a lookup (REQ-188)", () => {
    /**
     * The hole this closes, on a fixture that reproduces all three shapes the
     * screens actually use. A key in an identifier is invisible to a walker
     * that only reads literal arguments, and the keys reached that way are the
     * FALLBACKS: the sentence shown when a code this build never heard of
     * arrives, which is the one nobody exercises by hand.
     */
    const found = catalogueKeysIn(
      parseSource(
        "fixture.ts",
        `const FALLBACK_KEY = "a.fallback";
         const UNKNOWN_KEY = "a.unknown";
         function chooseKey(code) {
           return KEYS[code] ?? UNKNOWN_KEY;
         }
         export const S = () => {
           const key = someRuntimeKey();
           t(KEYS[type] ?? FALLBACK_KEY);
           t(chooseKey(code));
           t(key);
         };`,
      ),
    );

    // Each key named by the CONSTANT that carries it, because that identifier
    // is what somebody has to open to fix a gap: the path itself is written
    // nowhere near the lookup.
    expect(found).toEqual([
      { file: "fixture.ts", key: "a.fallback", via: "FALLBACK_KEY" },
      { file: "fixture.ts", key: "a.unknown", via: "UNKNOWN_KEY" },
    ]);
  });

  it("chases no identifier whose value it cannot read", () => {
    /**
     * The other direction, and the one that decides whether the walker above is
     * safe to run on the corpus. `t(key)` where `key` is a parameter, a local,
     * or an import is a key this check cannot know, and GUESSING one would
     * accuse a lookup that is perfectly correct. Only a module-level constant
     * holding a literal is followed, which is the whole of what it can prove.
     */
    const found = catalogueKeysIn(
      parseSource(
        "fixture.ts",
        `import { derivedKey } from "./elsewhere.js";
         const CONFIRMED_KEY = "a.confirmed";
         export const S = (props, section) => {
           const local = "a.local";
           t(props.titleKey);
           t(section.unknownKey);
           t(derivedKey(code));
           t(local);
           t(CONFIRMED_KEY);
         };`,
      ),
    );

    expect(found).toEqual([
      { file: "fixture.ts", key: "a.confirmed", via: "CONFIRMED_KEY" },
    ]);
  });

  it("finds a plural sentence under the forms the catalogue writes it in", () => {
    // A lookup with a count names the BASE key, and the base is not a path in
    // the file: `_one` and `_other` are (REQ-182). Tying the family to its base
    // is what lets the check below read such a lookup as answered, and it stays
    // exact: a base nobody wrote sentences for is still missing.
    const carried = flatten(loadCatalogue(DEFAULT_LOCALE));
    const known = addressable(carried);
    const base = "dashboard.activity.relative.minutes";

    expect(carried).not.toContain(base);
    expect(carried).toContain(`${base}_one`);
    expect(known.has(base)).toBe(true);
    expect(known.has("dashboard.activity.relative.nothing")).toBe(false);
    // And an identifier that merely ends in a word is not a plural form: the
    // catalogue is full of them, and reading `no_match` as a family would hand
    // out an exemption to half the trail's vocabulary.
    expect(addressedBy("dashboard.activity.silence.no_match")).toBe(
      "dashboard.activity.silence.no_match",
    );
  });

  it("asks for no key the default catalogue does not carry", () => {
    // The half of REQ-074 that a parity test cannot reach: parity proves the
    // two catalogues agree, this proves the CODE agrees with them. Without it
    // a renamed key ships, and the operator meets the placeholder of REQ-075
    // where a sentence belonged.
    expect(unanswered(lookupKeys())).toStrictEqual([]);
  });

  it("reaches the keys only a constant carries (REQ-188)", () => {
    /**
     * Guards the guard on the real corpus, and names the three the measurement
     * was taken on. `screens.automations.refusalUnknown` reaches `t` through
     * `UNKNOWN_REFUSAL_KEY` and the return of `refusalKey`, and appears as a
     * literal argument nowhere: before this, dropping that sentence from both
     * catalogues failed NOTHING, and it is the sentence an operator meets when
     * something unforeseen happens, so the eye does not catch it either.
     */
    const reached = new Map(
      lookupKeys().map((found) => [found.key, found.via]),
    );

    expect(reached.get("auth.attemptsThrottled")).toBe("THROTTLE_REASON_KEY");
  });

  it("reports a lookup the catalogue cannot answer, naming the constant", () => {
    /**
     * The requirement's own sentence, exercised: a constant pointed at a key
     * nobody wrote is reported, and reported by the constant's NAME because
     * that is the only thing at the call site. The same expression the check
     * above runs, so a walker that could no longer see through a constant fails
     * here rather than passing quietly.
     */
    const invented = catalogueKeysIn(
      parseSource(
        "src/web/screens/invented.tsx",
        `const NOWHERE_KEY = "screens.invented.nobodyWroteThis";
         export const S = () => t(KEYS[code] ?? NOWHERE_KEY);`,
      ),
    );

    expect(unanswered(invented)).toStrictEqual([
      "src/web/screens/invented.tsx: t(NOWHERE_KEY) = " +
        `"screens.invented.nobodyWroteThis"`,
    ]);
  });
});

describe("REQ-074: no operator-facing text is written in the interface (criterion 43)", () => {
  it("recognises a literal on a screen when it sees one", () => {
    const found = visibleLiteralsIn(
      parseSource(
        "fixture.tsx",
        `export const S = () => (
           <p title="a title">hello <b>{"there"}</b><i>{t("k")}</i></p>
         );`,
      ),
    );

    // Text node, string expression and visible attribute: the three shapes a
    // sentence reaches a screen through. The catalogue lookup is not one.
    expect(found.sort()).toEqual(["hello ", "there", "title=a title"].sort());
  });

  it("renders no screen text that did not come from the catalogue", () => {
    const offenders = interfaceFiles().flatMap((file) =>
      visibleLiteralsIn(parseSource(file, readFileSync(file, "utf8"))).map(
        (literal) => `${file.replace(repoRoot, "")}: ${literal}`,
      ),
    );

    expect(offenders).toStrictEqual([]);
  });
});

describe("REQ-175: whitespace weighs the same wherever it is written", () => {
  /**
   * `<p> </p>` and `<p>{" "}</p>` put the same absence of words on a screen.
   * The guard used to tolerate the first and accuse the second, so the one
   * spelling React needs when a space has to survive between two elements was
   * the one spelling this check refused (found in phase 3d, separating an
   * optional marker from its field by a space).
   */
  it("gives one verdict to one content, as text and as expression", () => {
    const cases = [
      { content: " ", accused: false },
      { content: "\n      ", accused: false },
      { content: " mind the gap ", accused: true },
      { content: "word", accused: true },
    ];

    for (const { content, accused } of cases) {
      const asText = visibleLiteralsIn(
        parseSource("fixture.tsx", `export const S = () => <p>${content}</p>;`),
      );
      const asExpression = visibleLiteralsIn(
        parseSource(
          "fixture.tsx",
          `export const S = () => <p>{${JSON.stringify(content)}}</p>;`,
        ),
      );

      const spelling = JSON.stringify(content);
      expect(asText.length > 0, `text ${spelling}`).toBe(accused);
      expect(asExpression.length > 0, `expression ${spelling}`).toBe(accused);
    }
  });

  // The symmetry is about the absence of words, not about the braces: a
  // sentence smuggled into a spacing expression is still a sentence, and this
  // is the hole tolerating `{" "}` could have opened (REQ-074).
  it("names the words a spacing expression could have carried", () => {
    const found = visibleLiteralsIn(
      parseSource(
        "fixture.tsx",
        `export const S = () => <p>{t("a")}{" and "}{t("b")}</p>;`,
      ),
    );

    expect(found).toStrictEqual([" and "]);
  });

  // Same weight in the third shape the guard reads. An empty `alt` is how a
  // decorative image is marked for a screen reader, and a value with no words
  // in it has nothing to translate there either.
  it("weighs a visible attribute by its content too", () => {
    const found = visibleLiteralsIn(
      parseSource(
        "fixture.tsx",
        `export const S = () => (
           <p title=" "><img alt="" /><input placeholder="a word" /></p>
         );`,
      ),
    );

    expect(found).toStrictEqual(["placeholder=a word"]);
  });
});

describe("REQ-163: a reason code with no translation fails here", () => {
  /**
   * The half of REQ-163 a screen cannot prove. The engine emits codes because
   * it cannot read the catalogue (ADR-003), and the value of that trade is
   * entirely in this check: without it, a code added to the engine reaches the
   * operator raw, and the trail shows `email_already_known` where a sentence
   * belonged.
   *
   * The key is DERIVED from the code (`suppressionTextKey`), which is what
   * makes this total rather than a list somebody has to remember to extend. It
   * also reaches where the REQ-074 check above cannot: that one collects keys
   * written as literals in `t("...")` calls, and a screen translating a code
   * builds its key at runtime, so no literal exists for it to find.
   */

  it("finds codes to check", () => {
    // Guards the guard: an empty list would pass every check below while the
    // engine emitted whatever it liked.
    expect(SUPPRESSION_REASONS.length).toBeGreaterThan(0);
    expect(EXECUTION_FAILURE_REASONS.length).toBeGreaterThan(0);
    expect(engineReasonKeys()).toHaveLength(
      SUPPRESSION_REASONS.length + EXECUTION_FAILURE_REASONS.length,
    );
  });

  it("translates every reason the engine can emit, in every language", () => {
    expect(untranslated(engineReasonKeys())).toStrictEqual([]);
  });

  it("reports a code no catalogue translates, naming it", () => {
    // The requirement's own sentence, exercised: a code the engine could add
    // tomorrow addresses a key that does not exist, and this fails on it with
    // nobody having registered anything by hand. The check is the same
    // expression the test above runs, so a check that could not see a gap
    // would be caught here rather than passing quietly.
    const invented = [
      suppressionTextKey("reason_nobody_translated" as SuppressionReason),
      // The same sentence read of the failures (REQ-171): the two vocabularies
      // are separate lists under separate sections, so a check that only saw
      // one of them would let the other ship raw.
      executionFailureTextKey(
        "failure_nobody_translated" as ExecutionFailureReason,
      ),
    ];

    const offenders = untranslated(invented);

    expect(offenders).not.toStrictEqual([]);
    expect(offenders).toHaveLength(invented.length * availableLocales().length);
    for (const key of invented) {
      expect(
        offenders.filter((offender) => offender.includes(key)),
      ).toHaveLength(availableLocales().length);
    }
  });

  it("puts words where the code was, and not the code itself", () => {
    for (const locale of availableLocales()) {
      const words = new Map(sentencesOf(loadCatalogue(locale)));

      for (const reason of [
        ...SUPPRESSION_REASONS,
        ...EXECUTION_FAILURE_REASONS,
      ]) {
        // Through the SAME dispatcher the panel calls (REQ-171): a screen and a
        // guard that derived their keys separately could agree on every code
        // and still disagree about which section holds its words.
        const sentence = words.get(actionReasonTextKey(reason)) ?? "";

        expect(sentence.trim(), `${locale}: ${reason}`).not.toBe("");
        // "instead of appearing raw on the screen": a translation that quotes
        // the code back is the failure this requirement is about, dressed up.
        expect(sentence, `${locale}: ${reason}`).not.toContain(reason);
      }
    }
  });

  it("gives each vocabulary its own section, and never the other's words", () => {
    // The dispatcher is the one place a code meets a section, so this is where
    // a suppression quietly answering a failure key (or the reverse) shows up.
    // Both lists are closed, so the check is exact rather than a sample.
    for (const reason of SUPPRESSION_REASONS) {
      expect(actionReasonTextKey(reason)).toBe(suppressionTextKey(reason));
    }
    for (const reason of EXECUTION_FAILURE_REASONS) {
      expect(actionReasonTextKey(reason)).toBe(executionFailureTextKey(reason));
    }
    // Disjoint, which is what makes the dispatch above total: a code in both
    // lists would always be answered as a suppression, and its failure
    // translation would be two sentences written for nobody.
    expect(
      SUPPRESSION_REASONS.filter((reason) =>
        (EXECUTION_FAILURE_REASONS as readonly string[]).includes(reason),
      ),
    ).toStrictEqual([]);
  });
});

/**
 * REQ-163 for the vocabularies the panel's recent activity translates: the
 * trail's verdicts, the two readings of a silence, and the five reasons an
 * automation refuses an event (REQ-160).
 *
 * The same argument as the block above, applied where the codes are counted
 * rather than emitted, and it reaches where no rendered screen can: a screen
 * test proves the sentences it was given are on the page, and this proves the
 * catalogues carry one for EVERY code the application can produce, in every
 * language, before anyone has seen the screen.
 *
 * TWO of the three vocabularies are mirrored in `engine-reasons.ts` rather than
 * imported from where they are declared, because the interface bundles that
 * module and their homes reach a database driver. Mirrors drift, so the mirrors
 * are held against the originals HERE, by assignment, which makes a sixth
 * outcome or a third silence code fail the build instead of the eye.
 */
describe("REQ-163: the activity's codes are translated, by derivation", () => {
  it("keeps the mirrored vocabularies identical to the declared ones", () => {
    // Assignable BOTH ways, which is what makes this total: one direction alone
    // would accept a mirror that had grown a code the trail cannot write, and
    // the other alone would accept one that had lost a code it can.
    const outcomeIsMirrored: ActivityOutcome = "ok" as AuditOutcome;
    const outcomeIsDeclared: AuditOutcome = "ok" as ActivityOutcome;
    const silenceIsMirrored: ActivitySilence = "no_match" as SilenceCode;
    const silenceIsDeclared: SilenceCode = "no_match" as ActivitySilence;

    // Read at runtime too, so the assignments above are not dead code a linter
    // could remove and take the compile-time proof with them.
    expect([
      outcomeIsMirrored,
      outcomeIsDeclared,
      silenceIsMirrored,
      silenceIsDeclared,
    ]).toHaveLength(4);
  });

  it("finds codes to check", () => {
    // Guards the guard: an empty list would pass every check below while the
    // panel showed whatever it liked.
    expect(ACTIVITY_OUTCOMES.length).toBeGreaterThan(0);
    expect(ACTIVITY_SILENCES.length).toBeGreaterThan(0);
    expect(MATCH_REFUSALS.length).toBeGreaterThan(0);
    expect(activityReasonKeys()).toHaveLength(
      ACTIVITY_OUTCOMES.length * 2 +
        ACTIVITY_SILENCES.length +
        MATCH_REFUSALS.length,
    );
  });

  it("translates every code the activity shows, in every language", () => {
    expect(untranslated(activityReasonKeys())).toStrictEqual([]);
  });

  it("reports a code no catalogue translates, naming it", () => {
    // The requirement's own sentence, exercised on each of the three families:
    // a code any of them could gain tomorrow addresses a key that does not
    // exist, and this fails on it.
    const invented = [
      arrivalTextKey("nobody_translated" as ActivityOutcome),
      actionOutcomeTextKey("nobody_translated" as ActivityOutcome),
      activitySilenceTextKey("nobody_translated" as ActivitySilence),
      matchRefusalTextKey("nobody_translated" as never),
    ];

    expect(untranslated(invented)).toHaveLength(
      invented.length * availableLocales().length,
    );
  });

  it("puts words where the code was, and not the code itself", () => {
    /**
     * Only the codes carrying an underscore, and the restriction is what makes
     * this check safe rather than weaker: `no_match` and `wrong_origin` are
     * identifiers no sentence in either language contains, while `failed` and
     * `duplicate` are ordinary English words a correct translation is entitled
     * to be. Applied to those, this would forbid the right answer.
     */
    const identifiers = [
      ...ACTIVITY_SILENCES.map((code) => [activitySilenceTextKey(code), code]),
      ...MATCH_REFUSALS.map((code) => [matchRefusalTextKey(code), code]),
    ].filter(([, code]) => (code ?? "").includes("_"));

    expect(identifiers.length).toBeGreaterThan(0);

    for (const locale of availableLocales()) {
      const words = new Map(sentencesOf(loadCatalogue(locale)));

      for (const [key = "", code = ""] of identifiers) {
        const sentence = words.get(key) ?? "";

        expect(sentence.trim(), `${locale}: ${key}`).not.toBe("");
        expect(sentence, `${locale}: ${key}`).not.toContain(code);
      }
    }
  });
});

/**
 * REQ-172: the mirror of REQ-074, and the half that goes unnoticed for months.
 *
 * REQ-074 fails when the code asks for a key no catalogue carries. The reverse
 * costs nothing at runtime and everything over time: a sentence whose last
 * caller was deleted stays behind, reads as current, and is eventually reworded
 * by somebody who believes it is on a screen. That is how a catalogue comes to
 * state behaviour the application no longer has, which is the defect phase 3e
 * spent a day undoing. Measured once already: when the vague reason gave way to
 * the aggregate, `dispatch.noAutomationMatched` became dead text in both
 * languages and nothing failed.
 *
 * The trap is that a live key need not be written inside a `t("...")` call:
 *
 *  - written down, but reached by INDEXING a map. `RANGE_LABEL_KEYS`,
 *    `GRANULARITY_KEYS`, `CAP_LABEL_KEYS` and the section records of
 *    `dashboard.tsx` hold the key as a literal while the call site reads
 *    `t(key)`, and `LABEL_KEYS` collects them for the screen's own check.
 *  - never written down at all. `engine.suppressed.*`, `engine.failed.*` and
 *    the code families under `dashboard.activity.*` are built from a code at
 *    runtime by `engine-reasons.ts`, thirty keys of them, and not one appears
 *    as a literal anywhere.
 *
 * So this collects every literal in the production sources rather than only the
 * arguments of `t`, and then ASKS the deriving functions for the rest, the same
 * `engineReasonKeys()` and `activityReasonKeys()` the REQ-163 guards above
 * check. Reimplementing those families here, or keeping an allowlist beside
 * them, would leave this check one rename away from accusing thirty live keys
 * at once, and a guard that cries wolf is a guard people learn to ignore.
 *
 * Comments are not requests, which is what parsing buys over matching text: a
 * key quoted in a comment explaining why it was removed must still count as
 * dead.
 */
describe("REQ-172: no text stays in the catalogue with nobody asking for it", () => {
  it("sees a key written into a map, and not only one written into t()", () => {
    // Guards the guard: a collector that only read the arguments of `t` would
    // report every key `dashboard.tsx` holds in a record as dead.
    const found = stringLiteralsIn(
      parseSource(
        "fixture.ts",
        `const KEYS = { hour: "screens.first" };
         t("screens.second");
         // "screens.commented" is a mention, not a request.`,
      ),
    );

    expect(found).toContain("screens.first");
    expect(found).toContain("screens.second");
    expect(found).not.toContain("screens.commented");
  });

  it("collects from both sides of the boundary", () => {
    // The other half of the same guard, on the real corpus: a collector that
    // read no screen would accuse most of the catalogue, and one that read no
    // backend would accuse the rest.
    expect(literalKeys().has("config.missingEnvVariables")).toBe(true);
    expect(literalKeys().has("screens.dashboard.granularity.hour")).toBe(true);
    expect(literalKeys().has("nobody.wrote.this.anywhere")).toBe(false);
  });

  it("carries no key the code has stopped asking for", () => {
    const offenders = availableLocales().flatMap((locale) =>
      unrequested(flatten(loadCatalogue(locale)), locale),
    );

    expect(offenders).toStrictEqual([]);
  });

  it("reports a key nobody asks for, naming it and the language", () => {
    /**
     * Deliberately inside one of the derived families: a check that exempted a
     * whole SECTION by prefix, rather than the exact keys the deriving function
     * answers, would let a dead sentence hide under `dashboard.activity.` and
     * pass this.
     */
    const invented = "dashboard.activity.refusal.nobody_asks_for_this";
    const carried = [...flatten(loadCatalogue(DEFAULT_LOCALE)), invented];

    const offenders = availableLocales().flatMap((locale) =>
      unrequested(carried, locale),
    );

    // Exactly the invented key, once per language, and nothing else: the same
    // expression the check above runs, so a detector that could see no orphan
    // fails here instead of passing quietly.
    expect(offenders).toStrictEqual(
      availableLocales().map((locale) => `${locale}: ${invented}`),
    );
  });

  it("exempts the plural forms of a live key, and nothing wider", () => {
    /**
     * The family of a key somebody asks for is alive, because the caller names
     * the base and the library picks the form (REQ-182). What must NOT follow
     * is an amnesty for anything spelled like a plural: a form whose base no
     * code path asks for is dead text exactly as any other key is, and reading
     * it as one is how a whole section could come to hide under a suffix.
     */
    const live = "dashboard.activity.relative.minutes_one";
    const dead = "dashboard.activity.relative.nobody_asks_other";

    expect(literalKeys().has("dashboard.activity.relative.minutes")).toBe(true);

    for (const locale of availableLocales()) {
      expect(unrequested([live], locale), `locale ${locale}`).toStrictEqual([]);
      expect(unrequested([dead], locale), `locale ${locale}`).toStrictEqual([
        `${locale}: ${dead}`,
      ]);
    }
  });

  it("asks for the key a constant carries, and does not call it dead", () => {
    /**
     * The other family of REQ-188, from this side. `refusalUnknown` is written
     * down once, as the value of `UNKNOWN_REFUSAL_KEY`, and never as an
     * argument of `t`: a collector reading only the arguments would report the
     * fallback sentence of both languages as dead text, and somebody would
     * delete it. The two families now agree on what a request is, and this is
     * where that agreement is pinned.
     */
    const carried = ["auth.attemptsThrottled"];

    expect(lookupKeys().map((found) => found.key)).toEqual(
      expect.arrayContaining(carried),
    );

    for (const locale of availableLocales()) {
      expect(unrequested(carried, locale), `locale ${locale}`).toStrictEqual(
        [],
      );
    }
  });

  it("accuses no key that only a deriving function reaches", () => {
    /**
     * The other direction, and the one that decides whether this check is worth
     * keeping. A guard too wide accuses thirty live keys the moment a code
     * family stops being written down, which is the normal state of these two.
     */
    const derived = [...engineReasonKeys(), ...activityReasonKeys()];

    expect(derived.length).toBeGreaterThan(20);
    // Not one of them is a literal anywhere in the sources, so the accusation
    // this asserts against is real rather than hypothetical: a literal-only
    // collector would report every single one.
    expect(derived.filter((key) => literalKeys().has(key))).toStrictEqual([]);

    for (const locale of availableLocales()) {
      expect(unrequested(derived, locale), `locale ${locale}`).toStrictEqual(
        [],
      );
    }
  });
});

/**
 * REQ-190: a plural sentence is written in the categories ITS language selects.
 *
 * Measured, not supposed. With only `_one` and `_other` written, pt-BR renders
 * `t("dashboard.activity.relative.minutes", { count: 1000000 })` as "1000000
 * minutes ago": Portuguese selects `many` from a million on, the catalogue has
 * no sentence under that category, and i18next falls through to English. The
 * operator reads an English sentence in the middle of a Portuguese panel, and
 * key parity is at peace because both catalogues carry the same two forms.
 *
 * The numbers that reach today's keys cannot get there (minutes stop at 60,
 * hours at 24, days at 30), so this is written for the plural key added next,
 * which is the only kind of guard worth writing for a hole that has not been
 * fallen into yet.
 *
 * The categories are ASKED of the platform rather than tabled here, and that is
 * the point rather than economy: a copied table is a second source of truth
 * about somebody else's data, and it rots exactly where nobody looks. The
 * platform already answers, per language, and answers correctly on the day a
 * locale is added.
 */
describe("REQ-190: every plural key covers its language's categories", () => {
  it("reads the categories off the platform, per language", () => {
    // Guards the guard: a derivation that answered the same thing for every
    // language would make the check below a tautology, and the whole defect is
    // that the two shipped languages do NOT select the same categories.
    expect(pluralCategoriesOf(DEFAULT_LOCALE)).toContain("other");
    expect(pluralCategoriesOf("pt-BR")).toContain("many");
    expect(pluralCategoriesOf("pt-BR")).not.toEqual(
      pluralCategoriesOf(DEFAULT_LOCALE),
    );

    // And the suffix vocabulary the catalogues are written in has to be able to
    // spell every one of them, or a form nobody can address goes unnoticed.
    for (const locale of availableLocales()) {
      for (const category of pluralCategoriesOf(locale)) {
        expect(PLURAL_CATEGORIES, `locale ${locale}`).toContain(category);
      }
    }
  });

  it("finds plural families to check", () => {
    // Guards the guard, again: a catalogue walk that found no family would pass
    // every check below while the sentences said whatever they liked.
    expect(pluralBases().size).toBeGreaterThan(0);
    expect(pluralBases()).toContain("dashboard.activity.relative.minutes");
    expect(pluralBases()).not.toContain("dashboard.activity.relative.justNow");
  });

  it("writes every form its language selects, in every language", () => {
    expect(misplural(pluralBases())).toStrictEqual([]);
  });

  it("reports a family missing a form, naming the language and the form", () => {
    /**
     * The requirement's own sentence, exercised on a family no catalogue
     * carries: every language is missing every form of it, and this says so.
     * The same expression the check above runs, so a check that could see no
     * gap fails here rather than passing quietly.
     */
    const invented = "dashboard.activity.relative.centuries";

    const offenders = misplural(new Set([invented]));

    expect(offenders).toStrictEqual(
      availableLocales().flatMap((locale) =>
        pluralCategoriesOf(locale).map(
          (category) => `${locale}: ${invented}_${category}`,
        ),
      ),
    );
    // `many` among them, which is the form English never asks for: an
    // expectation built from the DEFAULT language's categories would pass a
    // catalogue that ships English to a Brazilian operator.
    expect(offenders).toContain(`pt-BR: ${invented}_many`);
  });

  it("writes no form its language never selects", () => {
    /**
     * The reverse, and it is not symmetry for its own sake: a `_few` written
     * into pt-BR is a sentence the language cannot reach, and the REQ-172 guard
     * cannot see it because a plural form answers to a base somebody does ask
     * for. Dead text that hides under a live key is exactly the shape phase 3e
     * spent a day undoing.
     */
    const stray = availableLocales().flatMap((locale) => {
      const selected = new Set(pluralCategoriesOf(locale));

      return [...pluralFormsOf(flatten(loadCatalogue(locale)))].flatMap(
        ([base, written]) =>
          [...written]
            .filter((category) => !selected.has(category))
            .map((category) => `${locale}: ${base}_${category}`),
      );
    });

    expect(stray).toStrictEqual([]);
  });

  it("renders each size in the language in force, and never in English", () => {
    /**
     * The structural check above says the sentence is written; this says the
     * library picks it, which is the half a catalogue check cannot prove. It
     * runs through `createTranslator`, the same code both halves of the process
     * translate with, and it is the check that fails on the defect as it was
     * MEASURED: with no `_many`, a million minutes comes back in English.
     */
    const catalogues = Object.fromEntries(
      availableLocales().map((locale) => [locale, loadCatalogue(locale)]),
    );

    for (const locale of availableLocales()) {
      const translator = createTranslator(catalogues, locale);
      const sentences = new Map(sentencesOf(loadCatalogue(locale)));

      for (const base of pluralBases()) {
        for (const category of pluralCategoriesOf(locale)) {
          const count = countIn(locale, category);
          const written = sentences.get(`${base}_${category}`) ?? "";

          expect(count, `${locale}: ${category}`).toBeDefined();
          expect(
            translator.t(base, { count }),
            `${locale}: ${base} at ${String(count)}`,
          ).toBe(written.replaceAll("{{count}}", String(count)));
        }
      }
    }
  });
});

/**
 * REQ-174: every label record has somebody covering it.
 *
 * Twelve records across four screens turn a value into a catalogue key, and
 * REQ-157 was paid on one screen only. What a record can lose is two different
 * things, and each guarantee answers one of them:
 *
 *  - a ROW, when a union grows a value and the record does not. Only the
 *    compiler sees that, and only when the record is `Record<T, string>` over a
 *    CLOSED union: keyed by `string`, a missing row is a silent `undefined`.
 *  - the SENTENCE, when the key stops naming anything in the catalogue. No
 *    compiler sees that, because the key is an ordinary string, and the REQ-074
 *    walker cannot either: it reads the arguments of `t("...")`, and a record's
 *    key is read as `t(KEYS[value])`. What sees it is a published list checked
 *    against the shipped catalogue.
 *
 * So a record needs at least one, and this is the census that says so. Measured
 * on this corpus before it existed: an entry added to `REFUSAL_KEYS` naming a
 * key nobody had written into either catalogue passed all 96 tests.
 *
 * A census and not a list of the twelve, because a list is a thing to remember:
 * the record added next week is exactly the one nobody would add to it, and the
 * requirement's own sentence is that a NEW record with neither guarantee fails.
 */
describe("REQ-174: no label record is left uncovered", () => {
  it("tells a record of keys from the records of icons and tints", () => {
    // Guards the guard: a census that saw nothing would report no offender on a
    // screen full of them, and one that saw everything would accuse the tints.
    const found = labelRecordsIn(
      parseSource(
        "fixture.tsx",
        `const OPEN: Readonly<Record<string, string>> = { a: "screens.fixture.open" };
         const CLOSED: Readonly<Record<Mode, string>> = { m: "screens.fixture.closed" };
         const LISTED: Readonly<Record<string, string>> = { l: "screens.fixture.listed" };
         const TINTS: Readonly<Record<Mode, BadgeState>> = { m: "active" };
         const GLYPHS: Readonly<Record<Mode, string>> = { m: "circle-check" };
         export const KEYS: readonly string[] = [...Object.values(LISTED)];`,
      ),
    );

    // `TINTS` is not a record of keys because its values are not strings, and
    // `GLYPHS` is not one because its values name no catalogue path. Both live
    // beside the real records on these screens.
    expect(found.map((record) => record.name)).toEqual([
      "OPEN",
      "CLOSED",
      "LISTED",
    ]);
    expect(uncovered(found)).toEqual(["fixture.tsx: OPEN"]);
  });

  it("finds the records it is supposed to police", () => {
    // The other half of the same guard, on the real corpus: a census matching
    // nothing would pass every check below while the screens held whatever they
    // liked. The named ones are the measurement this task started from.
    const named = labelRecords().map((record) => label(record));

    expect(named.length).toBeGreaterThanOrEqual(7);
    for (const record of [
      "src/web/screens/dashboard.tsx: RANGE_LABEL_KEYS",
      "src/web/screens/dashboard.tsx: GRANULARITY_KEYS",
      "src/web/screens/dashboard.tsx: EVENT_LABEL_KEYS",
      "src/web/screens/dashboard.tsx: ACTION_LABEL_KEYS",
      "src/web/screens/dashboard.tsx: CAP_LABEL_KEYS",
      "src/web/screens/dashboard.tsx: CAP_STATUS_KEYS",
    ]) {
      expect(named).toContain(record);
    }
  });

  it("leaves every record that decides no sentence alone", () => {
    // The false accusation this census has to not make. These five map a value
    // to a tint or an icon, and the WORD beside them comes from a record that
    // IS policed above (REQ-038), so demanding a guarantee of them would be
    // demanding it of the design system.
    const named = labelRecords().map((record) => record.name);

    for (const record of [
      "CAP_BADGE_STATES",
      "OUTCOME_BADGE_STATES",
      "KIND_ICONS",
      "ACTION_GLYPHS",
      "GLYPH",
    ]) {
      expect(named, record).not.toContain(record);
    }
  });

  it("leaves no record without one of the two guarantees", () => {
    expect(uncovered(labelRecords())).toStrictEqual([]);
  });

  it("reports a record that has neither, naming it", () => {
    /**
     * The requirement's own sentence, exercised: a record a screen could gain
     * tomorrow, keyed by `string` and in no list, is reported. The same
     * expression the check above runs, so a census that could see no gap fails
     * here rather than passing quietly.
     */
    const invented = labelRecordsIn(
      parseSource(
        "src/web/screens/invented.tsx",
        `const NEW_KEYS: Readonly<Record<string, string>> = {
           code: "screens.invented.code",
         };`,
      ),
    );

    expect(uncovered(invented)).toStrictEqual([
      "src/web/screens/invented.tsx: NEW_KEYS",
    ]);
  });

  it("names every dispensation, and dispenses nothing that stopped needing it", () => {
    /**
     * The dispensations are the part of this census that could rot into an
     * allowlist, so they are held to the two things that keep them honest: the
     * record still EXISTS under that name, and it would still be accused. A
     * record renamed with its dispensation left behind, or one that has since
     * been covered, fails here instead of quietly exempting whatever inherits
     * the name.
     */
    const records = labelRecords();

    for (const dispensation of DISPENSED) {
      const where = `${dispensation.file}: ${dispensation.name}`;
      const record = records.find((candidate) => label(candidate) === where);

      expect(record, where).toBeDefined();
      expect(record?.keyedBy, where).toBe("string");
      expect(record?.listed, where).toBe(false);
      // A reason, and one somebody wrote: an empty string would make the
      // dispensation the silent omission this check exists to forbid.
      expect(dispensation.reason.length, where).toBeGreaterThan(40);
    }
  });

  it("holds every listed record against the shipped catalogue", () => {
    /**
     * What makes the second guarantee worth having. Being in a published list
     * is only a guarantee if something reads the list and demands the sentence,
     * and for the refusal labels of `automations.tsx` that something is here:
     * the screen's own suite renders the codes it was given, and cannot notice
     * a key nobody translated.
     */
    // Through `addressable`, because a listed key may name a plural family:
    // `ELAPSED_KEYS` holds the base and the catalogue carries the forms.
    const known = addressable(flatten(loadCatalogue(DEFAULT_LOCALE)));
    const listed = labelRecords().filter((record) => record.listed);

    expect(listed.length).toBeGreaterThan(5);

    const missing = listed.flatMap((record) =>
      record.keys
        .filter((key) => !known.has(key))
        .map((key) => `${label(record)}: ${key}`),
    );

    expect(missing).toStrictEqual([]);
  });
});

describe("REQ-167: no text promises a step the format does not declare", () => {
  /**
   * The flow format declares seven actions (`FLOW_ACTIONS`) and not one of them
   * compares anything: `flows/binding.ts` only ever builds `goto` and `end`
   * transitions, so nothing an operator can author reads an attribute back and
   * decides on it. A hint saying otherwise sends someone building a flow around
   * a step that is not there, and the loss is their afternoon.
   *
   * The check is on the whole catalogue rather than on the one key that said
   * it, because a sentence moves: rewritten on another screen, re-added in one
   * language only, or written afresh by whoever implements the branch someday.
   * When the step exists, this check is what has to be deleted, deliberately.
   */
  const COMPARISON = /compar/i;
  const ATTRIBUTE = /atributo|attribute/i;

  const promisesComparison = (sentence: string): boolean =>
    COMPARISON.test(sentence) && ATTRIBUTE.test(sentence);

  it("recognises the promise, and leaves a true sentence alone", () => {
    // Guards the guard: a detector matching nothing would pass the check below
    // while the catalogue promised whatever it liked.
    expect(
      promisesComparison(
        "um fluxo que compare o atributo depois vê a diferença",
      ),
    ).toBe(true);
    expect(
      promisesComparison(
        "a flow that compares the attribute later sees the difference",
      ),
    ).toBe(true);
    // A comment IS compared against the publication it arrived on, and saying
    // so is not this promise.
    expect(
      promisesComparison(
        "é esse o valor contra o qual cada comentário é comparado",
      ),
    ).toBe(false);
  });

  it("finds sentences in every shipped catalogue to check", () => {
    // The other half of the same guard: a walker that returned nothing would
    // report no offender on a catalogue full of them.
    for (const locale of availableLocales()) {
      expect(
        sentencesOf(loadCatalogue(locale)).length,
        `locale ${locale}`,
      ).toBeGreaterThan(100);
    }
  });

  it("carries no sentence promising a flow compares an attribute", () => {
    const offenders = availableLocales().flatMap((locale) =>
      sentencesOf(loadCatalogue(locale))
        .filter(([, sentence]) => promisesComparison(sentence))
        .map(([key, sentence]) => `${locale}: ${key}: ${sentence}`),
    );

    expect(offenders).toStrictEqual([]);
  });
});

/**
 * REQ-184: a test may only spread over the catalogue what the catalogue
 * confirms.
 *
 * A merge fixture is wave scaffolding. A task delivers its sentences as a
 * trecho, merges them into the shipped catalogue here so its screen can be
 * proved before `locales/*.json` (a shared file no task in a wave writes)
 * accepts them, and lets the PUBLISHED text win the merge. Once the keys land
 * the spread is a no-op and the assertions read the shipped sentence, which is
 * the whole design.
 *
 * What it costs when a key never lands, or leaves again: the fixture keeps
 * answering, the screen goes on being proved against a sentence that exists
 * only inside the test file, and the suite is green about text no operator can
 * ever read. Measured, not supposed: `screens.automations.rowComment` left both
 * catalogues in phase 3f and the fixture of `automations.test.tsx` went on
 * declaring it, which is the defect this requirement was written for.
 *
 * Discovery is by SHAPE and never by name, and that is the lesson this check is
 * made of rather than a preference. Its first version lived inside one screen's
 * test and read that screen's fixture; when the fixture was deleted the
 * requirement lost its guard entirely and `grep -rn REQ-184 src/` came back with
 * a comment. A check that looked for `ADDED_EN` would know one wave's spelling
 * and go blind at the next, while still reporting the requirement covered. So
 * what is detected is the MERGE itself: an object literal that spreads a local
 * object together with a section of an imported catalogue, in either order,
 * under whatever names the file gave them. The section spread beside it is what
 * says which published keys the fixture claims to extend.
 *
 * Parsing rather than matching text, for the reason the REQ-172 header gives at
 * length: the sources are full of quoted keys in comments and of source code
 * written inside template literals (this very file), and a regex reads both as
 * requests.
 */
describe("REQ-184: no test overlays the catalogue with text it does not confirm", () => {
  /**
   * A path in the tree the real fixtures live in, so the relative specifier of
   * a fixture source resolves the way a real one does: import resolution is the
   * part of this check that decides WHICH language a merge is measured against.
   */
  const source = `${repoRoot}src/web/screens/fixture.test.tsx`;
  const IMPORTS = `import en from "../../i18n/locales/en.json";
    import ptBR from "../../i18n/locales/pt-BR.json";`;

  it("sees the merge by its shape, in either order and under any name", () => {
    /**
     * Guards the guard, and pins the failure that created this task. Neither
     * name below is the one the live fixtures use, and the second merge writes
     * the two spreads the other way round: a check that recognised a convention
     * instead of a shape would find nothing here and pass every check under it.
     */
    const found = overlaysIn(
      parseSource(
        source,
        `${IMPORTS}
         const WHATEVER = { save: "Save" };
         const outra = { save: "Salvar" };
         const catalogues = {
           en: {
             ...en,
             screens: {
               ...en.screens,
               flows: { ...WHATEVER, ...en.screens.flows },
             },
           },
           "pt-BR": {
             ...ptBR,
             screens: {
               ...ptBR.screens,
               flows: { ...ptBR.screens.flows, ...outra },
             },
           },
         };`,
      ),
    );

    expect(found.map(nameOf)).toEqual([
      "src/web/screens/fixture.test.tsx: WHATEVER over en:screens.flows",
      "src/web/screens/fixture.test.tsx: outra over pt-BR:screens.flows",
    ]);
  });

  it("finds test sources of both extensions to check", () => {
    // The other half of the same guard: the screens carrying the fixtures are
    // `.tsx`, and a glob reaching only `.ts` would read none of them while
    // reporting every check below as passed.
    expect(testFiles().some((file) => file.endsWith(".test.ts"))).toBe(true);
    expect(testFiles().some((file) => file.endsWith(".test.tsx"))).toBe(true);
  });

  it("leaves a screen proved against the published section alone", () => {
    /**
     * The direction that decides whether this is safe to run on the corpus. A
     * catalogue rebuilt out of its own published sections is not a merge, and
     * reading one there would accuse a screen for doing precisely what REQ-193
     * asks of it. The alias is deliberate: `copy` names a section, and a check
     * that took every spread identifier for a fixture would report the whole
     * dashboard section as unconfirmed text.
     */
    const found = overlaysIn(
      parseSource(
        source,
        `${IMPORTS}
         const copy = en.screens.dashboard;
         const catalogues = {
           en: { ...en, screens: { ...en.screens, dashboard: copy } },
         };`,
      ),
    );

    expect(found).toStrictEqual([]);
  });

  it("confirms every key every merge fixture declares", () => {
    expect(overlays().flatMap(unconfirmed)).toStrictEqual([]);
  });

  it("reports a key the catalogue does not carry, naming fixture and section", () => {
    /**
     * The bite kept IN the suite instead of performed once by hand. The check
     * above passes trivially on a corpus that carries no fixture at all, which
     * is how the first version of this requirement lost its guard without a
     * single test turning red, so the detector has to be shown biting on a
     * source of its own.
     */
    const found = overlaysIn(
      parseSource(
        source,
        `${IMPORTS}
         const ADDED_EN = { createAutomation: "Create automation", nobodyPublishedThis: "..." };
         const catalogues = {
           en: {
             ...en,
             screens: {
               ...en.screens,
               publications: { ...ADDED_EN, ...en.screens.publications },
             },
           },
         };`,
      ),
    );

    // `createAutomation` is published under `screens.publications` and passes;
    // only the invented key is named, by the path whoever fixes it has to add
    // or delete.
    expect(found.flatMap(unconfirmed)).toStrictEqual([
      "src/web/screens/fixture.test.tsx: ADDED_EN over en:screens.publications: screens.publications.nobodyPublishedThis",
    ]);
  });

  it("aims no merge it cannot aim, and accuses no key of one", () => {
    /**
     * Two sections spread beside the same fixture leave the target undecidable,
     * and GUESSING one would accuse keys that are correct under the other. A
     * guard that cries wolf is a guard people learn to skip, so the doubt is
     * reported as itself: an answer somebody can act on, and one this check
     * cannot pass by ignoring.
     */
    const found = overlaysIn(
      parseSource(
        source,
        `${IMPORTS}
         const MIXED = { save: "Save" };
         const copy = { ...MIXED, ...en.screens.flows, ...en.screens.automations };`,
      ),
    );

    expect(found.flatMap(unconfirmed)).toStrictEqual([
      "src/web/screens/fixture.test.tsx: MIXED: spread over more than one catalogue section, so which one it extends cannot be told",
    ]);
  });
});

/**
 * Every locale that carries no text for one of these keys, named.
 *
 * Shared by both REQ-163 blocks, because they ask the identical question of
 * different vocabularies: the keys are DERIVED from the codes, so a code added
 * tomorrow addresses a key that does not exist yet and this reports it with
 * nobody having registered anything by hand.
 */
function untranslated(keys: readonly string[]): string[] {
  return availableLocales().flatMap((locale) => {
    const known = new Set(flatten(loadCatalogue(locale)));
    return keys
      .filter((key) => !known.has(key))
      .map((key) => `${locale}: ${key}`);
  });
}

/**
 * Every key of `keys` that no code path asks for, named with its language
 * (REQ-172).
 *
 * The catalogue arrives as an argument rather than being read here, so the
 * bite proof can hand it a catalogue carrying one key nobody wants and watch
 * this report exactly that one.
 */
function unrequested(keys: readonly string[], locale: string): string[] {
  const requested = requestedKeys();

  return keys
    .filter((key) => !requested.has(key) && !requested.has(addressedBy(key)))
    .map((key) => `${locale}: ${key}`);
}

/**
 * Every catalogue key the application can address: the ones written down, and
 * the ones the deriving functions build from a code.
 *
 * The derived halves are ASKED of `engine-reasons.ts` and never re-listed here.
 * That module is the one place a code meets the catalogue (REQ-163), the panel
 * builds its keys by calling the same functions, and a family that grows a code
 * tomorrow is covered here with nobody registering anything.
 */
function requestedKeys(): Set<string> {
  return new Set([
    ...literalKeys(),
    // The keys a lookup reaches through a constant, so the two halves of
    // REQ-188 share ONE notion of what a request is. Every one of them is also
    // a literal somewhere in the corpus today, which is why nothing here
    // changes an answer: what it buys is that narrowing the literal collector
    // cannot quietly turn a fallback sentence into dead text.
    ...lookupKeys().map((lookup) => lookup.key),
    ...engineReasonKeys(),
    ...activityReasonKeys(),
  ]);
}

let literalCache: Set<string> | undefined;

/**
 * Every string literal in the production sources, both sides of the boundary.
 *
 * Every literal, and not only the arguments of `t`, because a key is just as
 * alive when it sits in a record the code indexes (`RANGE_LABEL_KEYS`,
 * `GRANULARITY_KEYS`, `LABEL_KEYS`) as when it is written into the call. The
 * price is that a key written down in a map nothing reads still counts as
 * requested, and that is the right side to err on: this check exists to find
 * text with no caller at all, and a false accusation would teach the team to
 * skip it.
 *
 * Cached because three checks ask for it and the walk parses every source.
 */
function literalKeys(): Set<string> {
  literalCache ??= new Set(
    [...productionFiles(), ...interfaceFiles()].flatMap((file) =>
      stringLiteralsIn(parseSource(file, readFileSync(file, "utf8"))),
    ),
  );

  return literalCache;
}

/** The text of every string literal in a source, comments excluded by parsing. */
function stringLiteralsIn(source: ts.SourceFile): string[] {
  const literals: string[] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      literals.push(node.text);
    }
    ts.forEachChild(node, visit);
  };

  visit(source);
  return literals;
}

/**
 * The CLDR categories i18next spells as a key suffix (`minutes_one`).
 *
 * A key with plural forms is asked for WITHOUT the suffix: the code writes
 * `t("...minutes", { count })` and the library picks the form from the number
 * and the language in force. So a catalogue carrying plural sentences carries
 * paths no caller ever names, and the checks that hold code and catalogue
 * against each other have to read a family as the ONE key it is. Without this,
 * the first plural sentence to ship is reported as two pieces of dead text
 * (REQ-172) while the lookup that renders it is reported as missing (REQ-074).
 *
 * Every category the CLDR spells and not the ones the shipped languages use:
 * pt-BR already writes `_many`, and a locale added tomorrow (`ru`, `pl`) writes
 * `_few` under the same base key, so a shorter list would accuse those forms on
 * the day they arrive. Which of them a language actually SELECTS is a different
 * question, asked of the platform per language by `pluralCategoriesOf`
 * (REQ-190), and this list is held against that answer there.
 */
const PLURAL_CATEGORIES = ["zero", "one", "two", "few", "many", "other"];

/**
 * The key a catalogue path is addressed by: a plural form answers to its base.
 *
 * The suffix has to be a category and nothing else, which is what keeps this
 * from eating the identifiers the catalogue is full of: `no_match` and
 * `wrong_origin` end in a word, not in a plural class, and stay themselves.
 */
function addressedBy(path: string): string {
  const cut = path.lastIndexOf("_");

  return cut > 0 && PLURAL_CATEGORIES.includes(path.slice(cut + 1))
    ? path.slice(0, cut)
    : path;
}

/** Every key a catalogue answers to: its paths, plus the base of each family. */
function addressable(paths: readonly string[]): Set<string> {
  return new Set(paths.flatMap((path) => [path, addressedBy(path)]));
}

/** The keys a CALLER names: a plural family counts once, as its base. */
function bases(paths: readonly string[]): Set<string> {
  return new Set(paths.map(addressedBy));
}

/**
 * The plural categories a language actually selects, asked of the platform
 * (REQ-190).
 *
 * Cardinal, because that is what a count is and what i18next resolves with.
 * Never a table: the answer belongs to the CLDR, the platform ships it, and a
 * copy of it here would be right until the day it silently was not.
 */
function pluralCategoriesOf(locale: string): readonly string[] {
  return [
    ...new Intl.PluralRules(locale).resolvedOptions().pluralCategories,
  ].sort();
}

/** The categories a catalogue writes sentences under, by base key. */
function pluralFormsOf(paths: readonly string[]): Map<string, Set<string>> {
  const families = new Map<string, Set<string>>();

  for (const path of paths) {
    const base = addressedBy(path);
    if (base === path) {
      continue;
    }
    const written = families.get(base) ?? new Set<string>();
    written.add(path.slice(base.length + 1));
    families.set(base, written);
  }

  return families;
}

let pluralCache: Set<string> | undefined;

/**
 * Every base key ANY shipped catalogue writes plural sentences for.
 *
 * Any and not the default's, because the language that needs a form the default
 * has no use for is the whole of REQ-190: reading the families off English
 * alone would ask pt-BR for `one` and `other` and call it covered.
 */
function pluralBases(): Set<string> {
  pluralCache ??= new Set(
    availableLocales().flatMap((locale) => [
      ...pluralFormsOf(flatten(loadCatalogue(locale))).keys(),
    ]),
  );

  return pluralCache;
}

/** Every form a language selects and its catalogue does not write (REQ-190). */
function misplural(families: ReadonlySet<string>): string[] {
  return availableLocales().flatMap((locale) => {
    const written = pluralFormsOf(flatten(loadCatalogue(locale)));

    return [...families].flatMap((base) =>
      pluralCategoriesOf(locale)
        .filter((category) => !(written.get(base) ?? new Set()).has(category))
        .map((category) => `${locale}: ${base}_${category}`),
    );
  });
}

/**
 * A count the language puts in `category`, found by asking rather than tabled.
 *
 * Probes and not a table for the same reason the categories are derived: which
 * number lands in `many` is Portuguese's business, and writing 1000000 down
 * here would be this file claiming to know a rule it does not own. The probes
 * only have to be wide enough to contain one member of every category, and a
 * category with no probe is reported by the check that calls this.
 */
function countIn(locale: string, category: string): number | undefined {
  const rules = new Intl.PluralRules(locale);
  const probes = [
    ...Array.from({ length: 201 }, (_, step) => step),
    ...Array.from({ length: 9 }, (_, power) => 10 ** (power + 1)),
    ...Array.from({ length: 9 }, (_, power) => 3 * 10 ** (power + 1)),
  ];

  return probes.find((count) => rules.select(count) === category);
}

/** Flat leaf paths of a catalogue, the form `t` addresses them by. */
function flatten(value: unknown, prefix = ""): string[] {
  return typeof value === "object" && value !== null
    ? Object.entries(value).flatMap(([key, nested]) =>
        flatten(nested, prefix === "" ? key : `${prefix}.${key}`),
      )
    : [prefix];
}

/**
 * The same walk, keeping the text beside its key: parity is about the keys, and
 * a promise is in what they say.
 */
function sentencesOf(value: unknown, prefix = ""): [string, string][] {
  if (typeof value === "object" && value !== null) {
    return Object.entries(value).flatMap(([key, nested]) =>
      sentencesOf(nested, prefix === "" ? key : `${prefix}.${key}`),
    );
  }

  return typeof value === "string" ? [[prefix, value]] : [];
}

function parseSource(file: string, text: string): ts.SourceFile {
  // The script kind follows the extension, which is what lets the same helper
  // read a `.ts` module and a `.tsx` screen.
  return ts.createSourceFile(file, text, ts.ScriptTarget.ESNext, true);
}

/** A catalogue key a lookup asks for, and where the reader would find it. */
interface Lookup {
  readonly file: string;
  readonly key: string;
  /**
   * The constant the key came out of, when it did not come out of a literal.
   *
   * Kept because it is what an offender has to be REPORTED by: the path itself
   * is written nowhere near the lookup, so `t("...")` in a message would send
   * whoever reads it looking for a string the call site does not contain.
   */
  readonly via?: string;
}

/**
 * Every catalogue key a file asks for, including the ones it reaches through a
 * constant (REQ-188).
 *
 * Two of the three keys reached this way are FALLBACKS: `t(KEYS[type] ??
 * MEDIA_FALLBACK_KEY)` and the `?? UNKNOWN_REFUSAL_KEY` at the end of
 * `refusalKey` are the sentences shown when a value this build never heard of
 * arrives, so they are the least exercised text in the catalogue AND the text a
 * walker reading only literal arguments could not see at all. The eye covers
 * neither. Measured before this: dropping `screens.automations.refusalUnknown`
 * from both catalogues failed nothing in the whole suite.
 *
 * What is followed is bounded on purpose, and the bound is "a value this file
 * settles": a module-level constant holding a literal, either side of a `??`,
 * both branches of a `?:`, and the returns of a function declared here. An
 * identifier that is a parameter, a local, or an import resolves to nothing and
 * is reported as nothing, because a guess there would accuse a correct lookup
 * and a guard that cries wolf is a guard people learn to skip.
 */
function catalogueKeysIn(source: ts.SourceFile): Lookup[] {
  const constants = stringConstantsIn(source);
  const returns = returnedExpressionsIn(source);
  const found: Lookup[] = [];

  const keysOf = (
    node: ts.Expression,
    entered: ReadonlySet<string>,
  ): Lookup[] => {
    if (ts.isStringLiteral(node)) {
      return [{ file: source.fileName, key: node.text }];
    }
    if (ts.isParenthesizedExpression(node)) {
      return keysOf(node.expression, entered);
    }
    // `t(created ? "cli.imported" : "cli.replaced")`: two keys, both written
    // down, and both have to exist.
    if (ts.isConditionalExpression(node)) {
      return [
        ...keysOf(node.whenTrue, entered),
        ...keysOf(node.whenFalse, entered),
      ];
    }
    // `t(KEYS[type] ?? FALLBACK_KEY)`: the record's rows are held by REQ-174,
    // and the fallback on the right is what nothing reached before this.
    if (
      ts.isBinaryExpression(node) &&
      FALLBACK_OPERATORS.includes(node.operatorToken.kind)
    ) {
      return [...keysOf(node.left, entered), ...keysOf(node.right, entered)];
    }
    if (ts.isIdentifier(node)) {
      const value = constants.get(node.text);

      return value === undefined
        ? []
        : [{ file: source.fileName, key: value, via: node.text }];
    }
    // `t(refusalKey(refusal))`: the key is decided inside a function of this
    // file, and its last resort is the constant nothing else names. The name is
    // recorded on the way in, so a function that calls itself stops here rather
    // than recursing forever.
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      !entered.has(node.expression.text)
    ) {
      const inner = new Set([...entered, node.expression.text]);

      return (returns.get(node.expression.text) ?? []).flatMap((expression) =>
        keysOf(expression, inner),
      );
    }
    return [];
  };

  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "t"
    ) {
      const [key] = node.arguments;
      if (key !== undefined) {
        found.push(...keysOf(key, new Set()));
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(source);
  return found;
}

/** The operators that put a fallback key on the right of a lookup. */
const FALLBACK_OPERATORS: readonly ts.SyntaxKind[] = [
  ts.SyntaxKind.QuestionQuestionToken,
  ts.SyntaxKind.BarBarToken,
];

/**
 * Module-level `const NAME = "text"` declarations, by name.
 *
 * Module level and nothing narrower, which is what keeps this from needing a
 * type checker: a name declared once at the top of a file has one value in that
 * file, while a local can be reassigned, shadowed, or built from a parameter.
 */
function stringConstantsIn(source: ts.SourceFile): Map<string, string> {
  const constants = new Map<string, string>();

  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) {
      continue;
    }
    for (const declaration of statement.declarationList.declarations) {
      const value = declaration.initializer;
      if (
        ts.isIdentifier(declaration.name) &&
        value !== undefined &&
        ts.isStringLiteral(value)
      ) {
        constants.set(declaration.name.text, value.text);
      }
    }
  }

  return constants;
}

/** What each function declared at the top of a file returns, by name. */
function returnedExpressionsIn(
  source: ts.SourceFile,
): Map<string, ts.Expression[]> {
  const returns = new Map<string, ts.Expression[]>();

  for (const statement of source.statements) {
    if (
      !ts.isFunctionDeclaration(statement) ||
      statement.name === undefined ||
      statement.body === undefined
    ) {
      continue;
    }

    const returned: ts.Expression[] = [];
    const visit = (node: ts.Node): void => {
      // A nested function's returns are its own, and reading them as this
      // one's would attribute a key to a call that never produces it.
      if (
        ts.isFunctionDeclaration(node) ||
        ts.isFunctionExpression(node) ||
        ts.isArrowFunction(node)
      ) {
        return;
      }
      if (ts.isReturnStatement(node) && node.expression !== undefined) {
        returned.push(node.expression);
      }
      ts.forEachChild(node, visit);
    };

    ts.forEachChild(statement.body, visit);
    returns.set(statement.name.text, returned);
  }

  return returns;
}

let lookupCache: Lookup[] | undefined;

/**
 * Every catalogue lookup both sides of the boundary make. Cached: three checks
 * ask for it and the walk parses every source.
 */
function lookupKeys(): Lookup[] {
  lookupCache ??= [...productionFiles(), ...interfaceFiles()].flatMap((file) =>
    catalogueKeysIn(parseSource(file, readFileSync(file, "utf8"))),
  );

  return lookupCache;
}

/**
 * Every lookup the default catalogue cannot answer, named where it is written
 * (REQ-074).
 *
 * Through `addressable`, because a lookup with a count names the BASE and the
 * catalogue carries the forms (REQ-182).
 *
 * Once each, because one constant read from two branches of the same function
 * is one thing to fix and repeating it only makes the report longer. The file
 * is part of what is compared, so the same key missing on two screens is still
 * two lines.
 */
function unanswered(lookups: readonly Lookup[]): string[] {
  const known = addressable(flatten(loadCatalogue(DEFAULT_LOCALE)));

  return [
    ...new Set(
      lookups
        .filter((lookup) => !known.has(lookup.key))
        .map(
          (lookup) =>
            `${lookup.file.replace(repoRoot, "")}: ` +
            (lookup.via === undefined
              ? `t("${lookup.key}")`
              : `t(${lookup.via}) = "${lookup.key}"`),
        ),
    ),
  ];
}

/**
 * A record the interface indexes to turn a value it holds into a catalogue key
 * (REQ-174).
 */
interface LabelRecord {
  readonly file: string;
  readonly name: string;
  /** The key type it is written over. `string` means no compiler reaches it. */
  readonly keyedBy: string;
  readonly keys: readonly string[];
  /** Spread into a list the screen publishes for a catalogue check to read. */
  readonly listed: boolean;
}

/**
 * Records left open on purpose, each with the reason, because an omission and
 * a forgetting look identical from here.
 *
 * Exact file and name rather than a pattern: `MEDIA_KEYS` is dispensed, and a
 * `MEDIA_TITLE_KEYS` added beside it tomorrow inherits nothing.
 */
const DISPENSED: readonly {
  readonly file: string;
  readonly name: string;
  readonly reason: string;
}[] = [];

let recordCache: LabelRecord[] | undefined;

/** Every label record the interface holds. Cached: three checks ask for it. */
function labelRecords(): LabelRecord[] {
  recordCache ??= interfaceFiles().flatMap((file) =>
    labelRecordsIn(parseSource(file, readFileSync(file, "utf8"))),
  );

  return recordCache;
}

/** A record named where it lives, which is how an offender has to be reported. */
function label(record: LabelRecord): string {
  return `${record.file.replace(repoRoot, "")}: ${record.name}`;
}

/** Every record reached by neither guarantee and dispensed by nobody. */
function uncovered(records: readonly LabelRecord[]): string[] {
  const dispensed = new Set(
    DISPENSED.map(
      (dispensation) => `${dispensation.file}: ${dispensation.name}`,
    ),
  );

  return records
    .filter(
      (record) =>
        record.keyedBy === "string" &&
        !record.listed &&
        !dispensed.has(label(record)),
    )
    .map((record) => label(record));
}

/**
 * The label records of one source, each already told whether the file lists it.
 *
 * A record of KEYS and not any record: the value type has to be `string`, which
 * leaves out the tints and icons keyed by the same unions, and every value has
 * to read as a catalogue path, which leaves out a `Record<T, string>` of icon
 * names. Both shapes live beside the real records on these screens, so a census
 * that took either would accuse the design system of losing a sentence.
 */
function labelRecordsIn(source: ts.SourceFile): LabelRecord[] {
  const listed = listedRecords(source);
  const records: LabelRecord[] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      const [keyType, valueType] =
        node.type === undefined ? [] : (recordArguments(node.type) ?? []);
      const initializer = node.initializer;
      const keys =
        valueType?.kind === ts.SyntaxKind.StringKeyword &&
        initializer !== undefined &&
        ts.isObjectLiteralExpression(initializer)
          ? initializer.properties.map((property) =>
              ts.isPropertyAssignment(property) &&
              ts.isStringLiteral(property.initializer)
                ? property.initializer.text
                : "",
            )
          : [];

      // A catalogue path in every row, or this is a record of something else.
      if (keys.length > 0 && keys.every((key) => key.includes("."))) {
        records.push({
          file: source.fileName,
          name: node.name.text,
          keyedBy: keyType?.getText(source) ?? "",
          keys,
          listed: listed.has(node.name.text),
        });
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(source);
  return records;
}

/** The two type arguments of `Record<K, V>`, through any `Readonly` wrapping. */
function recordArguments(
  type: ts.TypeNode,
): readonly [ts.TypeNode | undefined, ts.TypeNode | undefined] | undefined {
  if (!ts.isTypeReferenceNode(type) || !ts.isIdentifier(type.typeName)) {
    return undefined;
  }

  const args = type.typeArguments ?? [];
  const [first, second] = args;

  if (type.typeName.text === "Readonly" && args.length === 1 && first) {
    return recordArguments(first);
  }

  return type.typeName.text === "Record" && args.length === 2
    ? [first, second]
    : undefined;
}

/**
 * Every record a source spreads into a list it EXPORTS.
 *
 * Exported, because a list nothing outside the file can read is a list no check
 * reads either, and the guarantee this stands for is that something holds the
 * keys against the catalogue. `...Object.values(NAME)` is the one shape that
 * counts: a list repeating the keys as literals would drift from the record it
 * copied, and drift is what the guarantee is against.
 */
function listedRecords(source: ts.SourceFile): Set<string> {
  const names = new Set<string>();

  const visit = (node: ts.Node): void => {
    const exported =
      ts.isVariableStatement(node) &&
      (node.modifiers ?? []).some(
        (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
      );

    if (exported && ts.isVariableStatement(node)) {
      for (const declaration of node.declarationList.declarations) {
        const initializer = declaration.initializer;
        if (
          initializer !== undefined &&
          ts.isArrayLiteralExpression(initializer)
        ) {
          for (const element of initializer.elements) {
            const spread = spreadRecordName(element);
            if (spread !== undefined) {
              names.add(spread);
            }
          }
        }
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(source);
  return names;
}

/** The record name of a `...Object.values(NAME)` element, when that is one. */
function spreadRecordName(element: ts.Expression): string | undefined {
  if (
    !ts.isSpreadElement(element) ||
    !ts.isCallExpression(element.expression)
  ) {
    return undefined;
  }

  const call = element.expression;
  const [argument] = call.arguments;

  return ts.isPropertyAccessExpression(call.expression) &&
    ts.isIdentifier(call.expression.expression) &&
    call.expression.expression.text === "Object" &&
    call.expression.name.text === "values" &&
    argument !== undefined &&
    ts.isIdentifier(argument)
    ? argument.text
    : undefined;
}

/** Attributes a browser puts in front of a person, so their value is text. */
const VISIBLE_ATTRIBUTES = ["title", "alt", "placeholder", "aria-label"];

/**
 * Spacing rather than a sentence: a string with no word in it (REQ-175).
 *
 * Tolerated, and tolerated in every shape the guard reads, because there is
 * nothing in a space to translate and `{" "}` is how React writes the space
 * that JSX would otherwise swallow between two elements. Judging that by where
 * it was written is what this stands against: the guard used to let a space
 * pass as text and accuse the same space as an expression, which made the
 * canonical spelling of a space the one spelling it refused.
 *
 * Content and not braces: `{" mind the gap "}` has words in it and is text
 * again, so tolerating the space opens no door for REQ-074.
 */
function isSpacing(text: string): boolean {
  return text.trim() === "";
}

/**
 * Every string a screen would put on the page without going through the
 * catalogue: text between tags, a string expression rendered as a child, and
 * the visible attributes above.
 *
 * Parsing rather than matching text, for the same reason the error check
 * parses: a regex would flag the catalogue keys, the test ids and every
 * comment that quotes a sentence.
 */
function visibleLiteralsIn(source: ts.SourceFile): string[] {
  const offenders: string[] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isJsxText(node) && !isSpacing(node.text)) {
      offenders.push(node.text);
    }

    if (
      ts.isJsxExpression(node) &&
      node.expression !== undefined &&
      ts.isStringLiteral(node.expression) &&
      !isSpacing(node.expression.text)
    ) {
      offenders.push(node.expression.text);
    }

    if (
      ts.isJsxAttribute(node) &&
      ts.isIdentifier(node.name) &&
      VISIBLE_ATTRIBUTES.includes(node.name.text) &&
      node.initializer !== undefined &&
      ts.isStringLiteral(node.initializer) &&
      !isSpacing(node.initializer.text)
    ) {
      offenders.push(`${node.name.text}=${node.initializer.text}`);
    }

    ts.forEachChild(node, visit);
  };

  visit(source);
  return offenders;
}

/** A published catalogue section, in the language whose import named it. */
interface Section {
  readonly locale: string;
  /** The path of the section, empty when the whole catalogue was spread. */
  readonly section: string;
}

/**
 * A local object a test spreads over a published catalogue section (REQ-184).
 *
 * Either the merge is aimed and readable, and every key it declares is held
 * against the section, or it carries the DOUBT that stopped this check from
 * aiming it. The doubt is a member of the type rather than a silent skip: an
 * overlay quietly dropped is an overlay nobody ever checks again, which is the
 * shape of the hole this whole requirement is about.
 */
type Overlay =
  | {
      readonly file: string;
      readonly fixture: string;
      readonly locale: string;
      readonly section: string;
      readonly keys: readonly string[];
    }
  | {
      readonly file: string;
      readonly fixture: string;
      readonly doubt: string;
    };

/** How an overlay is reported: what to open, and against what to read it. */
function nameOf(overlay: Overlay): string {
  return "doubt" in overlay
    ? `${overlay.file}: ${overlay.fixture}: ${overlay.doubt}`
    : `${overlay.file}: ${overlay.fixture} over ${overlay.locale}:${overlay.section}`;
}

/**
 * Every key an overlay declares that its published section does not carry, and
 * every overlay this check could not aim (REQ-184).
 *
 * Addressed keys and not the raw paths, so a fixture naming the base of a
 * plural family is not accused of a key the catalogue answers to under its
 * forms (REQ-190): the caller writes `t("...minutes", { count })` and the
 * catalogue writes `minutes_one`, and both are the same key.
 */
function unconfirmed(overlay: Overlay): string[] {
  if ("doubt" in overlay) {
    return [nameOf(overlay)];
  }

  const carried = addressable(flatten(loadCatalogue(overlay.locale)));

  return overlay.keys
    .map((key) => (overlay.section === "" ? key : `${overlay.section}.${key}`))
    .filter((path) => !carried.has(path))
    .map((path) => `${nameOf(overlay)}: ${path}`);
}

/** Every merge the test corpus declares, in every test source (REQ-184). */
function overlays(): Overlay[] {
  return testFiles().flatMap((file) =>
    overlaysIn(parseSource(file, readFileSync(file, "utf8"))),
  );
}

/**
 * The merges a single source declares, found by shape.
 *
 * The shape is one object literal spreading BOTH a local object and a published
 * section: `{ ...X, ...en.screens.flows }` and `{ ...en.screens.flows, ...X }`
 * are the same merge, and the order only decides which side wins a collision.
 * Nothing here knows a fixture's name, because the name is the convention of
 * one wave and the requirement is about all of them.
 *
 * Everything spread that is NOT a published section counts as the fixture, down
 * to a spread whose keys cannot be read: reading only the identifiers this
 * check can resolve would let a merge pass unexamined for the very reason that
 * makes it hard to examine.
 */
function overlaysIn(file: ts.SourceFile): Overlay[] {
  const catalogues = catalogueImportsIn(file);

  if (catalogues.size === 0) {
    // No name in the file can reach a published section, so no spread in it can
    // be a merge. Most test sources stop here.
    return [];
  }

  const declared = declarationsIn(file, catalogues);
  const where = file.fileName.replace(repoRoot, "");
  const found: Overlay[] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isObjectLiteralExpression(node)) {
      const spread = node.properties
        .filter(ts.isSpreadAssignment)
        .map((property) => property.expression);
      const aimed = spread.map((expression) => ({
        expression,
        section: sectionOf(expression, catalogues, declared.aliases),
      }));
      // By identity and not by count: the same section spread twice, once
      // directly and once through an alias, still aims the merge at one place.
      const sections = new Map<string, Section>(
        aimed.flatMap((entry) =>
          entry.section === undefined
            ? []
            : [
                [
                  `${entry.section.locale}:${entry.section.section}`,
                  entry.section,
                ] as const,
              ],
        ),
      );
      const fixtures = aimed.filter((entry) => entry.section === undefined);

      for (const fixture of fixtures) {
        if (sections.size === 0) {
          // Not a merge at all: an object built out of local pieces says
          // nothing about the published catalogue.
          continue;
        }

        found.push(
          overlayOf(
            where,
            fixture.expression,
            [...sections.values()],
            declared,
          ),
        );
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(file);
  return found;
}

/** One merge, aimed at its section when the shape allows it to be aimed. */
function overlayOf(
  file: string,
  expression: ts.Expression,
  sections: readonly Section[],
  declared: Declarations,
): Overlay {
  const fixture = ts.isIdentifier(expression)
    ? expression.text
    : expression.getText();
  const [only] = sections;

  if (sections.length !== 1 || only === undefined) {
    return {
      file,
      fixture,
      doubt:
        "spread over more than one catalogue section, so which one it extends cannot be told",
    };
  }

  const literal = ts.isIdentifier(expression)
    ? declared.fixtures.get(expression.text)
    : undefined;
  const keys =
    literal === undefined || declared.ambiguous.has(fixture)
      ? undefined
      : declaredKeysIn(literal);

  if (keys === undefined) {
    // Reported and not skipped, and reported as a doubt rather than as a
    // missing key: the merge is real, this check cannot read what it declares,
    // and saying so sends somebody to look instead of accusing a key that may
    // well be published.
    return { file, fixture, doubt: "declares keys this check cannot read" };
  }

  return { file, fixture, locale: only.locale, section: only.section, keys };
}

/** What a source's own names mean: the fixtures, and the section aliases. */
interface Declarations {
  readonly fixtures: ReadonlyMap<string, ts.ObjectLiteralExpression>;
  /** Names declared more than once, whose value cannot be told from the name. */
  readonly ambiguous: ReadonlySet<string>;
  readonly aliases: ReadonlyMap<string, Section>;
}

/**
 * Both halves of what a spread identifier can mean, collected in one walk.
 *
 * The aliases matter as much as the fixtures: `const copy = en.screens.dashboard`
 * is a name for PUBLISHED text, and a check that took every spread identifier
 * for a local object would report a whole published section as unconfirmed.
 * Names declared twice are recorded rather than resolved, because scope is not
 * something this walk can decide and picking one of the two would be a guess.
 */
function declarationsIn(
  file: ts.SourceFile,
  catalogues: ReadonlyMap<string, string>,
): Declarations {
  const fixtures = new Map<string, ts.ObjectLiteralExpression>();
  const aliases = new Map<string, Section>();
  const ambiguous = new Set<string>();
  const seen = new Set<string>();

  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      const name = node.name.text;

      if (seen.has(name)) {
        ambiguous.add(name);
      }
      seen.add(name);

      const section =
        node.initializer === undefined
          ? undefined
          : sectionOf(node.initializer, catalogues, aliases);

      if (section !== undefined) {
        aliases.set(name, section);
      } else if (
        node.initializer !== undefined &&
        ts.isObjectLiteralExpression(node.initializer)
      ) {
        fixtures.set(name, node.initializer);
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(file);
  return { fixtures, ambiguous, aliases };
}

/** The published section an expression names, when it names one. */
function sectionOf(
  expression: ts.Expression,
  catalogues: ReadonlyMap<string, string>,
  aliases: ReadonlyMap<string, Section>,
): Section | undefined {
  if (ts.isIdentifier(expression)) {
    const locale = catalogues.get(expression.text);

    return locale === undefined
      ? aliases.get(expression.text)
      : { locale, section: "" };
  }

  if (ts.isPropertyAccessExpression(expression)) {
    const base = sectionOf(expression.expression, catalogues, aliases);

    return base === undefined
      ? undefined
      : {
          locale: base.locale,
          section:
            base.section === ""
              ? expression.name.text
              : `${base.section}.${expression.name.text}`,
        };
  }

  return undefined;
}

/**
 * The leaf keys an object literal declares, or nothing when one cannot be read.
 *
 * Nothing rather than the readable subset: a fixture holding a computed name or
 * a spread of its own declares keys this walk cannot enumerate, and answering
 * with the rest would report a merge as fully confirmed while part of it went
 * unread.
 */
function declaredKeysIn(
  literal: ts.ObjectLiteralExpression,
  prefix = "",
): string[] | undefined {
  const keys: string[] = [];

  for (const property of literal.properties) {
    if (ts.isShorthandPropertyAssignment(property)) {
      keys.push(
        prefix === "" ? property.name.text : `${prefix}.${property.name.text}`,
      );
      continue;
    }

    if (!ts.isPropertyAssignment(property)) {
      return undefined;
    }

    const name =
      ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)
        ? property.name.text
        : undefined;

    if (name === undefined) {
      return undefined;
    }

    const path = prefix === "" ? name : `${prefix}.${name}`;

    if (ts.isObjectLiteralExpression(property.initializer)) {
      const nested = declaredKeysIn(property.initializer, path);

      if (nested === undefined) {
        return undefined;
      }

      keys.push(...nested);
      continue;
    }

    keys.push(path);
  }

  return keys;
}

/** The local name each shipped catalogue was imported under, if any. */
function catalogueImportsIn(file: ts.SourceFile): Map<string, string> {
  const found = new Map<string, string>();

  for (const statement of file.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      statement.importClause?.name === undefined ||
      !ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      continue;
    }

    const locale = localeImported(
      file.fileName,
      statement.moduleSpecifier.text,
    );

    if (locale !== undefined) {
      found.set(statement.importClause.name.text, locale);
    }
  }

  return found;
}

/**
 * The locale a specifier imports, when it imports a shipped catalogue.
 *
 * Resolved as a path and held against the locales directory, rather than read
 * off the spelling of the specifier: what decides the language a merge is
 * measured against is which FILE it imported, and a catalogue named `en.json`
 * somewhere else is not this one.
 */
function localeImported(file: string, specifier: string): string | undefined {
  const resolved = join(dirname(file), specifier);

  if (dirname(resolved) !== localesDir) {
    return undefined;
  }

  const locale = basename(resolved, ".json");

  return availableLocales().includes(locale) ? locale : undefined;
}

/** Every test source, both extensions: the fixtures live in the `.tsx` ones. */
function testFiles(): string[] {
  return [
    ...globSync("src/**/*.test.ts", { cwd: repoRoot }),
    ...globSync("src/**/*.test.tsx", { cwd: repoRoot }),
  ].map((relative) => `${repoRoot}${relative}`);
}

/**
 * Production sources only. Tests legitimately construct errors with literal
 * messages — that is a fixture, not operator-facing text.
 */
function productionFiles(): string[] {
  return globSync("src/**/*.ts", { cwd: repoRoot })
    .filter((relative) => !relative.endsWith(".test.ts"))
    .map((relative) => `${repoRoot}${relative}`);
}

/** The screens, which the `.ts` glob above does not reach. */
function interfaceFiles(): string[] {
  return globSync("src/web/**/*.tsx", { cwd: repoRoot })
    .filter((relative) => !relative.endsWith(".test.tsx"))
    .map((relative) => `${repoRoot}${relative}`);
}
