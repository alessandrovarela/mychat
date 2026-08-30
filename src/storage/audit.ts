import { and, asc, desc, eq, gte, isNull, lte } from "drizzle-orm";
import type { MyChatDatabase } from "./database.js";
import { auditEntries } from "./schema.js";

/**
 * The audit trail (REQ-029): every inbound event and every executed action,
 * with instant, contact, flow, step and outcome — and, when something went
 * wrong, the reason.
 *
 * Why a table and not a log file: the application spec decided the operator's
 * metrics come from this record rather than an external observability stack.
 * Counting anything in a log file means parsing it, and a format nobody
 * validates drifts the first time a message is reworded.
 *
 * Append-only by use. Nothing here updates or deletes: a record that can be
 * rewritten cannot answer what actually happened.
 */

/**
 * `alert` is a third kind, not an outcome of the other two: it is the
 * application telling the OPERATOR something, rather than recording what
 * happened to a contact. Before Phase 3 there is no screen, so an alert that
 * lived only in a log would satisfy REQ-081 and REQ-088 on paper while leaving
 * the operator with no way to see it.
 */
export type AuditKind = "event_received" | "action_executed" | "alert";

/**
 * `ok` is the only outcome that needs no reason. The others each describe a
 * distinct thing an operator would ask about: a duplicate delivery, a
 * deliberate suppression (once-per-contact, disabled automation), a refusal
 * before calling the platform, and an outright failure.
 */
export type AuditOutcome =
  "ok" | "failed" | "duplicate" | "suppressed" | "blocked";

/**
 * The specific type of the thing recorded (REQ-106), one union per kind.
 *
 * Written at the instant of the record, never derived afterwards, and that is
 * the requirement rather than a preference. The derivation available (reading
 * `stepId` against the flow definition in force) would judge yesterday's run by
 * today's definition, and this phase adds revisions and restoration precisely
 * so that definitions change: a run that happened under a definition since
 * edited, or since deleted, would be counted as something it never was.
 *
 * Literal unions and not free strings, because these values are counted. A
 * misspelling in a free string opens a new bucket in the dashboard instead of
 * failing anywhere, and nobody notices until the totals stop adding up.
 */

/** What arrived, for `kind: "event_received"`. Mirrors the trigger origins. */
export type AuditEventSubtype = "comment" | "direct_message";

/**
 * What was done, for `kind: "action_executed"`.
 *
 * `message_sent` covers every step whose action is a direct message to the
 * contact (the delivery, the confirmation question, the address question, the
 * follow request): they are one type of action to an operator counting what
 * left the account, and telling them apart is what `stepId` and `flowId`
 * already do on the same row.
 *
 * The subtype says what KIND of action the entry is about; whether it happened
 * is `outcome`. Counting messages actually sent therefore means
 * `subtype: "message_sent"` AND `outcome: "ok"`, since a step that was
 * suppressed (REQ-068) is still a message step, recorded as one, that sent
 * nothing.
 */
export type AuditActionSubtype =
  | "comment_reply"
  | "message_sent"
  /**
   * A declared pause began, and the run is waiting on the clock (REQ-098,
   * REQ-156).
   *
   * Its own type rather than one borrowed from the waits below, and rather than
   * nothing at all. Nothing at all is what it recorded before: the row existed,
   * with its flow and its step, and the panel could only file it under the group
   * it keeps for entries that cannot say what they are, beside deliveries whose
   * payload nobody could read. A pause knows exactly what it is.
   *
   * It records the pause STARTING, because that is the moment this row is
   * written. What ends it is either the sweep resuming the run (REQ-098, which
   * writes the rows of the steps that then ran) or `wait_ended`, which belongs
   * to the waits that give up on a contact who never answered.
   */
  | "pause_started"
  /** A wait ended through the path the flow declared: timeout, or attempts spent. */
  | "wait_ended"
  /** A run that failed with no step to blame: no definition, or a cycle. */
  | "execution_failed";

/** What the application is telling the operator, for `kind: "alert"`. */
export type AuditAlertSubtype =
  | "credential_seeded"
  | "credential_renewed"
  | "credential_refresh_failed"
  | "credential_unusable"
  /** Three definitive delivery failures paused one automation (REQ-201). */
  | "automation_auto_paused";

export type AuditSubtype =
  AuditEventSubtype | AuditActionSubtype | AuditAlertSubtype;

/**
 * How an entry that does not name its type is grouped (REQ-106).
 *
 * Deliberately NOT a member of `AuditSubtype`: nothing may ever write it. It is
 * what a READER calls an entry whose subtype is absent, and absence has exactly
 * two causes, both of them honest. The row predates the migration that added
 * the column, or the writer genuinely could not tell (a delivery whose payload
 * this build cannot read names no origin). Either way the aggregation shows the
 * group as what it is and keeps working, instead of failing or inventing.
 */
