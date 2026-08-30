import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { LIMIT_DEFAULTS } from "../config/limits.js";
import { runExecution } from "../engine/execute.js";
import type { EnginePorts, OutboundMessage } from "../engine/ports.js";
import { bindActiveAutomation } from "./binding.js";
import type {
  ActiveAutomation,
  AutomationStep,
  AutomationTrigger,
} from "./schema.js";
import { validateAutomationActivation } from "./validation.js";
import type { ValidationIssue, ValidationResult } from "./validation.js";

/**
 * Proves the path from the SELF-CONTAINED aggregate to the send, for the parts
 * a direct message adds up from (REQ-213, REQ-219, REQ-226, REQ-229) and for
 * the rules the anchor case still owes: no resource in the first message
 * (REQ-066),
 * an already open conversation that skips the question and still delivers
 * (REQ-068), the confirmation's quick reply (REQ-086), text measured in UTF-8
 * bytes (REQ-087), a single implementation of the assembly rules (REQ-140), and
 * a definition that survives export and reimport (REQ-052).
 *
 * What this file is FOR is the percurso: `validateAutomationActivation`, then
 * `bindActiveAutomation`, then the engine, then the message the sender actually
 * received. The adapter and the wire payload are proved next door, in
 * `src/platform/sending.test.ts`, and are deliberately not repeated here.
 *
 * The byte case is the one worth staring at. `"é".length` is 1 and
 * `Buffer.byteLength("é")` is 2, so a Portuguese text can pass a character
 * check and be refused by the platform — to a contact who is already waiting.
 *
 * Two requirements of the v1 `send_dm` did NOT survive the version-2 contract
 * and are not simulated here. REQ-084 declared the delivery FORM (`text`,
 * `link`, `file`) beside an `asset` parameter; the aggregate declares the
 * PARTS of one message instead (a text, buttons, pure links, a cover), and what
 * they become is proved below. REQ-085 declared a `button_label` for the link
 * form, with the catalogue supplying a default; the buttons of REQ-219 replaced
 * it with one to three destinations whose `label` is REQUIRED, so there is no
 * absent label left to default, and the catalogue key it fell back to no longer
 * exists.
 *
 * A third left in phase 3n: REQ-231's attachment. The parts are two lists now,
 * and they are not one thing said twice (REQ-287, REQ-288) — a BUTTON makes the
 * message a card, a pure LINK travels on its own. What each becomes on the wire
 * is the engine's, and the pure link's own message is proved where the engine
 * is: this file stops at the card, the text, and the order they were declared
 * in.
 */

/** A file as the catalogue stores it: the name it coined, not an address. */
const GUIDE_FILE = "guide~8f3c1a92.pdf";

const CARD_BUTTONS = [
  { id: "guide", label: "Get the guide", url: "https://example.com/guide" },
  { id: "course", label: "See the course", url: "https://example.com/course" },
  { id: "call", label: "Book a call", url: "https://example.com/call" },
] as const;

const DIRECT_MESSAGE_TRIGGER: AutomationTrigger = {
  type: "direct_message",
  match: { keywords: ["guide"], mode: "contains" },
};

const COMMENT_TRIGGER: AutomationTrigger = {
  type: "comment",
  target: "media-1",
  match: { keywords: ["guide"], mode: "contains" },
};

/** One aggregate, self-contained: no flow reference and no parameter values. */
function aggregate(
  steps: readonly AutomationStep[],
  trigger: AutomationTrigger = DIRECT_MESSAGE_TRIGGER,
): ActiveAutomation {
  return {
    schema_version: 2,
    kind: "automation",
    id: "owned-automation",
    state: "active",
    trigger,
    rules: { once_per_contact: true, first_reply_delay_seconds: 5 },
    steps: [...steps],
  };
}

/** The same object as `aggregate`, with room for a shape the schema refuses. */
function aggregateWith(steps: unknown[], trigger = DIRECT_MESSAGE_TRIGGER) {
  return {
    schema_version: 2,
    kind: "automation",
    id: "owned-automation",
    state: "active",
    trigger,
    rules: { once_per_contact: true, first_reply_delay_seconds: 5 },
    steps,
  };
}

