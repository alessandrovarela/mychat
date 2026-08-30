import type { AttributeValue } from "./ports.js";

/**
 * The structural view of a flow that the state machine needs to decide a next
 * step. The authoritative versioned schema lives in `src/flows`; the engine
 * keeps its own minimal types so it can be typechecked and tested on its own
 * (ADR-003). The two are reconciled when the engine starts executing steps.
 */

export type StepId = string;

/** Identity and words of one ordered card button, whatever it opens. */
interface StepCardButtonBase {
  readonly id: string;
  readonly label: string;
}

/** A button that opens an address the operator typed. */
export interface StepCardWebButton extends StepCardButtonBase {
  readonly url: string;
}

/**
 * A button that opens a FILE of the catalogue (REQ-285).
 *
 * The asset NAME, exactly as `StepCard.image` carries one, and never the
 * address it resolves to. A file reaches the contact as a card button's
 * destination now, served from our own CDN, so what the button opens is a
 * resource of this installation rather than somewhere on the web — and a
 * resource is named, not spelled out.
 *
 * The reason the name travels instead of the URL is that the URL is an ANSWER
 * and this is the QUESTION. Resolution happens in the instant before the send
 * (REQ-020), through the same port and with the same consequence the cover
 * already has: a file deleted since the automation was written makes the send
 * fail loudly instead of handing the contact a button that opens nothing.
 */
export interface StepCardAssetButton extends StepCardButtonBase {
  readonly asset: string;
}

/**
 * One ordered destination carried by a card step: an address, or a file.
 *
 * A UNION and not two optional fields, so "a button opens exactly one thing"
 * is held by the type rather than by a rule somebody has to remember. Which of
 * the two it is, is also what the editor reads back when it reopens an
 * automation, so the operator's choice survives the round trip.
 */
export type StepCardButton = StepCardWebButton | StepCardAssetButton;

/** Card intent after schema binding and before resource resolution. */
export interface StepCard {
  /** An asset name, resolved through the engine port only at execution time. */
  readonly image?: string;
  readonly title?: string;
  readonly description?: string;
  readonly buttons: readonly StepCardButton[];
}

/**
 * A value a step acts on: a scalar, wordings, or one bound card.
 *
 * The composite shapes live here rather than in `AttributeValue` on purpose:
 * an attribute belongs to a contact and is written to a store, while these are
 * declarations a step carries. Widening the attribute would make a card or
 * several wordings storable as somebody's e-mail address.
 */
export type StepConfigValue = AttributeValue | readonly string[] | StepCard;

/**
 * Where a step hands control to. Ending is explicit: a step that simply ran out
 * of successors would be indistinguishable from a step whose target went
 * missing, and those two deserve different answers.
 */
export type Transition =
  | { readonly kind: "goto"; readonly stepId: StepId }
  | {
      readonly kind: "branch";
      readonly attribute: string;
      readonly equals: AttributeValue;
      readonly ifTrue: StepId;
      readonly ifFalse: StepId;
    }
  | { readonly kind: "end" };

export interface FlowStep {
  readonly id: StepId;
  /** Step kind (`send_message`, `reply_comment`, `delay`, ...). */
  readonly type: string;
  /**
   * Plain values the step acts on, already resolved by the caller from the
   * automation's parameters. Deliberately untyped beyond `StepConfigValue`: the
   * engine must not learn the shape of any particular step kind's payload,
   * or every new step type becomes an engine change.
   */
  readonly config?: Readonly<Record<string, StepConfigValue>>;
  readonly transition: Transition;
}

export interface FlowDefinition {
  readonly id: string;
  readonly steps: readonly FlowStep[];
}

/** Plain snapshot of one run. No identity, no persistence concern. */
export interface ExecutionState {
  readonly flowId: string;
  readonly contactId: string;
  /** `null` before the first step has been decided. */
  readonly currentStepId: StepId | null;
}
