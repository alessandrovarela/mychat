import { describe, expect, it } from "vitest";
import {
  decodeNoMatch,
  encodeNoMatch,
  MATCH_REFUSALS,
  matchAutomation,
  matchesKeyword,
  matchEvent,
} from "./matching.js";
import type { InboundEvent } from "./matching.js";
import { validateUnifiedAutomation } from "./validation.js";
import type { ActiveAutomation, UnifiedAutomation } from "./schema.js";

/**
 * Proves REQ-013, REQ-014 and REQ-064: what fires an automation and what does
 * not.
 *
 * Being wrong here is expensive in both directions — firing for someone who
 * did not ask is spam, staying silent for someone who did is the product not
 * working — so each mode is pinned to the behaviour that distinguishes it from
 * its neighbours.
 */

function automation(
  trigger: unknown,
  overrides: Record<string, unknown> = {},
): UnifiedAutomation {
  const result = validateUnifiedAutomation({
    schema_version: 2,
    kind: "automation",
    id: "a1",
    state: "active",
    trigger,
    rules: { once_per_contact: true },
    steps: [
      {
        id: "deliver",
        action: "send_dm",
        message: { text: "oi" },
      },
    ],
    ...overrides,
  });
  if (!result.ok) {
    throw new Error(
      `fixture automation invalid: ${JSON.stringify(result.issues)}`,
    );
  }
  return result.value;
}

function commentTrigger(
  target: string,
  keywords: string[],
  mode: "contains" | "exact" = "contains",
): unknown {
  return { type: "comment", target, match: { keywords, mode } };
}

/** REQ-262: the branch that declares no word at all. */
function anyWordTrigger(target: string): unknown {
  return { type: "comment", target, match: { mode: "any" } };
}

const COMMENT: InboundEvent = {
  origin: "comment",
  text: "eu quero isso",
  contactId: "contact-1",
  publicationId: "pub-1",
  commentId: "comment-1",
};

describe("REQ-013: keyword matching modes", () => {
  it("contains matches a substring", () => {
    expect(matchesKeyword("eu quero isso", "quero", "contains")).toBe(true);
  });

  it("exact does NOT match a substring — that is why it exists", () => {
    expect(matchesKeyword("eu quero isso", "quero", "exact")).toBe(false);
    expect(matchesKeyword("quero", "quero", "exact")).toBe(true);
  });

  it("ignores case and surrounding blanks, which never carry intent", () => {
    expect(matchesKeyword("  QUERO  ", "quero", "exact")).toBe(true);
  });

  it("does NOT fold accents, because in Portuguese they distinguish words", () => {
    // Folding would make "e" match "é", which is a different word.
    expect(matchesKeyword("e", "é", "exact")).toBe(false);
  });

  it("REQ-136: matches across Unicode forms, which look identical on screen", () => {
    // The SAME word, written the two ways Unicode allows. A keyboard decides
    // which one it produces, and nobody can tell them apart by looking.
    const composed = "código".normalize("NFC");
    const decomposed = "código".normalize("NFD");
    expect(composed).not.toBe(decomposed);

    // Both directions: the keyword may be stored either way, and so may the
    // comment. Before REQ-136 every one of these returned false.
    expect(matchesKeyword(decomposed, composed, "contains")).toBe(true);
    expect(matchesKeyword(composed, decomposed, "contains")).toBe(true);
    expect(matchesKeyword(decomposed, composed, "exact")).toBe(true);
    expect(matchesKeyword(composed, decomposed, "exact")).toBe(true);

    // And inside a real sentence, which is how "contains" is actually used.
    expect(
      matchesKeyword(`quero o ${decomposed} por favor`, composed, "contains"),
    ).toBe(true);
  });

  it("REQ-136: folding the FORM does not fold the accent itself", () => {
    // The guard for the fix above: normalising must not turn into stripping.
    expect(matchesKeyword("avo", "avô", "exact")).toBe(false);
    expect(matchesKeyword("esta", "está", "exact")).toBe(false);
  });

  /**
   * REQ-259. The advanced expression is gone from the format, so an aggregate
   * that declares it is refused on the way IN and never reaches this function.
   *
   * Asserted through the validator rather than through `matchesKeyword`,
   * because the removal that matters is the one no other writer can go round:
   * a mode refused only by the editor would arrive intact from the API, from an
   * import, or from a row somebody wrote by hand.
   */
  it("REQ-259: an automation declaring the advanced expression is refused", () => {
    const refused = validateUnifiedAutomation({
      schema_version: 2,
      kind: "automation",
      id: "a1",
      state: "active",
      trigger: {
        type: "comment",
        target: "pub-1",
        match: { keywords: ["^quero\\b"], mode: "regex" },
      },
      rules: { once_per_contact: true },
      steps: [{ id: "deliver", action: "send_dm", message: { text: "oi" } }],
    });

    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.issues.map((issue) => issue.code)).toContain(
      "invalid_shape",
    );
    expect(
      refused.issues.some((issue) => issue.path.includes("trigger.match.mode")),
    ).toBe(true);
  });
});

