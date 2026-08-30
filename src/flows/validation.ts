import type { z } from "zod";
import { LIMIT_DEFAULTS } from "../config/limits.js";
import { t } from "../i18n/index.js";
import {
  activeAutomationSchema,
  CARD_BUTTON_LIMIT,
  PURE_LINK_LIMIT,
  stepWordings,
  SUPPORTED_AUTOMATION_SCHEMA_VERSIONS,
  unifiedAutomationSchema,
} from "./schema.js";
import type {
  ActiveAutomation,
  AutomationStep,
  UnifiedAutomation,
} from "./schema.js";
import { isStepIncompatibleWith } from "./trigger-compatibility.js";

export const VALIDATION_ISSUE_CODES = [
  "schema_version_missing",
  "schema_version_unsupported",
  "invalid_shape",
  "duplicate_step_id",
  "duplicate_button_id",
  "button_destination_declared_twice",
  "step_without_wording",
  "flow_trigger_incompatible",
  "message_text_too_long",
  "confirmation_without_quick_reply",
  "message_without_content",
  "too_many_buttons",
  "too_many_links",
  "cover_without_button",
  "card_description_too_long",
  "card_title_declared_twice",
  "scope_trigger_mismatch",
  "email_question_without_wording",
  "follow_question_without_wording",
] as const;

export type ValidationIssueCode = (typeof VALIDATION_ISSUE_CODES)[number];

/*
 * No ceiling on how many messages one delivery becomes, and no attachment count
 * (REQ-284, REQ-288).
 *
 * Both existed here until phase 3n and both had the same single reason: one
 * send call carries text OR an attachment and never both, so a text with a PDF
 * was two calls and a second PDF was a third message. The attachment left the
 * format, and the reason left with it. What a delivery may become is now
 * counted where it is decided: at most one card or text, plus one message per
 * pure link, which `PURE_LINK_LIMIT` already holds to three.
 *
 * No refusal by LENGTH of a button label or of a quick reply label either
 * (REQ-306).
 *
 * Both existed here until phase 3o and neither was ever decided: the platform
 * publishes those two numbers as a point of TRUNCATION, `limits.ts` stored
 * them as such, and this file turned them into a refusal on the way past. The
 * measurement on the real account on 2026-08-19 settled it: a quick reply of
 * 67 characters was ACCEPTED, the button showed 35 of them with an ellipsis,
 * and the webhook echo came back with all 67. The cut is presentation, so
 * refusing to store the definition refuses what the platform itself delivers.
 *
 * The numbers did not go anywhere: `linkButtonLabelChars` and
 * `quickReplyLabelChars` stay in configuration, readable at runtime and
 * tunable by environment variable, and what they feed now is the editor's
 * warning that the text will arrive cut (REQ-307). Warning is not this layer's
 * job: what reaches a contact whole is stored whole.
 */

export interface ValidationIssue {
  readonly code: ValidationIssueCode;
  readonly path: string;
  readonly message: string;
  /**
   * The ceiling this value went past, when the refusal is about a ceiling.
   *
   * The number and never the sentence, and it travels BESIDE `message` rather
   * than inside it: the message is this layer's own account of the refusal, in
   * the operator's language, and an editor that wanted to say the same thing
   * in three words had no way to learn the number short of reading English
   * prose back out of it. The words are the screen's, the number is ours,
   * which is the arrangement the instance's settings already ship under
   * (`refusalObject({ limit })` in `src/http/api/instance.ts`).
   *
   * Absent on every refusal that is not about a ceiling, because there is no
   * honest number to put there.
   */
  readonly limit?: number;
}

export type ValidationResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly issues: readonly ValidationIssue[] };

export function validateUnifiedAutomation(
  input: unknown,
): ValidationResult<UnifiedAutomation> {
  const versionIssue = checkSchemaVersion(input);
  if (versionIssue !== undefined) return { ok: false, issues: [versionIssue] };

  const parsed = unifiedAutomationSchema.safeParse(input);
  if (!parsed.success)
    return { ok: false, issues: toShapeIssues(parsed.error) };

  const issues = collectCoherenceIssues(parsed.data);
  return issues.length === 0
    ? { ok: true, value: parsed.data }
    : { ok: false, issues };
}

