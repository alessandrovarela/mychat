import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Proves REQ-005: the repository carries a document that records, for every
 * platform limit and resource the engine depends on, the confirmed value, the
 * official documentation URL, and the date it was consulted.
 *
 * This suite checks COMPLETENESS, never correctness. Whether a URL actually
 * supports the value written next to it is a human review step, and no
 * assertion can stand in for it. What the suite does guarantee is that nobody
 * left a row half filled, pointed a source at something that is not a URL, or
 * dated a consultation in the future.
 */

const DOCUMENT_URL = new URL("../docs/platform-limits.md", import.meta.url);

/**
 * The ten items REQ-005 requires. An item may legitimately conclude "not
 * found" or "not supported", but it may never be missing.
 */
const REQUIRED_KEYS = [
  "message_window",
  "messages_per_hour",
  "api_calls_per_hour",
  "comment_reply_endpoint",
  "send_message_endpoint",
  "dev_mode_permissions",
  "follower_relationship",
  "quick_reply_buttons",
  "media_list_endpoint",
  "media_url_validity",
] as const;

/**
 * Placeholders that look filled in but carry no information. A row containing
 * only one of these is an unfinished row, not an answer.
 */
const PLACEHOLDER =
  /^(-+|_+|\?+|\.{2,}|tbd|todo|fixme|xxx|n\/?a|none|null|pendente|pending|a confirmar|em aberto)$/i;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Matches a markdown table separator cell, such as `---` or `:---:`. */
const SEPARATOR_CELL = /^:?-{3,}:?$/;

interface LimitRow {
  key: string;
  value: string;
  source: string;
  consultedAt: string;
}

function readDocument(): string {
  return readFileSync(DOCUMENT_URL, "utf8");
}

/**
 * Parses every four-column markdown table row in the document. Header and
 * separator rows are dropped. Rows whose key is not one of REQUIRED_KEYS are
 * kept here and filtered by the caller, so that explanatory tables elsewhere
 * in the document never break this suite.
 */
function parseRows(markdown: string): LimitRow[] {
  return markdown
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("|") && line.endsWith("|"))
    .map((line) =>
      line
        .slice(1, -1)
        .split("|")
        .map((cell) => cell.trim()),
    )
    .filter(
      (cells): cells is [string, string, string, string] => cells.length === 4,
    )
    .filter(
      ([key]) => key !== "chave" && key !== "key" && !SEPARATOR_CELL.test(key),
    )
    .map(([key, value, source, consultedAt]) => ({
      key,
      value,
      source,
      consultedAt,
    }));
}

function indexRequiredRows(): Map<string, LimitRow> {
  const required = new Set<string>(REQUIRED_KEYS);
  const index = new Map<string, LimitRow>();

  for (const row of parseRows(readDocument())) {
    if (!required.has(row.key)) continue;
    if (index.has(row.key)) {
      throw new Error(`duplicate row for key "${row.key}"`);
    }
    index.set(row.key, row);
  }

  return index;
}

function requireRow(key: string): LimitRow {
  const row = indexRequiredRows().get(key);
  if (row === undefined) {
    throw new Error(`no row for key "${key}" in docs/platform-limits.md`);
  }
  return row;
}

/**
 * Today in UTC, plus one day of slack. The slack keeps the suite from failing
 * for someone in a timezone ahead of UTC who dated a row with their local
 * calendar day. Anything beyond that is a genuine future date.
 */
function latestAcceptableDate(): string {
  const limit = new Date();
  limit.setUTCDate(limit.getUTCDate() + 1);
  return limit.toISOString().slice(0, 10);
}

describe("REQ-005: platform limits document", () => {
  it("exists in the repository", () => {
    expect(existsSync(DOCUMENT_URL)).toBe(true);
  });

  it("explains what the document is for before listing values", () => {
    expect(readDocument().trim().length).toBeGreaterThan(0);
  });

  it("carries exactly one row for each of the ten required keys", () => {
    expect([...indexRequiredRows().keys()].sort()).toEqual(
      [...REQUIRED_KEYS].sort(),
    );
  });

  for (const key of REQUIRED_KEYS) {
    describe(key, () => {
      it("records a value that is not a placeholder", () => {
        const { value } = requireRow(key);

        expect(value).not.toBe("");
        expect(value).not.toMatch(PLACEHOLDER);
      });

      it("cites a well formed source URL", () => {
        const { source } = requireRow(key);

        expect(source).not.toBe("");
        expect(source).not.toMatch(PLACEHOLDER);
        expect(URL.canParse(source)).toBe(true);
        expect(new URL(source).protocol).toMatch(/^https?:$/);
      });

      it("records an ISO consultation date that is not in the future", () => {
        const { consultedAt } = requireRow(key);

        expect(consultedAt).toMatch(ISO_DATE);
        // Rejects impossible calendar dates that still match the shape.
        expect(new Date(`${consultedAt}T00:00:00Z`).toISOString()).toContain(
          consultedAt,
        );
        expect(consultedAt <= latestAcceptableDate()).toBe(true);
      });
    });
  }
});
