import { describe, expect, it } from "vitest";
import { LIMIT_DEFAULTS } from "../config/limits.js";
import { CARD_BUTTON_LIMIT, PURE_LINK_LIMIT } from "./schema.js";
import {
  VALIDATION_ISSUE_CODES,
  validateAutomationActivation,
  validateUnifiedAutomation,
} from "./validation.js";
import type { ValidationIssue } from "./validation.js";

/**
 * The additive private message (REQ-229, REQ-230, REQ-232), judged where it is
 * saved.
 *
 * The contract this file proves replaced a union discriminated by `kind`, and
 * the union is what the product paid for: choosing a card made the written text
 * disappear, choosing a file dropped it at the send, and "a text and a link"
 * could not be written down at all. What is left is one message with parts, and
 * the rules that say what the parts become.
 *
 * Every refusal below is asserted BY NAME — the step, and the field. An
 * operator meets these on the save that refuses to activate, on a screen made
 * of sections rather than JSON paths, and a refusal that cannot say which step
 * and which field sends them hunting through the whole automation.
 */

interface Button {
  id: string;
  label: string;
  url: string;
}

/** What makes the message a card, and the only thing that does (REQ-287). */
const BUTTONS: readonly [Button, Button, Button] = [
  { id: "starter", label: "Starter", url: "https://example.com/1" },
  { id: "advanced", label: "Advanced", url: "https://example.com/2" },
  { id: "extra", label: "Extra", url: "https://example.com/3" },
];

/**
 * The other form: an address, and nothing beside it (REQ-286).
 *
 * Written as bare strings because that is the shape, and the shape is the
 * requirement: a pure link has no label to show and no id to attribute a click
 * to, since attributing one means delivering `/clicks/<id>` in the address's
 * place and the address is exactly what the destination site is asked to
 * describe.
 */
const LINKS = [
  "https://example.com/video",
  "https://example.com/article",
  "https://example.com/post",
] as const;

function complete() {
  return {
    schema_version: 2,
    kind: "automation",
    id: "launch-post",
    state: "active",
    trigger: {
      type: "comment",
      target: "publication-1",
      match: { keywords: ["guide"], mode: "contains" },
    },
    rules: { once_per_contact: true },
    steps: [
      {
        id: "deliver",
        action: "send_dm",
        message: { buttons: [BUTTONS[0], BUTTONS[1]] },
      },
    ],
  };
}

/** The same automation, with the private message replaced wholesale. */
function withMessage(message: unknown): unknown {
  return {
    ...complete(),
    steps: [{ id: "deliver", action: "send_dm", message }],
  };
}

function issuesOf(aggregate: unknown): readonly ValidationIssue[] {
  const result = validateUnifiedAutomation(aggregate);
  return result.ok ? [] : result.issues;
}

function activationIssuesOf(aggregate: unknown): readonly ValidationIssue[] {
  const result = validateAutomationActivation(aggregate);
  return result.ok ? [] : result.issues;
}

function codes(issues: readonly ValidationIssue[]): string[] {
  return issues.map((entry) => entry.code);
}

