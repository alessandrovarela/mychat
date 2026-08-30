import { readFileSync } from "node:fs";
import { globSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LIMIT_DEFAULTS } from "../config/limits.js";
import type { OutboundMessage } from "../engine/ports.js";
import { MESSAGE_PAUSE_MS, createQueueingSender } from "../runtime/outbox.js";
import {
  createDurableWorkStore,
  IN_MEMORY_DATABASE,
  openDatabase,
} from "../storage/index.js";
import type { DatabaseHandle, DurableWorkStore } from "../storage/index.js";
import type { PlatformAccount } from "./account.js";
import { buildSendRequest, createPlatformSender } from "./sender.js";
import type { SendPayload } from "./sender.js";
import type { PlatformRequest, PlatformResponse } from "./transport.js";
import { checkWindow } from "./windows.js";

/**
 * Proves REQ-019, REQ-080 and REQ-090.
 *
 * These three are the phase's most likely production failure: the endpoints of
 * a public reply and a private message are different, the recipient of a
 * private reply is `comment_id` and NOT `id`, and the window comes from the
 * ORIGIN of the execution rather than from the contact. Every one of them
 * passes a careless test and fails against the real platform.
 */

const NOW = new Date("2026-08-01T10:00:00.000Z");
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

const limits = {
  messageWindowHours: LIMIT_DEFAULTS.messageWindowHours,
  commentReplyWindowDays: LIMIT_DEFAULTS.commentReplyWindowDays,
};

const credential = {
  path: "instagram_login" as const,
  host: "graph.instagram.com",
  accessToken: "token-1",
  accountId: "ig-account-1",
};

function accountStub(host = credential.host): PlatformAccount {
  return {
    current: () => Promise.resolve({ ...credential, host }),
    check: () => Promise.resolve({ ok: true as const }),
    refreshIfNeeded: () => Promise.resolve({ kind: "not_needed" as const }),
  };
}

function capturing(response: PlatformResponse = { status: 200, body: {} }) {
  const sent: PlatformRequest[] = [];
  return {
    sent,
    transport: (request: PlatformRequest): Promise<PlatformResponse> => {
      sent.push(request);
      return Promise.resolve(response);
    },
  };
}

function workItem(payload: SendPayload) {
  return {
    id: 1,
    kind: "send" as const,
    dedupeKey: "k",
    status: "pending" as const,
    dueAt: NOW,
    attempts: 0,
    payload,
    contactId: payload.contactId ?? null,
    executionId: "exec-1",
    sendClass: "direct_message" as const,
    lastReason: null,
  };
}

describe("REQ-080: the window comes from the origin, not from the contact", () => {
  it("gives a comment-born execution seven days", () => {
    const sixDays = new Date(NOW.getTime() - 6 * DAY);

    expect(checkWindow("comment", sixDays, NOW, limits)).toMatchObject({
      allowed: true,
      window: "comment_reply_7d",
    });
  });

  it("gives a message-born execution twenty-four hours", () => {
    const sixDays = new Date(NOW.getTime() - 6 * DAY);
    const verdict = checkWindow("direct_message", sixDays, NOW, limits);

    expect(verdict.allowed).toBe(false);
    if (verdict.allowed) return;
    expect(verdict.window).toBe("direct_message_24h");
  });

  it("decides differently for the two origins at the SAME instant", () => {
    // The heart of the requirement: two days old passes on one path and fails
    // on the other. A single window would lose six days or invent six.
    const twoDays = new Date(NOW.getTime() - 2 * DAY);

    expect(checkWindow("comment", twoDays, NOW, limits).allowed).toBe(true);
    expect(checkWindow("direct_message", twoDays, NOW, limits).allowed).toBe(
      false,
    );
  });

  it("names both the window and the origin when it refuses", () => {
    const verdict = checkWindow(
      "comment",
      new Date(NOW.getTime() - 8 * DAY),
      NOW,
      limits,
    );

    expect(verdict.allowed).toBe(false);
    if (verdict.allowed) return;
    expect(verdict.reason).toContain("comment_reply_7d");
    expect(verdict.reason).toContain("comment");
  });

  it("takes both durations from configuration, not from a literal", () => {
    const twoDays = new Date(NOW.getTime() - 2 * DAY);

    expect(
      checkWindow("comment", twoDays, NOW, {
        messageWindowHours: 24,
        commentReplyWindowDays: 1,
      }).allowed,
    ).toBe(false);
  });
});

