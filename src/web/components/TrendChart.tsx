import type { ReactElement, ReactNode } from "react";

/**
 * TrendChart: the shape of a counting table, drawn BESIDE the table (REQ-154).
 *
 * The panel's tables answer "does this match the record", figure by figure, and
 * they keep doing it: the registered request was to ADD a visual reading, not to
 * trade one for the other. What a table of thirty rows does not give is the
 * SHAPE: whether the traffic is flat, whether it peaked at nine in the morning,
 * whether one type carries all of it. Reading that off a column means reading
 * thirty numbers one by one, which is exactly what a drawing spares.
 *
 * SMALL MULTIPLES, one strip per type, and that choice is the answer to the part
 * of the requirement most easily faked: identity is carried by the NAME beside
 * each strip, never by a tint. There is no palette here, no legend to map a
 * colour onto a type, and nothing to tell apart by hue: every bar in the drawing
 * is painted with the same token, so an operator who sees no colour at all loses
 * nothing, and one who prints the page in black and white loses nothing either.
 * A single plot with the types overlaid would have needed a colour per series,
 * a legend, and a second encoding to survive without it. A strip per type needs
 * none of that and takes the same room.
 *
 * ONE SCALE FOR THE WHOLE DRAWING. The tallest column of the block is the
 * largest count in it, so a strip half the height of its neighbour really did
 * count half as much. Beside each strip stands its own largest count, in words
 * and digits, which is what stops a height from being a quantity nobody can
 * name: `peakLabel` arrives already worded from the catalogue, because "Peak 3"
 * is a sentence and this component knows no language.
 *
 * STRIPS OF TWO NATURES IN ONE FRAME, which is what `group` is for (REQ-179).
 * The panel draws what ARRIVED and what was DONE in this single drawing, and
 * the reading that matters is one against the other: they only compare because
 * they are cut over the same periods and measured against the same scale, which
 * is exactly what two frames side by side could not give (each would have had
 * its own tallest column, so two strips of equal height would have meant two
 * different quantities). What tells the two halves apart is a written heading
 * over each run of strips, in the same register as the name beside every strip:
 * still no palette, still no legend, still nothing to tell apart by hue.
 *
 * COUNTS ARRIVE AS NUMBERS, never as the text a locale formatted. That is the
 * defect REQ-155 fixed inside the table cells (`"1.234"` read as a fraction,
 * `"1,234"` read as nothing at all, one unreadable cell flattening every bar
 * through the maximum), and the fix here is to make it unrepresentable: the type
 * says `number[]`, so there is no text to parse and no locale to get wrong.
 *
 * The drawing is one `role="img"` with its own name, and not a heap of silent
 * divs: a screen reader hears that a figure is there and what it shows. Exact
 * values remain available twice: a point yields its value when it is inspected
 * with a pointer, and the panel's named detailed table preserves the complete
 * keyboard and assistive-technology reading. A plotted height is therefore
 * never the only way to recover a fact.
 */

export interface TrendSeries {
  /** The type, as the trail names it. Not shown: it is the React key. */
  readonly key: string;
  /** The type's name, from the catalogue. This is what tells strips apart. */
  readonly label: ReactNode;
  /**
   * What NATURE this strip counts, from the catalogue, written over the first
   * strip of each run (REQ-179).
   *
   * A string and not a node, because the component compares it against the
   * previous strip's to decide where a run begins, and two nodes that read the
   * same are not equal. Series carrying the same group have to arrive together:
   * a heading is written whenever the group CHANGES, so an interleaved list
   * would draw the same heading twice.
   */
  readonly group?: string;
  /** One count per period, aligned with `periods`. Numbers, never text. */
  readonly counts: readonly number[];
  /** This strip's largest count, already worded by the caller. */
  readonly peakLabel: ReactNode;
}

export interface TrendChartProps {
  /**
   * What the drawing shows, from the catalogue.
   *
   * Required, because it is the figure's ONLY name: a drawing with no name is
   * an object a screen reader announces as "image" and nothing else.
   */
  readonly label: string;
  /** The names printed beside the shared numeric scale and time axis. */
  readonly axes: {
    readonly x: string;
    readonly y: string;
  };
  readonly series: readonly TrendSeries[];
  /** One label per column, already formatted: the periods the counts fall in. */
  readonly periods: readonly string[];
  /** How to read the drawing, from the catalogue. Text, for everyone. */
  readonly note?: ReactNode;
}

