import type { ReactElement, ReactNode } from "react";
import { Icon, ICON_SIZE } from "./Icon.js";
import type { IconName } from "./Icon.js";

/**
 * EmptyState: nothing stored yet, said properly.
 *
 * A fresh installation is empty for a while, so empty is a designed state and
 * not a gap in the screen (REQ-115). It says what is missing and offers the one
 * action that ends it, which is why `action` is a single slot and not a row of
 * buttons: an empty list has exactly one thing worth doing.
 *
 * The glyph is decoration beside a title that always renders, so it carries no
 * accessible name; `null` drops it entirely, which is what the panel's "nothing
 * recorded in this period" wants, since there is no action to offer there.
 */

export interface EmptyStateProps {
  readonly icon?: IconName | null;
  /** What is missing, from the catalogue. */
  readonly title: ReactNode;
  /** What to do about it. */
  readonly children?: ReactNode;
  /** The single action that ends the empty state. */
  readonly action?: ReactNode;
}

export function EmptyState({
  icon = "list",
  title,
  children,
  action,
}: EmptyStateProps): ReactElement {
  return (
    <div className="mc-empty">
      {icon === null ? null : (
        <span className="mc-empty__icon">
          <Icon name={icon} size={ICON_SIZE.display} />
        </span>
      )}
      <span className="mc-empty__title">{title}</span>
      {children === undefined ? null : (
        <p className="mc-empty__text">{children}</p>
      )}
      {action}
    </div>
  );
}
