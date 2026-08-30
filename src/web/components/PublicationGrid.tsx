import { useState } from "react";
import type { ReactElement, ReactNode } from "react";
import { Icon, ICON_SIZE } from "./Icon.js";

/**
 * PublicationGrid: the account's publications, in the two places they appear:
 * the publications screen and the target picker of the automation form. One
 * component, two contexts (REQ-113).
 *
 * What changed from the grid this phase replaces: the thumbnail dominates, the
 * media type is a small overlay, the date is discreet, and the platform's
 * 17-digit identifier is present but last, because it means nothing to the
 * person operating.
 *
 * The caption leads the text under the picture (REQ-216), and that is the same
 * argument carried one step further: the tile used to read `IMAGE · 09 jun ·
 * 17900000000000001`, so ten publications were told apart by squinting at ten
 * thumbnails. What a person recognises their own post by is the sentence they
 * wrote, so it is the first thing read and the identifier stays where it was,
 * legible and last.
 *
 * A missing or broken thumbnail is a designed state and not a gap: the
 * platform's image URL expires and can answer 404, and the publication is still
 * a perfectly good target. So the tile falls back to a labelled placeholder,
 * never to an empty box, and `brokenLabel` is required for that reason.
 *
 * Each tile is a `<button>` carrying `aria-pressed`, so the grid is a set of
 * choices a keyboard walks with Tab and commits with Enter or Space, and the
 * one already chosen announces itself as pressed (REQ-116).
 */

export interface PublicationItem {
  /** The platform's identifier. Shown, but last. */
  readonly id: string;
  /**
   * The caption the operator wrote, WHOLE (REQ-216).
   *
   * Whole and clamped by the stylesheet to two lines, never shortened here: the
   * text stays complete in the document, so a screen reader reads all of it and
   * a wider card shows more of it, while a post of two hundred words still
   * cannot push the date, the state and the action off the tile.
   *
   * Absent is a designed state and not a gap: a publication with no caption
   * exists, is ordinary, and the tile simply closes up around it.
   */
  readonly caption?: string;
  /** The media type, as the platform words it. */
  readonly mediaType: string;
  /** Date already formatted by the caller for its locale. */
  readonly publishedLabel: string;
  /** Our own address, never the platform's (REQ-071). Absent draws the
   * fallback. */
  readonly thumbnailUrl?: string;
}

export interface PublicationGridProps {
  readonly items: readonly PublicationItem[];
  readonly selectedId?: string;
  readonly onSelect?: (id: string) => void;
  /** The accessible name of each tile, built from the identifier. */
  readonly selectLabel: (id: string) => string;
  /** The alternative text of each thumbnail, built from the identifier. */
  readonly thumbnailAlt: (id: string) => string;
  /** What the fallback says when the image did not load. */
  readonly brokenLabel: string;
  /** Optional content belonging to one publication, kept outside its button. */
  readonly renderDetails?: (item: PublicationItem) => ReactNode;
}

export function PublicationGrid({
  items,
  selectedId,
  onSelect,
  selectLabel,
  thumbnailAlt,
  brokenLabel,
  renderDetails,
}: PublicationGridProps): ReactElement {
  // Which images failed IN THIS SESSION. A URL that 404s once will 404 again,
  // and React would otherwise re-render the same broken <img> on every keypress
  // in a parent form.
  const [broken, setBroken] = useState<Readonly<Record<string, true>>>({});

  return (
    <ul className="mc-pubgrid">
      {items.map((item) => {
        const failed =
          broken[item.id] === true || item.thumbnailUrl === undefined;
        const selected = selectedId === item.id;

        return (
          <li key={item.id} className="mc-pubgrid__item">
            <button
              type="button"
              className={`mc-pubtile${selected ? " mc-pubtile--selected" : ""}`}
              aria-label={selectLabel(item.id)}
              aria-pressed={selected}
              onClick={() => onSelect?.(item.id)}
            >
              <span className="mc-pubtile__frame">
                {failed ? (
                  <span className="mc-pubtile__fallback">
                    <Icon name="image-off" size={ICON_SIZE.standalone} />
                    {brokenLabel}
                  </span>
                ) : (
                  <img
                    src={item.thumbnailUrl}
                    alt={thumbnailAlt(item.id)}
                    onError={() =>
                      setBroken((was) => ({ ...was, [item.id]: true }))
                    }
                  />
                )}
                <span className="mc-pubtile__kind">{item.mediaType}</span>
                {selected ? (
                  <span className="mc-pubtile__check" aria-hidden="true">
                    <Icon name="check" size={ICON_SIZE.chip} />
                  </span>
                ) : null}
              </span>
              <span className="mc-pubtile__meta">
                {/* First, because it is what the person wrote and therefore the
                    one line that tells two publications apart. Rendered as
                    text and never as markup: it is somebody's caption, and it
                    arrives with whatever they typed in it. */}
                {item.caption === undefined ? null : (
                  <span className="mc-pubtile__caption">{item.caption}</span>
                )}
                <span className="mc-pubtile__date">{item.publishedLabel}</span>
                <span className="mc-pubtile__id">{item.id}</span>
              </span>
            </button>
            {renderDetails?.(item)}
          </li>
        );
      })}
    </ul>
  );
}
