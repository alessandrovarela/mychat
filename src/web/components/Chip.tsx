import type { ReactElement, ReactNode } from "react";
import { Icon, ICON_SIZE } from "./Icon.js";

/**
 * Chip: a keyword, as a removable token.
 *
 * Keywords are typed as one comma-separated string in the interface this phase
 * replaces, and the handoff asks for tokens instead, with the match mode beside
 * them. So the chip is the unit: monospace when it stands for something the
 * operator typed verbatim, and removable unless it is only being displayed.
 *
 * The removal is a real `<button>` and not a clickable span, which is what
 * makes it reachable by Tab and operable by Enter and Space with no keyboard
 * code of our own (REQ-116).
 */

export type ChipTone = "neutral" | "accent";

interface ChipBase {
  readonly children: ReactNode;
  readonly tone?: ChipTone;
  /** Monospace, for text the operator typed verbatim: keywords, identifiers. */
  readonly mono?: boolean;
  readonly className?: string;
}

/**
 * Removable and named, or neither.
 *
 * A union rather than two optional props, so the compiler refuses a remove
 * button with no accessible name: `removeLabel` is what a screen reader
 * announces, and "button" alone does not say which word is about to go.
 */
type ChipRemoval =
  | {
      readonly onRemove: () => void;
      /** Names the word being removed, from the catalogue. */
      readonly removeLabel: string;
    }
  | { readonly onRemove?: undefined; readonly removeLabel?: undefined };

export type ChipProps = ChipBase & ChipRemoval;

export function Chip({
  children,
  onRemove,
  removeLabel,
  tone = "neutral",
  mono = false,
  className = "",
}: ChipProps): ReactElement {
  const classes = [
    "mc-chip",
    tone === "accent" ? "mc-chip--accent" : "",
    mono ? "mc-chip--code" : "",
    onRemove === undefined ? "mc-chip--static" : "",
    className,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <span className={classes}>
      <span className="mc-chip__label">{children}</span>
      {onRemove === undefined ? null : (
        <button
          type="button"
          className="mc-chip__remove"
          aria-label={removeLabel}
          title={removeLabel}
          onClick={onRemove}
        >
          <Icon name="x" size={ICON_SIZE.chip} />
        </button>
      )}
    </span>
  );
}
