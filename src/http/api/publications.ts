import type { FastifyInstance } from "fastify";
import { PUBLICATION_LISTING_PAGE_SIZE } from "../../platform/publications-cache.js";
import type {
  PublicationCatalogue,
  PublicationEntry,
  PublicationListing,
  PublicationLookup,
} from "../../platform/publications-cache.js";
import type {
  PublicationAutomationCoverage,
  PublicationAutomationCoverageReader,
  UnreadableAutomation,
} from "../../storage/publication-automation-coverage.js";
import {
  apiRoute,
  arrayOf,
  BOOLEAN,
  INTEGER,
  inputObject,
  outputObject,
  STATUS,
  STRING,
  TIMESTAMP,
} from "./contract.js";
import type { JsonSchema } from "./contract.js";

/**
 * The publication grid over HTTP (REQ-069 to REQ-072).
 *
 * Two routes and not one, because the difference between them IS REQ-070:
 * opening the screen reads the local cache and spends no request budget, while
 * refreshing is the operator asking for the platform to be walked. Collapsing
 * them into one GET with a `refresh=true` parameter would put a platform call
 * behind a method browsers and proxies are free to repeat.
 *
 * A listing that failed still answers 200. That is REQ-072 and not leniency:
 * the grid is a convenience, the target can always be typed as a URL or an id,
 * and a 5xx here would make the screen look broken while the automation it
 * exists to create is perfectly possible. The failure travels IN the payload,
 * beside whatever was cached.
 *
 * A THIRD route answers by identifier (REQ-144), and it is not a variation of
 * the first. The grid is a page of the newest publications, so a caller that
 * wanted the thumbnail of one particular publication and read a page to find it
 * would show a picture for the recent ones and a marker of absence for every
 * older one, on rows that are holding the identifier the whole time. Paging
 * further only moves that line: asking by identifier removes it.
 */

/** Where the rows came from, so the screen can say what it is showing. */
const SOURCE: JsonSchema = { type: "string", enum: ["cache", "platform"] };

const PUBLICATION = outputObject(
  {
    id: STRING,
    /**
     * The caption the operator published, whole and OPTIONAL (REQ-216).
     *
     * Optional because two ordinary publications carry none: one that was
     * published without a caption, and one cached before the caption was ever
     * asked for. Requiring it would turn either into a 500 on a screen that
     * works perfectly well without the text.
     *
     * Whole, and not the two lines a card shows: truncation belongs to the
     * component that draws it, and a contract that shortened the text would
     * make the full caption unreachable to every other reader.
     */
    caption: STRING,
    /** The platform's own vocabulary (`IMAGE`, `VIDEO`), left unmapped. */
    mediaType: STRING,
    publishedAt: TIMESTAMP,
    /** Our address, never the platform's: theirs expires (REQ-071). Absent
     * when no copy could be made, and the publication still lists. */
    thumbnailUrl: STRING,
  },
  ["id", "mediaType", "publishedAt"],
);

const LISTING = outputObject(
  {
    items: arrayOf(PUBLICATION),
    total: INTEGER,
    offset: INTEGER,
    limit: INTEGER,
    source: SOURCE,
    cachedAt: TIMESTAMP,
    /**
     * Why the platform could not be consulted, when it could not. The one
     * string in this contract that is not a code: it is the platform's own
     * answer, quoted so the operator can act on it, and the screen shows it as
     * a quotation beside its own translated wording.
     */
    failure: STRING,
  },
  ["items", "total", "offset", "limit", "source"],
);

/**
 * What a lookup by identifier answers with (REQ-144). No page, no total and no
 * origin: nothing here is paged, and the rows always come from this instance's
 * store. `failure` is kept, so a caller degrades exactly as the grid does.
 */
const LOOKUP = outputObject({ items: arrayOf(PUBLICATION), failure: STRING }, [
  "items",
]);

/**
 * An automation named by its identifier and by nothing else (REQ-279): the name
 * the operator reads is composed by the screen from the publication's current
 * caption, so there is none for this payload to carry.
 */
