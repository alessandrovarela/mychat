import type { ReactElement, ReactNode } from "react";

/**
 * Card: one record on screen, in the shape the handoff asks for: the thumbnail
 * the operator recognises, the name, the sentence saying what the record does,
 * discreet meta, the state as a marker, and the actions on the right.
 *
 * The same component carries an automation, a flow and a publication row, and
 * that is deliberate: on screen the three are the same kind of thing, and
 * giving each its own card is how an interface ends up with five facts glued
 * into one line.
 *
 * `interactive` is hover styling and nothing else. The card is NOT a control:
 * what a keyboard reaches inside it is the real button in `actions`, which is
 * why this component takes no `onClick` (REQ-116: a clickable div is reachable
 * by nobody who is not holding a mouse).
 */

export interface CardProps {
  /** Thumbnail or glyph, rendered in a fixed square. */
  readonly media?: ReactNode;
  readonly title: ReactNode;
  /** A StatusBadge, beside the title. */
  readonly badge?: ReactNode;
  /** What this record does, in words, already composed by the caller. */
  readonly sentence?: ReactNode;
  /** Discreet facts: date, identifier, reach. One entry per fact. */
  readonly meta?: readonly ReactNode[];
  /** Buttons on the right. Keep destructive ones behind a menu. */
  readonly actions?: ReactNode;
  readonly interactive?: boolean;
  readonly selected?: boolean;
  /** Sunken surface, no shadow, for a card nested inside a panel. */
  readonly muted?: boolean;
  /** Element to render. Use `"li"` inside a list. */
  readonly as?: "div" | "li" | "article";
  readonly className?: string;
  readonly children?: ReactNode;
}

export function Card({
  media,
  title,
  badge,
  sentence,
  meta = [],
  actions,
  interactive = false,
  selected = false,
  muted = false,
  as: Tag = "div",
  className = "",
  children,
}: CardProps): ReactElement {
  const classes = [
    "mc-card",
    interactive ? "mc-card--interactive" : "",
    selected ? "mc-card--selected" : "",
    muted ? "mc-card--muted" : "",
    className,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <Tag className={classes}>
      {media === undefined ? null : (
        <div className="mc-card__media">{media}</div>
      )}
      <div className="mc-card__body">
        <div className="mc-card__head">
          <span className="mc-card__title">{title}</span>
          {badge}
        </div>
        {sentence === undefined ? null : (
          <div className="mc-card__sentence">{sentence}</div>
        )}
        {meta.length === 0 ? null : (
          <div className="mc-card__meta">
            {meta.map((entry, index) => (
              // The index is the key because a fact has no identity of its own:
              // it is a date or a count, and two of them can read the same.
              <span key={index}>{entry}</span>
            ))}
          </div>
        )}
        {children}
      </div>
      {actions === undefined ? null : (
        <div className="mc-card__actions">{actions}</div>
      )}
    </Tag>
  );
}
