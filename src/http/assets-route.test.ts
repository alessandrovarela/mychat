import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { assetCapabilityUrl, createDiskAssets } from "../storage/assets.js";
import {
  createDiskThumbnails,
  thumbnailKeyFor,
} from "../storage/publication-cache.js";
import { ASSETS_ROUTE_PREFIX, registerAssetsRoute } from "./assets-route.js";
import {
  THUMBNAILS_ROUTE_PREFIX,
  registerThumbnailsRoute,
} from "./thumbnails-route.js";

/**
 * Proves REQ-094: what the disk adapter promises to the contact is what this
 * route delivers, a resource that is not there answers 404, and no response
 * carries a path from the file system.
 *
 * And REQ-109 for the route beside it, which serves the publication
 * thumbnails. The two share one implementation (`file-route.ts`), so the
 * containment check that keeps a public wildcard inside its directory is
 * exercised twice here, once through each address.
 *
 * The address under test is never typed by hand. Every request goes to the
 * pathname of a URL the adapter itself produced, which is the only way the test
 * fails when the two drift apart, instead of agreeing with a copy of the route.
 *
 * Through `app.inject()`: no port is bound, so the fast suite stays fast.
 */

const PUBLIC_ORIGIN = "https://tunnel.example";
const PDF_BYTES = "%PDF-1.4 anchor";
const CAPABILITY_SECRET = "asset-route-test-secret";

