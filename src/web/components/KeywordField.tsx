import { useState } from "react";
import type { InputHTMLAttributes, ReactElement } from "react";
import { Chip } from "./Chip.js";
import { Select } from "./Select.js";
import type { SelectOption } from "./Select.js";

/**
 * KeywordField: the trigger keywords as removable chips, with the match mode
 * attached to them.
 *
 * The mode qualifies the words ("contains the keyword"), and in the interface
 * this phase replaces it sits three fields below them, orphaned. Here it is
 * inside the same control, because reading the two together is the only way the
 * rule means anything.
 *
 * Keyboard, which is the whole point of the component (REQ-116): Enter or a
 * comma commits the word being typed, each chip's removal is a real button
 * Tab reaches, and blurring the input commits too, so a word typed and left
 * behind is not silently discarded when the operator clicks Save.
 */

interface KeywordFieldBase {
  /** Required: the label of the surrounding Field points at the input. */
  readonly id: string;
  readonly keywords: readonly string[];
  readonly onAdd?: (keyword: string) => void;
  readonly onRemove?: (keyword: string) => void;
  readonly placeholder?: string;
  /** Builds each remove button's accessible name from the word it removes. */
  readonly removeLabel: (keyword: string) => string;
}

/**
 * The mode select arrives whole or not at all: options, the word that labels
 * them, the one in force and the handler. A select with no label is a control
 * nobody can name, and options with no handler is a control that does nothing.
 */
type KeywordFieldMode =
  | {
      readonly modeOptions: readonly SelectOption[];
      readonly modeLabel: string;
      readonly mode: string;
      readonly onModeChange: (mode: string) => void;
    }
  | {
      readonly modeOptions?: undefined;
      readonly modeLabel?: undefined;
      readonly mode?: undefined;
      readonly onModeChange?: undefined;
    };

/**
 * What is left of an input's attributes once the ones this component owns are
 * taken out, and it is forwarded to the input itself.
 *
 * That forwarding is the point: a surrounding `Field` clones its description
 * and its `aria-invalid` onto whatever it nests (REQ-185), and a signature that
 * named only the props it knew would swallow them here, leaving the refusal
 * drawn on the screen and announced to nobody.
 *
 * The omitted ones are refused rather than ignored: the word being typed is
 * this component's state, and the three handlers ARE the component (Enter and a
 * comma commit the word, blur commits it too), so a caller passing them would
 * be writing code that never runs.
 */
type KeywordFieldInput = Omit<
  InputHTMLAttributes<HTMLInputElement>,
  | "id"
  | "type"
  | "placeholder"
  | "value"
  | "onChange"
  | "onKeyDown"
  | "onBlur"
  | "children"
>;

export type KeywordFieldProps = KeywordFieldBase &
  KeywordFieldMode &
  KeywordFieldInput;

export function KeywordField({
  id,
  keywords,
  onRemove,
  onAdd,
  placeholder,
  modeLabel,
  mode,
  modeOptions = [],
  onModeChange,
  removeLabel,
  className = "",
  ...rest
}: KeywordFieldProps): ReactElement {
  const [draft, setDraft] = useState("");

  const commit = (): void => {
    // The trailing comma is stripped because a comma is also a separator here:
    // typing "quero," has to produce the word, not the word plus punctuation.
    const word = draft.trim().replace(/,$/, "");

    if (word !== "" && onAdd !== undefined) {
      onAdd(word);
    }

    setDraft("");
  };

  return (
    <div>
      <div className="mc-keywords">
        {/* Two whole chips rather than one with conditional props: the removal
            and its name travel together in Chip's type, and a spread would
            hand the compiler a pair it can no longer tell apart. */}
        {/* Tinted, because a keyword is a DECISION: the words below the field
            are suggestions in a dashed outline, and the difference between an
            offer and a word that will really fire the automation has to be
            visible without reading either. */}
        {keywords.map((word) =>
          onRemove === undefined ? (
            <Chip key={word} mono tone="accent">
              {word}
            </Chip>
          ) : (
            <Chip
              key={word}
              mono
              tone="accent"
              onRemove={() => onRemove(word)}
              removeLabel={removeLabel(word)}
            >
              {word}
            </Chip>
          ),
        )}
        <input
          id={id}
          type="text"
          // Adds to the component's class, never instead of it (REQ-198): left
          // in `rest` and spread below, a caller's `className` took the input's
          // own styling with it and nothing said so.
          className={["mc-keywords__input", className]
            .filter(Boolean)
            .join(" ")}
          placeholder={placeholder}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === ",") {
              // Enter would submit the surrounding form and the comma would be
              // typed into the field; here both mean "this word is finished".
              event.preventDefault();
              commit();
            }
          }}
          onBlur={commit}
          {...rest}
        />
      </div>
      {modeOptions.length === 0 ? null : (
        <div className="mc-keywords__mode">
          <label className="mc-keywords__modelabel" htmlFor={`${id}-mode`}>
            {modeLabel}
          </label>
          <Select
            id={`${id}-mode`}
            options={modeOptions}
            value={mode}
            onChange={(event) => onModeChange?.(event.target.value)}
          />
        </div>
      )}
    </div>
  );
}