interface RunOptions {
  readonly random?: number;
  readonly trigger?: AutomationTrigger;
  readonly origin?: "comment" | "direct_message";
  readonly conversationOpen?: boolean;
  readonly publicUrl?: (name: string) => Promise<string>;
  /** Called after the binding and before the run, to count early resolutions. */
  readonly afterBinding?: () => void;
}

/**
 * Runs the production path — bind, then execute — and hands back every message
 * that actually went out.
 *
 * The fixture goes through `validateAutomationActivation` first, so what is run
 * is what an operator could have saved.
 */
async function sentByActive(
  steps: readonly AutomationStep[],
  options: RunOptions = {},
): Promise<OutboundMessage[]> {
  const candidate = aggregate(steps, options.trigger);
  const validated = validateAutomationActivation(candidate);
  if (!validated.ok) {
    throw new Error(
      `fixture is not a valid automation: ${JSON.stringify(validated.issues)}`,
    );
  }

  const bound = bindActiveAutomation(validated.value);
  if (!bound.ok) throw new Error(JSON.stringify(bound.issues));
  options.afterBinding?.();

  const sent: OutboundMessage[] = [];
  const ports: EnginePorts = {
    clock: { now: () => new Date(Date.UTC(2026, 7, 4)) },
    contacts: {
      getAttributes: () => Promise.resolve({}),
      setAttribute: () => Promise.resolve(),
    },
    sender: {
      sendDirectMessage: (_contactId, message) => {
        sent.push(message);
        return Promise.resolve();
      },
      replyToComment: (_commentId, message) => {
        sent.push(message);
        return Promise.resolve();
      },
    },
    assets: {
      publicUrl:
        options.publicUrl ??
        ((name) => Promise.resolve(`https://cdn.example/${name}`)),
    },
    random: { next: () => options.random ?? 0 },
    // No case here asserts a deadline: what the instance decided has to be
    // present because the engine is told it rather than reading it off a step
    // (REQ-252, REQ-254), and absent it would not compile.
    waiting: { hours: 24, questions: 3, followButtonLabel: "I followed" },
    suspender: {
      suspend: () => Promise.resolve(),
      // Closed by default, like the engine's own double: an open conversation
      // SUPPRESSES the confirmation (REQ-068), so a double that reported it
      // open would quietly stop testing the message these cases are about.
      isConversationOpen: () =>
        Promise.resolve(options.conversationOpen ?? false),
    },
  };

  await runExecution(
    {
      flowId: candidate.id,
      contactId: "contact-1",
      origin: options.origin ?? "direct_message",
      ...(options.origin === "comment" && { commentId: "comment-1" }),
    },
    { current: (id) => (id === candidate.id ? bound.definition : undefined) },
    ports,
  );

  return sent;
}

function rejectionOf(
  result: ValidationResult<ActiveAutomation>,
): ValidationIssue[] {
  if (result.ok) throw new Error("expected the aggregate to be rejected");
  return [...result.issues];
}

function codes(issues: ValidationIssue[]): string[] {
  return issues.map((entry) => entry.code);
}

const cardStep = (
  buttons: readonly { id: string; label: string; url: string }[] = CARD_BUTTONS,
): AutomationStep => ({
  id: "deliver",
  action: "send_dm",
  message: {
    image: "cover.png",
    title: "Choose a guide",
    description: "Three useful starting points",
    buttons: [...buttons],
  },
});

/** The addresses that travel on their own, with no card around them (REQ-286). */
const PURE_LINKS = [
  "https://example.com/video",
  "https://example.com/article",
] as const;

const confirmStep = (overrides: Record<string, unknown> = {}): AutomationStep =>
  ({
    id: "confirm",
    action: "confirm_optin",
    text: "shall I send it?",
    on_timeout: "abandon",
    ...overrides,
  }) as AutomationStep;

