import { useEffect, useRef } from "react";
import type { ReactElement, ReactNode } from "react";
import { Icon, ICON_SIZE } from "./Icon.js";
import type { IconName } from "./Icon.js";

/**
 * Notice: a message about what just happened, in one of four natures.
 *
 * The four exist because the login screen answers four different ways and, in
 * the interface this phase replaces, all four come out as the same paragraph: a
 * refused password is recoverable right now, a throttled origin has to wait,
 * an unreachable instance is nobody's typing mistake (REQ-034, REQ-117). Nature
 * plus glyph plus title separates them, and the sentence stays long because the
 * catalogue writes long sentences on purpose.
 *
 * `role` defaults BY NATURE: a refusal and a degraded path announce as alerts,
 * a confirmation and a piece of context as status. That default is what the
 * screens of Phase 3 already do by hand with `role="alert"`, kept so their
 * tests keep finding what they look for.
 *
 * `focus` was the system's answer to REQ-150, and it exists because of a defect
 * an operator met on a real screen: the confirmation of a write is born at the
 * TOP of the page and the control that produced it sits at the END of a form
 * nearly a thousand lines long. Announced, the message reaches a screen reader
 * wherever it is; SEEN, it reaches nobody, because the page does not move. So
 * the sentence takes the focus, which scrolls it into view, puts the caret in
 * front of it and makes the next Tab continue from the answer rather than from
 * the button that is now stale.
 *
 * The move happens on MOUNT, which is what makes it repeatable: the screens
 * clear their confirmation before every write, so the next one is a new element
 * and takes the focus again. A notice left mounted across two writes would move
 * nothing the second time, and that is the caller's contract with this prop.
 *
 * SINCE REQ-312, no confirmation uses it. This comment used to go on to argue
 * that a message which removes itself is a message somebody reading slowly
 * never finishes, and the argument was answered rather than overruled: the
 * answer to a write is now a `Toast`, whose time on screen is derived from the
 * length of the sentence with a floor sized for a screen reader, which stops
 * running while the pointer or the caret is on it, and which carries a close
 * button. What that leaves `focus` for is the notice a screen puts up when it
 * has taken the place of the whole page (`SessionExpiredNotice`), where the
 * message IS the screen and there is nothing else to move the caret to.
 *
 * `focus` is NOT for a refusal that names a field: that one is drawn under the
 * field, and the caret goes to the FIELD (REQ-310, REQ-311).
 */

export type NoticeNature = "info" | "success" | "warning" | "error";

const GLYPH: Readonly<Record<NoticeNature, IconName>> = {
  info: "info",
  success: "circle-check",
  warning: "triangle-alert",
  error: "circle-alert",
};

export interface NoticeIssue {
  /** Field path inside the refused document, when the refusal names one. */
  readonly path?: string;
  readonly message: string;
}

export interface NoticeProps {
  /** `error` refusals, `warning` degraded paths, `success` confirmations,
   * `info` context. */
  readonly nature?: NoticeNature;
  /** Short line above the sentence. Optional: many notices are one sentence. */
  readonly title?: ReactNode;
  /** The sentence, from the catalogue. Long on purpose. */
  readonly children?: ReactNode;
  /** Buttons: try again, go to the access screen. */
  readonly actions?: ReactNode;
  /** Several refusals at once, each with its field path. */
  readonly issues?: readonly NoticeIssue[];
  /** Overrides the default derived from the nature. */
  readonly role?: "alert" | "status" | "none";
  /**
   * Takes the focus when it appears (REQ-150). For the answer to a control the
   * operator just pressed, never for a message that was already on the page.
   */
  readonly focus?: boolean;
  readonly className?: string;
}

export function Notice({
  nature = "info",
  title,
  children,
  actions,
  issues = [],
  role,
  focus = false,
  className = "",
}: NoticeProps): ReactElement {
  const resolvedRole =
    role ?? (nature === "error" || nature === "warning" ? "alert" : "status");
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (focus) {
      box.current?.focus();
    }
  }, [focus]);

  return (
    <div
      className={["mc-notice", `mc-notice--${nature}`, className]
        .filter(Boolean)
        .join(" ")}
      role={resolvedRole}
      // Focusable programmatically and not by Tab, exactly as the dialog is:
      // the answer is where focus is PUT, and Tab then continues from it into
      // the page. A notice nobody asked to focus stays out of the tab order.
      tabIndex={focus ? -1 : undefined}
      ref={box}
    >
      <span className="mc-notice__icon">
        <Icon name={GLYPH[nature]} size={ICON_SIZE.control} />
      </span>
      <div className="mc-notice__body">
        {title === undefined ? null : (
          <span className="mc-notice__title">{title}</span>
        )}
        {children === undefined ? null : <p>{children}</p>}
        {issues.length === 0 ? null : (
          <ul className="mc-notice__list">
            {issues.map((issue, index) => (
              // The index is the key because a refusal has no identity: the
              // same path can be refused twice for two different reasons.
              <li key={index}>
                {issue.path === undefined ? (
                  issue.message
                ) : (
                  <>
                    {/* The colon between the path and the reason is drawn by
                        the stylesheet: punctuation written into the markup is
                        text that went through no catalogue (REQ-074). */}
                    <code>{issue.path}</code>
                    <span>{issue.message}</span>
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
        {actions === undefined ? null : (
          <div className="mc-notice__actions">{actions}</div>
        )}
      </div>
    </div>
  );
}
