import { asc } from "drizzle-orm";
import type { MyChatDatabase } from "./database.js";
import { automationAggregates } from "./schema.js";

/**
 * Where a resource is used, so that deleting it is an informed act (REQ-293).
 *
 * Deleting a file is not undoable and it is not local: the button already
 * delivered to a contact points at `/clicks/<destinationId>`, which redirects
 * to the object, so the file disappearing turns every direct message already
 * sent into a dead link. The operator can only weigh that against something,
 * and this reader is that something.
 */
export interface AssetUsage {
  readonly automationId: string;
  /** Whether the automation using it is running right now. */
  readonly enabled: boolean;
  /** The publication it answers on, when it answers on one. */
  readonly publicationId?: string;
}

export interface AssetUsageReader {
  read(name: string): Promise<readonly AssetUsage[]>;
}

/**
 * The stored definition as text, walked rather than parsed by the flow schema.
 *
 * Deliberate, and the reason is the schema itself. The repository answers with
 * what the CURRENT shape accepts, so a reader built on it would leave out
 * exactly the rows this question is about (REQ-294): a format change is what
 * leaves old automations behind, and that is precisely when somebody asks who
 * still uses a file. An automation nobody can parse still holds the resource's
 * key, and the contacts it already wrote to still have the link.
 *
 * The scan therefore knows nothing about steps, cards or buttons: it looks for
 * the key in every string the document carries, wherever the format of the day
 * puts it. The key is minted (`storeNewAsset`), so a string carrying it is a
 * reference to it and not a coincidence.
 */
function stringsOf(value: unknown, found: string[] = []): string[] {
  if (typeof value === "string") {
    found.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) stringsOf(item, found);
  } else if (typeof value === "object" && value !== null) {
    for (const item of Object.values(value)) stringsOf(item, found);
  }
  return found;
}

function mentions(definition: string, name: string): boolean {
  let document: unknown;
  try {
    document = JSON.parse(definition);
  } catch {
    // Not even JSON: the row is unreadable by anything, and the honest answer
    // to "is the key in there" is still the text itself.
    return definition.includes(name);
  }

  // `includes` and not equality: the key may travel on its own or inside an
  // address built from it, and both are the same file.
  return stringsOf(document).some((value) => value.includes(name));
}

function isActive(definition: string): boolean {
  try {
    const document: unknown = JSON.parse(definition);
    return (
      typeof document === "object" &&
      document !== null &&
      (document as { state?: unknown }).state === "active"
    );
  } catch {
    // An automation the reader cannot parse is not one the dispatcher runs.
    return false;
  }
}

export function createAssetUsageReader(db: MyChatDatabase): AssetUsageReader {
  return {
    read(name: string): Promise<readonly AssetUsage[]> {
      if (name.length === 0) {
        return Promise.resolve([]);
      }

      const usage = db
        .select({
          id: automationAggregates.id,
          definition: automationAggregates.definition,
          publicationTarget: automationAggregates.publicationTarget,
        })
        .from(automationAggregates)
        .orderBy(asc(automationAggregates.id))
        .all()
        .filter((row) => mentions(row.definition, name))
        .map((row) => ({
          automationId: row.id,
          enabled: isActive(row.definition),
          ...(row.publicationTarget !== null && {
            publicationId: row.publicationTarget,
          }),
        }));

      return Promise.resolve(usage);
    },
  };
}
