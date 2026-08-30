import { useEffect, useId, useRef, useState } from "react";
import type { ReactElement } from "react";
import { Button } from "./Button.js";
import { Icon, ICON_SIZE } from "./Icon.js";
import { IconButton } from "./IconButton.js";

/**
 * AssetGrid: everything already uploaded, shown as what it is (REQ-291).
 *
 * The catalogue was a dropdown of NAMES, and a name shows no picture: what
 * tells two covers apart is the image, so choosing one meant opening the list,
 * reading `capa-final-2.png`, saving, looking at the preview and starting over.
 * A picture is therefore DRAWN, in a grid of tiles, and it is the whole reason
 * this component exists.
 *
 * A document takes the SAME tile, of the same size, in the same grid. Nothing
 * is drawn of a PDF that a thumbnail would help anyone recognise, so where the
 * image shows its picture the document shows the mark of its kind, and what
 * tells two PDFs apart stays where it already was: the name, read under the
 * frame, on the tile. Giving the document the whole line instead was tried and
 * refused by eye, because a catalogue read as one shape is read at a glance and
 * a catalogue of two shapes is read twice.
 *
 * The name shown is the one the operator gave the file, never the minted key
 * the catalogue stores it under: two uploads of `guide.pdf` are two resources
 * and the second is kept as `guide~1a2b3c4d.pdf`, which is an identity and not
 * a word anybody chose. Selection still travels by key, because that is what a
 * definition points at (REQ-292).
 *
 * Each item is a `<button>` carrying `aria-pressed`, so the catalogue is a set
 * of choices a keyboard walks with Tab and commits with Enter or Space, and the
 * one already chosen announces itself as pressed (REQ-116).
 *
 * Deleting is offered HERE, and confirmed on the tile itself (REQ-293). The
 * catalogue is already a dialog, and a second dialog over it would ask the
 * operator to read a file name in one window and decide about it in another;
 * the tile that is about to go is the one thing on screen that says which file
 * this is, so it is where the question is asked. What the answer costs travels
 * with it: how many automations use the file, counted by the catalogue and
 * never guessed here, and the warning that messages ALREADY DELIVERED stop
 * working, which is the part no undo reaches.
 */

export interface AssetTile {
  /** The catalogue's key: what a definition points at, and never shown. */
  readonly name: string;
  /** What the operator called the file, which is what is read on screen. */
  readonly fileName: string;
  /** Our own address for it, used to draw a picture. */
  readonly url: string;
  /** What fills the tile's frame: a picture is drawn, a document is marked. */
  readonly kind: "image" | "file";
}

/**
 * The tile now asking to be confirmed, and what it knows.
 *
 * Owned by the caller and not by this component, because the number in it is
 * not this component's to know: how many automations use a file is a question
 * only the catalogue can answer, and it is asked the moment the deletion is
 * requested. Until the answer lands the count is absent, and the tile says so
 * rather than showing a zero it made up.
 */
export interface AssetRemoval {
  /** The catalogue key of the tile in confirmation. */
  readonly name: string;
  /** How many automations use it, once the catalogue has answered. */
  readonly usageCount?: number;
  /** The deletion is on its way and has not answered yet. */
  readonly pending?: boolean;
}