describe("v2 aggregate validation", () => {
  it("stores incomplete drafts but refuses to activate them", () => {
    const draft = {
      schema_version: 2,
      kind: "automation",
      id: "unfinished",
      state: "draft",
      steps: [{ id: "deliver", action: "send_dm", message: {} }],
    };
    expect(validateUnifiedAutomation(draft).ok).toBe(true);
    expect(validateAutomationActivation(draft).ok).toBe(false);
  });

  it("activates a complete draft and preserves the order of both lists", () => {
    // REQ-288: the order the editor declared is the order the contact receives,
    // so neither list may be sorted, deduplicated or reassembled on the way
    // through. Both are asserted, because they are two lists now and a reader
    // that preserves one and rebuilds the other would still pass with one.
    const result = validateAutomationActivation({
      ...complete(),
      state: "draft",
      steps: [
        {
          id: "deliver",
          action: "send_dm",
          message: {
            buttons: [BUTTONS[2], BUTTONS[0], BUTTONS[1]],
            links: [LINKS[2], LINKS[0], LINKS[1]],
          },
        },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const step = result.value.steps[0];
    if (step?.action !== "send_dm") return;
    expect(step.message.buttons?.map((button) => button.id)).toEqual([
      "extra",
      "starter",
      "advanced",
    ]);
    expect(step.message.links).toEqual([LINKS[2], LINKS[0], LINKS[1]]);
  });

  it("rejects duplicate stable ids and unsafe destinations", () => {
    const duplicate = complete();
    duplicate.steps[0]!.message.buttons[1] = {
      ...BUTTONS[1],
      id: BUTTONS[0].id,
    };
    expect(codes(issuesOf(duplicate))).toContain("duplicate_button_id");

    const unsafe = complete();
    unsafe.steps[0]!.message.buttons[0] = {
      ...BUTTONS[0],
      url: "javascript:alert(1)",
    };
    expect(validateUnifiedAutomation(unsafe).ok).toBe(false);
  });

  /**
   * REQ-229: what the parts COMBINE into, and what they refuse to combine into.
   *
   * Read as a table on purpose. The rules are few and each one has a
   * consequence a contact can see, so the cases that must be ACCEPTED are
   * asserted beside the ones that must be refused: a contract that only ever
   * refuses is one nobody can write an automation with.
   */
  describe("the message is additive: a text, and parts that add to it", () => {
    it("accepts a text on its own, which goes out as a text message", () => {
      expect(
        validateUnifiedAutomation(withMessage({ text: "here it is" })).ok,
      ).toBe(true);
    });

    it("accepts a text with one button, which is a card whose title it becomes", () => {
      expect(
        validateUnifiedAutomation(
          withMessage({ text: "Grab the guide", buttons: [BUTTONS[0]] }),
        ).ok,
      ).toBe(true);
    });

    it("accepts a text with the three buttons a card carries", () => {
      // The fixture IS the ceiling, held against it here so that raising or
      // lowering one of the two never leaves this file testing a number the
      // format stopped carrying.
      expect(BUTTONS).toHaveLength(CARD_BUTTON_LIMIT);
      expect(LINKS).toHaveLength(PURE_LINK_LIMIT);
      expect(
        validateUnifiedAutomation(
          withMessage({ text: "Pick one", buttons: [...BUTTONS] }),
        ).ok,
      ).toBe(true);
    });

    it("REQ-287: a text with pure links and no button is NOT a card", () => {
      // The requirement, measured where it shows: the same wording is a
      // MESSAGE here and would be a card TITLE beside a button, and the two are
      // held to ceilings twelve times apart. Until phase 3n one link made the
      // card, so this automation was refused for a title nobody had written.
      const long = "x".repeat(LIMIT_DEFAULTS.cardTitleChars + 1);

      expect(
        validateUnifiedAutomation(
          withMessage({ text: long, links: [LINKS[0], LINKS[1]] }),
        ).ok,
      ).toBe(true);
    });

    it("REQ-287: three links and no button still make no card to cover", () => {
      const issues = issuesOf(
        withMessage({
          text: "here it is",
          image: "cover.png",
          links: [...LINKS],
        }),
      );

      expect(codes(issues)).toContain("cover_without_button");
      const refusal = issues.find((one) => one.code === "cover_without_button");
      expect(refusal?.path).toBe("steps[0].message.image");
      expect(refusal?.message).toContain("deliver");
    });

    it("REQ-288: a card and pure links coexist, each list in its own order", () => {
      // Declared against the order a well-meaning normalisation would impose:
      // neither list is alphabetical here, so a reader that sorted either one
      // would answer something else. The order is the operator's, and it is
      // the order the contact receives the messages in.
      const result = validateAutomationActivation(
        withMessage({
          text: "Grab the guide",
          buttons: [BUTTONS[0], BUTTONS[2]],
          links: [LINKS[0], LINKS[1]],
        }),
      );

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const step = result.value.steps[0];
      if (step?.action !== "send_dm") return;
      expect(step.message.buttons?.map((button) => button.id)).toEqual([
        "starter",
        "extra",
      ]);
      expect(step.message.links).toEqual([LINKS[0], LINKS[1]]);
    });

    it("accepts a card with a cover, a title and a description", () => {
      expect(
        validateUnifiedAutomation(
          withMessage({
            image: "cover.png",
            title: "Choose a guide",
            description: "Three useful starting points",
            buttons: [...BUTTONS],
          }),
        ).ok,
      ).toBe(true);
    });

    it("refuses the fourth button, naming the step and the field", () => {
      const issues = issuesOf(
        withMessage({
          buttons: [
            ...BUTTONS,
            { id: "fourth", label: "Fourth", url: "https://example.com/4" },
          ],
        }),
      );

      expect(codes(issues)).toContain("too_many_buttons");
      const refusal = issues.find((one) => one.code === "too_many_buttons");
      expect(refusal?.path).toBe("steps[0].message.buttons");
      expect(refusal?.message).toContain("deliver");
      expect(refusal?.message).toContain(String(CARD_BUTTON_LIMIT));
    });

    it("refuses the fourth link, which would be a fifth message", () => {
      const issues = issuesOf(
        withMessage({ links: [...LINKS, "https://example.com/4"] }),
      );

      expect(codes(issues)).toContain("too_many_links");
      const refusal = issues.find((one) => one.code === "too_many_links");
      expect(refusal?.path).toBe("steps[0].message.links");
      expect(refusal?.message).toContain("deliver");
      expect(refusal?.message).toContain(String(PURE_LINK_LIMIT));
    });

    it("counts the two ceilings apart, and accepts a card with three links", () => {
      // Three buttons and three links is one card and three messages after it,
      // which is what the product offers. Adding the two counts up would refuse
      // a delivery the editor can assemble.
      expect(
        validateUnifiedAutomation(
          withMessage({
            text: "Pick one",
            buttons: [...BUTTONS],
            links: [...LINKS],
          }),
        ).ok,
      ).toBe(true);
    });

    it("REQ-232: refuses a cover with no button to hang it on", () => {
      // The cover belongs to the card, and there is no card without a button.
      // An image with nothing under it is either a button the operator forgot
      // or an image they meant to send, and the two are different messages.
      const issues = issuesOf(
        withMessage({ text: "here it is", image: "cover.png" }),
      );

      expect(codes(issues)).toContain("cover_without_button");
      const refusal = issues.find((one) => one.code === "cover_without_button");
      expect(refusal?.path).toBe("steps[0].message.image");
      expect(refusal?.message).toContain("deliver");
    });

    it("REQ-232: accepts the same cover once a button exists", () => {
      expect(
        validateUnifiedAutomation(
          withMessage({ image: "cover.png", buttons: [BUTTONS[0]] }),
        ).ok,
      ).toBe(true);
    });

    it("refuses an entirely empty message on activation, naming the step", () => {
      const issues = activationIssuesOf(withMessage({}));

      expect(codes(issues)).toContain("message_without_content");
      const refusal = issues.find(
        (one) => one.code === "message_without_content",
      );
      expect(refusal?.path).toBe("steps[0].message");
      expect(refusal?.message).toContain("deliver");
    });

    it("REQ-287: a title on its own is nothing to send, and is refused", () => {
      // A title is the CARD's, so with no button there is no card to carry it
      // and no message goes out at all. It counted as content until phase 3n,
      // which let an automation that delivers silence pass as complete.
      expect(
        codes(activationIssuesOf(withMessage({ title: "Choose a guide" }))),
      ).toContain("message_without_content");
    });

    it("REQ-284: refuses a message that declares an attachment", () => {
      // The anchor case of the old contract, and the shape that is gone: the
      // file reaches the contact as a card button's destination now (REQ-285).
      // Refused at the FIELD, so whoever wrote it is told which part the format
      // stopped carrying, rather than having the key quietly ignored and an
      // automation delivering a text where a PDF was meant.
      const issues = issuesOf(
        withMessage({
          text: "here is the guide",
          attachments: [{ kind: "document", file: "guide.pdf" }],
        }),
      );

      expect(codes(issues)).toContain("invalid_shape");
      expect(issues[0]?.path).toBe("steps[0].message.attachments");
    });

    it("REQ-284: refuses the attachment in a DRAFT too, where it would hide", () => {
      // A draft shape that still held it would accept the old document on the
      // save, keep it while the editor stayed open, and refuse it only at
      // activation, which is the discovery this contract brings forward.
      const issues = issuesOf({
        ...(withMessage({
          attachments: [{ kind: "document", file: "guide.pdf" }],
        }) as Record<string, unknown>),
        state: "draft",
      });

      expect(codes(issues)).toContain("invalid_shape");
      expect(issues[0]?.path).toBe("steps[0].message.attachments");
    });

    it("REQ-286: refuses the retired link shape, which was a button", () => {
      // Until phase 3n a `links` entry was an object with a label and an id,
      // and it made a card. Read as a pure link it would be a card silently
      // demoted to a bare address, with the label the operator wrote dropped on
      // the way, so it is refused by the SHAPE rather than reinterpreted.
      const issues = issuesOf(withMessage({ links: [BUTTONS[0]] }));

      expect(codes(issues)).toContain("invalid_shape");
      expect(issues[0]?.path).toMatch(/^steps\[0\]\.message\.links\[0\]/);
    });
  });

  /**
   * REQ-230: the card's texts are the TEMPLATE's, and the template is short.
   *
   * The gap is the whole point: a text message accepts 1000 bytes and the
   * generic template's element accepts 80 characters. A message with a BUTTON
   * IS that element, so a text measured against the message ceiling passes
   * validation and reaches the contact CUT — which is what used to happen, in
   * silence, on the one path where the text became a title.
   */
  describe("REQ-230: the card's own, short ceilings", () => {
    const overTitle = "x".repeat(LIMIT_DEFAULTS.cardTitleChars + 1);
    const atTitle = "x".repeat(LIMIT_DEFAULTS.cardTitleChars);

    it("accepts a card title over the template limit, which the editor advises", () => {
      expect(
        validateUnifiedAutomation(
          withMessage({ title: overTitle, buttons: [BUTTONS[0]] }),
        ).ok,
      ).toBe(true);
    });

    it("accepts a title of exactly the template limit", () => {
      expect(
        validateUnifiedAutomation(
          withMessage({ title: atTitle, buttons: [BUTTONS[0]] }),
        ).ok,
      ).toBe(true);
    });

    it("refuses a card description over the template limit", () => {
      const description = "x".repeat(LIMIT_DEFAULTS.cardDescriptionChars + 1);
      const issues = issuesOf(
        withMessage({ description, buttons: [BUTTONS[0]] }),
      );

      expect(codes(issues)).toContain("card_description_too_long");
      expect(issues[0]?.path).toBe("steps[0].message.description");
      expect(issues[0]?.message).toContain("deliver");
    });

    it("keeps TEXT over the card ceiling once a button exists", () => {
      // The regression this requirement is written from. The same wording is
      // Fine as a message and as a card title: the platform only cuts its
      // drawing and accepts the complete stored title.
      const long = "x".repeat(LIMIT_DEFAULTS.cardTitleChars + 1);

      expect(validateUnifiedAutomation(withMessage({ text: long })).ok).toBe(
        true,
      );

      expect(
        validateUnifiedAutomation(
          withMessage({ text: long, buttons: [BUTTONS[0]] }),
        ).ok,
      ).toBe(true);
    });

    it("keeps EVERY wording over it, because any one may be the card title", () => {
      expect(
        validateUnifiedAutomation(
          withMessage({
            text: ["short", "x".repeat(LIMIT_DEFAULTS.cardTitleChars + 1)],
            buttons: [BUTTONS[0]],
          }),
        ).ok,
      ).toBe(true);
    });

    it("refuses a text and a card title declared together", () => {
      // With a button the text IS the title, so declaring both leaves one of
      // the two with nowhere to go. Refused rather than arbitrated: silently
      // dropping the loser is the exact fault this contract ended.
      const issues = activationIssuesOf(
        withMessage({
          text: "Grab the guide",
          title: "Choose a guide",
          buttons: [BUTTONS[0]],
        }),
      );

      expect(codes(issues)).toContain("card_title_declared_twice");
      const refusal = issues.find(
        (one) => one.code === "card_title_declared_twice",
      );
      expect(refusal?.path).toBe("steps[0].message.title");
      expect(refusal?.message).toContain("deliver");
    });

    it("keeps a text and a title apart when there is no button", () => {
      // No button, no card, no title travelling anywhere: the title is simply a
      // field this message does not use, and refusing it would refuse a draft
      // the operator is halfway through.
      expect(
        validateAutomationActivation(
          withMessage({ text: "here it is", title: "Choose a guide" }),
        ).ok,
      ).toBe(true);
    });
  });

  /**
   * REQ-087, REQ-125 and REQ-127 against the SHAPE the v2 aggregate uses.
   *
   * These three were proved for years against `step.text`, and phase 3k moved
   * the private message into `message.text` without moving the guards. Nothing
   * turned red, because the suites that held them were deleted in the same
   * phase: a message of any size was accepted, an empty list of wordings was
   * accepted, and only the FIRST wording of a list was ever measured.
   *
   * The paths are asserted, not only the codes. A refusal that cannot say
   * WHICH wording is over the ceiling sends the operator to read a list by eye.
   */
  describe("REQ-087/REQ-125/REQ-127: the guards reach the shape v2 stores", () => {
    const OVER = "a".repeat(1001);
    const AT_LIMIT = "a".repeat(1000);

    /** The aggregate with its steps replaced, read back as the API reads it. */
    function withSteps(steps: readonly unknown[]): unknown {
      return { ...complete(), steps };
    }

    function textMessage(text: unknown): unknown {
      return withSteps([
        { id: "deliver", action: "send_dm", message: { text } },
      ]);
    }

    it("measures the private message, which used to escape the ceiling entirely", () => {
      const issues = issuesOf(textMessage(OVER));
      expect(codes(issues)).toContain("message_text_too_long");
      expect(issues[0]?.path).toBe("steps[0].message.text");
      // The step is named, so the refusal is actionable without counting bytes.
      expect(issues[0]?.message).toContain("deliver");
    });

    it("accepts a private message exactly at the ceiling", () => {
      expect(validateUnifiedAutomation(textMessage(AT_LIMIT)).ok).toBe(true);
    });

    it("measures EVERY wording of a list, and points at the one over", () => {
      const issues = issuesOf(textMessage(["short", OVER]));
      expect(codes(issues)).toEqual(["message_text_too_long"]);
      expect(issues[0]?.path).toBe("steps[0].message.text[1]");
    });

    it("measures what collect_email and follow_gate ask", () => {
      const issues = issuesOf(
        withSteps([
          {
            id: "collect",
            action: "collect_email",
            ask: OVER,
            on_timeout: "abandon",
          },
          ...complete().steps,
        ]),
      );
      expect(codes(issues)).toContain("message_text_too_long");
      expect(issues[0]?.path).toBe("steps[0].ask");
    });

    it("keeps empty email and follow questions in a draft, then refuses each on activation", () => {
      const draft = {
        ...complete(),
        state: "draft",
        steps: [
          {
            id: "collect",
            action: "collect_email",
            ask: "",
            on_timeout: "abandon",
          },
          {
            id: "follow",
            action: "follow_gate",
            ask: "",
            on_timeout: "abandon",
          },
          ...complete().steps,
        ],
      };

      expect(validateUnifiedAutomation(draft).ok).toBe(true);
      const issues = activationIssuesOf(draft);
      expect(codes(issues)).toContain("email_question_without_wording");
      expect(codes(issues)).toContain("follow_question_without_wording");
      expect(issues.map((entry) => entry.path)).toEqual(
        expect.arrayContaining(["steps[0].ask", "steps[1].ask"]),
      );
    });

    it("refuses an empty list of wordings in a private message, naming the step", () => {
      const issues = issuesOf(textMessage([]));
      expect(codes(issues)).toContain("step_without_wording");
      expect(issues[0]?.path).toBe("steps[0].message.text");
      expect(issues[0]?.message).toContain("deliver");
    });

    it("keeps refusing an empty list in a public reply", () => {
      const issues = issuesOf(
        withSteps([
          { id: "answer", action: "reply_comment", text: [] },
          ...complete().steps,
        ]),
      );
      expect(codes(issues)).toContain("step_without_wording");
    });

    it("REQ-306: stores a button label past the ceiling, whole", () => {
      /**
       * This test proved the REFUSAL until phase 3o, and it was right until
       * the platform was measured on the real account on 2026-08-19: a label
       * longer than the configured ceiling was accepted, cut only where it was
       * drawn, and echoed back in full. The ceiling is a point of TRUNCATION,
       * so refusing to store the definition refuses what the platform itself
       * delivers, and the warning belongs to the editor (REQ-307).
       *
       * Stored WHOLE is the half that matters: a validation that quietly
       * shortened the label would pass an `ok` check and still lose the text.
       */
      const long = complete();
      const label = "x".repeat(LIMIT_DEFAULTS.linkButtonLabelChars + 1);
      long.steps[0]!.message.buttons[0] = { ...BUTTONS[0], label };

      const result = validateUnifiedAutomation(long);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const step = result.value.steps?.[0];
      // Asserted before the narrowing, so a shape that lost the step fails
      // here instead of returning early and passing on nothing.
      expect(step?.action).toBe("send_dm");
      if (step?.action !== "send_dm") return;
      expect(step.message?.buttons?.[0]?.label).toBe(label);
    });

    it("REQ-306: activates one whose button label is far past the ceiling", () => {
      // The other door in, and the one that used to be the last chance to
      // refuse: what the contact receives is decided here, and what the
      // contact receives is the cut label of a definition stored whole.
      const long = complete();
      long.steps[0]!.message.buttons[0] = {
        ...BUTTONS[0],
        label: "x".repeat(LIMIT_DEFAULTS.linkButtonLabelChars * 2),
      };

      expect(activationIssuesOf(long)).toStrictEqual([]);
    });
  });

  /**
   * Phase 3k removed the account-wide comment target along with REQ-218. What
   * is left has to be pinned in both directions, because the sentinel it used
   * to be spelled with is still shaped like a publication id: a comment
   * automation names ONE publication and refuses the empty target, while a
   * direct message names none and refuses to declare one.
   */
  describe("a comment automation names one publication", () => {
    /**
     * REQ-260: an identifier, and nothing else.
     *
     * The URL used to be accepted here and turned into an identifier before
     * anything was stored, which cost a credential, a walk of the media edge
     * and four refusals an operator had to read. The grid names a publication
     * now, so the one spelling that reaches storage is the one matching
     * compares against, and every other spelling is refused at the door.
     */
    it("accepts a publication id and refuses an address", () => {
      const identified = complete();
      identified.trigger.target = "17895695668004550";
      expect(validateUnifiedAutomation(identified).ok).toBe(true);

      for (const address of [
        "https://www.instagram.com/p/DZY-w4gjCI5/",
        "https://www.instagram.com/p/DZY-w4gjCI5/?igsh=MWx0eHc",
        "http://instagram.com/reel/DZY-w4gjCI5",
        "https://www.instagram.com/alessandro.varela/",
      ]) {
        const aggregate = complete();
        aggregate.trigger.target = address;
        const issues = issuesOf(aggregate);

        expect(codes(issues), address).toContain("invalid_shape");
        expect(
          issues.some((issue) => issue.path === "trigger.target"),
          address,
        ).toBe(true);
      }
    });

    it("allows a global comment trigger with no publication, but keeps a publication scope specific", () => {
      const global = {
        ...complete(),
        scope: { type: "global" },
      } as { trigger: Record<string, unknown> };
      delete global.trigger.target;
      expect(validateUnifiedAutomation(global).ok).toBe(true);

      const aggregate = complete();
      aggregate.trigger.target = "";
      expect(validateUnifiedAutomation(aggregate).ok).toBe(false);

      const absent = complete() as { trigger: Record<string, unknown> };
      delete absent.trigger["target"];
      expect(validateUnifiedAutomation(absent).ok).toBe(false);

      const specific = {
        ...complete(),
        scope: { type: "publication", publicationId: "publication-1" },
      } as { trigger: Record<string, unknown> };
      delete specific.trigger["target"];
      expect(codes(issuesOf(specific))).toContain("scope_trigger_mismatch");
    });

    it("keeps the direct message free of a publication, which it has none of", () => {
      const withoutTarget = {
        ...complete(),
        trigger: {
          type: "direct_message",
          match: { keywords: ["guide"], mode: "contains" },
        },
        steps: [
          {
            id: "deliver",
            action: "send_dm",
            message: { text: "hi" },
          },
        ],
      };
      expect(validateUnifiedAutomation(withoutTarget).ok).toBe(true);

      // A target on a direct message would be a silent lie about what the
      // automation listens to, and removing the account-wide scope does not
      // make it true.
      expect(
        validateUnifiedAutomation({
          ...withoutTarget,
          trigger: { ...withoutTarget.trigger, target: "17895695668004550" },
        }).ok,
      ).toBe(false);
    });
  });

  /**
   * REQ-258 and REQ-259, at the layer that is written by every writer.
   *
   * Both are removals from the FORMAT, and both are asserted here rather than
   * only against the editor for the same reason: a step or a mode refused by a
   * screen alone arrives intact from the API, from an import, or from a row
   * somebody wrote by hand. What is proved is that the refusal names the place
   * it is about, so whoever meets it can act on it.
   */
  describe("the vocabulary that left the product is refused at the door", () => {
    it("REQ-279: refuses an automation that carries a name", () => {
      // The name was a copy of the publication's caption, taken on the day the
      // automation was saved and never refreshed again. Refused at the FIELD
      // and not merely ignored: a key quietly dropped would let an editor, an
      // import or an API caller go on writing a name, and whoever wrote it
      // would believe the product was showing it.
      const issues = issuesOf({ ...complete(), name: "Launch post" });

      expect(codes(issues)).toContain("invalid_shape");
      expect(issues[0]?.path).toBe("name");
    });

    it("REQ-279: refuses it in a DRAFT too, which is where it would hide", () => {
      // Every field is optional in a draft, so a name written there is the one
      // that survives a removal: saved today, activated after the next deploy.
      const result = validateUnifiedAutomation({
        schema_version: 2,
        kind: "automation",
        id: "unfinished",
        state: "draft",
        name: "Half written",
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.issues[0]?.path).toBe("name");
    });

    it("REQ-279: refuses it on activation, the other door into the format", () => {
      expect(
        activationIssuesOf({ ...complete(), state: "draft", name: "Launch" })
          .length,
      ).toBeGreaterThan(0);
    });

    it("REQ-258: refuses the step that writes a contact attribute", () => {
      const aggregate = {
        ...complete(),
        steps: [
          { id: "tag", action: "set_attribute", key: "source", value: "guide" },
        ],
      };
      const issues = issuesOf(aggregate);

      expect(codes(issues)).toContain("invalid_shape");
      expect(issues.some((issue) => issue.path.startsWith("steps[0]"))).toBe(
        true,
      );
    });

    it("REQ-258: refuses it in a DRAFT too, which is where it would hide", () => {
      // A draft holds what is half written, and that is exactly how a retired
      // step survives a removal: saved today, activated after the next deploy.
      expect(
        validateUnifiedAutomation({
          schema_version: 2,
          kind: "automation",
          id: "unfinished",
          state: "draft",
          steps: [{ id: "tag", action: "set_attribute" }],
        }).ok,
      ).toBe(false);
    });

    it("REQ-258: the refusal code the attribute step needed is gone with it", () => {
      // `attribute_without_value` existed to name a step writing an empty
      // value. No step can declare one now, so the code names nothing: a
      // vocabulary that outlives what it described is a promise to a reader
      // that no path can keep.
      expect([...VALIDATION_ISSUE_CODES]).not.toContain(
        "attribute_without_value",
      );
    });

    it("REQ-306: the two refusals by length name nothing, and are gone", () => {
      // Same rule as the code above, applied to a refusal that was never
      // decided: the platform truncates these two fields, so no path can ever
      // raise them again. Leaving the words in the vocabulary would invite the
      // next reader to wire them back up.
      expect([...VALIDATION_ISSUE_CODES]).not.toContain(
        "quick_reply_label_too_long",
      );
      expect([...VALIDATION_ISSUE_CODES]).not.toContain(
        "button_label_too_long",
      );
    });

    it("REQ-259: refuses the advanced expression, naming the mode", () => {
      const aggregate = complete();
      aggregate.trigger.match = { keywords: ["^quero\\b"], mode: "regex" };
      const issues = issuesOf(aggregate);

      expect(codes(issues)).toContain("invalid_shape");
      expect(issues.some((issue) => issue.path === "trigger.match.mode")).toBe(
        true,
      );
    });

    it("REQ-259: refuses it on a direct message trigger as well", () => {
      expect(
        validateUnifiedAutomation({
          ...complete(),
          trigger: {
            type: "direct_message",
            match: { keywords: ["^quero"], mode: "regex" },
          },
          steps: [{ id: "deliver", action: "send_dm", message: { text: "h" } }],
        }).ok,
      ).toBe(false);
    });

    it("REQ-259: refuses it in a draft, where a mode is otherwise optional", () => {
      expect(
        validateUnifiedAutomation({
          schema_version: 2,
          kind: "automation",
          id: "unfinished",
          state: "draft",
          trigger: { type: "comment", match: { mode: "regex" } },
        }).ok,
      ).toBe(false);
    });
  });

  /**
   * REQ-262 and REQ-263 at the same layer: "any word" is a comment trigger's
   * choice, it excludes the words, and it does not exist on a direct message.
   */
  describe("any word belongs to the comment trigger and to nothing else", () => {
    /** The same automation, with the trigger's match replaced wholesale. */
    function matching(match: unknown): unknown {
      return { ...complete(), trigger: { ...complete().trigger, match } };
    }

    it("REQ-262: accepts a comment trigger that declares no word", () => {
      expect(validateUnifiedAutomation(matching({ mode: "any" })).ok).toBe(
        true,
      );
    });

    it("REQ-262: refuses any word declared beside the words it replaces", () => {
      const issues = issuesOf(matching({ mode: "any", keywords: ["guide"] }));

      // Named at the field that has to go, because that is the one an operator
      // can act on: the exclusivity is a SHAPE here, not a rule to remember.
      expect(
        issues.some((issue) => issue.path === "trigger.match.keywords"),
      ).toBe(true);
    });

    it("REQ-262: still refuses a keyword mode with no keyword at all", () => {
      // The other half of the exclusivity: choosing by word and naming none is
      // an unfinished automation, and "any word" is how one says "no word" on
      // purpose.
      const aggregate = complete();
      aggregate.trigger.match = { keywords: [], mode: "contains" };

      expect(validateUnifiedAutomation(aggregate).ok).toBe(false);
    });

    it("REQ-263: refuses any word on a direct message trigger", () => {
      expect(
        validateUnifiedAutomation({
          ...complete(),
          trigger: { type: "direct_message", match: { mode: "any" } },
          steps: [{ id: "deliver", action: "send_dm", message: { text: "h" } }],
        }).ok,
      ).toBe(false);
    });

    it("REQ-263: refuses it in a direct message DRAFT as well", () => {
      // The draft shape is the permissive one, and this is the one thing it
      // must not be permissive about: a draft that could hold it is a refusal
      // deferred to activation, for a choice no screen ever offered.
      expect(
        validateUnifiedAutomation({
          schema_version: 2,
          kind: "automation",
          id: "unfinished",
          state: "draft",
          trigger: { type: "direct_message", match: { mode: "any" } },
        }).ok,
      ).toBe(false);
    });
  });

  /**
   * REQ-249: the confirmation's button, which stopped being optional.
   *
   * It used to be a choice: with a label the question went out as a button,
   * without one it went out as text and took whatever came back. That second
   * reading is what REQ-250 removed, so a step with no label now declares a
   * question nothing could answer, and the contact would be held for the whole
   * deadline over a field somebody left blank.
   *
   * Refused BY NAME, and here rather than in the shape: a required field in the
   * schema reports a path and never the step, and the operator meets this on a
   * screen made of sections.
   */
  describe("the confirmation declares the button that answers it", () => {
    /**
     * The step id is deliberately a word the refusal's own sentence does not
     * contain: asserting on "confirm" would have passed with the id replaced by
     * anything at all, because the sentence says "confirmation" itself.
     */
    const STEP = "opt-in-question";

    function confirming(step: Record<string, unknown>): unknown {
      return {
        ...complete(),
        steps: [
          { id: STEP, action: "confirm_optin", ...step },
          { id: "deliver", action: "send_dm", message: { text: "here it is" } },
        ],
      };
    }

    it("accepts one that declares it", () => {
      expect(
        validateUnifiedAutomation(
          confirming({
            text: "shall I send it?",
            quick_reply_label: "Yes",
            on_timeout: "abandon",
          }),
        ).ok,
      ).toBe(true);
    });

    it("REQ-306: accepts one whose label is past the truncation point", () => {
      // What the label is LONG enough to be cut on the screen decides nothing
      // about storing it: the platform accepts it and cuts it where it draws
      // it, measured on the real account on 2026-08-19. Whether there is a
      // label at all is the rule that stayed, and the tests below are it.
      const label = "x".repeat(LIMIT_DEFAULTS.quickReplyLabelChars + 1);

      expect(
        issuesOf(
          confirming({
            text: "shall I send it?",
            quick_reply_label: label,
            on_timeout: "abandon",
          }),
        ),
      ).toStrictEqual([]);
    });

    it("refuses an active automation without it, naming the step", () => {
      const issues = issuesOf(
        confirming({ text: "shall I send it?", on_timeout: "abandon" }),
      );

      expect(codes(issues)).toContain("confirmation_without_quick_reply");
      const refusal = issues.find(
        (one) => one.code === "confirmation_without_quick_reply",
      );
      // The step by name and the field by path: the two things the editor needs
      // in order to put the caret where the operator has to type (REQ-008).
      expect(refusal?.path).toBe("steps[0].quick_reply_label");
      expect(refusal?.message).toContain(STEP);
    });

    it("refuses one whose label is nothing but blanks", () => {
      // A label of spaces is a button with no words on it, and nothing the
      // contact sends could equal it: the comparison trims both sides
      // (REQ-248), so this is the same wait as one with no label at all.
      expect(
        codes(
          issuesOf(
            confirming({
              text: "shall I send it?",
              quick_reply_label: "   ",
              on_timeout: "abandon",
            }),
          ),
        ),
      ).toContain("confirmation_without_quick_reply");
    });

    it("refuses it on activation of a draft, which is the other door in", () => {
      expect(
        codes(
          activationIssuesOf({
            ...complete(),
            state: "draft",
            steps: [
              {
                id: STEP,
                action: "confirm_optin",
                text: "shall I send it?",
                on_timeout: "abandon",
              },
            ],
          }),
        ),
      ).toContain("confirmation_without_quick_reply");
    });

    it("holds a DRAFT that has not been given one yet", () => {
      // Deliberately not refused here, and it is the same line the empty
      // message is judged by: an unwritten field is what a draft exists to
      // hold, and refusing the save would stop an operator halfway through the
      // form. What may never happen is this reaching a contact, and only
      // activation makes that possible.
      expect(
        validateUnifiedAutomation({
          schema_version: 2,
          kind: "automation",
          id: "unfinished",
          state: "draft",
          steps: [
            {
              id: "confirm",
              action: "confirm_optin",
              text: "shall I send it?",
              on_timeout: "abandon",
            },
          ],
        }).ok,
      ).toBe(true);
    });
  });

  it("rejects a comment reply in a direct-message automation", () => {
    const aggregate = {
      ...complete(),
      trigger: {
        type: "direct_message",
        match: { keywords: ["guide"], mode: "contains" },
      },
      steps: [{ id: "reply", action: "reply_comment", text: "Sent" }],
    };
    expect(codes(issuesOf(aggregate))).toContain("flow_trigger_incompatible");
  });
});

/**
 * REQ-285: what a card button OPENS, and the fact that it is one thing.
 *
 * The file did not leave the product with the attachment, it changed carrier:
 * it is a button's destination now, served from our own CDN, one tap inside the
 * message the operator wrote. What it is declared as is a NAME of the
 * catalogue and not an address — the catalogue coins its own identity and
 * answers "where is this file" at the instant of the send, so a name is one
 * question with one answer while a stored URL is a copy of somebody else's.
 *
 * Which form a button carries is also the operator's choice written down: an
 * address is their "Link", a name is their "PDF or image", and reopening the
 * automation reads the choice back instead of guessing it from a URL.
 */
describe("REQ-285: the card button opens one destination, and says which", () => {
  /** A file as the catalogue stores it, identity coined and all. */
  const FILE = "guide~8f3c1a92.pdf";

  const fileButton = { id: "guide", label: "Get the guide", asset: FILE };

  it("accepts a button whose destination is a file of the catalogue", () => {
    expect(
      validateUnifiedAutomation(withMessage({ buttons: [fileButton] })).ok,
    ).toBe(true);
  });

  it("refuses a button that declares an address AND a file", () => {
    const issues = issuesOf(
      withMessage({
        buttons: [{ ...fileButton, url: "https://example.com/guide" }],
      }),
    );

    // Refused by the SHAPE, and that is the design: `cardButtonSchema` is a
    // union of two strict objects, so a button carrying both matches neither
    // branch. The alternative — two optional fields side by side — would make
    // "an address and a file" a sentence this contract can write and somebody
    // downstream has to arbitrate.
    expect(codes(issues)).toContain("invalid_shape");
    expect(issues[0]?.path).toBe("steps[0].message.buttons[0]");
  });

  it("refuses a button that opens nothing at all", () => {
    const issues = issuesOf(
      withMessage({ buttons: [{ id: "guide", label: "Get the guide" }] }),
    );

    // Unchanged by the union: a destination left blank was refused while `url`
    // was a required field, and it is refused now.
    expect(codes(issues)).toContain("invalid_shape");
    expect(issues[0]?.path).toBe("steps[0].message.buttons[0]");
  });

  it("names the STEP when a DRAFT holds both destinations", () => {
    // Where an operator actually is while they are choosing. The draft shape is
    // the permissive one — both fields are writable, because switching from an
    // address to a file leaves the abandoned one behind — so this is the fault
    // the draft CAN hold, and the refusal has to name the step rather than
    // report a path (REQ-008, REQ-127).
    const issues = issuesOf({
      schema_version: 2,
      kind: "automation",
      id: "unfinished",
      state: "draft",
      steps: [
        {
          id: "hand-it-over",
          action: "send_dm",
          message: {
            buttons: [{ ...fileButton, url: "https://example.com/guide" }],
          },
        },
      ],
    });

    expect(codes(issues)).toContain("button_destination_declared_twice");
    const refusal = issues.find(
      (one) => one.code === "button_destination_declared_twice",
    );
    expect(refusal?.path).toBe("steps[0].message.buttons[0].asset");
    expect(refusal?.message).toContain("hand-it-over");
    expect(refusal?.message).toContain("guide");
  });

  it("lets a draft change its mind, with the abandoned field left empty", () => {
    // The editor writes the destination the moment the button exists, so a
    // button switched from "Link" to "PDF or image" carries `url: ""`. An empty
    // string is a destination asked for and not yet chosen, exactly as the
    // cover's is: reading it as a declaration would refuse every operator who
    // changed their mind.
    expect(
      issuesOf({
        schema_version: 2,
        kind: "automation",
        id: "unfinished",
        state: "draft",
        steps: [
          {
            id: "hand-it-over",
            action: "send_dm",
            message: { buttons: [{ ...fileButton, url: "" }] },
          },
        ],
      }),
    ).toEqual([]);
  });
});
