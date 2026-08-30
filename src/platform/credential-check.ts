import type { Clock } from "../engine/ports.js";
import { t } from "../i18n/index.js";
import type { AuditRepository } from "../storage/audit.js";
import type { CredentialHealth, PlatformAccount } from "./account.js";

/**
 * The periodic credential check (REQ-081, REQ-088), as durable work.
 *
 * Two requirements meet here, and they are not the same one. REQ-081 is about
 * a token that EXPIRES and must be renewed before it does. REQ-088 is about a
 * credential that STOPS WORKING for any reason at all — revoked, user removed
 * from the portfolio, permission withdrawn — and holds even on the path where
 * nothing ever expires. Merging them would leave that path failing in silence.
 *
 * Every outcome that an operator would want to know about becomes an `alert`
 * entry in the audit trail. Nothing here prints: the CLI reads the trail.
 */

/** How the check reschedules itself. One mechanism, one clock (ADR-005). */
export const CREDENTIAL_CHECK_KEY = "credential-check";

export type CredentialCheckOutcome =
  | { readonly kind: "healthy"; readonly expiresAt?: Date }
  | { readonly kind: "renewed"; readonly expiresAt: Date }
  | { readonly kind: "alert"; readonly reason: string };

export interface CredentialCheckDeps {
  readonly account: PlatformAccount;
  readonly audit: AuditRepository;
}

/**
 * Runs one check: renew if the expiry is near, then confirm the credential
 * still works.
 *
 * The order matters. Checking first and renewing after would report a token
 * that is about to die as perfectly healthy, which is true and useless.
 */
export async function runCredentialCheck(
  deps: CredentialCheckDeps,
  now: Date,
): Promise<CredentialCheckOutcome> {
  const refresh = await deps.account
    .refreshIfNeeded(now)
    .catch((error: unknown): { kind: "failed"; reason: string } => ({
      kind: "failed",
      reason: error instanceof Error ? error.message : String(error),
    }));

  if (refresh.kind === "failed") {
    const reason = t("credential.refreshFailed", { reason: refresh.reason });
    // Each alert names WHICH alert it is (REQ-106). Renewal that failed and a
    // credential that no longer works are different problems with different
    // answers, and a count that merges them tells the operator neither.
    await deps.audit.record(
      {
        kind: "alert",
        subtype: "credential_refresh_failed",
        outcome: "failed",
        reason,
      },
      now,
    );
    return { kind: "alert", reason };
  }

  if (refresh.kind === "renewed") {
    // A renewal is recorded even though nothing went wrong: REQ-081 asks for
    // every renewal to be on the record WITH its new expiry, which is the only
    // way an operator can tell renewal is actually happening.
    await deps.audit.record(
      {
        kind: "alert",
        subtype: "credential_renewed",
        outcome: "ok",
        reason: t("credential.renewed", {
          expiresAt: refresh.expiresAt.toISOString(),
        }),
      },
      now,
    );
  }

  // A check that throws IS a failed check: the credential could not be
  // confirmed, and "we could not tell" must never be reported as "fine".
  const health: CredentialHealth = await deps.account
    .check(now)
    .catch(() => ({ ok: false, reason: "unreachable" }) as const);

  if (!health.ok) {
    const reason = t("credential.unusable", { reason: health.reason });
    await deps.audit.record(
      {
        kind: "alert",
        subtype: "credential_unusable",
        outcome: "failed",
        reason,
      },
      now,
    );
    return { kind: "alert", reason };
  }

  if (refresh.kind === "renewed") {
    return { kind: "renewed", expiresAt: refresh.expiresAt };
  }

  return health.expiresAt === undefined
    ? { kind: "healthy" }
    : { kind: "healthy", expiresAt: health.expiresAt };
}

/**
 * The sweep handler. It always defers itself to the next interval, healthy or
 * not: a check that stopped rescheduling after one failure would go quiet
 * exactly when the operator most needs it to keep speaking.
 */
export function createCredentialCheckHandler(
  deps: CredentialCheckDeps & {
    readonly clock: Clock;
    readonly intervalMs: number;
  },
) {
  // The work item carries nothing this handler needs: there is one credential,
  // and the row exists only to give the check a due instant that survives a
  // restart.
  return async (): Promise<{
    kind: "defer";
    dueAt: Date;
    reason?: string;
  }> => {
    // Read here rather than at wiring time: the handler runs inside a sweep
    // pass that may have taken real time to reach it.
    const now = deps.clock.now();
    const outcome = await runCredentialCheck(deps, now);

    return {
      kind: "defer",
      dueAt: new Date(now.getTime() + deps.intervalMs),
      ...(outcome.kind === "alert" && { reason: outcome.reason }),
    };
  };
}
