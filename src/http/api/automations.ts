import type { FastifyInstance } from "fastify";
import { isUnreadable } from "../../flows/automations.js";
import type {
  AutomationAggregateLifecycle,
  StoredDefinition,
} from "../../flows/automations.js";
import {
  apiRoute,
  arrayOf,
  BOOLEAN,
  INTEGER,
  inputObject,
  outputObject,
  refusalObject,
  STATUS,
  STRING,
  TIMESTAMP,
} from "./contract.js";
import type { JsonSchema } from "./contract.js";
import type { UnifiedAutomation } from "../../flows/schema.js";
import type { ButtonClickMetrics } from "../../storage/button-clicks.js";
import type { ButtonClickMetricsBatchReader } from "../clicks-route.js";

const AUTOMATION_NOT_FOUND = "automation_not_found";
/**
 * The automation is there and this version's schema refuses it (REQ-294).
 *
 * A refusal of its own, because the two answers it is NOT are both wrong in a
 * way an operator pays for: 404 says the automation is gone, and it is not,
 * which is how a stored row would be deleted by somebody trusting the answer;
 * 500 says the instance is broken, and it is not, which is how a working
 * screen ends up looking like an outage.
 */
const AUTOMATION_UNREADABLE = "automation_unreadable";
const DEFINITION: JsonSchema = { type: "object", additionalProperties: true };
const STORED = outputObject(
  { definition: DEFINITION, createdAt: TIMESTAMP, updatedAt: TIMESTAMP },
  ["definition", "createdAt", "updatedAt"],
);
// `limit` is not required, and the omission is the contract: it carries the
// ceiling a value went past, and most refusals are not about a ceiling. It
// travels so a screen can say "at most N" in its own three words instead of
// reading the number back out of `message`, which is English prose.
const DEFINITION_ISSUE = outputObject(
  { path: STRING, code: STRING, message: STRING, limit: INTEGER },
  ["path", "code", "message"],
);
const ID_PARAMS = inputObject({ id: { type: "string", minLength: 1 } }, ["id"]);
const NO_QUERY = inputObject({});
const BUTTON_CLICK_TOTAL = outputObject({ buttonId: STRING, total: INTEGER }, [
  "buttonId",
  "total",
]);
const CLICK_METRICS = outputObject(
  {
    automationId: STRING,
    total: INTEGER,
    buttons: arrayOf(BUTTON_CLICK_TOTAL),
  },
  ["automationId", "total", "buttons"],
);
// `clicks` is not required, and the omission is the contract: it carries what
// was MEASURED, so a composition with no reader wired, or a read that failed,
// leaves it out. Declaring it required would force a zero into its place, and a
// zero nobody counted is indistinguishable from nobody clicking (REQ-329).
const LISTED = outputObject(
  {
    definition: DEFINITION,
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
    clicks: CLICK_METRICS,
  },
  ["definition", "createdAt", "updatedAt"],
);

/**
 * The listing's measurement reader: the counts arrive with the page that
 * already asked for the automations, so a screen showing twenty of them makes
 * one request instead of twenty one.
 */
export interface ClickMetricsReaders {
  readonly forListing: ButtonClickMetricsBatchReader;
}

interface PresentedAutomation {
  readonly definition: unknown;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly clicks?: ButtonClickMetrics;
}

function presentStored(stored: StoredDefinition<unknown>): PresentedAutomation {
  return {
    definition: stored.definition,
    createdAt: stored.createdAt.toISOString(),
    updatedAt: stored.updatedAt.toISOString(),
  };
}

/**
 * The listing carries the counts it can prove, and says nothing otherwise.
 *
 * Failing to read the counts does not fail the listing: the automations are
 * what the operator asked for, and the counts are an addition to them. What it
 * must never do is answer zero in their place.
 */
async function presentListing(
  listed: readonly StoredDefinition<UnifiedAutomation>[],
  readClicks: ButtonClickMetricsBatchReader | undefined,
): Promise<readonly PresentedAutomation[]> {
  const measured = await measureClicks(listed, readClicks);
  return listed.map((stored) => {
    const clicks = measured?.get(stored.definition.id);
    return {
      ...presentStored(stored),
      ...(clicks !== undefined && { clicks }),
    };
  });
}

