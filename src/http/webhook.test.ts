import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createOperatorCredentialStore } from "../auth/credential.js";
import {
  AUTH_THROTTLE_DEFAULTS,
  createAuthThrottle,
} from "../auth/throttle.js";
import {
  createSessionStore,
  DEFAULT_SESSION_TTL_MS,
  SESSION_COOKIE_NAME,
} from "../auth/session.js";
import { createAuditRepository } from "../storage/audit.js";
import type { AuditRepository } from "../storage/audit.js";
import { IN_MEMORY_DATABASE, openDatabase } from "../storage/database.js";
import type { DatabaseHandle } from "../storage/database.js";
import { registerAccess } from "./access.js";
import { createReceivedEventStore } from "./received-events.js";
import { buildWebhookServer, eventIdOf } from "./webhook.js";
import type { WebhookServer } from "./webhook.js";

/**
 * Proves REQ-001 to REQ-004: the webhook verifies its subscription, rejects
 * anything it cannot authenticate, answers before doing any work, and turns a
 * redelivery into exactly one execution.
 *
 * Injected through Fastify's own inject(), so no port is bound and no network
 * is touched — the fast suite stays fast and the commit gate stays usable.
 *
 * And REQ-032, which is about what must NOT be here: with the operator's
 * authentication registered on this same instance, the platform still reaches
 * the webhook carrying no cookie at all.
 */

const VERIFY_TOKEN = "verify-me";
const APP_SECRET = "app-secret";
const NOW = new Date("2026-08-01T12:00:00.000Z");

function sign(body: string): string {
  return `sha256=${createHmac("sha256", APP_SECRET).update(body).digest("hex")}`;
}

function eventBody(id = "17841400000000000", time = 1754049600): string {
  return JSON.stringify({
    object: "instagram",
    entry: [
      {
        id,
        time,
        messaging: [
          {
            sender: { id: "contact-1" },
            message: { mid: "mid-1", text: "quero" },
          },
        ],
      },
    ],
  });
}