const AUTOMATION_REFERENCE = outputObject({ id: STRING, enabled: BOOLEAN }, [
  "id",
  "enabled",
]);

const AUTOMATION_COVERAGE = outputObject(
  {
    publicationId: STRING,
    active: INTEGER,
    inactive: INTEGER,
    automations: arrayOf(AUTOMATION_REFERENCE),
  },
  ["publicationId", "active", "inactive", "automations"],
);

/**
 * A stored automation the current schema refuses (REQ-294).
 *
 * `publicationId` is optional and its absence is ordinary: an automation
 * started by a direct message watches no publication, and neither does a draft
 * that never named one. What is NOT optional is the identifier, because the
 * whole point of this half of the answer is that the row can be named at all.
 */
const UNREADABLE_AUTOMATION = outputObject(
  { id: STRING, publicationId: STRING },
  ["id"],
);

/**
 * How many publications one lookup may name.
 *
 * A ceiling and not an act of distrust: the identifiers travel in the address,
 * and an unbounded list is a request a proxy or a server refuses by length,
 * which would read to the operator as the screen being broken. Two hundred
 * seventeen-digit identifiers is about five kilobytes, well inside every
 * common limit, and far past the number of automations one account operates.
 */
export const PUBLICATION_LOOKUP_LIMIT = 200;

/**
 * The identifiers, repeated (`?ids=a&ids=b`) rather than joined by a separator.
 *
 * Declared as an array, so the router validates each element and the route
 * parses nothing: a comma-joined parameter would arrive as one string and the
 * handler would have to split it, which is a contract improvised in code
 * instead of declared (REQ-103).
 */
const LOOKUP_QUERY = inputObject({
  ids: {
    type: "array",
    items: STRING,
    maxItems: PUBLICATION_LOOKUP_LIMIT,
  },
});

interface Lookup {
  readonly ids?: readonly string[];
}

/**
 * How the caller asks for a page.
 *
 * The ceiling is the grid's own page size, imported and not retyped: without
 * one, a client turns a single request into a full read of the cache.
 */
const PAGE_PROPERTIES = {
  limit: {
    type: "integer",
    minimum: 1,
    maximum: PUBLICATION_LISTING_PAGE_SIZE,
  },
  offset: { type: "integer", minimum: 0 },
} as const;

const PAGE_QUERY = inputObject(PAGE_PROPERTIES);

/**
 * A refresh carries its page in the body, and an empty object is the whole
 * request when the operator only wants fresh data. It is declared rather than
 * absent because a POST with no body at all has nothing for the contract to
 * check, and this route must answer the same way whatever the client sends.
 */
const REFRESH_BODY = inputObject(PAGE_PROPERTIES);

interface Page {
  readonly limit?: number;
  readonly offset?: number;
}

function pageOf(page: Page): Partial<{ limit: number; offset: number }> {
  return {
    ...(page.limit !== undefined && { limit: page.limit }),
    ...(page.offset !== undefined && { offset: page.offset }),
  };
}

function presentEntry(entry: PublicationEntry): unknown {
  return {
    id: entry.id,
    ...(entry.caption !== undefined && { caption: entry.caption }),
    mediaType: entry.mediaType,
    publishedAt: entry.publishedAt.toISOString(),
    ...(entry.thumbnailUrl !== undefined && {
      thumbnailUrl: entry.thumbnailUrl,
    }),
  };
}

function presentListing(listing: PublicationListing): unknown {
  return {
    items: listing.items.map(presentEntry),
    total: listing.total,
    offset: listing.offset,
    limit: listing.limit,
    source: listing.source,
    ...(listing.cachedAt !== undefined && {
      cachedAt: listing.cachedAt.toISOString(),
    }),
    ...(listing.failure !== undefined && { failure: listing.failure }),
  };
}

function presentLookup(lookup: PublicationLookup): unknown {
  return {
    items: lookup.items.map(presentEntry),
    ...(lookup.failure !== undefined && { failure: lookup.failure }),
  };
}

