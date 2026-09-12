import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { desc, inArray, isNotNull } from "drizzle-orm";
import type { AssetStorage } from "../engine/ports.js";
import type { MyChatDatabase } from "./database.js";
import { publicationCache } from "./schema.js";
import type { PublicationCacheRow } from "./schema.js";

/**
 * Where the account's publications live between two openings of the screen
 * (REQ-069, REQ-070, REQ-071).
 *
 * The table is the requirement, not an optimisation. Asking the platform every
 * time the grid is drawn spends the account's request budget to redraw
 * something that changes when the operator publishes, and it makes the screen
 * fail whenever the platform is slow.
 *
 * The thumbnail is stored as a KEY and never as the platform's URL. Media URLs
 * on that CDN expire (docs/platform-limits.md, `media_url_validity`: official
 * documentation confirms they are not permanent and gives no deadline), so a
 * cached URL turns into a grid of broken images at an hour nobody can predict.
 * The image is copied into object storage under the `thumbs/` prefix (ADR-006,
 * ADR-010) and this key is what the listing resolves afterwards.
 */

/** The prefix that keeps thumbnails apart from operator assets (ADR-010). */
export const THUMBNAIL_PREFIX = "thumbs/";

/**
 * Extension per content type, so a binding that serves files by name (the disk
 * one, and the assets route in front of it) answers with a type a browser will
 * render. An unknown type gets no image extension rather than a plausible lie:
 * naming a WebP `.jpg` is how a grid renders nothing and nobody can tell why.
 */
const THUMBNAIL_EXTENSIONS: Readonly<Record<string, string>> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "image/gif": ".gif",
};

const UNKNOWN_THUMBNAIL_EXTENSION = ".bin";

/** The key one publication's thumbnail is stored under, everywhere. */
export function thumbnailKeyFor(
  publicationId: string,
  contentType: string,
): string {
  const extension =
    THUMBNAIL_EXTENSIONS[contentType.split(";")[0]?.trim().toLowerCase() ?? ""];
  return `${THUMBNAIL_PREFIX}${publicationId}${extension ?? UNKNOWN_THUMBNAIL_EXTENSION}`;
}

export interface ThumbnailBody {
  readonly bytes: Uint8Array;
  /** What the source served it as, which decides the key's extension. */
  readonly contentType: string;
}

/**
 * The write half of the thumbnail copy. The read half is `AssetStorage`, the
 * contract that already exists (ADR-016), so a listing resolves a key exactly
 * the way a flow resolves an asset and no second address scheme appears.
 *
 * Separate from `AssetCatalogue` on purpose: the operator's assets are uploaded
 * by hand and browsed by validation, while thumbnails are written by this
 * application and only ever read by key.
 */
export interface ThumbnailStore extends AssetStorage {
  put(key: string, body: ThumbnailBody): Promise<void>;
  /**
   * Whether THIS binding holds the copy that key names (REQ-118).
   *
   * Asked before a copy already recorded in the database is reused. The key is
   * derived from the publication id (`thumbnailKeyFor`), so it is identical
   * under every binding, and a key alone therefore proves that a copy was made
   * once, never that the binding in use can serve it. Switching bindings
   * (the in-memory double to disk in development, disk to the bucket in
   * deployment) leaves every recorded key pointing at bytes the new binding
   * never wrote.
   *
   * Separate from `publicUrl` because the question is separate: `publicUrl`
   * refuses a missing copy by throwing, and reading a boolean out of a thrown
   * error confuses "this copy is not here" with "this binding is not working".
   */
  has(key: string): Promise<boolean>;
}

/**
 * Where a memory-held copy answers from. Not a real host, and never fetched:
 * the double hands back an address so a caller can assert the listing points at
 * storage rather than at the platform. The `thumbs/` prefix is part of the key,
 * so this is the root of the bucket and not of the prefix.
 */
export const MEMORY_THUMBNAIL_BASE = "memory://bucket";

export interface MemoryThumbnails extends ThumbnailStore {
  /** What was actually written, for a test that checks the bytes survived. */
  bodyOf(key: string): ThumbnailBody | undefined;
  keys(): string[];
}

/**
 * The fast-suite binding of ADR-016. Also the only binding this phase needs:
 * where the copies finally land (the bucket under `thumbs/`) is a configuration
 * decision of the deployment phase, and every caller here is written against
 * the contract, so that decision changes one composition line.
 */
export function createMemoryThumbnails(
  publicBaseUrl: string = MEMORY_THUMBNAIL_BASE,
): MemoryThumbnails {
  const base = publicBaseUrl.replace(/\/+$/, "");
  const store = new Map<string, ThumbnailBody>();

  return {
    put(key: string, body: ThumbnailBody): Promise<void> {
      store.set(key, body);
      return Promise.resolve();
    },
    has(key: string): Promise<boolean> {
      // The map IS this binding's storage, and it dies with the process. That
      // is the honest answer a fresh run needs to hear, and the one that makes
      // a cache filled by an earlier run download its thumbnails again.
      return Promise.resolve(store.has(key));
    },
    publicUrl(name: string): Promise<string> {
      if (!store.has(name)) {
        // Same shape as the asset bindings refuse with: the caller decides what
        // a missing copy means, and here it means listing without a picture.
        throw new Error(`asset "${name}" does not exist`);
      }
      return Promise.resolve(`${base}/${name}`);
    },
    bodyOf(key: string): ThumbnailBody | undefined {
      return store.get(key);
    },
    keys(): string[] {
      return [...store.keys()].sort();
    },
  };
}

