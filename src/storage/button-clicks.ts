import { and, asc, count, desc, eq, gte, inArray, lte } from "drizzle-orm";
import type { Clock } from "../engine/ports.js";
import { t } from "../i18n/index.js";
import type { MyChatDatabase } from "./database.js";
import { StorageError } from "./errors.js";
import { buttonClicks, buttonDestinations } from "./schema.js";
import type { ButtonDestinationRow } from "./schema.js";

export interface ButtonDestination {
  readonly id: number;
  readonly automationId: string;
  readonly buttonId: string;
  readonly version: number;
  readonly url: string;
  /** The label shown to the contact for this immutable destination version. */
  readonly label?: string;
  readonly createdAt: Date;
}

export interface AttributedButtonClick {
  readonly occurredAt: Date;
  readonly automationId: string;
  readonly buttonId: string;
  readonly destinationId: number;
  readonly destinationVersion: number;
  readonly contactId: string;
  readonly executionId: string;
  /** Label as it was when this click was recorded, absent for legacy clicks. */
  readonly buttonLabel?: string;
}

export interface ButtonClickMetrics {
  readonly automationId: string;
  readonly total: number;
  readonly buttons: readonly {
    readonly buttonId: string;
    readonly total: number;
  }[];
}

/** A recorded click restricted to application-owned analytics facts. */
export type ButtonClickSample = AttributedButtonClick;

export interface ButtonClickStore {
  destinationFor(
    automationId: string,
    buttonId: string,
    url: string,
    at: Date,
    label?: string,
  ): Promise<ButtonDestination>;
  findDestination(id: number): Promise<ButtonDestination | undefined>;
  record(click: AttributedButtonClick): Promise<void>;
  metrics(automationId: string): Promise<ButtonClickMetrics>;
  /**
   * The same counts for a whole listing, in ONE grouped read.
   *
   * Not a loop over `metrics`, and not a scan sliced in memory either: the
   * database groups, so what crosses the boundary is one row per button and
   * never one row per click.
   *
   * Every requested automation comes back, including the ones nobody clicked.
   * A measured zero is an answer, and leaving it out would make the caller
   * decide what an absent key means.
   */
  metricsForAutomations(
    automationIds: readonly string[],
  ): Promise<ReadonlyMap<string, ButtonClickMetrics>>;
  samples(since: Date, until: Date): Promise<readonly ButtonClickSample[]>;
}

interface CollectedMetrics {
  readonly automationId: string;
  total: number;
  readonly buttons: { readonly buttonId: string; readonly total: number }[];
}

/**
 * Persistent versioned destinations and their append-only attributed clicks.
 * No method can update or remove either history.
 */
