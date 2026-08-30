import type { FlowAction } from "./schema.js";

/**
 * Actions the execution engine of this version can actually run.
 *
 * The schema declares every action of the product's v0.1, but declaring a step
 * is not the same as being able to execute it. Keeping the executable set
 * separate is what lets validation refuse a flow the engine cannot run, at
 * write time, instead of discovering it half way through an execution.
 *
 * When the engine learns an action, add it here and the format needs no change.
 */
export const SUPPORTED_STEP_ACTIONS = [
  "reply_comment",
  "send_dm",
  "delay",
  "confirm_optin",
  "collect_email",
  "follow_gate",
] as const satisfies readonly FlowAction[];

export type SupportedStepAction = (typeof SUPPORTED_STEP_ACTIONS)[number];

export function isSupportedStepAction(
  action: FlowAction,
): action is SupportedStepAction {
  return (SUPPORTED_STEP_ACTIONS as readonly FlowAction[]).includes(action);
}
