import type { FastifyInstance } from "fastify";
import type {
  InstanceSettings,
  InstanceSettingsChange,
  InstanceSettingsPreference,
} from "../../config/instance-settings.js";
import { knownTimeZones } from "../../config/timezone.js";
import type { TimeZonePreference } from "../../config/timezone.js";
import {
  TRIGGER_SWITCH_NAMES,
  type TriggerSwitchName,
  type TriggerSwitchPreference,
  type TriggerSwitchState,
} from "../../config/trigger-switches.js";
import {
  apiRoute,
  arrayOf,
  BOOLEAN,
  inputObject,
  INTEGER,
  outputObject,
  refusalObject,
  STATUS,
  STRING,
  TIMESTAMP,
} from "./contract.js";

/**
 * What this instance is CONFIGURED as, over HTTP (REQ-166, REQ-183).
 *
 * One route for the settings that belong to the instance and that no screen can
 * derive on its own. Today that is the time zone (REQ-153), and the reason it
 * needs a road of its own is that the interface had none: the zone reached the
 * panel only inside the answer to `GET /api/dashboard/metrics`, as the zone the
 * buckets of THAT window were cut in, so the Settings screen either read the
 * whole trail to learn one configured string or wrote a guess in its place. It
 * wrote a guess, and the guess said UTC after the zone became configurable.
 *
 * Two methods and one shape, which is the shape `/api/locale` already answers
 * with: what is in force, and what this instance can be switched to. The
 * interface needs both on load, because a selector that cannot list the
 * alternatives is not a selector, and asking for the list separately would let
 * the two answers disagree by one request.
 *
 * The list is built HERE and not in the browser, and that is not a detail. The
 * zone has to be one the aggregation can count in, and the aggregation runs in
 * THIS process: a list taken from the browser's calendar data would offer a
 * name this runtime refuses, and the operator would meet a refusal for picking
 * from a list we drew. See `knownTimeZones` for the two corrections the
 * runtime's own list needs.
 *
 * Why not the two routes that already existed:
 *
 *   - `/api/locale` is read with NO session (see `PUBLIC_READS` in
 *     `src/http/access.ts`), because the sign-in screen is interface and has to
 *     be in the instance's language. Everything that route answers is chosen to
 *     be safe in front of an unauthenticated caller, and where the operator
 *     lives is not that. It also answers the same shape from its POST, so a
 *     language write would echo back a zone nobody wrote.
 *   - `/api/session` opens and ends a session and has no read at all. A setting
 *     of the instance is not a fact about one session, and hanging it there
 *     would say it is.
 *
 * Codes only, like every route of this contract: `America/Sao_Paulo` is an
 * identifier, and the sentence explaining what it means to the operator is the
 * screen's, from the catalogue (REQ-073, REQ-074). The refusal is a code too —
 * `unknown_time_zone` names the one field this route carries.
 *
 * Private, by being registered inside the guarded scope and for no other
 * reason: the Settings screen is behind the session like every other screen
 * that is not sign-in.
 */

export const INSTANCE_ROUTE = "/api/instance";
export const INSTANCE_TRIGGERS_ROUTE = "/api/instance/triggers";
export const INSTANCE_SETTINGS_ROUTE = "/api/instance/settings";

const INSTANCE_STATE = outputObject(
  {
    /** The IANA zone this instance counts and reads its instants in. */
    timeZone: STRING,
    /**
     * Every zone it can be switched to, sorted, including the one in force.
     * Named for the setting rather than `available`, because a second setting
     * on this route would need a list of its own and the two must not have to
     * share one word.
     */
    timeZones: arrayOf(STRING),
  },
  ["timeZone", "timeZones"],
);

const TRIGGER_VALUE = outputObject({ enabled: BOOLEAN, updatedAt: TIMESTAMP }, [
  "enabled",
]);

const TRIGGER_STATE = outputObject(
  {
    all: TRIGGER_VALUE,
    comments: TRIGGER_VALUE,
    directMessages: TRIGGER_VALUE,
  },
  ["all", "comments", "directMessages"],
);

function presentTriggers(state: TriggerSwitchState): unknown {
  const present = (value: TriggerSwitchState[TriggerSwitchName]) => ({
    enabled: value.enabled,
    ...(value.updatedAt !== undefined && {
      updatedAt: value.updatedAt.toISOString(),
    }),
  });
  return {
    all: present(state.all),
    comments: present(state.comments),
    directMessages: present(state.directMessages),
  };
}

/**
 * What the instance decides about waiting, over HTTP (REQ-252, REQ-254,
 * REQ-255, REQ-257).
 *
 * The four values AND the bounds they live between, in one answer, for the
 * reason the zone comes with its list of zones: a screen that cannot see the
 * bounds either repeats them in the browser (two copies of 168, and one of them
 * wrong the day it moves) or lets the operator type a number it can only be
 * refused for. They are declared once, by the rule that owns them, and travel
 * from there.
 *
 * Numbers and codes only. The sentence that names 168 to an operator belongs to
 * the screen and to the catalogue (REQ-073), which is also why a refusal
 * carries `limit`: the words are the screen's, the number is ours.
 */
const INSTANCE_SETTINGS_STATE = outputObject(
  {
    waitHours: INTEGER,
    questions: INTEGER,
    closingMessage: STRING,
    followButtonLabel: STRING,
    limits: outputObject(
      {
        waitHoursMin: INTEGER,
        waitHoursMax: INTEGER,
        questionsMin: INTEGER,
        followButtonLabelChars: INTEGER,
      },
      [
        "waitHoursMin",
        "waitHoursMax",
        "questionsMin",
        "followButtonLabelChars",
      ],
    ),
  },
  ["waitHours", "questions", "closingMessage", "followButtonLabel", "limits"],
);

