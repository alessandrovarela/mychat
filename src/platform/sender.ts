import type { OutboundMessage } from "../engine/ports.js";
import type { SendAttempt } from "../runtime/policy.js";
import type { WorkItem } from "../storage/durable-work.js";
import type { PlatformAccount } from "./account.js";
import { isSuccess } from "./transport.js";
import type { PlatformRequest, PlatformTransport } from "./transport.js";
import { checkWindow } from "./windows.js";
import type { ExecutionOrigin, WindowLimits } from "./windows.js";

/**
 * The adapter that actually talks to the platform (REQ-090).
 *
 * This is the most likely place for the whole phase to fail in production
 * while passing every test, so the shapes are stated here once and asserted
 * once:
 *
 *   - a PUBLIC reply to a comment is `POST /<comment-id>/replies`;
 *   - a PRIVATE message born from a comment is `POST /<ig-id>/messages` with
 *     the recipient given as `comment_id` — NOT as `id`. This is the only way
 *     to open a conversation from a comment, and it OPENS one: it is the door,
 *     not the room. Only the first message of a run may go through it
 *     (REQ-097), which is why this adapter is told whether a send is the
 *     private reply instead of deducing it from the origin;
 *   - an ordinary direct message is `POST /<ig-id>/messages` with the recipient
 *     given as `id`.
 *
 * The host is never written here. It comes from the account port, because the
 * two authentication paths use different hosts (ADR-022) and an adapter that
 * hard-coded one would break the moment the other was configured.
 */

/** What a queued send carries. Built by the queueing sender, read here. */
export interface SendPayload {
  readonly action: "reply_comment" | "direct_message";
  readonly message: OutboundMessage;
  readonly origin: ExecutionOrigin;
  /** Instant the applicable window counts from, ISO-8601. */
  readonly since: string;
  /** Present for a public reply, and for a private reply born from one. */
  readonly commentId?: string;
  readonly contactId?: string;
  /**
   * Whether THIS send is the private reply, decided when it was queued.
   *
   * It is not derivable from the origin, and that is the whole point: a run born
   * from a comment sends more than one message, and only the FIRST of them may
   * travel as a private reply (REQ-097). Absent, the old inference stands, so
   * rows queued before this field existed still address themselves correctly.
   */
  readonly privateReply?: boolean;
}

export interface SenderDeps {
  readonly account: PlatformAccount;
  readonly transport: PlatformTransport;
  readonly limits: WindowLimits;
  readonly now: () => Date;
}

/**
 * The envelope of a generic template, shared by the two kinds of button that
 * live inside one. Written once so the two callers below cannot drift into
 * sending the same structure under two slightly different shapes.
 */
function genericTemplate(
  title: string,
  buttons: readonly Record<string, unknown>[],
  options: { readonly imageUrl?: string; readonly subtitle?: string } = {},
): Record<string, unknown> {
  return {
    attachment: {
      type: "template",
      payload: {
        template_type: "generic",
        elements: [
          {
            title,
            ...(options.imageUrl !== undefined && {
              image_url: options.imageUrl,
            }),
            ...(options.subtitle !== undefined && {
              subtitle: options.subtitle,
            }),
            buttons,
          },
        ],
      },
    },
  };
}

/**
 * Message body as the Send API expects it, built from delivery intent.
 *
 * `privateReply` chooses the mechanism for ordinary quick replies. A
 * `cardButtons` message is the exception fixed by ADR-027: it promises a
 * card-shaped call to action, so it is a generic template on either path.
 *
 * The two paths differ because the platform forces them apart. A message
 * addressed by `comment_id` (the private reply, the only way to open a
 * conversation from a comment) cannot carry `quick_replies`: observed on the
 * real platform on 2026-08-02, and the failure mode is the worst kind, because
 * the API answers `500: An unknown error has occurred` AND DELIVERS the message
 * anyway. Five retries against that produced five identical messages to one
 * contact, which is precisely the spam this product exists to avoid.
 *
 * A generic template with `postback` buttons DOES travel that path: captured
 * from a real webhook echo of another tool sending a private reply on the same
 * account. So the private reply keeps its button, in the one shape the platform
 * accepts there, instead of degrading to a question the contact must type an
 * answer to.
 *
 * The open conversation keeps `quick_replies` because it is the native
 * mechanism there: no template, a higher button ceiling, and none of the
 * generic template's documented absence on the desktop app.
 *
 * REQ-318 is that split read from the contact's side, and it is what makes the
 * follow gate's loop possible at all (REQ-316): the FIRST card of a
 * comment-born run has to be tappable, and on that one path only the postback
 * template is. A ceiling comes with each mechanism and the label has to fit the
 * tighter one, so the words the instance configures are kept short
 * (`docs/platform-limits.md`).
 */