describe("REQ-019: outside the window nothing is even built", () => {
  it("refuses without touching the transport", async () => {
    const { sent, transport } = capturing();
    const send = createPlatformSender({
      account: accountStub(),
      transport,
      limits,
      now: () => NOW,
    });

    const attempt = await send(
      workItem({
        action: "direct_message",
        message: { text: "hello" },
        origin: "direct_message",
        since: new Date(NOW.getTime() - 25 * HOUR).toISOString(),
        contactId: "contact-1",
      }),
    );

    expect(attempt.kind).toBe("permanent");
    // Spending a call to be refused is a call the private-reply ceiling
    // cannot afford.
    expect(sent).toHaveLength(0);
  });

  it("records the reason with the window and the origin", async () => {
    const { transport } = capturing();
    const send = createPlatformSender({
      account: accountStub(),
      transport,
      limits,
      now: () => NOW,
    });

    const attempt = await send(
      workItem({
        action: "direct_message",
        message: { text: "hello" },
        origin: "comment",
        since: new Date(NOW.getTime() - 8 * DAY).toISOString(),
        commentId: "comment-1",
        contactId: "contact-1",
      }),
    );

    if (attempt.kind !== "permanent") throw new Error("expected a refusal");
    expect(attempt.reason).toContain("comment_reply_7d");
    expect(attempt.reason).toContain("comment");
  });
});