export interface DiskThumbnailConfig {
  /**
   * Directory the copies are written to: the `thumbs/` prefix of the bucket,
   * as a directory on this machine. Created on the first write, so a fresh
   * clone with nothing cached has no empty directory to explain.
   */
  readonly dir: string;
  /**
   * Root the addresses are built from, and the root of the BUCKET rather than
   * of the prefix: the key already carries `thumbs/`, exactly as it will in R2
   * (ADR-010). With the disk binding this is the process's own public origin,
   * because the process is what answers for those addresses.
   */
  readonly publicBaseUrl: string | (() => Promise<string>);
}

/**
 * The file one key names inside the directory, or `undefined` when the key does
 * not name one.
 *
 * The check is not ceremony. The key is built from the publication id the
 * PLATFORM reported (`thumbnailKeyFor`), so an id carrying `../` would make
 * `put` write wherever it pleased on the host, and this is the one binding
 * where that is a write to a real file system. Containment is decided by
 * resolving and comparing against the directory, never by inspecting the string
 * for shapes we thought of: `dirname(resolved) === root` refuses every escape
 * that resolves elsewhere, whatever it was spelled like.
 */
function thumbnailFile(dir: string, key: string): string | undefined {
  if (!key.startsWith(THUMBNAIL_PREFIX) || key.includes("\0")) {
    return undefined;
  }

  const root = resolve(dir);
  const target = resolve(root, key.slice(THUMBNAIL_PREFIX.length));

  return dirname(target) === root ? target : undefined;
}

/**
 * The development binding, and the one every real execution uses until the
 * bucket lands (ADR-016): the copy is a file on disk, and its address is one
 * this process answers for through `registerThumbnailsRoute`.
 *
 * That last part is the whole point of it existing. The in-memory double hands
 * out `memory://bucket/...`, which is an address no browser resolves, so a grid
 * composed with the double shows the alternative text of every cell while every
 * test about the listing passes (REQ-109).
 */
export function createDiskThumbnails(
  config: DiskThumbnailConfig,
): ThumbnailStore {
  return {
    put(key: string, body: ThumbnailBody): Promise<void> {
      const file = thumbnailFile(config.dir, key);

      if (file === undefined) {
        // Refused, not repaired: a key this binding cannot place inside its own
        // directory is a key nothing should be writing. The caller catches it
        // and the publication lists with no picture, which is the same outcome
        // as any other failed copy.
        return Promise.reject(new Error(`thumbnail key "${key}" is refused`));
      }

      mkdirSync(config.dir, { recursive: true });
      writeFileSync(file, body.bytes);

      return Promise.resolve();
    },

    has(key: string): Promise<boolean> {
      const file = thumbnailFile(config.dir, key);

      // A key this binding would refuse to write is a key it cannot be holding,
      // so it answers no rather than reaching for a path outside its directory.
      return Promise.resolve(file !== undefined && existsSync(file));
    },

    async publicUrl(name: string): Promise<string> {
      const file = thumbnailFile(config.dir, name);

      if (file === undefined || !existsSync(file)) {
        // Same shape as the asset bindings refuse with: the caller decides what
        // a missing copy means, and here it means listing without a picture.
        throw new Error(`asset "${name}" does not exist`);
      }

      // The prefix is part of the address because it is part of the key, and
      // the route answers at exactly that prefix. The file name is encoded for
      // the same reason `createDiskAssets` encodes one: it lands in a URL.
      const source = config.publicBaseUrl;
      const base = (
        typeof source === "function" ? await source() : source
      ).replace(/\/+$/, "");
      return `${base}/${THUMBNAIL_PREFIX}${encodeURIComponent(name.slice(THUMBNAIL_PREFIX.length))}`;
    },
  };
}

/** One publication as the cache holds it: no URL of the platform's anywhere. */
export interface CachedPublication {
  readonly id: string;
  /**
   * The caption, whole (REQ-216). Absent both when the publication carries
   * none and when the row predates the column, and the two degrade the same
   * way: the card shows what it always showed, and a refresh fills it in.
   */
  readonly caption?: string;
  /** The platform's own vocabulary (`IMAGE`, `VIDEO`, ...), left unmapped. */
  readonly mediaType: string;
  readonly publishedAt: Date;
  /** Absent when the copy could not be made; the publication still lists. */
  readonly thumbnailKey?: string;
}

export interface PublicationPageQuery {
  readonly limit: number;
  readonly offset: number;
}

export interface CachedPublicationPage {
  readonly items: readonly CachedPublication[];
  /** Everything cached, so the screen can say how far the pages go. */
  readonly total: number;
  /** When the cache was last renewed. Absent when it is empty. */
  readonly cachedAt?: Date;
}

