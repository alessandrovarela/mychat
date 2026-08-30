import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

/**
 * Version-2 automations are stored as one authoritative document. The nullable
 * target contains only a specific publication (never `any`), so SQLite's
 * UNIQUE semantics allow any number of account-wide/DM automations while
 * deciding publication ownership atomically, including competing writers.
 *
 * The version-1 table above remains only for the runtime transition in 3k.3.
 */
export const automationAggregates = sqliteTable(
  "automation_aggregates",
  {
    id: text("id").primaryKey(),
    definition: text("definition").notNull(),
    publicationTarget: text("publication_target"),
    scopeType: text("scope_type"),
    globalMatch: text("global_match"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    uniqueIndex("automation_aggregates_publication_target_unique").on(
      table.publicationTarget,
    ),
    uniqueIndex("automation_aggregates_next_publication_unique")
      .on(table.scopeType)
      .where(sql`${table.scopeType} = 'next_publication'`),
    uniqueIndex("automation_aggregates_global_match_unique")
      .on(table.globalMatch)
      .where(sql`${table.globalMatch} is not null`),
  ],
);

export const automationPendingPublicationBaselines = sqliteTable(
  "automation_pending_publication_baselines",
  {
    automationId: text("automation_id").notNull(),
    publicationId: text("publication_id").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.automationId, table.publicationId] }),
    index("automation_pending_publication_baselines_publication_idx").on(
      table.publicationId,
    ),
  ],
);

/** Immutable destinations handed to contacts by card buttons (REQ-220). */
export const buttonDestinations = sqliteTable(
  "button_destinations",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    automationId: text("automation_id").notNull(),
    /** Stable authored identity; labels are deliberately not part of it. */
    buttonId: text("button_id").notNull(),
    /** Monotonic inside one automation/button pair. */
    version: integer("version").notNull(),
    /** Validated HTTP(S) destination captured at delivery composition time. */
    url: text("url").notNull(),
    /**
     * The words the contact saw on this version of the destination. Nullable
     * only for destinations written before Insights started preserving them.
     */
    label: text("label"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    uniqueIndex("button_destinations_version_unique").on(
      table.automationId,
      table.buttonId,
      table.version,
    ),
    index("button_destinations_latest_idx").on(
      table.automationId,
      table.buttonId,
      table.version,
    ),
  ],
);

/** One append-only attributed click, written before its redirect (REQ-221). */
export const buttonClicks = sqliteTable(
  "button_clicks",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    occurredAt: integer("occurred_at", { mode: "timestamp_ms" }).notNull(),
    automationId: text("automation_id").notNull(),
    buttonId: text("button_id").notNull(),
    destinationId: integer("destination_id")
      .notNull()
      .references(() => buttonDestinations.id),
    destinationVersion: integer("destination_version").notNull(),
    contactId: text("contact_id").notNull(),
    executionId: text("execution_id").notNull(),
    /** Label snapshot kept on the click itself, never resolved from a live flow. */
    buttonLabel: text("button_label"),
  },
  (table) => [
    index("button_clicks_automation_idx").on(table.automationId),
    index("button_clicks_button_idx").on(table.automationId, table.buttonId),
  ],
);

/**
 * The audit trail (REQ-029). Append-only by use, not by constraint: nothing
 * updates or deletes a row, because a record that can be rewritten cannot
 * answer "what actually happened".
 *
 * The application spec decided the operator's metrics come from THIS table
 * rather than an external observability stack, which is why it is shaped for
 * querying — indexed by instant and by contact — and not merely for appending.
 *
 * Most foreign keys are nullable on purpose: an event can be rejected before
 * anyone knows which contact, flow or step it belonged to, and refusing to
 * record that would blind exactly the case an operator most needs to see.
 */
