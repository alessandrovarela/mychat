import type { FastifyInstance } from "fastify";
import { THUMBNAIL_PREFIX } from "../storage/publication-cache.js";
import { registerFileRoute } from "./file-route.js";

/**
 * The route that makes a cached thumbnail an image a browser can load
 * (REQ-069, REQ-109).
 *
 * The listing never hands out a platform URL (those expire, REQ-071): it hands
 * out the address of OUR copy, built by the thumbnail binding as
 * `${bucketRoot}/${key}` where the key is `thumbs/<publication-id>.<ext>`. On
 * the disk binding the bucket root is this process's own public origin, so the
 * address a browser is given is `${origin}/thumbs/<file>`, and this route is
 * what answers there. Without it the grid renders the alternative text of every
 * cell and nothing else, which is exactly what an operator saw.
 *
 * A route of its own rather than a wider `/assets`, for two reasons. The
 * resource route's containment refuses anything that is not directly in its
 * directory, and that check is worth more than the convenience of reusing it
 * for a second directory. And the two directories hold different things:
 * `/assets` serves what the operator uploaded and the catalogue lists, while
 * these files are written by this application and only ever read by key, which
 * is the same separation ADR-010 gives them as sibling prefixes in the bucket.
 *
 * Public, like the resource route beside it: every byte here is a copy of a
 * picture the profile already publishes to the world, addressed by the
 * platform's own publication id, so a session would guard nothing. What it
 * would add is an auth path in front of every cell of the grid.
 *
 * The prefix is derived from the key's prefix and never typed again: the
 * address the binding builds and the address this route answers at are the same
 * string by construction, so they cannot drift apart in silence.
 */

export const THUMBNAILS_ROUTE_PREFIX = `/${THUMBNAIL_PREFIX.replace(/\/+$/, "")}`;

export interface ThumbnailsRouteConfig {
  /** Directory the thumbnail binding writes into, and nothing else. */
  readonly dir: string;
}

/**
 * Registers the route on an existing instance. No server is built here: the
 * process has one Fastify instance, and this is one route on it.
 */
export function registerThumbnailsRoute(
  app: FastifyInstance,
  config: ThumbnailsRouteConfig,
): void {
  registerFileRoute(app, { prefix: THUMBNAILS_ROUTE_PREFIX, dir: config.dir });
}
