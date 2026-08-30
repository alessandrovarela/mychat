import { z } from "zod";

/**
 * Declarative format, version 2.
 *
 * ONE entity. An automation carries its own trigger, rules and steps, and a
 * step carries concrete values rather than a binding to a parameter declared
 * somewhere else. There is no flow entity, no parameter and no reference to
 * resolve, which is what makes editing one automation unable to change another
 * (REQ-213).
 *
 * Version 1 kept two entities apart, a flow (WHAT to do, with declared
 * parameters) and an automation (WHERE and WHEN, pointing at one flow). Phase
 * 3k removed it with no compatibility layer, because there were no users and no
 * stored data to preserve. `FLOW_ACTIONS` and the step shapes below survive it:
 * they are the vocabulary the ENGINE executes, which is internal and stays.
 *
 * This module is pure data description: no transport, no persistence.
 */

/** The self-contained automation aggregate introduced in phase 3k. */
export const AUTOMATION_SCHEMA_VERSION = 2;

/** Versions accepted by the self-contained automation contract. */
export const SUPPORTED_AUTOMATION_SCHEMA_VERSIONS = [
  AUTOMATION_SCHEMA_VERSION,
] as const;

/** Every action the format declares. Executability is a separate concern, see engine-support.ts. */
export const FLOW_ACTIONS = [
  "reply_comment",
  "send_dm",
  "delay",
  "confirm_optin",
  "collect_email",
  "follow_gate",
] as const;

export type FlowAction = (typeof FLOW_ACTIONS)[number];

/**
 * How a DECLARED word has to appear in the text (REQ-259).
 *
 * Two, since phase 3l: the advanced expression (`regex`) left the product. It
 * asked an operator to write a pattern in a language nothing on the screen
 * taught, and every way of getting it wrong failed the same silent way (the
 * automation stayed enabled and never fired). Removed from the SHAPE rather
 * than from the editor, because a mode only the screen refused would come back
 * through any other writer: an aggregate declaring it is now refused at
 * validation.
 */
export const KEYWORD_MATCH_MODES = ["contains", "exact"] as const;

export type KeywordMatchMode = (typeof KEYWORD_MATCH_MODES)[number];

/**
 * Every comment on the target publication, whatever it says (REQ-262).
 *
 * A mode beside the other two and NOT a flag next to them, which is what makes
 * it exclusive with the choice by word by shape alone: the branch that declares
 * it has no `keywords` field at all, so "any word, and also these three" is a
 * definition nobody can write rather than a combination somebody has to
 * arbitrate later.
 */
export const ANY_WORD_MODE = "any";

/** What a COMMENT trigger may declare. The direct message keeps the two above. */
export const COMMENT_MATCH_MODES = [
  ANY_WORD_MODE,
  ...KEYWORD_MATCH_MODES,
] as const;

export type CommentMatchMode = (typeof COMMENT_MATCH_MODES)[number];

/** A single timeout policy is declared. Widening this list stays compatible. */
export const TIMEOUT_POLICIES = ["abandon"] as const;

const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const PUBLICATION_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

const slugSchema = z
  .string()
  .regex(
    SLUG_PATTERN,
    "must be a slug (lowercase letters and digits separated by single hyphens)",
  );

const textSchema = z.string().min(1, "must not be empty");

/**
 * What a step that sends text says: one wording, or the several it draws
 * between (REQ-125).
 *
 * A UNION on the existing field, not a second field beside it, and that is what
 * keeps the version at 1. Every definition ever stored declares a plain string,
 * which is still exactly what this accepts and still means exactly what it
 * meant, so nothing has to be rewritten to be read: no migration, and the
 * additive extension `sendDmStepSchema` already set the precedent for.
 *
 * The empty list is deliberately NOT refused here. Zod would report it on a
 * path (`steps[2].text`) and never name the step, and REQ-127 asks for the step
 * BY NAME, so that refusal lives in validation.ts beside the other rules that
 * can name one.
 */
