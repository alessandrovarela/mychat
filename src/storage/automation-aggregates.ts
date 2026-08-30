import { and, asc, eq } from "drizzle-orm";
import type { Clock } from "../engine/ports.js";
import { isUnreadable } from "../flows/automations.js";
import { normaliseGlobalMatch } from "../flows/matching.js";
import type {
  AutomationAggregateStore,
  FoundAutomation,
} from "../flows/automations.js";
import type { UnifiedAutomation } from "../flows/schema.js";
import { t } from "../i18n/index.js";
import { readAutomationDocument } from "./automation-document.js";
import type { MyChatDatabase } from "./database.js";
import { StorageError } from "./errors.js";
import {
  automationAggregates,
  automationPendingPublicationBaselines,
} from "./schema.js";
import type { AutomationAggregateRow } from "./schema.js";

const systemClock: Clock = { now: () => new Date() };

export function createAutomationAggregateRepository(
  db: MyChatDatabase,
  clock: Clock = systemClock,
): AutomationAggregateStore & PendingPublicationBinder {
  function findById(id: string): Promise<FoundAutomation | undefined> {
    const row = db
      .select()
      .from(automationAggregates)
      .where(eq(automationAggregates.id, id))
      .get();
    return Promise.resolve(row === undefined ? undefined : toFound(row));
  }

  return {
    findById,

    async bindPendingToPublication(publicationId) {
      const pending = db
        .select()
        .from(automationAggregates)
        .where(eq(automationAggregates.scopeType, "next_publication"))
        .get();

      if (pending === undefined) return { kind: "no_pending" as const };

      const found = toFound(pending);
      if (isUnreadable(found)) return { kind: "no_pending" as const };
      const definition = bindToPublication(found.definition, publicationId);
      const now = clock.now();

      try {
        const bound = db.transaction((tx) => {
          const baseline = tx
            .select({
              publicationId:
                automationPendingPublicationBaselines.publicationId,
            })
            .from(automationPendingPublicationBaselines)
            .where(
              and(
                eq(
                  automationPendingPublicationBaselines.automationId,
                  pending.id,
                ),
                eq(
                  automationPendingPublicationBaselines.publicationId,
                  publicationId,
                ),
              ),
            )
            .get();
          if (baseline !== undefined) return false;
          const changed = tx
            .update(automationAggregates)
            .set({
              definition: JSON.stringify(definition),
              publicationTarget: publicationId,
              scopeType: "publication",
              globalMatch: null,
              updatedAt: now,
            })
            .where(
              and(
                eq(automationAggregates.id, pending.id),
                eq(automationAggregates.scopeType, "next_publication"),
              ),
            )
            .run();
          if (changed.changes === 0) return false;
          tx.delete(automationPendingPublicationBaselines)
            .where(
              eq(
                automationPendingPublicationBaselines.automationId,
                pending.id,
              ),
            )
            .run();
          return true;
        });

        if (!bound) return { kind: "no_pending" as const };
      } catch (cause) {
        if (isUniqueConstraint(cause)) {
          return { kind: "conflict" as const, target: publicationId };
        }
        throw new StorageError(
          t("storage.automationNotStored", {
            id: pending.id,
            reason: cause instanceof Error ? cause.message : String(cause),
          }),
          { cause },
        );
      }

      const stored = await findById(pending.id);
      if (stored === undefined || isUnreadable(stored)) {
        throw mismatch(pending.id, t("storage.unknownReason"));
      }
      return { kind: "bound" as const, stored };
    },

    async list() {
      return db
        .select()
        .from(automationAggregates)
        .orderBy(asc(automationAggregates.id))
        .all()
        .flatMap((row) => {
          // ONE refused document used to take the whole listing with it
          // (REQ-294): the screen showed "the automations could not be read",
          // which is the empty screen by another road, and the webhook
          // dispatcher matched against nothing at all. It leaves by this
          // branch now, and it leaves counted: the coverage reader's
          // `unreadable()` finds it by its columns and the interface says how
          // many exist and that nothing was deleted.
          const found = toFound(row);
          return isUnreadable(found) ? [] : [found];
        });
    },

    async save(definition, pendingPublicationBaseline) {
      const now = clock.now();
      const target = specificPublicationTarget(definition);
      const scope = persistedScope(definition);
      const replaceBaseline = pendingPublicationBaseline !== undefined;
      const clearBaseline = scope.type !== "next_publication";

      try {
        db.transaction((tx) => {
          tx.insert(automationAggregates)
            .values({
              id: definition.id,
              definition: JSON.stringify(definition),
              publicationTarget: target,
              scopeType: scope.type,
              globalMatch: scope.globalMatch,
              createdAt: now,
              updatedAt: now,
            })
            .onConflictDoUpdate({
              target: automationAggregates.id,
              set: {
                definition: JSON.stringify(definition),
                publicationTarget: target,
                scopeType: scope.type,
                globalMatch: scope.globalMatch,
                updatedAt: now,
              },
            })
            .run();
          if (replaceBaseline || clearBaseline) {
            tx.delete(automationPendingPublicationBaselines)
              .where(
                eq(
                  automationPendingPublicationBaselines.automationId,
                  definition.id,
                ),
              )
              .run();
          }
          if (pendingPublicationBaseline !== undefined) {
            const ids = [...new Set(pendingPublicationBaseline)];
            if (ids.length > 0) {
              tx.insert(automationPendingPublicationBaselines)
                .values(
                  ids.map((publicationId) => ({
                    automationId: definition.id,
                    publicationId,
                  })),
                )
                .run();
            }
          }
        });
      } catch (cause) {
        if (isUniqueConstraint(cause)) {
          if (scope.type === "global" && scope.globalMatch !== null) {
            const existing = db
              .select({ id: automationAggregates.id })
              .from(automationAggregates)
              .where(eq(automationAggregates.globalMatch, scope.globalMatch))
              .get();
            return {
              ok: false as const,
              conflict: "global_match_conflict" as const,
              automationId: existing?.id ?? definition.id,
            };
          }
          if (scope.type === "next_publication") {
            return {
              ok: false as const,
              conflict: "next_publication_conflict" as const,
            };
          }
          if (target !== null) {
            return {
              ok: false as const,
              conflict: "publication_target_conflict" as const,
              target,
            };
          }
        }
        throw new StorageError(
          t("storage.automationNotStored", {
            id: definition.id,
            reason: cause instanceof Error ? cause.message : String(cause),
          }),
          { cause },
        );
      }

      const stored = await findById(definition.id);
      if (stored === undefined) {
        throw new StorageError(
          t("storage.automationNotStored", {
            id: definition.id,
            reason: t("storage.unknownReason"),
          }),
        );
      }
      // The row was written from a definition the schema had just accepted, so
      // reading it back refused means the two halves of this process disagree
      // about the format. Nothing sensible can be returned, and this is the one
      // place where a refused document IS an error rather than a state: the
      // rows REQ-294 is about were written by an older version, not by the
      // statement three lines above.
      if (isUnreadable(stored)) {
        throw mismatch(definition.id, t("storage.unknownReason"));
      }
      return { ok: true as const, stored };
    },

    async remove(id) {
      return db.transaction((tx) => {
        tx.delete(automationPendingPublicationBaselines)
          .where(eq(automationPendingPublicationBaselines.automationId, id))
          .run();
        return (
          tx
            .delete(automationAggregates)
            .where(eq(automationAggregates.id, id))
            .run().changes > 0
        );
      });
    },
  };
}

