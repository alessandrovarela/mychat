import { and, asc, eq, gte, lte } from "drizzle-orm";
import type { MyChatDatabase } from "./database.js";
import { durableWork } from "./schema.js";
import type { DurableWorkRow } from "./schema.js";

/**
 * The durable half of ADR-005: work that must happen even if the process does
 * not survive to do it.
 *
 * This module only stores and hands back work. It decides nothing about WHEN a
 * deferred item comes back (that is the retry budget, `src/runtime/retry.ts`)
 * and nothing about WHAT the work means (that is the handler the sweep calls).
 * Keeping those apart is what lets the send queue, the suspended execution and
 * anything the product adds later share one table without sharing a policy.
 */

/**
 * Every kind of durable work. New kinds join the same table and same sweep.
 *
 * `credential_check` is here rather than on a timer of its own for the same
 * reason the other two share a table (ADR-005): it is work with a due instant
 * that must survive a restart. A separate timer would be a second clock to keep
 * in step, and one that silently stops when the process dies.
 */
export const WORK_KINDS = ["send", "suspension", "credential_check"] as const;
export type WorkKind = (typeof WORK_KINDS)[number];

export const WORK_STATUSES = ["pending", "done", "failed"] as const;
export type WorkStatus = (typeof WORK_STATUSES)[number];

/**
 * Which platform quota a send counts against (REQ-017).
 *
 * `private_reply` is the only one with an official hourly ceiling; the other
 * two differ by per-second quota, an order of magnitude apart, because audio
 * and video are metered separately from text and links.
 */
export const SEND_CLASSES = [
  "private_reply",
  "direct_message",
  "media",
] as const;
export type SendClass = (typeof SEND_CLASSES)[number];

/** What the caller offers. `payload` is the handler's business, not ours. */
export interface WorkRequest {
  readonly kind: WorkKind;
  /**
   * Identity of the work, chosen by the caller. Offering the same key twice is
   * offering the same work once: the UNIQUE column is what enforces it.
   */
  readonly dedupeKey: string;
  readonly payload: unknown;
  /** Not before this instant. Defaults to `now`, i.e. as soon as possible. */
  readonly dueAt?: Date;
  readonly contactId?: string;
  readonly executionId?: string;
  /** Required for a send: it is what the quota is counted against. */
  readonly sendClass?: SendClass;
}

/** A row as the sweep and its handlers see it: payload already parsed. */
export interface WorkItem {
  readonly id: number;
  readonly kind: WorkKind;
  readonly dedupeKey: string;
  readonly status: WorkStatus;
  readonly dueAt: Date;
  readonly attempts: number;
  readonly payload: unknown;
  readonly contactId: string | null;
  readonly executionId: string | null;
  readonly sendClass: SendClass | null;
  readonly lastReason: string | null;
}

export interface EnqueueResult {
  /** False when the key already existed: the work was already known. */
  readonly enqueued: boolean;
  readonly item: WorkItem;
}