function presentCoverage(
  coverage: readonly PublicationAutomationCoverage[],
): unknown {
  return coverage.map((entry) => ({
    publicationId: entry.publicationId,
    active: entry.active,
    inactive: entry.inactive,
    automations: entry.automations.map((automation) => ({
      id: automation.id,
      enabled: automation.enabled,
    })),
  }));
}

function presentUnreadable(
  unreadable: readonly UnreadableAutomation[],
): unknown {
  return unreadable.map((automation) => ({
    id: automation.id,
    ...(automation.publicationId !== undefined && {
      publicationId: automation.publicationId,
    }),
  }));
}

const EMPTY_COVERAGE: PublicationAutomationCoverageReader = {
  read: (publicationIds) =>
    Promise.resolve(
      publicationIds.map((publicationId) => ({
        publicationId,
        active: 0,
        inactive: 0,
        automations: [],
      })),
    ),
  unreadable: () => Promise.resolve([]),
};

export function registerPublicationRoutes(
  scope: FastifyInstance,
  publications: PublicationCatalogue,
  now: () => Date,
  coverage: PublicationAutomationCoverageReader = EMPTY_COVERAGE,
): void {
  apiRoute<unknown, Page>(scope, {
    method: "GET",
    url: "/api/publications",
    contract: {
      querystring: PAGE_QUERY,
      response: { 200: outputObject({ listing: LISTING }, ["listing"]) },
    },
    // REQ-070: an opening reads storage. The catalogue consults the platform
    // here only when the cache is empty, and that decision is its own.
    handler: async ({ query }) => ({
      status: STATUS.ok,
      payload: {
        listing: presentListing(await publications.open(now(), pageOf(query))),
      },
    }),
  });

  apiRoute<unknown, Lookup>(scope, {
    method: "GET",
    url: "/api/publications/by-id",
    contract: {
      querystring: LOOKUP_QUERY,
      response: {
        200: outputObject({ publications: LOOKUP }, ["publications"]),
      },
    },
    // A GET, and the difference from the refresh below is the whole reason:
    // this reads the store and spends no request budget, so a browser or a
    // proxy repeating it costs nothing (REQ-070).
    handler: async ({ query }) => ({
      status: STATUS.ok,
      payload: {
        publications: presentLookup(
          // No identifier at all is a legitimate question with an empty answer:
          // a listing whose automations all watch the whole account names no
          // publication, and that must not be a refusal.
          await publications.byIds(now(), query.ids ?? []),
        ),
      },
    }),
  });

  /**
   * What covers this page, AND what could not be read at all (REQ-294).
   *
   * Two halves of one answer and not two routes, because they are one question
   * asked of one table: "of the automations stored here, which ones answer for
   * the publications I am drawing, and which ones can this version not read".
   * The second half carries no page, so a caller that holds no publication at
   * all still gets it by asking with no identifier: that is the automations
   * list screen, which has to say a row exists precisely when it has none to
   * show.
   */
  apiRoute<unknown, Lookup>(scope, {
    method: "GET",
    url: "/api/publications/automation-coverage",
    contract: {
      querystring: LOOKUP_QUERY,
      response: {
        200: outputObject(
          {
            coverage: arrayOf(AUTOMATION_COVERAGE),
            unreadable: arrayOf(UNREADABLE_AUTOMATION),
          },
          ["coverage", "unreadable"],
        ),
      },
    },
    handler: async ({ query }) => ({
      status: STATUS.ok,
      payload: {
        coverage: presentCoverage(await coverage.read(query.ids ?? [])),
        unreadable: presentUnreadable(await coverage.unreadable()),
      },
    }),
  });

  apiRoute<unknown, unknown, Page>(scope, {
    method: "POST",
    url: "/api/publications/refresh",
    contract: {
      body: REFRESH_BODY,
      response: { 200: outputObject({ listing: LISTING }, ["listing"]) },
    },
    handler: async ({ body }) => ({
      status: STATUS.ok,
      payload: {
        listing: presentListing(
          await publications.refresh(now(), pageOf(body)),
        ),
      },
    }),
  });
}
