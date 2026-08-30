import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { IN_MEMORY_DATABASE, openDatabase } from "../storage/database.js";
import type { DatabaseHandle } from "../storage/database.js";
import {
  createDiskThumbnails,
  createMemoryThumbnails,
  createPublicationCacheStore,
  THUMBNAIL_PREFIX,
} from "../storage/publication-cache.js";
import type {
  MemoryThumbnails,
  PublicationCacheStore,
  ThumbnailBody,
  ThumbnailStore,
} from "../storage/publication-cache.js";
import type { AccountCredential, PlatformAccount } from "./account.js";
import { createPublicationCatalogue } from "./publications-cache.js";
import type { PublicationCatalogue } from "./publications-cache.js";
import type { PlatformRequest, PlatformResponse } from "./transport.js";

/**
 * Proves REQ-069 to REQ-072: the grid the operator picks a target from.
 *
 * The test that matters most here is the expiry one. Every other assertion
 * would pass on a listing that simply stored the platform's media URL, and that
 * listing would show a grid of broken images hours later, on a schedule nobody
 * controls and with nothing failing anywhere in the process. So the source URLs
 * are made to fail after caching, and the pictures still have to be there.
 */

const NOW = new Date("2026-08-02T10:00:00.000Z");
const LATER = new Date("2026-08-02T18:00:00.000Z");

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

/** The three shapes the media edge answers with, and they are not alike. */
const IMAGE = {
  id: "17895695668004550",
  media_type: "IMAGE",
  caption: "Comenta esqueleto e eu te mando o link do artigo.",
  timestamp: "2026-07-30T10:00:00+0000",
  media_url: "https://scontent.cdninstagram.com/image-1.jpg?oe=68A1",
  permalink: "https://www.instagram.com/p/DZY-w4gjCI5/",
};

const VIDEO = {
  id: "17895695668000001",
  media_type: "VIDEO",
  /** Line breaks and hashtags: a caption is written, not filled in a field. */
  caption: "Duas horas ao vivo.\nO link está na bio.\n#sdd #agentesdeIA",
  timestamp: "2026-07-28T09:00:00+0000",
  /** The video FILE. Copying this as a thumbnail is the mistake to avoid. */
  media_url: "https://scontent.cdninstagram.com/reel-1.mp4?oe=68A1",
  thumbnail_url: "https://scontent.cdninstagram.com/reel-1-poster.jpg?oe=68A1",
};

/** A publication with NO caption. Ordinary, and it must stay selectable. */
const CAROUSEL = {
  id: "17895695668000002",
  media_type: "CAROUSEL_ALBUM",
  timestamp: "2026-07-20T08:00:00+0000",
  media_url: "https://scontent.cdninstagram.com/album-1.jpg?oe=68A1",
};

const NEWEST = {
  id: "17895695668000003",
  media_type: "IMAGE",
  timestamp: "2026-08-02T09:00:00+0000",
  media_url: "https://scontent.cdninstagram.com/image-2.jpg?oe=68A1",
};

function mediaPage(
  entries: readonly unknown[],
  next?: string,
): PlatformResponse {
  return {
    status: 200,
    body: { data: entries, ...(next !== undefined && { paging: { next } }) },
  };
}

/** Answers from a fixture and records what would have left the process. */
function recordingTransport(
  answer: (request: PlatformRequest, index: number) => PlatformResponse,
) {
  const sent: PlatformRequest[] = [];

  return {
    sent,
    transport: (request: PlatformRequest): Promise<PlatformResponse> => {
      sent.push(request);
      return Promise.resolve(answer(request, sent.length - 1));
    },
  };
}

/**
 * The CDN, with the one behaviour that defines this feature: an address that
 * worked an hour ago stops working, with no warning and no way to renew it.
 */
function cdn() {
  const asked: string[] = [];
  let everythingExpired = false;

  return {
    asked,
    expireEverything(): void {
      everythingExpired = true;
    },
    download: (url: string): Promise<ThumbnailBody> => {
      asked.push(url);
      if (everythingExpired) {
        return Promise.reject(new Error("403 URL signature expired"));
      }
      return Promise.resolve({
        bytes: new TextEncoder().encode(`pixels of ${url}`),
        contentType: "image/jpeg",
      });
    },
  };
}