export const auditEntries = sqliteTable(
  "audit_entries",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    occurredAt: integer("occurred_at", { mode: "timestamp_ms" }).notNull(),
    /** `event_received` or `action_executed` — what kind of thing happened. */
    kind: text("kind").notNull(),
    /**
     * The SPECIFIC type of that event or action (REQ-106): a comment or a
     * direct message, a public reply or a message sent. Written at the instant
     * of the record and never derived afterwards. The values live in
     * `src/storage/audit.ts`, beside the code that writes them.
     *
     * Nullable, and it has to be. Rows written before this column existed
     * cannot say what they were, and the two honest options are a null or a
     * guess. The guess is exactly what REQ-106 forbids: the only one available
     * is reading `step_id` against the flow definition in force, which judges
     * yesterday's run by today's definition, and this phase adds revisions and
     * restoration precisely so that definitions change. An entry that does not
     * say is grouped as unknown by the reader, not filled in by the writer.
     */
    subtype: text("subtype"),
    /** `ok`, `failed`, `duplicate`, `suppressed`, `blocked`. */
    outcome: text("outcome").notNull(),
    contactId: text("contact_id"),
    flowId: text("flow_id"),
    stepId: text("step_id"),
    automationId: text("automation_id"),
    /** Platform event id, when the entry came from an inbound event. */
    eventId: text("event_id"),
    /**
     * Immutable identity of the execution that produced this row, when one
     * exists. It lets later readers correlate clicks with the run that put the
     * signed link in front of the contact without reopening an editable
     * automation document.
     */
    executionId: text("execution_id"),
    /**
     * The automation scope in force when this fact was recorded. Nullable for
     * rows that predate analytics attribution and for facts outside a run.
     */
    automationScope: text("automation_scope"),
    /**
     * The publication available to that execution at the instant of the fact.
     * It is deliberately a snapshot, never a foreign key: deleting or editing
     * a publication must not rewrite the history that already named it.
     */
    publicationId: text("publication_id"),
    /** Keyword that matched this run, absent for any-word and legacy facts. */
    matchedKeyword: text("matched_keyword"),
    /**
     * Immutable platform message identifier returned for an accepted outbound
     * send.  Older facts deliberately remain null: it would be fiction to
     * recover an id the platform never gave this instance.
     */
    platformMessageId: text("platform_message_id"),
    /**
     * What the interaction actually said (REQ-162): the comment's text, the
     * message's text, the label of the button that was tapped.
     *
     * Kept because an operator reading the trail sees a contact id and an
     * outcome and cannot tell WHICH comment the row is about. The text is
     * already in hand at the instant of the record, and recovering it later
     * would mean asking the platform for a comment that may since have been
     * deleted.
     *
     * An EMPTY string is a value here, not an absence: a sticker or a button
     * with no label is an interaction that genuinely carried no text, which is
     * a different fact from a row that never stored any.
     *
     * Nullable, and it has to be, for the reason spelled out for `subtype`
     * above: rows already written cannot be told what they carried, and no
     * later pass can reconstruct it.
     */
    eventText: text("event_text"),
    /**
     * The public identifier of whoever originated the event (REQ-162): the
     * `username` the platform puts beside the id in a comment payload.
     *
     * Beside `contact_id` rather than instead of it. The id is what every other
     * table joins on and it never changes; the username is what a human
     * recognises and can be changed by its owner at any time, so the row keeps
     * what it was told AT THE INSTANT and never re-resolves it.
     *
     * Nullable for two honest reasons at once: the rows written before this
     * column, and every direct message, whose payload carries no username at
     * all. Absent means "the payload did not bring it", which is exactly what
     * the reader must be able to say instead of inventing one.
     */
    contactUsername: text("contact_username"),
    /** Required whenever the outcome is not `ok`; null otherwise. */
    reason: text("reason"),
  },
  (table) => [
    index("audit_occurred_idx").on(table.occurredAt),
    index("audit_contact_idx").on(table.contactId),
    index("audit_event_idx").on(table.eventId),
    index("audit_execution_idx").on(table.executionId, table.occurredAt),
    index("audit_platform_message_idx").on(table.platformMessageId),
    index("audit_publication_idx").on(table.publicationId, table.occurredAt),
    // The dashboard's own query (REQ-036, REQ-037): one kind, counted by
    // subtype, over a window. Without it that count is a full scan of a table
    // that grows with every event the account ever received.
    index("audit_subtype_idx").on(table.kind, table.subtype, table.occurredAt),
  ],
);

