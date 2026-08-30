import type { CredentialStore } from "../storage/credentials.js";
import type {
  AccountCredential,
  CredentialFailure,
  CredentialHealth,
  PlatformAccount,
  RefreshOutcome,
} from "./account.js";
import { isSuccess } from "./transport.js";
import type { PlatformTransport } from "./transport.js";

/**
 * The Instagram Login authentication path (ADR-021, ADR-022).
 *
 * Chosen to ship first because it is the path a self-hoster can actually take:
 * a system user "cannot exist independently" of a business portfolio, so
 * adopting it would impose a Facebook Page, a portfolio and possibly Business
 * Verification on everyone installing MyChat. Instagram Login explicitly does
 * not require a Facebook Page.
 *
 * The consequence is REQ-081, and it is not optional: on this path NO token is
 * eternal — one hour for the short-lived one, sixty days for the long-lived
 * one. Without automatic renewal every installation dies after sixty days, in
 * silence, and the operator has no way to tell why.
 */

/** This path's API host. The system-user path uses a different one entirely. */
export const INSTAGRAM_LOGIN_HOST = "graph.instagram.com";

/**
 * Permissions this path needs. Named here rather than in the caller because
 * the OTHER path spells the comment one differently
 * (`instagram_manage_comments`), and a caller that hard-coded either would
 * break the moment the account port returned the other path.
 */
export const INSTAGRAM_LOGIN_SCOPES = [
  "instagram_business_basic",
  "instagram_business_manage_messages",
  "instagram_business_manage_comments",
] as const;

const REFRESH_PATH = "/refresh_access_token";
const IDENTITY_PATH = "/me";

export interface InstagramLoginDeps {
  readonly credentials: CredentialStore;
  readonly transport: PlatformTransport;
  /**
   * How long before expiry a renewal is attempted. Well inside the sixty days,
   * so a failing renewal has many further chances before the token dies.
   */
  readonly refreshThresholdMs: number;
}

/** Message shape the platform uses for an expired or withdrawn credential. */
function classifyFailure(status: number, body: unknown): CredentialFailure {
  const message = extractErrorMessage(body).toLowerCase();

  if (message.includes("expired")) {
    return "expired";
  }
  // The platform reports a revoked token and a withdrawn permission with the
  // same status, so the message is the only thing that separates them — and an
  // operator needs to know which one, because the fixes are different.
  if (message.includes("permission")) {
    return "permission_removed";
  }
  if (status === 401 || status === 403 || status === 400) {
    return "revoked";
  }
  return "unreachable";
}

function extractErrorMessage(body: unknown): string {
  if (typeof body === "string") {
    return body;
  }
  const error = (body as { error?: { message?: unknown } } | null)?.error;
  return typeof error?.message === "string" ? error.message : "";
}

export function createInstagramLoginAccount(
  deps: InstagramLoginDeps,
): PlatformAccount {
  async function requireStored(): Promise<AccountCredential> {
    const stored = await deps.credentials.read();

    if (stored === undefined) {
      // Not a catalogue message: it is a programming error to ask for a
      // credential on a path that never had one configured. The operator-facing
      // version of this fact is the `status` command.
      throw new Error("no platform credential is configured");
    }

    return {
      path: "instagram_login",
      host: INSTAGRAM_LOGIN_HOST,
      accessToken: stored.accessToken,
      accountId: stored.accountId,
      ...(stored.expiresAt !== undefined && { expiresAt: stored.expiresAt }),
    };
  }

  return {
    current: requireStored,

    async check(now: Date): Promise<CredentialHealth> {
      const credential = await requireStored();

      if (
        credential.expiresAt !== undefined &&
        credential.expiresAt.getTime() <= now.getTime()
      ) {
        // Answered without a call: the platform would only confirm what the
        // stored expiry already says, and spending a call to be told so is
        // exactly the waste the private-reply ceiling cannot afford.
        return { ok: false, reason: "expired" };
      }

      const response = await deps.transport({
        method: "GET",
        host: credential.host,
        path: IDENTITY_PATH,
        query: { fields: "id", access_token: credential.accessToken },
      });

      await deps.credentials.recordCheck(now);

      if (!isSuccess(response)) {
        return {
          ok: false,
          reason: classifyFailure(response.status, response.body),
        };
      }

      return credential.expiresAt === undefined
        ? { ok: true }
        : { ok: true, expiresAt: credential.expiresAt };
    },

    async refreshIfNeeded(now: Date): Promise<RefreshOutcome> {
      const credential = await requireStored();

      if (credential.expiresAt === undefined) {
        // Cannot happen on this path, and is still the right answer to give:
        // the port is shared with a path where it CAN happen, and a renewal
        // there is inert rather than wrong.
        return { kind: "not_applicable" };
      }

      const remaining = credential.expiresAt.getTime() - now.getTime();
      if (remaining > deps.refreshThresholdMs) {
        return { kind: "not_needed" };
      }

      const response = await deps.transport({
        method: "GET",
        host: credential.host,
        path: REFRESH_PATH,
        query: {
          grant_type: "ig_refresh_token",
          access_token: credential.accessToken,
        },
      });

      if (!isSuccess(response)) {
        return {
          kind: "failed",
          reason: extractErrorMessage(response.body) || String(response.status),
        };
      }

      const body = response.body as {
        access_token?: unknown;
        expires_in?: unknown;
      } | null;

      if (
        typeof body?.access_token !== "string" ||
        typeof body.expires_in !== "number"
      ) {
        // A 200 with a body nobody can read is worse than an error: storing a
        // partial credential would swap a working token for a broken one.
        return { kind: "failed", reason: "malformed renewal response" };
      }

      const expiresAt = new Date(now.getTime() + body.expires_in * 1000);
      await deps.credentials.recordRefresh(body.access_token, expiresAt, now);

      return { kind: "renewed", expiresAt };
    },
  };
}
