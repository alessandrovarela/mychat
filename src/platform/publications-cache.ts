import { t } from "../i18n/index.js";
import type {
  CachedPublication,
  PublicationCacheStore,
  PublicationPageQuery,
  ThumbnailBody,
  ThumbnailStore,
} from "../storage/publication-cache.js";
import { thumbnailKeyFor } from "../storage/publication-cache.js";
import type { PlatformAccount } from "./account.js";
import {
  describeResponseError,
  describeThrown,
  MEDIA_PAGE_SIZE,
  MEDIA_PATH,
  nextPageRequest,
  PUBLICATION_PAGE_LIMIT,
} from "./publications.js";
import type { MediaPage } from "./publications.js";
import { isSuccess } from "./transport.js";
import type { PlatformRequest, PlatformTransport } from "./transport.js";

/**
 * The publication grid the operator picks a target from (REQ-069 to REQ-072).
 *
 * Three separate facts shape this module, and dropping any one of them gives a
 * screen that looks right and rots:
 *
 *   - REQ-070: the platform is consulted when the cache is EMPTY or when the
 *     operator asks for a refresh, never on an opening. The listing is a read
 *     of local storage, so opening the screen costs no request budget and works
 *     while the platform is down.
 *   - REQ-071: the platform's media URLs expire (docs/platform-limits.md,
 *     `media_url_validity`), so caching one would produce broken images at an
 *     hour nobody can predict. Caching a publication COPIES its thumbnail into
 *     object storage and the listing hands out that address instead. Nothing in
 *     this module ever stores or returns a platform URL.
 *   - REQ-072: none of the above may stand between the operator and an
 *     automation. Every failure here degrades the listing and nothing else: the
 *     publication identifier can still be typed into the trigger by hand, and
 *     that path touches neither this cache nor this module.
 */

/**
 * What the listing needs of each publication: the identifier that becomes the
 * target, the words the operator wrote, the type and the date they recognise it
 * by, and an address for the picture.
 *
 * `caption` is here because a person recognises their own post by the text they
 * wrote and never by a seventeen digit number (REQ-216): asking for everything
 * else and not for it is what left the grid reading `IMAGE · 09 jun ·
 * 17900000000000001`, ten times over, on a screen where every tile is a
 * decision.
 *
 * The official reference for this node marks `caption` "Available for Instagram
 * API with Facebook Login only", and that line is WRONG for this endpoint: a
 * real `GET /me/media` on `graph.instagram.com`, with the Instagram Login
 * credential this project uses (ADR-021, ADR-022), answers 200 with the caption
 * of every publication. Verified against the operated account on 2026-08-16 and
 * recorded in docs/platform-limits.md under `media_caption_field`.
 *
 * `thumbnail_url` and `media_url` are both asked for, and they are not
 * interchangeable: a VIDEO carries the poster image in `thumbnail_url` and the
 * video file itself in `media_url`, so taking `media_url` for everything would
 * copy whole videos into the bucket as "thumbnails". An IMAGE has no
 * `thumbnail_url` at all, which is why both are requested and one falls back to
 * the other.
 */
const LISTING_FIELDS =
  "id,caption,media_type,timestamp,thumbnail_url,media_url";

/** How many publications one page of the grid carries. */
export const PUBLICATION_LISTING_PAGE_SIZE = 24;

/** One publication as the screen shows it. No platform URL, by construction. */
export interface PublicationEntry {
  readonly id: string;
  /**
   * The words the operator published, WHOLE (REQ-216).
   *
   * Absent when the publication carries none, which is an ordinary post and not
   * a defect, and absent as well for a publication cached before this field
   * existed, until the next refresh fills it. Truncation belongs to whoever
   * draws it: a card shows two lines, and a stored half-caption could never be
   * made whole again.
   */
  readonly caption?: string;
  readonly mediaType: string;
  readonly publishedAt: Date;
  /** Address in OUR storage. Absent when no copy could be made (REQ-069). */
  readonly thumbnailUrl?: string;
}

