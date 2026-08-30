import type { AutomationStep, AutomationTrigger } from "./schema.js";

export type TriggerType = AutomationTrigger["type"];

export const TRIGGER_TYPES = [
  "comment",
  "direct_message",
] as const satisfies readonly TriggerType[];

/**
 * Whether this trigger cannot execute this step, because no comment exists to
 * reply to (REQ-134).
 *
 * Stated once, per step, because the rule has to NAME the step it refuses and
 * the caller is the loop that knows the position. It used to answer with the
 * offending steps as a list while `validation.ts` carried a second copy of the
 * same condition inline: two sources for one rule, which is how the orphan
 * module of REQ-140 came about. The list form had no caller at all.
 */
export function isStepIncompatibleWith(
  step: AutomationStep,
  trigger: TriggerType,
): boolean {
  return trigger === "direct_message" && step.action === "reply_comment";
}