/**
 * Every event id the webhook has already accepted (REQ-004).
 *
 * The platform redelivers on purpose — anything it does not get a fast 200 for
 * comes back. Deduplication therefore is not defensive programming, it is the
 * documented contract, and the primary key is what enforces it: a second
 * INSERT of the same id fails at the database rather than depending on a
 * read-then-write that two concurrent requests could both pass.
 */
export const receivedEvents = sqliteTable("received_events", {
  /** Id the platform assigned to the delivery. */
  eventId: text("event_id").primaryKey(),
  receivedAt: integer("received_at", { mode: "timestamp_ms" }).notNull(),
});

/**
 * Which contacts have already been DELIVERED to by which automation (REQ-015,
 * REQ-239).
 *
 * The key is the PAIR (automation, contact), not (flow, contact). That
 * distinction was a corrected error in the requirements: keyed by flow, a
 * contact who received one publication's material could never receive
 * another's, because both automations share the flow. Keyed by automation,
 * each publication reaches them once, which is what an operator means by
 * "once per contact".
 *
 * A row is written when the run HANDS SOMETHING OVER, never when it starts
 * (REQ-239). See `src/storage/automation-runs.ts` for what that costs and what
 * it buys; the column below is the half of it the schema has to carry.
 */
export const automationRuns = sqliteTable(
  "automation_runs",
  {
    automationId: text("automation_id").notNull(),
    contactId: text("contact_id").notNull(),
    firstRunAt: integer("first_run_at", { mode: "timestamp_ms" }).notNull(),
    /**
     * The run that took this contact's one chance (REQ-239, REQ-240).
     *
     * Stored so the claim can answer "is this mark MINE": a flow that delivers
     * twice (a message, a question, then the file) asks a second time from the
     * same run, and without this column the pair alone would refuse it and the
     * contact would never receive the second half.
     *
     * Nullable for the rows a database may already carry, which were written
     * by the older code at the START of a run and therefore name no delivery.
     */
    executionId: text("execution_id"),
  },
  (table) => [
    primaryKey({ columns: [table.automationId, table.contactId] }),
    index("automation_runs_contact_idx").on(table.contactId),
  ],
);

/**
 * The consecutive definitive delivery failures for each automation (REQ-200).
 *
 * The instants are stored as JSON because the sequence is deliberately tiny
 * (at most the three entries that trip the guard), while its shape is one
 * ordered value rather than an independently queried event stream. Keeping it
 * in SQLite is what makes the ten-minute window survive a process restart.
 */
