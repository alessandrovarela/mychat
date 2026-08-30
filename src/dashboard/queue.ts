import { asc, eq } from "drizzle-orm";
import type { MyChatDatabase } from "../storage/database.js";
import { durableWork } from "../storage/schema.js";
import type { PendingWork, QueueSource } from "./aggregate.js";
import type { WorkKind } from "../storage/durable-work.js";

/**
 * The queue side of the dashboard (REQ-040).
 *
 * `DurableWorkStore` answers the questions the SWEEP asks (what is due, what
 * has been concluded); the operator asks a different one, about a backlog that
 * includes work not due yet, and about how long the oldest item has been
 * waiting. That is a read this table supports and that store does not expose,
 * so the adapter lives here instead of widening an interface the sweep would
 * never call.
 *
 * `createdAt` and not `dueAt`, on purpose: a deferred item has its due instant
 * pushed FORWARD every time it is retried, so an item stuck for a day would
 * report itself as brand new. What an operator means by "the oldest" is how
 * long something has been waiting, which is when it entered the queue.
 */
export function createQueueSource(db: MyChatDatabase): QueueSource {
  return {
    pending(): Promise<readonly PendingWork[]> {
      const rows = db
        .select({ kind: durableWork.kind, createdAt: durableWork.createdAt })
        .from(durableWork)
        .where(eq(durableWork.status, "pending"))
        .orderBy(asc(durableWork.createdAt))
        .all();

      return Promise.resolve(
        rows.map((row) => ({
          kind: row.kind as WorkKind,
          createdAt: row.createdAt,
        })),
      );
    },
  };
}