describe("REQ-213/REQ-219/REQ-229: the aggregate declares the message parts", () => {
  it("accepts each part, alone and combined", () => {
    const messages = [
      { text: "here it is" },
      { links: [...PURE_LINKS] },
      { buttons: [CARD_BUTTONS[0]] },
      { text: "Grab the guide", buttons: [CARD_BUTTONS[0]] },
      // The two forms in one message, which is REQ-288: a card, and addresses
      // that travel after it.
      {
        text: "Grab the guide",
        buttons: [CARD_BUTTONS[0]],
        links: [...PURE_LINKS],
      },
    ];

    for (const message of messages) {
      const result = validateAutomationActivation(
        aggregateWith([{ id: "deliver", action: "send_dm", message }]),
      );

      expect(result.ok, JSON.stringify(message)).toBe(true);
    }
  });

  it("rejects a part it does not know, rather than ignoring it", () => {
    // A strict object, so a misspelt part is refused instead of being dropped
    // in silence: an operator who wrote `link` would otherwise save an
    // automation that sends no link at all.
    const issues = rejectionOf(
      validateAutomationActivation(
        aggregateWith([
          {
            id: "deliver",
            action: "send_dm",
            message: { text: "here it is", carrier_pigeon: true },
          },
        ]),
      ),
    );

    expect(codes(issues)).toContain("invalid_shape");
    expect(issues[0]?.path).toBe("steps[0].message.carrier_pigeon");
  });

  it("rejects a button with no destination and a link that is no address", () => {
    // The v1 refusal `delivery_requires_asset` said the same thing about a
    // parameter. The aggregate says it about a VALUE, in the schema itself.
    const withoutUrl = rejectionOf(
      validateAutomationActivation(
        aggregateWith([
          {
            id: "deliver",
            action: "send_dm",
            message: { buttons: [{ id: "guide", label: "Get it" }] },
          },
        ]),
      ),
    );
    // The BUTTON and no longer its `url` field, and the move is the union of
    // REQ-285: a button opens an address or a file of the catalogue, so a
    // button that declares neither is a button matching no destination at all
    // — a fault of the button, not of one field it happens to be missing.
    expect(withoutUrl[0]?.path).toBe("steps[0].message.buttons[0]");

    const notAnAddress = rejectionOf(
      validateAutomationActivation(
        aggregateWith([
          {
            id: "deliver",
            action: "send_dm",
            message: { links: ["not an address"] },
          },
        ]),
      ),
    );
    expect(notAnAddress[0]?.path).toBe("steps[0].message.links[0]");
  });

  it("refuses the fourth button, and a button id repeated in one message", () => {
    const fourth = rejectionOf(
      validateAutomationActivation(
        aggregateWith([
          cardStep([
            ...CARD_BUTTONS,
            { id: "extra", label: "Fourth", url: "https://example.com/4" },
          ]),
        ]),
      ),
    );
    expect(codes(fourth)).toContain("too_many_buttons");
    expect(fourth[0]?.path).toBe("steps[0].message.buttons");

    const repeated = rejectionOf(
      validateAutomationActivation(
        aggregateWith([
          cardStep([
            CARD_BUTTONS[0],
            { ...CARD_BUTTONS[1], id: CARD_BUTTONS[0].id },
          ]),
        ]),
      ),
    );
    // Named by its own path: a click is attributed by button id, so two buttons
    // sharing one would report their taps as a single destination.
    expect(codes(repeated)).toContain("duplicate_button_id");
    expect(repeated[0]?.path).toBe("steps[0].message.buttons[1].id");
  });

  it("refuses a destination that is not HTTP or HTTPS", () => {
    const issues = rejectionOf(
      validateAutomationActivation(
        aggregateWith([
          cardStep([{ ...CARD_BUTTONS[0], url: "ftp://example.com/guide" }]),
        ]),
      ),
    );

    expect(issues[0]?.message).toContain("must use HTTP or HTTPS");
  });
});

