import type { FlowDefinition, StepConfigValue } from "../engine/flow.js";
import type { ActiveAutomation, AutomationStep } from "./schema.js";

export interface BindingIssue {
  readonly code: "invalid_automation";
  readonly detail: string;
}

export type BindingResult =
  | { readonly ok: true; readonly definition: FlowDefinition }
  | { readonly ok: false; readonly issues: readonly BindingIssue[] };

function automationStepConfig(
  step: AutomationStep,
): Readonly<Record<string, StepConfigValue>> | undefined {
  const config: Record<string, StepConfigValue> = {};

  if (step.action === "send_dm") {
    /*
     * The additive message, translated part by part (REQ-229).
     *
     * The text is carried WHATEVER else the step declares, and that single
     * change is most of this task: the exclusive contract wrote `text: ""`
     * beside a file and beside a card, so the anchor case — a wording and a
     * PDF — reached the engine with the wording already thrown away, and no
     * later layer could put it back.
     *
     * The parts stay parts. Which of them become one card, which become a
     * second message, and what the platform is asked for is the engine's and
     * the adapter's business (ADR-003): this only has to hand over everything
     * the operator declared, and hand it over unmerged.
     */
    const message = step.message;
    const buttons = message.buttons ?? [];
    const links = message.links ?? [];

    if (message.text !== undefined) config["text"] = message.text;

    // The card is the BUTTONS' (REQ-287). Bound only when there is one, so a
    // delivery of pure links reaches the engine as what it is: a text, and
    // addresses that travel after it.
    //
    // Each button is handed over WHOLE, with the destination in the form the
    // operator declared it: an address, or the name of a file of the catalogue
    // (REQ-285). Neither is touched here. A name resolved into a URL at this
    // point would be resolved at the moment the definition is READ, and what
    // has to be true is that it is resolved in the instant before the send
    // (REQ-020) — which is the engine's, and is what makes a file deleted in
    // between fail loudly instead of travelling as a dead address.
    if (buttons.length > 0) {
      config["card"] = {
        ...(message.image !== undefined && { image: message.image }),
        ...(message.title !== undefined && { title: message.title }),
        ...(message.description !== undefined && {
          description: message.description,
        }),
        buttons: [...buttons],
      };
    }

    // Handed over in the declared order and unmerged, like every other part:
    // that each of these becomes a message of its own, after the card or the
    // text, is the engine's to carry out (REQ-286, REQ-288).
    if (links.length > 0) config["links"] = [...links];

    // Nothing is bound for an attachment, and the absence is the requirement
    // (REQ-284). `asset`, `delivery` and `asset_kind` were written here until
    // phase 3n; the format carries no attachment to write them from, and a file
    // reaches the contact as a card button's destination now (REQ-285).
  } else {
    if ("text" in step && step.text !== undefined) config["text"] = step.text;
    if ("ask" in step && step.ask !== undefined) config["text"] = step.ask;
    if ("quick_reply_label" in step && step.quick_reply_label !== undefined) {
      config["quick_reply_label"] = step.quick_reply_label;
    }
    if ("seconds" in step && step.seconds !== undefined)
      config["seconds"] = step.seconds;
    if ("on_timeout" in step && step.on_timeout !== undefined) {
      config["on_timeout"] = step.on_timeout;
    }
    // The deadline and the number of questions used to be bound here too. They
    // are settings of the instance since phase 3l (REQ-252, REQ-254) and reach
    // the engine as injected data instead of as step configuration, so there is
    // nothing left to copy out of the step.
  }

  return Object.keys(config).length === 0 ? undefined : config;
}

/** Captures the executable definition owned by one active v2 aggregate. */
export function bindActiveAutomation(
  automation: ActiveAutomation,
): BindingResult {
  return {
    ok: true,
    definition: {
      id: automation.id,
      steps: automation.steps.map((step, index) => {
        const config = automationStepConfig(step);
        return {
          id: step.id,
          type: step.action,
          ...(config !== undefined && { config }),
          transition:
            index === automation.steps.length - 1
              ? { kind: "end" as const }
              : {
                  kind: "goto" as const,
                  stepId: automation.steps[index + 1]?.id ?? "",
                },
        };
      }),
    },
  };
}
