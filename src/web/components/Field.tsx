import { cloneElement, isValidElement } from "react";
import type { InputHTMLAttributes, ReactElement, ReactNode } from "react";
import { Icon, ICON_SIZE } from "./Icon.js";
import type { IconName } from "./Icon.js";
import type { LengthAdviceNature } from "./length-advice.js";

/**
 * Field: label, tip, control, error, advice, hint, in that order and always
 * wired together.
 *
 * The label is a real `<label for>` and never a placeholder: the tests query by
 * role and accessible name, which is what REQ-116 rests on, and a placeholder
 * that vanishes on focus is not a label. The hint sits under the field rather
 * than beside it because these hints are whole sentences, in two languages, and
 * the Portuguese one runs longer.
 *
 * The TIP is a second sentence with a different job and therefore a different
 * place: it says what the option is FOR, in the operator's words, and it is
 * read BEFORE the control is touched, so it sits under the label (REQ-267). A
 * hint reports on the answer (a ceiling, a format, what happens when the upload
 * finishes) and belongs under the field, where the answer is. Written into one
 * slot the two would take turns being in the wrong place.
 *
 * A field MARKED optional names its control from two parts instead of from the
 * label's text (REQ-148): the marker is a second word and has to be announced
 * as one, and the only thing separating it on screen is punctuation the
 * stylesheet draws, which no accessible name is built from.
 *
 * `error` also sets `aria-invalid` and joins the message into
 * `aria-describedby`, so the refusal is announced with the field instead of
 * floating in a distant paragraph, which is exactly the defect the handoff
 * reports on the flows screen. The error comes BEFORE the hint in the
 * description because it is the thing that changed.
 *
 * `advice` is the layer that speaks WHILE the text is being typed (REQ-307,
 * REQ-308), which is what separates it from `error`: an error is what came back
 * from a save that was refused, and an advice is what is going to happen if
 * this text is saved as it stands. It sits under the control, where the answer
 * is, and it is announced as it appears, because a message that comes and goes
 * with the keystrokes is a message nobody hears otherwise.
 *
 * Pass another control as `children` (a Select, a TextArea, a KeywordField) to
 * reuse the label wiring, giving that control the same `id`. That control is
 * handed the SAME description and the same `aria-invalid` the field's own input
 * would get (REQ-149): without it the refusal is drawn on the screen and exists
 * for nobody who is not looking at it.
 */

/**
 * One advice under the control: what nature it is, and the sentence saying so.
 *
 * The two travel together because neither is worth anything alone. The nature
 * decides the colour and the glyph, and the colour is never the only carrier of
 * the difference (the design system's rule 4.2): a prediction drawn in the
 * refusal's red and worded like the refusal is a refusal, whatever the field
 * ends up storing.
 */
export interface FieldAdvice {
  readonly nature: LengthAdviceNature;
  /** From the catalogue, like every word a component renders. */
  readonly message: ReactNode;
}

/**
 * The mark each nature carries beside its sentence.
 *
 * The refusal to come takes the same glyph the field's own refusal takes, on
 * purpose: it is the same event, said before it happens. The prediction takes
 * the neutral one, because an alert glyph would put the error's face on a text
 * the platform is going to accept.
 */
const ADVICE_GLYPHS: Readonly<Record<LengthAdviceNature, IconName>> = {
  limit: "circle-alert",
  truncation: "info",
};

interface FieldBase {
  /** Required: it is what ties the label, the hint and the error together. */
  readonly id: string;
  readonly label: ReactNode;
  /** What the option is FOR, in one line. Rendered under the label. */
  readonly tip?: ReactNode;
  /** A whole sentence is expected. Rendered under the control. */
  readonly hint?: ReactNode;
  /** Sets `aria-invalid` and renders beside the field, never far from it. */
  readonly error?: ReactNode;
  /**
   * What the platform is going to do to this text, said while it is typed.
   *
   * It does NOT set `aria-invalid`, and that is the difference the two natures
   * are worth: a text that will arrive cut is a text the platform ACCEPTS, so
   * marking the field invalid over it would say the opposite of the sentence
   * beside it. A limit that will be refused is marked by the refusal itself,
   * when the save comes back.
   */
  readonly advice?: FieldAdvice;
  /** Monospace input, for identifiers and publication addresses. */
  readonly mono?: boolean;
  /**
   * Beside the label, on the same line: the character counter of a field with a
   * ceiling the platform imposes (REQ-257).
   *
   * Beside the label and not inside it, which is the whole reason this is a
   * slot of its own. A counter written into `label` would join the control's
   * accessible NAME, so the field would rename itself on every keystroke; here
   * it is a sibling, read in order, while the name stays the label's words. The
   * ceiling itself is stated in `hint`, where it is announced with the field.
   *
   * `TextArea` already had this slot, for the JSON editor's toolbar, and the
   * markup is the same `.mc-field__head` on purpose.
   */
  readonly toolbar?: ReactNode;
  /** Pass a Select, TextArea or KeywordField to reuse the label wiring. */
  readonly children?: ReactNode;
}

/**
 * Marked optional and worded, or neither: the word "optional" is text, and
 * text belongs to the catalogue, so a field cannot be marked without one.
 */
