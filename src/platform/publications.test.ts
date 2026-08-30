import { describe, expect, it } from "vitest";
import {
  describeResponseError,
  describeThrown,
  nextPageRequest,
} from "./publications.js";

/**
 * What is left of this module after REQ-260, and why it is still tested here.
 *
 * The write-time resolution of a publication URL used to live in it, with a
 * block of its own proving that the four spellings a person copies all name the
 * same post. The URL left the product: a trigger target is an identifier, so
 * there is nothing to resolve and nothing that could be resolved wrong.
 *
 * What survives is the vocabulary of the media-edge walk, and the part of it
 * worth a unit test is the DEFENSIVE reading: `paging.next` comes from someone
 * else's API, and the walk that follows it is driven by whatever it says. The
 * listing itself is proved end to end in `publications-cache.test.ts`.
 */

describe("REQ-069: the cursor is followed as the platform wrote it", () => {
  it("carries the host, the path and every parameter across", () => {
    // Rebuilt by hand, a cursor loses the parameters that make it a cursor and
    // the walk starts over from page one, forever.
    expect(
      nextPageRequest({
        paging: {
          next: "https://graph.instagram.com/v21.0/me/media?after=xyz",
        },
      }),
    ).toEqual({
      method: "GET",
      host: "graph.instagram.com",
      path: "/v21.0/me/media",
      query: { after: "xyz" },
    });
  });

  it("ends the walk when there is no cursor at all", () => {
    expect(nextPageRequest({ data: [] })).toBeUndefined();
    expect(nextPageRequest({ paging: null })).toBeUndefined();
    expect(nextPageRequest({ paging: { next: 42 } })).toBeUndefined();
  });

  it("ends the walk on a cursor nobody can parse, instead of throwing", () => {
    // The caller then refuses the read, which is recoverable. A throw here
    // would take down a screen because somebody else's API answered oddly.
    expect(nextPageRequest({ paging: { next: "not a URL" } })).toBeUndefined();
  });
});

describe("REQ-072: a failure is reported in one line an operator can act on", () => {
  it("quotes the platform's own message beside the status", () => {
    expect(
      describeResponseError({
        status: 500,
        body: { error: { message: "internal" } },
      }),
    ).toBe("500: internal");
  });

  it("falls back to the status when the body says nothing readable", () => {
    expect(describeResponseError({ status: 502, body: "<html>" })).toBe("502");
    expect(describeResponseError({ status: 400, body: null })).toBe("400");
  });

  it("reads a thrown failure, which has no status to report", () => {
    expect(describeThrown(new Error("getaddrinfo ENOTFOUND"))).toContain(
      "ENOTFOUND",
    );
    expect(describeThrown("plain")).toBe("plain");
  });
});
