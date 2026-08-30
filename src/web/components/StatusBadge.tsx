import type { ReactElement, ReactNode } from "react";

/**
 * StatusBadge: state as a marker, and the word inside it is not optional.
 *
 * REQ-038 and the handoff's restriction 4.2 say the same thing from different
 * ends: colour is never the only carrier of information. So this component has
 * no icon-only and no dot-only mode. The dot is decoration in front of a word
 * that always renders, and `children` is required for exactly that reason.
 */

export type BadgeState =
  "neutral" | "active" | "attention" | "critical" | "info";

export interface StatusBadgeProps {
  /**
   * `active` in force; `neutral` off; `attention` near a ceiling;
   * `critical` at a ceiling; `info` a neutral fact worth marking.
   */
  readonly state?: BadgeState;
  /** The word. Always present: never render a badge with no text. */
  readonly children: ReactNode;
  readonly dot?: boolean;
  /** Square and monospace, for a machine value such as a media type. */
  readonly mono?: boolean;
  /** So another element can point its `aria-labelledby` at this word. */
  readonly id?: string;
  readonly className?: string;
}

export function StatusBadge({
  state = "neutral",
  children,
  dot = true,
  mono = false,
  id,
  className = "",
}: StatusBadgeProps): ReactElement {
  const classes = [
    "mc-badge",
    `mc-badge--${state}`,
    mono ? "mc-badge--square" : "",
    className,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <span className={classes} id={id}>
      {dot ? <span className="mc-badge__dot" aria-hidden="true" /> : null}
      {children}
    </span>
  );
}