/**
 * REQ-262: a comment trigger that names no word fires for every comment on the
 * publication it watches.
 *
 * The publication is the whole condition, so what is proved here is that the
 * TEXT stops being one: two comments with nothing in common both fire, and the
 * one on another publication still does not.
 */
describe("REQ-262: any word fires for every comment on the publication", () => {
  it("fires whatever the comment says", () => {
    const watching = automation(anyWordTrigger("pub-1"));

    // An emoji and an empty text included on purpose: they are what a keyword
    // trigger can never match, and what "any word" is chosen precisely to reach.
    for (const text of ["eu quero isso", "que legal", "❤️", ""]) {
      expect(matchAutomation(watching, { ...COMMENT, text }), text).toEqual({
        matched: true,
      });
    }
  });

  it("reports no keyword, because there was none to report", () => {
    // `keyword` absent and not an empty string: an empty string reads as a word
    // that matched, and no word matched anything here.
    const result = matchAutomation(
      automation(anyWordTrigger("pub-1")),
      COMMENT,
    );

    expect(result).toEqual({ matched: true });
    expect(result).not.toHaveProperty("keyword");
  });

  it("still watches ONE publication, and refuses the comments of another", () => {
    // "Any word" widens what is said, never where it is said: the target is
    // asked before the text is, and it is what refuses first.
    expect(
      matchAutomation(automation(anyWordTrigger("pub-2")), COMMENT),
    ).toEqual({ matched: false, reason: "wrong_target" });
  });

  it("never answers `no_keyword`, which cannot apply to it", () => {
    const { fired, refused } = matchEvent(
      [automation(anyWordTrigger("pub-1"), { id: "qualquer" })],
      { ...COMMENT, text: "nada a ver com a palavra" },
    );

    expect(fired.map((entry) => entry.automation.id)).toEqual(["qualquer"]);
    expect(refused).toEqual([]);
  });

  /**
   * REQ-263. The direct message trigger has no such branch, and the SCHEMA is
   * what says so: a prohibition kept in the editor is a promise by convention,
   * and this contract is written by the API and by importers too.
   */
  it("REQ-263: the schema refuses any word on a direct message trigger", () => {
    const refused = validateUnifiedAutomation({
      schema_version: 2,
      kind: "automation",
      id: "a1",
      state: "active",
      trigger: { type: "direct_message", match: { mode: "any" } },
      rules: { once_per_contact: true },
      steps: [{ id: "deliver", action: "send_dm", message: { text: "oi" } }],
    });

    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(
      refused.issues.some((issue) => issue.path.includes("trigger.match")),
    ).toBe(true);
  });

  /**
   * REQ-262's other half: exclusive with the choice by word, and exclusive by
   * SHAPE. The `any` branch declares no `keywords` field, so declaring words
   * beside it is an unrecognised key rather than a combination somebody has to
   * arbitrate at execution time.
   */
  it("REQ-262: refuses any word declared together with keywords", () => {
    const refused = validateUnifiedAutomation({
      schema_version: 2,
      kind: "automation",
      id: "a1",
      state: "active",
      trigger: {
        type: "comment",
        target: "pub-1",
        match: { mode: "any", keywords: ["quero"] },
      },
      rules: { once_per_contact: true },
      steps: [{ id: "deliver", action: "send_dm", message: { text: "oi" } }],
    });

    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(
      refused.issues.some((issue) =>
        issue.path.includes("trigger.match.keywords"),
      ),
    ).toBe(true);
  });
});

describe("REQ-013 / REQ-064: target resolution", () => {
  it("fires when the comment belongs to the targeted publication", () => {
    const result = matchAutomation(
      automation(commentTrigger("pub-1", ["quero"])),
      COMMENT,
    );

    expect(result.matched).toBe(true);
  });

  it("stays silent for a comment on another publication", () => {
    const result = matchAutomation(
      automation(commentTrigger("pub-2", ["quero"])),
      COMMENT,
    );

    expect(result).toEqual({ matched: false, reason: "wrong_target" });
  });

  it("stays silent when no keyword matches", () => {
    const result = matchAutomation(
      automation(commentTrigger("pub-1", ["cupom"])),
      COMMENT,
    );

    expect(result).toEqual({ matched: false, reason: "no_keyword" });
  });

  it("reports which keyword fired, so the trail can say why", () => {
    const result = matchAutomation(
      automation(commentTrigger("pub-1", ["cupom", "quero"])),
      COMMENT,
    );

    expect(result).toEqual({ matched: true, keyword: "quero" });
  });
});

