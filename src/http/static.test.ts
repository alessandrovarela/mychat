import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import viteConfig from "../../vite.config.js";
import { ASSETS_ROUTE_PREFIX } from "./assets-route.js";
import {
  RESERVED_PREFIXES,
  WEB_DIST_DIR,
  registerStaticRoute,
} from "./static.js";

/**
 * Proves REQ-105: the interface is served by the same process, out of the files
 * the build produced, and nothing about that catch-all touches the routes that
 * belong to someone else.
 *
 * The second half is the one that fails silently in production. The platform
 * calls `/webhook` with no session of ours and expects the webhook's answer; a
 * page returned there stops every delivery with no error on our side, which is
 * why the KEEL forbids ANY layer in front of it. A single page application's
 * fallback is a layer in front of everything by construction, so it is checked
 * here against a router where the webhook route is absent, present, and
 * registered for another method.
 *
 * Through `app.inject()`: no port is bound, so the fast suite stays fast.
 */

const INDEX_MARKER = '<div id="root"></div>';
const BUNDLE = "app/index-d34db33f.js";
const BUNDLE_MARKER = "export const built = true;";
const WEBHOOK_ANSWER = "challenge-echoed";

describe("REQ-105: the interface served from the build output", () => {
  let parent: string;
  let directory: string;
  let app: FastifyInstance;

  /** Writes what `vite build` writes: an entry document and a hashed bundle. */
  function build(): void {
    writeFileSync(join(directory, "index.html"), INDEX_MARKER);
    mkdirSync(join(directory, dirname(BUNDLE)), { recursive: true });
    writeFileSync(join(directory, BUNDLE), BUNDLE_MARKER);
  }

  beforeEach(() => {
    // The build output sits INSIDE a temporary parent, so a test can write a
    // file beside it and prove that no address reaches out of the output.
    parent = mkdtempSync(join(tmpdir(), "mychat-web-"));
    directory = join(parent, "web");
    mkdirSync(directory);
    app = Fastify({ logger: false });
  });

  afterEach(async () => {
    await app.close();
    rmSync(parent, { recursive: true, force: true });
  });

  describe("what the build produced", () => {
    beforeEach(() => {
      build();
      registerStaticRoute(app, { dir: directory });
    });

    it("serves the entry document at the root of the site", async () => {
      const response = await app.inject({ method: "GET", url: "/" });

      expect(response.statusCode).toBe(200);
      expect(response.headers["content-type"]).toContain("text/html");
      expect(response.body).toBe(INDEX_MARKER);
    });

    it("serves the hashed bundle the document points at", async () => {
      const response = await app.inject({ method: "GET", url: `/${BUNDLE}` });

      expect(response.statusCode).toBe(200);
      expect(response.body).toBe(BUNDLE_MARKER);
      expect(response.headers["content-type"]).toContain("javascript");
    });

    it("answers a deep link with the same document", async () => {
      // No file behind `/flows/new`: the application resolves the address once
      // it loads, which is the whole point of the fallback.
      const response = await app.inject({ method: "GET", url: "/flows/new" });

      expect(response.statusCode).toBe(200);
      expect(response.body).toBe(INDEX_MARKER);
    });

    it("refuses an address that climbs out of the build output", async () => {
      writeFileSync(join(parent, "outside.txt"), "secret");

      // Percent-encoded, because the wildcard arrives decoded: this is the
      // shape that survives the router and reaches the handler as `../`.
      const response = await app.inject({
        method: "GET",
        url: "/%2e%2e%2foutside.txt",
      });

      expect(response.body).not.toContain("secret");
      expect(response.body).toBe(INDEX_MARKER);
    });
  });

  describe("the routes it must never answer for", () => {
    beforeEach(() => {
      build();
    });

    it("leaves the public webhook alone when no webhook route exists", async () => {
      // The case Fastify's router cannot cover: with nothing registered at
      // `/webhook`, the catch-all is the only match, and answering it with the
      // interface is what silently kills every delivery.
      registerStaticRoute(app, { dir: directory });

      const response = await app.inject({ method: "GET", url: "/webhook" });

      expect(response.statusCode).toBe(404);
      expect(response.body).not.toContain(INDEX_MARKER);
    });

    it("does not shadow the webhook route that is registered", async () => {
      app.get("/webhook", async () => WEBHOOK_ANSWER);
      registerStaticRoute(app, { dir: directory });

      const response = await app.inject({ method: "GET", url: "/webhook" });

      expect(response.statusCode).toBe(200);
      expect(response.body).toBe(WEBHOOK_ANSWER);
    });

    it("does not answer the webhook's delivery method", async () => {
      app.post("/webhook", async () => WEBHOOK_ANSWER);
      registerStaticRoute(app, { dir: directory });

      const response = await app.inject({ method: "POST", url: "/webhook" });

      expect(response.body).toBe(WEBHOOK_ANSWER);
    });

    it("leaves an unknown address under the contract as a miss", async () => {
      // A mistyped `/api/*` must stay a 404 for the caller that reads JSON, not
      // become a 200 carrying a page.
      registerStaticRoute(app, { dir: directory });

      const response = await app.inject({ method: "GET", url: "/api/flows" });

      expect(response.statusCode).toBe(404);
      expect(response.body).not.toContain(INDEX_MARKER);
    });

    it("leaves a contract route called with the wrong method as a miss", async () => {
      app.post("/api/flows", async () => ({ ok: true }));
      registerStaticRoute(app, { dir: directory });

      const response = await app.inject({ method: "GET", url: "/api/flows" });

      expect(response.statusCode).toBe(404);
      expect(response.body).not.toContain(INDEX_MARKER);
    });

    it("leaves the public resource prefix to the resource route", async () => {
      // The platform fetches these URLs itself. A page returned instead of a
      // file is a broken delivery to a contact, with nothing to explain it.
      registerStaticRoute(app, { dir: directory });

      const response = await app.inject({
        method: "GET",
        url: `${ASSETS_ROUTE_PREFIX}/guide.pdf`,
      });

      expect(response.statusCode).toBe(404);
      expect(response.body).not.toContain(INDEX_MARKER);
    });

    it("reserves every prefix it declares, and the webhook among them", async () => {
      registerStaticRoute(app, { dir: directory });

      for (const prefix of RESERVED_PREFIXES) {
        const response = await app.inject({
          method: "GET",
          url: `${prefix}/unclaimed`,
        });

        expect(response.body).not.toContain(INDEX_MARKER);
      }

      expect(RESERVED_PREFIXES).toContain("/webhook");
    });
  });

  describe("before the build has run", () => {
    it("starts and answers 404, instead of refusing to boot", async () => {
      // A fresh clone has no `dist/web`. The webhook has to work there anyway,
      // so nothing in this route may throw while the process is composed.
      registerStaticRoute(app, { dir: join(directory, "never-built") });
      app.get("/webhook", async () => WEBHOOK_ANSWER);

      const page = await app.inject({ method: "GET", url: "/" });
      const webhook = await app.inject({ method: "GET", url: "/webhook" });

      expect(page.statusCode).toBe(404);
      expect(webhook.body).toBe(WEBHOOK_ANSWER);
    });
  });

  describe("the address the build writes to", () => {
    it("is the directory this route reads", async () => {
      // Never typed twice: the route's default is compared with what the build
      // configuration declares, so moving the output moves both or fails here.
      const configRoot = fileURLToPath(new URL("../..", import.meta.url));
      const outDir = viteConfig.build?.outDir;

      expect(outDir).toBeTypeOf("string");
      expect(resolve(configRoot, String(outDir))).toBe(WEB_DIST_DIR);
    });

    it("keeps the bundle's own files out of the resource prefix", async () => {
      // Vite's default asset directory is `assets/`, which is the public
      // resource route's prefix: with the default, every script of the
      // interface would answer 404 while the build looked perfect.
      const assetsDir = viteConfig.build?.assetsDir;

      expect(assetsDir).toBeTypeOf("string");
      expect(`/${String(assetsDir)}`).not.toBe(ASSETS_ROUTE_PREFIX);
      expect(RESERVED_PREFIXES).not.toContain(`/${String(assetsDir)}`);
    });
  });
});