export const stepTextSchema = z.union([textSchema, z.array(textSchema)], {
  // Spelled out, because a union's own report is "Invalid input" and nothing
  // else: REQ-008 promises the path AND the reason, and the reason has to say
  // that a list is now one of the two things this field accepts.
  error: "must be a wording, or a list of wordings",
});

export type StepText = z.infer<typeof stepTextSchema>;

/**
 * Every wording a step declares, single or several, read as one list.
 *
 * One reader for both shapes, exported because everything downstream needs the
 * same reading: validation measures each wording, the binding interpolates each
 * one, and the editor lists them.
 */
export function stepWordings(text: StepText): readonly string[] {
  return typeof text === "string" ? [text] : text;
}

/**
 * What a step that WAITS no longer declares (REQ-252, REQ-254).
 *
 * `timeout_hours` and `max_attempts` were fields of the three steps below until
 * phase 3l. They are settings of the INSTANCE now (`src/config/instance-
 * settings.ts`), one deadline and one number of questions for every step that
 * waits, and their absence here is the requirement rather than an omission: a
 * strict object refuses what it does not declare, so an aggregate written under
 * the old reading is refused at validation instead of being stored with two
 * fields nothing would ever read again.
 *
 * What a step still decides is WHAT COUNTS AS AN ANSWER, which is why
 * `on_timeout` stays: the path a contact who never answered takes is a decision
 * of the flow, and the engine is not entitled to overrule it.
 */
const onTimeoutSchema = z.enum(TIMEOUT_POLICIES);

const replyCommentStepSchema = z.strictObject({
  id: slugSchema,
  action: z.literal("reply_comment"),
  /** One wording, or the several this step draws between (REQ-125). */
  text: stepTextSchema,
});

const delayStepSchema = z.strictObject({
  id: slugSchema,
  action: z.literal("delay"),
  seconds: z.int().positive("must be greater than zero"),
});

const confirmOptinStepSchema = z.strictObject({
  id: slugSchema,
  action: z.literal("confirm_optin"),
  text: textSchema,
  /**
   * Label of the quick-reply button, and the answer this step accepts
   * (REQ-249, REQ-250).
   *
   * OBLIGATORY since phase 3l, and absent here is no longer a choice: what the
   * button says is what counts as a yes, so a question without one is a
   * question nobody can answer. It stays declared by the STEP, unlike the
   * button of "ask to follow" that moved to the instance's settings, because
   * this one is part of the offer that this automation makes.
   *
   * Optional in the SHAPE all the same, and deliberately: a required field
   * would be refused by Zod on a path (`steps[2].quick_reply_label`) and would
   * never name the step, which is what REQ-008 promises the operator. The
   * refusal lives in `validation.ts` beside the other rules that can name one,
   * and a draft may still hold the field unwritten while it is being filled in.
   *
   * A quick reply is NOT the URL button of `send_dm`: different mechanism,
   * different ceiling, different payload.
   */
  quick_reply_label: textSchema.optional(),
  on_timeout: onTimeoutSchema,
});

const collectEmailStepSchema = z.strictObject({
  id: slugSchema,
  action: z.literal("collect_email"),
  ask: z.string().optional(),
  on_timeout: onTimeoutSchema,
});

const followGateStepSchema = z.strictObject({
  id: slugSchema,
  action: z.literal("follow_gate"),
  ask: z.string().optional(),
  on_timeout: onTimeoutSchema,
});

/**
 * A publication IDENTIFIER, and nothing wider (REQ-260).
 *
 * A comment automation always names ONE publication. The account-wide target
 * ("any") was removed with REQ-218 in phase 3k: a global automation had to be
 * arbitrated against the publication's own, and the product decided the
 * arbitration was not worth the ambiguity it created for whoever operates it.
 *
 * The publication URL went the same way in phase 3l. It was accepted here and
 * turned into an identifier before anything was stored, which cost a credential,
 * a walk of the media edge and four ways of refusing that an operator had to
 * read and act on. The grid is what names a publication now: the operator picks
 * the picture and the identifier is what travels, so the one spelling that ever
 * reaches storage is the one matching compares against.
 */