describe("REQ-213/REQ-226: the aggregate delivers its own message", () => {
  it("draws among text variations captured directly on the automation", async () => {
    const [message] = await sentByActive(
      [
        {
          id: "deliver",
          action: "send_dm",
          message: { text: ["Primeira", "Segunda"] },
        },
      ],
      { random: 0.75 },
    );

    expect(message?.text).toBe("Segunda");
  });

  it("sends a text shape and nothing else, with no resource to resolve", async () => {
    const resolved: string[] = [];
    const [message] = await sentByActive(
      [
        {
          id: "deliver",
          action: "send_dm",
          message: { text: "here it is" },
        },
      ],
      {
        publicUrl: (name) => {
          resolved.push(name);
          return Promise.resolve(`https://cdn.example/${name}`);
        },
      },
    );

    expect(message).toEqual({ text: "here it is" });
    expect(resolved).toEqual([]);
  });

  it("resolves the card's cover only when its step executes", async () => {
    const requested: string[] = [];
    const [message] = await sentByActive([cardStep()], {
      publicUrl: (name) => {
        requested.push(name);
        return Promise.resolve("https://cdn.example/cover.png");
      },
    });

    expect(requested).toEqual(["cover.png"]);
    expect(message?.card?.imageUrl).toBe("https://cdn.example/cover.png");
    // REQ-284: nothing is attached to the conversation any more. A file reaches
    // the contact as a button's destination, inside the card above.
    expect(message?.attachment).toBeUndefined();
  });

  it("keeps the resource NAME until the send-time URL resolution", async () => {
    // A value returned by an upload is a key, and a platform media URL expires.
    // The resolver changes after the aggregate is bound, which proves the
    // binding cached no URL and that the current one is looked up only when
    // the delivery is built (REQ-020).
    const names: string[] = [];
    let currentUrl = "https://cdn.example/old.png";
    let callsAtBinding = -1;

    const [message] = await sentByActive(
      [
        {
          id: "deliver",
          action: "send_dm",
          message: {
            image: "fresh-cover.png",
            buttons: [CARD_BUTTONS[0]],
          },
        },
      ],
      {
        publicUrl: (name) => {
          names.push(name);
          return Promise.resolve(currentUrl);
        },
        afterBinding: () => {
          callsAtBinding = names.length;
          currentUrl = "https://cdn.example/fresh.png";
        },
      },
    );

    expect(callsAtBinding).toBe(0);
    expect(names).toEqual(["fresh-cover.png"]);
    expect(message?.card?.imageUrl).toBe("https://cdn.example/fresh.png");
  });

  it("resolves one card image and preserves its three ordered buttons", async () => {
    const requested: string[] = [];
    const [message] = await sentByActive([cardStep()], {
      publicUrl: (name) => {
        requested.push(name);
        return Promise.resolve(`https://cdn.example/${name}`);
      },
    });

    expect(requested).toEqual(["cover.png"]);
    expect(message?.card).toEqual({
      imageUrl: "https://cdn.example/cover.png",
      title: "Choose a guide",
      description: "Three useful starting points",
      buttons: [
        {
          id: "guide",
          label: "Get the guide",
          url: "https://example.com/guide",
        },
        {
          id: "course",
          label: "See the course",
          url: "https://example.com/course",
        },
        { id: "call", label: "Book a call", url: "https://example.com/call" },
      ],
    });
  });

  it("REQ-219: delivers the buttons in the DECLARED order, never normalised", async () => {
    // Declared against every order a well-meaning normalisation would impose:
    // not alphabetical by id, not alphabetical by label, not by URL. The order
    // is the operator's ranking of the destinations, and the first button is
    // the one most people tap — reordering it silently changes the offer.
    const declared = [
      { id: "zeta", label: "Course", url: "https://example.com/3" },
      { id: "alpha", label: "Guide", url: "https://example.com/1" },
      { id: "mid", label: "Call", url: "https://example.com/2" },
    ];

    const [message] = await sentByActive([
      {
        id: "deliver",
        action: "send_dm",
        message: { buttons: declared },
      },
    ]);

    expect(message?.card?.buttons.map((button) => button.id)).toEqual([
      "zeta",
      "alpha",
      "mid",
    ]);
    expect(message?.card?.buttons).toEqual(declared);
  });

  it("carries a card with no image and no wording, when none is declared", async () => {
    const requested: string[] = [];
    const [message] = await sentByActive(
      [
        {
          id: "deliver",
          action: "send_dm",
          message: { buttons: [CARD_BUTTONS[0]] },
        },
      ],
      {
        publicUrl: (name) => {
          requested.push(name);
          return Promise.resolve(`https://cdn.example/${name}`);
        },
      },
    );

    // Nothing is invented for the absent halves, and no resource is resolved
    // for an image the automation never declared.
    expect(requested).toEqual([]);
    expect(message?.card).toEqual({ buttons: [CARD_BUTTONS[0]] });
    expect(message?.card?.imageUrl).toBeUndefined();
    expect(message?.card?.title).toBeUndefined();
  });

  it("REQ-226: keeps every other step of the aggregate behaving as proved", async () => {
    const sent = await sentByActive(
      [
        { id: "reply", action: "reply_comment", text: ["Primeira", "Segunda"] },
        {
          id: "deliver",
          action: "send_dm",
          message: { text: "here it is" },
        },
      ],
      { trigger: COMMENT_TRIGGER, origin: "comment", random: 0.75 },
    );

    // The public reply draws among its wordings exactly as the delivery does,
    // and the run walks on through the steps the aggregate now owns.
    expect(sent.map((message) => message.text)).toEqual([
      "Segunda",
      "here it is",
    ]);
  });
});