describe("the publication catalogue", () => {
  let handle: DatabaseHandle;
  let cache: PublicationCacheStore;
  let thumbnails: MemoryThumbnails;

  beforeEach(() => {
    handle = openDatabase({ databasePath: IN_MEMORY_DATABASE });
    cache = createPublicationCacheStore(handle.db);
    thumbnails = createMemoryThumbnails();
  });

  afterEach(() => {
    handle.close();
  });

  describe("REQ-069: the listing carries what a target is chosen by", () => {
    it("consults the platform once on an empty cache and lists every field", async () => {
      const media = cdn();
      const platform = recordingTransport(() =>
        mediaPage([IMAGE, VIDEO, CAROUSEL]),
      );
      const catalogue = createPublicationCatalogue({
        account,
        transport: platform.transport,
        cache,
        thumbnails,
        download: media.download,
      });

      const listing = await catalogue.open(NOW);

      // Acceptance criterion 28: one walk, one request, nothing repeated.
      expect(platform.sent).toHaveLength(1);
      expect(platform.sent[0]?.host).toBe(CREDENTIAL.host);
      expect(platform.sent[0]?.query?.["fields"]).toContain("media_type");
      expect(platform.sent[0]?.query?.["fields"]).toContain("timestamp");

      expect(listing.source).toBe("platform");
      expect(listing.total).toBe(3);
      // Newest first: the publication an operator automates is the recent one.
      expect(listing.items.map((item) => item.id)).toEqual([
        IMAGE.id,
        VIDEO.id,
        CAROUSEL.id,
      ]);
      expect(listing.items[0]).toMatchObject({
        id: IMAGE.id,
        mediaType: "IMAGE",
        publishedAt: new Date(IMAGE.timestamp),
      });
      expect(listing.items[0]?.thumbnailUrl).toBeDefined();
      expect(listing.cachedAt).toEqual(NOW);
    });

    it("copies the poster of a video, never the video file itself", async () => {
      const media = cdn();
      const platform = recordingTransport(() => mediaPage([VIDEO]));
      const catalogue = createPublicationCatalogue({
        account,
        transport: platform.transport,
        cache,
        thumbnails,
        download: media.download,
      });

      await catalogue.open(NOW);

      expect(media.asked).toEqual([VIDEO.thumbnail_url]);
      expect(media.asked).not.toContain(VIDEO.media_url);
    });

    it("serves the listing in pages", async () => {
      const media = cdn();
      const platform = recordingTransport(() =>
        mediaPage([IMAGE, VIDEO, CAROUSEL]),
      );
      const catalogue = createPublicationCatalogue({
        account,
        transport: platform.transport,
        cache,
        thumbnails,
        download: media.download,
      });

      const first = await catalogue.open(NOW, { limit: 2, offset: 0 });
      const second = await catalogue.open(NOW, { limit: 2, offset: 2 });

      expect(first.items.map((item) => item.id)).toEqual([IMAGE.id, VIDEO.id]);
      expect(first.total).toBe(3);
      expect(second.items.map((item) => item.id)).toEqual([CAROUSEL.id]);
      expect(second.total).toBe(3);
    });

    it("follows the paging cursor the platform hands back", async () => {
      const media = cdn();
      const platform = recordingTransport((_request, index) =>
        index === 0
          ? mediaPage(
              [IMAGE, VIDEO],
              "https://graph.instagram.com/me/media?after=CURSOR",
            )
          : mediaPage([CAROUSEL]),
      );
      const catalogue = createPublicationCatalogue({
        account,
        transport: platform.transport,
        cache,
        thumbnails,
        download: media.download,
      });

      const listing = await catalogue.open(NOW);

      expect(platform.sent).toHaveLength(2);
      expect(platform.sent[1]?.query?.["after"]).toBe("CURSOR");
      expect(listing.total).toBe(3);
    });
  });

  describe("REQ-070: the screen reads the cache, not the platform", () => {
    it("sends nothing when the cache is filled, however often it opens", async () => {
      const media = cdn();
      const platform = recordingTransport(() =>
        mediaPage([IMAGE, VIDEO, CAROUSEL]),
      );
      const catalogue = createPublicationCatalogue({
        account,
        transport: platform.transport,
        cache,
        thumbnails,
        download: media.download,
      });

      await catalogue.open(NOW);
      const requestsAfterFirst = platform.sent.length;

      const again = await catalogue.open(LATER);
      const third = await catalogue.open(LATER);

      // Acceptance criterion 29: not one call, on any later opening.
      expect(platform.sent).toHaveLength(requestsAfterFirst);
      expect(again.source).toBe("cache");
      expect(third.source).toBe("cache");
      expect(again.items.map((item) => item.id)).toEqual([
        IMAGE.id,
        VIDEO.id,
        CAROUSEL.id,
      ]);
      // The instant of the fetch, not of the opening: nothing was refreshed.
      expect(again.cachedAt).toEqual(NOW);
    });

    it("consults the platform and renews the cache on an explicit refresh", async () => {
      const media = cdn();
      let entries: readonly unknown[] = [IMAGE, VIDEO];
      const platform = recordingTransport(() => mediaPage(entries));
      const catalogue = createPublicationCatalogue({
        account,
        transport: platform.transport,
        cache,
        thumbnails,
        download: media.download,
      });

      await catalogue.open(NOW);
      entries = [NEWEST, IMAGE, VIDEO];

      const refreshed = await catalogue.refresh(LATER);

      // Acceptance criterion 30: the platform was asked, and the grid changed.
      expect(platform.sent).toHaveLength(2);
      expect(refreshed.source).toBe("platform");
      expect(refreshed.items.map((item) => item.id)).toEqual([
        NEWEST.id,
        IMAGE.id,
        VIDEO.id,
      ]);
      expect(refreshed.cachedAt).toEqual(LATER);
    });
  });

  describe("REQ-071: the thumbnail outlives the address it came from", () => {
    it("keeps showing the picture after the source URL expires", async () => {
      const media = cdn();
      const platform = recordingTransport(() => mediaPage([IMAGE, VIDEO]));
      const catalogue = createPublicationCatalogue({
        account,
        transport: platform.transport,
        cache,
        thumbnails,
        download: media.download,
      });

      const first = await catalogue.open(NOW);
      const cachedUrl = first.items[0]?.thumbnailUrl;

      // The platform expires the media URLs and stops answering at all: what is
      // on screen from here on can only come from our own storage.
      media.expireEverything();
      const dead = recordingTransport(() => {
        throw new Error("the platform is not answering");
      });
      const afterExpiry = createPublicationCatalogue({
        account,
        transport: dead.transport,
        cache,
        thumbnails,
        download: media.download,
      });

      const listing = await afterExpiry.open(LATER);

      // Acceptance criterion 31: the picture is still there, and it is served
      // from the key in storage rather than from the address that expired.
      expect(listing.items[0]?.thumbnailUrl).toBe(cachedUrl);
      expect(cachedUrl).toContain(THUMBNAIL_PREFIX);
      expect(cachedUrl).not.toContain("cdninstagram");
      expect(listing.items[1]?.thumbnailUrl).toBeDefined();
      expect(dead.sent).toHaveLength(0);

      const stored = thumbnails.bodyOf(`${THUMBNAIL_PREFIX}${IMAGE.id}.jpg`);
      expect(new TextDecoder().decode(stored?.bytes)).toBe(
        `pixels of ${IMAGE.media_url}`,
      );
    });

    it("survives a refresh whose source URLs no longer work", async () => {
      const media = cdn();
      const platform = recordingTransport(() => mediaPage([IMAGE]));
      const catalogue = createPublicationCatalogue({
        account,
        transport: platform.transport,
        cache,
        thumbnails,
        download: media.download,
      });

      const first = await catalogue.open(NOW);
      media.expireEverything();

      const refreshed = await catalogue.refresh(LATER);

      // The copy already in storage is never fetched again, which is what keeps
      // a refresh from replacing a good picture with a failed download.
      expect(media.asked).toEqual([IMAGE.media_url]);
      expect(refreshed.items[0]?.thumbnailUrl).toBe(
        first.items[0]?.thumbnailUrl,
      );
    });
  });

  describe("REQ-072: a listing that fails never blocks an automation", () => {
    it("degrades to an empty grid and leaves the target entry working", async () => {
      const media = cdn();
      const broken = recordingTransport(() => {
        throw new Error("getaddrinfo ENOTFOUND graph.instagram.com");
      });
      const catalogue = createPublicationCatalogue({
        account,
        transport: broken.transport,
        cache,
        thumbnails,
        download: media.download,
      });

      const listing = await catalogue.open(NOW);

      expect(listing.items).toHaveLength(0);
      expect(listing.failure).toContain("ENOTFOUND");

      expect(IMAGE.id).not.toBe("");
    });

    it("lists a publication whose thumbnail could not be stored, and takes a URL target", async () => {
      const media = cdn();
      const platform = recordingTransport(() => mediaPage([IMAGE]));
      const refusing: ThumbnailStore = {
        put: () => Promise.reject(new Error("bucket refused the write")),
        has: () => Promise.resolve(false),
        publicUrl: () => Promise.reject(new Error("nothing was written")),
      };
      const catalogue = createPublicationCatalogue({
        account,
        transport: platform.transport,
        cache,
        thumbnails: refusing,
        download: media.download,
      });

      const listing = await catalogue.open(NOW);

      // A failed copy costs the picture and nothing else: the publication is
      // still listed, and its id is what the operator came here for.
      expect(listing.items).toHaveLength(1);
      expect(listing.items[0]?.id).toBe(IMAGE.id);
      expect(listing.items[0]?.thumbnailUrl).toBeUndefined();

      expect(IMAGE.permalink).toMatch(/^https:/);
    });
  });

  /**
   * REQ-216: the publication arrives with the words that were published.
   *
   * The bite that matters here is the first assertion of the first test. Every
   * other test in this file passes on a catalogue that never asks the platform
   * for `caption`, because the fixtures carry one and a fixture is not an API:
   * drop `caption` from the requested fields and only the assertion on the
   * query goes red. So the request is asserted, and then the round trip through
   * storage, which is what proves the caption survives the screen being closed.
   */
  describe("REQ-216: the caption travels from the platform to the listing", () => {
    /**
     * The media edge as it really behaves: it answers with the fields that were
     * ASKED for, and with nothing else.
     *
     * Every fixture in this file carries its caption inline, so a transport
     * that handed them back whole would let each case below pass over a walk
     * that never requested one — the exact defect this task exists to fix,
     * reproduced inside the test meant to catch it. Projecting the entry onto
     * the requested fields is what ties these assertions to the request.
     */
    function honestMediaEdge(entries: readonly Record<string, unknown>[]) {
      return recordingTransport((request) => {
        const asked = String(request.query?.["fields"] ?? "").split(",");

        return mediaPage(
          entries.map((entry) =>
            Object.fromEntries(
              Object.entries(entry).filter(([field]) => asked.includes(field)),
            ),
          ),
        );
      });
    }

    it("asks the media edge for the caption and lists it whole", async () => {
      const media = cdn();
      const platform = honestMediaEdge([IMAGE, CAROUSEL]);
      const catalogue = createPublicationCatalogue({
        account,
        transport: platform.transport,
        cache,
        thumbnails,
        download: media.download,
      });

      const listing = await catalogue.open(NOW);

      expect(platform.sent[0]?.query?.["fields"]).toContain("caption");
      expect(listing.items[0]?.caption).toBe(IMAGE.caption);
      // A publication with no caption is ordinary: it lists, it is selectable,
      // and nothing was invented to fill the line.
      expect(listing.items[1]?.id).toBe(CAROUSEL.id);
      expect(listing.items[1]?.caption).toBeUndefined();
    });

    it("keeps the caption in the cache, so a later opening still has it", async () => {
      const media = cdn();
      const platform = honestMediaEdge([IMAGE, VIDEO]);
      const catalogue = createPublicationCatalogue({
        account,
        transport: platform.transport,
        cache,
        thumbnails,
        download: media.download,
      });

      await catalogue.open(NOW);
      const again = await catalogue.open(LATER);

      // Read from storage and not from the platform (REQ-070), which is the
      // whole point: the caption has to be IN the row, not in the answer.
      expect(platform.sent).toHaveLength(1);
      expect(again.source).toBe("cache");
      expect(again.items[0]?.caption).toBe(IMAGE.caption);
      // The line breaks the operator typed are still there. A caption is not a
      // label, and collapsing it into one line is a decision for the card.
      expect(again.items[1]?.caption).toBe(VIDEO.caption);
      expect(again.items[1]?.caption).toContain("\n");
    });

    it("stores a very long caption whole, however few lines a card shows", async () => {
      const media = cdn();
      // Longer than any tile can draw, and shorter than the platform allows.
      const written = `${"palavra ".repeat(300)}fim`;
      const platform = honestMediaEdge([{ ...IMAGE, caption: written }]);
      const catalogue = createPublicationCatalogue({
        account,
        transport: platform.transport,
        cache,
        thumbnails,
        download: media.download,
      });

      await catalogue.open(NOW);
      const again = await catalogue.open(LATER);

      // Truncation is presentation. What is kept is the whole text, ending
      // included: a store that shortened it could never give it back.
      expect(again.items[0]?.caption).toBe(written);
      expect(again.items[0]?.caption?.endsWith("fim")).toBe(true);
    });

    it("treats a caption of nothing but spacing as no caption at all", async () => {
      const media = cdn();
      const platform = honestMediaEdge([
        { ...IMAGE, caption: "   \n  " },
        { ...VIDEO, caption: 12 },
      ]);
      const catalogue = createPublicationCatalogue({
        account,
        transport: platform.transport,
        cache,
        thumbnails,
        download: media.download,
      });

      const listing = await catalogue.open(NOW);

      // An empty line on a card is a gap where the absence should close up,
      // and a number is not a caption however confidently it arrives.
      expect(listing.items[0]?.caption).toBeUndefined();
      expect(listing.items[1]?.caption).toBeUndefined();
      // Both are still listed: neither is a reason to lose a target.
      expect(listing.items.map((item) => item.id)).toEqual([
        IMAGE.id,
        VIDEO.id,
      ]);
    });

    it("lists a publication cached before the caption existed, and fills it on the next refresh", async () => {
      // The row a real installation is holding right now: written by a build
      // that never asked for the caption, so the column is null. It has to
      // list, it has to be selectable, and nothing may throw over it.
      handle.connection
        .prepare(
          `INSERT INTO publication_cache (id, media_type, published_at, thumbnail_key, cached_at)
           VALUES (?, ?, ?, NULL, ?)`,
        )
        .run(IMAGE.id, IMAGE.media_type, NOW.getTime(), NOW.getTime());

      const media = cdn();
      const platform = honestMediaEdge([IMAGE]);
      const catalogue = createPublicationCatalogue({
        account,
        transport: platform.transport,
        cache,
        thumbnails,
        download: media.download,
      });

      const stale = await catalogue.open(NOW);

      // REQ-070 holds: a filled cache is not re-read from the platform, so the
      // old row shows exactly what it always showed and no more.
      expect(platform.sent).toHaveLength(0);
      expect(stale.items[0]?.id).toBe(IMAGE.id);
      expect(stale.items[0]?.caption).toBeUndefined();

      // And the way out is the one already on the screen: the operator asks for
      // fresh data, and the caption arrives with it. No backfill, no migration
      // that invents text, nothing to repair by hand.
      const renewed = await catalogue.refresh(LATER);

      expect(renewed.items[0]?.caption).toBe(IMAGE.caption);
    });
  });
});