describe("REQ-090: the endpoint and the recipient per origin", () => {
  it("replies publicly to a comment at /<comment-id>/replies", () => {
    const request = buildSendRequest(
      {
        action: "reply_comment",
        message: { text: "check your DMs" },
        origin: "comment",
        since: NOW.toISOString(),
        commentId: "comment-42",
      },
      credential.host,
      credential.accountId,
      credential.accessToken,
    );

    expect(request.path).toBe("/comment-42/replies");
    expect(request.body).toEqual({ message: "check your DMs" });
  });

  it("addresses a comment-born private message by comment_id", () => {
    const request = buildSendRequest(
      {
        action: "direct_message",
        message: { text: "here it is" },
        origin: "comment",
        since: NOW.toISOString(),
        commentId: "comment-42",
        contactId: "contact-1",
      },
      credential.host,
      credential.accountId,
      credential.accessToken,
    );

    expect(request.path).toBe("/ig-account-1/messages");
    // NOT `id`. This is the only way to open a conversation from a comment,
    // and the mistake is invisible until it reaches the real platform.
    expect(request.body).toMatchObject({
      recipient: { comment_id: "comment-42" },
    });
    expect(request.body).not.toMatchObject({ recipient: { id: "contact-1" } });
  });

  it("addresses an ordinary direct message by contact id", () => {
    const request = buildSendRequest(
      {
        action: "direct_message",
        message: { text: "here it is" },
        origin: "direct_message",
        since: NOW.toISOString(),
        contactId: "contact-1",
      },
      credential.host,
      credential.accountId,
      credential.accessToken,
    );

    expect(request.body).toMatchObject({ recipient: { id: "contact-1" } });
  });

  it("renders a link as a URL button inside a generic template", () => {
    const request = buildSendRequest(
      {
        action: "direct_message",
        message: {
          text: "here it is",
          link: { url: "https://cdn.example/guide.pdf", label: "Get it" },
        },
        origin: "direct_message",
        since: NOW.toISOString(),
        contactId: "contact-1",
      },
      credential.host,
      credential.accountId,
      credential.accessToken,
    );

    const body = request.body as {
      message: {
        attachment?: {
          payload?: {
            template_type?: string;
            elements?: { buttons?: { type?: string; url?: string }[] }[];
          };
        };
      };
    };
    expect(body.message.attachment?.payload?.template_type).toBe("generic");
    // A delivery carries a link and never choices, so the template it produces
    // is the URL one and is untouched by what the confirmation path does with
    // the same envelope.
    expect(body.message.attachment?.payload?.elements?.[0]?.buttons).toEqual([
      {
        type: "web_url",
        url: "https://cdn.example/guide.pdf",
        title: "Get it",
      },
    ]);
  });

  it("renders one complete card as one ordered generic template", () => {
    const request = buildSendRequest(
      {
        action: "direct_message",
        message: {
          text: "",
          card: {
            imageUrl: "https://cdn.example/cover.webp",
            title: "Choose",
            description: "In this order",
            buttons: [
              { id: "one", label: "One", url: "https://example.com/1" },
              { id: "two", label: "Two", url: "https://example.com/2" },
              { id: "three", label: "Three", url: "https://example.com/3" },
            ],
          },
        },
        origin: "direct_message",
        since: NOW.toISOString(),
        contactId: "contact-1",
      },
      credential.host,
      credential.accountId,
      credential.accessToken,
    );

    expect(request.body).toMatchObject({
      message: {
        attachment: {
          type: "template",
          payload: {
            template_type: "generic",
            elements: [
              {
                image_url: "https://cdn.example/cover.webp",
                title: "Choose",
                subtitle: "In this order",
                buttons: [
                  {
                    type: "web_url",
                    title: "One",
                    url: "https://example.com/1",
                  },
                  {
                    type: "web_url",
                    title: "Two",
                    url: "https://example.com/2",
                  },
                  {
                    type: "web_url",
                    title: "Three",
                    url: "https://example.com/3",
                  },
                ],
              },
            ],
          },
        },
      },
    });
  });

  it("uses an invisible transport fallback for a button-only card", () => {
    const request = buildSendRequest(
      {
        action: "direct_message",
        message: {
          text: "",
          card: {
            buttons: [
              { id: "open", label: "Open", url: "https://example.com" },
            ],
          },
        },
        origin: "direct_message",
        since: NOW.toISOString(),
        contactId: "contact-1",
      },
      credential.host,
      credential.accountId,
      credential.accessToken,
    );

    const body = request.body as {
      message: {
        attachment: { payload: { elements: Record<string, unknown>[] } };
      };
    };
    expect(body.message.attachment.payload.elements).toEqual([
      {
        title: "\u200b",
        buttons: [
          { type: "web_url", title: "Open", url: "https://example.com" },
        ],
      },
    ]);
  });

  it("REQ-231: sends an image as an image and a document as a file", () => {
    // Two DIFFERENT attachment types on the Send API, with different accepted
    // formats and different ceilings ("Send messages", v26.0, consulted
    // 2026-08-16). Everything used to travel as `file`, so every image arrived
    // as a download instead of being rendered in the conversation.
    const bodyFor = (
      attachment: SendPayload["message"]["attachment"],
    ): { type?: string; payload?: { url?: string } } =>
      (
        buildSendRequest(
          {
            action: "direct_message",
            message: {
              text: "",
              ...(attachment !== undefined && { attachment }),
            },
            origin: "direct_message",
            since: NOW.toISOString(),
            contactId: "contact-1",
          },
          credential.host,
          credential.accountId,
          credential.accessToken,
        ).body as {
          message: {
            attachment?: { type?: string; payload?: { url?: string } };
          };
        }
      ).message.attachment ?? {};

    expect(
      bodyFor({ url: "https://cdn.example/bonus.png", kind: "image" }),
    ).toEqual({
      type: "image",
      payload: { url: "https://cdn.example/bonus.png", is_reusable: true },
    });
    expect(
      bodyFor({ url: "https://cdn.example/guide.pdf", kind: "document" }),
    ).toEqual({
      type: "file",
      payload: { url: "https://cdn.example/guide.pdf", is_reusable: true },
    });
  });

  it("REQ-231: an attachment message carries no text beside it", () => {
    // The rule that forces two messages, asserted on the wire: the body the
    // adapter builds for an attachment has an `attachment` and no `text` at
    // all, so a delivery that tried to send both in one call would silently
    // lose one of them here.
    const body = buildSendRequest(
      {
        action: "direct_message",
        message: {
          text: "",
          attachment: {
            url: "https://cdn.example/guide.pdf",
            kind: "document",
          },
        },
        origin: "direct_message",
        since: NOW.toISOString(),
        contactId: "contact-1",
      },
      credential.host,
      credential.accountId,
      credential.accessToken,
    ).body as { message: Record<string, unknown> };

    expect(Object.keys(body.message)).toEqual(["attachment"]);
  });

  it("REQ-318: the choices of an ordinary message are quick_replies, not a template", () => {
    const request = buildSendRequest(
      {
        action: "direct_message",
        message: { text: "shall I send it?", quickReplies: ["Yes"] },
        origin: "direct_message",
        since: NOW.toISOString(),
        contactId: "contact-1",
      },
      credential.host,
      credential.accountId,
      credential.accessToken,
    );

    const body = request.body as {
      message: { quick_replies?: unknown[]; attachment?: unknown };
    };
    // In an open conversation the quick reply is the native mechanism, so a
    // template here would spend a heavier primitive for nothing.
    expect(body.message.quick_replies).toEqual([
      { content_type: "text", title: "Yes", payload: "Yes" },
    ]);
    expect(body.message.attachment).toBeUndefined();
  });

  it("REQ-342: follow-card choices are postback template buttons in an open conversation", () => {
    const request = buildSendRequest(
      {
        action: "direct_message",
        message: { text: "follow us", cardButtons: ["I followed"] },
        origin: "direct_message",
        since: NOW.toISOString(),
        contactId: "contact-1",
      },
      credential.host,
      credential.accountId,
      credential.accessToken,
    );

    const body = request.body as {
      message: {
        quick_replies?: unknown[];
        attachment?: {
          type?: string;
          payload?: {
            template_type?: string;
            elements?: { buttons?: unknown[] }[];
          };
        };
      };
    };

    expect(body.message.quick_replies).toBeUndefined();
    expect(body.message.attachment?.type).toBe("template");
    expect(body.message.attachment?.payload?.template_type).toBe("generic");
    expect(body.message.attachment?.payload?.elements?.[0]?.buttons).toEqual([
      { type: "postback", title: "I followed", payload: "I followed" },
    ]);
  });

  it("REQ-342: follow-card choices stay postback template buttons in a private reply", () => {
    const request = buildSendRequest(
      {
        action: "direct_message",
        message: { text: "follow us", cardButtons: ["I followed"] },
        origin: "comment",
        since: NOW.toISOString(),
        commentId: "comment-42",
        contactId: "contact-1",
      },
      credential.host,
      credential.accountId,
      credential.accessToken,
    );

    const body = request.body as {
      message: {
        quick_replies?: unknown[];
        attachment?: { payload?: { elements?: { buttons?: unknown[] }[] } };
      };
    };

    expect(body.message.quick_replies).toBeUndefined();
    expect(body.message.attachment?.payload?.elements?.[0]?.buttons).toEqual([
      { type: "postback", title: "I followed", payload: "I followed" },
    ]);
  });

  it("REQ-318: the choices of a PRIVATE reply are template postback buttons", () => {
    // Observed on the real platform: a private reply carrying `quick_replies`
    // answers 500 and delivers anyway, so five retries produced five messages
    // to one contact. A generic template with postback buttons does travel
    // this path, so the contact still gets a button instead of having to type.
    const request = buildSendRequest(
      {
        action: "direct_message",
        message: { text: "shall I send it?", quickReplies: ["Yes"] },
        origin: "comment",
        since: NOW.toISOString(),
        commentId: "comment-42",
        contactId: "contact-1",
      },
      credential.host,
      credential.accountId,
      credential.accessToken,
    );

    const body = request.body as {
      recipient: Record<string, string>;
      message: {
        quick_replies?: unknown[];
        attachment?: {
          type?: string;
          payload?: {
            template_type?: string;
            elements?: { title?: string; buttons?: unknown[] }[];
          };
        };
      };
    };
    expect(body.recipient).toEqual({ comment_id: "comment-42" });
    // The combination that answered 500 must not be built at all.
    expect(body.message.quick_replies).toBeUndefined();
    expect(body.message.attachment?.type).toBe("template");
    expect(body.message.attachment?.payload?.template_type).toBe("generic");
    const [element] = body.message.attachment?.payload?.elements ?? [];
    expect(element?.title).toBe("shall I send it?");
    expect(element?.buttons).toEqual([
      { type: "postback", title: "Yes", payload: "Yes" },
    ]);
  });

  it("REQ-318: a private reply gets one postback button per declared choice", () => {
    const request = buildSendRequest(
      {
        action: "direct_message",
        message: { text: "which one?", quickReplies: ["Yes", "Not now"] },
        origin: "comment",
        since: NOW.toISOString(),
        commentId: "comment-42",
        contactId: "contact-1",
      },
      credential.host,
      credential.accountId,
      credential.accessToken,
    );

    const body = request.body as {
      message: {
        attachment?: { payload?: { elements?: { buttons?: unknown[] }[] } };
      };
    };
    // The intent is "offer these choices": collapsing two into one button
    // would silently change what the contact was asked.
    expect(body.message.attachment?.payload?.elements?.[0]?.buttons).toEqual([
      { type: "postback", title: "Yes", payload: "Yes" },
      { type: "postback", title: "Not now", payload: "Not now" },
    ]);
  });

  it("REQ-318: the two paths stay apart, same intent, two mechanisms", () => {
    // The engine sends the identical message on both paths. Only the adapter
    // knows they cannot carry the same primitive.
    const message = { text: "shall I send it?", quickReplies: ["Yes"] };

    const open = buildSendRequest(
      {
        action: "direct_message",
        message,
        origin: "direct_message",
        since: NOW.toISOString(),
        contactId: "contact-1",
      },
      credential.host,
      credential.accountId,
      credential.accessToken,
    ).body as { message: { quick_replies?: unknown[]; attachment?: unknown } };

    const fromComment = buildSendRequest(
      {
        action: "direct_message",
        message,
        origin: "comment",
        since: NOW.toISOString(),
        commentId: "comment-42",
        contactId: "contact-1",
      },
      credential.host,
      credential.accountId,
      credential.accessToken,
    ).body as { message: { quick_replies?: unknown[]; attachment?: unknown } };

    expect(open.message.quick_replies).toHaveLength(1);
    expect(open.message.attachment).toBeUndefined();
    expect(fromComment.message.quick_replies).toBeUndefined();
    expect(fromComment.message.attachment).toBeDefined();
  });

  it("flags a 5xx as delivery-uncertain, because it may have been sent", async () => {
    const attempt = await createPlatformSender({
      account: accountStub(),
      transport: capturing({ status: 500, body: {} }).transport,
      limits,
      now: () => NOW,
    })(
      workItem({
        action: "direct_message",
        message: { text: "hello" },
        origin: "direct_message",
        since: NOW.toISOString(),
        contactId: "contact-1",
      }),
    );

    expect(attempt).toMatchObject({
      kind: "transient",
      deliveryUncertain: true,
    });
  });

  it("takes the host from the account port", async () => {
    const { sent, transport } = capturing();
    const send = createPlatformSender({
      // The other authentication path uses a different host entirely.
      account: accountStub("graph.facebook.com"),
      transport,
      limits,
      now: () => NOW,
    });

    await send(
      workItem({
        action: "direct_message",
        message: { text: "hello" },
        origin: "direct_message",
        since: NOW.toISOString(),
        contactId: "contact-1",
      }),
    );

    expect(sent[0]?.host).toBe("graph.facebook.com");
  });

  it("hard-codes no platform host outside the adapter", () => {
    // The guard proper: a host written anywhere else is a caller that would
    // keep working on one authentication path and break on the other.
    //
    // Parsed, not grepped: a comment explaining WHY the host must not be
    // hard-coded would otherwise be flagged as hard-coding it, and the guard
    // would push the explanation out of the code it explains.
    const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
    const HOST = /graph\.(instagram|facebook)\.com/;

    const literalHosts = (file: string): string[] => {
      const source = ts.createSourceFile(
        file,
        readFileSync(file, "utf8"),
        ts.ScriptTarget.ESNext,
        true,
      );
      const found: string[] = [];

      const visit = (node: ts.Node): void => {
        if (
          (ts.isStringLiteral(node) ||
            ts.isNoSubstitutionTemplateLiteral(node)) &&
          HOST.test(node.text)
        ) {
          found.push(file.replace(repoRoot, ""));
        }
        ts.forEachChild(node, visit);
      };

      visit(source);
      return found;
    };

    const offenders = globSync("src/**/*.ts", { cwd: repoRoot })
      .filter((relative) => !relative.endsWith(".test.ts"))
      // The adapter is where the host is ALLOWED to be written: it is what
      // the account port hands to everyone else.
      .filter((relative) => relative !== "src/platform/instagram-login.ts")
      .flatMap((relative) => literalHosts(`${repoRoot}${relative}`));

    expect(offenders).toEqual([]);
  });
});

