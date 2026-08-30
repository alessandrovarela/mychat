import { statSync } from "node:fs";
import { resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import fastifyStatic from "@fastify/static";
import type { FastifyInstance } from "fastify";
import { ASSETS_ROUTE_PREFIX } from "./assets-route.js";
import { THUMBNAILS_ROUTE_PREFIX } from "./thumbnails-route.js";

/**
 * The interface, served by the process that serves everything else (REQ-105,
 * ADR-004).
 *
 * Files only: what `vite build` wrote to disk is what this route hands out.
 * There is no development server in a running installation, and no second
 * process, which is what makes the Phase 4 image a single container.
 *
 * The one thing this route must never do is answer for someone else. A single
 * page application needs a catch-all (a deep link such as `/flows/new` has no
 * file behind it and still has to load the application), and a catch-all is
 * exactly the shape that swallows a route it was never meant to see. Two rules
 * keep that from happening, and `static.test.ts` holds both:
 *
 *   1. The reserved prefixes below are answered by NOBODY here, whatever the
 *      state of the router. `/webhook` is the KEEL's hard rule (an HTML page
 *      returned to the platform is a silent death: deliveries stop, no error
 *      anywhere), `/api` belongs to the interface's own contract, `/assets` is
 *      the public resource route the platform fetches from, and `/thumbs` is
 *      where the publication grid loads its pictures.
 *   2. Only GET (and the HEAD Fastify derives from it) reaches this handler,
 *      so a POST to a route that does not exist stays a 404 instead of
 *      becoming a page.
 */

/**
 * Where `vite build` writes, resolved from this file rather than from the
 * working directory: the process is started by whoever runs it, from wherever
 * they happen to be.
 *
 * `src/http/static.ts` -> repository root -> `dist/web`. The application runs
 * from source (the build typechecks and bundles the interface, it emits no
 * backend JavaScript), so this file's location IS the installation's layout.
 * `static.test.ts` compares this path with the one `vite.config.ts` declares.
 */
export const WEB_DIST_DIR = fileURLToPath(
  new URL("../../dist/web", import.meta.url),
);

/** The document every unclaimed address answers with. */
const INDEX_FILE = "index.html";

/**
 * Addresses this route refuses to answer, whatever else happens.
 *
 * Fastify's router already prefers a registered route over a wildcard, so a
 * `GET /webhook` that exists is reached anyway. This list is what protects the
 * case the router cannot: the route that is NOT registered, or is registered
 * for another method, whose request would otherwise fall into the catch-all
 * and receive `index.html` with a 200.
 */
export const RESERVED_PREFIXES: readonly string[] = [
  "/webhook",
  "/api",
  // Imported, never retyped: the resource route owns this prefix, and the two
  // must be the same string for the platform's fetches to keep working.
  ASSETS_ROUTE_PREFIX,
  // Same reasoning, and the failure is just as quiet: the grid asks for an
  // image and a page answered with 200 is a broken picture in every cell.
  THUMBNAILS_ROUTE_PREFIX,
];

export interface StaticRouteConfig {
  /** The build output to serve. Defaults to where `vite build` writes. */
  readonly dir?: string;
}

function isReserved(pathname: string): boolean {
  return RESERVED_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

/**
 * The absolute path of a file inside the build output, or `undefined` when the
 * address does not name one.
 *
 * Containment is checked by comparing resolved paths, the same way the resource
 * route does it: the wildcard arrives percent-decoded, so `../`, an absolute
 * path and an encoded escape all collapse to the same fact once resolved, and
 * no encoding we failed to anticipate can talk its way around it.
 */
function resolveFile(root: string, requested: string): string | undefined {
  if (requested === "" || requested.includes("\0")) {
    return undefined;
  }

  const target = resolve(root, requested);

  // Nested directories are legitimate here (the bundle writes `app/`), so
  // containment is a prefix check on the resolved path. The separator is part
  // of the prefix on purpose: without it a sibling directory whose name merely
  // starts with the root's (`dist/webother`) would pass as contained.
  if (!target.startsWith(root.endsWith(sep) ? root : `${root}${sep}`)) {
    return undefined;
  }

  try {
    return statSync(target).isFile() ? target : undefined;
  } catch {
    // Not built yet, or simply not a file: both mean "no file at this address",
    // and a fresh clone with no `dist/web` must still boot and serve the
    // webhook. Nothing here may throw at start-up.
    return undefined;
  }
}

/**
 * Registers the interface on an existing instance. No server is built here: the
 * process has one Fastify instance, and this is one route on it.
 *
 * Encapsulated in a child scope so that `reply.sendFile` and the catch-all
 * belong to this plugin and to nothing else in the process.
 */
export function registerStaticRoute(
  app: FastifyInstance,
  config: StaticRouteConfig = {},
): void {
  const root = resolve(config.dir ?? WEB_DIST_DIR);

  app.register(async (scope) => {
    await scope.register(fastifyStatic, {
      root,
      // No routes of its own: this module registers the single wildcard below,
      // so the reserved check runs BEFORE anything is served. `sendFile` is the
      // only thing taken from the plugin, for content type, etag and ranges.
      serve: false,
    });

    scope.get("/*", async (request, reply) => {
      const requested = (request.params as Record<string, string>)["*"] ?? "";
      const pathname = `/${requested}`;

      if (isReserved(pathname)) {
        // Not ours, and not an empty 200 either: the application's own 404
        // answers, exactly as it would if this route did not exist.
        reply.callNotFound();
        return reply;
      }

      if (resolveFile(root, requested) !== undefined) {
        return reply.sendFile(requested);
      }

      if (resolveFile(root, INDEX_FILE) === undefined) {
        // The interface was never built. Saying so with a 404 is honest;
        // refusing to start would take the webhook down with it.
        reply.callNotFound();
        return reply;
      }

      // The deep link: no file behind the address, so the application loads and
      // resolves the address itself (see `src/web/App.tsx`).
      return reply.sendFile(INDEX_FILE);
    });
  });
}
