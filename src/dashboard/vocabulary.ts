/**
 * The closed vocabularies the panel is expressed in: which period is asked for,
 * how finely it is cut, and which band a ceiling's consumption falls in.
 *
 * They live apart from `aggregate.ts` for ONE reason, and it is the compiler's
 * and not taste: this module imports NOTHING. `aggregate.ts` reaches the trail,
 * the durable work store and the configuration, and through them a database
 * driver, so the interface's program (`src/web/tsconfig.json`, the only one in
 * the repository with a DOM and without node types) must never compile it. A
 * file with no imports of its own costs that program nothing, which is what
 * lets the interface hold its OWN declarations of these three words against
 * these ones by assignment (REQ-192, pinned in
 * `src/web/screens/dashboard.test.tsx`) instead of by eye.
 *
 * The interface still declares the three words itself, deliberately: its types
 * are the screen's contract with the wire and not a window onto this layer's
 * internals, and the two programs are separate on purpose. What the pin takes
 * away is not the second spelling, it is the freedom of the two to disagree in
 * silence.
 */

/**
 * The three ranges the screen offers. Values are identifiers, never labels: an
 * operator-facing name for each one belongs in the catalogue.
 */
export const DASHBOARD_RANGES = [
  "last_24_hours",
  "last_7_days",
  "last_30_days",
] as const;

export type DashboardRange = (typeof DASHBOARD_RANGES)[number];

/**
 * How finely a range is cut. Not a choice of its own: `aggregate.ts` derives it
 * from the range, because a thirty-day chart by hour is 720 columns nobody can
 * read.
 */
export type BucketGranularity = "hour" | "day";

/**
 * Which band a ceiling's consumption falls in. The thresholds that decide it
 * come from configuration, never from a literal, so this union is the shape of
 * the answer and never the answer itself.
 */
export type CapStatus = "normal" | "attention" | "critical";

/**
 * The period a cap is measured over. It is not decoration: the screen reads it
 * to decide WHICH caveat a meter carries, so a spelling out of step here prints
 * the wrong sentence beside a real number.
 *
 * It joined this module one phase after the three above (REQ-196, and they were
 * REQ-192). The reason is worth keeping: it was found BESIDE them, in the same
 * two files, and named in neither requirement, so the pin was built, the family
 * was declared closed, and the fourth member stayed outside it. A guard that
 * knows its members by name only ever guards the members someone listed.
 */
export type CapWindow = "hour" | "second";