const triggerTargetSchema = z
  .string()
  .min(1, "must not be empty")
  .refine((value) => PUBLICATION_ID_PATTERN.test(value), {
    error: "must be a publication id",
  });

/**
 * What a COMMENT trigger listens for, as two branches that exclude each other.
 *
 * Discriminated on `mode`, the field both branches already carried, so nothing
 * new has to be declared for the discrimination to exist. With `any` the object
 * is strict and has no `keywords` at all: declaring words beside it is refused
 * by the SHAPE, which is REQ-262's exclusivity held by the type rather than by a
 * rule somebody has to remember to write.
 */
const commentMatchSchema = z.discriminatedUnion("mode", [
  z.strictObject({ mode: z.literal(ANY_WORD_MODE) }),
  z.strictObject({
    keywords: z.array(textSchema).min(1, "must declare at least one keyword"),
    mode: z.enum(KEYWORD_MATCH_MODES),
  }),
]);

/**
 * What a DIRECT MESSAGE trigger listens for: declared words, always (REQ-263).
 *
 * Its own shape rather than the one above, and that separation IS the
 * requirement. "Any word" on a direct message trigger means every message the
 * account receives starts an automation, which is not a target an operator
 * chose but the whole inbox. Refused HERE and not only on the screen: a
 * prohibition kept in the editor is a promise by convention, and this contract
 * is written by importers and by the API too.
 */
const directMessageMatchSchema = z.strictObject({
  keywords: z.array(textSchema).min(1, "must declare at least one keyword"),
  mode: z.enum(KEYWORD_MATCH_MODES),
});

const commentTriggerSchema = z.strictObject({
  type: z.literal("comment"),
  // Version-2 documents carry their publication here. New documents carry the
  // choice in `scope`, where global and next-publication can be represented
  // without a sentinel publication id.
  target: triggerTargetSchema.optional(),
  match: commentMatchSchema,
});

const directMessageTriggerSchema = z.strictObject(
  {
    type: z.literal("direct_message"),
    match: directMessageMatchSchema,
  },
  // A direct message is not tied to a publication, so a declared target would be
  // a silent lie about what the automation listens to.
  {
    error:
      "a direct message trigger takes no target (it covers the whole account)",
  },
);

export const triggerSchema = z.discriminatedUnion("type", [
  commentTriggerSchema,
  directMessageTriggerSchema,
]);

export type AutomationTrigger = z.infer<typeof triggerSchema>;

export const automationScopeSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("publication"),
    publicationId: triggerTargetSchema,
  }),
  z.strictObject({ type: z.literal("global") }),
  z.strictObject({ type: z.literal("next_publication") }),
]);

export type AutomationScope = z.infer<typeof automationScopeSchema>;

// --- self-contained automation, version 2 ---------------------------------

/** A persisted automation is explicitly either editable or executable. */
export const AUTOMATION_STATES = ["draft", "active"] as const;

export type AutomationState = (typeof AUTOMATION_STATES)[number];

const httpUrlSchema = z
  .url("must be a valid URL")
  .refine(
    (value) => value.startsWith("http://") || value.startsWith("https://"),
    {
      error: "must use HTTP or HTTPS",
    },
  );

/** A button that opens an ADDRESS the operator typed (REQ-219, REQ-229). */
const webButtonSchema = z.strictObject({
  id: slugSchema,
  label: textSchema,
  url: httpUrlSchema,
});