export interface AssetGridProps {
  readonly items: readonly AssetTile[];
  /** The key already chosen, so it can announce itself as pressed. */
  readonly selectedName?: string;
  onSelect(name: string): void;
  /** The accessible name of each choice, built from the operator's file name. */
  readonly selectLabel: (fileName: string) => string;
  /** The alternative text of each picture, built from the same. */
  readonly thumbnailAlt: (fileName: string) => string;
  /** What a tile says when its picture did not load. */
  readonly brokenLabel: string;
  /** What a document says it is, in a word: `PDF`. */
  readonly kindLabel: string;
  /** What stands in the catalogue's place while it holds nothing. */
  readonly emptyLabel: string;
  /** Which tile is in confirmation, if any. */
  readonly removal?: AssetRemoval;
  /** The operator asked to delete one: the caller goes and counts its uses. */
  onRemoveRequest(name: string): void;
  onRemoveConfirm(name: string): void;
  onRemoveCancel(): void;
  /** The name of each tile's delete control, so twenty are not one word. */
  readonly removeLabel: (fileName: string) => string;
  /** What the tile in confirmation asks, naming the file it is about. */
  readonly removeQuestion: (fileName: string) => string;
  /** How many automations use it, in words, counted by the catalogue. */
  readonly usageLabel: (count: number) => string;
  /** What stands in the count's place while the catalogue is being asked. */
  readonly usagePendingLabel: string;
  /** That the messages already delivered stop working. The whole cost. */
  readonly removeWarning: string;
  readonly removeConfirmLabel: string;
  /** The word on the commit control while the deletion is on its way. */
  readonly removeWorkingLabel: string;
  readonly removeCancelLabel: string;
}

