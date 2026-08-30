import { useState } from "react";
import type { ReactElement } from "react";
import { Button } from "./Button.js";
import { Icon, ICON_SIZE } from "./Icon.js";

/**
 * FileUpload: the one control for everything that goes up, in the two faces the
 * two things it carries need (REQ-290).
 *
 * An image is recognised by its PICTURE, so the chosen one is drawn. A document
 * is recognised by what it is and what it is called, so it gets a kind mark and
 * its name. Before this, both were a file name in a row of text, and choosing a
 * cover meant reading `guide~1a2b3c4d.png` and hoping.
 *
 * Three states, and the empty one is a state rather than a gap: nothing chosen
 * yet is the normal beginning of the control, and it says what would happen and
 * offers the one way to start. The third is a picture that did not draw: the
 * address of a resource can 404 while the resource is perfectly well chosen, so
 * the frame falls back to a labelled mark and never to an empty box.
 *
 * Removing is a BUTTON here, and that is the correction the prototype's own
 * note carries: the word "replace" loose in the middle of the row never read as
 * an action. Both actions are real buttons of the system, so both take the one
 * tap size with everything else (REQ-268).
 */

export interface FileUploadProps {
  /**
   * Given to the control that OPENS the choice, so a `Field` around this can
   * name it with a real `<label for>`.
   */
  readonly id?: string;
  /** What the operator called the file. Absent means nothing is chosen yet. */
  readonly fileName?: string;
  /** Where the chosen picture is, when it is a picture. */
  readonly previewUrl?: string;
  /** Which face to wear: a picture is drawn, a document is marked. */
  readonly kind: "image" | "file";
  /** What a document says it is, in a word: `PDF`. */
  readonly kindLabel: string;
  /** One line under the name, saying where the file now lives. */
  readonly note?: string;
  /** What the empty state says before anything is chosen. */
  readonly emptyHint: string;
  /** Opens the choice with nothing chosen yet. */
  readonly chooseLabel: string;
  /** Opens the choice with something already chosen. */
  readonly replaceLabel: string;
  readonly removeLabel: string;
  /** The alternative text of the drawn picture, built from the file name. */
  readonly thumbnailAlt: string;
  /** What the frame says when the picture did not load. */
  readonly brokenLabel: string;
  readonly disabled?: boolean;
  onChoose(): void;
  onRemove(): void;
  /**
   * What a `Field` around this hands its nested control (REQ-149, REQ-185).
   *
   * It lands on the control that OPENS the choice, because that is the element
   * a keyboard stops on: a refusal wired to the box around it is a refusal
   * announced to nobody who is not looking at the screen.
   */
  readonly "aria-labelledby"?: string;
  readonly "aria-describedby"?: string;
  readonly "aria-invalid"?: boolean | "true" | "false";
}

export function FileUpload({
  id,
  fileName,
  previewUrl,
  kind,
  kindLabel,
  note,
  emptyHint,
  chooseLabel,
  replaceLabel,
  removeLabel,
  thumbnailAlt,
  brokenLabel,
  disabled = false,
  onChoose,
  onRemove,
  ...described
}: FileUploadProps): ReactElement {
  // Which address failed IN THIS SESSION, so a 404 is not requested again on
  // every keystroke in the form around this control.
  const [broken, setBroken] = useState<string>();

  if (fileName === undefined) {
    return (
      <div className="mc-uploader mc-uploader--empty">
        <span className="mc-uploader__hint">{emptyHint}</span>
        <Button
          id={id}
          variant="secondary"
          icon={kind === "image" ? "image" : "file"}
          disabled={disabled}
          onClick={onChoose}
          {...described}
        >
          {chooseLabel}
        </Button>
      </div>
    );
  }

  const drawable =
    kind === "image" && previewUrl !== undefined && broken !== previewUrl;

  return (
    <div className="mc-uploader">
      {drawable ? (
        <img
          className="mc-uploader__thumb"
          src={previewUrl}
          alt={thumbnailAlt}
          onError={() => setBroken(previewUrl)}
        />
      ) : (
        <span
          className={`mc-uploader__mark${kind === "image" ? " mc-uploader__mark--broken" : ""}`}
        >
          {kind === "image" ? (
            <>
              <Icon name="image-off" size={ICON_SIZE.standalone} />
              {brokenLabel}
            </>
          ) : (
            kindLabel
          )}
        </span>
      )}
      <span className="mc-uploader__meta">
        <span className="mc-uploader__name">{fileName}</span>
        {note === undefined ? null : (
          <span className="mc-uploader__note">{note}</span>
        )}
      </span>
      <span className="mc-uploader__acts">
        <Button
          id={id}
          variant="secondary"
          disabled={disabled}
          onClick={onChoose}
          {...described}
        >
          {replaceLabel}
        </Button>
        <Button variant="removal" disabled={disabled} onClick={onRemove}>
          {removeLabel}
        </Button>
      </span>
    </div>
  );
}
