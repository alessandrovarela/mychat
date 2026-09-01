import type { FastifyInstance } from "fastify";
import type { AccountProfileReader } from "../../platform/account-profile.js";
import {
  apiRoute,
  BOOLEAN,
  inputObject,
  outputObject,
  STATUS,
  STRING,
} from "./contract.js";

export const ACCOUNT_PROFILE_ROUTE = "/api/account-profile";

const PROFILE = outputObject(
  { connected: BOOLEAN, name: STRING, pictureUrl: STRING },
  ["connected"],
);

export function registerAccountProfileRoute(
  scope: FastifyInstance,
  profiles: AccountProfileReader,
): void {
  apiRoute(scope, {
    method: "GET",
    url: ACCOUNT_PROFILE_ROUTE,
    contract: {
      querystring: inputObject({}),
      response: {
        [STATUS.ok]: outputObject({ profile: PROFILE }, ["profile"]),
      },
    },
    handler: async () => ({
      status: STATUS.ok,
      payload: { profile: await profiles.read() },
    }),
  });
}