describe("the webhook", () => {
  let handle: DatabaseHandle;
  let audit: AuditRepository;
  let app: WebhookServer;
  let handled: string[];

  beforeEach(() => {
    handle = openDatabase({ databasePath: IN_MEMORY_DATABASE });
    audit = createAuditRepository(handle.db);
    handled = [];

    app = buildWebhookServer({
      verifyToken: VERIFY_TOKEN,
      appSecret: APP_SECRET,
      events: createReceivedEventStore(handle.db),
      audit,
      now: () => NOW,
      onEvent: (_payload, eventId) => {
        handled.push(eventId);
        return Promise.resolve();
      },
    });
  });

  afterEach(async () => {
    // Drains post-response work so it cannot leak into the next test.
    await app.whenIdle();
    await app.close();
    handle.close();
  });

  describe("REQ-001: subscription verification", () => {
    it("records a successful platform confirmation", async () => {
      let confirmations = 0;
      const confirmedApp = buildWebhookServer({
        verifyToken: VERIFY_TOKEN,
        appSecret: APP_SECRET,
        events: createReceivedEventStore(handle.db),
        audit,
        now: () => NOW,
        onConfirmed: async () => {
          confirmations += 1;
        },
      });
      const response = await confirmedApp.inject({
        method: "GET",
        url: "/webhook",
        query: {
          "hub.mode": "subscribe",
          "hub.verify_token": VERIFY_TOKEN,
          "hub.challenge": "challenge",
        },
      });
      expect(response.statusCode).toBe(200);
      expect(confirmations).toBe(1);
      await confirmedApp.close();
    });

    it("echoes the challenge as plain text when the token is right", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/webhook",
        query: {
          "hub.mode": "subscribe",
          "hub.verify_token": VERIFY_TOKEN,
          "hub.challenge": "1158201444",
        },
      });

      expect(response.statusCode).toBe(200);
      // Plain text, not JSON: a quoted string fails the handshake with no
      // useful error on the platform side.
      expect(response.body).toBe("1158201444");
      expect(response.headers["content-type"]).toContain("text/plain");
    });

    it("refuses a wrong token with 403 and records no event", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/webhook",
        query: {
          "hub.mode": "subscribe",
          "hub.verify_token": "wrong",
          "hub.challenge": "1158201444",
        },
      });

      expect(response.statusCode).toBe(403);
      expect(await audit.query()).toHaveLength(0);
    });

    it("refuses a missing token", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/webhook",
        query: { "hub.mode": "subscribe", "hub.challenge": "x" },
      });

      expect(response.statusCode).toBe(403);
    });

    it("refuses a handshake until a verification token has been saved", async () => {
      const unconfigured = buildWebhookServer({
        verifyToken: "",
        appSecret: APP_SECRET,
        events: createReceivedEventStore(handle.db),
        audit,
        now: () => NOW,
      });

      const response = await unconfigured.inject({
        method: "GET",
        url: "/webhook",
        query: {
          "hub.mode": "subscribe",
          "hub.verify_token": "",
          "hub.challenge": "challenge",
        },
      });

      expect(response.statusCode).toBe(403);
      await unconfigured.close();
    });
  });

  describe("REQ-002: signature validation", () => {
    it("refuses events until the Meta App Secret has been saved", async () => {
      const unconfigured = buildWebhookServer({
        verifyToken: VERIFY_TOKEN,
        appSecret: "",
        events: createReceivedEventStore(handle.db),
        audit,
        now: () => NOW,
        onEvent: (_payload, eventId) => {
          handled.push(eventId);
          return Promise.resolve();
        },
      });

      const body = eventBody();
      const response = await unconfigured.inject({
        method: "POST",
        url: "/webhook",
        headers: {
          "content-type": "application/json",
          "x-hub-signature-256": sign(body),
        },
        payload: body,
      });

      expect(response.statusCode).toBe(403);
      await unconfigured.whenIdle();
      expect(handled).toEqual([]);
      await unconfigured.close();
    });

    it("accepts a body whose signature matches", async () => {
      const body = eventBody();

      const response = await app.inject({
        method: "POST",
        url: "/webhook",
        headers: {
          "content-type": "application/json",
          "x-hub-signature-256": sign(body),
        },
        payload: body,
      });

      expect(response.statusCode).toBe(200);
    });

    it("rejects a missing signature with 403 and creates no execution", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/webhook",
        headers: { "content-type": "application/json" },
        payload: eventBody(),
      });

      expect(response.statusCode).toBe(403);
      await app.whenIdle();
      expect(handled).toEqual([]);

      const trail = await audit.query();
      expect(trail[0]?.outcome).toBe("failed");
      expect(trail[0]?.reason).toContain("missing");
    });

    it("rejects a malformed signature", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/webhook",
        headers: {
          "content-type": "application/json",
          "x-hub-signature-256": "garbage",
        },
        payload: eventBody(),
      });

      expect(response.statusCode).toBe(403);
      expect((await audit.query())[0]?.reason).toContain("malformed");
    });

    it("verifies over the bytes received, not over a re-serialisation", async () => {
      // The same document, formatted. Re-serialising the parsed object would
      // produce different bytes and therefore a different digest, so this
      // delivery is accepted only if the check reads what actually arrived.
      // A compact body cannot catch that: its re-serialisation happens to be
      // identical to itself.
      const body = JSON.stringify(JSON.parse(eventBody()) as unknown, null, 2);

      const response = await app.inject({
        method: "POST",
        url: "/webhook",
        headers: {
          "content-type": "application/json",
          "x-hub-signature-256": sign(body),
        },
        payload: body,
      });

      expect(response.statusCode).toBe(200);
      expect(await audit.query({ outcome: "ok" })).toHaveLength(1);
    });

    it("rejects a signature computed over a different body", async () => {
      // The exact attack the signature exists to stop: a valid-looking digest
      // that does not belong to these bytes.
      const response = await app.inject({
        method: "POST",
        url: "/webhook",
        headers: {
          "content-type": "application/json",
          "x-hub-signature-256": sign("something else entirely"),
        },
        payload: eventBody(),
      });

      expect(response.statusCode).toBe(403);
      expect(handled).toEqual([]);
      expect((await audit.query())[0]?.reason).toContain("mismatch");
    });
  });

  describe("REQ-003: the answer precedes the work", () => {
    it("responds before the handler runs", async () => {
      const order: string[] = [];
      const slowApp = buildWebhookServer({
        verifyToken: VERIFY_TOKEN,
        appSecret: APP_SECRET,
        events: createReceivedEventStore(handle.db),
        audit,
        now: () => NOW,
        onEvent: () => {
          order.push("handler");
          return Promise.resolve();
        },
      });

      const body = eventBody();
      const response = await slowApp.inject({
        method: "POST",
        url: "/webhook",
        headers: {
          "content-type": "application/json",
          "x-hub-signature-256": sign(body),
        },
        payload: body,
      });
      order.push("response");

      expect(response.statusCode).toBe(200);
      // The response is observed first. Processing inline would turn one slow
      // send into a storm of platform redeliveries.
      expect(order[0]).toBe("response");

      await slowApp.whenIdle();
      await slowApp.close();
    });
  });

  describe("REQ-004: a redelivery produces exactly one execution", () => {
    it("processes the first delivery and marks the second a duplicate", async () => {
      const body = eventBody();
      const headers = {
        "content-type": "application/json",
        "x-hub-signature-256": sign(body),
      };

      const first = await app.inject({
        method: "POST",
        url: "/webhook",
        headers,
        payload: body,
      });
      const second = await app.inject({
        method: "POST",
        url: "/webhook",
        headers,
        payload: body,
      });

      // Both answer 200: the platform is behaving correctly by retrying, and
      // anything else invites it to retry harder.
      expect(first.statusCode).toBe(200);
      expect(second.statusCode).toBe(200);

      const duplicates = await audit.query({ outcome: "duplicate" });
      expect(duplicates).toHaveLength(1);

      const accepted = await audit.query({ outcome: "ok" });
      expect(accepted).toHaveLength(1);
    });

    it("treats two genuinely different events as two events", async () => {
      for (const id of ["event-a", "event-b"]) {
        const body = eventBody(id);
        await app.inject({
          method: "POST",
          url: "/webhook",
          headers: {
            "content-type": "application/json",
            "x-hub-signature-256": sign(body),
          },
          payload: body,
        });
      }

      expect(await audit.query({ outcome: "ok" })).toHaveLength(2);
      expect(await audit.query({ outcome: "duplicate" })).toHaveLength(0);
    });
  });
});