type FieldOptionality =
  | { readonly optional: true; readonly optionalLabel: string }
  | { readonly optional?: false; readonly optionalLabel?: undefined };

export type FieldProps = FieldBase &
  FieldOptionality &
  Omit<InputHTMLAttributes<HTMLInputElement>, "id" | "children">;

/**
 * What a nested control is handed, and the whole of it: the name and the
 * description of the field it sits in, and whether that field was refused.
 */
interface DescribedControl {
  readonly "aria-labelledby"?: string;
  readonly "aria-describedby"?: string;
  readonly "aria-invalid"?: boolean | "true" | "false";
}

/**
 * The nested control, wired to the field's own label and message.
 *
 * One element or nothing: a control is what `children` is for, and cloning a
 * pile of them would put a field's description on whatever wrapper came first.
 * A description the control already carries is KEPT and the field's ids are
 * added to it, deduplicated, so a caller that wired the message itself does not
 * end up having it announced twice.
 */
function describedControl(
  children: ReactNode,
  describedBy: string | undefined,
  labelledBy: string | undefined,
  invalid: boolean,
): ReactNode {
  if (!isValidElement<DescribedControl>(children)) {
    return children;
  }

  const ids = new Set(
    [children.props["aria-describedby"], describedBy].flatMap((value) =>
      value === undefined ? [] : value.split(/\s+/),
    ),
  );

  ids.delete("");

  return cloneElement(children, {
    "aria-labelledby": children.props["aria-labelledby"] ?? labelledBy,
    "aria-describedby": ids.size === 0 ? undefined : [...ids].join(" "),
    "aria-invalid":
      children.props["aria-invalid"] ?? (invalid ? true : undefined),
  });
}

export function Field({
  id,
  label,
  tip,
  hint,
  error,
  advice,
  optional = false,
  optionalLabel,
  mono = false,
  toolbar,
  children,
  // Taken out of `rest` for the reason REQ-198 records in `TextArea`: spread
  // last, a caller's class REPLACED the component's and the control lost
  // `mc-input` (its surface, its border and its tap size) with no error
  // anywhere. A class from outside adds to these, never instead of them.
  className = "",
  ...rest
}: FieldProps): ReactElement {
  // A nested control can render a hint of its own. Keep this id in the
  // Field namespace so both descriptions remain addressable in the same DOM.
  const hintId = hint === undefined ? undefined : `${id}-field-hint`;
  const tipId = tip === undefined ? undefined : `${id}-field-tip`;
  const errorId = error === undefined ? undefined : `${id}-error`;
  const adviceId = advice === undefined ? undefined : `${id}-advice`;
  // Described in the order the four are READ: what changed first, then what is
  // about to happen to what was typed, then what the option is for, then what
  // the answer has to respect.
  const describedBy =
    [errorId, adviceId, tipId, hintId].filter(Boolean).join(" ") || undefined;
  // Two parts, named separately, so the control's name is BUILT from them
  // instead of being read off whatever the label happens to contain (REQ-148).
  // `aria-labelledby` joins what it references with a space, by the algorithm
  // and in every engine; the middle dot between the two on screen is drawn by
  // the stylesheet, and generated content is not text a name is made of. Read
  // off the label, the two arrive at a screen reader as one glued word.
  const labelledBy = optional ? `${id}-label ${id}-optional` : undefined;

  return (
    <div className="mc-field">
      <div className="mc-field__head">
        <label className="mc-field__label" htmlFor={id}>
          <span id={`${id}-label`}>{label}</span>
          {optional ? (
            <span id={`${id}-optional`} className="mc-field__optional">
              {optionalLabel}
            </span>
          ) : null}
        </label>
        {toolbar}
      </div>
      {tip === undefined ? null : (
        <p className="mc-field__tip" id={tipId}>
          {tip}
        </p>
      )}
      {describedControl(
        children,
        describedBy,
        labelledBy,
        error !== undefined,
      ) ?? (
        <input
          id={id}
          className={[
            "mc-input",
            mono ? "mc-input--mono" : "",
            error === undefined ? "" : "mc-input--invalid",
            className,
          ]
            .filter(Boolean)
            .join(" ")}
          aria-invalid={error === undefined ? undefined : true}
          aria-labelledby={labelledBy}
          aria-describedby={describedBy}
          {...rest}
        />
      )}
      {error === undefined ? null : (
        <p className="mc-field__error" id={errorId}>
          <Icon name="circle-alert" size={ICON_SIZE.text} />
          <span>{error}</span>
        </p>
      )}
      {advice === undefined ? null : (
        // `status` and not `alert`: this appears and goes with the keystrokes,
        // and an assertive region would cut across the letters a screen reader
        // is echoing back as they are typed. Polite queues it behind them,
        // which is the difference between being told and being interrupted.
        <p
          className={`mc-field__advice mc-field__advice--${advice.nature}`}
          id={adviceId}
          role="status"
        >
          <Icon name={ADVICE_GLYPHS[advice.nature]} size={ICON_SIZE.text} />
          <span>{advice.message}</span>
        </p>
      )}
      {hint === undefined ? null : (
        <p className="mc-field__hint" id={hintId}>
          {hint}
        </p>
      )}
    </div>
  );
}