describe("REQ-014: direct message trigger", () => {
  const DM: InboundEvent = {
    origin: "direct_message",
    text: "quero o material",
    contactId: "contact-1",
  };

  it("fires on a direct message whose text matches", () => {
    const result = matchAutomation(
      automation({
        type: "direct_message",
        match: { keywords: ["quero"], mode: "contains" },
      }),
      DM,
    );

    expect(result.matched).toBe(true);
  });

  it("does not fire a comment automation from a direct message", () => {
    const result = matchAutomation(
      automation(commentTrigger("pub-1", ["quero"])),
      DM,
    );

    expect(result).toEqual({ matched: false, reason: "wrong_origin" });
  });

  it("does not fire a direct message automation from a comment", () => {
    const result = matchAutomation(
      automation({
        type: "direct_message",
        match: { keywords: ["quero"], mode: "contains" },
      }),
      COMMENT,
    );

    expect(result).toEqual({ matched: false, reason: "wrong_origin" });
  });
});

describe("REQ-055: a disabled automation never fires", () => {
  it("refuses even when everything else would match", () => {
    const result = matchAutomation(
      automation(commentTrigger("pub-1", ["quero"]), { state: "draft" }),
      COMMENT,
    );

    expect(result).toEqual({ matched: false, reason: "disabled" });
  });
});

/**
 * REQ-058: every automation an event matches fires, and not only the first.
 *
 * Phase 3k removed REQ-218 along with the account-wide comment target, and this
 * is what it did NOT remove: a comment now names one publication, so REQ-217
 * already guarantees at most one comment automation per publication, while a
 * direct message names none and several may legitimately answer the same
 * message.
 */
describe("REQ-058: every matching automation fires", () => {
  it("fires every matching direct-message automation", () => {
    const direct = {
      type: "direct_message",
      match: { keywords: ["quero"], mode: "contains" },
    };
    const { fired } = matchEvent(
      [automation(direct, { id: "a1" }), automation(direct, { id: "a2" })],
      { ...COMMENT, origin: "direct_message", publicationId: undefined },
    );

    expect(fired.map((entry) => entry.automation.id)).toEqual(["a1", "a2"]);
  });

  it("returns nothing when none match", () => {
    expect(
      matchEvent([automation(commentTrigger("pub-1", ["cupom"]))], COMMENT)
        .fired,
    ).toEqual([]);
  });
});

describe("REQ-367: explicit scopes", () => {
  it("lets a global comment automation cover publications without a sentinel target", () => {
    const scoped = {
      ...automation(commentTrigger("pub-1", ["quero"])),
      scope: { type: "global" as const },
      trigger: {
        type: "comment" as const,
        match: { keywords: ["quero"], mode: "contains" as const },
      },
    } as ActiveAutomation;

    expect(matchAutomation(scoped, COMMENT)).toEqual({
      matched: true,
      keyword: "quero",
    });
  });

  it("keeps a next-publication scope inert until it is bound", () => {
    const scoped = {
      ...automation(commentTrigger("pub-1", ["guide"])),
      scope: { type: "next_publication" as const },
      trigger: {
        type: "comment" as const,
        match: { keywords: ["guide"], mode: "contains" as const },
      },
    } as ActiveAutomation;

    expect(matchAutomation(scoped, COMMENT)).toEqual({
      matched: false,
      reason: "wrong_target",
    });
  });
});

/**
 * REQ-160. `matchAutomation` has always known why each automation stayed
 * silent, and the loop over the automations threw every one of those reasons
 * away: it pushed the matches and dropped the refusals, so an operator asking
 * "why did nothing happen" could be told only that nothing had.
 */