export interface PublicationListing {
  readonly items: readonly PublicationEntry[];
  /** Everything cached, so the screen knows how many pages exist. */
  readonly total: number;
  readonly offset: number;
  readonly limit: number;
  /** Where these rows came from. `platform` means a walk happened just now. */
  readonly source: "cache" | "platform";
  readonly cachedAt?: Date;
  /**
   * Why the platform could not be consulted, when it could not (REQ-072).
   *
   * Present BESIDE the items rather than instead of them: a refresh that fails
   * leaves whatever was cached on screen, and an empty cache leaves an empty
   * grid, but neither takes away the manual entry of the target.
   */
  readonly failure?: string;
}

/**
 * Fetches the bytes of a thumbnail from the platform's CDN. A port because the
 * fast suite touches no network (ADR-017), and because this is the one call in
 * the feature that is not the JSON transport.
 */
export type ThumbnailDownload = (url: string) => Promise<ThumbnailBody>;

export interface PublicationCatalogueDeps {
  readonly account: PlatformAccount;
  readonly transport: PlatformTransport;
  readonly cache: PublicationCacheStore;
  readonly thumbnails: ThumbnailStore;
  readonly download: ThumbnailDownload;
  /** Overridable so the page size is configuration and not a literal here. */
  readonly pageSize?: number;
}

/**
 * What a lookup by identifier answers with (REQ-144).
 *
 * Not a `PublicationListing`, and the missing fields say why: there is no page
 * to report, no total to page through, and no origin to announce, because the
 * rows always come from this instance's own store. What it keeps is `failure`,
 * so a caller degrades exactly the way the grid does.
 */
export interface PublicationLookup {
  /**
   * The publications that were found, in storage's order. Absent identifiers
   * are simply absent: asking for a publication the account no longer has is
   * an ordinary answer, not a failure, and an automation pointing at one is
   * still a perfectly good row on the screen.
   */
  readonly items: readonly PublicationEntry[];
  /** Why the platform could not be consulted, when it had to be (REQ-072). */
  readonly failure?: string;
}

export interface PublicationCatalogue {
  /**
   * The screen opening. Reads the cache, and consults the platform ONLY when
   * the cache is empty (REQ-070).
   */
  open(
    now: Date,
    page?: Partial<PublicationPageQuery>,
  ): Promise<PublicationListing>;
  /** The operator asking for fresh data: always walks the platform (REQ-070). */
  refresh(
    now: Date,
    page?: Partial<PublicationPageQuery>,
  ): Promise<PublicationListing>;
  /**
   * The publications these identifiers name (REQ-144).
   *
   * The reason this exists rather than the caller reading a page and matching
   * against it: a page is the NEWEST publications, and an automation watching
   * one published before that page would find nothing, on a screen that is
   * holding its identifier. The defect is invisible on a fresh account and
   * grows with every publication, which is the worst schedule available.
   */
  byIds(now: Date, ids: readonly string[]): Promise<PublicationLookup>;
  syncIds(
    now: Date,
  ): Promise<
    | { readonly ok: true; readonly ids: readonly string[] }
    | { readonly ok: false; readonly reason: string }
  >;
}

/** One entry of the media edge, after the parts we can trust are read out. */
interface ListedMedia {
  readonly id: string;
  /** The caption, whole, or nothing when the publication carries none. */
  readonly caption?: string;
  readonly mediaType: string;
  readonly publishedAt: Date;
  /** The platform address the copy is made FROM. Never stored, never returned. */
  readonly thumbnailSource?: string;
}

/**
 * The caption of one entry, or nothing.
 *
 * Two answers collapse into "nothing" on purpose: a publication that carries no
 * caption at all, and one whose caption is only spacing. Neither has anything
 * to show, and keeping the second would put an empty line on a card where the
 * absence is supposed to close up.
 *
 * Only the ENDS are trimmed. What is inside is the operator's own text, line
 * breaks included, and this is the last place that could give it back if it
 * were thrown away here.
 */
function readCaption(caption: unknown): string | undefined {
  if (typeof caption !== "string") {
    // Someone else's API: a number, a null or an object here is not a caption,
    // and refusing the whole entry over it would cost a selectable target.
    return undefined;
  }

  const written = caption.trim();

  return written === "" ? undefined : written;
}

type WalkOutcome =
  | { readonly ok: true; readonly entries: readonly ListedMedia[] }
  | { readonly ok: false; readonly reason: string };