export interface DurableWorkStore {
  /** Idempotent by `dedupeKey`. Never throws on a repeat, reports it. */
  enqueue(request: WorkRequest, now: Date): Promise<EnqueueResult>;
  /** Pending work already due, oldest first. The sweep's only read. */
  due(now: Date, limit?: number): Promise<WorkItem[]>;
  /** Concluded. A `done` row is never collected again — the heart of REQ-016. */
  complete(id: number, now: Date): Promise<void>;
  /** Gave up, with the reason kept for the operator. */
  fail(id: number, reason: string, now: Date): Promise<void>;
  /**
   * Back to the queue, later. Counts as an attempt, which is what lets the
   * retry budget end somewhere. `reason` is null for a deliberate deferral
   * (a cap reached) and set for a failure being retried.
   */
  defer(id: number, dueAt: Date, now: Date, reason?: string): Promise<void>;
  find(id: number): Promise<WorkItem | undefined>;
  findByKey(dedupeKey: string): Promise<WorkItem | undefined>;
  /**
   * Every send queued for one execution, oldest first, whatever its status.
   *
   * The queue is what remembers, so a decision that must hold across the whole
   * run survives a restart without any in-memory state: the caller reads what
   * this execution has already asked for and decides from that. The payload is
   * handed back untouched, because what it MEANS is the caller's business and
   * not this module's (see the note at the top).
   */
  sendsFor(executionId: string): Promise<WorkItem[]>;
  /**
   * Concludes sends this execution queued but which have not left yet.
   *
   * A terminal run cannot leave a question behind: its answer would have no
   * execution to receive it. Completed and failed sends stay as they are,
   * because this is retirement, not a rewrite of history.
   */
  retirePendingSends(executionId: string, now: Date): Promise<void>;
  /**
   * Every PENDING suspension of one contact, soonest deadline first (REQ-235).
   *
   * A query about the CONTACT, and that is the whole of it. Routing an inbound
   * message asks "is this person waiting on something", which is a question
   * about them, and answering it by reading the head of the queue made the
   * answer depend on how busy the queue was: a send is due now and a wait is
   * due in hours, so a wait sorts to the TAIL by construction, and a hundred
   * pending sends were enough to hide every one of them. The message then
   * reached trigger matching, started a second run, and handed over a resource
   * the contact had confirmed nothing for, which is the failure REQ-067 exists
   * to prevent.
   *
   * The order is the one the scan produced, kept deliberately: which of two
   * waits an answer belongs to is a product question (see the INBOX), and a fix
   * for a lookup is not the place to decide it.
   */
  pendingSuspensionsFor(contactId: string): Promise<WorkItem[]>;
  /** Pending count, for the operator's status report. */
  countPending(): Promise<number>;
  /**
   * Sends of this class already CONCLUDED at or after `from` — the quota
   * accounting of REQ-017. Concluded, not attempted: a send the platform
   * refused consumed no quota, and counting it would throttle the account for
   * work it never did.
   */
  countCompletedSince(sendClass: SendClass, from: Date): Promise<number>;
  /**
   * When the oldest send still inside the window happened, so the caller can
   * defer to the exact instant the window frees up instead of guessing.
   */
  oldestCompletedSince(
    sendClass: SendClass,
    from: Date,
  ): Promise<Date | undefined>;
}

function toItem(row: DurableWorkRow): WorkItem {
  return {
    id: row.id,
    kind: row.kind as WorkKind,
    dedupeKey: row.dedupeKey,
    status: row.status as WorkStatus,
    dueAt: row.dueAt,
    attempts: row.attempts,
    payload: JSON.parse(row.payload) as unknown,
    contactId: row.contactId,
    executionId: row.executionId,
    sendClass: row.sendClass as SendClass | null,
    lastReason: row.lastReason,
  };
}

