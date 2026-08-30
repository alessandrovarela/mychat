import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  AccountCredential,
  PlatformAccount,
} from "../../platform/account.js";
import { createPublicationCatalogue } from "../../platform/publications-cache.js";
import { PUBLICATION_LISTING_PAGE_SIZE } from "../../platform/publications-cache.js";
import type {
  PlatformRequest,
  PlatformResponse,
} from "../../platform/transport.js";
import { IN_MEMORY_DATABASE, openDatabase } from "../../storage/database.js";
import type { DatabaseHandle } from "../../storage/database.js";
import {
  createMemoryThumbnails,
  createPublicationCacheStore,
  thumbnailKeyFor,
} from "../../storage/publication-cache.js";
import type {
  CachedPublication,
  MemoryThumbnails,
  PublicationCacheStore,
  ThumbnailBody,
} from "../../storage/publication-cache.js";
import type { PublicationAutomationCoverageReader } from "../../storage/publication-automation-coverage.js";
import { guardContracts, installRefusals } from "./contract.js";
import {
  PUBLICATION_LOOKUP_LIMIT,
  registerPublicationRoutes,
} from "./publications.js";

/**
 * REQ-144: a publication is fetched by IDENTIFIER, not found by reading a page
 * of the grid and matching against it.
 *
 * The whole test is one contrast, and every case here exists to hold one half
 * of it in place. The grid answers the NEWEST publications, a page at a time.
 * An automation watches whatever publication it was created for, and that
 * publication only gets older. So a caller that wanted its thumbnail and read
 * the first page to find it works perfectly on a fresh account, and degrades
 * silently as the account fills: the recent rows keep their pictures and every
 * older one renders the marker of an absent thumbnail, which is the marker for
 * a publication whose copy could not be made and means something else entirely.
 * Nothing fails, nothing logs, and the operator reads it as their thumbnails
 * having disappeared.
 *
 * The fixture is therefore deliberately larger than one page. The publication
 * the cases ask for is the OLDEST one, which is exactly the row the previous
 * approach could never see, and `lists a page that does NOT contain it` is the
 * assertion that keeps this test honest: without it, a fixture that quietly
 * shrank to a single page would leave every other case passing while proving
 * nothing at all.
 *
 * Through the real router, the real catalogue and a real (in-memory) SQLite
 * cache. The serialiser of `contract.ts` emits the declared fields and nothing
 * else, so a payload assembled in the handler and left undeclared would vanish
 * on its way out with no error anywhere: a lookup proven against a double of
 * the catalogue would go green over a route that answers `{}`.
 */

const NOW = new Date("2026-08-03T12:00:00.000Z");

/** Comfortably more than one page, so "older than the first page" exists. */
const PUBLICATION_COUNT = PUBLICATION_LISTING_PAGE_SIZE + 6;

const CREDENTIAL: AccountCredential = {
  path: "instagram_login",
  host: "graph.instagram.com",
  accessToken: "token-1",
  accountId: "acct-1",
};

const account: PlatformAccount = {
  current: () => Promise.resolve(CREDENTIAL),
  check: () => Promise.resolve({ ok: true }),
  refreshIfNeeded: () => Promise.resolve({ kind: "not_needed" }),
};

const PIXELS: ThumbnailBody = {
  bytes: new TextEncoder().encode("pixels"),
  contentType: "image/jpeg",
};

/**
 * The platform's own identifiers: seventeen digits, newest first.
 *
 * Built by concatenation and never by arithmetic. Seventeen digits is past
 * `Number.MAX_SAFE_INTEGER`, so adding an index to a numeric literal of that
 * size silently produces the SAME identifier for several publications, which
 * is worth knowing here and worth knowing about the product: a publication id
 * is a string in this codebase from end to end, for exactly this reason.
 */
function idAt(index: number): string {
  return `178956956680000${String(100 + PUBLICATION_COUNT - index)}`;
}

function publishedAt(index: number): Date {
  return new Date(NOW.getTime() - index * 86_400_000);
}

const NEWEST_ID = idAt(0);
/** The row a page of the grid never reaches, and the point of the feature. */
const OLDEST_ID = idAt(PUBLICATION_COUNT - 1);

/** What the publication at this index was published with, when it was. */
function captionAt(index: number): string {
  return `Publicação ${String(index)}: comenta e eu te mando o link.`;
}

/**
 * Half the fixture carries a caption and half carries none, because both are
 * ordinary and the contract has to answer for both: one publication was
 * published without a caption, and one was cached before the caption was ever
 * asked for. The two are indistinguishable from here, which is the point.
 */
function fixture(): readonly CachedPublication[] {
  return Array.from({ length: PUBLICATION_COUNT }, (_unused, index) => ({
    id: idAt(index),
    ...(index % 2 === 0 && { caption: captionAt(index) }),
    mediaType: index % 2 === 0 ? "IMAGE" : "VIDEO",
    publishedAt: publishedAt(index),
    thumbnailKey: thumbnailKeyFor(idAt(index), PIXELS.contentType),
  }));
}

