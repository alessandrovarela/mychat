import type { InputHTMLAttributes, ReactElement, ReactNode } from "react";

/**
 * Checkbox: the box, its label, and the sentence that says what it does.
 *
 * Both booleans in this product are rules with consequences (once per contact,
 * in force), so the hint is not decoration: it is where the consequence gets
 * stated, on the line under the label. It is wired with `aria-describedby`, so
 * it is announced with the control instead of sitting nearby in silence.
 *
 * These are form fields that get saved with the rest of the form, never instant
 * toggles that write on click, and the `switch` variant does NOT change that:
 * it changes the drawing and nothing else. That distinction is the whole reason
 * the two shapes live in one component instead of two — the semantics a switch
 * would be tempted to invent (`role="switch"`, a click that commits) are
 * exactly the semantics this product must not have, so there is one control
 * here, it is an `input[type=checkbox]`, and the variant picks a track instead
 * of a box.
 *
 * `labelHidden` is for the one arrangement where the name is already on screen
 * in larger type: a switch in a section's heading, where the heading beside it
 * IS the sentence. The words are still rendered and still reach the accessible
 * name through the `<label>`; the sheet clips them, so nothing is announced by
 * position alone.
 */

export type CheckboxVariant = "box" | "switch";

export interface CheckboxProps extends Omit<
  InputHTMLAttributes<HTMLInputElement>,
  "type" | "id"
> {
  /** Required: it wires the label and the hint to the box. */
  readonly id: string;
  readonly label: ReactNode;
  /** The consequence, in words. Rendered under the label. */
  readonly hint?: ReactNode;
  /** `box` is the form field; `switch` is the same control drawn as a track. */
  readonly variant?: CheckboxVariant;
  /** Keeps the label as the accessible name only. Switch variant alone. */
  readonly labelHidden?: boolean;
}

export function Checkbox({
  id,
  label,
  hint,
  variant = "box",
  labelHidden = false,
  ...rest
}: CheckboxProps): ReactElement {
  const hintId = hint === undefined ? undefined : `${id}-hint`;
  const block = variant === "switch" ? "mc-switch" : "mc-check";

  return (
    <label className={block} htmlFor={id}>
      <input type="checkbox" id={id} aria-describedby={hintId} {...rest} />
      {variant === "switch" ? (
        // The track and the pin that travels along it. Hidden from the reader
        // because it draws a state the input already carries: announcing it
        // twice is announcing it wrong.
        <span className="mc-switch__track" aria-hidden="true" />
      ) : null}
      <span className={labelHidden ? `${block}__name` : `${block}__text`}>
        <span className={`${block}__label`}>{label}</span>
        {hint === undefined ? null : (
          <span className={`${block}__hint`} id={hintId}>
            {hint}
          </span>
        )}
      </span>
    </label>
  );
}