/**
 * A button that opens a FILE of the catalogue (REQ-285).
 *
 * The asset NAME, exactly as the card's cover carries one, and never the
 * address it resolves to. The file did not leave the product when the
 * attachment did, it changed carrier: it is a button's destination now, served
 * from our own CDN, so what a contact taps is one tap inside the message the
 * operator wrote and it can be counted.
 *
 * The name and not the URL, and that is a decision with three reasons. The
 * catalogue answers "where is this file" at the instant of the send and throws
 * when the answer is nowhere, so a file deleted after the automation was
 * written fails LOUDLY instead of reaching a contact as a button that opens
 * nothing. The catalogue also coins its own identity (`guide.pdf` is stored as
 * `guide~8hex.pdf`), so an address frozen at save time is a copy of an answer
 * that belongs to another table. And the cover already works this way
 * (REQ-020, REQ-224): one question, one place that answers it.
 */
const fileButtonSchema = z.strictObject({
  id: slugSchema,
  label: textSchema,
  asset: textSchema,
});

/**
 * Stable identity and destination of one ordered card button (REQ-219,
 * REQ-229, REQ-285).
 *
 * A UNION and not two optional fields beside each other, and the difference is
 * the whole of it: a button opens exactly ONE thing, so "an address and a file"
 * is a sentence this contract cannot write rather than a combination somebody
 * downstream has to arbitrate. Strict objects, so the branch that declares an
 * address refuses a file beside it and the other way round.
 *
 * Which branch a stored button matches is also what the editor reads back when
 * it reopens an automation: `url` is the operator's "Link", `asset` is their
 * "PDF or image". The choice survives the round trip because it is what was
 * written down, not something inferred from the shape of an address.
 *
 * A button that declares NEITHER is refused here too, exactly as it was while
 * `url` was a required field: nothing changes for a destination left blank.
 */
export const cardButtonSchema = z.union(
  [webButtonSchema, fileButtonSchema],
  // Spelled out, because a union's own report is "Invalid input" and nothing
  // else, and REQ-008 promises the reason as well as the path.
  {
    error:
      "must open one destination: an address (url) or a file of the catalogue (asset)",
  },
);

export type CardButton = z.infer<typeof cardButtonSchema>;

/**
 * How many BUTTONS one card carries (REQ-219).
 *
 * Three, which is what one generic-template element accepts and also what the
 * product offers. The ceiling is NOT applied here, for the reason the whole
 * file keeps repeating: a `.max()` reports "too big" on a path, and REQ-127
 * asks for the STEP by name, so the refusal lives in validation.ts where a step
 * id is in reach.
 */
export const CARD_BUTTON_LIMIT = 3;

/**
 * One pure link: an ADDRESS, and nothing beside it (REQ-286).
 *
 * No label and no id, and both absences are the form. A label belongs to a
 * button, which is the other form and the one that makes a card; and an id
 * exists so a click can be attributed to it, which is done by delivering
 * `/clicks/<id>` in the destination's place. That wrapper is exactly what a
 * pure link must not carry: the address IS what the destination site is asked
 * to describe, and replacing it means the preview an operator chose this form
 * for is never drawn.
 */
const pureLinkSchema = httpUrlSchema;

/**
 * How many pure links one delivery carries (REQ-288).
 *
 * Three as well, and it is not the same number twice: the ceiling above is the
 * template's, this one is the PRODUCT's. Each link is a message of its own, so
 * a fourth is a fifth message in a row, and a burst is what this product exists
 * not to be. Applied in validation.ts, like every other count, so the refusal
 * can name the step.
 */
export const PURE_LINK_LIMIT = 3;

