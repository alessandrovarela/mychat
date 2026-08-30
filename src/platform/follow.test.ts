import { describe, expect, it } from "vitest";
import type { FollowStatus } from "../engine/ports.js";
import type { AccountCredential, PlatformAccount } from "./account.js";
import { createFollowLink, FOLLOW_FIELD } from "./follow.js";
import type { PlatformRequest, PlatformResponse } from "./transport.js";

/**
 * Proves the platform half of REQ-027: the confirmed field is what is asked
 * for, on the host the account port names, and NOTHING but that field coming
 * back `true` is ever read as "follows".
 *
 * The asymmetry is the whole subject. A gate that opens because a query could
 * not be made hands over a resource that cannot be recalled, and the field is
 * documented to be unavailable for a contact who is not in a conversation
 * (docs/platform-limits.md, item 7), so that case is ordinary rather than
 * exotic. Every failure shape below is therefore asserted twice: as the cause
 * it names, and as NOT a follower.
 */

const CONTACT = "17841400000000000";

const CREDENTIAL: AccountCredential = {
  path: "instagram_login",
  host: "graph.instagram.com",
  accessToken: "token-1",
  accountId: "acct-1",
};

function accountStub(host = CREDENTIAL.host): PlatformAccount {
  return {
    current: () => Promise.resolve({ ...CREDENTIAL, host }),
    check: () => Promise.resolve({ ok: true }),
    refreshIfNeeded: () => Promise.resolve({ kind: "not_needed" }),
  };
}

/** Answers from a fixture and records what would have left the process. */
function recordingTransport(answer: PlatformResponse) {
  const sent: PlatformRequest[] = [];

  return {
    sent,
    transport: (request: PlatformRequest): Promise<PlatformResponse> => {
      sent.push(request);
      return Promise.resolve(answer);
    },
  };
}

function answering(body: unknown, status = 200): PlatformResponse {
  return { status, body };
}

async function statusFrom(
  response: PlatformResponse,
  host?: string,
): Promise<FollowStatus> {
  const { transport } = recordingTransport(response);
  return await createFollowLink({
    account: accountStub(host),
    transport,
  }).status(CONTACT);
}

describe("REQ-027: the query the platform actually answers", () => {
  it("asks the user node for the confirmed field, with the stored token", async () => {
    const { sent, transport } = recordingTransport(
      answering({ [FOLLOW_FIELD]: true }),
    );

    await createFollowLink({ account: accountStub(), transport }).status(
      CONTACT,
    );

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      method: "GET",
      path: `/${CONTACT}`,
      query: { fields: FOLLOW_FIELD, access_token: CREDENTIAL.accessToken },
    });
    // REQ-005: the field is the mechanism the feasibility work confirmed, and
    // a rename here would be a query the platform answers with nothing.
    expect(FOLLOW_FIELD).toBe("is_user_follow_business");
  });

  it("takes the host from the account port and never from a literal", async () => {
    // The system-user path (ADR-022) uses a different host entirely, so the
    // proof is that the SAME adapter follows the port to two of them. The
    // repository-wide scan for a written-down host lives in
    // `src/platform/sending.test.ts` and covers this file too.
    const first = recordingTransport(answering({ [FOLLOW_FIELD]: true }));
    const second = recordingTransport(answering({ [FOLLOW_FIELD]: true }));

    await createFollowLink({
      account: accountStub("graph.instagram.com"),
      transport: first.transport,
    }).status(CONTACT);
    await createFollowLink({
      account: accountStub("graph.facebook.com"),
      transport: second.transport,
    }).status(CONTACT);

    expect(first.sent[0]?.host).toBe("graph.instagram.com");
    expect(second.sent[0]?.host).toBe("graph.facebook.com");
  });

  it("reads the field as the answer it is", async () => {
    expect(await statusFrom(answering({ [FOLLOW_FIELD]: true }))).toStrictEqual(
      {
        kind: "follows",
      },
    );
    expect(
      await statusFrom(answering({ [FOLLOW_FIELD]: false })),
    ).toStrictEqual({ kind: "does_not_follow" });
  });
});