export function AssetGrid({
  items,
  selectedName,
  onSelect,
  selectLabel,
  thumbnailAlt,
  brokenLabel,
  kindLabel,
  emptyLabel,
  removal,
  onRemoveRequest,
  onRemoveConfirm,
  onRemoveCancel,
  removeLabel,
  removeQuestion,
  usageLabel,
  usagePendingLabel,
  removeWarning,
  removeConfirmLabel,
  removeWorkingLabel,
  removeCancelLabel,
}: AssetGridProps): ReactElement {
  // Which addresses failed IN THIS SESSION. One that answered 404 once answers
  // 404 again, and React would otherwise ask for it on every render.
  const [broken, setBroken] = useState<Readonly<Record<string, true>>>({});
  /** What the two controls of the confirmation are described BY. */
  const consequenceId = useId();
  const tiles = useRef<Record<string, HTMLButtonElement | null>>({});
  const removers = useRef<Record<string, HTMLButtonElement | null>>({});
  const keep = useRef<HTMLButtonElement>(null);
  const empty = useRef<HTMLParagraphElement>(null);
  /** The tile that was in confirmation, and where it sat, once it is not. */
  const asked = useRef<{ name: string; index: number } | undefined>(undefined);
  const asking = removal?.name;

  /**
   * Focus follows the question, and the question is asked on the tile.
   *
   * A confirmation the keyboard cannot reach is a confirmation only a mouse
   * has, so focus moves into it when it opens and comes back out when it
   * closes. Coming back has three ends, and the third is the one that is easy
   * to miss: the tile the focus was on can be GONE, because deleting it is
   * what the question was about, and focus left on a removed node falls to the
   * body, which inside a dialog is nowhere at all.
   */
  useEffect(() => {
    if (asking !== undefined) {
      // Only when it OPENS: the count landing and the deletion starting are
      // both re-renders of the same question, and moving focus on either would
      // take it off whatever the operator had reached by then.
      if (asked.current?.name === asking) {
        return;
      }

      asked.current = {
        name: asking,
        index: items.findIndex((item) => item.name === asking),
      };
      keep.current?.focus();
      // And the whole cell after it, because the grid scrolls inside itself:
      // focus brings the BUTTON into view, and the button is at the bottom of
      // the question, so on a narrow screen the line naming the file ends up
      // above the fold. Measured at 320px, where it was cut by 27 pixels.
      keep.current?.closest("li")?.scrollIntoView?.({ block: "nearest" });
      return;
    }

    const left = asked.current;

    if (left === undefined) {
      return;
    }

    asked.current = undefined;

    if (items.some((item) => item.name === left.name)) {
      // Refused: the tile is back, and focus returns to the control that
      // opened the question rather than to the top of the dialog.
      removers.current[left.name]?.focus();
      return;
    }

    // Deleted. Whatever took its place in the grid, or the last tile when it
    // was the last, or the sentence that now stands for the whole catalogue.
    const next = items[Math.min(left.index, items.length - 1)];

    if (next === undefined) {
      empty.current?.focus();
    } else {
      tiles.current[next.name]?.focus();
    }
  }, [asking, items]);

  if (items.length === 0) {
    return (
      // Focusable programmatically and not by Tab: this is where focus lands
      // when the tile it was on was the last one deleted.
      <p className="mc-assetgrid__empty" tabIndex={-1} ref={empty}>
        {emptyLabel}
      </p>
    );
  }

  return (
    <ul className="mc-assetgrid">
      {items.map((item) => {
        const selected = selectedName === item.name;
        const failed = broken[item.name] === true;
        const confirming = removal !== undefined && removal.name === item.name;
        const counted = removal?.usageCount;
        const working = removal?.pending === true;

        return (
          <li key={item.name} className="mc-assetgrid__item">
            {confirming ? (
              <div className="mc-assetconfirm">
                <div className="mc-assetconfirm__said" id={consequenceId}>
                  <span className="mc-assetconfirm__name">
                    {removeQuestion(item.fileName)}
                  </span>
                  <span className="mc-assetconfirm__usage">
                    {counted === undefined
                      ? usagePendingLabel
                      : usageLabel(counted)}
                  </span>
                  <span className="mc-assetconfirm__warning">
                    {removeWarning}
                  </span>
                </div>
                <div className="mc-assetconfirm__acts">
                  <Button
                    variant="destructive"
                    block
                    // Nothing is deleted before the cost of deleting it is on
                    // screen: until the catalogue has counted the uses, the
                    // warning is missing its number and the choice is not the
                    // informed one REQ-293 asks for.
                    disabled={counted === undefined}
                    pending={working}
                    aria-describedby={consequenceId}
                    onClick={(): void => onRemoveConfirm(item.name)}
                  >
                    {working ? removeWorkingLabel : removeConfirmLabel}
                  </Button>
                  <Button
                    variant="secondary"
                    block
                    disabled={working}
                    aria-describedby={consequenceId}
                    ref={keep}
                    onClick={onRemoveCancel}
                  >
                    {removeCancelLabel}
                  </Button>
                </div>
              </div>
            ) : (
              <>
                <button
                  type="button"
                  className={`mc-assettile${selected ? " mc-assettile--selected" : ""}`}
                  aria-label={selectLabel(item.fileName)}
                  aria-pressed={selected}
                  ref={(node): void => {
                    tiles.current[item.name] = node;
                  }}
                  onClick={() => onSelect(item.name)}
                >
                  <span className="mc-assettile__frame">
                    {/* Over the picture and not around it: an inset ring on the
                        frame is painted under whatever fills it, so on a tile
                        that is entirely photograph the choice would show
                        nowhere. */}
                    {selected ? (
                      <span className="mc-assettile__check" aria-hidden="true">
                        <Icon name="check" size={ICON_SIZE.chip} />
                      </span>
                    ) : null}
                    {item.kind === "file" ? (
                      <span className="mc-assettile__kind">
                        <Icon name="file" size={ICON_SIZE.standalone} />
                        {kindLabel}
                      </span>
                    ) : failed ? (
                      <span className="mc-assettile__fallback">
                        <Icon name="image-off" size={ICON_SIZE.standalone} />
                        {brokenLabel}
                      </span>
                    ) : (
                      <img
                        src={item.url}
                        alt={thumbnailAlt(item.fileName)}
                        onError={() =>
                          setBroken((was) => ({ ...was, [item.name]: true }))
                        }
                      />
                    )}
                  </span>
                  <span className="mc-assettile__name">{item.fileName}</span>
                </button>
                {/* A sibling of the tile and not a child of it: the tile is a
                    button, and a button inside a button is markup no browser
                    agrees on. It is laid over the corner opposite the mark of
                    the chosen one, so neither ever covers the other. */}
                <IconButton
                  icon="trash-2"
                  tone="danger"
                  className="mc-assettile__delete"
                  label={removeLabel(item.fileName)}
                  disabled={removal !== undefined}
                  ref={(node): void => {
                    removers.current[item.name] = node;
                  }}
                  onClick={(): void => onRemoveRequest(item.name)}
                />
              </>
            )}
          </li>
        );
      })}
    </ul>
  );
}