/**
 * What one private message carries: a text, and the parts that ADD to it.
 *
 * Additive, and that is the whole of the change (REQ-229). Until phase 3k this
 * was a union discriminated by `kind`, so the shapes excluded one another and
 * the product paid for it in the two cases operators actually write: choosing a
 * card made the written text VANISH (a card had a title and a description, and
 * nowhere for the message), and choosing a file dropped the text at the send.
 * "Text and a link" could not be expressed at all, and "text and a PDF" — the
 * anchor case of this product — forced the text to be abandoned.
 *
 * Every field is optional HERE and the combinations are judged in
 * validation.ts, for two reasons. A draft is saved half-written, so a shape
 * that demanded a text would make the editor unable to store what the operator
 * has so far; and every refusal this contract owes has to name the step and the
 * field (REQ-008, REQ-127), which a shape complaint at `steps[2].message`
 * cannot do.
 *
 * TWO lists of parts since phase 3n, and their separation is the requirement
 * (REQ-287, REQ-288). A BUTTON is what turns the message into a card; a LINK is
 * an address that travels on its own. Until 3n there was one list called
 * `links` and the card was derived from its length, so the two forms were one
 * declaration and neither could be offered as itself: an operator who wanted
 * the destination site to draw its own preview got a card with a button in it.
 *
 * No attachment among the parts, and its absence is the removal (REQ-284). The
 * platform's own file message costs the contact a second tap — touching a PDF
 * opens a warning pointing at the platform's CDN, and only then the file — and
 * it cannot be measured. The file did not leave the product, it changed
 * carrier: it is the destination of a card button now, served from our CDN
 * (REQ-285). Removed from the SHAPE with no compatibility layer, exactly as
 * phase 3l removed `name`: a strict object refuses what it does not declare, so
 * an automation stored under the old reading is refused at validation instead
 * of being read as one that silently sends nothing. Refused and SHOWN as
 * unreadable rather than discarded in silence, which is REQ-294 and lives where
 * the automations are listed.
 *
 * What the parts BECOME is stated once, here, because three files downstream
 * depend on reading it the same way:
 *
 *   - no button: the text goes out as a plain text message;
 *   - one button or more: ONE card goes out, and the text travels as its title
 *     (REQ-230) — never as a separate message before it;
 *   - `image` is the card's cover, so it exists only where a card does, which
 *     is only where a BUTTON does (REQ-232, REQ-287);
 *   - each link is a message of its OWN, after the card or the text, in the
 *     order it was declared (REQ-286, REQ-288).
 */
export const directMessageContentSchema = z.strictObject({
  /** One wording, or the several this step draws between (REQ-125). */
  text: stepTextSchema.optional(),
  /**
   * The card's buttons, and the card itself: with one of these the message IS a
   * card, with none of them it is not (REQ-287). Array order is the order they
   * sit in the card, never sorted.
   */
  buttons: z.array(cardButtonSchema).optional(),
  /**
   * Zero to three pure links, each one a message of its own. Array order is
   * delivery order, never sorted (REQ-288).
   */
  links: z.array(pureLinkSchema).optional(),
  /** The card's cover. An asset name, resolved at send time (REQ-224). */
  image: textSchema.optional(),
  /** The card's own title, with the template's short ceiling (REQ-230). */
  title: textSchema.optional(),
  /** The card's own subtitle, with the same ceiling. */
  description: textSchema.optional(),
});

export type DirectMessageContent = z.infer<typeof directMessageContentSchema>;

const unifiedSendDmStepSchema = z.strictObject({
  id: slugSchema,
  action: z.literal("send_dm"),
  message: directMessageContentSchema,
});

/** Steps owned by the automation aggregate. */
export const automationStepSchema = z.discriminatedUnion("action", [
  replyCommentStepSchema,
  unifiedSendDmStepSchema,
  delayStepSchema,
  confirmOptinStepSchema,
  collectEmailStepSchema,
  followGateStepSchema,
]);

export type AutomationStep = z.infer<typeof automationStepSchema>;

/**
 * How long the automation holds its FIRST reply, in seconds (REQ-277).
 *
 * A closed ruler and not a free number, and the closure is the product's
 * decision rather than a simplification of the editor: what an operator is
 * choosing here is "do not answer in the same second", which is the signature a
 * spam filter looks for, and every useful answer to that is one of these five.
 * A free field invited 3600, which is not a politeness but an abandoned
 * contact.
 *
 * Exported because the SCREEN offers exactly these and must not retype them: a
 * sixth box on the screen would be a value the contract refuses, and a value
 * removed here would go on being offered.
 */
