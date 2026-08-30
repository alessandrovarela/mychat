import { eq } from "drizzle-orm";
import type { MyChatDatabase } from "./database.js";
import { contactConversations } from "./schema.js";

/**
 * When each contact last wrote to the account.
 *
 * The distinction this store exists to keep: a COMMENT does not count. Only a
 * message from the contact opens a conversation, and that is not a technicality
 * — it is the finding behind REQ-066. Commenting does not put the account in
 * the contact's inbox, so a first message carrying a link lands in requests and,
 * repeated at volume, trips the spam filter. Counting comments here would erase
 * exactly the distinction the phase was built around.
 */

export interface ConversationStore {
  /** Records that the contact wrote to the account. Never called for comments. */
  noteInbound(contactId: string, at: Date): Promise<void>;
  /** Undefined when this contact has never written. */
  lastInboundAt(contactId: string): Promise<Date | undefined>;
}

export function createConversationStore(db: MyChatDatabase): ConversationStore {
  return {
    noteInbound(contactId: string, at: Date): Promise<void> {
      db.insert(contactConversations)
        .values({ contactId, lastInboundAt: at })
        .onConflictDoUpdate({
          target: contactConversations.contactId,
          set: { lastInboundAt: at },
        })
        .run();

      return Promise.resolve();
    },

    lastInboundAt(contactId: string): Promise<Date | undefined> {
      const [row] = db
        .select()
        .from(contactConversations)
        .where(eq(contactConversations.contactId, contactId))
        .all();

      return Promise.resolve(row?.lastInboundAt);
    },
  };
}
