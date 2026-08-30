import type { AuditRepository } from "../storage/audit.js";
import type { CredentialStore } from "../storage/credentials.js";
import type { DurableWorkStore } from "../storage/durable-work.js";

/**
 * What the operator can see before there is a screen.
 *
 * REQ-081 and REQ-088 both demand an alert "visible to the operator", and until
 * Phase 3 there is no interface to show one in. So visibility is defined
 * concretely: an `alert` entry in the audit trail, AND a command that reports
 * it and exits non-zero while the alert stands. An alert that only exists in a
 * log satisfies neither requirement, because nobody is watching a log.
 *
 * "Open" is decided by recency rather than by a status column: the newest alert
 * entry wins. A failing check that later succeeds closes itself, with no state
 * to reconcile and no way for the two to drift.
 */

export interface OperationalStatus {
  /** False on a fresh installation. Not an alert: nothing has broken yet. */
  readonly credentialConfigured: boolean;
  readonly authPath?: string;
  readonly expiresAt?: Date;
  readonly lastCheckedAt?: Date;
  readonly lastRefreshedAt?: Date;
  /** Present while the newest alert entry is a failure. */
  readonly openAlert?: {
    readonly origin: "machine" | "instance";
    readonly reason: string;
    readonly occurredAt: Date;
    readonly subtype?: string;
    readonly automationId?: string;
  };
  readonly pendingWork: number;
}

export interface StatusDeps {
  readonly credentials: CredentialStore;
  readonly audit: AuditRepository;
  readonly work: DurableWorkStore;
}

export async function readOperationalStatus(
  deps: StatusDeps,
): Promise<OperationalStatus> {
  const [stored, alerts, pendingWork] = await Promise.all([
    deps.credentials.read(),
    deps.audit.query({ kind: "alert", limit: 1, order: "newest" }),
    deps.work.countPending(),
  ]);

  const newest = alerts[0];
  const openAlert =
    newest?.outcome === "failed"
      ? {
          origin:
            newest.subtype === "automation_auto_paused"
              ? ("machine" as const)
              : ("instance" as const),
          reason: newest.reason ?? "",
          occurredAt: newest.occurredAt,
          ...(newest.subtype !== undefined && { subtype: newest.subtype }),
          ...(newest.automationId !== undefined && {
            automationId: newest.automationId,
          }),
        }
      : undefined;

  return {
    credentialConfigured: stored !== undefined,
    ...(stored !== undefined && { authPath: stored.authPath }),
    ...(stored?.expiresAt !== undefined && { expiresAt: stored.expiresAt }),
    ...(stored?.lastCheckedAt !== undefined && {
      lastCheckedAt: stored.lastCheckedAt,
    }),
    ...(stored?.lastRefreshedAt !== undefined && {
      lastRefreshedAt: stored.lastRefreshedAt,
    }),
    ...(openAlert !== undefined && { openAlert }),
    pendingWork,
  };
}