/** A full-height column, in percent: the height is a share, not a length. */
const FULL = 100;

/**
 * The sliver a non-zero count still draws.
 *
 * One event in a period whose peak is two hundred rounds to 0%, and a column
 * that is empty where something WAS counted says the opposite of the truth. The
 * same reasoning, and the same floor, as `CapMeter`.
 */
const MINIMUM_VISIBLE = 2;

export function TrendChart({
  label,
  axes,
  series,
  periods,
  note,
}: TrendChartProps): ReactElement {
  // One scale for every strip, so the strips can be compared with each other
  // rather than each against itself. The floor of 1 is what keeps a block that
  // counted nothing from dividing by zero.
  const max = Math.max(
    1,
    ...series.flatMap((one) => one.counts.filter((count) => count > 0)),
  );

  const first = periods[0];
  const last = periods.length > 1 ? periods[periods.length - 1] : undefined;
  const groups = series.reduce<TrendSeries[][]>((all, one) => {
    const current = all.at(-1);
    if (current === undefined || current[0]?.group !== one.group)
      all.push([one]);
    else current.push(one);
    return all;
  }, []);

  return (
    <div className="mc-trend">
      <div className="mc-trend__plot" role="img" aria-label={label}>
        <p className="mc-trend__axis-title mc-trend__axis-title--y">{axes.y}</p>
        {groups.map((group, groupIndex) => (
          <div
            className="mc-trend__series-card"
            key={`${group[0]?.group ?? "series"}-${groupIndex}`}
          >
            {/* The nature this run of strips counts, over the first of them.
                Written whenever the group changes, so a drawing of one nature
                carries no heading at all and nothing on screen names something
                the caller did not ask for. */}
            {group[0]?.group === undefined ? null : (
              <p className="mc-trend__group">{group[0].group}</p>
            )}
            {group.map((one, index) => (
              <div
                className="mc-trend__row"
                data-series={one.key}
                key={one.key}
              >
                <span className="mc-trend__name">{one.label}</span>
                {groupIndex === 0 && index === 0 ? (
                  <span className="mc-trend__scale" aria-hidden="true">
                    <span>{max}</span>
                    <span>{Math.ceil(max / 2)}</span>
                    <span>{max - max}</span>
                  </span>
                ) : (
                  <span className="mc-trend__scale" aria-hidden="true" />
                )}
                <span className="mc-trend__track">
                  {periods.map((period, column) => {
                    const count = one.counts[column] ?? 0;
                    const share = Math.round((count / max) * FULL);

                    return (
                      // The count on the slot and not on the bar: a period that
                      // counted nothing draws no bar, and its slot still has to
                      // say it counted nothing rather than disappear from the row.
                      <span
                        className="mc-trend__slot"
                        key={period}
                        title={period}
                        data-count={count}
                      >
                        {count > 0 ? (
                          <span
                            className="mc-trend__bar"
                            aria-hidden="true"
                            style={{
                              height: `${Math.max(share, MINIMUM_VISIBLE)}%`,
                            }}
                          >
                            {/* A non-zero fact must be readable from the bar
                              itself, not only from the pointer tooltip. */}
                            <span
                              className="mc-trend__value"
                              aria-hidden="true"
                            >
                              {count}
                            </span>
                          </span>
                        ) : null}
                      </span>
                    );
                  })}
                </span>
                <span className="mc-trend__peak">{one.peakLabel}</span>
              </div>
            ))}
          </div>
        ))}

        {/* The two ends of the axis, so a column's place in time is readable
            without hovering it: the periods run oldest to newest, and only the
            ends are written, because thirty labels under a strip is a line
            nobody reads. Every column carries its own period as a tooltip. */}
        {first === undefined ? null : (
          <>
            <p className="mc-trend__axis">
              <span>{first}</span>
              {last === undefined ? null : <span>{last}</span>}
            </p>
            <p className="mc-trend__axis-title mc-trend__axis-title--x">
              {axes.x}
            </p>
          </>
        )}
      </div>

      {note === undefined ? null : <p className="mc-trend__note">{note}</p>}
    </div>
  );
}
