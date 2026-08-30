import type { ReactElement, ReactNode } from "react";

/**
 * DataTable: the panel's counting tables, kept as tables.
 *
 * The handoff is explicit about this one: the table was a deliberate choice,
 * the numbers are the answer to "does this match the record", and a screen
 * reader can walk them. The request was to ADD a visual reading, not to replace
 * one. So this renders a real `<table>` with a caption, row headers and a total
 * row, and optionally draws a proportional bar INSIDE the numeric cell: the
 * figure stays where it was, the bar sits beside it and is `aria-hidden`,
 * because it says nothing the figure does not already say.
 *
 * The caption carries the note that belongs to these numbers (counted when a
 * message is accepted for sending, not when the platform confirms delivery).
 * It is a `<caption>` and not a paragraph underneath so it is announced with
 * the table, before the figures it qualifies.
 */

export interface TableColumn {
  /** The first column is the row label; the rest are numeric. */
  readonly key: string;
  readonly label: string;
}

export interface TableRow {
  readonly key: string;
  /** The period, already formatted by the caller for its locale. */
  readonly label: ReactNode;
  readonly cells: Readonly<Record<string, number | string>>;
}

export interface TableTotal {
  readonly label: string;
  readonly cells: Readonly<Record<string, number | string>>;
}

export interface DataTableProps {
  /** The note that belongs to these numbers, above the head. */
  readonly caption?: ReactNode;
  readonly columns: readonly TableColumn[];
  readonly rows: readonly TableRow[];
  readonly total?: TableTotal;
  /** Draws a proportional bar beside each figure. The figure always stays. */
  readonly bars?: boolean;
}

/**
 * How long the bar of the largest value is, in px.
 *
 * A measurement of this widget rather than a step of any ladder: the bar shares
 * a cell with the figure, and it is sized so the figure is never pushed out of
 * a narrow column.
 */
const BAR_MAX_PIXELS = 56;

/**
 * A count written as text: digits, and the punctuation a locale groups them
 * with. `1234`, `1,234` in English, `1.234` in Portuguese, all the same count.
 *
 * Groups of exactly three digits, so a fraction (`12.5`) is refused rather than
 * read as a hundred and twenty five: these are counting tables, and a separator
 * followed by anything but a triplet is not grouping.
 */
const COUNT_TEXT = /^(?:\d+|\d{1,3}(?:[.,\s]\d{3})+)$/u;

/** The grouping itself, which is decoration and never part of the value. */
const GROUPING = /[.,\s]/gu;

/**
 * What a cell is worth for SIZING, or undefined when it is not a count.
 *
 * A cell arrives as a number or as text the caller already formatted for its
 * locale, and reading that text with `Number()` fails twice over (REQ-155):
 * the English `"1,234"` is `NaN`, and since the tallest bar is a `Math.max`
 * over every cell, one `NaN` erases EVERY bar in the table; the Portuguese
 * `"1.234"` reads as `1.234`, so the largest count in the table draws the
 * shortest bar. The digits are the value in both, and the punctuation between
 * them is the locale's.
 *
 * A cell this cannot read (a percentage, a duration, a word) is sized by
 * nothing: it draws no bar of its own and takes no part in the maximum, so it
 * can no longer flatten the bars that ARE countable. The figure itself is
 * printed as it came, always, and the bars are `aria-hidden` decoration, so
 * nothing that is read out depends on any of this.
 */
function countOf(cell: number | string): number | undefined {
  if (typeof cell === "number") {
    return Number.isFinite(cell) ? cell : undefined;
  }

  const text = cell.trim();

  return COUNT_TEXT.test(text) ? Number(text.replace(GROUPING, "")) : undefined;
}

export function DataTable({
  caption,
  columns,
  rows,
  total,
  bars = false,
}: DataTableProps): ReactElement {
  const [, ...valueColumns] = columns;

  // The tallest bar is the largest figure in the table, so the bars compare
  // rows against each other and never against a ceiling nobody declared. The
  // floor of 1 keeps an all-zero table from dividing by zero, and a cell that
  // is not a count contributes nothing rather than poisoning the maximum.
  const max = bars
    ? Math.max(
        1,
        ...rows.flatMap((row) =>
          valueColumns.flatMap((column) => {
            const count = countOf(row.cells[column.key] ?? 0);

            return count === undefined ? [] : [count];
          }),
        ),
      )
    : 1;

  return (
    <div className="mc-tablewrap">
      <table className="mc-table">
        {caption === undefined ? null : <caption>{caption}</caption>}
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column.key} scope="col">
                {column.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.key}>
              <th scope="row">{row.label}</th>
              {valueColumns.map((column) => {
                const value = row.cells[column.key] ?? 0;
                const count = countOf(value) ?? 0;

                return (
                  <td key={column.key}>
                    <span className="mc-table__cell">
                      {bars && count > 0 ? (
                        <span
                          className="mc-table__bar"
                          aria-hidden="true"
                          style={{
                            width: `${Math.round((count / max) * BAR_MAX_PIXELS)}px`,
                          }}
                        />
                      ) : null}
                      <span>{value}</span>
                    </span>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
        {total === undefined ? null : (
          <tfoot>
            <tr>
              <th scope="row">{total.label}</th>
              {valueColumns.map((column) => (
                <td key={column.key}>{total.cells[column.key] ?? 0}</td>
              ))}
            </tr>
          </tfoot>
        )}
      </table>
    </div>
  );
}