export function validateAutomationActivation(
  input: unknown,
): ValidationResult<ActiveAutomation> {
  const versionIssue = checkSchemaVersion(input);
  if (versionIssue !== undefined) return { ok: false, issues: [versionIssue] };

  const candidate =
    typeof input === "object" && input !== null && !Array.isArray(input)
      ? { ...(input as Record<string, unknown>), state: "active" }
      : input;
  const parsed = activeAutomationSchema.safeParse(candidate);
  if (!parsed.success)
    return { ok: false, issues: toShapeIssues(parsed.error) };

  const issues = collectCoherenceIssues(parsed.data);
  return issues.length === 0
    ? { ok: true, value: parsed.data }
    : { ok: false, issues };
}

function checkSchemaVersion(input: unknown): ValidationIssue | undefined {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return issue(
      "invalid_shape",
      "",
      `expected a definition object, received ${describeType(input)}`,
    );
  }
  const declared = (input as Record<string, unknown>)["schema_version"];
  if (declared === undefined) {
    return issue(
      "schema_version_missing",
      "schema_version",
      t("validation.schemaVersionMissing", {
        supported: SUPPORTED_AUTOMATION_SCHEMA_VERSIONS.join(", "),
      }),
    );
  }
  if (
    !(SUPPORTED_AUTOMATION_SCHEMA_VERSIONS as readonly unknown[]).includes(
      declared,
    )
  ) {
    return issue(
      "schema_version_unsupported",
      "schema_version",
      t("validation.schemaVersionUnsupported", {
        found:
          typeof declared === "string" ? `"${declared}"` : String(declared),
        supported: SUPPORTED_AUTOMATION_SCHEMA_VERSIONS.join(", "),
      }),
    );
  }
  return undefined;
}

function collectCoherenceIssues(
  automation: UnifiedAutomation,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const seenSteps = new Set<string>();

  collectScopeIssues(automation, issues);

  for (const [stepIndex, step] of (automation.steps ?? []).entries()) {
    if (seenSteps.has(step.id)) {
      issues.push(
        issue(
          "duplicate_step_id",
          `steps[${stepIndex}].id`,
          t("validation.duplicateStepId", { id: step.id }),
        ),
      );
    }
    seenSteps.add(step.id);

    if (
      automation.trigger !== undefined &&
      isStepIncompatibleWith(step as AutomationStep, automation.trigger.type)
    ) {
      issues.push(
        issue(
          "flow_trigger_incompatible",
          `steps[${stepIndex}].action`,
          t("validation.triggerIncompatible", { step: step.id }),
        ),
      );
    }

    collectStepIssues(step, stepIndex, issues, automation.state === "active");
  }
  return issues;
}

function collectScopeIssues(
  automation: UnifiedAutomation,
  issues: ValidationIssue[],
): void {
  // Documents written before scopes existed remain readable. Every new writer
  // declares scope explicitly; the legacy target is only a read bridge.
  if (automation.trigger === undefined) return;
  if (automation.scope === undefined) {
    if (
      automation.trigger.type === "comment" &&
      automation.trigger.target === undefined
    ) {
      issues.push(
        issue(
          "scope_trigger_mismatch",
          "trigger.target",
          t("validation.scopeTriggerMismatch"),
        ),
      );
    }
    return;
  }

  const scope = automation.scope;
  const trigger = automation.trigger;
  const coherent =
    trigger.type === "direct_message"
      ? scope.type === "global"
      : scope.type === "publication"
        ? trigger.target === scope.publicationId
        : trigger.target === undefined;
  if (!coherent) {
    issues.push(
      issue(
        "scope_trigger_mismatch",
        "scope",
        t("validation.scopeTriggerMismatch"),
      ),
    );
  }
}

type AnyStep = AutomationStep | NonNullable<UnifiedAutomation["steps"]>[number];

/** The additive message a step declares, in either the draft or the active shape. */
type DeclaredMessage = Extract<AnyStep, { action: "send_dm" }>["message"];

function declaredMessage(step: AnyStep): DeclaredMessage {
  return step.action === "send_dm" ? step.message : undefined;
}

/** One button as either shape holds it: the active union, or the draft. */
type DeclaredButton = NonNullable<
  NonNullable<DeclaredMessage>["buttons"]
