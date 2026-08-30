import { useId } from "react";
import type { ReactElement, ReactNode } from "react";
import { StatusBadge } from "./StatusBadge.js";

/**
 * CapMeter: consumption against one platform ceiling (REQ-038).
 *
 * Three things always render together: the bar, the numbers, and the status in
 * words. The bar is the fastest read and the least trustworthy one, so it is
 * never alone, and the status word is never replaced by the colour of the fill
 * (acceptance criterion 23).
 *
 * `note` carries the caveat that belongs to THIS number (the per-second
 * ceilings are read for the second in progress, so they normally show zero),
 * because an explanatory note is part of the datum and not a footer.
 *
 * Two things the component refuses to do, and both are the same refusal: it
 * does not word the usage and it does not word the status. `usageLabel` and
 * `statusLabel` arrive already formatted from the catalogue, because "86 of 100
 * (86%)" is a sentence whose number order belongs to a locale, not to a meter.
 */

/**
 * The band, spelled here a third time (the screen and `dashboard/aggregate.ts`
 * spell it too), because a component of the design system declares its own props
 * and imports no screen. Held against `src/dashboard/vocabulary.ts` by
 * assignment in both directions, in `screens/dashboard.test.tsx` (REQ-192): a
 * band added or dropped here alone stops `npm run build`.
 */
export type CapStatus = "normal" | "attention" | "critical";

export interface CapMeterProps {
  /** The ceiling's name, from the catalogue. */
  readonly name: ReactNode;
  readonly used: number;
  readonly limit: number;
  /** Threshold band. Drives the fill colour and the badge tone, nothing else. */
  readonly status: CapStatus;
  /** The band in words. Required: colour never carries it alone. */
  readonly statusLabel: string;
  /**
   * A mark drawn before the word, for a band that has to stand out from the
   * others at a glance (REQ-178).
   *
   * Optional and never a substitute: the word renders either way, and the mark
   * is a SHAPE beside it rather than a second tint, so a ceiling being
   * approached is picked out of a list of ceilings without reading each one and
   * without telling any two colours apart. The caller decides which bands carry
   * one, because which band is worth pointing at is a decision about ceilings
   * and not about meters.
   */
  readonly statusMark?: ReactNode;
  /** The numbers, already formatted by the caller for its locale. */
  readonly usageLabel: ReactNode;
  /** The caveat that belongs to this number, rendered beside the status. */
  readonly note?: ReactNode;
}

/** A full bar, in percent, so the fill's width is a share and not a length. */
const FULL = 100;

/**
 * The sliver a non-zero consumption still draws.
 *
 * One request against a ten thousand per hour ceiling rounds to 0%, and a bar
 * that is empty when something HAS been spent says the opposite of the truth.
 */
const MINIMUM_VISIBLE = 2;

export function CapMeter({
  name,
  used,
  limit,
  status,
  statusLabel,
  statusMark,
  usageLabel,
  note,
}: CapMeterProps): ReactElement {
  const nameId = useId();
  const usageId = useId();
  const statusId = useId();

  const percent =
    limit > 0 ? Math.min(FULL, Math.round((used / limit) * FULL)) : 0;
  const fill = Math.max(percent, used > 0 ? MINIMUM_VISIBLE : 0);

  return (
    <div className="mc-cap">
      <div className="mc-cap__head">
        <span className="mc-cap__name" id={nameId}>
          {name}
        </span>
        <span className="mc-cap__value" id={usageId}>
          {usageLabel}
        </span>
      </div>
      <div
        className="mc-cap__track"
        role="meter"
        aria-valuenow={used}
        aria-valuemin={0}
        aria-valuemax={limit}
        // The name of the meter is the three pieces of text already on screen,
        // pointed at rather than restated. A string built here would be a
        // fourth wording of the same thing, assembled in code, in no language.
        aria-labelledby={`${nameId} ${usageId} ${statusId}`}
      >
        <div
          className={`mc-cap__fill mc-cap__fill--${status}`}
          style={{ width: `${fill}%` }}
        />
      </div>
      <div className="mc-cap__foot">
        <StatusBadge
          id={statusId}
          state={status === "normal" ? "active" : status}
          dot={false}
        >
          {/* Inside the badge and before the word, so the two are read as one
              marker. The meter's own name points at this badge, and the mark
              carries no accessible name of its own: announcing it would read
              the same band twice, once as a shape and once as the sentence. */}
          {statusMark}
          {statusLabel}
        </StatusBadge>
        {note === undefined ? null : <span>{note}</span>}
      </div>
    </div>
  );
}