describe("REQ-090: what the platform answered becomes what the queue does", () => {
  it("reports a 429 as rate limited, carrying the platform's own delay", async () => {
    const { transport } = capturing({
      status: 429,
      body: {},
      retryAfterSeconds: 120,
    });
    const send = createPlatformSender({
      account: accountStub(),
      transport,
      limits,
      now: () => NOW,
    });

    expect(
      await send(
        workItem({
          action: "direct_message",
          message: { text: "hello" },
          origin: "direct_message",
          since: NOW.toISOString(),
          contactId: "contact-1",
        }),
      ),
    ).toEqual({ kind: "rate_limited", retryAfterMs: 120_000 });
  });

  it("reports a 5xx as transient and a 4xx as permanent", async () => {
    const payload: SendPayload = {
      action: "direct_message",
      message: { text: "hello" },
      origin: "direct_message",
      since: NOW.toISOString(),
      contactId: "contact-1",
    };

    const transient = await createPlatformSender({
      account: accountStub(),
      transport: capturing({ status: 503, body: {} }).transport,
      limits,
      now: () => NOW,
    })(workItem(payload));

    const permanent = await createPlatformSender({
      account: accountStub(),
      transport: capturing({
        status: 400,
        body: { error: { message: "bad recipient" } },
      }).transport,
      limits,
      now: () => NOW,
    })(workItem(payload));

    expect(transient.kind).toBe("transient");
    expect(permanent).toMatchObject({
      kind: "permanent",
      reason: "400: bad recipient",
    });
  });
});