describe("REQ-027: a query that cannot answer is never a yes", () => {
  it("reports a successful answer that omits the field as `field_absent`", async () => {
    // The documented case, and the one this project will meet most: the field
    // belongs to the messaging User Profile API and answers for a contact who
    // is in a conversation. The other fields still arrive, so a reader that
    // took a missing boolean for `false`, or worse for `true`, would look
    // perfectly healthy.
    const status = await statusFrom(
      answering({ id: CONTACT, name: "Ana", follower_count: 12 }),
    );

    expect(status.kind).toBe("unknown");
    expect(status.kind === "unknown" && status.cause).toBe("field_absent");
    // The detail carries what came back, because "the platform said nothing
    // about it" and "the platform was never asked" send an operator to
    // different places.
    expect(status.kind === "unknown" && status.detail).toContain("Ana");
  });

  it("reports a refusal by the platform as `refused`, quoting it", async () => {
    const status = await statusFrom(
      answering(
        {
          error: {
            message:
              "Unsupported get request. Object with ID does not exist, cannot be loaded due to missing permissions",
          },
        },
        400,
      ),
    );

    expect(status.kind).toBe("unknown");
    expect(status.kind === "unknown" && status.cause).toBe("refused");
    expect(status.kind === "unknown" && status.detail).toContain(
      "missing permissions",
    );
  });

  it("separates the platform's own failure, which a retry may survive", async () => {
    const status = await statusFrom(answering({ error: {} }, 503));

    expect(status.kind === "unknown" && status.cause).toBe("unreachable");
  });

  it("reports a transport that never got an answer as `unreachable`", async () => {
    const status = await createFollowLink({
      account: accountStub(),
      transport: () => Promise.reject(new Error("getaddrinfo ENOTFOUND")),
    }).status(CONTACT);

    expect(status.kind).toBe("unknown");
    expect(status.kind === "unknown" && status.cause).toBe("unreachable");
    expect(status.kind === "unknown" && status.detail).toContain("ENOTFOUND");
  });

  it("reports having nothing to ask with as `no_credential`", async () => {
    const status = await createFollowLink({
      account: {
        current: () =>
          Promise.reject(new Error("no platform credential is configured")),
        check: () => Promise.resolve({ ok: true }),
        refreshIfNeeded: () => Promise.resolve({ kind: "not_needed" }),
      },
      transport: () => {
        throw new Error("the transport must not be reached without a token");
      },
    }).status(CONTACT);

    expect(status.kind).toBe("unknown");
    expect(status.kind === "unknown" && status.cause).toBe("no_credential");
  });

  it.each([
    ["a body nobody can read", answering("<html>gateway</html>")],
    ["no body at all", answering(null)],
    ["a field that is not a boolean", answering({ [FOLLOW_FIELD]: "true" })],
    ["a field that is null", answering({ [FOLLOW_FIELD]: null })],
  ])("reports %s as `malformed`", async (_label, response) => {
    const status = await statusFrom(response);

    expect(status.kind).toBe("unknown");
    expect(status.kind === "unknown" && status.cause).toBe("malformed");
  });

  it("answers `follows` for the field being true and for nothing else", async () => {
    // The invariant of this file, asserted over every shape at once. A single
    // leak here is the irreversible failure of the whole step, and it is
    // exactly what an optimistic reader (`Boolean(body.is_user_follow_business)`
    // over a body that may not carry it, or a `catch` that shrugs) would
    // produce while every other test above still passed.
    const shapes: readonly PlatformResponse[] = [
      answering({ [FOLLOW_FIELD]: false }),
      answering({ id: CONTACT }),
      answering({}),
      answering(null),
      answering("truthy string"),
      answering({ [FOLLOW_FIELD]: "true" }),
      answering({ [FOLLOW_FIELD]: 1 }),
      answering({ [FOLLOW_FIELD]: true }, 401),
      answering({ [FOLLOW_FIELD]: true }, 403),
      answering({ [FOLLOW_FIELD]: true }, 500),
    ];

    for (const shape of shapes) {
      expect((await statusFrom(shape)).kind, JSON.stringify(shape)).not.toBe(
        "follows",
      );
    }

    // And the one shape that IS a yes, so the assertion above cannot be
    // satisfied by an adapter that answers "unknown" to everything.
    expect((await statusFrom(answering({ [FOLLOW_FIELD]: true }))).kind).toBe(
      "follows",
    );
  });
});
