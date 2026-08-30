import { eq } from "drizzle-orm";
import type {
  AttributeValue,
  ContactAttributes,
  ContactRepo,
} from "../engine/ports.js";
import type { MyChatDatabase } from "./database.js";
import { contactAttributes } from "./schema.js";

/**
 * Contact attributes that outlive the execution that wrote them (REQ-028).
 *
 * This is the concrete side of the engine's `ContactRepo` port: the engine
 * declares what it needs, this supplies it, and the engine never learns that a
 * database exists (ADR-003).
 *
 * Why persistence is the requirement and not an optimisation: an attribute is
 * how one execution tells a LATER one what it already knows — that this contact
 * gave their e-mail, that they already confirmed. Kept in memory it would be
 * forgotten by the next deploy, and the contact would be asked again for
 * something they already answered.
 */

function encode(value: AttributeValue): string {
  return JSON.stringify(value);
}

function decode(raw: string): AttributeValue {
  // Values are written by `encode` above, so a parse failure means the row was
  // touched by something else. Reading it as the literal string is the least
  // destructive answer: it keeps the attribute visible instead of losing it.
  try {
    return JSON.parse(raw) as AttributeValue;
  } catch {
    return raw;
  }
}

export interface ContactAttributeStore extends ContactRepo {
  /** Every attribute of every contact, for the operator's inspection. */
  forget(contactId: string): Promise<number>;
}

export function createContactRepository(
  db: MyChatDatabase,
  now: () => Date,
): ContactAttributeStore {
  return {
    getAttributes(contactId: string): Promise<ContactAttributes> {
      const rows = db
        .select()
        .from(contactAttributes)
        .where(eq(contactAttributes.contactId, contactId))
        .all();

      const attributes: Record<string, AttributeValue> = {};
      for (const row of rows) {
        attributes[row.key] = decode(row.value);
      }

      return Promise.resolve(attributes);
    },

    setAttribute(
      contactId: string,
      key: string,
      value: AttributeValue,
    ): Promise<void> {
      const at = now();

      db.insert(contactAttributes)
        .values({ contactId, key, value: encode(value), updatedAt: at })
        .onConflictDoUpdate({
          target: [contactAttributes.contactId, contactAttributes.key],
          set: { value: encode(value), updatedAt: at },
        })
        .run();

      return Promise.resolve();
    },

    forget(contactId: string): Promise<number> {
      const removed = db
        .delete(contactAttributes)
        .where(eq(contactAttributes.contactId, contactId))
        .returning()
        .all();

      return Promise.resolve(removed.length);
    },
  };
}
