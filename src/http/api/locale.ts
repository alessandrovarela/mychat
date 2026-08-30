import type { FastifyInstance } from "fastify";
import type { LocalePreference } from "../../i18n/preference.js";
import {
  apiRoute,
  arrayOf,
  inputObject,
  outputObject,
  refusalObject,
  STATUS,
  STRING,
} from "./contract.js";

/**
 * The language of the instance, over HTTP (REQ-074, REQ-102).
 *
 * Two routes and one shape: what is in force, and what this build can be
 * switched to. The interface needs both on load, because a selector that cannot
 * list the alternatives is not a selector, and asking for the list separately
 * would let the two answers disagree by one request.
 *
 * No text crosses here. The answer carries locale NAMES (`en`, `pt-BR`), and
 * the screen writes its own labels: a sentence sent from the server would be
 * the one piece of operator-facing text the catalogue could not translate.
 *
 * The catalogues themselves do not cross either: the interface bundles them
 * (see `src/web/locale.tsx`), so the language changes with no round trip, and a
 * panel already open keeps working while the process restarts.
 */

export const LOCALE_ROUTE = "/api/locale";

const LOCALE_STATE = outputObject(
  {
    /** The language in force for this instance, right now. */
    locale: STRING,
    /** Every language this build carries a catalogue for, sorted. */
    available: arrayOf(STRING),
  },
  ["locale", "available"],
);

export function registerLocaleRoutes(
  scope: FastifyInstance,
  preference: LocalePreference,
): void {
  apiRoute(scope, {
    method: "GET",
    url: LOCALE_ROUTE,
    contract: {
      // Empty and closed: this route takes no parameter, and says so, so an
      // unexpected one is refused instead of ignored.
      querystring: inputObject({}),
      response: { 200: LOCALE_STATE },
    },
    handler: async () => {
      const inForce = await preference.inForce();

      return {
        status: STATUS.ok,
        payload: {
          locale: inForce.locale,
          available: [...preference.available()],
        },
      };
    },
  });

  apiRoute<unknown, unknown, { locale: string }>(scope, {
    method: "POST",
    url: LOCALE_ROUTE,
    contract: {
      body: inputObject({ locale: STRING }, ["locale"]),
      response: { 200: LOCALE_STATE, 422: refusalObject() },
    },
    handler: async ({ body }) => {
      const chosen = await preference.choose(body.locale);

      if (!chosen.ok) {
        // 422 and not 400: the request was well formed, and the domain refused
        // what it carried. Nothing was stored, so the previous choice stands.
        return { status: STATUS.refused, payload: { error: chosen.refusal } };
      }

      return {
        status: STATUS.ok,
        payload: {
          locale: chosen.locale,
          available: [...preference.available()],
        },
      };
    },
  });
}