describe("REQ-094: the public resource route", () => {
  let parent: string;
  let directory: string;
  let app: FastifyInstance;

  /** The pathname of the URL the adapter builds, nothing hand written. */
  async function addressOf(name: string): Promise<string> {
    const assets = createDiskAssets({
      dir: directory,
      publicBaseUrl: `${PUBLIC_ORIGIN}${ASSETS_ROUTE_PREFIX}`,
      assetCapabilitySecret: CAPABILITY_SECRET,
    });

    const url = new URL(await assets.publicUrl(name));
    return `${url.pathname}${url.search}`;
  }

  beforeEach(() => {
    parent = mkdtempSync(join(tmpdir(), "mychat-route-"));
    directory = join(parent, "assets");
    mkdirSync(directory);

    app = Fastify({ logger: false });
    registerAssetsRoute(app, { dir: directory, secret: CAPABILITY_SECRET });
  });

  afterEach(async () => {
    await app.close();
    rmSync(parent, { recursive: true, force: true });
  });

  it("serves the resource at the address the disk adapter builds", async () => {
    writeFileSync(join(directory, "guide.pdf"), PDF_BYTES);

    const address = await addressOf("guide.pdf");
    const response = await app.inject({ method: "GET", url: address });

    // The adapter and the route agree on the prefix, so the contact's link
    // lands here and not on a 404 the operator would only see in the wild.
    expect(address).toMatch(
      new RegExp(`^${ASSETS_ROUTE_PREFIX}/guide\\.pdf\\?cap=`),
    );
    expect(response.statusCode).toBe(200);
    expect(response.body).toBe(PDF_BYTES);
    // A PDF announced as text is opened as gibberish by the platform.
    expect(response.headers["content-type"]).toBe("application/pdf");
  });

  it("serves a name the adapter had to percent-encode", async () => {
    writeFileSync(join(directory, "guia da semana.pdf"), PDF_BYTES);

    const address = await addressOf("guia da semana.pdf");
    const response = await app.inject({ method: "GET", url: address });

    // `encodeURIComponent` is what put the %20 there. Decoding it once, and
    // exactly once, is the difference between a working link and a 404 on
    // every resource whose name has a space, which most uploads do.
    expect(address).toContain("%20");
    expect(response.statusCode).toBe(200);
    expect(response.body).toBe(PDF_BYTES);
  });

  it("falls back to a neutral content type for an unknown extension", async () => {
    writeFileSync(join(directory, "bonus.unknown"), PDF_BYTES);

    const response = await app.inject({
      method: "GET",
      url: await addressOf("bonus.unknown"),
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBe("application/octet-stream");
    // Guessing is left to nobody: an upload with a wrong extension must not get
    // to decide how the browser interprets it.
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
  });

  it("answers 404 for a resource that does not exist", async () => {
    const response = await app.inject({
      method: "GET",
      url: `${ASSETS_ROUTE_PREFIX}/never-uploaded.pdf`,
    });

    expect(response.statusCode).toBe(404);
    expect(response.body).toBe("");
  });

  it("rejects a missing or altered capability without revealing the object", async () => {
    writeFileSync(join(directory, "guide.pdf"), PDF_BYTES);
    const valid = await addressOf("guide.pdf");
    const alteredUrl = new URL(`${PUBLIC_ORIGIN}${valid}`);
    alteredUrl.searchParams.set("cap", "x");
    const altered = `${alteredUrl.pathname}${alteredUrl.search}`;

    for (const url of [
      `${ASSETS_ROUTE_PREFIX}/guide.pdf`,
      altered,
      assetCapabilityUrl(
        `${PUBLIC_ORIGIN}${ASSETS_ROUTE_PREFIX}`,
        "other.pdf",
        CAPABILITY_SECRET,
      ),
    ]) {
      const response = await app.inject({ method: "GET", url });
      expect(response.statusCode).toBe(404);
      expect(response.body).toBe("");
    }
  });

  it("answers 404 for a name that tries to escape the directory", async () => {
    // The file EXISTS, one level up. Anything other than 404 here is a read of
    // the host file system through a link we hand to strangers.
    writeFileSync(join(parent, "secret.txt"), "not for the internet");

    // The separator is what is encoded, never a whole dot segment: a segment
    // that IS `..` (or its `%2e%2e` spelling) gets collapsed by the client
    // before the request leaves, so those never reach a handler. These do.
    const escapes = [
      "..%2Fsecret.txt",
      "..%2f..%2fetc%2fpasswd",
      "%2Fetc%2Fpasswd",
      "%2e%2e%2fsecret.txt",
      "nested/secret.txt",
      ".",
      "",
    ];

    for (const attempt of escapes) {
      const response = await app.inject({
        method: "GET",
        url: `${ASSETS_ROUTE_PREFIX}/${attempt}`,
      });

      // 404 and not 403: telling apart "does not exist" from "exists but
      // refused" turns the route into a probe of the host file system.
      expect(response.statusCode, attempt).toBe(404);
      expect(response.body, attempt).toBe("");
    }
  });

  it("reveals no file system path in any response", async () => {
    writeFileSync(join(directory, "guide.pdf"), PDF_BYTES);

    const responses = await Promise.all(
      [
        `${ASSETS_ROUTE_PREFIX}/missing.pdf`,
        `${ASSETS_ROUTE_PREFIX}/..%2Fsecret.txt`,
        `${ASSETS_ROUTE_PREFIX}/../../etc/passwd`,
        `${ASSETS_ROUTE_PREFIX}/`,
      ].map((url) => app.inject({ method: "GET", url })),
    );

    for (const response of responses) {
      expect(response.statusCode).toBe(404);
      // Where the files live on the host is not the fetcher's business, and an
      // error page that names the directory is how that gets published.
      expect(response.body).not.toContain(directory);
      expect(response.body).not.toContain(parent);
      expect(response.body).not.toContain(tmpdir());
    }
  });

  it("treats a missing directory as an empty catalogue, not a crash", async () => {
    // A fresh clone has no dev-data/assets. The route must answer 404 there,
    // for the same reason createDiskAssets().list() returns an empty list.
    const orphan = Fastify({ logger: false });
    registerAssetsRoute(orphan, {
      dir: join(parent, "not-created"),
      secret: CAPABILITY_SECRET,
    });

    const response = await orphan.inject({
      method: "GET",
      url: `${ASSETS_ROUTE_PREFIX}/guide.pdf`,
    });

    expect(response.statusCode).toBe(404);
    await orphan.close();
  });

  it("does not serve a directory as if it were a resource", async () => {
    mkdirSync(join(directory, "nested"));

    const response = await app.inject({
      method: "GET",
      url: `${ASSETS_ROUTE_PREFIX}/nested`,
    });

    // A listing is information this route has no business giving out, and the
    // adapter does not list directories as resources either.
    expect(response.statusCode).toBe(404);
  });
});

describe("REQ-433: private S3 asset capability route", () => {
  let app: FastifyInstance;
  const temporaryUrl = "https://r2.example/assets/guide.pdf?temporary=1";

  beforeEach(() => {
    app = Fastify({ logger: false });
    registerAssetsRoute(app, {
      secret: CAPABILITY_SECRET,
      temporaryUrl: async (name) => {
        if (name !== "guide.pdf") {
          throw new Error("missing");
        }
        return temporaryUrl;
      },
    });
  });

  afterEach(async () => {
    await app.close();
  });

  it("redirects one valid MyChat capability to a freshly issued provider URL", async () => {
    const url = new URL(
      assetCapabilityUrl(
        `${PUBLIC_ORIGIN}${ASSETS_ROUTE_PREFIX}`,
        "guide.pdf",
        CAPABILITY_SECRET,
      ),
    );

    const response = await app.inject({
      method: "GET",
      url: `${url.pathname}${url.search}`,
    });

    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe(temporaryUrl);
  });

  it("makes a deleted object indistinguishable from a bad capability", async () => {
    const deleted = new URL(
      assetCapabilityUrl(
        `${PUBLIC_ORIGIN}${ASSETS_ROUTE_PREFIX}`,
        "deleted.pdf",
        CAPABILITY_SECRET,
      ),
    );

    for (const url of [
      `${ASSETS_ROUTE_PREFIX}/guide.pdf`,
      `${deleted.pathname}${deleted.search}`,
    ]) {
      const response = await app.inject({ method: "GET", url });
      expect(response.statusCode).toBe(404);
      expect(response.body).toBe("");
    }
  });
});

/**
 * REQ-109: the address the publication listing hands out is one a browser can
 * open, and this route is what answers there.
 *
 * The grid had thirteen publications of a real account and not one picture,
 * because the binding in force produced `memory://bucket/thumbs/<id>.jpg`. No
 * browser resolves that scheme, so every cell rendered its alternative text
 * while every test about the listing passed. What follows is the other half:
 * the copy on disk, at the address the binding builds, over HTTP.
 */
describe("REQ-109: the publication thumbnails route", () => {
  const PUBLICATION_ID = "18153371755481491";
  const PIXELS = "JPEG-bytes-of-a-thumbnail";

  let parent: string;
  let directory: string;
  let app: FastifyInstance;

  /** The pathname of the URL the binding builds, nothing hand written. */
  async function addressOf(key: string): Promise<string> {
    const thumbnails = createDiskThumbnails({
      dir: directory,
      // The bucket root, which for this binding is the process's own origin:
      // the key carries the `thumbs/` prefix the route answers at.
      publicBaseUrl: PUBLIC_ORIGIN,
    });

    return new URL(await thumbnails.publicUrl(key)).pathname;
  }

  beforeEach(() => {
    parent = mkdtempSync(join(tmpdir(), "mychat-thumbs-"));
    directory = join(parent, "thumbs");
    mkdirSync(directory);

    app = Fastify({ logger: false });
    registerThumbnailsRoute(app, { dir: directory });
  });

  afterEach(async () => {
    await app.close();
    rmSync(parent, { recursive: true, force: true });
  });

  it("serves the picture at the address the listing hands out", async () => {
    const key = thumbnailKeyFor(PUBLICATION_ID, "image/jpeg");
    writeFileSync(join(directory, `${PUBLICATION_ID}.jpg`), PIXELS);

    const address = await addressOf(key);
    const response = await app.inject({ method: "GET", url: address });

    // The key's prefix IS the route's prefix, by construction on both sides.
    expect(address).toBe(`${THUMBNAILS_ROUTE_PREFIX}/${PUBLICATION_ID}.jpg`);
    expect(response.statusCode).toBe(200);
    expect(response.body).toBe(PIXELS);
    // A picture announced as an octet stream is a broken cell in the grid.
    expect(response.headers["content-type"]).toBe("image/jpeg");
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
  });

  it("answers 404 when the copy is not on disk", async () => {
    const response = await app.inject({
      method: "GET",
      url: `${THUMBNAILS_ROUTE_PREFIX}/${PUBLICATION_ID}.jpg`,
    });

    expect(response.statusCode).toBe(404);
    expect(response.body).toBe("");
  });

  it("answers 404 for a name that tries to escape the directory", async () => {
    // The file EXISTS, one level up. Anything other than 404 here is a read of
    // the host file system through an address this route hands to strangers.
    writeFileSync(join(parent, "secret.jpg"), "not for the internet");

    const escapes = [
      "..%2Fsecret.jpg",
      "..%2f..%2fetc%2fpasswd",
      "%2Fetc%2Fpasswd",
      "%2e%2e%2fsecret.jpg",
      "nested/secret.jpg",
      ".",
      "",
    ];

    for (const attempt of escapes) {
      const response = await app.inject({
        method: "GET",
        url: `${THUMBNAILS_ROUTE_PREFIX}/${attempt}`,
      });

      // 404 and not 403: telling apart "does not exist" from "exists but
      // refused" turns the route into a probe of the host file system.
      expect(response.statusCode, attempt).toBe(404);
      expect(response.body, attempt).toBe("");
      expect(response.body, attempt).not.toContain("not for the internet");
    }
  });

  it("reveals no file system path in any response", async () => {
    const responses = await Promise.all(
      [
        `${THUMBNAILS_ROUTE_PREFIX}/${PUBLICATION_ID}.jpg`,
        `${THUMBNAILS_ROUTE_PREFIX}/..%2Fsecret.jpg`,
        `${THUMBNAILS_ROUTE_PREFIX}/`,
      ].map((url) => app.inject({ method: "GET", url })),
    );

    for (const response of responses) {
      expect(response.statusCode).toBe(404);
      expect(response.body).not.toContain(directory);
      expect(response.body).not.toContain(parent);
      expect(response.body).not.toContain(tmpdir());
    }
  });

  it("treats a directory that was never created as empty, not as a crash", async () => {
    // Nothing has been cached yet, so nothing created the directory. The route
    // has to answer 404 there instead of taking the process down.
    const orphan = Fastify({ logger: false });
    registerThumbnailsRoute(orphan, { dir: join(parent, "not-created") });

    const response = await orphan.inject({
      method: "GET",
      url: `${THUMBNAILS_ROUTE_PREFIX}/${PUBLICATION_ID}.jpg`,
    });

    expect(response.statusCode).toBe(404);
    await orphan.close();
  });
});