export const FIRST_REPLY_DELAY_CHOICES = [0, 5, 10, 30, 60] as const;

export type FirstReplyDelaySeconds = (typeof FIRST_REPLY_DELAY_CHOICES)[number];

/**
 * What the automation waits when nobody chose (REQ-277).
 *
 * Five seconds, and it is the DEFAULT rather than the floor: zero is on the
 * ruler above and means immediate, declared by whoever wants it. That split is
 * what lets the absence of the field keep meaning "not chosen" and be filled
 * with the product's answer, instead of meaning "immediate" and turning every
 * aggregate an importer writes without the field into the one behaviour the
 * requirement exists to prevent.
 */
export const DEFAULT_FIRST_REPLY_DELAY_SECONDS = 5;

const automationRulesSchema = z.strictObject({
  once_per_contact: z.boolean().default(true),
  /**
   * The wait, as a RULE of the automation and no longer a step (REQ-277).
   *
   * It lives beside `once_per_contact` because it is the same kind of thing:
   * one decision that governs the whole run, taken once, and true wherever the
   * automation fires. As a step it was a position in a list, and a position is
   * something the editor has to get right every time it assembles one; this is
   * a value, and there is no order to get wrong.
   *
   * The `delay` STEP still exists in the vocabulary above, and deliberately: it
   * is a pause between two named steps (REQ-098), which is a different thing
   * from the hold before the first reply and is proven end to end. What changed
   * is that the operator's wait is no longer expressed through it.
   */
  first_reply_delay_seconds: z
    .literal(FIRST_REPLY_DELAY_CHOICES, {
      error: `must be one of the offered waits (${FIRST_REPLY_DELAY_CHOICES.join(", ")} seconds)`,
    })
    .default(DEFAULT_FIRST_REPLY_DELAY_SECONDS),
});

/*
 * No `name` among them, and its absence is the field's removal (REQ-279).
 *
 * A comment automation names the publication it watches and nothing else: the
 * name an operator reads is composed from that publication's CURRENT caption at
 * the moment of showing. A stored name was a copy of a caption that lives in
 * another table, frozen on the day it was saved, and a copy that cannot be
 * refreshed is a second answer to a question that already has one, which is how
 * the same automation came to be called two different things on two screens.
 */
const activeAutomationFields = {
  schema_version: z.literal(AUTOMATION_SCHEMA_VERSION),
  kind: z.literal("automation"),
  id: slugSchema,
  scope: automationScopeSchema.optional(),
  trigger: triggerSchema,
  rules: automationRulesSchema,
  steps: z
    .array(automationStepSchema)
    .min(1, "an active automation needs at least one step"),
} as const;

/** Fully validated, executable aggregate. It contains no flow reference. */
export const activeAutomationSchema = z.strictObject({
  ...activeAutomationFields,
  state: z.literal("active"),
});

export type ActiveAutomation = z.infer<typeof activeAutomationSchema>;

/*
 * Drafts keep the same vocabulary, but fields the editor has not reached may
 * be absent. Discriminants and generated ids stay required once a nested item
 * exists, which prevents a draft from becoming an unstructured JSON bag.
 */
/*
 * Two draft shapes, for the reason the active ones are two: the words may be
 * missing while the editor is still open, and "any word" may not be declared on
 * a direct message even half written (REQ-263). A draft that could hold it would
 * be a draft whose only fault is discovered at activation, which is the refusal
 * this contract exists to bring forward.
 *
 * `keywords` stays optional under EVERY mode here, `any` included, because a
 * draft is what an operator left half answered: they may have chosen the mode
 * before typing a word, or typed words and then chosen `any`. The exclusivity
 * of REQ-262 is what the ACTIVE shape refuses, and the editor writes only the
 * side the chosen mode uses.
 */
const draftCommentMatchSchema = z.strictObject({
  keywords: z.array(z.string()).optional(),
  mode: z.enum(COMMENT_MATCH_MODES).optional(),
});