/**
 * REQ-032 and acceptance criterion 3: with the operator's authentication
 * registered on this very instance, the platform is answered normally.
 *
 * The private route registered beside the webhook is not decoration. Without
 * it, every assertion below would also pass on a build whose guard was never
 * armed at all, and would prove nothing about where the guard is.
 *
 * What this file CANNOT catch, by construction, is the guard being registered
 * globally with `/webhook` on an exception list: that arrangement answers the
 * platform correctly today and breaks the next route somebody adds. The test
 * for THAT lives in `src/auth/session.test.ts` ("answers a route registered
 * outside the scope with no cookie at all"), and the two are only worth
 * anything together.
 */
describe("REQ-032: the platform reaches the webhook with no session", () => {
  const PRIVATE_ROUTE = "/api/probe";

  let handle: DatabaseHandle;
  let app: WebhookServer;
  let handled: string[];

  beforeEach(() => {
    handle = openDatabase({ databasePath: IN_MEMORY_DATABASE });
    handled = [];

    app = buildWebhookServer({
      verifyToken: VERIFY_TOKEN,
      appSecret: APP_SECRET,
      events: createReceivedEventStore(handle.db),
      audit: createAuditRepository(handle.db),
      now: () => NOW,
      onEvent: (_payload, eventId) => {
        handled.push(eventId);
        return Promise.resolve();
      },
    });

    registerAccess(
      app,
      {
        sessions: createSessionStore(handle.db),
        credentials: createOperatorCredentialStore(handle.db),
        // The production configuration, the strictest one there is.
        cookie: { secure: true, ttlMs: DEFAULT_SESSION_TTL_MS },
        now: () => NOW,
        throttle: createAuthThrottle(AUTH_THROTTLE_DEFAULTS),
        throttleLimits: AUTH_THROTTLE_DEFAULTS,
        audit: createAuditRepository(handle.db),
      },
      (scope) => {
        scope.post(PRIVATE_ROUTE, async () => ({ ok: true }));
      },
    );
  });

  afterEach(async () => {
    await app.whenIdle();
    await app.close();
    handle.close();
  });

  it("refuses the private route beside it, so the guard is armed", async () => {
    const response = await app.inject({ method: "POST", url: PRIVATE_ROUTE });

    expect(response.statusCode).toBe(401);
  });

  it("accepts a signed delivery with no cookie at all", async () => {
    const body = eventBody();

    const response = await app.inject({
      method: "POST",
      url: "/webhook",
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": sign(body),
      },
      payload: body,
    });

    expect(response.statusCode).toBe(200);
    // No 401, no redirect, and no authentication page in the body: those are
    // the three shapes REQ-032 names, and every one of them stops deliveries
    // without producing an error anywhere on our side.
    expect(response.statusCode).not.toBe(401);
    expect(response.headers["location"]).toBeUndefined();
    expect(String(response.headers["content-type"] ?? "")).not.toContain(
      "text/html",
    );
    expect(response.body).not.toContain("<html");
    // Nothing tried to open a session for the platform either.
    expect(response.headers["set-cookie"]).toBeUndefined();

    await app.whenIdle();
    expect(handled).toHaveLength(1);
  });

  it("answers the subscription handshake with no cookie at all", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/webhook",
      query: {
        "hub.mode": "subscribe",
        "hub.verify_token": VERIFY_TOKEN,
        "hub.challenge": "1158201444",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toBe("1158201444");
  });

  it("is not fooled into refusing by a garbage cookie either", async () => {
    // A stale or forged cookie must change nothing here: the platform is not
    // authenticated by one, so the route cannot start caring about it.
    const body = eventBody();

    const response = await app.inject({
      method: "POST",
      url: "/webhook",
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": sign(body),
      },
      cookies: { [SESSION_COOKIE_NAME]: "forged" },
      payload: body,
    });

    expect(response.statusCode).toBe(200);
  });
});

