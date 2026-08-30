import { createHmac, timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type {
  ButtonLinkWriter,
  Clock,
  OutboundCardButton,
} from "../engine/ports.js";
import type {
  ButtonClickMetrics,
  ButtonClickStore,
} from "../storage/button-clicks.js";

export const CLICKS_ROUTE_PREFIX = "/clicks";
const SIGNING_CONTEXT = "mychat/button-click/v1";

interface ClickRouteDeps {
  readonly store: ButtonClickStore;
  readonly secret: Buffer | string;
  readonly clock: Clock;
}

interface ButtonLinkDeps extends Pick<ClickRouteDeps, "store" | "secret"> {
  /** Public origin already normalised by the validated environment config. */
  readonly publicOrigin: string;
}

/** Explicit domain separation when reusing the validated Meta app secret. */
export function deriveClickSigningSecret(metaAppSecret: string): Buffer {
  return createHmac("sha256", metaAppSecret).update(SIGNING_CONTEXT).digest();
}

export function createButtonLinkWriter(deps: ButtonLinkDeps): ButtonLinkWriter {
  return {
    async wrap(buttons, context, at) {
      const wrapped: OutboundCardButton[] = [];
      for (const button of buttons) {
        const destination = await deps.store.destinationFor(
          context.automationId,
          button.id,
          button.url,
          at,
          button.label,
        );
        const signature = signClick(
          destination.id,
          context.contactId,
          context.executionId,
          deps.secret,
        );
        const query = new URLSearchParams({
          contactId: context.contactId,
          executionId: context.executionId,
          signature,
        });
        wrapped.push({
          ...button,
          url: `${deps.publicOrigin}${CLICKS_ROUTE_PREFIX}/${String(destination.id)}?${query.toString()}`,
        });
      }
      return wrapped;
    },
  };
}

/** Public and deliberately registered outside the operator session scope. */
export function registerClicksRoute(
  app: FastifyInstance,
  deps: ClickRouteDeps,
): void {
  app.get(`${CLICKS_ROUTE_PREFIX}/:destinationId`, async (request, reply) => {
    const params = request.params as { destinationId?: unknown };
    const query = request.query as Record<string, unknown>;
    const destinationId = positiveInteger(params.destinationId);
    const contactId = scalar(query["contactId"]);
    const executionId = scalar(query["executionId"]);
    const signature = scalar(query["signature"]);

    if (
      destinationId === undefined ||
      contactId === undefined ||
      executionId === undefined ||
      signature === undefined ||
      !verifyClick(
        destinationId,
        contactId,
        executionId,
        signature,
        deps.secret,
      )
    ) {
      return reply.code(404).send();
    }

    const destination = await deps.store.findDestination(destinationId);
    if (destination === undefined) return reply.code(404).send();

    try {
      // The redirect is conditional on this append succeeding (REQ-221).
      await deps.store.record({
        occurredAt: deps.clock.now(),
        automationId: destination.automationId,
        buttonId: destination.buttonId,
        destinationId: destination.id,
        destinationVersion: destination.version,
        contactId,
        executionId,
        ...(destination.label !== undefined && {
          buttonLabel: destination.label,
        }),
      });
    } catch {
      return reply.code(503).send();
    }

    return reply.code(302).header("location", destination.url).send();
  });
}

function signClick(
  destinationId: number,
  contactId: string,
  executionId: string,
  secret: Buffer | string,
): string {
  return createHmac("sha256", secret)
    .update(canonical(destinationId, contactId, executionId))
    .digest("hex");
}

function verifyClick(
  destinationId: number,
  contactId: string,
  executionId: string,
  received: string,
  secret: Buffer | string,
): boolean {
  if (!/^[0-9a-f]{64}$/i.test(received)) return false;
  const expected = signClick(destinationId, contactId, executionId, secret);
  return timingSafeEqual(
    Buffer.from(received.toLowerCase(), "utf8"),
    Buffer.from(expected, "utf8"),
  );
}

/** Length prefixes prevent two different identity tuples sharing one input. */
function canonical(
  destinationId: number,
  contactId: string,
  executionId: string,
): string {
  return [String(destinationId), contactId, executionId]
    .map((value) => `${String(Buffer.byteLength(value, "utf8"))}:${value}`)
    .join("|");
}

function positiveInteger(value: unknown): number | undefined {
  if (typeof value !== "string" || !/^[1-9][0-9]*$/.test(value))
    return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function scalar(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

export type ButtonClickMetricsReader = (
  automationId: string,
) => Promise<ButtonClickMetrics>;

/**
 * Every listed automation's counts in one read (REQ-329).
 *
 * A batch and not a convenience: the listing is what the card draws from, and a
 * reader taking one identifier turns a page of twenty automations into twenty
 * requests, each one asking the database the same question again.
 */
export type ButtonClickMetricsBatchReader = (
  automationIds: readonly string[],
) => Promise<ReadonlyMap<string, ButtonClickMetrics>>;