async function measureClicks(
  listed: readonly StoredDefinition<UnifiedAutomation>[],
  readClicks: ButtonClickMetricsBatchReader | undefined,
): Promise<ReadonlyMap<string, ButtonClickMetrics> | undefined> {
  if (readClicks === undefined) return undefined;
  try {
    return await readClicks(listed.map((stored) => stored.definition.id));
  } catch {
    return undefined;
  }
}

export function registerAutomationAggregateRoutes(
  scope: FastifyInstance,
  automations: AutomationAggregateLifecycle,
  clickMetrics?: ClickMetricsReaders,
): void {
  apiRoute(scope, {
    method: "GET",
    url: "/api/automations",
    contract: {
      querystring: NO_QUERY,
      response: {
        200: outputObject({ automations: arrayOf(LISTED) }, ["automations"]),
      },
    },
    handler: async () => ({
      status: STATUS.ok,
      payload: {
        automations: await presentListing(
          await automations.list(),
          clickMetrics?.forListing,
        ),
      },
    }),
  });

  apiRoute<{ id: string }>(scope, {
    method: "GET",
    url: "/api/automations/:id",
    contract: {
      params: ID_PARAMS,
      querystring: NO_QUERY,
      response: {
        200: outputObject({ automation: STORED }, ["automation"]),
        404: refusalObject(),
        422: refusalObject(),
      },
    },
    handler: async ({ params }) => {
      const found = await automations.read(params.id);
      if (found === undefined) {
        return {
          status: STATUS.notFound,
          payload: { error: AUTOMATION_NOT_FOUND },
        };
      }
      if (isUnreadable(found)) {
        return {
          status: STATUS.refused,
          payload: { error: AUTOMATION_UNREADABLE },
        };
      }
      return {
        status: STATUS.ok,
        payload: { automation: presentStored(found) },
      };
    },
  });

  apiRoute<unknown, unknown, { definition: unknown }>(scope, {
    method: "POST",
    url: "/api/automations",
    contract: {
      body: inputObject({ definition: DEFINITION }, ["definition"]),
      response: {
        200: outputObject({ created: BOOLEAN, automation: STORED }, [
          "created",
          "automation",
        ]),
        409: refusalObject({ target: STRING, automationId: STRING }),
        422: refusalObject({
          issues: arrayOf(DEFINITION_ISSUE),
          reason: STRING,
        }),
      },
    },
    handler: async ({ body }) => {
      const result = await automations.save(body.definition);
      if (
        !result.ok &&
        (result.refusal === "publication_target_conflict" ||
          result.refusal === "global_match_conflict" ||
          result.refusal === "next_publication_conflict")
      ) {
        return {
          status: STATUS.conflict,
          payload: {
            error: result.refusal,
            ...(result.refusal === "publication_target_conflict" && {
              target: result.target,
            }),
            ...(result.refusal === "global_match_conflict" && {
              automationId: result.automationId,
            }),
          },
        };
      }
      if (!result.ok) {
        return {
          status: STATUS.refused,
          payload: {
            error: result.refusal,
            ...(result.refusal === "invalid_definition" && {
              issues: result.issues,
            }),
            ...(result.refusal === "pending_publication_sync_failed" && {
              reason: result.reason,
            }),
          },
        };
      }
      return {
        status: STATUS.ok,
        payload: {
          created: result.created,
          automation: presentStored(result.stored),
        },
      };
    },
  });

  apiRoute<{ id: string }>(scope, {
    method: "DELETE",
    url: "/api/automations/:id",
    contract: {
      params: ID_PARAMS,
      response: {
        200: outputObject({ id: STRING }, ["id"]),
        404: refusalObject(),
      },
    },
    handler: async ({ params }) =>
      (await automations.remove(params.id))
        ? { status: STATUS.ok, payload: { id: params.id } }
        : {
            status: STATUS.notFound,
            payload: { error: AUTOMATION_NOT_FOUND },
          },
  });
}
