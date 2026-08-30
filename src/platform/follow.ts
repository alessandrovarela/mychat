import type {
  FollowLink,
  FollowStatus,
  FollowUnknownCause,
} from "../engine/ports.js";
import type { PlatformAccount } from "./account.js";
import { isSuccess } from "./transport.js";
import type { PlatformTransport } from "./transport.js";

/**
 * Reading whether a contact follows the account (REQ-027, REQ-005).
 *
 * This is the first platform call of the project that is not a send and not a
 * credential check, and it is a READ whose wrong answer cannot be undone. The
 * mechanism is the one the feasibility work confirmed and wrote down
 * (docs/platform-limits.md, item 7): the field `is_user_follow_business` on the
 * user node, with `instagram_business_basic` and
 * `instagram_business_manage_messages`.
 *
 * The documented limit is the design constraint, not a footnote: the field
 * belongs to the messaging User Profile API and answers for a contact who is in
 * a CONVERSATION, not for an arbitrary user. So "the platform would not say" is
 * an ordinary outcome of this adapter, produced several ways, and every one of
 * them is reported as `unknown` with the cause named. NOTHING here returns
 * `follows` except the field itself coming back `true`. That is the single
 * invariant this file exists to keep: a gate that opens on an unanswered query
 * gives the resource away, and no later layer can take it back.
 */

/** The field REQ-005 confirmed answers this question. */
export const FOLLOW_FIELD = "is_user_follow_business";

export interface FollowLinkDeps {
  readonly account: PlatformAccount;
  readonly transport: PlatformTransport;
}

function unknown(cause: FollowUnknownCause, detail?: string): FollowStatus {
  return { kind: "unknown", cause, ...(detail !== undefined && { detail }) };
}

function describeThrown(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** What the platform said about its own refusal, as far as it said anything. */
function describeError(response: { status: number; body: unknown }): string {
  const message = (response.body as { error?: { message?: unknown } } | null)
    ?.error?.message;
  return typeof message === "string"
    ? `${String(response.status)}: ${message}`
    : String(response.status);
}

/**
 * An error status, read as a cause.
 *
 * Below 500 the platform ANSWERED and said no: a withdrawn permission and an id
 * it will not load for us arrive this way, and both are `refused`. They are not
 * split further here because the platform spells them alike and only the
 * message tells them apart, which is exactly what the detail carries. From 500
 * up nobody answered anything, and that is a different fact for the operator: a
 * retry may work, while a refusal will not.
 */
function causeOf(status: number): FollowUnknownCause {
  return status >= 500 ? "unreachable" : "refused";
}

export function createFollowLink(deps: FollowLinkDeps): FollowLink {
  return {
    async status(contactId: string): Promise<FollowStatus> {
      let credential;
      try {
        credential = await deps.account.current();
      } catch (error) {
        // An installation with no credential cannot ask, and must not guess.
        return unknown("no_credential", describeThrown(error));
      }

      let response;
      try {
        response = await deps.transport({
          method: "GET",
          // Never written here (REQ-090, ADR-022): the two authentication paths
          // use different hosts, and a literal would keep working on one and
          // break on the other with no test able to see it.
          host: credential.host,
          path: `/${contactId}`,
          query: {
            fields: FOLLOW_FIELD,
            access_token: credential.accessToken,
          },
        });
      } catch (error) {
        return unknown("unreachable", describeThrown(error));
      }

      if (!isSuccess(response)) {
        return unknown(causeOf(response.status), describeError(response));
      }

      if (typeof response.body !== "object" || response.body === null) {
        return unknown("malformed", String(response.status));
      }

      const value = (response.body as Record<string, unknown>)[FOLLOW_FIELD];

      if (value === undefined) {
        // A 200 that carries everything except the answer. The documented
        // reading is a contact who is not in a conversation, which is the very
        // case this project expects to meet (docs/platform-limits.md, item 7).
        return unknown("field_absent", JSON.stringify(response.body));
      }

      if (typeof value !== "boolean") {
        return unknown("malformed", JSON.stringify(value));
      }

      return value ? { kind: "follows" } : { kind: "does_not_follow" };
    },
  };
}