describe("the engine's sender queues instead of calling", () => {
  let handle: DatabaseHandle;
  let work: DurableWorkStore;

  beforeEach(() => {
    handle = openDatabase({ databasePath: IN_MEMORY_DATABASE });
    work = createDurableWorkStore(handle.db);
  });

  afterEach(() => {
    handle.close();
  });

  const clock = { now: () => NOW };

  it("turns a decided message into durable work", async () => {
    const sender = createQueueingSender(
      { work, clock },
      {
        origin: "comment",
        commentId: "comment-42",
        since: NOW,
        executionId: "exec-1",
      },
    );

    await sender.sendDirectMessage("contact-1", { text: "here it is" });

    const [queued] = await work.due(NOW);
    expect(queued?.executionId).toBe("exec-1");
    expect(queued?.sendClass).toBe("private_reply");
    expect(queued?.payload).toMatchObject({
      action: "direct_message",
      origin: "comment",
      commentId: "comment-42",
      contactId: "contact-1",
    });
  });

  it("queues two different messages of the same run, not one", async () => {
    const sender = createQueueingSender(
      { work, clock },
      { origin: "direct_message", since: NOW, executionId: "exec-1" },
    );

    await sender.sendDirectMessage("contact-1", { text: "shall I send it?" });
    await sender.sendDirectMessage("contact-1", { text: "here it is" });

    // A flow legitimately sends the confirmation and then the delivery; keying
    // both on the execution alone would drop the second as a duplicate.
    expect(await work.countPending()).toBe(2);
  });

  it("queues the same message of the same run only once", async () => {
    const sender = createQueueingSender(
      { work, clock },
      { origin: "direct_message", since: NOW, executionId: "exec-1" },
    );

    await sender.sendDirectMessage("contact-1", { text: "here it is" });
    await sender.sendDirectMessage("contact-1", { text: "here it is" });

    expect(await work.countPending()).toBe(1);
  });

  it("REQ-097: only the first direct message of a comment-born run is a private reply", async () => {
    const context = {
      origin: "comment" as const,
      commentId: "comment-42",
      since: NOW,
      executionId: "exec-1",
    };
    const sender = createQueueingSender({ work, clock }, context);

    await sender.sendDirectMessage("contact-1", { text: "here it is" });
    await sender.sendDirectMessage("contact-1", { text: "how did it go?" });

    const [first, second] = await work.due(NOW);

    // The door, then the room. The private reply OPENS the conversation from a
    // comment; addressing the follow-up the same way is what produced `500: An
    // unknown error has occurred` on the real platform — and delivered anyway,
    // reaching the contact twice.
    expect(first?.payload).toMatchObject({
      privateReply: true,
      commentId: "comment-42",
    });
    expect(second?.payload).toMatchObject({ privateReply: false });
    expect(second?.payload).not.toHaveProperty("commentId");

    // The addressing the adapter actually builds, which is the part the
    // platform judges.
    const bodyOf = (payload: unknown): unknown =>
      buildSendRequest(
        payload as SendPayload,
        credential.host,
        credential.accountId,
        credential.accessToken,
      ).body;

    expect(bodyOf(first?.payload)).toMatchObject({
      recipient: { comment_id: "comment-42" },
    });
    expect(bodyOf(second?.payload)).toMatchObject({
      recipient: { id: "contact-1" },
    });

    // And the follow-up stops charging the 750/h private-reply ceiling it no
    // longer uses.
    expect(first?.sendClass).toBe("private_reply");
    expect(second?.sendClass).toBe("direct_message");
  });

  it("REQ-097: the spent private reply is remembered by the queue, not by the sender", async () => {
    const context = {
      origin: "comment" as const,
      commentId: "comment-42",
      since: NOW,
      executionId: "exec-1",
    };

    await createQueueingSender({ work, clock }, context).sendDirectMessage(
      "contact-1",
      { text: "here it is" },
    );

    // A restart between the two messages builds a new sender from the same
    // context. Anything held in memory would hand the private reply out twice.
    await createQueueingSender({ work, clock }, context).sendDirectMessage(
      "contact-1",
      { text: "how did it go?" },
    );

    const [, second] = await work.due(NOW);
    expect(second?.payload).toMatchObject({ privateReply: false });
  });

  it("REQ-097: a public reply does not spend the private reply", async () => {
    const sender = createQueueingSender(
      { work, clock },
      {
        origin: "comment",
        commentId: "comment-42",
        since: NOW,
        executionId: "exec-1",
      },
    );

    // The anchor case answers the comment publicly and only then opens the
    // conversation. If the public reply counted as the private one, the message
    // that opens the conversation would be addressed by an id the contact has
    // never written to.
    await sender.replyToComment("comment-42", { text: "check your DMs" });
    await sender.sendDirectMessage("contact-1", { text: "here it is" });

    const [, direct] = await work.due(NOW);
    expect(direct?.payload).toMatchObject({
      privateReply: true,
      commentId: "comment-42",
    });
  });

  it("meters an attachment under the tighter media quota", async () => {
    const sender = createQueueingSender(
      { work, clock },
      { origin: "direct_message", since: NOW, executionId: "exec-1" },
    );

    await sender.sendDirectMessage("contact-1", {
      text: "",
      attachment: { url: "https://cdn.example/guide.pdf", kind: "document" },
    });

    const [queued] = await work.due(NOW);
    expect(queued?.sendClass).toBe("media");
  });

  /**
   * REQ-231: the two messages of one delivery, once they are rows.
   *
   * The queue is keyed by execution and step, so two sends of one run are one
   * row unless something tells them apart. That is not a detail here: the whole
   * point of splitting the delivery is lost if the queue swallows the half that
   * arrives second.
   */
  const deliveryPair = async (sender: {
    sendDirectMessage(id: string, message: OutboundMessage): Promise<void>;
  }): Promise<void> => {
    await sender.sendDirectMessage("contact-1", { text: "here is the guide" });
    await sender.sendDirectMessage("contact-1", {
      text: "",
      attachment: { url: "https://cdn.example/guide.pdf", kind: "document" },
    });
  };

  it("REQ-231: queues BOTH messages of one delivery, under different keys", async () => {
    const sender = createQueueingSender(
      { work, clock },
      { origin: "direct_message", since: NOW, executionId: "exec-1" },
    );

    await deliveryPair(sender);

    const queued = await work.sendsFor("exec-1");
    expect(queued).toHaveLength(2);
    // Named, and not only counted: the identity is what the UNIQUE column
    // enforces, and two rows with one key is the shape that would drop the
    // attachment in silence.
    expect(new Set(queued.map((item) => item.dedupeKey)).size).toBe(2);
  });

  it("REQ-286: queues two identical pure links as two rows, not one", async () => {
    const sender = createQueueingSender(
      { work, clock },
      { origin: "direct_message", since: NOW, executionId: "exec-1" },
    );

    // The same address declared twice is a legal delivery: the format counts
    // the links and refuses a fourth, it does not compare them. Their rows are
    // told apart by hashing the message, so what separates these two is the
    // position the engine stamped on each (`part`) and nothing else — with a
    // flag, or with nothing, the second would be dropped as a repeat of the
    // first and the contact would receive one message where two were declared.
    const repeated = "https://zeta.example/webinar";
    await sender.sendDirectMessage("contact-1", { text: "here it is" });
    await sender.sendDirectMessage("contact-1", { text: repeated, part: 2 });
    await sender.sendDirectMessage("contact-1", { text: repeated, part: 3 });

    const queued = await work.sendsFor("exec-1");
    expect(queued).toHaveLength(3);
    expect(new Set(queued.map((item) => item.dedupeKey)).size).toBe(3);
  });

  it("REQ-231: the attachment is due AFTER the message it belongs to", async () => {
    const sender = createQueueingSender(
      { work, clock },
      { origin: "direct_message", since: NOW, executionId: "exec-1" },
    );

    await deliveryPair(sender);

    const [message, attachment] = await work.sendsFor("exec-1");
    // The sweep hands everything due in one pass to the adapter back to back,
    // so two rows due at the same instant leave in the same second — which is
    // the burst a spam filter looks for. The gap is a due instant on the row,
    // never a sleep: it has to survive a restart, exactly like REQ-098's pause.
    expect(message?.dueAt).toEqual(NOW);
    expect(attachment?.dueAt.getTime()).toBe(NOW.getTime() + MESSAGE_PAUSE_MS);
    expect(await work.due(NOW)).toHaveLength(1);
  });

  it("REQ-231: a delivery that is only an attachment waits for nothing", async () => {
    const sender = createQueueingSender(
      { work, clock },
      { origin: "direct_message", since: NOW, executionId: "exec-1" },
    );

    await sender.sendDirectMessage("contact-1", {
      text: "",
      attachment: { url: "https://cdn.example/guide.pdf", kind: "document" },
    });

    // Nothing went before it, so there is nothing to be spaced from: pausing
    // here would delay a delivery for the sake of a gap that has no other side.
    const [only] = await work.sendsFor("exec-1");
    expect(only?.dueAt).toEqual(NOW);
  });

  it("REQ-231: the delivery spends the private reply on the MESSAGE, not the file", async () => {
    const sender = createQueueingSender(
      { work, clock },
      {
        origin: "comment",
        commentId: "comment-42",
        since: NOW,
        executionId: "exec-1",
      },
    );

    await deliveryPair(sender);

    const [message, attachment] = await work.sendsFor("exec-1");
    // The private reply is the door, and it opens once (REQ-097). The file
    // travels into the room the message opened; addressed by `comment_id` a
    // second time it is the shape that answered 500 and delivered anyway.
    expect(message?.payload).toMatchObject({ privateReply: true });
    expect(attachment?.payload).toMatchObject({ privateReply: false });
    expect(attachment?.payload).not.toHaveProperty("commentId");
  });
});
