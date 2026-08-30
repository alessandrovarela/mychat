import type { ReactElement, ReactNode } from "react";
import { Button } from "./Button.js";

/**
 * Pagination: where we are in a listing, and the two steps out of it.
 *
 * The sentence arrives already formatted ("Showing 1 to 12 of 48."): the
 * numbers, their order and the plural rules belong to the locale and to the
 * catalogue, never to this component. Same for the two button words, which is
 * why they are required props.
 *
 * The steps are buttons and not links: they change what is on screen without
 * changing the address, so there is nothing to open in a new tab.
 */

export interface PaginationProps {
  /** Already formatted by the caller: "Showing 1 to 12 of 48." */
  readonly label: ReactNode;
  readonly previousLabel: string;
  readonly nextLabel: string;
  readonly atStart?: boolean;
  readonly atEnd?: boolean;
  readonly onPrevious?: () => void;
  readonly onNext?: () => void;
}

export function Pagination({
  label,
  onPrevious,
  onNext,
  previousLabel,
  nextLabel,
  atStart = false,
  atEnd = false,
}: PaginationProps): ReactElement {
  return (
    <div className="mc-pagination">
      <p className="mc-pagination__count">{label}</p>
      <div className="mc-pagination__controls">
        <Button
          variant="secondary"
          icon="chevron-left"
          disabled={atStart}
          onClick={onPrevious}
        >
          {previousLabel}
        </Button>
        <Button
          variant="secondary"
          iconEnd="chevron-right"
          disabled={atEnd}
          onClick={onNext}
        >
          {nextLabel}
        </Button>
      </div>
    </div>
  );
}
