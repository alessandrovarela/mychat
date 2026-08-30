import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import type { AuditRepository } from "../storage/audit.js";
import type { ReceivedEventStore } from "./received-events.js";
import { verifySignature } from "./signature.js";

/**
 * The webhook route: the application's only public surface, and the entry
 * point for everything the product does.
 *
 * Hard rule of the KEEL, repeated here because breaking it fails silently:
 * NOTHING may authenticate in front of `/webhook`. Not the app's own auth,
 * not a proxy, not Cloudflare Access (ADR-011 carves out an explicit bypass).
 * An auth layer here does not produce a visible error — it produces deliveries
 * that never arrive and, eventually, an unsubscribed app.
 */

declare module "fastify" {
  interface FastifyRequest {
    /**
     * The bytes of the body exactly as they arrived, for the ONE thing that
     * cannot be computed from the parsed object: the signature digest
     * (REQ-002).
     *
     * Optional because it is set only inside the webhook's own scope, by the
     * parser registered there. Everywhere else in the process it is undefined,
     * and no route outside that scope may read it.
     */
    rawBody?: Buffer;
  }
}

/** What the route does with an accepted event. Runs AFTER the response. */
export type EventHandler = (payload: unknown, eventId: string) => Promise<void>;

export interface WebhookDeps {
  readonly verifyToken: string;
  readonly appSecret: string;
  readonly events: ReceivedEventStore;
  readonly audit: AuditRepository;
  readonly now: () => Date;
  /**
   * Invoked after the response is sent. Optional so a deployment that only
   * needs to acknowledge (a smoke test, the first boot) still works.
   */
  readonly onEvent?: EventHandler;
}

/**
 * Extracts an id that identifies this DELIVERY. The platform nests it
 * differently per event kind, so the lookup is defensive: an event whose id
 * cannot be found is processed rather than dropped, because losing a real
 * delivery costs more than running one twice (recorded in the phase spec's
 * clarification record).
 */
export function eventIdOf(payload: unknown): string | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;

  const entry = (payload as { entry?: unknown }).entry;
  if (!Array.isArray(entry) || entry.length === 0) return undefined;

  const first = entry[0] as {
    id?: unknown;
    time?: unknown;
    messaging?: unknown;
  };
  const parts: string[] = [];

  if (typeof first.id === "string") parts.push(first.id);
  if (typeof first.time === "number") parts.push(String(first.time));

  if (Array.isArray(first.messaging) && first.messaging.length > 0) {
    const message = (first.messaging[0] as { message?: { mid?: unknown } })
      .message;
    if (typeof message?.mid === "string") parts.push(message.mid);
  }

  return parts.length > 0 ? parts.join(":") : undefined;
}

/** A server that can be asked when its post-response work has drained. */
export interface WebhookServer extends FastifyInstance {
  /** Resolves once every handler started so far has finished. */
  whenIdle(): Promise<void>;
}

