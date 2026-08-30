import type { Clock } from "../engine/ports.js";
import { t } from "../i18n/index.js";
import type { ActiveAutomation, UnifiedAutomation } from "./schema.js";
import {
  validateAutomationActivation,
  validateUnifiedAutomation,
} from "./validation.js";
import type { ValidationIssue, ValidationResult } from "./validation.js";

export interface StoredDefinition<T> {
  readonly definition: T;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/**
 * A stored automation that EXISTS and that this version's schema refuses
 * (REQ-294).
 *
 * It carries the identifier and nothing else, because the identifier is the
 * only thing about it that can be trusted: it is read off the row's own
 * COLUMN, never off the document, which is the thing nobody can parse.
 *
 * The refusal is the decision and stays (no compatibility layer, no guessing
 * at the old shape). What this type buys is that the refusal cannot be
 * mistaken for absence: a caller holding one of these knows the row is there,
 * and the compiler will not let it read a definition off it.
 */
export interface UnreadableStoredAutomation {
  readonly unreadable: true;
  readonly id: string;
}

/** What a lookup by identifier finds: the definition, a refusal, or nothing. */
export type FoundAutomation =
  StoredDefinition<UnifiedAutomation> | UnreadableStoredAutomation;

export function isUnreadable(
  found: FoundAutomation | undefined,
): found is UnreadableStoredAutomation {
  return found !== undefined && "unreadable" in found;
}

export interface AutomationAggregateStore {
  /**
   * Every stored automation this version CAN read, and only those (REQ-294).
   *
   * The rows the schema refuses are left out instead of taking the answer
   * down with them, and they are not swallowed: they leave here and come back
   * through the coverage reader's `unreadable()`, which locates them by their
   * columns, so the interface says how many exist and that nothing was
   * deleted. One readable automation is worth more than a listing that is all
   * or nothing.
   */
  list(): Promise<readonly StoredDefinition<UnifiedAutomation>[]>;
  findById(id: string): Promise<FoundAutomation | undefined>;
  save(
    definition: UnifiedAutomation,
    pendingPublicationBaseline?: readonly string[],
  ): Promise<
    | {
        readonly ok: true;
        readonly stored: StoredDefinition<UnifiedAutomation>;
      }
    | {
        readonly ok: false;
        readonly conflict: "publication_target_conflict";
        readonly target: string;
      }
    | {
        readonly ok: false;
        readonly conflict: "global_match_conflict";
        readonly automationId: string;
      }
    | { readonly ok: false; readonly conflict: "next_publication_conflict" }
  >;
  remove(id: string): Promise<boolean>;
}

export type AutomationAggregateSaveResult =
  | {
      readonly ok: true;
      readonly created: boolean;
      readonly stored: StoredDefinition<UnifiedAutomation>;
    }
  | {
      readonly ok: false;
      readonly refusal: "invalid_definition";
      readonly issues: readonly ValidationIssue[];
    }
  | {
      readonly ok: false;
      readonly refusal: "publication_target_conflict";
      readonly target: string;
    }
  | {
      readonly ok: false;
      readonly refusal: "global_match_conflict";
      readonly automationId: string;
    }
  | { readonly ok: false; readonly refusal: "next_publication_conflict" }
  | {
      readonly ok: false;
      readonly refusal: "pending_publication_sync_failed";
      readonly reason: string;
    };

export interface AutomationAggregateLifecycle {
  list(): Promise<readonly StoredDefinition<UnifiedAutomation>[]>;
  /**
   * One automation by identifier, and the three answers are three different
   * sentences (REQ-294): here it is, it exists and cannot be read, there is
   * none. The middle one is not the first two: answering "not found" for a row
   * that is in the table is a lie, and taking the request down with an error is
   * the listing's old defect asked one row at a time.
   */
  read(id: string): Promise<FoundAutomation | undefined>;
  save(input: unknown): Promise<AutomationAggregateSaveResult>;
  remove(id: string): Promise<boolean>;
}

export interface AutomationFailureLedger {
  recordFailure(automationId: string, at: Date): Promise<readonly Date[]>;
  reset(automationId: string): Promise<void>;
}

/**
 * The lifecycle no longer takes a publication resolver, and the absence is
 * REQ-260 rather than a simplification: the target is an identifier now, so
 * there is nothing left to resolve and no write that depends on the platform
 * being reachable.
 */
export interface PendingPublicationBaselineReader {
  sync(): Promise<
    | { readonly ok: true; readonly ids: readonly string[] }
    | { readonly ok: false; readonly reason: string }
  >;
}

export function createAutomationAggregateLifecycle(
  store: AutomationAggregateStore,
  failures?: AutomationFailureLedger,
  pendingPublicationBaseline?: PendingPublicationBaselineReader,
): AutomationAggregateLifecycle {
  return {
    list: () => store.list(),
    read: (id) => store.findById(id),
    async save(input) {
      const validated = validateUnifiedAutomation(input);
      if (!validated.ok) {
        return {
          ok: false,
          refusal: "invalid_definition",
          issues: validated.issues,
        };
      }

      const existing = await store.findById(validated.value.id);
      const isPendingActivation =
        validated.value.state === "active" &&
        validated.value.scope?.type === "next_publication" &&
        (isUnreadable(existing) ||
          existing?.definition.state !== "active" ||
          existing.definition.scope?.type !== "next_publication");
      let baseline: readonly string[] | undefined;
      if (isPendingActivation) {
        const synced = await pendingPublicationBaseline?.sync();
        if (synced === undefined || !synced.ok) {
          return {
            ok: false,
            refusal: "pending_publication_sync_failed",
            reason:
              synced?.reason ??
              t("automation.pendingPublicationSyncUnavailable"),
          };
        }
        baseline = synced.ids;
      }
      const result = await store.save(validated.value, baseline);
      // An existing row this version refuses is still an existing row: the
      // save that lands on it is an UPDATE and says so, and no failure ledger
      // is reset, because "it was a draft until now" is a claim about a
      // document nobody could read (REQ-294). Writing a complete, valid
      // definition over it is the operator's own repair, not a compatibility
      // layer: nothing here reads or guesses at what was there.
      if (
        result.ok &&
        validated.value.state === "active" &&
        !isUnreadable(existing) &&
        existing?.definition.state === "draft"
      ) {
        await failures?.reset(validated.value.id);
      }

      if (result.ok)
        return {
          ok: true,
          created: existing === undefined,
          stored: result.stored,
        };
      if (result.conflict === "publication_target_conflict")
        return { ok: false, refusal: result.conflict, target: result.target };
      if (result.conflict === "global_match_conflict")
        return {
          ok: false,
          refusal: result.conflict,
          automationId: result.automationId,
        };
      return { ok: false, refusal: result.conflict };
    },
    remove: (id) => store.remove(id),
  };
}

export function activateAutomationDraft(
  draft: unknown,
): ValidationResult<ActiveAutomation> {
  return validateAutomationActivation(draft);
}

export interface AutomationPauseAudit {
  record(
    entry: {
      readonly kind: "alert";
      readonly subtype: "automation_auto_paused";
      readonly outcome: "failed";
      readonly automationId: string;
      readonly reason: string;
    },
    occurredAt: Date,
  ): Promise<unknown>;
}

export interface AutomationDeliveryOutcomes {
  succeeded(automationId: string): Promise<void>;
  failed(automationId: string, reason: string): Promise<void>;
}

export interface AutomationFailureHandlerDeps {
  readonly aggregates: Pick<AutomationAggregateStore, "findById" | "save">;
  readonly failures: AutomationFailureLedger;
  readonly audit: AutomationPauseAudit;
  readonly clock: Clock;
}

export function createAutomationFailureHandler(
  deps: AutomationFailureHandlerDeps,
): AutomationDeliveryOutcomes {
  return {
    succeeded: (automationId) => deps.failures.reset(automationId),

    async failed(automationId, reason) {
      const at = deps.clock.now();
      const sequence = await deps.failures.recordFailure(automationId, at);
      if (sequence.length < 3) return;

      const aggregate = await deps.aggregates.findById(automationId);
      // A row this version refuses is not paused and not rewritten (REQ-294):
      // pausing it would mean writing back a definition that would have to be
      // read first, and it is not running anyway, since the listing the
      // dispatcher matches against leaves it out.
      if (isUnreadable(aggregate) || aggregate?.definition.state !== "active")
        return;

      await deps.aggregates.save({
        ...aggregate.definition,
        state: "draft",
      });
      await deps.audit.record(
        {
          kind: "alert",
          subtype: "automation_auto_paused",
          outcome: "failed",
          automationId,
          // The identifier alone names it (REQ-279): an automation carries no
          // name, and the one the screens show is composed from the publication
          // when it is shown, which is not something an audit entry written
          // here can hold.
          reason: t("automation.autoPaused", { id: automationId, reason }),
        },
        at,
      );
    },
  };
}