function readEntry(entry: unknown): ListedMedia | undefined {
  const media = entry as {
    id?: unknown;
    caption?: unknown;
    media_type?: unknown;
    timestamp?: unknown;
    thumbnail_url?: unknown;
    media_url?: unknown;
  } | null;

  if (typeof media?.id !== "string" || typeof media.media_type !== "string") {
    // Without an id there is no target to select, so the row is worth nothing
    // to this screen. Skipped rather than refused: one unreadable entry must
    // not cost the operator the whole listing.
    return undefined;
  }

  const published =
    typeof media.timestamp === "string" ? new Date(media.timestamp) : undefined;

  const source =
    typeof media.thumbnail_url === "string"
      ? media.thumbnail_url
      : typeof media.media_url === "string"
        ? media.media_url
        : undefined;

  const caption = readCaption(media.caption);

  return {
    id: media.id,
    ...(caption !== undefined && { caption }),
    mediaType: media.media_type,
    // A missing or unparseable timestamp still lists, at the epoch: the date
    // orders the grid, and losing the publication over it would take away a
    // target the operator can see on their own profile.
    publishedAt:
      published !== undefined && !Number.isNaN(published.getTime())
        ? published
        : new Date(0),
    ...(source !== undefined && { thumbnailSource: source }),
  };
}

/**
 * Walks the media edge to its end, or to the bound `publications.ts` already
 * defends the same edge with.
 *
 * A failure part way through returns the failure and NOT the pages already
 * read: replacing the cache with a truncated listing would silently delete
 * publications the operator could select a minute earlier.
 */
async function walk(deps: PublicationCatalogueDeps): Promise<WalkOutcome> {
  let request: PlatformRequest;

  try {
    const credential = await deps.account.current();
    request = {
      method: "GET",
      // Never hard-coded: the two authentication paths use different hosts
      // (ADR-022), and the port is what knows which one is in force.
      host: credential.host,
      path: MEDIA_PATH,
      query: {
        fields: LISTING_FIELDS,
        limit: String(MEDIA_PAGE_SIZE),
        access_token: credential.accessToken,
      },
    };
  } catch (error) {
    return { ok: false, reason: describeThrown(error) };
  }

  const entries: ListedMedia[] = [];

  for (let page = 0; page < PUBLICATION_PAGE_LIMIT; page += 1) {
    let response;
    try {
      response = await deps.transport(request);
    } catch (error) {
      return { ok: false, reason: describeThrown(error) };
    }

    if (!isSuccess(response)) {
      return { ok: false, reason: describeResponseError(response) };
    }

    if (typeof response.body !== "object" || response.body === null) {
      return { ok: false, reason: t("publication.malformedResponse") };
    }

    const body = response.body as MediaPage;
    if (Array.isArray(body.data)) {
      for (const entry of body.data) {
        const read = readEntry(entry);
        if (read !== undefined) {
          entries.push(read);
        }
      }
    }

    const following = nextPageRequest(body);
    if (following === undefined) {
      return { ok: true, entries };
    }
    request = following;
  }

  // The bound was reached. Reported as a success because every page answered:
  // what ran out was the walk, and the newest publications are what the grid
  // is for.
  return { ok: true, entries };
}

/**
 * Copies one thumbnail into storage and returns its key, or undefined when the
 * copy could not be made.
 *
 * A failure is swallowed on purpose, and it is the difference between a grid
 * with one missing picture and a screen that shows nothing: the publication is
 * still a perfectly valid automation target, and its id is what the operator
 * came for.
 */
async function copyThumbnail(
  deps: PublicationCatalogueDeps,
  entry: ListedMedia,
): Promise<string | undefined> {
  if (entry.thumbnailSource === undefined) {
    return undefined;
  }

  let body: ThumbnailBody;
  try {
    body = await deps.download(entry.thumbnailSource);
  } catch (error) {
    // The platform URL is deliberately not part of this line. It is a
    // short-lived, signed address, and writing it to a log would turn a useful
    // operational diagnostic into a credential leak. The publication id is
    // public already, while the error name and HTTP status (when our fetch
    // implementation supplied one) tell an operator whether the failure was
    // the CDN or the local write that follows.
    const status =
      error instanceof ThumbnailDownloadError && error.status !== undefined
        ? ` status=${error.status}`
        : "";
    console.warn(
      `[mychat] thumbnail copy failed publication=${entry.id} stage=download${status}`,
    );
    return undefined;
  }

  const key = thumbnailKeyFor(entry.id, body.contentType);
  try {
    await deps.thumbnails.put(key, body);
    return key;
  } catch {
    console.warn(
      `[mychat] thumbnail copy failed publication=${entry.id} stage=storage`,
    );
    return undefined;
  }
}

