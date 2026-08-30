import { useEffect, useId, useRef } from "react";
import type { ReactElement, ReactNode } from "react";
import { IconButton } from "./IconButton.js";

/**
 * Modal: a dialog over the screen. In this product it carries the publication
 * grid, opened on demand from the automation form (REQ-113), and it is the
 * frame ConfirmDialog is built on.
 *
 * Four keyboard facts, and none of them costs a dependency:
 *
 *   - Escape closes. The listener is on the window, so it works wherever focus
 *     happens to be when the dialog opens.
 *   - focus moves INTO the dialog when it opens. Without that, the dialog is
 *     rendered where the component sits in the tree and Tab would walk the
 *     whole page behind it first, which is how a keyboard operator ends up
 *     typing into a form that is covered.
 *   - focus goes BACK to whatever had it when the dialog closes, by any of the
 *     ways it closes, which is the same contract the shell's drawer keeps
 *     (REQ-303). Dropped on `body` instead, the operator is returned to the top
 *     of a page they were in the middle of: the control that opened the dialog
 *     is no longer focused and, on a long form, no longer even on screen.
 *   - the close control is a real button with a required name.
 *
 * There is no focus trap: a trap is a library, and the product takes no new
 * dependency. What is here is the part that decides whether the dialog can be
 * used at all without a mouse (REQ-116).
 */

export type ModalSize = "sm" | "md" | "lg";

interface ModalBase {
  readonly open?: boolean;
  readonly title: ReactNode;
  /** One sentence under the title, saying what the dialog is for. */
  readonly lead?: ReactNode;
  /**
   * The lead is DRAWN on the desktop layout only, and stays in the document
   * on every one (REQ-335).
   *
   * For a lead that explains rather than instructs: on a handset the sentence
   * costs the vertical space the dialog's own content needs, and the operator
   * asked for that space back. It is taken out of the PICTURE and not out of
   * the document, because the cost being paid is pixels and a screen reader
   * pays none: hiding it with `display: none` would take the sentence from the
   * one operator who cannot see what it describes. The stylesheet decides at
   * which width, and it decides it once.
   */
  readonly leadWideOnly?: boolean;
  readonly size?: ModalSize;
  /** Footer row, right aligned. */
  readonly footer?: ReactNode;
  readonly children?: ReactNode;
}

/**
 * Where the way out IS, stated in the type, because there are three answers and
 * two of them would be a bug if they were the same.
 *
 *   - `onClose` with `closeLabel`: the way out is the X in the head, and it is
 *     named, because a close control with no accessible name is a glyph nobody
 *     can reach on purpose.
 *   - `onClose` without `closeLabel`: the head carries no X, and the way out is
 *     a button the caller puts in the FOOTER, beside the action (REQ-304). The
 *     footer stops being optional here, because the alternative is a dialog
 *     with no visible exit at all.
 *   - neither: nothing closes it, and the veil and Escape do nothing either.
 */
type ModalClose =
  | { readonly onClose: () => void; readonly closeLabel: string }
  | {
      readonly onClose: () => void;
      readonly closeLabel?: undefined;
      readonly footer: ReactNode;
    }
  | { readonly onClose?: undefined; readonly closeLabel?: undefined };

export type ModalProps = ModalBase & ModalClose;

export function Modal({
  open = true,
  title,
  lead,
  leadWideOnly = false,
  size = "lg",
  onClose,
  closeLabel,
  footer,
  children,
}: ModalProps): ReactElement | null {
  const titleId = useId();
  const dialog = useRef<HTMLDivElement>(null);
  /** What had focus when the dialog opened, and gets it back when it goes. */
  const opener = useRef<Element | null>(null);

  useEffect(() => {
    if (!open || onClose === undefined) {
      return undefined;
    }

    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        onClose();
      }
    };

    window.addEventListener("keydown", onKey);
    return (): void => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  useEffect(() => {
    if (!open) {
      return undefined;
    }

    opener.current = document.activeElement;
    dialog.current?.focus();

    return (): void => {
      const back = opener.current;
      opener.current = null;

      // Only if it is still THERE. A dialog often closes because the record its
      // control belonged to is gone (a row deleted from its own confirmation),
      // and focus put on a detached node lands on `body` all the same.
      if (back instanceof HTMLElement && back.isConnected) {
        back.focus();
      }
    };
  }, [open]);

  if (!open) {
    return null;
  }

  return (
    <div
      className="mc-overlay"
      // `mousedown` and not `click`: a click that STARTED inside the dialog and
      // ended on the overlay (a drag while selecting text) would otherwise
      // close the dialog and discard what was being read.
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose?.();
        }
      }}
    >
      <div
        className={`mc-modal mc-modal--${size}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        // Focusable programmatically, not by Tab: the dialog is where focus is
        // put when it opens, and then Tab continues from here into its own
        // controls.
        tabIndex={-1}
        ref={dialog}
      >
        <div className="mc-modal__head">
          <div className="mc-modal__titles">
            <h2 className="mc-modal__title" id={titleId}>
              {title}
            </h2>
            {lead === undefined ? null : (
              <p
                className={`mc-modal__lead${leadWideOnly ? " mc-modal__lead--wide" : ""}`}
              >
                {lead}
              </p>
            )}
          </div>
          {/* The X only where the props type put it: named AND closable.
              Without the word the way out is the caller's, in the footer, and
              nothing is drawn here. Destructuring a union loses the
              correlation, so it is restated. */}
          {onClose === undefined || closeLabel === undefined ? null : (
            <IconButton icon="x" label={closeLabel} onClick={onClose} />
          )}
        </div>
        <div className="mc-modal__body">{children}</div>
        {footer === undefined ? null : (
          <div className="mc-modal__foot">{footer}</div>
        )}
      </div>
    </div>
  );
}