const draftDirectMessageMatchSchema = z.strictObject({
  keywords: z.array(z.string()).optional(),
  mode: z.enum(KEYWORD_MATCH_MODES).optional(),
});

const draftTriggerSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("comment"),
    target: z.string().optional(),
    match: draftCommentMatchSchema.optional(),
  }),
  z.strictObject({
    type: z.literal("direct_message"),
    match: draftDirectMessageMatchSchema.optional(),
  }),
]);

/**
 * The same button with every value the editor has not filled in yet allowed to
 * be blank, including the destination it opens.
 *
 * ONE object here and not the union above, and the difference is what a draft
 * IS: the operator picks "Link" or "PDF or image" and fills it in afterwards,
 * so both fields have to be writable while only one of them ends up declared.
 * An empty string is a destination ASKED FOR and not yet chosen, exactly as the
 * cover's is, and it is also the record of WHICH of the two the operator
 * pressed.
 *
 * The SHAPE stays this wide for every writer, and the editor is stricter than
 * it: a form switched from one destination to the other keeps the abandoned
 * value in memory and writes neither the field nor a blank for it
 * (`buttonDestination`, `automation-form.tsx`). What this permissiveness is for
 * is everything that writes a draft without that editor, which is an import, a
 * call to the API, and a document written by hand.
 *
 * Declaring BOTH for real is the one combination a draft may not hold, and it
 * is refused by name in `validation.ts`: a draft whose only fault is discovered
 * at activation is the discovery this contract exists to bring forward.
 */
const draftCardButtonSchema = z.strictObject({
  id: slugSchema,
  label: z.string().optional(),
  url: z.string().optional(),
  asset: z.string().optional(),
});

/**
 * The same additive parts, with every value the editor has not filled in yet
 * allowed to be blank. The PARTS are the same fields, so a draft never has to
 * be translated into the active shape: it is the active shape, with holes.
 *
 * No `attachments` here either, and the draft is where that matters most: a
 * shape that still held the retired part would accept the old document on the
 * save, keep it for as long as the editor stayed open, and refuse it only at
 * activation — which is the discovery this contract exists to bring forward.
 */
const draftDirectMessageContentSchema = z.strictObject({
  text: stepTextSchema.optional(),
  buttons: z.array(draftCardButtonSchema).optional(),
  // A half-typed address is a string and not yet a URL, which is what a draft
  // holds. What it may not be is an object: the retired button shape and this
  // one would then be told apart by a field nobody declared.
  links: z.array(z.string()).optional(),
  image: z.string().optional(),
  title: z.string().optional(),
  description: z.string().optional(),
});

const draftAutomationStepSchema = z.discriminatedUnion("action", [
  replyCommentStepSchema.partial().required({ id: true, action: true }),
  z.strictObject({
    id: slugSchema,
    action: z.literal("send_dm"),
    message: draftDirectMessageContentSchema.optional(),
  }),
  delayStepSchema.partial().required({ id: true, action: true }),
  confirmOptinStepSchema.partial().required({ id: true, action: true }),
  collectEmailStepSchema.partial().required({ id: true, action: true }),
  followGateStepSchema.partial().required({ id: true, action: true }),
]);

export const draftAutomationSchema = z.strictObject({
  schema_version: z.literal(AUTOMATION_SCHEMA_VERSION),
  kind: z.literal("automation"),
  id: slugSchema,
  state: z.literal("draft"),
  scope: automationScopeSchema.optional(),
  trigger: draftTriggerSchema.optional(),
  rules: automationRulesSchema.partial().optional(),
  steps: z.array(draftAutomationStepSchema).optional(),
});

export type DraftAutomation = z.infer<typeof draftAutomationSchema>;

/** The only persisted language consumers of the unified editor need. */
export const unifiedAutomationSchema = z.discriminatedUnion("state", [
  draftAutomationSchema,
  activeAutomationSchema,
]);

export type UnifiedAutomation = z.infer<typeof unifiedAutomationSchema>;