export const UNKNOWN_SUBTYPE = "unknown";

/** A subtype as a reader sees it: one of the written values, or the group. */
export type AuditSubtypeGroup = AuditSubtype | typeof UNKNOWN_SUBTYPE;

/**
 * The group an entry belongs to. The single place absence becomes "unknown", so
 * every count of this trail buckets the same way.
 */
export function subtypeGroupOf(entry: {
  readonly subtype?: AuditSubtype;
}): AuditSubtypeGroup {
  return entry.subtype ?? UNKNOWN_SUBTYPE;
}

export interface AuditEntry {
  readonly id: number;
  readonly occurredAt: Date;
  readonly kind: AuditKind;
  /** Absent on rows written before REQ-106, and on those that cannot tell. */
  readonly subtype?: AuditSubtype;
  readonly outcome: AuditOutcome;
  readonly contactId?: string;
  readonly flowId?: string;
  readonly stepId?: string;
  readonly automationId?: string;
  readonly eventId?: string;
  /** The immutable run identity, when this fact belongs to an execution. */
  readonly executionId?: string;
  /** Scope snapshot written when this fact happened, never recomputed later. */
  readonly automationScope?: "publication" | "global" | "next_publication";
  /** Publication snapshot, absent only when the fact offered none. */
  readonly publicationId?: string;
  /** Trigger word captured when this execution matched, never recomputed later. */
  readonly matchedKeyword?: string;
  /** Meta message id, present only after an API acceptance response. */
  readonly platformMessageId?: string;
  /**
   * What the interaction said (REQ-162). An empty string is a value: an answer
   * that carried no text. Absent means the row never stored any.
   */
  readonly eventText?: string;
  /** Public identifier of who originated it. Absent when none was brought. */
  readonly contactUsername?: string;
  readonly reason?: string;
}

/** What a caller supplies. The id and the instant belong to the store. */
export interface AuditRecord {
  readonly kind: AuditKind;
  /** Omitted only where the writer honestly cannot tell. Never guessed. */
  readonly subtype?: AuditSubtype;
  readonly outcome: AuditOutcome;
  readonly contactId?: string;
  readonly flowId?: string;
  readonly stepId?: string;
  readonly automationId?: string;
  readonly eventId?: string;
  /** Execution identity captured at the time the run writes this fact. */
  readonly executionId?: string;
  /** Scope snapshot captured at the time the run writes this fact. */
  readonly automationScope?: "publication" | "global" | "next_publication";
  /** Publication snapshot captured at the time the run writes this fact. */
  readonly publicationId?: string;
  /** Trigger word captured at the time this execution matched. */
  readonly matchedKeyword?: string;
  readonly platformMessageId?: string;
  /** What arrived, as it arrived (REQ-162). Empty text is still text. */
  readonly eventText?: string;
  /**
   * Omitted when the payload brought no public identifier, which is every
   * direct message (REQ-162). Never derived from the contact id: the two are
   * different identifiers, and only one of them the platform actually sent.
   */
  readonly contactUsername?: string;
  readonly reason?: string;
}

/** Every field narrows; omitting all of them returns the whole trail. */
export interface AuditQuery {
  readonly kind?: AuditKind;
  /**
   * Narrows to one type, and `unknown` narrows to the entries that name none:
   * the group has to be reachable by a query, or REQ-106's "grouped as unknown"
   * would be something only an in-memory pass over the whole table could do.
   */
  readonly subtype?: AuditSubtypeGroup;
  readonly outcome?: AuditOutcome;
  readonly contactId?: string;
  readonly flowId?: string;
  readonly eventId?: string;
  /** Immutable execution identity, used to read its persisted attribution. */
  readonly executionId?: string;
  readonly platformMessageId?: string;
  readonly since?: Date;
  readonly until?: Date;
  readonly limit?: number;
  /** Newest first by default: an operator looks at what just happened. */
  readonly order?: "newest" | "oldest";
}

export interface AuditRepository {
  record(entry: AuditRecord, occurredAt: Date): Promise<AuditEntry>;
  query(filter?: AuditQuery): Promise<readonly AuditEntry[]>;
}