export function createButtonClickStore(db: MyChatDatabase): ButtonClickStore {
  function present(row: ButtonDestinationRow): ButtonDestination {
    return {
      id: row.id,
      automationId: row.automationId,
      buttonId: row.buttonId,
      version: row.version,
      url: row.url,
      ...(row.label !== null && { label: row.label }),
      createdAt: row.createdAt,
    };
  }

  return {
    async destinationFor(automationId, buttonId, rawUrl, at, label) {
      const url = validatedDestination(rawUrl);

      const destination = db.transaction((tx) => {
        const latest = tx
          .select()
          .from(buttonDestinations)
          .where(
            and(
              eq(buttonDestinations.automationId, automationId),
              eq(buttonDestinations.buttonId, buttonId),
            ),
          )
          .orderBy(desc(buttonDestinations.version))
          .get();

        // Reusing the exact presentation keeps its version. A new label is a
        // new historical fact even when it points at the same URL.
        if (latest?.url === url && latest.label === (label ?? null))
          return latest;

        const [inserted] = tx
          .insert(buttonDestinations)
          .values({
            automationId,
            buttonId,
            version: (latest?.version ?? 0) + 1,
            url,
            label: label ?? null,
            createdAt: at,
          })
          .returning()
          .all();

        if (inserted === undefined) {
          throw new StorageError(
            t("storage.buttonDestinationNotStored", { automationId, buttonId }),
          );
        }
        return inserted;
      });

      return present(destination);
    },

    findDestination(id) {
      const row = db
        .select()
        .from(buttonDestinations)
        .where(eq(buttonDestinations.id, id))
        .get();
      return Promise.resolve(row === undefined ? undefined : present(row));
    },

    record(click) {
      db.insert(buttonClicks).values(click).run();
      return Promise.resolve();
    },

    async metrics(automationId) {
      const totalRow = db
        .select({ total: count() })
        .from(buttonClicks)
        .where(eq(buttonClicks.automationId, automationId))
        .get();
      const grouped = db
        .select({ buttonId: buttonClicks.buttonId, total: count() })
        .from(buttonClicks)
        .where(eq(buttonClicks.automationId, automationId))
        .groupBy(buttonClicks.buttonId)
        .orderBy(asc(buttonClicks.buttonId))
        .all();

      return {
        automationId,
        total: totalRow?.total ?? 0,
        buttons: grouped,
      };
    },

    async metricsForAutomations(automationIds) {
      // Asked twice for the same automation, answered once: the identifier is
      // the key of the answer, so a repeated one cannot double any count.
      const wanted = [...new Set(automationIds)];
      const collected = new Map<string, CollectedMetrics>(
        wanted.map((automationId) => [
          automationId,
          { automationId, total: 0, buttons: [] },
        ]),
      );
      if (wanted.length === 0) return collected;

      const grouped = db
        .select({
          automationId: buttonClicks.automationId,
          buttonId: buttonClicks.buttonId,
          total: count(),
        })
        .from(buttonClicks)
        .where(inArray(buttonClicks.automationId, wanted))
        .groupBy(buttonClicks.automationId, buttonClicks.buttonId)
        .orderBy(asc(buttonClicks.automationId), asc(buttonClicks.buttonId))
        .all();

      for (const row of grouped) {
        const entry = collected.get(row.automationId);
        if (entry === undefined) continue;
        entry.buttons.push({ buttonId: row.buttonId, total: row.total });
        // The button groups partition the automation's clicks, because
        // `button_id` is NOT NULL, so their sum is the same number the single
        // read counts over the rows.
        entry.total += row.total;
      }
      return collected;
    },

    async samples(since, until) {
      const rows = db
        .select({
          occurredAt: buttonClicks.occurredAt,
          automationId: buttonClicks.automationId,
          buttonId: buttonClicks.buttonId,
          destinationId: buttonClicks.destinationId,
          destinationVersion: buttonClicks.destinationVersion,
          contactId: buttonClicks.contactId,
          executionId: buttonClicks.executionId,
          buttonLabel: buttonClicks.buttonLabel,
        })
        .from(buttonClicks)
        .where(
          and(
            gte(buttonClicks.occurredAt, since),
            lte(buttonClicks.occurredAt, until),
          ),
        )
        .orderBy(asc(buttonClicks.occurredAt), asc(buttonClicks.id))
        .all();
      return rows.map(({ buttonLabel, ...click }) => ({
        ...click,
        ...(buttonLabel !== null && { buttonLabel }),
      }));
    },
  };
}

/** Defense at persistence: only destinations the route can safely reveal exist. */
function validatedDestination(raw: string): string {
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error("unsupported protocol");
    }
    return parsed.href;
  } catch (cause) {
    throw new StorageError(t("storage.buttonDestinationInvalid"), { cause });
  }
}

/** Small clock adapter convenient for focused callers and tests. */
export function recordButtonClick(
  store: Pick<ButtonClickStore, "record">,
  clock: Clock,
  click: Omit<AttributedButtonClick, "occurredAt">,
): Promise<void> {
  return store.record({ ...click, occurredAt: clock.now() });
}