/**
 * REQ-107: the parser that keeps the raw bytes governs the webhook and nothing
 * else.
 *
 * `webhook.ts` claims that Fastify encapsulates a content type parser by scope,
 * and a comment that claims behaviour has to be checked: this is the check,
 * against Fastify 5 itself. The wider proof, the one over the COMPOSED
 * application with its real `/api` routes, is in `src/app.test.ts`, because
 * that is where the routes and the parser actually meet.
 */
describe("REQ-107: the raw body does not leak out of the webhook's scope", () => {
  const BESIDE_ROUTE = "/beside";

  let handle: DatabaseHandle;
  let app: WebhookServer;

  beforeEach(() => {
    handle = openDatabase({ databasePath: IN_MEMORY_DATABASE });

    app = buildWebhookServer({
      verifyToken: VERIFY_TOKEN,
      appSecret: APP_SECRET,
      events: createReceivedEventStore(handle.db),
      audit: createAuditRepository(handle.db),
      now: () => NOW,
    });
  });

  afterEach(async () => {
    await app.whenIdle();
    await app.close();
    handle.close();
  });

  it("hands a route registered beside it the object that route declared", async () => {
    let received: unknown;
    let rawBodyVisible = true;

    // The shape every route with an input schema has in this application: a
    // closed object with a required field. Under an envelope the two unknown
    // keys are stripped, `password` is missing, and the route answers 400.
    app.post(
      BESIDE_ROUTE,
      {
        schema: {
          body: {
            type: "object",
            required: ["password"],
            properties: { password: { type: "string" } },
            additionalProperties: false,
          },
        },
      },
      async (request) => {
        received = request.body;
        rawBodyVisible = request.rawBody !== undefined;
        return { ok: true };
      },
    );

    const response = await app.inject({
      method: "POST",
      url: BESIDE_ROUTE,
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ password: "segredo" }),
    });

    expect(response.statusCode).toBe(200);
    expect(received).toEqual({ password: "segredo" });
    // The bytes are the webhook's business alone: outside its scope the default
    // parser runs, so nothing else in the process carries a copy of every body.
    expect(rawBodyVisible).toBe(false);
  });

  it("still gives its own route the bytes, on the same instance", async () => {
    const body = eventBody();

    const response = await app.inject({
      method: "POST",
      url: "/webhook",
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": sign(body),
      },
      payload: body,
    });

    expect(response.statusCode).toBe(200);
  });
});

describe("extracting the delivery id", () => {
  it("combines the entry id, its time and the message id", () => {
    expect(eventIdOf(JSON.parse(eventBody()))).toBe(
      "17841400000000000:1754049600:mid-1",
    );
  });

  it("returns undefined when the payload carries nothing identifying", () => {
    // Such an event is PROCESSED rather than dropped: losing a real delivery
    // costs more than running one twice (phase spec, clarification Q5).
    expect(eventIdOf({})).toBeUndefined();
    expect(eventIdOf({ entry: [] })).toBeUndefined();
    expect(eventIdOf(null)).toBeUndefined();
    expect(eventIdOf("nonsense")).toBeUndefined();
  });
});
