import { asc } from "drizzle-orm";
import type { UnifiedAutomation } from "../flows/schema.js";
import { readAutomationDocument } from "./automation-document.js";
import type { MyChatDatabase } from "./database.js";
import { automationAggregates } from "./schema.js";

/**
 * An automation this publication carries: which one it is, and whether it runs.
 *
 * No name, and none to give (REQ-279): an automation is named after the
 * publication's caption at the moment of showing, and the caller asking this
 * question is the grid that already holds that caption on the tile.
 */
export interface PublicationAutomationReference {
  readonly id: string;
  readonly enabled: boolean;
}

export interface PublicationAutomationCoverage {
  readonly publicationId: string;
  readonly active: number;
  readonly inactive: number;
  readonly automations: readonly PublicationAutomationReference[];
}

/**
 * An automation that EXISTS and cannot be read (REQ-294).
 *
 * The counterpart of the coverage above, and it exists because of what the
 * silence cost once already: when `name` left the format in phase 3l the rows
 * written under the old shape stopped parsing, this reader dropped them, and
 * the operator watched the list get shorter with nothing said. The attachment
 * left the format the same way (REQ-284) and by the same explicit decision, so
 * the same rows are about to stop parsing again. The refusal is right; the
 * dropping is the defect.
 *
 * Nothing here comes from the document, because the document is the thing that
 * cannot be read. The identifier and the publication are read off their own
 * COLUMNS, which the store writes at save time, so a row nobody can parse is
 * still located.
 */
export interface UnreadableAutomation {
  readonly id: string;
  /** The publication it was stored against, when it was stored against one. */
  readonly publicationId?: string;
}

export interface PublicationAutomationCoverageReader {
  read(
    publicationIds: readonly string[],
  ): Promise<readonly PublicationAutomationCoverage[]>;
  /**
   * Every stored automation the current schema refuses, whatever it watches.
   *
   * It takes no page and it is not per publication on purpose: an automation
   * the schema refuses may watch a publication that is nowhere near the page
   * being drawn, or no publication at all, and a question scoped to a page
   * would answer "nothing to report" on precisely the screen the operator is
   * standing on when the list goes short.
   */
  unreadable(): Promise<readonly UnreadableAutomation[]>;
}

/**
 * The stored document as the CURRENT schema reads it, or nothing at all.
 *
 * The parse itself is shared with the repository (`readAutomationDocument`),
 * and that is what keeps the two sides of this answer from drifting: the
 * listing drops exactly the rows this file reports, so a refused document is
 * counted once on each side instead of once and then never again.
 */
function parsedDefinitionOf(definition: string): UnifiedAutomation | undefined {
  const document = readAutomationDocument(definition);
  return document.ok ? document.definition : undefined;
}

/**
 * Answers a page of publications (REQ-208) and what cannot be read (REQ-294).
 *
 * It takes the database and not the automation repository, and the reason
 * survives the repository having stopped throwing (REQ-294): `list()` answers
 * what this version CAN read, which is by definition everything except the
 * rows these two questions exist to report. Only the table itself still holds
 * them, and only their columns still name them.
 *
 * Both questions therefore walk the aggregate rows and parse in application
 * code, which the comment here used to deny. It is one small table, one row
 * per automation in the instance, and the coverage half still asks nothing at
 * all when the page names no publication.
 */
export function createPublicationAutomationCoverageReader(
  db: MyChatDatabase,
): PublicationAutomationCoverageReader {
  return {
    read(
      publicationIds: readonly string[],
    ): Promise<readonly PublicationAutomationCoverage[]> {
      const ids = [...new Set(publicationIds)];
      if (ids.length === 0) {
        return Promise.resolve([]);
      }

      const rows = db
        .select({ definition: automationAggregates.definition })
        .from(automationAggregates)
        .orderBy(asc(automationAggregates.id))
        .all()
        .flatMap((row) => {
          // A document this reader cannot parse is not covered and not
          // dropped: it leaves by this branch and comes back under
          // `unreadable` below, which is the same row counted once on each
          // side rather than once and then never again (REQ-294).
          const definition = parsedDefinitionOf(row.definition);
          if (
            definition === undefined ||
            definition.trigger?.type !== "comment"
          )
            return [];

          const target = definition.trigger.target;
          if (target === undefined || !ids.includes(target)) return [];
          return [
            {
              id: definition.id,
              enabled: definition.state === "active",
              target,
            },
          ];
        });

      return Promise.resolve(
        ids.map((publicationId) => {
          const own = rows
            .filter((row) => row.target === publicationId)
            .map(({ id, enabled }) => ({ id, enabled }));

          return {
            publicationId,
            active: own.filter((automation) => automation.enabled).length,
            inactive: own.filter((automation) => !automation.enabled).length,
            automations: own,
          };
        }),
      );
    },

    unreadable(): Promise<readonly UnreadableAutomation[]> {
      const found = db
        .select({
          id: automationAggregates.id,
          definition: automationAggregates.definition,
          publicationTarget: automationAggregates.publicationTarget,
        })
        .from(automationAggregates)
        .orderBy(asc(automationAggregates.id))
        .all()
        .filter((row) => parsedDefinitionOf(row.definition) === undefined)
        .map((row) => ({
          id: row.id,
          ...(row.publicationTarget !== null && {
            publicationId: row.publicationTarget,
          }),
        }));

      return Promise.resolve(found);
    },
  };
}