interface PendingPublicationBinder {
  bindPendingToPublication(
    publicationId: string,
  ): Promise<
    | { readonly kind: "no_pending" }
    | { readonly kind: "bound"; readonly stored: FoundAutomation }
    | { readonly kind: "conflict"; readonly target: string }
  >;
}

function bindToPublication(
  definition: UnifiedAutomation,
  publicationId: string,
): UnifiedAutomation {
  const trigger = definition.trigger;

  if (trigger?.type === "comment") {
    return {
      ...definition,
      scope: { type: "publication", publicationId },
      trigger: { ...trigger, target: publicationId },
    } as UnifiedAutomation;
  }

  return {
    ...definition,
    scope: { type: "publication", publicationId },
  };
}

/**
 * The publication this automation occupies, or `null` when it occupies none.
 *
 * `null` is what the UNIQUE index lets stack: SQLite compares nulls as
 * distinct, so every direct-message automation (which has no publication at
 * all) and every draft that has not named its target yet coexist, while two
 * comment automations on the same publication collide (REQ-217).
 */
function specificPublicationTarget(
  definition: UnifiedAutomation,
): string | null {
  const trigger = definition.trigger;
  if (definition.scope?.type === "publication")
    return definition.scope.publicationId;
  return trigger?.type === "comment" &&
    trigger.target !== undefined &&
    trigger.target !== ""
    ? trigger.target
    : null;
}

function persistedScope(definition: UnifiedAutomation): {
  readonly type: "publication" | "global" | "next_publication" | null;
  readonly globalMatch: string | null;
} {
  const scope = definition.scope;
  if (scope?.type === "global")
    return {
      type: scope.type,
      globalMatch:
        definition.state !== "active"
          ? null
          : normaliseGlobalMatch(definition.trigger),
    };
  return { type: scope?.type ?? null, globalMatch: null };
}

/**
 * The row as this version reads it: the definition, or the refusal itself.
 *
 * A verdict and not an exception (REQ-294). The identifier of a refused row
 * comes from `row.id`, its own column, and never from the document: the
 * document is the thing that could not be read, so nothing may be taken from
 * it, not even the identifier it claims to carry.
 */
function toFound(row: AutomationAggregateRow): FoundAutomation {
  const document = readAutomationDocument(row.definition);
  if (!document.ok) return { unreadable: true, id: row.id };

  return {
    definition: document.definition,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function mismatch(id: string, cause: unknown): StorageError {
  return new StorageError(
    t("storage.storedRecordSchemaMismatch", {
      kind: "automation",
      id,
      reason: cause instanceof Error ? cause.message : String(cause),
    }),
    { cause },
  );
}

function isUniqueConstraint(cause: unknown): boolean {
  return (
    cause instanceof Error &&
    "code" in cause &&
    cause.code === "SQLITE_CONSTRAINT_UNIQUE"
  );
}