/**
 * The key of a copy that is worth reusing, or undefined when a fresh download
 * is what the publication needs (REQ-118).
 *
 * A key recorded in the cache says a copy was made once, under whichever
 * binding was composed that day. It is derived from the publication id, so it
 * is identical under every binding, and reusing it without asking is how a
 * development instance ended up with thirteen keys written by the in-memory
 * binding and a disk directory that had never been created: the refresh read
 * the keys, concluded the copies existed, downloaded nothing, and every cell of
 * the grid rendered its alternative text. The same swap happens again when disk
 * gives way to the bucket in deployment.
 */
async function reusableCopy(
  deps: PublicationCatalogueDeps,
  key: string | undefined,
): Promise<string | undefined> {
  if (key === undefined) {
    return undefined;
  }

  try {
    return (await deps.thumbnails.has(key)) ? key : undefined;
  } catch {
    // The store could not answer, which is not the same as answering no. The
    // key is kept: downloading again on a doubt is exactly how an expired
    // source URL replaces a copy that is very probably still there (REQ-071),
    // and a key whose copy is genuinely gone already lists with no picture.
    return key;
  }
}

/** The stored address of a copy, or undefined when the copy is not there. */
async function thumbnailUrlOf(
  deps: PublicationCatalogueDeps,
  publication: CachedPublication,
): Promise<string | undefined> {
  if (publication.thumbnailKey === undefined) {
    return undefined;
  }

  try {
    return await deps.thumbnails.publicUrl(publication.thumbnailKey);
  } catch {
    // The copy was removed from storage behind our back. The publication keeps
    // its place in the grid: it is still selectable, and a picture is not what
    // makes it one.
    return undefined;
  }
}

/**
 * One cached publication as a caller receives it: the stored address of the
 * copy, never the platform's own. Shared by the listing and the lookup, so the
 * two cannot drift into answering with different shapes for one publication.
 */
async function entryOf(
  deps: PublicationCatalogueDeps,
  publication: CachedPublication,
): Promise<PublicationEntry> {
  const url = await thumbnailUrlOf(deps, publication);

  return {
    id: publication.id,
    ...(publication.caption !== undefined && { caption: publication.caption }),
    mediaType: publication.mediaType,
    publishedAt: publication.publishedAt,
    ...(url !== undefined && { thumbnailUrl: url }),
  };
}

function pageQuery(
  deps: PublicationCatalogueDeps,
  page: Partial<PublicationPageQuery> | undefined,
): PublicationPageQuery {
  return {
    limit: page?.limit ?? deps.pageSize ?? PUBLICATION_LISTING_PAGE_SIZE,
    offset: page?.offset ?? 0,
  };
}

/** Reads one page out of the cache. The only path that produces a listing. */
async function readListing(
  deps: PublicationCatalogueDeps,
  query: PublicationPageQuery,
  source: "cache" | "platform",
  failure?: string,
): Promise<PublicationListing> {
  const page = await deps.cache.page(query);

  const items = await Promise.all(
    page.items.map((publication) => entryOf(deps, publication)),
  );

  return {
    items,
    total: page.total,
    offset: query.offset,
    limit: query.limit,
    source,
    ...(page.cachedAt !== undefined && { cachedAt: page.cachedAt }),
    ...(failure !== undefined && { failure }),
  };
}

