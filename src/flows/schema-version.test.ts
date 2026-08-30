import { describe, expect, it } from "vitest";
import { SUPPORTED_STEP_ACTIONS } from "./engine-support.js";
import {
  ANY_WORD_MODE,
  AUTOMATION_SCHEMA_VERSION,
  COMMENT_MATCH_MODES,
  DEFAULT_FIRST_REPLY_DELAY_SECONDS,
  FIRST_REPLY_DELAY_CHOICES,
  FLOW_ACTIONS,
  KEYWORD_MATCH_MODES,
} from "./schema.js";
import { validateUnifiedAutomation } from "./validation.js";

const active = {
  schema_version: 2,
  kind: "automation",
  id: "launch-post",
  state: "active",
  trigger: {
    type: "comment",
    target: "media-1",
    match: { keywords: ["pdf"], mode: "contains" },
  },
  rules: { once_per_contact: true },
  steps: [{ id: "reply", action: "reply_comment", text: "Check your inbox" }],
};

describe("the aggregate schema gate", () => {
  it("accepts v2 with owned steps and no legacy binding fields", () => {
    const result = validateUnifiedAutomation(active);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).not.toHaveProperty("flow");
    expect(result.value).not.toHaveProperty("values");
  });

  it("rejects missing, retired, and future versions before shape validation", () => {
    const unversioned = { ...active } as Record<string, unknown>;
    delete unversioned["schema_version"];
    for (const input of [
      unversioned,
      { ...active, schema_version: 1 },
      { ...active, schema_version: 99 },
    ]) {
      const result = validateUnifiedAutomation(input);
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.issues).toHaveLength(1);
      expect(result.issues[0]?.path).toBe("schema_version");
    }
  });

  it("rejects legacy flow/value binding fields", () => {
    expect(
      validateUnifiedAutomation({ ...active, flow: "legacy", values: {} }).ok,
    ).toBe(false);
  });

  /**
   * REQ-229 arrived inside version 2 rather than beside it, and that is a
   * decision worth pinning.
   *
   * The private message stopped being a union discriminated by `kind` and
   * became a text with parts that add to it. No compatibility layer was
   * written, because there is no stored data to preserve: the version stays at
   * 2 and the development database is reinitialised. What must NOT happen is
   * the old document being read as if it still meant something — a `kind` that
   * is quietly ignored would leave an automation that sends nothing at all,
   * and the operator would find out from a contact.
   */
  describe("the additive message replaced the exclusive one, in place", () => {
    const deliver = (message: unknown) => ({
      ...active,
      steps: [{ id: "deliver", action: "send_dm", message }],
    });

    it("keeps the version at 2 for the message it now accepts", () => {
      const result = validateUnifiedAutomation(
        deliver({
          text: "here it is",
          buttons: [
            { id: "guide", label: "Get it", url: "https://example.com/guide" },
          ],
        }),
      );

      expect(result.ok).toBe(true);
      expect(result.ok && result.value.schema_version).toBe(2);
    });

    it("refuses the retired shapes instead of ignoring what they declare", () => {
      for (const retired of [
        { kind: "text", text: "here it is" },
        { kind: "file", file: "guide.pdf" },
        { kind: "card", card: { buttons: [] } },
      ]) {
        const result = validateUnifiedAutomation(deliver(retired));

        expect(result.ok, JSON.stringify(retired)).toBe(false);
        if (result.ok) continue;
        // Named as an unknown part, at its own path: a document written against
        // the old contract is refused where it is wrong, not as a whole.
        expect(result.issues[0]?.path).toBe("steps[0].message.kind");
      }
    });
  });

  /**
   * Phase 3l took four things OUT of version 2, and the version did not move.
   *
   * The same decision REQ-229 took and for the same reason: there is no stored
   * automation to preserve, so a compatibility layer would be code written for
   * a document nobody holds. What must not happen is the retired vocabulary
   * being read as if it still meant something, and that is what the refusals in
   * `validation.test.ts` assert one by one. What is pinned HERE is the shape of
   * the vocabulary itself, because a list is where a removal silently comes
   * back: an entry restored to `FLOW_ACTIONS` makes the step expressible again
   * with no screen changed and no test failing anywhere else.
   *
   * Phase 3n took a fifth thing out of the same version, the attachment, and it
   * has its own block below: the four here are the ones 3l removed.
   */
  describe("the vocabulary shrank inside version 2", () => {
    it("keeps the version at 2 for the narrower format", () => {
      expect(AUTOMATION_SCHEMA_VERSION).toBe(2);
      expect(validateUnifiedAutomation(active).ok).toBe(true);
    });

    it("REQ-279: an automation with no name at all is a complete one", () => {
      // The field left the format inside version 2, like the three below: the
      // aggregate above declares no name and is accepted whole, which is what
      // says the removal is the FORMAT's and not a screen's habit. The document
      // that still carries one is refused in `validation.test.ts`.
      expect(active).not.toHaveProperty("name");
      const result = validateUnifiedAutomation(active);

      expect(result.ok).toBe(true);
      expect(result.ok && result.value.schema_version).toBe(2);
      expect(result.ok && result.value).not.toHaveProperty("name");
    });

    it("REQ-258: no action of the format writes a contact attribute", () => {
      expect([...FLOW_ACTIONS]).not.toContain("set_attribute");
      // And the engine's executable set with it: the two lists are separate on
      // purpose (a declared action need not be runnable), so a removal from one
      // and not the other is exactly the drift this asserts against.
      expect([...SUPPORTED_STEP_ACTIONS]).not.toContain("set_attribute");
    });

    it("REQ-259: no match mode is an advanced expression", () => {
      expect([...KEYWORD_MATCH_MODES]).toEqual(["contains", "exact"]);
      expect([...COMMENT_MATCH_MODES]).not.toContain("regex");
    });

    it("REQ-262/REQ-263: any word is a comment's mode and only a comment's", () => {
      // The two lists ARE the exclusivity: the comment trigger reads the wider
      // one, the direct message reads the narrower, and a screen offering the
      // wrong one would be offering what the schema refuses.
      expect([...COMMENT_MATCH_MODES]).toEqual([
        ANY_WORD_MODE,
        ...KEYWORD_MATCH_MODES,
      ]);
      expect([...KEYWORD_MATCH_MODES]).not.toContain(ANY_WORD_MODE);
    });

    it("REQ-252/REQ-254: refuses a step that declares a deadline or a number of tries", () => {
      // Both were fields of these steps until phase 3l, and both are one
      // setting of the instance now. Refused at the SHAPE and not merely
      // dropped: a key quietly ignored would let an editor, an import or an API
      // caller go on writing a number that decides nothing, and the operator
      // would set a deadline of six hours and be waited on for a week.
      const declaring = [
        {
          id: "confirm",
          action: "confirm_optin",
          text: "may I send it?",
          quick_reply_label: "Yes",
          timeout_hours: 6,
          on_timeout: "abandon",
        },
        {
          id: "collect",
          action: "collect_email",
          ask: "your e-mail?",
          on_timeout: "abandon",
          max_attempts: 3,
        },
        {
          id: "gate",
          action: "follow_gate",
          ask: "follow us",
          timeout_hours: 8,
          on_timeout: "abandon",
        },
      ];

      for (const step of declaring) {
        const result = validateUnifiedAutomation({
          ...active,
          steps: [step],
        });

        expect(result.ok, JSON.stringify(step)).toBe(false);
        if (result.ok) continue;
        // Named on the field, so whoever wrote it is told WHICH key the format
        // stopped carrying.
        expect(result.issues[0]?.path).toMatch(
          /steps\[0\]\.(timeout_hours|max_attempts)/,
        );
      }
    });

    it("REQ-260: refuses an address where it used to accept one", () => {
      // Version 2 accepted a publication URL and resolved it before storing.
      // A document written under that reading is refused now, at the field, and
      // not stored as a target that would never equal a publication id.
      const addressed = {
        ...active,
        trigger: {
          ...active.trigger,
          target: "https://www.instagram.com/p/DZY-w4gjCI5/",
        },
      };
      const result = validateUnifiedAutomation(addressed);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.issues[0]?.path).toBe("trigger.target");
    });
  });

  /**
   * Phase 3n took a fifth thing out of version 2, and the version did not move
   * either (REQ-284).
   *
   * The same decision as the four above, for the same reason: no stored
   * automation to preserve, so a compatibility layer would be code written for
   * a document nobody holds. What is DIFFERENT is what the retired document
   * meant. An automation with an attachment delivered a file, so reading it as
   * one that merely has no attachment would deliver a text where a PDF was
   * promised — in silence, to a contact who asked for the file. Hence the
   * refusal here, and REQ-294 asking the interface to say such an automation
   * exists and cannot be read, instead of dropping it from a list.
   *
   * The file itself did not leave the product: it is the destination of a card
   * button now, served from our CDN (REQ-285), which costs the contact one tap
   * instead of two and can be measured.
   */
  describe("REQ-284: the attachment left version 2, and the version stayed", () => {
    const deliver = (message: unknown) => ({
      ...active,
      steps: [{ id: "deliver", action: "send_dm", message }],
    });

    const attached = {
      text: "here is the guide",
      attachments: [{ kind: "document", file: "guide.pdf" }],
    };

    it("keeps the version at 2 for the format that stopped carrying it", () => {
      expect(AUTOMATION_SCHEMA_VERSION).toBe(2);
      expect(
        validateUnifiedAutomation(
          deliver({
            text: "here it is",
            buttons: [
              {
                id: "guide",
                label: "Get it",
                url: "https://example.com/guide",
              },
            ],
          }),
        ).ok,
      ).toBe(true);
    });

    it("refuses the part, at the field that used to carry it", () => {
      const result = validateUnifiedAutomation(deliver(attached));

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.issues[0]?.path).toBe("steps[0].message.attachments");
    });

    it("refuses it in a DRAFT too, which is where it would hide", () => {
      // A draft shape that still accepted it would take the old document in on
      // the save and refuse it only at activation, which is precisely the late
      // discovery this contract exists to bring forward.
      const result = validateUnifiedAutomation({
        ...deliver(attached),
        state: "draft",
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.issues[0]?.path).toBe("steps[0].message.attachments");
    });

    it("declares no step that sends a file, in either vocabulary", () => {
      // The list is where a removal silently comes back. An action restored
      // here would make the attachment step expressible again with no screen
      // changed, which is how a part that left the product returns.
      for (const retired of ["send_file", "send_attachment", "send_asset"]) {
        expect([...FLOW_ACTIONS]).not.toContain(retired);
        expect([...SUPPORTED_STEP_ACTIONS]).not.toContain(retired);
      }
    });
  });

  /**
   * The wait stopped being a STEP and became a rule of the automation
   * (REQ-277).
   *
   * The defect it repairs was invisible to every test there was: the editor
   * assembled the steps in one fixed order and the wait was always the LAST
   * of them, so the run paused after the final message and resumed with
   * nothing left to do. Switched on or off, the contact received the same
   * messages in the same instants. Nothing here could have caught that,
   * because nothing compared the order the editor writes with the effect it
   * has, so what is pinned now is the thing that has no order to get wrong: a
   * value on the aggregate.
   */
  describe("REQ-277: the wait is a rule of the automation, on a closed ruler", () => {
    const withRules = (rules: unknown) => ({ ...active, rules });

    it("offers the five waits the product decided, and no sixth", () => {
      // The list is the CONTRACT the screen offers boxes for. A value added
      // here with no box is a wait nobody can choose; a box added there with
      // no value here is a choice the aggregate refuses at save time.
      expect([...FIRST_REPLY_DELAY_CHOICES]).toEqual([0, 5, 10, 30, 60]);
      expect(DEFAULT_FIRST_REPLY_DELAY_SECONDS).toBe(5);
      expect([...FIRST_REPLY_DELAY_CHOICES]).toContain(
        DEFAULT_FIRST_REPLY_DELAY_SECONDS,
      );
    });

    it("reads an aggregate that declares no wait as the default, not as immediate", () => {
      // The whole reason zero is ON the ruler: absence can then keep meaning
      // "nobody chose", and be answered with the product's five seconds. Were
      // absence itself immediate, every aggregate written by an importer or
      // by an older screen would answer in the same second, which is the one
      // behaviour the requirement exists to prevent.
      const result = validateUnifiedAutomation(active);

      expect(result.ok).toBe(true);
      expect(result.ok && result.value.rules?.first_reply_delay_seconds).toBe(
        DEFAULT_FIRST_REPLY_DELAY_SECONDS,
      );
    });

    it("takes immediate as a declared zero", () => {
      const result = validateUnifiedAutomation(
        withRules({ once_per_contact: true, first_reply_delay_seconds: 0 }),
      );

      expect(result.ok).toBe(true);
      expect(result.ok && result.value.rules?.first_reply_delay_seconds).toBe(
        0,
      );
    });

    it("refuses a wait that is not on the ruler, at the field that carries it", () => {
      // The string is in this list on purpose: a form field hands back text,
      // and a screen that forgot to convert it would otherwise store "5" and
      // hold nothing back.
      for (const off of [3, 7, 45, 120, -5, 5.5, "5", null]) {
        const result = validateUnifiedAutomation(
          withRules({
            once_per_contact: true,
            first_reply_delay_seconds: off,
          }),
        );

        expect(result.ok, JSON.stringify(off)).toBe(false);
        if (result.ok) continue;
        expect(result.issues[0]?.path).toBe("rules.first_reply_delay_seconds");
      }
    });

    it("lets a draft be saved before the wait is chosen", () => {
      // Half a form is what a draft IS, and a rules object with nothing in it
      // still reads as the product's answer rather than as immediate.
      const result = validateUnifiedAutomation({
        schema_version: 2,
        kind: "automation",
        id: "half-written",
        state: "draft",
        rules: {},
      });

      expect(result.ok).toBe(true);
      expect(result.ok && result.value.rules?.first_reply_delay_seconds).toBe(
        DEFAULT_FIRST_REPLY_DELAY_SECONDS,
      );
    });

    it("keeps the pause STEP, which is a different wait and is proven elsewhere", () => {
      // Not an oversight, and worth pinning because the two are easy to read
      // as one: this rule holds the FIRST reply of a run, the `delay` step
      // pauses BETWEEN two named steps (REQ-098). What phase 3l took away is
      // the editor's use of the step, never the step.
      expect([...FLOW_ACTIONS]).toContain("delay");
      expect([...SUPPORTED_STEP_ACTIONS]).toContain("delay");
    });
  });
});