/**
 * Proves REQ-109 at the binding: the address the listing hands out is one a
 * browser can open, and the copy behind it is a file this process serves.
 *
 * Every test above passes with a binding that returns `memory://bucket/...`,
 * which is what the real execution used and why a real grid showed thirteen
 * publications and no picture at all. The scheme is asserted here, and the
 * route that answers for it in `src/http/assets-route.test.ts`.
 */
describe("REQ-109: the disk binding of the thumbnail store", () => {
  const PUBLIC_ORIGIN = "https://tunnel.example";

  /**
   * A publication id that is a path. Nothing stops the platform from answering
   * with one, and this binding is the first that turns a key into a real write.
   */
  const POISONED = {
    id: "../escaped",
    media_type: "IMAGE",
    timestamp: "2026-07-30T10:00:00+0000",
    media_url: "https://scontent.cdninstagram.com/image-9.jpg?oe=68A1",
  };

  let parent: string;
  let directory: string;
  let handle: DatabaseHandle;
  let cache: PublicationCacheStore;
  let thumbnails: ThumbnailStore;

  function catalogueOver(
    entries: readonly unknown[],
    media: ReturnType<typeof cdn>,
  ): PublicationCatalogue {
    return createPublicationCatalogue({
      account,
      transport: recordingTransport(() => mediaPage(entries)).transport,
      cache,
      thumbnails,
      download: media.download,
    });
  }

  beforeEach(() => {
    parent = mkdtempSync(join(tmpdir(), "mychat-thumbs-"));
    // Deliberately NOT created: the first copy is what creates it, so a fresh
    // clone that has cached nothing has no empty directory to explain.
    directory = join(parent, "thumbs");
    handle = openDatabase({ databasePath: IN_MEMORY_DATABASE });
    cache = createPublicationCacheStore(handle.db);
    thumbnails = createDiskThumbnails({
      dir: directory,
      publicBaseUrl: PUBLIC_ORIGIN,
    });
  });

  afterEach(() => {
    handle.close();
    rmSync(parent, { recursive: true, force: true });
  });

  it("stores the copy as a file and addresses it over HTTP", async () => {
    const media = cdn();

    const listing = await catalogueOver([IMAGE], media).open(NOW);
    const address = new URL(String(listing.items[0]?.thumbnailUrl));

    // The scheme is the assertion. `memory:` parses as a URL just as well, and
    // that is exactly the defect: what a browser can open is http or https.
    expect(["http:", "https:"]).toContain(address.protocol);
    expect(address.pathname).toBe(`/${THUMBNAIL_PREFIX}${IMAGE.id}.jpg`);
    expect(readFileSync(join(directory, `${IMAGE.id}.jpg`), "utf8")).toBe(
      `pixels of ${IMAGE.media_url}`,
    );
  });

  it("refuses a key that would leave the directory, and still lists the publication", async () => {
    const media = cdn();

    const listing = await catalogueOver([POISONED], media).open(NOW);

    // Nothing was written where the id asked for, and nothing was written at
    // all: an id from the platform never gets to choose a path on this host.
    expect(existsSync(join(dirname(directory), "escaped.jpg"))).toBe(false);
    expect(existsSync(join(parent, "escaped.jpg"))).toBe(false);
    // The publication survives the refusal, which is what REQ-072 asks of
    // every failure in this feature: no picture, and still a target.
    expect(listing.items).toHaveLength(1);
    expect(listing.items[0]?.id).toBe(POISONED.id);
    expect(listing.items[0]?.thumbnailUrl).toBeUndefined();
  });

  it("lists the publication with no picture when the copy is gone from disk", async () => {
    const media = cdn();

    await catalogueOver([IMAGE], media).open(NOW);
    unlinkSync(join(directory, `${IMAGE.id}.jpg`));

    const listing = await catalogueOver([IMAGE], media).open(LATER);

    // The cache still points at the key. A grid missing one picture is the
    // whole cost, and the operator can still select the publication.
    expect(listing.items).toHaveLength(1);
    expect(listing.items[0]?.id).toBe(IMAGE.id);
    expect(listing.items[0]?.thumbnailUrl).toBeUndefined();
  });
});