>[number];

/**
 * Whether this step's message is a CARD, which one button is all it takes
 * (REQ-287).
 *
 * Asked in one place because everything about the card follows from it: the
 * text becomes the card's title instead of a message (REQ-230), the cover has
 * something to sit on (REQ-232), and the ceiling the text is measured against
 * changes with it.
 *
 * It was `links.length > 0` until phase 3n, which made a pure link and a button
 * the same declaration: an operator who added an address so the destination
 * site would draw its own preview silently turned their message into a card,
 * and the preview they were after was never drawn.
 */
function messageIsCard(step: AnyStep): boolean {
  return (declaredMessage(step)?.buttons ?? []).length > 0;
}

/**
 * Every wording one step declares, and where each one sits.
 *
 * Read through ONE reader because the same two rules apply wherever a wording
 * is written, and phase 3k proved what happens when they are written per
 * field: the v2 `send_dm` moved its text into `message.text`, the guards kept
 * reading `step.text`, and the byte ceiling of REQ-087 silently stopped
 * reaching any private message at all. A path is returned beside each wording
 * so a refusal still points at the exact one (REQ-008).
 */
function declaredWordings(
  step: AnyStep,
  index: number,
):
  | {
      readonly values: readonly string[];
      readonly path: string;
      readonly listed: boolean;
    }
  | undefined {
  if (step.action === "send_dm") {
    // ONE field now, and always the same one: the additive contract has a text
    // that stands on its own, so there is no `kind` left to ask about and no
    // shape of message this reader can fail to reach.
    const text = step.message?.text;
    if (text === undefined) return undefined;
    return {
      values: stepWordings(text),
      path: `steps[${index}].message.text`,
      listed: Array.isArray(text),
    };
  }
  if ("text" in step && step.text !== undefined) {
    return {
      values: stepWordings(step.text),
      path: `steps[${index}].text`,
      listed: Array.isArray(step.text),
    };
  }
  // What `collect_email` and `follow_gate` say to the contact. It is a message
  // like any other and the platform measures it the same way.
  if ("ask" in step && step.ask !== undefined) {
    return { values: [step.ask], path: `steps[${index}].ask`, listed: false };
  }
  return undefined;
}

/**
 * What a button DECLARES as its destination, read the same way on a draft and
 * on an active automation (REQ-285).
 *
 * An empty string is a destination asked for and not yet chosen, exactly as the
 * cover's is: the editor writes the field the moment the button exists, so a
 * button being filled in carries `url: ""` and a button switched from an
 * address to a file carries it still. Reading "" as a declaration would turn
 * every operator who changed their mind into a refusal.
 */
function declaresAddress(button: DeclaredButton): boolean {
  return "url" in button && button.url !== undefined && button.url !== "";
}

function declaresFile(button: DeclaredButton): boolean {
  return "asset" in button && button.asset !== undefined && button.asset !== "";
}

