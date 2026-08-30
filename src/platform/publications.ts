import type { PlatformRequest } from "./transport.js";

/**
 * The media edge of the account, as everything that walks it reads it.
 *
 * What lives here is the SHARED vocabulary of that walk: where it goes, how
 * many rows a page asks for, how far it is allowed to follow the cursor, and
 * how the two failures it can meet are put into one line an operator can act
 * on. The walk itself belongs to `publications-cache.ts`, which is the only
 * caller today.
 *
 * Until phase 3l this module also resolved a publication URL into a publication
 * id, before an automation was stored (REQ-064, REQ-130). REQ-260 took the URL
 * out of the product: a target is an identifier now, the grid is what names a
 * publication, and with the URL went the shortcode parsing, the per-write walk
 * of this edge and the four refusals it could answer with. The constants below
 * survive it because the LISTING was always the other caller.
 *
 * No transport is created here and no credential is read: the caller injects
 * both, so the fast suite touches neither (ADR-017).
 */

/**
 * Media edge of the authenticated account. Exported because the listing walks
 * it (REQ-069): two spellings of one path is how a correction lands in one
 * caller and not the other.
 */
export const MEDIA_PATH = "/me/media";

/** How many media one request asks for. */
export const MEDIA_PAGE_SIZE = 50;

/**
 * How many pages of `/me/media` a single walk follows.
 *
 * Bounded because the loop is driven by `paging.next`, a value that comes from
 * someone else's API: a cycle, or a cursor that never empties, would hang the
 * caller forever while spending the account's request budget. A bound turns
 * that into a refusal the operator can read and act on. Twenty pages of fifty
 * is a thousand publications, far past what any account browses in one screen.
 */
export const PUBLICATION_PAGE_LIMIT = 20;

/** One answer of the media edge, read defensively: it is someone else's API. */
export interface MediaPage {
  readonly data?: unknown;
  readonly paging?: { readonly next?: unknown } | null;
}

/** The `paging.next` cursor as a request, or undefined when there is no more. */
export function nextPageRequest(page: MediaPage): PlatformRequest | undefined {
  const next = page.paging?.next;
  if (typeof next !== "string") {
    return undefined;
  }

  let parsed: URL;
  try {
    parsed = new URL(next);
  } catch {
    // A cursor nobody can parse ends the walk instead of throwing: the caller
    // then refuses the read, which is recoverable, rather than crashing it.
    return undefined;
  }

  return {
    method: "GET",
    host: parsed.host,
    path: parsed.pathname,
    query: Object.fromEntries(parsed.searchParams),
  };
}

/** What the platform refused with, in one line an operator can act on. */
export function describeResponseError(response: {
  status: number;
  body: unknown;
}): string {
  const message = (response.body as { error?: { message?: unknown } } | null)
    ?.error?.message;
  return typeof message === "string"
    ? `${String(response.status)}: ${message}`
    : String(response.status);
}

/** A thrown failure as text: a refused connection has no status to report. */
export function describeThrown(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