export function registerInstanceRoutes(
  scope: FastifyInstance,
  timeZone: TimeZonePreference,
  triggers: TriggerSwitchPreference,
  settings: InstanceSettingsPreference,
): void {
  /**
   * Read on every request and never captured: this is the whole of REQ-183 at
   * this layer. A value resolved once at registration would answer the zone the
   * PROCESS started with for as long as it ran, which is exactly the behaviour
   * the requirement removes.
   */
  async function state(): Promise<{
    timeZone: string;
    timeZones: readonly string[];
  }> {
    const inForce = await timeZone.inForce();

    return {
      timeZone: inForce.timeZone,
      timeZones: knownTimeZones(inForce.timeZone),
    };
  }

  apiRoute(scope, {
    method: "GET",
    url: INSTANCE_ROUTE,
    contract: {
      // Empty and closed: this route takes no parameter, so an unexpected one
      // is refused instead of ignored.
      querystring: inputObject({}),
      response: { 200: INSTANCE_STATE },
    },
    handler: async () => ({ status: STATUS.ok, payload: await state() }),
  });

  apiRoute<unknown, unknown, { timeZone: string }>(scope, {
    method: "POST",
    url: INSTANCE_ROUTE,
    contract: {
      body: inputObject({ timeZone: STRING }, ["timeZone"]),
      response: { 200: INSTANCE_STATE, 422: refusalObject() },
    },
    handler: async ({ body }) => {
      const chosen = await timeZone.choose(body.timeZone);

      if (!chosen.ok) {
        // 422 and not 400: the request was well formed, and the domain refused
        // what it carried. Nothing was stored, so the previous zone stands and
        // the next read of the dashboard still cuts its buckets in it.
        return { status: STATUS.refused, payload: { error: chosen.refusal } };
      }

      // Re-read rather than echoed: the answer to a write is the same answer
      // the GET gives, so a screen that adopts it cannot end up displaying a
      // zone the instance did not keep.
      return { status: STATUS.ok, payload: await state() };
    },
  });

  apiRoute(scope, {
    method: "GET",
    url: INSTANCE_TRIGGERS_ROUTE,
    contract: {
      querystring: inputObject({}),
      response: { 200: TRIGGER_STATE },
    },
    handler: async () => ({
      status: STATUS.ok,
      payload: presentTriggers(await triggers.read()),
    }),
  });

  apiRoute<unknown, unknown, { name: TriggerSwitchName; enabled: boolean }>(
    scope,
    {
      method: "POST",
      url: INSTANCE_TRIGGERS_ROUTE,
      contract: {
        body: inputObject(
          {
            name: { type: "string", enum: [...TRIGGER_SWITCH_NAMES] },
            enabled: BOOLEAN,
          },
          ["name", "enabled"],
        ),
        response: { 200: TRIGGER_STATE },
      },
      handler: async ({ body }) => ({
        status: STATUS.ok,
        payload: presentTriggers(
          await triggers.choose(body.name, body.enabled),
        ),
      }),
    },
  );

  function presentSettings(value: InstanceSettings): unknown {
    return { ...value, limits: settings.bounds };
  }

  apiRoute(scope, {
    method: "GET",
    url: INSTANCE_SETTINGS_ROUTE,
    contract: {
      querystring: inputObject({}),
      response: { 200: INSTANCE_SETTINGS_STATE },
    },
    // Read on every request and never captured, exactly like the zone above: a
    // value resolved at registration would answer what the PROCESS started with
    // for as long as it ran.
    handler: async () => ({
      status: STATUS.ok,
      payload: presentSettings(await settings.read()),
    }),
  });

  apiRoute<unknown, unknown, InstanceSettingsChange>(scope, {
    method: "POST",
    url: INSTANCE_SETTINGS_ROUTE,
    contract: {
      /*
       * Every field optional, and none of them required: a screen changing the
       * deadline must not have to resend a closing message it never read, and
       * a body naming a field nobody declared is still refused by the contract
       * (`additionalProperties` is closed) rather than silently ignored.
       *
       * The bounds are NOT declared here as `minimum`/`maximum`. A schema
       * refusal answers 400 with a message about a path, and REQ-252 and
       * REQ-257 ask for the LIMIT to be named: the domain refuses instead, at
       * 422, with the code and the number the screen puts into a sentence.
       */
      body: inputObject({
        waitHours: INTEGER,
        questions: INTEGER,
        closingMessage: STRING,
        followButtonLabel: STRING,
      }),
      response: {
        200: INSTANCE_SETTINGS_STATE,
        422: refusalObject({ limit: INTEGER }),
      },
    },
    handler: async ({ body }) => {
      const chosen = await settings.choose(body);

      if (!chosen.ok) {
        // 422 and not 400: the request was well formed and the domain refused
        // what it carried. Nothing was stored, so every value stands as it was
        // and the waits already counting are untouched either way (REQ-253).
        return {
          status: STATUS.refused,
          payload: {
            error: chosen.refusal.code,
            ...(chosen.refusal.limit !== undefined && {
              limit: chosen.refusal.limit,
            }),
          },
        };
      }

      // Re-read rather than echoed, like the zone: the answer to a write is the
      // answer the GET gives, so a screen adopting it cannot end up displaying
      // a value the instance did not keep.
      return { status: STATUS.ok, payload: presentSettings(chosen.settings) };
    },
  });
}
