import type { ReactElement, ReactNode, TextareaHTMLAttributes } from "react";
import { Icon, ICON_SIZE } from "./Icon.js";

/**
 * TextArea, with refusals rendered directly under the field, each with the
 * path the instance named.
 *
 * No mode of this component carries a height. The floor is one rule of the
 * sheet for every multi-line box of the interface (REQ-281), and how tall a
 * given box opens is the caller's own `rows`.
 *
 * Several refusals at once is the common case and not the exception, so
 * `issues` is a list and never a string. The list is wired into
 * `aria-describedby` and announced as an alert, because it appears in reaction
 * to something the operator just did.
 *
 * `issuesTitle` travels with `issues` in the type: the line above the refusals
 * ("the definition was refused, so nothing was written") is a sentence, and a
 * sentence belongs to the catalogue.
 */

export interface DefinitionIssue {
  /** Field path inside the definition. */
  readonly path: string;
  readonly message: string;
}

interface TextAreaBase {
  /** Required: the label points at it. */
  readonly id: string;
  readonly label: ReactNode;
  /** What the option is FOR, in one line. Rendered under the label, as in
   * `Field`, and for the same reason (REQ-267). */
  readonly tip?: ReactNode;
  readonly hint?: ReactNode;
  /**
   * One refusal about the whole field, rendered as `Field` renders its own and
   * wired into the description the same way (REQ-149).
   *
   * Beside `issues` and not instead of it, because the two are different facts:
   * `issues` is a list of refused PATHS inside a document, which is what a JSON
   * editor gets back, and this is the single sentence a plain text field gets
   * when the instance refused the value it holds. Without it a refusal about a
   * textarea could only be drawn somewhere else on the page, which is exactly
   * the defect REQ-149 exists to prevent.
   */
  readonly error?: ReactNode;
  /** Controls beside the label: format, copy, schema version. */
  readonly toolbar?: ReactNode;
}

type TextAreaIssues =
  | {
      readonly issues: readonly DefinitionIssue[];
      /** The line above the refusals, from the catalogue. */
      readonly issuesTitle: ReactNode;
    }
  | { readonly issues?: undefined; readonly issuesTitle?: undefined };

export type TextAreaProps = TextAreaBase &
  TextAreaIssues &
  Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "id">;

export function TextArea({
  id,
  label,
  tip,
  hint,
  error,
  issues = [],
  issuesTitle,
  toolbar,
  className = "",
  "aria-describedby": fieldDescribedBy,
  "aria-invalid": fieldInvalid,
  ...rest
}: TextAreaProps): ReactElement {
  // A surrounding Field can render another hint for this same control. Its
  // namespace is distinct so composing aria-describedby preserves both.
  const hintId = hint === undefined ? undefined : `${id}-textarea-hint`;
  const tipId = tip === undefined ? undefined : `${id}-textarea-tip`;
  const issuesId = issues.length === 0 ? undefined : `${id}-issues`;
  const errorId = error === undefined ? undefined : `${id}-error`;
  // The two descriptions are JOINED, never chosen between (REQ-185). The
  // refusals and the hint below belong to this component; a surrounding `Field`
  // clones ITS error and hint onto whatever it nests, and it cannot know about
  // the ids composed here. Taken out of `rest` for that reason: spread last it
  // would overwrite this list, and the paths the instance refused would stop
  // being announced exactly when the field is also refused. Deduplicated,
  // because a screen that pointed at one of these ids itself would otherwise
  // have it read out twice.
  const describedBy =
    [
      ...new Set([
        issuesId,
        // Before the tip and the hint, because it is the thing that changed:
        // the same order `Field` describes its own control in.
        errorId,
        tipId,
        hintId,
        ...(fieldDescribedBy?.split(/\s+/) ?? []),
      ]),
    ]
      .filter(Boolean)
      .join(" ") || undefined;

  return (
    <div className="mc-field">
      <div className="mc-field__head">
        <label className="mc-field__label" htmlFor={id}>
          {label}
        </label>
        {toolbar}
      </div>
      {tip === undefined ? null : (
        <p className="mc-field__tip" id={tipId}>
          {tip}
        </p>
      )}
      <textarea
        id={id}
        spellCheck={false}
        // Taken out of `rest` for the same reason as the two attributes below,
        // and with the opposite resolution (REQ-198): spread last, a caller's
        // `className` REPLACED this list and the control lost its own styling
        // silently. A class from outside adds to the component's, never instead
        // of them, which is what `Select` already did and these did not.
        className={[
          "mc-input",
          "mc-textarea",
          issues.length === 0 && error === undefined ? "" : "mc-input--invalid",
          className,
        ]
          .filter(Boolean)
          .join(" ")}
        // The field's answer only where this component has none of its own: a
        // definition refused HERE is invalid whatever the field around it
        // thinks, and left in `rest` the field's `undefined` would erase it.
        aria-invalid={
          issues.length === 0 && error === undefined ? fieldInvalid : true
        }
        aria-describedby={describedBy}
        {...rest}
      />
      {error === undefined ? null : (
        <p className="mc-field__error" id={errorId}>
          <Icon name="circle-alert" size={ICON_SIZE.text} />
          <span>{error}</span>
        </p>
      )}
      {issues.length === 0 ? null : (
        <div className="mc-notice mc-notice--error" id={issuesId} role="alert">
          <span className="mc-notice__icon">
            <Icon name="circle-alert" size={ICON_SIZE.control} />
          </span>
          <div className="mc-notice__body">
            <span className="mc-notice__title">{issuesTitle}</span>
            <ul className="mc-notice__list">
              {issues.map((issue, index) => (
                // The index is the key: the same path can be refused twice,
                // for two different reasons, in the same answer.
                <li key={index}>
                  {/* Same list, same rule as Notice: the colon is a stylesheet
                      matter, not a string in a component. */}
                  <code>{issue.path}</code>
                  <span>{issue.message}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
      {hint === undefined ? null : (
        <p className="mc-field__hint" id={hintId}>
          {hint}
        </p>
      )}
    </div>
  );
}