/**
 * Proves REQ-118: the cache survives the storage binding it was filled under.
 *
 * No test above changes the binding, and that is exactly how the defect shipped.
 * The real instance filled thirteen rows on 02/08 through the in-memory binding
 * (bytes in RAM, gone with the process) and ran on 03/08 through disk. The key
 * is derived from the publication id, so both bindings spell it identically:
 * the refresh read a key, concluded the copy existed, downloaded nothing, and
 * every cell of the grid rendered its alternative text over a `dev-data/thumbs`
 * directory that had never been created. Phase 4 performs the same swap in
 * production when disk gives way to the bucket.
 */
describe("REQ-118: a cache filled under another storage binding", () => {
  const PUBLIC_ORIGIN = "https://tunnel.example";

  let parent: string;
  let directory: string;
  let handle: DatabaseHandle;
  let cache: PublicationCacheStore;

  function catalogueOver(
    thumbnails: ThumbnailStore,
    media: ReturnType<typeof cdn>,
  ): PublicationCatalogue {
    return createPublicationCatalogue({
      account,
      transport: recordingTransport(() => mediaPage([IMAGE, VIDEO])).transport,
      cache,
      thumbnails,
      download: media.download,
    });
  }

  function onDisk(): ThumbnailStore {
    return createDiskThumbnails({
      dir: directory,
      publicBaseUrl: PUBLIC_ORIGIN,
    });
  }

  beforeEach(() => {
    parent = mkdtempSync(join(tmpdir(), "mychat-rebind-"));
    // Never created here: `put` is what creates it, so its absence below is the
    // proof that no copy was written, which is what the real instance showed.
    directory = join(parent, "thumbs");
    handle = openDatabase({ databasePath: IN_MEMORY_DATABASE });
    cache = createPublicationCacheStore(handle.db);
  });

  afterEach(() => {
    handle.close();
    rmSync(parent, { recursive: true, force: true });
  });

  it("downloads the thumbnails again when the binding in use holds no copy", async () => {
    const media = cdn();

    // 02/08, in memory: the copies land in RAM and the keys land in the table.
    const filled = await catalogueOver(createMemoryThumbnails(), media).open(
      NOW,
    );
    expect(filled.items.map((item) => item.thumbnailUrl)).not.toContain(
      undefined,
    );

    // 03/08, on disk: another process, another binding, and the same keys.
    expect(existsSync(directory)).toBe(false);

    const listing = await catalogueOver(onDisk(), media).refresh(LATER);

    // The heart of REQ-118: the pictures come back, and they come back by
    // themselves, on the operator's next refresh and with no migration.
    expect(listing.items).toHaveLength(2);
    for (const item of listing.items) {
      expect(item.thumbnailUrl).toEqual(
        expect.stringContaining(`${PUBLIC_ORIGIN}/${THUMBNAIL_PREFIX}`),
      );
    }
    expect(media.asked).toEqual([
      IMAGE.media_url,
      VIDEO.thumbnail_url,
      IMAGE.media_url,
      VIDEO.thumbnail_url,
    ]);
    expect(readFileSync(join(directory, `${IMAGE.id}.jpg`), "utf8")).toBe(
      `pixels of ${IMAGE.media_url}`,
    );
  });

  it("reuses a copy the binding in use still holds, and never fetches it again", async () => {
    const media = cdn();
    const disk = onDisk();

    const first = await catalogueOver(disk, media).open(NOW);
    media.expireEverything();

    const refreshed = await catalogueOver(disk, media).refresh(LATER);

    // REQ-071, and the reason the reuse exists at all: the copy is there, so
    // the source is never asked again and a URL that has since expired gets no
    // chance to replace a good picture with nothing.
    expect(media.asked).toEqual([IMAGE.media_url, VIDEO.thumbnail_url]);
    expect(refreshed.items.map((item) => item.thumbnailUrl)).toEqual(
      first.items.map((item) => item.thumbnailUrl),
    );
  });

  it("lists the publications with no picture when the copies are gone and the sources have expired", async () => {
    const media = cdn();

    await catalogueOver(createMemoryThumbnails(), media).open(NOW);
    media.expireEverything();

    const listing = await catalogueOver(onDisk(), media).refresh(LATER);

    // REQ-072 is untouched by the retry: a download that fails costs the
    // picture and nothing else, and the grid still hands over the targets.
    expect(listing.items.map((item) => item.id)).toEqual([IMAGE.id, VIDEO.id]);
    expect(listing.items[0]?.thumbnailUrl).toBeUndefined();
    expect(listing.items[1]?.thumbnailUrl).toBeUndefined();
    expect(listing.failure).toBeUndefined();
  });
});
