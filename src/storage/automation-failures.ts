import { eq } from "drizzle-orm";
import type { MyChatDatabase } from "./database.js";
import { automationFailureSequences } from "./schema.js";

/** The moving window named by REQ-200. */
export const AUTOMATION_FAILURE_WINDOW_MS = 10 * 60 * 1000;
export const AUTOMATION_FAILURE_LIMIT = 3;

export interface AutomationFailureSequenceStore {
  recordFailure(automationId: string, at: Date): Promise<readonly Date[]>;
  reset(automationId: string): Promise<void>;
  read(automationId: string): Promise<readonly Date[]>;
}

function parse(value: string): Date[] {
  const decoded = JSON.parse(value) as unknown;
  if (!Array.isArray(decoded)) return [];
  return decoded
    .filter((instant): instant is number => Number.isFinite(instant))
    .map((instant) => new Date(instant));
}

export function createAutomationFailureSequenceStore(
  db: MyChatDatabase,
): AutomationFailureSequenceStore {
  function readNow(automationId: string): Date[] {
    const [row] = db
      .select()
      .from(automationFailureSequences)
      .where(eq(automationFailureSequences.automationId, automationId))
      .all();
    return row === undefined ? [] : parse(row.occurredAts);
  }

  return {
    read(automationId: string): Promise<readonly Date[]> {
      return Promise.resolve(readNow(automationId));
    },

    recordFailure(automationId: string, at: Date): Promise<readonly Date[]> {
      const cutoff = at.getTime() - AUTOMATION_FAILURE_WINDOW_MS;
      const sequence = readNow(automationId)
        .filter((instant) => instant.getTime() >= cutoff)
        .concat(at)
        .slice(-AUTOMATION_FAILURE_LIMIT);

      db.insert(automationFailureSequences)
        .values({
          automationId,
          occurredAts: JSON.stringify(
            sequence.map((instant) => instant.getTime()),
          ),
          updatedAt: at,
        })
        .onConflictDoUpdate({
          target: automationFailureSequences.automationId,
          set: {
            occurredAts: JSON.stringify(
              sequence.map((instant) => instant.getTime()),
            ),
            updatedAt: at,
          },
        })
        .run();

      return Promise.resolve(sequence);
    },

    reset(automationId: string): Promise<void> {
      db.delete(automationFailureSequences)
        .where(eq(automationFailureSequences.automationId, automationId))
        .run();
      return Promise.resolve();
    },
  };
}