function collectStepIssues(
  step: AnyStep,
  index: number,
  issues: ValidationIssue[],
  active: boolean,
): void {
  if (
    active &&
    (step.action === "collect_email" || step.action === "follow_gate") &&
    (step.ask === undefined || step.ask.trim() === "")
  ) {
    issues.push(
      issue(
        step.action === "collect_email"
          ? "email_question_without_wording"
          : "follow_question_without_wording",
        `steps[${index}].ask`,
        t("validation.stepWithoutWording", { step: step.id }),
      ),
    );
  }

  const declared = declaredWordings(step, index);

  if (declared !== undefined) {
    if (declared.listed && declared.values.length === 0) {
      issues.push(
        issue(
          "step_without_wording",
          declared.path,
          t("validation.stepWithoutWording", { step: step.id }),
        ),
      );
    }

    const asCardTitle = messageIsCard(step);

    // EVERY wording, not only the first: a step that draws between several
    // sends any one of them, so one over the ceiling is a message that fails
    // to go out on the day it happens to be drawn.
    for (const [wordingIndex, wording] of declared.values.entries()) {
      const path = declared.listed
        ? `${declared.path}[${wordingIndex}]`
        : declared.path;

      // The ceiling follows the DESTINATION, not the field. With a button this
      // wording is the card's title. The template cuts it visually, but accepts
      // and stores the whole value, so it must not become a validation refusal
      // (ADR-028 / REQ-346). It is deliberately not measured against the text
      // message's byte ceiling either: this delivery is a card, not a text
      // message, and the browser advises its title ceiling while it is edited.
      if (asCardTitle) {
        continue;
      }

      const found = Buffer.byteLength(wording, "utf8");
      if (found <= LIMIT_DEFAULTS.messageTextBytes) continue;
      issues.push(
        issue(
          "message_text_too_long",
          path,
          t("validation.messageTextTooLong", {
            step: step.id,
            found,
            limit: LIMIT_DEFAULTS.messageTextBytes,
          }),
          LIMIT_DEFAULTS.messageTextBytes,
        ),
      );
    }
  }

  if (step.action === "confirm_optin") {
    const label = step.quick_reply_label;

    // How LONG the label is decides nothing here (REQ-306). Whether there is
    // one at all still does, and that is the rule below.

    // REQ-249: the button is obligatory, and it is what the question is
    // answered with (REQ-250). Refused HERE rather than by the shape, and by
    // name: a required field in the schema reports a path and never the step,
    // and REQ-008 promises the operator the step they have to go and fix.
    //
    // Only on activation, exactly like a delivery with nothing in it: an
    // unwritten field is what a draft exists to hold, and refusing the save
    // would stop an operator halfway through a form. What may never happen is
    // this reaching a CONTACT, and activation is the moment that becomes
    // possible.
    if (active && (label === undefined || label.trim() === "")) {
      issues.push(
        issue(
          "confirmation_without_quick_reply",
          `steps[${index}].quick_reply_label`,
          t("validation.confirmationWithoutQuickReply", { step: step.id }),
        ),
      );
    }
  }
  const message = declaredMessage(step);
  if (message === undefined) return;

  collectMessageIssues(message, step.id, index, issues, active);
}

/**
 * What the additive message may and may not combine (REQ-229, REQ-230, REQ-232,
 * REQ-287).
 *
 * Every refusal here names the STEP and points at the FIELD, because that is
 * the only form of refusal an operator can act on: the editor shows sections,
 * not JSON paths, and "invalid message" sends someone hunting.
 *
 * The rules split in two on purpose. What is WRONG in itself — a count over a
 * ceiling, a repeated id, a cover with nothing to sit on — is refused whether
 * the automation is a draft or active: a draft with four links is a draft that
 * can never be activated, and saying so on the save it happens is cheaper than
 * saying it later. What is merely UNFINISHED (a message with nothing in it, a
 * title and a text that have not been reconciled yet) is refused only on
 * activation, because a draft exists precisely to hold what is half written.
 */
