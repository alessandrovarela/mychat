import { createReadStream, statSync } from "node:fs";
import { dirname, extname, resolve } from "node:path";
import type { FastifyInstance, FastifyRequest } from "fastify";

/**
 * The file-serving half of every public route that hands out a file: the
 * resources an operator uploaded (`assets-route.ts`) and the publication
 * thumbnails this application copied (`thumbnails-route.ts`).
 *
 * One implementation and not two, and the containment check below is the whole
 * reason. It is the only thing between a public wildcard and the host file
 * system, so a second copy of it is a second place to get it wrong, and the
 * copy that is wrong is the one nobody is looking at. Each route keeps what is
 * genuinely its own: its address, its directory and why it exists.
 *
 * Public by nature. The platform fetches resource URLs from its own servers,
 * with no session and no credential of ours, and the same reasoning as
 * `/webhook` applies: an auth layer in front of either is a broken delivery
 * with no error anywhere on our side.
 */

export interface FileRouteConfig {
  /** Address this route answers at: leading slash, no trailing one. */
  readonly prefix: string;
  /** The directory it serves, and the only one it may ever read from. */
  readonly dir: string;
  /** Optional route-specific capability check, before any filesystem lookup. */
  readonly authorize?: (
    name: string,
    request: FastifyRequest,
  ) => boolean | Promise<boolean>;
}

/**
 * Enough to keep a browser and the platform from guessing wrong: a PDF must not
 * arrive as text, and a video must not arrive as a download prompt.
 *
 * SVG is deliberately absent. Served as `image/svg+xml` from the same origin as
 * the dashboard it would be a script execution vector, and falling back to
 * `application/octet-stream` costs nothing here, where every entry is a file an
 * operator uploaded to be delivered or an image this application downloaded.
 */
const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".mp4": "video/mp4",
  ".mp3": "audio/mpeg",
  ".zip": "application/zip",
  ".csv": "text/csv; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

const DEFAULT_CONTENT_TYPE = "application/octet-stream";

function contentTypeOf(name: string): string {
  return CONTENT_TYPES[extname(name).toLowerCase()] ?? DEFAULT_CONTENT_TYPE;
}

/**
 * The absolute path of a file, or `undefined` when the name does not address
 * one sitting directly in the directory.
 *
 * The containment check is `dirname(resolved) === root` instead of a scan for
 * `..`, because the name arrives already percent-decoded and every escape shape
 * (`../x`, `/etc/passwd`, `%2e%2e%2fx`, a nested `sub/file`) collapses to the
 * same observable fact once resolved: the file is not in this directory.
 * Comparing resolved paths cannot be talked around by an encoding we did not
 * anticipate, which a substring check can.
 *
 * Directly in the directory, and not in a subtree of it: both callers store
 * flat, so nothing legitimate is being refused, and the strict comparison is
 * the one form of this check with no prefix arithmetic to get wrong.
 */
function resolveFile(dir: string, name: string): string | undefined {
  if (name === "" || name.includes("\0")) {
    return undefined;
  }

  const root = resolve(dir);
  const target = resolve(root, name);

  if (dirname(target) !== root) {
    return undefined;
  }

  try {
    // Directories are not files: `.` resolves to the root itself, and a listing
    // is information these routes have no business giving out.
    return statSync(target).isFile() ? target : undefined;
  } catch {
    // Any stat failure is a miss, including a directory that was never created.
    // A fresh clone has no `dev-data/`, and a route must behave as an empty
    // catalogue there, exactly as `createDiskAssets().list()` does.
    return undefined;
  }
}

/**
 * Registers one file route on an existing instance. No server is built here:
 * the process has one Fastify instance, and this is one route on it.
 */
export function registerFileRoute(
  app: FastifyInstance,
  config: FileRouteConfig,
): void {
  // A wildcard, not `:name`, so that a nested or escaping path reaches this
  // handler and gets the same empty 404 as a plain miss. Left to the default
  // handler, those would answer with a different body and turn the response
  // into a probe: telling apart "does not exist" from "exists but refused" is
  // already more than an anonymous fetcher should learn.
  app.get(`${config.prefix}/*`, async (request, reply) => {
    const name = (request.params as Record<string, string>)["*"] ?? "";
    if (
      config.authorize !== undefined &&
      !(await config.authorize(name, request))
    ) {
      return reply.code(404).send();
    }
    const path = resolveFile(config.dir, name);

    if (path === undefined) {
      // Empty body on purpose: nothing to leak, and nothing to translate.
      return reply.code(404).send();
    }

    const size = statSync(path).size;

    return (
      reply
        .code(200)
        .type(contentTypeOf(name))
        .header("content-length", size)
        // Without it a browser sniffs an octet-stream, and a file uploaded with
        // the wrong extension gets to decide how it is interpreted.
        .header("x-content-type-options", "nosniff")
        // Streamed rather than read whole: a video is a normal resource here,
        // and buffering it would put the whole file in memory per request.
        .send(createReadStream(path))
    );
  });
}