/** The platform, refusing to be asked: with a filled cache nothing may call it. */
const FORBIDDEN_TRANSPORT = (): Promise<PlatformResponse> => {
  throw new Error("the platform must not be consulted for a lookup");
};

let handle: DatabaseHandle;
let cache: PublicationCacheStore;
let thumbnails: MemoryThumbnails;
let open: FastifyInstance[] = [];

interface AppOptions {
  /** Left empty to reach the one branch that may consult the platform. */
  readonly fill?: boolean;
  readonly transport?: (request: PlatformRequest) => Promise<PlatformResponse>;
  readonly coverage?: PublicationAutomationCoverageReader;
}

async function buildApp(options: AppOptions = {}): Promise<FastifyInstance> {
  if (options.fill !== false) {
    const publications = fixture();

    for (const publication of publications) {
      await thumbnails.put(String(publication.thumbnailKey), PIXELS);
    }

    await cache.replace(publications, NOW);
  }

  const app = Fastify({ logger: false });
  open.push(app);

  await app.register(async (scope) => {
    // The same three lines `registerApiRoutes` runs, in the same order.
    guardContracts(scope);
    installRefusals(scope);
    registerPublicationRoutes(
      scope,
      createPublicationCatalogue({
        account,
        transport: options.transport ?? FORBIDDEN_TRANSPORT,
        cache,
        thumbnails,
        download: () => Promise.resolve(PIXELS),
      }),
      () => NOW,
      options.coverage,
    );
  });

  await app.ready();

  return app;
}

interface Row {
  readonly id: string;
  readonly caption?: string;
  readonly mediaType: string;
  readonly publishedAt: string;
  readonly thumbnailUrl?: string;
}

interface Lookup {
  readonly items: readonly Row[];
  readonly failure?: string;
}

function lookupUrl(ids: readonly string[]): string {
  const parameters = new URLSearchParams();
  for (const id of ids) {
    parameters.append("ids", id);
  }
  return `/api/publications/by-id?${parameters.toString()}`;
}

async function lookup(
  app: FastifyInstance,
  ids: readonly string[],
): Promise<Lookup> {
  const response = await app.inject({ method: "GET", url: lookupUrl(ids) });

  expect(response.statusCode).toBe(200);

  return response.json<{ publications: Lookup }>().publications;
}

beforeEach(() => {
  handle = openDatabase({ databasePath: IN_MEMORY_DATABASE });
  cache = createPublicationCacheStore(handle.db);
  thumbnails = createMemoryThumbnails();
});

afterEach(async () => {
  await Promise.all(open.map((app) => app.close()));
  open = [];
  handle.close();
});