function collectMessageIssues(
  message: NonNullable<DeclaredMessage>,
  stepId: string,
  index: number,
  issues: ValidationIssue[],
  active: boolean,
): void {
  const path = `steps[${index}].message`;
  const buttons = message.buttons ?? [];
  const links = message.links ?? [];
  const wordings = message.text === undefined ? [] : stepWordings(message.text);

  if (buttons.length > CARD_BUTTON_LIMIT) {
    issues.push(
      issue(
        "too_many_buttons",
        `${path}.buttons`,
        t("validation.tooManyButtons", {
          step: stepId,
          found: buttons.length,
          limit: CARD_BUTTON_LIMIT,
        }),
      ),
    );
  }

  // The two ceilings are counted apart because the two forms ARE apart
  // (REQ-287): three buttons is what one card element carries, three links is
  // three further messages, and adding them up would refuse a delivery the
  // product offers.
  if (links.length > PURE_LINK_LIMIT) {
    issues.push(
      issue(
        "too_many_links",
        `${path}.links`,
        t("validation.tooManyLinks", {
          step: stepId,
          found: links.length,
          limit: PURE_LINK_LIMIT,
        }),
      ),
    );
  }

  const seenButtons = new Set<string>();
  for (const [buttonIndex, button] of buttons.entries()) {
    // Nothing measures `button.label` here (REQ-306). A label longer than
    // `linkButtonLabelChars` travels to the platform whole and is cut only on
    // the screen it is drawn on, so the ceiling belongs to the editor's
    // warning and not to this refusal.
    if (declaresAddress(button) && declaresFile(button)) {
      // REQ-285: a button opens exactly ONE thing. The ACTIVE shape cannot even
      // hold both (`cardButtonSchema` is a union of two strict objects), so what
      // this rule reaches is the DRAFT, which is where an operator actually
      // is while they are choosing — and reaching it there is the point: a
      // fault whose only discovery is the activation is the discovery this
      // contract exists to bring forward.
      //
      // The half the operator abandoned is left behind as an empty string, not
      // as a second destination, so switching from an address to a file and
      // back is not this fault and must never be reported as one.
      issues.push(
        issue(
          "button_destination_declared_twice",
          `${path}.buttons[${buttonIndex}].asset`,
          t("validation.buttonDestinationDeclaredTwice", {
            step: stepId,
            id: button.id,
          }),
        ),
      );
    }
    if (seenButtons.has(button.id)) {
      issues.push(
        issue(
          "duplicate_button_id",
          `${path}.buttons[${buttonIndex}].id`,
          t("validation.duplicateButtonId", { id: button.id }),
        ),
      );
    }
    seenButtons.add(button.id);
  }

  if (
    message.description !== undefined &&
    message.description.length > LIMIT_DEFAULTS.cardDescriptionChars
  ) {
    issues.push(
      issue(
        "card_description_too_long",
        `${path}.description`,
        t("validation.cardDescriptionTooLong", {
          step: stepId,
          found: message.description.length,
          limit: LIMIT_DEFAULTS.cardDescriptionChars,
        }),
        LIMIT_DEFAULTS.cardDescriptionChars,
      ),
    );
  }

  // REQ-232, REQ-287: the cover belongs to the card, and there is no card
  // without a BUTTON. Pure links do not make one, however many there are, so an
  // image beside three links is still an image with nothing to sit on.
  if (message.image !== undefined && buttons.length === 0) {
    issues.push(
      issue(
        "cover_without_button",
        `${path}.image`,
        t("validation.coverWithoutButton", { step: stepId }),
      ),
    );
  }

  // With a button, the text IS the title, so declaring both leaves one of them
  // with nowhere to go. Refused rather than arbitrated: silently dropping the
  // one that loses is the exact fault this contract was written to end.
  if (
    active &&
    buttons.length > 0 &&
    wordings.length > 0 &&
    message.title !== undefined
  ) {
    issues.push(
      issue(
        "card_title_declared_twice",
        `${path}.title`,
        t("validation.cardTitleDeclaredTwice", { step: stepId }),
      ),
    );
  }

  /*
   * What this delivery actually SENDS, counted the way the contact receives it:
   * one first message when there is a text or a card, plus one per pure link.
   *
   * A title alone does not count, and that is the one change of arithmetic here
   * (REQ-287). A title is the card's, and with no button there is no card to
   * carry it: counting it made an automation that delivers nothing at all pass
   * as complete, and the operator would find that out from a contact who
   * received silence.
   */
  const main = wordings.length > 0 || buttons.length > 0 ? 1 : 0;
  const messages = main + links.length;

  if (active && messages === 0) {
    issues.push(
      issue(
        "message_without_content",
        path,
        t("validation.messageWithoutContent", { step: stepId }),
      ),
    );
  }
}

function toShapeIssues(error: z.ZodError): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (const raw of error.issues) {
    if (raw.code === "unrecognized_keys") {
      for (const key of raw.keys)
        issues.push(
          issue("invalid_shape", formatPath([...raw.path, key]), raw.message),
        );
    } else {
      issues.push(issue("invalid_shape", formatPath(raw.path), raw.message));
    }
  }
  return issues;
}

function issue(
  code: ValidationIssueCode,
  path: string,
  reason: string,
  limit?: number,
): ValidationIssue {
  return {
    code,
    path,
    message: path === "" ? reason : `${path}: ${reason}`,
    ...(limit !== undefined && { limit }),
  };
}

function formatPath(path: readonly PropertyKey[]): string {
  let formatted = "";
  for (const segment of path) {
    if (typeof segment === "number") formatted += `[${segment}]`;
    else
      formatted += formatted === "" ? String(segment) : `.${String(segment)}`;
  }
  return formatted;
}

function describeType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}
