import type { ReactElement, SelectHTMLAttributes } from "react";
import { Icon, ICON_SIZE } from "./Icon.js";

/**
 * Select: the native element, kept native.
 *
 * A custom listbox is either a dependency or a pile of keyboard code, and this
 * product can spend neither. The native control already opens with Alt+Down,
 * walks with the arrows, jumps by typing and closes with Escape, on every
 * platform, in every assistive technology. So: `<select>`, appearance stripped,
 * our own chevron drawn beside it, and nothing else invented (REQ-116).
 *
 * The placeholder is a disabled first option, which is what keeps "choose one"
 * from being submitted as a value.
 */

export interface SelectOption {
  readonly value: string;
  readonly label: string;
  readonly disabled?: boolean;
}

export interface SelectProps extends Omit<
  SelectHTMLAttributes<HTMLSelectElement>,
  "children"
> {
  /** Required: a Field's label points at it. */
  readonly id: string;
  readonly options: readonly SelectOption[];
  /** Disabled first option, from the catalogue. */
  readonly placeholder?: string;
  /** Optional native hint retained for consumers that also expose a default. */
  readonly nativePlaceholder?: string;
}

export function Select({
  id,
  options,
  placeholder,
  value,
  className = "",
  nativePlaceholder,
  ...rest
}: SelectProps): ReactElement {
  const nativeAttributes =
    nativePlaceholder === undefined
      ? {}
      : ({
          placeholder: nativePlaceholder,
        } as unknown as SelectHTMLAttributes<HTMLSelectElement>);

  return (
    <span className="mc-select-wrap">
      <select
        id={id}
        value={value}
        className={["mc-input", "mc-select", className]
          .filter(Boolean)
          .join(" ")}
        {...nativeAttributes}
        {...rest}
      >
        {placeholder === undefined ? null : (
          <option value="" disabled>
            {placeholder}
          </option>
        )}
        {options.map((option) => (
          <option
            key={option.value}
            value={option.value}
            disabled={option.disabled}
          >
            {option.label}
          </option>
        ))}
      </select>
      {/* Decoration: the control it belongs to is right there and already
          announces itself, so a second announcement would be noise. */}
      <span className="mc-select-wrap__chevron" aria-hidden="true">
        <Icon name="chevron-down" size={ICON_SIZE.text} />
      </span>
    </span>
  );
}