describe("REQ-144: a publication is found by its identifier", () => {
  it("lists a page that does NOT contain the oldest publication", async () => {
    const app = await buildApp();

    const response = await app.inject({
      method: "GET",
      url: "/api/publications",
    });

    expect(response.statusCode).toBe(200);
    const listing = response.json<{
      listing: { items: readonly Row[]; total: number };
    }>().listing;

    // The premise of everything below, asserted rather than assumed: the grid
    // holds every publication and shows a page of the newest, so the target
    // this test asks for is genuinely out of reach of a caller reading pages.
    expect(listing.total).toBe(PUBLICATION_COUNT);
    expect(listing.items.map((item) => item.id)).toContain(NEWEST_ID);
    expect(listing.items.map((item) => item.id)).not.toContain(OLDEST_ID);
  });

  it("finds a publication older than the first page, with its thumbnail", async () => {
    const app = await buildApp();

    const found = await lookup(app, [OLDEST_ID]);

    // The case the whole task exists for. Under the previous approach this row
    // came back as nothing at all, and the screen drew the marker that means
    // "the copy of this picture could not be made".
    expect(found.items).toHaveLength(1);
    expect(found.items[0]?.id).toBe(OLDEST_ID);
    expect(found.items[0]?.publishedAt).toBe(
      publishedAt(PUBLICATION_COUNT - 1).toISOString(),
    );
    // OUR address and never the platform's, exactly as the grid answers
    // (REQ-071): the lookup resolves the stored copy through the same store.
    expect(found.items[0]?.thumbnailUrl).toBe(
      await thumbnails.publicUrl(thumbnailKeyFor(OLDEST_ID, "image/jpeg")),
    );
    expect(found.failure).toBeUndefined();
  });

  it("finds several at once, from both ends of the account's history", async () => {
    const app = await buildApp();

    // One request for the whole listing, and not one per row: an automations
    // screen holds every target it draws, and asking one at a time would turn
    // an opening into as many round trips as there are automations.
    const found = await lookup(app, [NEWEST_ID, OLDEST_ID]);

    expect(found.items.map((item) => item.id).sort()).toEqual(
      [NEWEST_ID, OLDEST_ID].sort(),
    );
  });

  it("reads one identifier given alone, not as a list of one", async () => {
    const app = await buildApp();

    // `?ids=x` arrives as a bare string and the contract declares an array. If
    // the router did not reconcile the two, every automations screen with a
    // single publication target would be refused with a 400.
    expect((await lookup(app, [OLDEST_ID])).items[0]?.id).toBe(OLDEST_ID);
  });

  it("answers the same publication once when two callers name it twice", async () => {
    const app = await buildApp();

    // Several automations legitimately watch one publication, which is the
    // ordinary shape of a launch: one post, three keywords, three automations.
    const found = await lookup(app, [OLDEST_ID, OLDEST_ID]);

    expect(found.items.map((item) => item.id)).toEqual([OLDEST_ID]);
  });

  it("leaves out an identifier the account no longer has, and still answers", async () => {
    const app = await buildApp();

    const found = await lookup(app, [OLDEST_ID, "17895695668999999"]);

    // A deleted publication is an ordinary answer and not an error: the
    // automation that watches it is still a row the operator has to be able to
    // see, and disable (REQ-072).
    expect(found.items.map((item) => item.id)).toEqual([OLDEST_ID]);
    expect(found.failure).toBeUndefined();
  });

  it("asks for nothing when the listing names no publication", async () => {
    const app = await buildApp();

    const response = await app.inject({
      method: "GET",
      url: "/api/publications/by-id",
    });

    // An account whose automations all watch the whole account names no
    // publication at all, and that is an empty answer rather than a refusal.
    expect(response.statusCode).toBe(200);
    expect(
      response.json<{ publications: Lookup }>().publications.items,
    ).toEqual([]);
  });

  it("refuses more identifiers than the declared ceiling, before the domain", async () => {
    const app = await buildApp();

    const response = await app.inject({
      method: "GET",
      url: lookupUrl(
        Array.from({ length: PUBLICATION_LOOKUP_LIMIT + 1 }, (_u, index) =>
          String(index),
        ),
      ),
    });

    // REQ-103: the contract refuses, and it names the field and the rule.
    expect(response.statusCode).toBe(400);
    expect(
      response.json<{ issues: { path: string; rule: string }[] }>().issues,
    ).toContainEqual({ source: "querystring", path: "ids", rule: "maxItems" });
  });
});

describe("REQ-208: the page asks for automation coverage without listing automations", () => {
  it("passes only the page ids and returns own counts and references", async () => {
    const calls: string[][] = [];
    const app = await buildApp({
      coverage: {
        read: (publicationIds) => {
          calls.push([...publicationIds]);
          return Promise.resolve([
            {
              publicationId: NEWEST_ID,
              active: 1,
              inactive: 1,
              automations: [
                { id: "launch", enabled: true },
                { id: "archive", enabled: false },
              ],
            },
          ]);
        },
        unreadable: () => Promise.resolve([]),
      },
    });

    const response = await app.inject({
      method: "GET",
      url: `/api/publications/automation-coverage?ids=${NEWEST_ID}&ids=${OLDEST_ID}`,
    });

    expect(response.statusCode).toBe(200);
    expect(calls).toEqual([[NEWEST_ID, OLDEST_ID]]);
    expect(response.json()).toEqual({
      coverage: [
        {
          publicationId: NEWEST_ID,
          active: 1,
          inactive: 1,
          automations: [
            { id: "launch", enabled: true },
            { id: "archive", enabled: false },
          ],
        },
      ],
      // The other half of the answer, empty because everything parsed. It
      // travels even so: a field a payload only sometimes carries is a field
      // every reader has to guess about (REQ-294).
      unreadable: [],
    });
  });

  it("applies the same per-page ceiling before asking storage", async () => {
    let called = false;
    const app = await buildApp({
      coverage: {
        read: () => {
          called = true;
          return Promise.resolve([]);
        },
        unreadable: () => {
          called = true;
          return Promise.resolve([]);
        },
      },
    });

    const response = await app.inject({
      method: "GET",
      url: lookupUrl(
        Array.from({ length: PUBLICATION_LOOKUP_LIMIT + 1 }, (_u, index) =>
          String(index),
        ),
      ).replace(
        "/api/publications/by-id",
        "/api/publications/automation-coverage",
      ),
    });

    expect(response.statusCode).toBe(400);
    expect(called).toBe(false);
  });
});

/**
 * REQ-294: the contract carries what could NOT be read, so a screen can say it.
 *
 * The half of the coverage answer that has no page: an automation the current
 * schema refuses never reaches a listing, so a caller holding no publication at
 * all is exactly the caller who has to hear about it. That caller is the
 * automations screen, which asks this route with no identifier.
 */
