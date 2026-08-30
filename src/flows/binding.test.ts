import { describe, expect, it } from "vitest";
import { bindActiveAutomation } from "./binding.js";
import type { ActiveAutomation } from "./schema.js";

const automation: ActiveAutomation = {
  schema_version: 2,
  kind: "automation",
  id: "launch-guide",
  state: "active",
  trigger: {
    type: "comment",
    target: "publication-1",
    match: { keywords: ["guide"], mode: "contains" },
  },
  rules: { once_per_contact: true, first_reply_delay_seconds: 5 },
  steps: [
    { id: "reply", action: "reply_comment", text: ["Check DM", "Sent"] },
    { id: "wait", action: "delay", seconds: 5 },
    {
      id: "confirm",
      action: "confirm_optin",
      text: "May I send it?",
      quick_reply_label: "Yes",
      on_timeout: "abandon",
    },
    {
      id: "email",
      action: "collect_email",
      ask: "Your email?",
      on_timeout: "abandon",
    },
    {
      id: "follow",
      action: "follow_gate",
      ask: "Follow us",
      on_timeout: "abandon",
    },
    {
      id: "deliver",
      action: "send_dm",
      message: {
        text: "here is the guide",
        buttons: [
          { id: "guide", label: "Get the guide", url: "https://example.com/g" },
        ],
      },
    },
  ],
};

describe("REQ-226: active aggregate binding", () => {
  it("serializes every retained action in order without a flow reference", () => {
    const result = bindActiveAutomation(automation);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.definition.id).toBe("launch-guide");
    expect(result.definition.steps.map((step) => step.type)).toEqual([
      "reply_comment",
      "delay",
      "confirm_optin",
      "collect_email",
      "follow_gate",
      "send_dm",
    ]);
    expect(result.definition.steps[0]?.config?.["text"]).toEqual([
      "Check DM",
      "Sent",
    ]);
    expect(result.definition.steps[1]?.config?.["seconds"]).toBe(5);
    expect(result.definition.steps[2]?.config?.["quick_reply_label"]).toBe(
      "Yes",
    );
    // REQ-252, REQ-254: the deadline and the number of questions are settings
    // of the instance now, so the binding has nothing to copy out of the step
    // and the engine is told them instead. A value here would mean a step had
    // gone back to declaring one.
    expect(result.definition.steps[2]?.config).not.toHaveProperty(
      "timeout_hours",
    );
    expect(result.definition.steps[3]?.config).not.toHaveProperty(
      "max_attempts",
    );
    expect(result.definition.steps[4]?.config).not.toHaveProperty(
      "timeout_hours",
    );
    expect(result.definition.steps[5]?.config).toMatchObject({
      text: "here is the guide",
      card: {
        buttons: [
          { id: "guide", label: "Get the guide", url: "https://example.com/g" },
        ],
      },
    });
    // REQ-284: the attachment left the format, so there is nothing to bind it
    // from. A value on any of these three would mean the part came back.
    for (const retired of ["asset", "delivery", "asset_kind"]) {
      expect(result.definition.steps[5]?.config).not.toHaveProperty(retired);
    }
    expect(result.definition).not.toHaveProperty("flow");
  });
});

/**
 * REQ-229 and REQ-230 at the seam: the additive message, part by part.
 *
 * The binding is where the operator's document becomes what the engine runs, so
 * it is where a dropped part becomes invisible. It IS what used to happen: the
 * exclusive contract wrote `text: ""` beside a file and beside a card, so the
 * anchor case — a wording and a PDF — reached the engine with the wording
 * already thrown away and nothing downstream could put it back.
 */
describe("REQ-229: the additive message reaches the engine whole", () => {
  /** One aggregate of one `send_dm`, carrying the message under test. */
  function bound(message: ActiveAutomation["steps"][number]) {
    const result = bindActiveAutomation({
      ...automation,
      steps: [message],
    });
    if (!result.ok) throw new Error(JSON.stringify(result.issues));
    return result.definition.steps[0]?.config;
  }

  const deliver = (
    message: Extract<
      ActiveAutomation["steps"][number],
      { action: "send_dm" }
    >["message"],
  ) => ({ id: "deliver", action: "send_dm" as const, message });

  it("carries a text on its own, with nothing invented beside it", () => {
    const config = bound(deliver({ text: "here it is" }));

    expect(config).toEqual({ text: "here it is" });
  });

  it("carries every wording of a text, so the draw has all of them", () => {
    expect(bound(deliver({ text: ["Primeira", "Segunda"] }))?.["text"]).toEqual(
      ["Primeira", "Segunda"],
    );
  });

  it("turns the buttons into the card the engine builds, in declared order", () => {
    const buttons = [
      { id: "zeta", label: "Course", url: "https://example.com/3" },
      { id: "alpha", label: "Guide", url: "https://example.com/1" },
    ];
    const config = bound(
      deliver({
        text: "Pick one",
        buttons,
        image: "cover.png",
        description: "Two useful starting points",
      }),
    );

    // The text stays a text: it becomes the card's TITLE at send time, where
    // the wording is drawn (REQ-126), and freezing one here would send the same
    // sentence to every contact for good.
    expect(config?.["text"]).toBe("Pick one");
    expect(config?.["card"]).toEqual({
      image: "cover.png",
      description: "Two useful starting points",
      buttons,
    });
  });

  it("REQ-288: hands the pure links over in the declared order", () => {
    // Unmerged and unsorted, like every other part. That each of these becomes
    // a message of its own, after the card or the text, is carried out by the
    // engine; what the binding owes is the operator's order, intact.
    const links = ["https://example.com/video", "https://example.com/article"];

    expect(bound(deliver({ text: "here it is", links }))?.["links"]).toEqual(
      links,
    );
  });

  it("REQ-287: declares no card when the message has only pure links", () => {
    // The separation, at the seam: three addresses and no button reach the
    // engine as a text plus three addresses. Bound as a card, they would come
    // back to the contact as buttons and the preview the operator wanted the
    // destination site to draw would never exist.
    const config = bound(
      deliver({ text: "here it is", links: ["https://example.com/video"] }),
    );

    expect(config).not.toHaveProperty("card");
    expect(config?.["links"]).toEqual(["https://example.com/video"]);
  });

  it("REQ-285: hands the button's file over as the NAME it was declared with", () => {
    // Untouched, exactly like the cover beside it: the catalogue answers "where
    // is this file" at the instant of the send (REQ-020), so resolving it here
    // would resolve it when the definition is READ, and a file deleted in
    // between would travel as an address that opens nothing.
    const config = bound(
      deliver({
        text: "here is the guide",
        buttons: [
          { id: "guide", label: "Get the guide", asset: "guide~8f3c1a92.pdf" },
        ],
      }),
    );

    expect(config?.["card"]).toEqual({
      buttons: [
        { id: "guide", label: "Get the guide", asset: "guide~8f3c1a92.pdf" },
      ],
    });
  });

  it("REQ-284: binds no attachment, because the format carries none", () => {
    const config = bound(deliver({ text: "here is the guide" }));

    expect(config).toEqual({ text: "here is the guide" });
  });

  it("declares no card at all when there is no button", () => {
    expect(bound(deliver({ text: "here it is" }))).not.toHaveProperty("card");
  });
});