/**
 * REQ-229 and REQ-230, walked from the saved document to the message that went
 * out: what the parts BECOME.
 *
 * The two cases below are the ones the exclusive contract could not carry, and
 * both failed in the same way — silently, with something the operator wrote
 * simply not arriving. That is what makes them worth proving at the far end,
 * against what the sender received, rather than against the document.
 */
describe("REQ-229/REQ-230: the parts become one delivery", () => {
  it("sends a text with no link as a plain text message", async () => {
    const [message] = await sentByActive([
      { id: "deliver", action: "send_dm", message: { text: "here it is" } },
    ]);

    expect(message).toEqual({ text: "here it is" });
    expect(message?.card).toBeUndefined();
  });

  it("makes the text the card's title as soon as one button exists", async () => {
    const [message] = await sentByActive([
      {
        id: "deliver",
        action: "send_dm",
        message: { text: "Grab the guide", buttons: [CARD_BUTTONS[0]] },
      },
    ]);

    // ONE message, and the text is inside it: no separate text message before
    // the card, which is the half of REQ-230 an operator sees as two bubbles.
    expect(message?.card?.title).toBe("Grab the guide");
    expect(message?.card?.buttons).toEqual([CARD_BUTTONS[0]]);
  });

  it("REQ-346: sends a title past the display ceiling whole", async () => {
    const title = "x".repeat(LIMIT_DEFAULTS.cardTitleChars + 1);
    const [message] = await sentByActive([
      {
        id: "deliver",
        action: "send_dm",
        message: { text: title, buttons: [CARD_BUTTONS[0]] },
      },
    ]);

    expect(message?.card?.title).toBe(title);
  });

  it("draws the wording that becomes the title, one wording per send", async () => {
    // The title cannot be settled before the run: the wording is DRAWN
    // (REQ-126), so writing it into the card at binding time would have frozen
    // one sentence for every contact, for good.
    const [message] = await sentByActive(
      [
        {
          id: "deliver",
          action: "send_dm",
          message: {
            text: ["Primeira", "Segunda"],
            buttons: [CARD_BUTTONS[0]],
          },
        },
      ],
      { random: 0.75 },
    );

    expect(message?.card?.title).toBe("Segunda");
  });

  it("keeps a declared card title over the text it has none of", async () => {
    const [message] = await sentByActive([
      {
        id: "deliver",
        action: "send_dm",
        message: { title: "Choose a guide", buttons: [CARD_BUTTONS[0]] },
      },
    ]);

    expect(message?.card?.title).toBe("Choose a guide");
  });

  it("REQ-284: the anchor case is ONE message, with the file on a button", async () => {
    // "A text and a PDF", which is what this product exists for, and what the
    // exclusive contract used to force the operator to give up. It was two
    // messages until phase 3n — a text, then the platform's own file message,
    // which costs the contact a second tap and cannot be measured. It is one
    // message now: a card, whose button opens the file (REQ-285).
    //
    // The file is declared by NAME, as the catalogue stores it, and the address
    // is what the send makes of it.
    const resolved: string[] = [];
    const sent = await sentByActive(
      [
        {
          id: "deliver",
          action: "send_dm",
          message: {
            text: "here is the guide",
            buttons: [
              { id: "guide", label: "Get the guide", asset: GUIDE_FILE },
            ],
          },
        },
      ],
      {
        publicUrl: (name) => {
          resolved.push(name);
          return Promise.resolve(`https://cdn.example/${name}`);
        },
      },
    );

    expect(sent).toHaveLength(1);
    expect(sent[0]?.card?.title).toBe("here is the guide");
    // Resolved once, through the engine's asset port, in the instant before
    // the message left — exactly as the cover is (REQ-020). A URL frozen at
    // save time would be a second answer to a question the catalogue owns, and
    // the catalogue coins the name it answers for.
    expect(resolved).toEqual([GUIDE_FILE]);
    expect(sent[0]?.card?.buttons).toEqual([
      {
        id: "guide",
        label: "Get the guide",
        url: `https://cdn.example/${GUIDE_FILE}`,
      },
    ]);
    // The part that left the format leaves the wire with it: nothing this
    // aggregate can declare produces an attachment any more.
    expect(sent.every((message) => message.attachment === undefined)).toBe(
      true,
    );
  });

  it("REQ-285: an address the operator typed is left exactly as typed", async () => {
    // The other branch of the same button, in the same card and in the declared
    // order. Only the file goes through the catalogue: putting a typed address
    // through it would ask for a resource nobody ever stored.
    const resolved: string[] = [];
    const sent = await sentByActive(
      [
        {
          id: "deliver",
          action: "send_dm",
          message: {
            text: "two ways in",
            buttons: [
              {
                id: "site",
                label: "Our site",
                url: "https://example.com/site",
              },
              { id: "guide", label: "Get the guide", asset: GUIDE_FILE },
            ],
          },
        },
      ],
      {
        publicUrl: (name) => {
          resolved.push(name);
          return Promise.resolve(`https://cdn.example/${name}`);
        },
      },
    );

    expect(resolved).toEqual([GUIDE_FILE]);
    expect(sent[0]?.card?.buttons.map((button) => button.url)).toEqual([
      "https://example.com/site",
      `https://cdn.example/${GUIDE_FILE}`,
    ]);
  });
});

