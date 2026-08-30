import { eq } from "drizzle-orm";
import type { MyChatDatabase } from "../storage/database.js";
import { receivedEvents } from "../storage/schema.js";

/**
 * Remembers which deliveries were already accepted (REQ-004).
 *
 * `claim` is deliberately a single INSERT rather than a read-then-write: two
 * redeliveries arriving at the same moment would both pass a read, and both
 * would run the flow. The primary key is what makes the second one lose, and
 * it does so inside the database rather than in application logic that has to
 * be reasoned about.
 */
export interface ReceivedEventStore {
  /** True if this id is new (the caller owns it), false if already seen. */
  claim(eventId: string, at: Date): Promise<boolean>;
  seen(eventId: string): Promise<boolean>;
}

export function createReceivedEventStore(
  db: MyChatDatabase,
): ReceivedEventStore {
  return {
    claim(eventId: string, at: Date): Promise<boolean> {
      const inserted = db
        .insert(receivedEvents)
        .values({ eventId, receivedAt: at })
        .onConflictDoNothing()
        .returning()
        .all();

      return Promise.resolve(inserted.length > 0);
    },

    seen(eventId: string): Promise<boolean> {
      const rows = db
        .select()
        .from(receivedEvents)
        .where(eq(receivedEvents.eventId, eventId))
        .all();

      return Promise.resolve(rows.length > 0);
    },
  };
}