function toMessageBody(
  message: OutboundMessage,
  privateReply: boolean,
): Record<string, unknown> {
  if (message.card !== undefined) {
    // Meta requires a title even though the product contract does not. A
    // zero-width space satisfies the transport without inventing customer copy
    // or exposing an internal field in the authored card.
    return genericTemplate(
      message.card.title ?? "\u200b",
      message.card.buttons.map((button) => ({
        type: "web_url",
        url: button.url,
        title: button.label,
      })),
      {
        ...(message.card.imageUrl !== undefined && {
          imageUrl: message.card.imageUrl,
        }),
        ...(message.card.description !== undefined && {
          subtitle: message.card.description,
        }),
      },
    );
  }

  if (message.link !== undefined) {
    // A URL button lives inside a generic template, a different mechanism from
    // a quick reply, with its own ceiling, and documented as unavailable on the
    // desktop app. A message carries a link OR choices, never both, which is
    // what lets these two template cases stay apart.
    return genericTemplate(message.text, [
      { type: "web_url", url: message.link.url, title: message.link.label },
    ]);
  }

  if (message.attachment !== undefined) {
    /*
     * The declared kind chooses the attachment TYPE (REQ-231).
     *
     * `image` and `file` are two different things to the Send API: an image is
     * `type: "image"` and is rendered in the conversation, a document is
     * `type: "file"` and arrives as an attachment to download, and the two
     * accept different formats and different ceilings (png/jpeg up to 8 MB,
     * pdf up to 25 MB — "Send messages", v26.0, consulted 2026-08-16). Sending
     * everything as `file`, which is what this adapter did until 3k.17, made
     * every image arrive as a download.
     *
     * Asked of the kind rather than of the URL: the extension of a public
     * bucket URL is a guess, and it would be made at the instant nothing can be
     * done about being wrong.
     */
    return {
      attachment: {
        type: message.attachment.kind === "image" ? "image" : "file",
        payload: { url: message.attachment.url, is_reusable: true },
      },
    };
  }

  if (message.cardButtons !== undefined) {
    return genericTemplate(
      message.text,
      message.cardButtons.map((title) => ({
        type: "postback",
        title,
        payload: title,
      })),
    );
  }

  if (message.quickReplies !== undefined) {
    // The payload is the title on both mechanisms, deliberately. It is NOT a
    // routing key: a tap finds the run it belongs to by the CONTACT (see
    // `routeInbound`), never by what the payload says. Keeping it equal to the
    // title means the value that comes back reads the same whichever mechanism
    // carried it, since a quick reply returns a message whose text is the title
    // and a postback returns `postback.title`.
    return privateReply
      ? genericTemplate(
          message.text,
          message.quickReplies.map((title) => ({
            type: "postback",
            title,
            payload: title,
          })),
        )
      : {
          text: message.text,
          quick_replies: message.quickReplies.map((title) => ({
            content_type: "text",
            title,
            payload: title,
          })),
        };
  }

  return { text: message.text };
}

/**
 * Builds the request for one send. Separated from performing it so the fast
 * suite can assert the shape without a transport at all.
 */
export function buildSendRequest(
  payload: SendPayload,
  host: string,
  accountId: string,
  accessToken: string,
): PlatformRequest {
  if (payload.action === "reply_comment") {
    return {
      method: "POST",
      host,
      path: `/${payload.commentId ?? ""}/replies`,
      query: { access_token: accessToken },
      body: { message: payload.message.text },
    };
  }

  const privateReply =
    payload.privateReply ??
    (payload.origin === "comment" && payload.commentId !== undefined);

  const recipient = privateReply
    ? { comment_id: payload.commentId }
    : { id: payload.contactId ?? "" };

  return {
    method: "POST",
    host,
    path: `/${accountId}/messages`,
    query: { access_token: accessToken },
    body: {
      recipient,
      message: toMessageBody(payload.message, privateReply),
    },
  };
}

/** Status codes that mean "come back later" rather than "never". */
function classify(status: number): SendAttempt["kind"] {
  if (status === 429) return "rate_limited";
  if (status >= 500) return "transient";
  return "permanent";
}

/**
 * The send attempt the queue policy wraps. It reports WHAT happened and knows
 * nothing about caps or backoff — those belong to `withSendPolicy`.
 */
export function createPlatformSender(
  deps: SenderDeps,
): (item: WorkItem) => Promise<SendAttempt> {
  return async (item: WorkItem): Promise<SendAttempt> => {
    const payload = item.payload as SendPayload;
    const now = deps.now();

    const verdict = checkWindow(
      payload.origin,
      new Date(payload.since),
      now,
      deps.limits,
    );

    if (!verdict.allowed) {
      // Nothing is built and nothing is sent. Waiting cannot fix an expired
      // window, so this is permanent rather than a retry.
      return { kind: "permanent", reason: verdict.reason };
    }

    const credential = await deps.account.current();
    const response = await deps.transport(
      buildSendRequest(
        payload,
        credential.host,
        credential.accountId,
        credential.accessToken,
      ),
    );

    if (isSuccess(response)) {
      const messageId = (response.body as { message_id?: unknown } | null)
        ?.message_id;
      return {
        kind: "sent",
        ...(typeof messageId === "string" &&
          messageId !== "" && {
            platformMessageId: messageId,
          }),
      };
    }

    const kind = classify(response.status);

    if (kind === "transient") {
      // A 5xx means the platform RECEIVED the request and then failed to say
      // what it did with it. It may have delivered: observed on 2026-08-02,
      // where five 500s produced five delivered messages. The queue policy
      // needs to know that retrying here risks duplicating, not recovering.
      return {
        kind,
        reason: describeError(response.status, response.body),
        deliveryUncertain: true,
      };
    }

    if (kind === "rate_limited") {
      return {
        kind,
        ...(response.retryAfterSeconds !== undefined && {
          retryAfterMs: response.retryAfterSeconds * 1000,
        }),
      };
    }

    return {
      kind,
      reason: describeError(response.status, response.body),
      category:
        response.status === 401 || response.status === 403
          ? "credential"
          : "delivery",
    };
  };
}

function describeError(status: number, body: unknown): string {
  const message = (body as { error?: { message?: unknown } } | null)?.error
    ?.message;
  return typeof message === "string" ? `${status}: ${message}` : String(status);
}