export function createDurableWorkStore(db: MyChatDatabase): DurableWorkStore {
  function requireRow(id: number): DurableWorkRow {
    const [row] = db
      .select()
      .from(durableWork)
      .where(eq(durableWork.id, id))
      .all();

    if (row === undefined) {
      // Not a catalogue message: no operator ever sees this. It means a caller
      // is holding an id the table never had, which is a programming error.
      throw new Error(`durable work ${id} does not exist`);
    }

    return row;
  }

  return {
    enqueue(request: WorkRequest, now: Date): Promise<EnqueueResult> {
      const inserted = db
        .insert(durableWork)
        .values({
          kind: request.kind,
          dedupeKey: request.dedupeKey,
          status: "pending",
          dueAt: request.dueAt ?? now,
          attempts: 0,
          payload: JSON.stringify(request.payload),
          contactId: request.contactId ?? null,
          executionId: request.executionId ?? null,
          sendClass: request.sendClass ?? null,
          lastReason: null,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoNothing()
        .returning()
        .all();

      const row = inserted[0];
      if (row !== undefined) {
        return Promise.resolve({ enqueued: true, item: toItem(row) });
      }

      // The key was already there. Hand back what is stored rather than an
      // error: a redelivered event asking for a send that is already queued is
      // the platform behaving exactly as documented, not a fault.
      const [existing] = db
        .select()
        .from(durableWork)
        .where(eq(durableWork.dedupeKey, request.dedupeKey))
        .all();

      if (existing === undefined) {
        throw new Error(
          `durable work "${request.dedupeKey}" conflicted and then vanished`,
        );
      }

      return Promise.resolve({ enqueued: false, item: toItem(existing) });
    },

    due(now: Date, limit = 100): Promise<WorkItem[]> {
      const rows = db
        .select()
        .from(durableWork)
        .where(
          and(eq(durableWork.status, "pending"), lte(durableWork.dueAt, now)),
        )
        .orderBy(asc(durableWork.dueAt), asc(durableWork.id))
        .limit(limit)
        .all();

      return Promise.resolve(rows.map(toItem));
    },

    complete(id: number, now: Date): Promise<void> {
      requireRow(id);
      db.update(durableWork)
        .set({ status: "done", lastReason: null, updatedAt: now })
        .where(eq(durableWork.id, id))
        .run();

      return Promise.resolve();
    },

    fail(id: number, reason: string, now: Date): Promise<void> {
      const row = requireRow(id);
      db.update(durableWork)
        .set({
          status: "failed",
          attempts: row.attempts + 1,
          lastReason: reason,
          updatedAt: now,
        })
        .where(eq(durableWork.id, id))
        .run();

      return Promise.resolve();
    },

    defer(id: number, dueAt: Date, now: Date, reason?: string): Promise<void> {
      const row = requireRow(id);

      // `done` is TERMINAL, and deferring past it would resurrect a line that
      // nothing can close again: a suspension back in `pending` with its
      // execution already over is a deadline nobody is waiting on, and the
      // contact stays held until it expires. Found on 2026-08-18 during the
      // sabotage proofs of task 3l.9, where spending an attempt on an already
      // superseded wait brought the row back and reddened assertions that had
      // nothing to do with the sabotage. No caller does this today, which is
      // exactly why the guard is cheap now and expensive later.
      //
      // Silent rather than thrown on purpose: two sweeps racing over the same
      // row is legitimate, and the loser must not take a live process down for
      // arriving second. `failed` is NOT terminal here, because retrying a
      // failure is what `reason` exists for.
      if (row.status === "done") {
        return Promise.resolve();
      }

      db.update(durableWork)
        .set({
          status: "pending",
          dueAt,
          attempts: row.attempts + 1,
          lastReason: reason ?? null,
          updatedAt: now,
        })
        .where(eq(durableWork.id, id))
        .run();

      return Promise.resolve();
    },

    find(id: number): Promise<WorkItem | undefined> {
      const [row] = db
        .select()
        .from(durableWork)
        .where(eq(durableWork.id, id))
        .all();

      return Promise.resolve(row === undefined ? undefined : toItem(row));
    },

    findByKey(dedupeKey: string): Promise<WorkItem | undefined> {
      const [row] = db
        .select()
        .from(durableWork)
        .where(eq(durableWork.dedupeKey, dedupeKey))
        .all();

      return Promise.resolve(row === undefined ? undefined : toItem(row));
    },

    sendsFor(executionId: string): Promise<WorkItem[]> {
      const rows = db
        .select()
        .from(durableWork)
        .where(
          and(
            eq(durableWork.kind, "send"),
            eq(durableWork.executionId, executionId),
          ),
        )
        .orderBy(asc(durableWork.id))
        .all();

      return Promise.resolve(rows.map(toItem));
    },

    retirePendingSends(executionId: string, now: Date): Promise<void> {
      retirePendingSends(executionId, now);
      return Promise.resolve();
    },

    pendingSuspensionsFor(contactId: string): Promise<WorkItem[]> {
      const rows = db
        .select()
        .from(durableWork)
        .where(
          and(
            eq(durableWork.contactId, contactId),
            eq(durableWork.kind, "suspension"),
            eq(durableWork.status, "pending"),
          ),
        )
        .orderBy(asc(durableWork.dueAt), asc(durableWork.id))
        .all();

      return Promise.resolve(rows.map(toItem));
    },

    countPending(): Promise<number> {
      const rows = db
        .select({ id: durableWork.id })
        .from(durableWork)
        .where(eq(durableWork.status, "pending"))
        .all();

      return Promise.resolve(rows.length);
    },

    countCompletedSince(sendClass: SendClass, from: Date): Promise<number> {
      return Promise.resolve(completedSince(sendClass, from).length);
    },

    oldestCompletedSince(
      sendClass: SendClass,
      from: Date,
    ): Promise<Date | undefined> {
      const [oldest] = completedSince(sendClass, from);
      return Promise.resolve(oldest?.updatedAt);
    },
  };

  /** Concluded sends of one class inside the window, oldest first. */
  function completedSince(
    sendClass: SendClass,
    from: Date,
  ): { updatedAt: Date }[] {
    return db
      .select({ updatedAt: durableWork.updatedAt })
      .from(durableWork)
      .where(
        and(
          eq(durableWork.sendClass, sendClass),
          eq(durableWork.status, "done"),
          gte(durableWork.updatedAt, from),
        ),
      )
      .orderBy(asc(durableWork.updatedAt))
      .all();
  }

  function retirePendingSends(executionId: string, now: Date): void {
    db.update(durableWork)
      .set({ status: "done", lastReason: null, updatedAt: now })
      .where(
        and(
          eq(durableWork.kind, "send"),
          eq(durableWork.executionId, executionId),
          eq(durableWork.status, "pending"),
        ),
      )
      .run();
  }
}
