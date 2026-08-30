import type { ReactElement, ReactNode } from "react";
import { Icon, ICON_SIZE } from "./Icon.js";

/**
 * PendingState: a read in progress, announced as a status (REQ-115).
 *
 * The sentence is what gets announced, and it stays in the DOM: a spinner alone
 * says something is happening to whoever can see it turning, and nothing at all
 * to anyone else. `aria-live="polite"` waits for a pause instead of cutting
 * across what is being read.
 *
 * `skeleton` draws placeholder rows under the sentence, for a list that is
 * loading into a shape the operator already knows. They are `aria-hidden`
 * because they are the shape of information, not information.
 */

export interface PendingStateProps {
  /** What is being read, from the catalogue. */
  readonly label: ReactNode;
  /** How many placeholder rows to draw under the label. 0 for none. */
  readonly skeleton?: number;
}

export function PendingState({
  label,
  skeleton = 0,
}: PendingStateProps): ReactElement {
  return (
    <div className="mc-stack" role="status" aria-live="polite">
      <p className="mc-pending">
        <Icon
          name="loader-circle"
          size={ICON_SIZE.text}
          className="mc-pending__spinner"
        />
        {label}
      </p>
      {skeleton > 0 ? (
        <div className="mc-stack" aria-hidden="true">
          {Array.from({ length: skeleton }, (_, index) => (
            <div key={index} className="mc-skeleton" />
          ))}
        </div>
      ) : null}
    </div>
  );
}