/*
 * REQ-231 left the product with the attachment (REQ-284), and its cases left
 * this file with it.
 *
 * What they proved is worth keeping written down, because it is the reason the
 * product stopped sending files this way. One platform call carries `text` OR
 * `attachment` and never both (measured on graph.instagram.com v26.0, "Send
 * messages", 2026-08-16), so a delivery that said something and attached
 * something was two messages: the text, then the file. Touching that file
 * opened a warning pointing at the platform's CDN and cost the contact a second
 * tap, and a tap on it could not be measured.
 *
 * A card button costs one tap, goes out inside the one message the operator
 * wrote, and is counted. What used to be the two-message case is proved above,
 * as ONE message, under REQ-284.
 */

describe("REQ-066: the first message carries no resource at all", () => {
  it("asks before it delivers, and the question carries no URL", async () => {
    const sent = await sentByActive([
      confirmStep({ quick_reply_label: "Yes" }),
      cardStep(),
    ]);

    // The run suspends on the question, so the card never leaves. Whatever the
    // aggregate declares afterwards, the FIRST message has nowhere to put a URL.
    expect(sent).toHaveLength(1);
    expect(sent[0]?.card).toBeUndefined();
    expect(sent[0]?.link).toBeUndefined();
    expect(sent[0]?.attachment).toBeUndefined();
    expect(JSON.stringify(sent[0])).not.toMatch(/https?:\/\//);
  });
});

describe("REQ-068: an open conversation skips the question, not the delivery", () => {
  it("delivers the declared card without asking again", async () => {
    const sent = await sentByActive(
      [confirmStep({ quick_reply_label: "Yes" }), cardStep()],
      { conversationOpen: true },
    );

    // One message, and it is the delivery: the contact who has just written is
    // already in a conversation, so the confirmation is suppressed and the run
    // carries on to the step that hands the resource over.
    expect(sent).toHaveLength(1);
    expect(sent[0]?.card?.buttons.map((button) => button.id)).toEqual([
      "guide",
      "course",
      "call",
    ]);
  });
});

describe("REQ-086: the confirmation's quick reply", () => {
  it("sends the question with the declared button, and no resource", async () => {
    const [message] = await sentByActive([
      confirmStep({ quick_reply_label: "Yes, send it" }),
    ]);

    expect(message?.quickReplies).toEqual(["Yes, send it"]);
    expect(message?.text).toBe("shall I send it?");
    // REQ-066 by construction: `confirm_optin` declares no message shape, so
    // there is nothing here a URL could be put into.
    expect(message?.link).toBeUndefined();
    expect(message?.attachment).toBeUndefined();
    expect(message?.card).toBeUndefined();
  });

  /**
   * REQ-306: a label longer than the ceiling is SENT, and sent whole.
   *
   * The refusal this replaces was never a decision. `docs/platform-limits.md`
   * says the platform TRUNCATES a quick reply title, `limits.ts` stored the
   * number as such, and the validation turned it into a refusal on the way
   * past. The measurement on the real account on 2026-08-19 is what settles
   * it: a label of MEASURED_QUICK_REPLY_CHARS characters was accepted, the
   * button drew 35 of them with an ellipsis, and the webhook echo came back
   * with the whole text. We were refusing to store what the platform delivers.
   *
   * Asserted at the SEND and not at the validation, because the label reaching
   * the sender unshortened is the whole claim: an aggregate that merely
   * validates could still lose the text further down.
   */
  const MEASURED_QUICK_REPLY_CHARS = 67;

  it("sends a label past the ceiling, exactly as it was written", async () => {
    const label = "x".repeat(MEASURED_QUICK_REPLY_CHARS);
    const [message] = await sentByActive([
      confirmStep({ quick_reply_label: label }),
    ]);

    expect(message?.quickReplies).toEqual([label]);
  });

  it("accepts the ceiling itself, and one character past it", async () => {
    // The boundary from both sides, derived from the configured number so the
    // cases follow an installation that tunes it. One past it used to be the
    // first refusal.
    for (const size of [
      LIMIT_DEFAULTS.quickReplyLabelChars,
      LIMIT_DEFAULTS.quickReplyLabelChars + 1,
    ]) {
      const label = "x".repeat(size);
      expect(
        validateAutomationActivation(
          aggregateWith([confirmStep({ quick_reply_label: label })]),
        ).ok,
        `label of ${size} characters`,
      ).toBe(true);
    }
  });
});

describe("REQ-087: message text is measured in UTF-8 bytes", () => {
  const limit = LIMIT_DEFAULTS.messageTextBytes;

  const replyWith = (text: string): unknown[] => [
    { id: "reply", action: "reply_comment", text },
  ];

  it("accepts a text of exactly the byte limit", () => {
    const text = "x".repeat(limit);

    expect(Buffer.byteLength(text, "utf8")).toBe(limit);
    expect(
      validateAutomationActivation(
        aggregateWith(replyWith(text), COMMENT_TRIGGER),
      ).ok,
    ).toBe(true);
  });

  it("rejects a text one byte over, with bytes found and the limit", () => {
    const text = "x".repeat(limit + 1);
    const issues = rejectionOf(
      validateAutomationActivation(
        aggregateWith(replyWith(text), COMMENT_TRIGGER),
      ),
    );

    expect(codes(issues)).toContain("message_text_too_long");
    expect(issues[0]?.message).toContain(String(limit + 1));
    expect(issues[0]?.message).toContain(String(limit));
  });

  it("rejects accented text that a CHARACTER count would have let through", () => {
    // 999 accented characters: under 1000 by length, 1998 bytes in UTF-8.
    const text = "é".repeat(999);

    expect(text.length).toBeLessThan(limit);
    expect(Buffer.byteLength(text, "utf8")).toBe(1998);

    const issues = rejectionOf(
      validateAutomationActivation(
        aggregateWith(replyWith(text), COMMENT_TRIGGER),
      ),
    );
    expect(codes(issues)).toContain("message_text_too_long");
    expect(issues[0]?.message).toContain("1998");
  });

  it("measures every step that declares a text of its own", () => {
    // The rule reaches the step's own `text` field, so it is asserted over the
    // steps that have one. A `send_dm` of the version-2 contract keeps its
    // wording under `message.text` and a `collect_email` under `ask`, and
    // neither is reached by the measurement as it stands today.
    const long = "é".repeat(999);
    const issues = rejectionOf(
      validateAutomationActivation(
        aggregateWith(
          [
            { id: "reply", action: "reply_comment", text: long },
            confirmStep({ text: long }),
          ],
          COMMENT_TRIGGER,
        ),
      ),
    );
    const offending = issues.filter(
      (entry) => entry.code === "message_text_too_long",
    );

    expect(offending).toHaveLength(2);
    expect(offending.map((entry) => entry.path)).toEqual([
      "steps[0].text",
      "steps[1].text",
    ]);
  });
});

describe("REQ-140: one implementation of the assembly rules", () => {
  it("assembles the delivery where production assembles it", async () => {
    // Not against a helper standing beside the engine: the assertion is on the
    // message the SENDER received, after the real binding and the real run.
    // There used to be such a helper, `flows/message.ts`, holding the same
    // rules while `engine/execute.ts` built the real message — two
    // implementations of one rule, and the tests watching the one that never
    // ran.
    const resolved: string[] = [];
    const sent = await sentByActive(
      [confirmStep({ quick_reply_label: "Yes" }), cardStep()],
      {
        conversationOpen: true,
        publicUrl: (name) => {
          resolved.push(name);
          return Promise.resolve(`https://cdn.example/${name}`);
        },
      },
    );

    // The image became a URL exactly once, through the engine's asset port,
    // at the instant before the message left.
    expect(resolved).toEqual(["cover.png"]);
    expect(sent[0]?.card?.imageUrl).toBe("https://cdn.example/cover.png");
  });

  it("keeps no second assembly beside it, under src/flows", () => {
    /*
     * The orphan module was HERE, in `src/flows`. Nothing in this directory may
     * learn the shape of an outbound message again: the aggregate declares an
     * intent, and the engine is the only place that turns it into one.
     *
     * The word `attachment` LEFT this vocabulary with REQ-229, and the reason
     * is worth writing down, because dropping a word from a guard is how guards
     * die. It used to mean only one thing here — `OutboundMessage.attachment`,
     * the assembled field — and the additive contract gave it a second,
     * legitimate meaning: a part the operator DECLARED. Phase 3n took that
     * second meaning away again (REQ-284) and the word was not restored to the
     * guard, because what replaced it is wider than what it lost: EVERY name
     * the outbound message and the sender port are made of, so a second
     * assembly cannot be written here without naming one of them.
     */
    const directory = fileURLToPath(new URL(".", import.meta.url));
    const vocabulary =
      /Outbound\w*|imageUrl|quickReplies|sendDirectMessage|replyToComment/;

    const offenders = readdirSync(directory)
      .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
      .filter((name) =>
        vocabulary.test(readFileSync(`${directory}${name}`, "utf8")),
      );

    expect(offenders).toEqual([]);
  });
});

describe("REQ-052: the aggregate survives export and reimport", () => {
  it("keeps every declared field, field by field", () => {
    const original = aggregateWith(
      [
        { id: "reply", action: "reply_comment", text: ["Primeira", "Segunda"] },
        confirmStep({ quick_reply_label: "Yes" }),
        {
          id: "deliver-links",
          action: "send_dm",
          message: { text: "and two more", links: [...PURE_LINKS] },
        },
        cardStep(),
        {
          id: "deliver-text",
          action: "send_dm",
          message: { text: "here it is" },
        },
      ],
      COMMENT_TRIGGER,
    );

    const first = validateAutomationActivation(original);
    if (!first.ok) {
      throw new Error(
        `expected the aggregate to be accepted: ${JSON.stringify(first.issues)}`,
      );
    }

    const second = validateAutomationActivation(
      JSON.parse(JSON.stringify(first.value)),
    );
    if (!second.ok) {
      throw new Error("expected the reimported aggregate to be accepted");
    }

    expect(second.value).toEqual<ActiveAutomation>(first.value);
    // Spelled out, because a deep equality on an ARRAY is the one place where
    // a reordering would still have to be reported, and these are the two
    // fields whose order is the delivery order (REQ-219, REQ-288).
    const links = second.value.steps[2];
    expect(
      links?.action === "send_dm" ? links.message.links : undefined,
    ).toEqual([...PURE_LINKS]);

    const card = second.value.steps[3];
    expect(
      card?.action === "send_dm"
        ? card.message.buttons?.map((button) => button.id)
        : undefined,
    ).toEqual(["guide", "course", "call"]);
  });
});
