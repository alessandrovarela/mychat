import type { AnchorHTMLAttributes, ReactElement, ReactNode, Ref } from "react";
import { Icon, ICON_SIZE } from "./Icon.js";
import type { IconName } from "./Icon.js";
import type { ButtonVariant } from "./Button.js";

export interface ButtonLinkProps extends Omit<
  AnchorHTMLAttributes<HTMLAnchorElement>,
  "href"
> {
  /** A destination is mandatory: a link that goes nowhere is an action. */
  readonly href: string;
  readonly variant?: ButtonVariant;
  readonly icon?: IconName;
  readonly iconEnd?: IconName;
  readonly block?: boolean;
  readonly children?: ReactNode;
  readonly ref?: Ref<HTMLAnchorElement>;
}

/** A real destination wearing the same visible shape and tap floor as Button. */
export function ButtonLink({
  href,
  variant = "secondary",
  icon,
  iconEnd,
  block = false,
  children,
  className = "",
  ...rest
}: ButtonLinkProps): ReactElement {
  const classes = [
    "mc-btn",
    `mc-btn--${variant}`,
    block ? "mc-btn--block" : "",
    className,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <a href={href} className={classes} {...rest}>
      {icon === undefined ? null : <Icon name={icon} size={ICON_SIZE.text} />}
      {children}
      {iconEnd === undefined ? null : (
        <Icon name={iconEnd} size={ICON_SIZE.text} />
      )}
    </a>
  );
}