export function buildWebhookServer(deps: WebhookDeps): WebhookServer {
  const inFlight = new Set<Promise<void>>();

  const app = Fastify({
    logger: false,
    bodyLimit: 1024 * 1024,
  });

  /**
   * The two public routes, registered inside their OWN encapsulated scope. The
   * reason is the content type parser below, and REQ-107 exists because an
   * earlier version of this file got it wrong twice over.
   *
   * The signature can only be computed over the bytes as they ARRIVED
   * (REQ-002, and signature.ts says why), which Fastify's default JSON parser
   * discards. So this route needs its own parser. Two rules govern it:
   *
   *   1. it hands the route the PARSED OBJECT, exactly like the default parser
   *      does, and puts the bytes beside the body on `request.rawBody`.
   *      Wrapping the body in an envelope changes what the handler of every
   *      route receives, and a route with a closed input schema then answers
   *      400 to a perfectly correct request.
   *   2. it is registered HERE and not on the root instance, so it governs
   *      these two routes and nothing else. `addContentTypeParser` is
   *      encapsulated by scope (verified against Fastify 5 in
   *      `webhook.test.ts`, not assumed), so every other route in this process
   *      keeps the default parser, and a route added later cannot inherit this
   *      one's special needs by accident.
   *
   * Both together are what the requirement asks for: the raw bytes survive for
   * the digest, and no other route can tell that this one needed them.
   */
  app.register(async (webhook) => {
    webhook.addContentTypeParser(
      "application/json",
      { parseAs: "buffer" },
      (request, body, done) => {
        try {
          const raw = body as Buffer;
          // Beside the body, never around it.
          request.rawBody = raw;
          done(null, JSON.parse(raw.toString("utf8")) as unknown);
        } catch (error) {
          done(error as Error, undefined);
        }
      },
    );

    /**
     * Subscription verification (REQ-001). The platform expects the challenge
     * echoed back as PLAIN TEXT: a JSON-quoted string fails the handshake with
     * no useful error.
     */
    webhook.get("/webhook", async (request, reply) => {
      const query = request.query as Record<string, string | undefined>;
      const mode = query["hub.mode"];
      const token = query["hub.verify_token"];
      const challenge = query["hub.challenge"];

      if (
        mode === "subscribe" &&
        token === deps.verifyToken &&
        challenge !== undefined
      ) {
        return reply.code(200).type("text/plain").send(challenge);
      }

      // Nothing is recorded as an event here: a failed handshake is not an
      // event, and recording it would pollute the trail an operator reads.
      return reply.code(403).send();
    });

    webhook.post("/webhook", async (request, reply) => {
      // The bytes as received, and never `JSON.stringify(request.body)`: a
      // round trip through the parser changes whitespace and key order, and
      // the digest then stops matching for reasons that look like a platform
      // bug (REQ-002).
      const raw = request.rawBody ?? Buffer.alloc(0);
      const header = request.headers["x-hub-signature-256"];

      const verdict = verifySignature(
        raw,
        typeof header === "string" ? header : undefined,
        deps.appSecret,
      );

      if (!verdict.valid) {
        // None of the three records this route writes carries a subtype, and
        // the absence is deliberate (REQ-106). They are about the DELIVERY,
        // and a delivery is not one interaction: the platform documents
        // batching, so one accepted body may carry a comment and a direct
        // message at once, and there is no single origin such a row could
        // honestly claim. A rejected signature is worse still, since nothing
        // in that body has been established as coming from the platform at
        // all. The origin is written where it is actually known, one row per
        // interaction, by the dispatcher.
        await deps.audit.record(
          {
            kind: "event_received",
            outcome: "failed",
            reason: `signature ${verdict.reason}`,
          },
          deps.now(),
        );
        return reply.code(403).send();
      }

      // The parsed object, which is what the parser above hands every route
      // it governs.
      const payload: unknown = request.body;
      const eventId = eventIdOf(payload);

      // Idempotency BEFORE the response, because the check is a fast local
      // write and doing it after would let two redeliveries both pass it
      // (REQ-004).
      if (eventId !== undefined) {
        const fresh = await deps.events.claim(eventId, deps.now());
        if (!fresh) {
          await deps.audit.record(
            {
              kind: "event_received",
              outcome: "duplicate",
              eventId,
              reason: "already processed",
            },
            deps.now(),
          );
          // 200, not an error: the platform is behaving correctly by retrying,
          // and anything else invites it to retry harder.
          return reply.code(200).send();
        }
      }

      await deps.audit.record(
        {
          kind: "event_received",
          outcome: "ok",
          ...(eventId !== undefined && { eventId }),
        },
        deps.now(),
      );

      // REQ-003: the response goes out BEFORE any processing. The platform
      // redelivers whatever it does not get acknowledged quickly, and
      // processing inline turns one slow send into a storm of duplicates.
      reply.code(200).send();

      if (deps.onEvent !== undefined) {
        const handler = deps.onEvent;
        const id = eventId ?? "unidentified";

        // `setImmediate`, not a bare async call. An async function body runs
        // SYNCHRONOUSLY up to its first await, so invoking the handler
        // directly would execute it inside the request cycle, exactly what
        // REQ-003 forbids, and invisible unless a test asserts the ordering.
        //
        // Tracked, too: an untracked detached promise is unobservable, so a
        // shutdown cannot wait for it and a test cannot know when it finished.
        // That is how work silently disappears on deploy.
        const work = new Promise<void>((resolve) => {
          setImmediate(() => {
            void handler(payload, id)
              .catch(async (cause: unknown) => {
                await deps.audit.record(
                  {
                    kind: "event_received",
                    outcome: "failed",
                    ...(eventId !== undefined && { eventId }),
                    reason:
                      cause instanceof Error ? cause.message : String(cause),
                  },
                  deps.now(),
                );
              })
              .finally(() => {
                inFlight.delete(work);
                resolve();
              });
          });
        });

        inFlight.add(work);
      }

      return reply;
    });
  });

  const server = Object.assign(app, {
    whenIdle: async (): Promise<void> => {
      // Loops because a handler may enqueue nothing but can still be replaced
      // by another arriving while this one drains.
      while (inFlight.size > 0) {
        await Promise.all([...inFlight]);
      }
    },
  });

  return server;
}