function toEntry(row: typeof auditEntries.$inferSelect): AuditEntry {
  // Columns are nullable; the domain type uses optional, so absent stays
  // absent instead of turning into an explicit null every caller must handle.
  return {
    id: row.id,
    occurredAt: row.occurredAt,
    kind: row.kind as AuditKind,
    outcome: row.outcome as AuditOutcome,
    // Absent stays absent here too, and that is what makes the fallback work:
    // a row written before the column existed reads back with no subtype, which
    // `subtypeGroupOf` turns into the unknown group instead of a null nobody
    // handled or a value nobody wrote (REQ-106).
    ...(row.subtype !== null && { subtype: row.subtype as AuditSubtype }),
    ...(row.contactId !== null && { contactId: row.contactId }),
    ...(row.flowId !== null && { flowId: row.flowId }),
    ...(row.stepId !== null && { stepId: row.stepId }),
    ...(row.automationId !== null && { automationId: row.automationId }),
    ...(row.eventId !== null && { eventId: row.eventId }),
    ...(row.executionId !== null && { executionId: row.executionId }),
    ...(row.automationScope !== null && {
      automationScope: row.automationScope as AuditEntry["automationScope"],
    }),
    ...(row.publicationId !== null && { publicationId: row.publicationId }),
    ...(row.matchedKeyword !== null && { matchedKeyword: row.matchedKeyword }),
    ...(row.platformMessageId !== null && {
      platformMessageId: row.platformMessageId,
    }),
    // Compared against null and NOT tested for truth (REQ-162): an empty text
    // is falsy and is exactly the case that must survive the round trip, since
    // "the sticker said nothing" and "this row stored nothing" are different
    // answers to the operator's question.
    ...(row.eventText !== null && { eventText: row.eventText }),
    ...(row.contactUsername !== null && {
      contactUsername: row.contactUsername,
    }),
    ...(row.reason !== null && { reason: row.reason }),
  };
}

export function createAuditRepository(db: MyChatDatabase): AuditRepository {
  return {
    record(entry: AuditRecord, occurredAt: Date): Promise<AuditEntry> {
      const [row] = db
        .insert(auditEntries)
        .values({
          occurredAt,
          kind: entry.kind,
          // Written HERE, at the instant of the record (REQ-106), from what the
          // caller knew when it happened. Nothing later recomputes it.
          subtype: entry.subtype ?? null,
          outcome: entry.outcome,
          contactId: entry.contactId ?? null,
          flowId: entry.flowId ?? null,
          stepId: entry.stepId ?? null,
          automationId: entry.automationId ?? null,
          eventId: entry.eventId ?? null,
          executionId: entry.executionId ?? null,
          automationScope: entry.automationScope ?? null,
          publicationId: entry.publicationId ?? null,
          matchedKeyword: entry.matchedKeyword ?? null,
          platformMessageId: entry.platformMessageId ?? null,
          // `??` and not `||`, for the same reason the read above compares
          // against null: an empty text is a value the caller meant to write.
          eventText: entry.eventText ?? null,
          contactUsername: entry.contactUsername ?? null,
          reason: entry.reason ?? null,
        })
        .returning()
        .all();

      if (row === undefined) {
        // Losing an audit write silently would make the trail lie by omission.
        throw new Error("audit entry was not written");
      }

      return Promise.resolve(toEntry(row));
    },

    query(filter: AuditQuery = {}): Promise<readonly AuditEntry[]> {
      const conditions = [
        filter.kind !== undefined && eq(auditEntries.kind, filter.kind),
        // The unknown group is a NULL column, not a stored word, so it is
        // matched by absence. Comparing it as a value would return nothing at
        // all, silently, since SQL equality against NULL is never true.
        filter.subtype !== undefined &&
          (filter.subtype === UNKNOWN_SUBTYPE
            ? isNull(auditEntries.subtype)
            : eq(auditEntries.subtype, filter.subtype)),
        filter.outcome !== undefined &&
          eq(auditEntries.outcome, filter.outcome),
        filter.contactId !== undefined &&
          eq(auditEntries.contactId, filter.contactId),
        filter.flowId !== undefined && eq(auditEntries.flowId, filter.flowId),
        filter.eventId !== undefined &&
          eq(auditEntries.eventId, filter.eventId),
        filter.executionId !== undefined &&
          eq(auditEntries.executionId, filter.executionId),
        filter.platformMessageId !== undefined &&
          eq(auditEntries.platformMessageId, filter.platformMessageId),
        filter.since !== undefined &&
          gte(auditEntries.occurredAt, filter.since),
        filter.until !== undefined &&
          lte(auditEntries.occurredAt, filter.until),
      ].filter((condition) => condition !== false);

      const ordering =
        filter.order === "oldest"
          ? [asc(auditEntries.occurredAt), asc(auditEntries.id)]
          : [desc(auditEntries.occurredAt), desc(auditEntries.id)];

      const base = db
        .select()
        .from(auditEntries)
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(...ordering);

      const rows =
        filter.limit === undefined
          ? base.all()
          : base.limit(filter.limit).all();

      return Promise.resolve(rows.map(toEntry));
    },
  };
}