export const automationFailureSequences = sqliteTable(
  "automation_failure_sequences",
  {
    automationId: text("automation_id").primaryKey(),
    /** JSON array of epoch-millisecond instants, oldest first. */
    occurredAts: text("occurred_ats").notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
);

/**
 * Durable work: ONE table for every kind of waiting the application does
 * (ADR-005).
 *
 * The decision worth restating is the one NOT taken: a send queue and a
 * suspended execution are not two mechanisms here. Both are "something that
 * should happen at or after an instant", both must survive a restart, and both
 * are collected by the same periodic sweep. Two tables would mean two claim
 * protocols and two clocks to keep in step, for no gain — the rows differ only
 * in `kind` and in what `payload` carries.
 *
 * `dedupeKey` is what makes REQ-016 provable rather than hopeful: enqueueing is
 * an INSERT against a UNIQUE column, so the same send offered twice (a
 * redelivered event, a retried execution) produces one row, decided by the
 * database and not by a read-then-write that two callers could both pass.
 *
 * The honest limit of the guarantee: a process that dies AFTER the platform
 * accepted a send but BEFORE the row is marked `done` will send again on the
 * next sweep. That is at-least-once, and REQ-016 forbids duplicating work
 * already CONCLUDED, which a row marked `done` never is.
 *
 * What at-least-once is NOT is a free trade, and an earlier version of this
 * comment claimed it was ("the alternative loses messages"). That reasoning
 * holds for processing work and fails for talking to a person: on 2026-08-02
 * the platform answered 500 to a send it had actually delivered, the retry
 * budget spent itself, and one contact received five identical messages. A
 * duplicate delivered to a human being is the harm this product exists to
 * avoid, not the acceptable cost of avoiding a loss. Hence the ceiling on
 * uncertain deliveries in `src/runtime/policy.ts`.
 */
export const durableWork = sqliteTable(
  "durable_work",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    /** `send` here; `suspension` joins it in the same table, same sweep. */
    kind: text("kind").notNull(),
    /** Caller-chosen identity of the work. UNIQUE: enqueueing twice is once. */
    dedupeKey: text("dedupe_key").notNull().unique(),
    /** `pending`, `done` or `failed`. Only `pending` is ever collected. */
    status: text("status").notNull(),
    /** Not before this instant. A deferral moves it forward, never a timer. */
    dueAt: integer("due_at", { mode: "timestamp_ms" }).notNull(),
    /** How many times a handler has taken it. Read by the retry budget. */
    attempts: integer("attempts").notNull(),
    /** JSON. Opaque to this layer on purpose: the handler owns its shape. */
    payload: text("payload").notNull(),
    /**
     * Which platform quota a send counts against (REQ-017). Null for work that
     * is not a send.
     *
     * A column rather than a second ledger table, deliberately: a completed row
     * IS the record that a send happened, so counting them cannot drift from
     * what was actually delivered. A separate ledger would be a second source
     * of truth about the same fact, and the two would disagree the first time
     * a write failed halfway.
     */
    sendClass: text("send_class"),
    /** Nullable: work that belongs to no contact still belongs in the queue. */
    contactId: text("contact_id"),
    /** Set when the work belongs to a running execution (suspension, sends). */
    executionId: text("execution_id"),
    /** Why it was deferred or why it failed. Null while nothing went wrong. */
    lastReason: text("last_reason"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    // The sweep's only query: pending work already due, oldest first.
    index("durable_work_due_idx").on(table.status, table.dueAt),
    index("durable_work_execution_idx").on(table.executionId),
    // The quota query: completed sends of one class inside a time window.
    index("durable_work_quota_idx").on(
      table.sendClass,
      table.status,
      table.updatedAt,
    ),
    // REQ-235: the wait of ONE contact, found by the contact. Without it the
    // lookup was a scan of the queue's head, and a wait sorts to the tail of
    // that order by construction: a send is due now, a wait is due in hours.
    index("durable_work_contact_idx").on(
      table.contactId,
      table.kind,
      table.status,
    ),
  ],
);

/**
 * The platform credential in force (REQ-081, REQ-088).
 *
 * One row, always: this is a single-instance, single-operator application, and
 * the fixed primary key is what says so in the schema rather than in a comment
 * everyone has to remember.
 *
 * `expiresAt` is nullable because one of the two authentication paths issues a
 * token that does not expire (ADR-022). Null means "no expiry", not "unknown" —
 * a distinction that decides whether renewal is inert or overdue.
 */
export const platformCredentials = sqliteTable("platform_credentials", {
  /** Always `PLATFORM_CREDENTIAL_ID`. One instance, one operator, one row. */
  id: text("id").primaryKey(),
  /** `instagram_login` or `system_user`. Decides host and permissions. */
  authPath: text("auth_path").notNull(),
  accessToken: text("access_token").notNull(),
  /** The account's own platform id, the `<ig-id>` of `/<ig-id>/messages`. */
  accountId: text("account_id").notNull(),
  expiresAt: integer("expires_at", { mode: "timestamp_ms" }),
  lastCheckedAt: integer("last_checked_at", { mode: "timestamp_ms" }),
  lastRefreshedAt: integer("last_refreshed_at", { mode: "timestamp_ms" }),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

/**
 * Contact attributes (REQ-028).
 *
 * A row per (contact, key) rather than a JSON document per contact: an
 * attribute is written by one step of one execution while another execution of
 * another flow may be reading a different one, and a document would make those
 * two a last-write-wins race over each other's keys.
 *
 * Values are stored as JSON text so a boolean stays a boolean across a restart.
 * A column per type would be four mostly-null columns; a plain string column
 * would turn `false` into `"false"`, which is truthy and would silently invert
 * a branch.
 */
export const contactAttributes = sqliteTable(
  "contact_attributes",
  {
    contactId: text("contact_id").notNull(),
    key: text("key").notNull(),
    /** JSON-encoded `AttributeValue`: string, number, boolean or null. */
    value: text("value").notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.contactId, table.key] })],
);

