import type { ExecutionFailureReason } from "./execute.js";
import type {
  ExecutionState,
  FlowDefinition,
  FlowStep,
  StepId,
  Transition,
} from "./flow.js";
import type { Clock, ContactAttributes } from "./ports.js";

/**
 * The pure half of the state machine: it decides what should happen next and
 * performs nothing. Executing the decided step belongs to Phase 1, behind the
 * ports in `./ports`. Keeping the two apart is what lets every branch of the
 * decision be covered with plain objects, no network and no store.
 */

/** Plain data the decision reads. Everything is already resolved by the caller. */
export interface DecisionInput {
  readonly flow: FlowDefinition;
  readonly execution: ExecutionState;
  /**
   * Contact attributes already read through `ContactRepo` and handed over as
   * plain data: the decision itself must never reach out for anything.
   */
  readonly attributes: ContactAttributes;
}

export type Decision =
  | {
      readonly kind: "run-step";
      readonly step: FlowStep;
      readonly decidedAt: Date;
    }
  | { readonly kind: "finished"; readonly decidedAt: Date }
  | {
      /**
       * A code and never a sentence (REQ-171). `runExecution` returns this
       * reason as the run's own, the trail stores it, and the panel translates
       * it; a phrase written here would travel that whole way and be dropped at
       * the end, leaving an operator with a failure and no cause. The
       * identifier that made the decision fail travels beside it.
       *
       * The type comes from `./execute.js` and the import is type-only, so
       * nothing of that module is loaded at run time and this one stays what it
       * is: a decision made out of plain data.
       */
      readonly kind: "failed";
      readonly reason: ExecutionFailureReason;
      readonly detail?: string;
      readonly decidedAt: Date;
    };

/**
 * Decides the next step of an execution. `clock` is the only port involved,
 * and it is injected so the answer is reproducible in a test.
 */
export function decideNextStep(input: DecisionInput, clock: Clock): Decision {
  const { flow, execution, attributes } = input;
  const decidedAt = clock.now();

  if (execution.flowId !== flow.id) {
    return {
      kind: "failed",
      reason: "execution_belongs_to_another_flow",
      detail: execution.flowId,
      decidedAt,
    };
  }

  if (execution.currentStepId === null) {
    const first = flow.steps[0];
    return first === undefined
      ? { kind: "finished", decidedAt }
      : { kind: "run-step", step: first, decidedAt };
  }

  const current = findStep(flow, execution.currentStepId);
  if (current === undefined) {
    return {
      kind: "failed",
      reason: "current_step_not_declared",
      detail: execution.currentStepId,
      decidedAt,
    };
  }

  const targetId = resolveTransition(current.transition, attributes);
  if (targetId === null) {
    return { kind: "finished", decidedAt };
  }

  const target = findStep(flow, targetId);
  if (target === undefined) {
    return {
      kind: "failed",
      reason: "transition_target_not_declared",
      detail: targetId,
      decidedAt,
    };
  }

  return { kind: "run-step", step: target, decidedAt };
}

/** Resolves a transition to a target step, or `null` when the flow ends here. */
function resolveTransition(
  transition: Transition,
  attributes: ContactAttributes,
): StepId | null {
  switch (transition.kind) {
    case "end":
      return null;
    case "goto":
      return transition.stepId;
    case "branch":
      return attributes[transition.attribute] === transition.equals
        ? transition.ifTrue
        : transition.ifFalse;
  }
}

function findStep(flow: FlowDefinition, stepId: StepId): FlowStep | undefined {
  return flow.steps.find((step) => step.id === stepId);
}
