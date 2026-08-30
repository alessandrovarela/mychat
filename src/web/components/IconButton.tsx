import type { ButtonHTMLAttributes, ReactElement, Ref } from "react";
import { Icon, ICON_SIZE } from "./Icon.js";
import type { IconName } from "./Icon.js";

/**
 * IconButton: a control whose only content is a glyph, so `label` is required.
 *
 * Required in the TYPE and not in a comment, which is REQ-116 enforced by the
 * compiler: a bare glyph names nothing, and a control with no accessible name
 * is invisible to anyone who is not looking at it. The same word becomes the
 * tooltip, so a sighted operator who hesitates over the glyph gets the answer
 * the screen reader already had.
 *
 * Used for closing a modal, removing a parameter row, and the overflow menu on
 * a card. Never for a primary action: those keep their words.
 *
 * One size, and a square one: `--tap` by `--tap` (REQ-268). A glyph names
 * nothing without its label, and a glyph the finger misses does not even do
 * that.
 */

export type IconButtonTone = "default" | "danger";

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  readonly icon: IconName;
  /** Accessible name and tooltip. From the catalogue, never from here. */
  readonly label: string;
  readonly tone?: IconButtonTone;
  /** Gives it a border and a surface, for when it stands alone on a page. */
  readonly bordered?: boolean;
  /**
   * The button element itself, for a caller that has to put focus BACK on it.
   *
   * `ButtonHTMLAttributes` carries no `ref`, so it is declared here and travels
   * with the rest of the attributes: in React 19 a ref is an ordinary prop, and
   * spreading it onto the element is all a function component has to do. The
   * casing uses it to return focus to the menu control when the drawer closes
   * (`src/web/shell.tsx`).
   */
  readonly ref?: Ref<HTMLButtonElement>;
}

export function IconButton({
  icon,
  label,
  tone = "default",
  bordered = false,
  className = "",
  type = "button",
  ...rest
}: IconButtonProps): ReactElement {
  const classes = [
    "mc-iconbtn",
    bordered ? "mc-iconbtn--bordered" : "",
    tone === "danger" ? "mc-iconbtn--danger" : "",
    className,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <button
      type={type}
      className={classes}
      aria-label={label}
      title={label}
      {...rest}
    >
      <Icon name={icon} size={ICON_SIZE.control} />
    </button>
  );
}