describe("REQ-160: the refusals survive the match, aggregated by reason", () => {
  /** One automation per refusal, so a single event exercises all four. */
  const REFUSED_BY_EACH_REASON = [
    automation(commentTrigger("pub-1", ["quero"]), {
      id: "desligada",
      state: "draft",
    }),
    automation(
      {
        type: "direct_message",
        match: { keywords: ["quero"], mode: "contains" },
      },
      { id: "mensagem" },
    ),
    automation(commentTrigger("pub-2", ["quero"]), { id: "outra-pub" }),
    automation(commentTrigger("pub-1", ["cupom"]), { id: "outra-palavra" }),
  ];

  it("distinguishes the four reasons, as codes and not as free text", () => {
    const { fired, refused } = matchEvent(REFUSED_BY_EACH_REASON, COMMENT);

    expect(fired).toEqual([]);
    // Every reason the matching can reach, each naming one automation. The
    // order is the declared one, so the same set always reads the same way.
    //
    // Four since REQ-259: `invalid_pattern` left with the advanced expression
    // that was the only thing able to produce it, and a reason no code can
    // reach is a sentence the panel promises an operator and never shows.
    expect(refused).toEqual([
      { reason: "disabled", count: 1 },
      { reason: "wrong_origin", count: 1 },
      { reason: "wrong_target", count: 1 },
      { reason: "no_keyword", count: 1 },
    ]);
    expect(refused.map((entry) => entry.reason)).toEqual([...MATCH_REFUSALS]);
  });

  it("aggregates by reason with the count, never one entry per automation", () => {
    // Twenty automations whose keyword is simply not in the comment. One entry
    // saying twenty is the record; twenty entries is a trail nobody reads.
    const many = Array.from({ length: 20 }, (_, index) =>
      automation(commentTrigger("pub-1", ["cupom"]), { id: `a${index + 1}` }),
    );

    expect(matchEvent(many, COMMENT).refused).toEqual([
      { reason: "no_keyword", count: 20 },
    ]);
  });

  it("reads the same however the automations happen to be ordered", () => {
    const reversed = [...REFUSED_BY_EACH_REASON].reverse();

    expect(matchEvent(reversed, COMMENT).refused).toEqual(
      matchEvent(REFUSED_BY_EACH_REASON, COMMENT).refused,
    );
  });

  it("keeps the refusals of the automations that did not fire beside the ones that did", () => {
    const { fired, refused } = matchEvent(
      [
        automation(commentTrigger("pub-1", ["quero"]), { id: "casa" }),
        automation(commentTrigger("pub-1", ["cupom"]), { id: "nao-casa" }),
      ],
      COMMENT,
    );

    expect(fired.map((entry) => entry.automation.id)).toEqual(["casa"]);
    expect(refused).toEqual([{ reason: "no_keyword", count: 1 }]);
  });

  it("refuses nothing when there is no automation to refuse", () => {
    expect(matchEvent([], COMMENT)).toEqual({ fired: [], refused: [] });
  });
});

describe("REQ-160: the aggregate travels as codes a reader can parse back", () => {
  it("survives the round trip through the one string the trail stores", () => {
    const refused = matchEvent(
      [
        automation(commentTrigger("pub-1", ["cupom"]), { id: "a1" }),
        automation(commentTrigger("pub-1", ["cupom"]), { id: "a2" }),
        automation(commentTrigger("pub-1", ["quero"]), {
          id: "a3",
          state: "draft",
        }),
      ],
      COMMENT,
    ).refused;

    const stored = encodeNoMatch(refused);

    // Codes, never a sentence: the screen picks the words (REQ-163), so the
    // stored value carries the vocabulary and the counts and nothing else.
    expect(stored).toContain("no_keyword");
    expect(decodeNoMatch(stored)).toEqual(refused);
  });

  it("tells its own record from a reason written in words", () => {
    // The field also holds sentences from other paths, and a row written
    // before REQ-160 holds the old one. Neither may be read as a tally.
    expect(decodeNoMatch("no enabled automation matched this event")).toBe(
      undefined,
    );
    expect(decodeNoMatch(undefined)).toBe(undefined);
    expect(decodeNoMatch('{"code":"something_else","refusals":[]}')).toBe(
      undefined,
    );
  });

  it("refuses a code it does not know instead of quietly dropping it", () => {
    // Skipping the unknown entry would under-report a count the operator reads
    // as complete. Unreadable is visible; a wrong number is not.
    expect(
      decodeNoMatch(
        '{"code":"no_automation_matched","refusals":[{"reason":"invented","count":1}]}',
      ),
    ).toBe(undefined);
    expect(
      decodeNoMatch(
        '{"code":"no_automation_matched","refusals":[{"reason":"no_keyword","count":0}]}',
      ),
    ).toBe(undefined);
  });

  it("keeps the empty aggregate distinct from a reason it cannot read", () => {
    // No automation exists at all, so nothing refused anything. That is an
    // answer, and it is not the same as "this is not one of these records".
    expect(decodeNoMatch(encodeNoMatch([]))).toEqual([]);
  });
});
