import type { FastifyInstance } from "fastify";
import { hasAssetCapability } from "../storage/assets.js";
import type { AssetCapabilitySecret } from "../storage/assets.js";
import { registerFileRoute } from "./file-route.js";

/**
 * The public route that answers at the address the disk binding hands out.
 *
 * `createDiskAssets({ dir, publicBaseUrl })` builds the URL sent to the contact
 * as `${publicBaseUrl}/${encodeURIComponent(name)}`, and until something
 * answers there the whole delivery path (by link and by attachment) produces
 * addresses that lead nowhere: the platform fetches the URL, gets nothing, and
 * the contact receives a broken message with no error anywhere on our side.
 *
 * The prefix is exported rather than written twice because the two halves must
 * agree byte for byte. Whoever composes the process builds `publicBaseUrl` from
 * this constant, so the route and the adapter cannot drift apart in silence.
 *
 * Public by nature: the platform fetches these URLs from its own servers, with
 * no session and no credential of ours. Same reasoning as `/webhook`, and the
 * same failure mode if an auth layer is ever put in front of it.
 *
 * How a file is found, typed and streamed lives in `file-route.ts`, together
 * with the path containment this route depends on: the thumbnails route needs
 * the same three things, and one copy of a containment check is the only number
 * of copies that stays correct.
 */

export const ASSETS_ROUTE_PREFIX = "/assets";

export interface AssetsRouteConfig {
  /** Capability key derived by composition from the installation secret. */
  readonly secret: AssetCapabilitySecret;
  /** Directory the disk binding reads, the one `createDiskAssets` was given. */
  readonly dir?: string;
  /** S3 binding: turn a verified capability into a fresh provider URL. */
  readonly temporaryUrl?: (name: string) => Promise<string>;
}

function capabilityFrom(request: { query: unknown }): string | undefined {
  const capability = (request.query as Record<string, unknown>)["cap"];
  return typeof capability === "string" ? capability : undefined;
}

/**
 * Registers the route on an existing instance. No server is built here: the
 * process has one Fastify instance, and this is one route on it.
 */
export function registerAssetsRoute(
  app: FastifyInstance,
  config: AssetsRouteConfig,
): void {
  if (config.dir !== undefined) {
    registerFileRoute(app, {
      prefix: ASSETS_ROUTE_PREFIX,
      dir: config.dir,
      authorize: (name, request) =>
        hasAssetCapability(name, capabilityFrom(request), config.secret),
    });
    return;
  }

  if (config.temporaryUrl === undefined) {
    throw new Error(
      "assets route needs a disk directory or temporary URL issuer",
    );
  }
  const temporaryUrl = config.temporaryUrl;

  app.get(`${ASSETS_ROUTE_PREFIX}/*`, async (request, reply) => {
    const name = (request.params as Record<string, string>)["*"] ?? "";
    if (!hasAssetCapability(name, capabilityFrom(request), config.secret)) {
      return reply.code(404).send();
    }
    try {
      return reply.redirect(await temporaryUrl(name), 302);
    } catch {
      // Missing and unavailable objects deliberately have the same public face.
      return reply.code(404).send();
    }
  });
}
