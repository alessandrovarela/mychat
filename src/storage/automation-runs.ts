import { and, eq } from "drizzle-orm";
import type { MyChatDatabase } from "./database.js";
import { automationRuns } from "./schema.js";

/**
 * Once-per-contact suppression (REQ-015, REQ-239, REQ-240).
 *
 * Keyed by the PAIR (automation, contact). That is a corrected error worth
 * restating: keyed by FLOW, a contact who received one publication's material
 * could never receive another's, because both automations share the flow.
 * Keyed by automation, each publication reaches them once, which is what an
 * operator means by "once per contact".
 *
 * The mark is spent at the DELIVERY and never at the start of a run (REQ-239).
 * For an automation with no private delivery, its public comment reply IS that
 * delivery, and the dispatcher claims here immediately before queuing it
 * (REQ-348, ADR-025).
 * Spent at the start it burned the one chance of a contact who received
 * nothing at all: they commented, were asked a question, went quiet, and the
 * automation was closed to them for ever. Phase 3l made that the ordinary path
 * rather than the rare one, because a comment on another publication now ends
 * the run they were in (REQ-236), so the very rule an operator switches on to
 * avoid a SECOND delivery was preventing the FIRST.
 *
 * `claim` is still one INSERT against the composite primary key rather than
 * read-then-write, and moving it did not weaken that: it is the same atomic
 * write, asked at the moment the run hands something over. Two events of the
 * same contact arriving together both pass the read this store also offers
 * (`hasRun`), both run, and exactly one of them wins this INSERT; the loser
 * delivers nothing (REQ-240). Nothing about that decision was delegated to the
 * send queue, whose identity is per execution and step and therefore does not
 * collide across two runs of one automation.
 */
export interface AutomationRunStore {
  /**
   * Takes this contact's one chance at this automation, for this run.
   *
   * True means deliver: either the mark was written now, or it was already
   * written BY THIS RUN. The second half is what lets one run deliver more
   * than once (a message, a question, then the file) without its own mark
   * refusing it halfway through.
   *
   * False means another run has already delivered to this contact, and this
   * one must hand nothing over.
   */
  claim(
    automationId: string,
    contactId: string,
    executionId: string,
    at: Date,
  ): Promise<boolean>;
  /** True if some run has already delivered to this pair. */
  hasRun(automationId: string, contactId: string): Promise<boolean>;
  /**
   * Drops every run of one automation, and says how many went (REQ-120).
   *
   * Called by the deletion path in `src/flows/automations.ts`, which is what
   * makes the sentence above a behaviour rather than an intention: until then
   * this method existed and was tested, no deletion anywhere called it, and an
   * automation recreated under the same id inherited the suppression of every
   * contact the old one had served.
   */
  forget(automationId: string): Promise<number>;
}

export function createAutomationRunStore(
  db: MyChatDatabase,
): AutomationRunStore {
  function markOf(
    automationId: string,
    contactId: string,
  ): { executionId: string | null } | undefined {
    return db
      .select()
      .from(automationRuns)
      .where(
        and(
          eq(automationRuns.automationId, automationId),
          eq(automationRuns.contactId, contactId),
        ),
      )
      .all()[0];
  }

  return {
    claim(
      automationId: string,
      contactId: string,
      executionId: string,
      at: Date,
    ): Promise<boolean> {
      const inserted = db
        .insert(automationRuns)
        .values({ automationId, contactId, firstRunAt: at, executionId })
        .onConflictDoNothing()
        .returning()
        .all();

      if (inserted.length > 0) return Promise.resolve(true);

      // Read only on the path that already lost the INSERT, and read a row
      // nothing ever updates: the answer cannot change between the write above
      // and this select, so asking twice is not the read-then-write the INSERT
      // exists to avoid.
      //
      // A row carrying no execution id was written by the older code at the
      // START of a run, so it names no delivery and belongs to no run this
      // process is holding. It refuses, which is the safer of the two errors:
      // a contact who did receive is not sent a second copy.
      return Promise.resolve(
        markOf(automationId, contactId)?.executionId === executionId,
      );
    },

    hasRun(automationId: string, contactId: string): Promise<boolean> {
      return Promise.resolve(markOf(automationId, contactId) !== undefined);
    },

    forget(automationId: string): Promise<number> {
      const removed = db
        .delete(automationRuns)
        .where(eq(automationRuns.automationId, automationId))
        .returning()
        .all();

      return Promise.resolve(removed.length);
    },
  };
}