export function createPublicationCatalogue(
  deps: PublicationCatalogueDeps,
): PublicationCatalogue {
  /**
   * Walks the platform and replaces the cache with what it answered, giving
   * back the reason it could not when it could not.
   *
   * Split out of `refresh` because a lookup needs the renewal and not the page:
   * reading a listing only to discard it would resolve a page of thumbnail
   * addresses nobody asked for, against a store that may be a network away.
   */
  async function renew(now: Date): Promise<string | undefined> {
    const walked = await walk(deps);

    if (!walked.ok) {
      // What was cached before stays cached and stays on screen: a platform
      // that answered badly says nothing about publications already listed.
      return walked.reason;
    }

    const stored = await deps.cache.thumbnailKeys();
    const publications: CachedPublication[] = [];

    for (const entry of walked.entries) {
      // A copy the store still HOLDS is reused untouched: re-downloading would
      // spend bandwidth for identical bytes, and would let a source URL that
      // has since expired replace a good copy with nothing (REQ-071). A copy
      // the store does not hold is made again, which is the whole of REQ-118
      // and what lets a cache filled under another binding heal itself on the
      // next refresh, with no migration and nothing for the operator to do.
      const key =
        (await reusableCopy(deps, stored.get(entry.id))) ??
        (await copyThumbnail(deps, entry));

      publications.push({
        id: entry.id,
        ...(entry.caption !== undefined && { caption: entry.caption }),
        mediaType: entry.mediaType,
        publishedAt: entry.publishedAt,
        ...(key !== undefined && { thumbnailKey: key }),
      });
    }

    await deps.cache.replace(publications, now);

    return undefined;
  }

  async function refresh(
    now: Date,
    page?: Partial<PublicationPageQuery>,
  ): Promise<PublicationListing> {
    const query = pageQuery(deps, page);
    const failure = await renew(now);

    return failure === undefined
      ? readListing(deps, query, "platform")
      : readListing(deps, query, "cache", failure);
  }

  return {
    refresh,

    async syncIds(now) {
      const failure = await renew(now);
      if (failure !== undefined) return { ok: false, reason: failure };
      return { ok: true, ids: await deps.cache.ids() };
    },

    async byIds(now: Date, ids: readonly string[]): Promise<PublicationLookup> {
      // Deduplicated because several automations legitimately watch the same
      // publication, and one identifier is one row however many asked for it.
      const wanted = [...new Set(ids)];

      if (wanted.length === 0) {
        // A listing whose automations all watch the whole account asks for
        // nothing, and nothing is what it costs.
        return { items: [] };
      }

      let failure: string | undefined;

      if ((await deps.cache.count()) === 0) {
        // The same rule an opening follows, and the same one REQ-070 wrote: an
        // EMPTY cache is the one state that may consult the platform. An
        // identifier the cache does not hold never does, and that restraint is
        // deliberate: this runs every time the operator opens their automations,
        // so a publication that was deleted would spend a request on every
        // opening, forever, to be told again that it is gone.
        try {
          failure = await renew(now);
        } catch (error) {
          // REQ-072: what could not be looked up costs the pictures and nothing
          // else. The screen answers with whatever is cached, and carries the
          // reason beside it instead of failing.
          failure = describeThrown(error);
        }
      }

      const found = await deps.cache.byIds(wanted);
      const items = await Promise.all(
        found.map((publication) => entryOf(deps, publication)),
      );

      return { items, ...(failure !== undefined && { failure }) };
    },

    async open(
      now: Date,
      page?: Partial<PublicationPageQuery>,
    ): Promise<PublicationListing> {
      const cached = await deps.cache.count();

      if (cached > 0) {
        // The whole of REQ-070 is this branch: an opening reads storage and
        // sends nothing, however many times the operator opens the screen.
        return readListing(deps, pageQuery(deps, page), "cache");
      }

      return refresh(now, page);
    },
  };
}

/**
 * The real download. Never exercised by the fast suite, by design: what it adds
 * over the injected double is `fetch`, and a test of `fetch` is a test of Node.
 */
export function createFetchThumbnailDownload(): ThumbnailDownload {
  return async (url: string): Promise<ThumbnailBody> => {
    let response: Response;
    try {
      response = await fetch(url);
    } catch {
      throw new ThumbnailDownloadError();
    }

    if (!response.ok) {
      // An expired URL answers here, and this is the throw the copy path
      // catches: the publication lists without a picture rather than not at all.
      throw new ThumbnailDownloadError(response.status);
    }

    try {
      return {
        bytes: new Uint8Array(await response.arrayBuffer()),
        contentType:
          response.headers.get("content-type") ?? "application/octet-stream",
      };
    } catch {
      throw new ThumbnailDownloadError();
    }
  };
}

/**
 * A deliberately sparse report from the external image download.
 *
 * The source URL is a signed, temporary address and must never cross this
 * boundary into a log. Its status is enough to distinguish an expired or
 * refused CDN response from a connection failure.
 */
class ThumbnailDownloadError extends Error {
  constructor(readonly status?: number) {
    super("thumbnail download failed");
  }
}