export interface PublicationCacheStore {
  /**
   * Renews the cache with what the platform reported, wholesale and in one
   * transaction: a half-written listing is a grid missing rows for reasons the
   * operator cannot see.
   */
  replace(publications: readonly CachedPublication[], at: Date): Promise<void>;
  page(query: PublicationPageQuery): Promise<CachedPublicationPage>;
  /**
   * The publications these identifiers name, and only the ones that exist
   * (REQ-144).
   *
   * Named separately from `page` because it answers a different question, and
   * the difference is the requirement. A page answers "what did I publish most
   * recently"; this answers "what is publication 17895695668004550", and no
   * amount of paging turns the first into the second. Reading the first page
   * and matching against it is how a target older than that page renders as a
   * publication that does not exist, on a screen that holds its identifier.
   *
   * Order is storage's, not the caller's: identity is what was asked for, and a
   * caller that needs its own order has the identifiers to impose it.
   */
  byIds(ids: readonly string[]): Promise<readonly CachedPublication[]>;
  /** Zero is what "the cache is empty" means, the one case that may fetch. */
  count(): Promise<number>;
  /**
   * Publication id to thumbnail key, for the copies this table records.
   *
   * A refresh reads this before downloading anything: the image of a given
   * publication does not change, so re-fetching every thumbnail on every
   * refresh would spend bandwidth to produce identical bytes, and would make an
   * expired source URL destroy a copy that is still perfectly good.
   *
   * What it says is that a copy was made under SOME binding, and not that the
   * binding in use holds it (REQ-118). Reuse is decided by asking the store
   * (`ThumbnailStore.has`); this map only says which key to ask about.
   */
  thumbnailKeys(): Promise<ReadonlyMap<string, string>>;
  ids(): Promise<readonly string[]>;
}

function toCached(row: PublicationCacheRow): CachedPublication {
  return {
    id: row.id,
    // Null is what a row written before the column existed carries, and what a
    // publication with no caption carries. Both read as absent here, which is
    // the one shape every caller above already handles.
    ...(row.caption !== null && { caption: row.caption }),
    mediaType: row.mediaType,
    publishedAt: row.publishedAt,
    ...(row.thumbnailKey !== null && { thumbnailKey: row.thumbnailKey }),
  };
}

export function createPublicationCacheStore(
  db: MyChatDatabase,
): PublicationCacheStore {
  return {
    replace(
      publications: readonly CachedPublication[],
      at: Date,
    ): Promise<void> {
      db.transaction((tx) => {
        tx.delete(publicationCache).run();

        if (publications.length === 0) {
          return;
        }

        tx.insert(publicationCache)
          .values(
            publications.map((publication) => ({
              id: publication.id,
              caption: publication.caption ?? null,
              mediaType: publication.mediaType,
              publishedAt: publication.publishedAt,
              thumbnailKey: publication.thumbnailKey ?? null,
              cachedAt: at,
            })),
          )
          .run();
      });

      return Promise.resolve();
    },

    page(query: PublicationPageQuery): Promise<CachedPublicationPage> {
      // Read whole and sliced in memory rather than by SQL `limit/offset`: the
      // walk that fills this table is bounded to a low four figures, and the
      // total has to be counted anyway for the screen to page at all.
      const rows = db
        .select()
        .from(publicationCache)
        .orderBy(desc(publicationCache.publishedAt))
        .all();

      const items = rows
        .slice(query.offset, query.offset + query.limit)
        .map(toCached);

      const cachedAt = rows.reduce<Date | undefined>(
        (latest, row) =>
          latest === undefined || row.cachedAt > latest ? row.cachedAt : latest,
        undefined,
      );

      return Promise.resolve({
        items,
        total: rows.length,
        ...(cachedAt !== undefined && { cachedAt }),
      });
    },

    byIds(ids: readonly string[]): Promise<readonly CachedPublication[]> {
      if (ids.length === 0) {
        // Short-circuited rather than handed to `inArray`, which builds a
        // predicate with nothing on its right-hand side. Nothing asked for is
        // nothing found, and that answer costs no query.
        return Promise.resolve([]);
      }

      const rows = db
        .select()
        .from(publicationCache)
        .where(inArray(publicationCache.id, [...ids]))
        .all();

      return Promise.resolve(rows.map(toCached));
    },

    count(): Promise<number> {
      return Promise.resolve(
        db.select({ id: publicationCache.id }).from(publicationCache).all()
          .length,
      );
    },

    thumbnailKeys(): Promise<ReadonlyMap<string, string>> {
      const rows = db
        .select({
          id: publicationCache.id,
          thumbnailKey: publicationCache.thumbnailKey,
        })
        .from(publicationCache)
        .where(isNotNull(publicationCache.thumbnailKey))
        .all();

      const keys = new Map<string, string>();
      for (const row of rows) {
        if (row.thumbnailKey !== null) {
          keys.set(row.id, row.thumbnailKey);
        }
      }

      return Promise.resolve(keys);
    },

    ids(): Promise<readonly string[]> {
      return Promise.resolve(
        db
          .select({ id: publicationCache.id })
          .from(publicationCache)
          .all()
          .map((row) => row.id),
      );
    },
  };
}
