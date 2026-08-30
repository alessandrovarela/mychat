import type { ButtonHTMLAttributes, ReactElement, ReactNode, Ref } from "react";
import { Icon, ICON_SIZE } from "./Icon.js";
import type { IconName } from "./Icon.js";

/**
 * Button: the one button of the system, in the five weights the screens use.
 *
 * Five weights and ONE size (REQ-268). The size axis is gone, and it is worth
 * saying why rather than leaving the absence to be read as an oversight: a
 * `size` property is a request every dense screen makes, and every screen that
 * made it produced a button no thumb could hit. Weight answers "how loud is
 * this action", and it is the only question a caller gets to answer here. How
 * big a target has to be is a question about hands, and the answer is
 * `--tap`, the same everywhere.
 *
 * `destructive` exists because two operations in this product cannot be undone
 * (deleting a flow, detaching an automation), and they must not sit at the same
 * weight as Edit. `removal` is the same family at a quieter weight, for taking
 * a part away that can be put back (a cover, a link, an attachment) or that
 * asks before it goes. `ghost` is what a row action uses, so a list of five
 * automations is not five blue rectangles.
 *
 * There is NO link weight, and the absence is REQ-276 rather than an oversight.
 * A link goes somewhere; a button does something. Underlined text drawn beside
 * a real button says "destination" to whoever reads it and carries no frame at
 * all, so nothing on screen says how big the target is: it was the hardest
 * thing on the page to hit with a thumb even while the rule below held its
 * height, because a height nobody can see is a height nobody aims at. What
 * navigates stays an `<a href>` and may wear this component's shape; what acts
 * is this component.
 *
 * `pending` replaces the leading glyph with the spinner and disables the
 * button WITHOUT emptying its label: a button whose word disappears while it
 * works is a button the operator cannot name to anyone. The pending word is a
 * different word ("Signing in" is not "Sign in"), so the caller passes it as
 * children, from the catalogue. This component knows no language.
 */

export type ButtonVariant =
  "primary" | "secondary" | "destructive" | "removal" | "ghost";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /**
   * `primary` the one commit per screen; `secondary` everything reversible;
   * `destructive` delete and detach, and only inside a confirmation;
   * `removal` takes a part away and can be undone, or opens the confirmation;
   * `ghost` actions inside a dense row or card.
   */
  readonly variant?: ButtonVariant;
  /** Leading glyph. Replaced by the spinner while `pending`. */
  readonly icon?: IconName;
  /** Trailing glyph, for an action that goes somewhere. */
  readonly iconEnd?: IconName;
  /** Shows the spinner and disables. Pass the pending word as children. */
  readonly pending?: boolean;
  readonly block?: boolean;
  readonly children?: ReactNode;
  /**
   * The button element itself, for a caller that has to PUT focus on it.
   *
   * `ButtonHTMLAttributes` carries no `ref`, so it is declared here and travels
   * with the rest of the attributes: in React 19 a ref is an ordinary prop, and
   * spreading it onto the element is all a function component has to do. The
   * catalogue uses it to move focus into a tile's confirmation the moment the
   * tile enters one (`src/web/components/AssetGrid.tsx`).
   */
  readonly ref?: Ref<HTMLButtonElement>;
}

export function Button({
  variant = "secondary",
  icon,
  iconEnd,
  pending = false,
  block = false,
  disabled = false,
  children,
  className = "",
  // Explicit, because the HTML default is `submit`: a bare <button> inside a
  // form submits it, which is how a Cancel beside a field ends up saving.
  type = "button",
  ...rest
}: ButtonProps): ReactElement {
  const classes = [
    "mc-btn",
    `mc-btn--${variant}`,
    block ? "mc-btn--block" : "",
    className,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <button
      type={type}
      className={classes}
      disabled={disabled || pending}
      {...rest}
    >
      {pending ? (
        <Icon
          name="loader-circle"
          size={ICON_SIZE.text}
          className="mc-btn__spinner"
        />
      ) : icon === undefined ? null : (
        <Icon name={icon} size={ICON_SIZE.text} />
      )}
      {children}
      {iconEnd === undefined || pending ? null : (
        <Icon name={iconEnd} size={ICON_SIZE.text} />
      )}
    </button>
  );
}