/**
 * When each contact last wrote to the account (REQ-068, REQ-019).
 *
 * One fact, two uses: it is what opens the twenty-four hour direct-message
 * window, and it is what makes a confirmation question unnecessary. A comment
 * does NOT update it, and that is the whole point — commenting is not writing
 * to the account, which is precisely the finding that created REQ-066.
 */
export const contactConversations = sqliteTable("contact_conversations", {
  contactId: text("contact_id").primaryKey(),
  lastInboundAt: integer("last_inbound_at", { mode: "timestamp_ms" }).notNull(),
});

/**
 * The operator's password (REQ-033, REQ-101).
 *
 * One row, always, for the same reason `platform_credentials` has one: this is
 * a single-instance, single-operator application, and a fixed primary key says
 * so in the schema instead of in a comment everyone has to remember.
 *
 * Only the derivation is stored, never the password. `algorithm` sits beside it
 * because a hash is unverifiable without knowing what produced it: the day the
 * function or its parameters change, the rows already written must stay
 * verifiable, and a column is what lets the verifier pick the right one instead
 * of inferring it from the string's shape.
 */
export const operatorCredential = sqliteTable("operator_credential", {
  /** Always `OPERATOR_CREDENTIAL_ID`. One instance, one operator, one row. */
  id: text("id").primaryKey(),
  /** The derived hash, carrying its own salt and parameters as encoded. */
  passwordHash: text("password_hash").notNull(),
  /** Which derivation produced `password_hash`, so verifying never guesses. */
  algorithm: text("algorithm").notNull(),
  /** Instant of the last change. A password never changed still has one. */
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

/**
 * Open sessions (REQ-031, REQ-104).
 *
 * A table rather than a self-describing signed token, and that IS REQ-104. A
 * token carrying its own expiry stays valid until that expiry because nothing
 * anywhere can be asked about it, so "the operator ended the session" could
 * only be enforced by a deny list, and a deny list held in memory is forgotten
 * by the next restart. Here the row is the authorisation itself: ending a
 * session removes the row, and a cookie whose row is gone authorises nothing,
 * before or after a restart.
 */
export const sessions = sqliteTable(
  "sessions",
  {
    /** Opaque value carried by the cookie. Never derived from the operator. */
    id: text("id").primaryKey(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    /** Past this instant the row authorises nothing, swept or not yet swept. */
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
  },
  // Both queries this table has: the expiry check on every private request, and
  // the sweep that clears what has run out.
  (table) => [index("sessions_expires_idx").on(table.expiresAt)],
);

/**
 * Revision history of flows and of automations (REQ-053, REQ-054).
 *
 * The WHOLE definition per revision, not a difference against the one before.
 * A difference is only readable through the chain it was computed from, so a
 * single unreadable link takes every older revision with it, which is the
 * opposite of what a history exists for. Restoring (REQ-054) then needs no
 * replay at all: it reads one row and writes it back as the newest revision.
 *
 * Two tables rather than one with a discriminator: a flow document and an
 * automation document are different shapes, restoring one is a different write
 * from restoring the other, and a shared table would make every read filter on
 * a column that exists only to undo the sharing.
 *
 * NO foreign key to the entity, deliberately, and for the reason REQ-056 gives
 * about the audit trail: the history of something that was deleted is exactly
 * the history somebody goes looking for.
 *
 * `id` is what breaks ties on `recorded_at`, so two revisions written inside
 * the same millisecond still list in the order they happened (REQ-053).
 */
/**
 * The account's publications, cached locally (REQ-069, REQ-070, REQ-071).
 *
 * REQ-070 is why the table exists: asking the platform every time the screen
 * opens spends quota to redraw a grid that barely changes, and it makes the
 * screen fail whenever the platform is slow.
 *
 * REQ-071 is why the thumbnail is a KEY and not a URL. Platform media URLs
 * expire, so a cached URL becomes a grid of broken images a few hours later.
 * The image is copied into the bucket under the `thumbs/` prefix (ADR-006,
 * ADR-010) and this column names it there, which is what keeps a publication
 * already listed showing its picture afterwards.
 */
export const publicationCache = sqliteTable(
  "publication_cache",
  {
    /** The publication's id on the platform, which is the automation target. */
    id: text("id").primaryKey(),
    /**
     * The caption the operator wrote, whole (REQ-216).
     *
     * NULLABLE, and for two different reasons that must both keep working. A
     * publication with no caption is an ordinary post, and there is no text to
     * invent for it. And every row cached before this column existed has null
     * here, because nothing local could reconstruct a caption nobody stored:
     * those rows list exactly as they did yesterday and fill themselves on the
     * next refresh, which is a listing that degrades instead of a screen that
     * has to be repaired by hand.
     *
     * Stored WHOLE. The two-line clamp is a decision of the card that draws it,
     * and a caption truncated here could never be given back.
     */
    caption: text("caption"),
    /** The platform's own vocabulary (`IMAGE`, `VIDEO`, ...), left unmapped. */
    mediaType: text("media_type").notNull(),
    /** When it was published, which is the order the listing is read in. */
    publishedAt: integer("published_at", { mode: "timestamp_ms" }).notNull(),
    /**
     * Key of the copy in object storage. Nullable: a publication whose
     * thumbnail could not be copied still belongs in the listing, and dropping
     * it would make a target unselectable over a failure that says nothing
     * about the publication itself.
     */
    thumbnailKey: text("thumbnail_key"),
    /** When this row was last refreshed: what tells stale from never fetched. */
    cachedAt: integer("cached_at", { mode: "timestamp_ms" }).notNull(),
  },
  // The listing's only query: a page of publications, newest first.
  (table) => [index("publication_cache_published_idx").on(table.publishedAt)],
);

/**
 * Choices the operator made in the panel, one row per setting (REQ-102).
 *
 * Key and value rather than a column per setting: the language is the first
 * inhabitant and will not be the last, and a schema that moves for every later
 * preference makes a migration out of a decision that is not a schema decision.
 *
 * The environment is deliberately not represented here. It supplies the INITIAL
 * value, so an absent row means "the operator never chose", which is a
 * different fact from a row holding whatever the environment happened to say,
 * and only this shape can tell the two apart.
 */
export const instancePreferences = sqliteTable("instance_preferences", {
  key: text("key").primaryKey(),
  /** Text: what a preference means is the business of whoever reads it. */
  value: text("value").notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

export type ContactAttributeRow = typeof contactAttributes.$inferSelect;
export type ContactConversationRow = typeof contactConversations.$inferSelect;
export type DurableWorkRow = typeof durableWork.$inferSelect;
export type PlatformCredentialRow = typeof platformCredentials.$inferSelect;
export type AutomationRunRow = typeof automationRuns.$inferSelect;
export type AutomationFailureSequenceRow =
  typeof automationFailureSequences.$inferSelect;
export type ReceivedEventRow = typeof receivedEvents.$inferSelect;
export type AutomationAggregateRow = typeof automationAggregates.$inferSelect;
export type ButtonDestinationRow = typeof buttonDestinations.$inferSelect;
export type ButtonClickRow = typeof buttonClicks.$inferSelect;
export type AuditEntryRow = typeof auditEntries.$inferSelect;
export type OperatorCredentialRow = typeof operatorCredential.$inferSelect;
export type SessionRow = typeof sessions.$inferSelect;
export type PublicationCacheRow = typeof publicationCache.$inferSelect;
export type InstancePreferenceRow = typeof instancePreferences.$inferSelect;