describe("REQ-294: an automation that cannot be read travels in the answer", () => {
  it("names it, with the publication it was stored against", async () => {
    const app = await buildApp({
      coverage: {
        read: () => Promise.resolve([]),
        unreadable: () =>
          Promise.resolve([
            { id: "legacy-attachment", publicationId: NEWEST_ID },
            { id: "corrupt" },
          ]),
      },
    });

    const response = await app.inject({
      method: "GET",
      url: `/api/publications/automation-coverage?ids=${NEWEST_ID}`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      coverage: [],
      unreadable: [
        { id: "legacy-attachment", publicationId: NEWEST_ID },
        // No publication at all is ordinary rather than a gap: a direct message
        // automation watches none, and neither does a draft that named none.
        { id: "corrupt" },
      ],
    });
  });

  it("answers it to a caller that names no publication", async () => {
    const asked: string[][] = [];
    const app = await buildApp({
      coverage: {
        read: (publicationIds) => {
          asked.push([...publicationIds]);
          return Promise.resolve([]);
        },
        unreadable: () => Promise.resolve([{ id: "legacy-attachment" }]),
      },
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/publications/automation-coverage",
    });

    expect(response.statusCode).toBe(200);
    expect(asked).toEqual([[]]);
    expect(response.json()).toEqual({
      coverage: [],
      unreadable: [{ id: "legacy-attachment" }],
    });
  });
});

describe("REQ-072: a lookup that could not be made does not take the screen down", () => {
  it("answers 200 with the platform's own refusal quoted beside no rows", async () => {
    // Nothing cached and the platform unreachable: the one state in which a
    // lookup has to consult the platform, and the one in which it fails.
    const app = await buildApp({
      fill: false,
      transport: () => Promise.reject(new Error("getaddrinfo ENOTFOUND")),
    });

    const found = await lookup(app, [OLDEST_ID]);

    expect(found.items).toEqual([]);
    // Quoted rather than translated: it is the platform speaking, and the
    // screen shows it beside its own wording (REQ-074).
    expect(found.failure).toContain("ENOTFOUND");
  });

  it("does not consult the platform at all once anything is cached", async () => {
    // `FORBIDDEN_TRANSPORT` throws, so this passes only by never being called:
    // an opening of the automations screen must cost no request budget
    // (REQ-070), however many targets it draws.
    const app = await buildApp();

    expect((await lookup(app, [OLDEST_ID, NEWEST_ID])).items).toHaveLength(2);
  });
});

/**
 * REQ-216: the caption reaches the caller, or nothing does.
 *
 * This is the layer where a field disappears in silence. The serialiser of
 * `contract.ts` emits the DECLARED properties and nothing else, so a handler
 * that puts the caption in the payload while the contract never declares it
 * answers 200 with the caption stripped, no error anywhere, and a grid that
 * shows identifiers again. Both routes are asserted for that reason: the grid
 * reads one and the automation form reads the other, and a contract fixed in
 * one place only would leave section 1 of the editor exactly as it was.
 */
describe("REQ-216: the response carries the caption of the publication", () => {
  it("carries it in the listing, and leaves it out when there is none", async () => {
    const app = await buildApp();

    const response = await app.inject({
      method: "GET",
      url: "/api/publications",
    });

    expect(response.statusCode).toBe(200);
    const items = response.json<{ listing: { items: readonly Row[] } }>()
      .listing.items;

    expect(items[0]?.id).toBe(NEWEST_ID);
    expect(items[0]?.caption).toBe(captionAt(0));
    // Absent, and absent as a missing key rather than as an empty string: the
    // screen closes the line up, and nothing was invented to fill it.
    expect(items[1]?.caption).toBeUndefined();
    expect(Object.hasOwn(items[1] ?? {}, "caption")).toBe(false);
  });

  it("carries it in a lookup by identifier, which is what the editor reads", async () => {
    const app = await buildApp();

    const found = await lookup(app, [OLDEST_ID, NEWEST_ID]);
    const newest = found.items.find((item) => item.id === NEWEST_ID);

    expect(newest?.caption).toBe(captionAt(0));
  });

  it("carries a caption longer than any card, whole", async () => {
    // Truncation is the card's decision and nobody else's. A contract that
    // shortened the text would make the whole caption unreachable, and this is
    // the one place it could still be seen in full.
    const written = `${"palavra ".repeat(400)}fim`;

    await cache.replace(
      [
        {
          id: NEWEST_ID,
          caption: written,
          mediaType: "IMAGE",
          publishedAt: publishedAt(0),
        },
      ],
      NOW,
    );

    const app = await buildApp({ fill: false });
    const found = await lookup(app, [NEWEST_ID]);

    expect(found.items[0]?.caption).toBe(written);
  });
});
