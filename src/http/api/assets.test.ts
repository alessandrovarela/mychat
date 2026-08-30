import {
  existsSync,
  mkdtempSync,
  readFileSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createOperatorCredentialStore,
  setOperatorPassword,
} from "../../auth/credential.js";
import { SESSION_COOKIE_NAME } from "../../auth/session.js";
import { createApp } from "../../app.js";
import type { App } from "../../app.js";
import { ASSETS_ROUTE_PREFIX } from "../assets-route.js";
import { ASSETS_API_ROUTE } from "./assets.js";
import { openDatabase } from "../../storage/database.js";
import type { DatabaseHandle } from "../../storage/database.js";
import { automationAggregates } from "../../storage/schema.js";
import { ASSET_CONTENT_TYPES, MAX_ASSET_BYTES } from "../../storage/assets.js";

const APP_SECRET = "app-secret";
const VERIFY_TOKEN = "verify-me";
const PASSWORD = "operator-password";
const NOW = new Date("2026-08-06T12:00:00.000Z");

const apps: App[] = [];
const handles: DatabaseHandle[] = [];
const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "mychat-api-assets-"));
  dirs.push(dir);
  return dir;
}

async function boot(withAsset = false): Promise<{
  app: App;
  dir: string;
  cookie: string;
  /** A second connection to the same file, for the rows a test seeds itself. */
  handle: DatabaseHandle;
}> {
  const dir = tempDir();
  if (withAsset) {
    mkdirSync(join(dir, "assets"), { recursive: true });
    writeFileSync(join(dir, "assets", "existing.pdf"), "%PDF-1.4 existing");
  }

  const app = await createApp(
    {
      META_APP_SECRET: APP_SECRET,
      WEBHOOK_VERIFY_TOKEN: VERIFY_TOKEN,
      DATABASE_PATH: join(dir, "mychat.db"),
      ASSETS_DIR: join(dir, "assets"),
      THUMBNAILS_DIR: join(dir, "thumbs"),
      SWEEP_INTERVAL_MS: "60000",
    },
    { clock: { now: (): Date => NOW } },
  );
  apps.push(app);

  const handle = openDatabase({ databasePath: join(dir, "mychat.db") });
  handles.push(handle);
  await setOperatorPassword(
    PASSWORD,
    createOperatorCredentialStore(handle.db),
    NOW,
  );

  const opened = await app.server.inject({
    method: "POST",
    url: "/api/session",
    headers: { "content-type": "application/json" },
    payload: JSON.stringify({ password: PASSWORD }),
  });
  expect(opened.statusCode).toBe(200);
  const session = opened.cookies.find(
    (cookie) => cookie.name === SESSION_COOKIE_NAME,
  );
  expect(session).toBeDefined();

  return {
    app,
    dir,
    handle,
    cookie: `${SESSION_COOKIE_NAME}=${String(session?.value)}`,
  };
}

function encoded(value: string): string {
  return Buffer.from(value, "utf8").toString("base64");
}

afterEach(async () => {
  for (const app of apps.splice(0)) {
    await app.close();
  }
  for (const handle of handles.splice(0)) {
    handle.close();
  }
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("REQ-047: the private asset catalogue API", () => {
  it("requires a session before listing or writing", async () => {
    const reader = await boot(true);

    const listed = await reader.app.server.inject({
      method: "GET",
      url: ASSETS_API_ROUTE,
    });
    expect(listed.statusCode).toBe(401);

    const uploaded = await reader.app.server.inject({
      method: "POST",
      url: ASSETS_API_ROUTE,
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({
        name: "blocked.txt",
        contentType: "text/plain",
        data: encoded("must not write"),
      }),
    });
    expect(uploaded.statusCode).toBe(401);
    expect(existsSync(join(reader.dir, "assets", "blocked.txt"))).toBe(false);
  });

  it("lists names and public URLs from the active binding", async () => {
    const reader = await boot(true);

    const response = await reader.app.server.inject({
      method: "GET",
      url: ASSETS_API_ROUTE,
      headers: { cookie: reader.cookie },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      assets: [
        {
          name: "existing.pdf",
          // A file that was in the directory before keys were minted keeps the
          // identity it has, and shows the name it has (REQ-292).
          fileName: "existing.pdf",
          publicUrl: expect.stringContaining(
            `${reader.app.config.publicOrigin}${ASSETS_ROUTE_PREFIX}/existing.pdf?cap=`,
          ),
        },
      ],
      upload: {
        contentTypes: ASSET_CONTENT_TYPES,
        maxBytes: MAX_ASSET_BYTES,
      },
    });
  });

  it("uploads a card image through the same catalogue", async () => {
    const reader = await boot();
    // PNG, not WebP: the catalogue takes what the platform will carry, and
    // nothing wider (REQ-231). A WebP is refused right here, at the upload.
    const body = {
      name: "cover.png",
      contentType: "image/png",
      data: Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("base64"),
    };

    const uploaded = await reader.app.server.inject({
      method: "POST",
      url: ASSETS_API_ROUTE,
      headers: { cookie: reader.cookie, "content-type": "application/json" },
      payload: JSON.stringify(body),
    });

    expect(uploaded.statusCode).toBe(200);
    const stored = uploaded.json().asset;
    expect(stored.fileName).toBe(body.name);
    expect(
      Uint8Array.from(readFileSync(join(reader.dir, "assets", stored.name))),
    ).toEqual(new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
  });

  it("uploads a PDF through the same catalogue and keeps the public route open", async () => {
    const reader = await boot();
    const body = {
      name: "guide.pdf",
      contentType: "application/pdf",
      data: encoded("%PDF-1.4 uploaded"),
    };

    const uploaded = await reader.app.server.inject({
      method: "POST",
      url: ASSETS_API_ROUTE,
      headers: { cookie: reader.cookie, "content-type": "application/json" },
      payload: JSON.stringify(body),
    });

    expect(uploaded.statusCode).toBe(200);
    const key: string = uploaded.json().asset.name;
    expect(uploaded.json()).toEqual({
      asset: {
        name: key,
        fileName: body.name,
        publicUrl: expect.stringContaining(
          `${reader.app.config.publicOrigin}${ASSETS_ROUTE_PREFIX}/${key}?cap=`,
        ),
      },
    });
    // The extension stays last in the minted key, because it is what the public
    // route types the answer by: `application/pdf` below is that, asserted.
    expect(key).toMatch(/^guide~[0-9a-f]{8}\.pdf$/);
    expect(readFileSync(join(reader.dir, "assets", key), "utf8")).toBe(
      "%PDF-1.4 uploaded",
    );

    const publicRead = await reader.app.server.inject({
      method: "GET",
      url:
        new URL(uploaded.json().asset.publicUrl).pathname +
        new URL(uploaded.json().asset.publicUrl).search,
    });
    expect(publicRead.statusCode).toBe(200);
    expect(publicRead.body).toBe("%PDF-1.4 uploaded");
    expect(publicRead.headers["content-type"]).toBe("application/pdf");
  });

  it("makes the same file name twice into two resources, neither one replaced", async () => {
    const reader = await boot();
    const first = {
      name: "note.pdf",
      contentType: "application/pdf",
      data: encoded("original"),
    };
    const second = { ...first, data: encoded("the second file") };

    const firstResponse = await reader.app.server.inject({
      method: "POST",
      url: ASSETS_API_ROUTE,
      headers: { cookie: reader.cookie, "content-type": "application/json" },
      payload: JSON.stringify(first),
    });
    expect(firstResponse.statusCode).toBe(200);

    // REQ-292. Not a refusal, which is what this route answered until 3n.3 and
    // which only forced the operator to invent a name for a file that has one,
    // and above all not an overwrite: the automations built on the first
    // resource go on delivering the first bytes, including the ones whose
    // message is already in somebody's direct.
    const secondResponse = await reader.app.server.inject({
      method: "POST",
      url: ASSETS_API_ROUTE,
      headers: { cookie: reader.cookie, "content-type": "application/json" },
      payload: JSON.stringify(second),
    });
    expect(secondResponse.statusCode).toBe(200);

    const one: string = firstResponse.json().asset.name;
    const other: string = secondResponse.json().asset.name;
    expect(other).not.toBe(one);
    expect(firstResponse.json().asset.fileName).toBe("note.pdf");
    expect(secondResponse.json().asset.fileName).toBe("note.pdf");

    expect(readFileSync(join(reader.dir, "assets", one), "utf8")).toBe(
      "original",
    );
    expect(readFileSync(join(reader.dir, "assets", other), "utf8")).toBe(
      "the second file",
    );

    const listed = await reader.app.server.inject({
      method: "GET",
      url: ASSETS_API_ROUTE,
      headers: { cookie: reader.cookie },
    });
    expect(
      listed
        .json()
        .assets.map((asset: { name: string }) => asset.name)
        .sort(),
    ).toEqual([one, other].sort());
  });

  it("refuses unsafe names and unsupported content without a partial object", async () => {
    const reader = await boot();
    const invalid = [
      {
        name: "../escape.pdf",
        contentType: "application/pdf",
        data: encoded("x"),
      },
      { name: "picture.gif", contentType: "image/gif", data: encoded("x") },
      // Accepted by this route until 3k.17, and refused by the platform at the
      // delivery: the only file format it names is pdf (REQ-231).
      { name: "notes.txt", contentType: "text/plain", data: encoded("x") },
      { name: "cover.webp", contentType: "image/webp", data: encoded("x") },
      { name: "bad.pdf", contentType: "application/pdf", data: "not-base64!" },
    ];

    for (const body of invalid) {
      const response = await reader.app.server.inject({
        method: "POST",
        url: ASSETS_API_ROUTE,
        headers: { cookie: reader.cookie, "content-type": "application/json" },
        payload: JSON.stringify(body),
      });
      expect(response.statusCode).toBe(422);
    }

    expect(existsSync(join(reader.dir, "escape.pdf"))).toBe(false);
    expect(
      await reader.app.server
        .inject({
          method: "GET",
          url: ASSETS_API_ROUTE,
          headers: { cookie: reader.cookie },
        })
        .then((response) => response.json()),
    ).toEqual({
      assets: [],
      upload: {
        contentTypes: ASSET_CONTENT_TYPES,
        maxBytes: MAX_ASSET_BYTES,
      },
    });
  });

  it("passes a payload over the process default through to the documented size refusal", async () => {
    const reader = await boot();
    const tooLarge = Buffer.alloc(MAX_ASSET_BYTES + 1).toString("base64");

    const response = await reader.app.server.inject({
      method: "POST",
      url: ASSETS_API_ROUTE,
      headers: { cookie: reader.cookie, "content-type": "application/json" },
      payload: JSON.stringify({
        name: "too-large.pdf",
        contentType: "application/pdf",
        data: tooLarge,
      }),
    });

    expect(response.statusCode).toBe(422);
    expect(response.json()).toEqual({ error: "too_large" });
    expect(existsSync(join(reader.dir, "assets", "too-large.pdf"))).toBe(false);
  });
});

/**
 * Proves REQ-293 from the back end: what the deletion dialogue reads, and the
 * deletion it must never be a side effect of.
 *
 * The definitions below are seeded as ROWS rather than posted through the
 * automation API, and that is the point rather than a shortcut: the usage read
 * knows nothing about the format of the day, so the proof must not depend on
 * it either. It also lets one of these automations be a document the current
 * schema would refuse, which is exactly the automation whose contacts are
 * holding a link to the file.
 */
describe("REQ-293: deleting a resource is explicit, and never a side effect", () => {
  const AUTOMATION_ROUTE = "/api/automations";

  async function upload(
    reader: { app: App; cookie: string },
    name: string,
    contents: string,
  ): Promise<string> {
    const response = await reader.app.server.inject({
      method: "POST",
      url: ASSETS_API_ROUTE,
      headers: { cookie: reader.cookie, "content-type": "application/json" },
      payload: JSON.stringify({
        name,
        contentType: "application/pdf",
        data: encoded(contents),
      }),
    });
    expect(response.statusCode).toBe(200);
    return response.json().asset.name as string;
  }

  function automationUsing(id: string, key: string, target?: string): unknown {
    return {
      schema_version: 2,
      kind: "automation",
      id,
      state: "active",
      trigger: {
        type: "comment",
        ...(target !== undefined && { target }),
        match: { keywords: ["guide"], mode: "contains" },
      },
      rules: { once_per_contact: true, first_reply_delay_seconds: 5 },
      steps: [
        {
          id: "message",
          action: "send_dm",
          message: { text: "Here" },
          card: { title: "Guide", image: key },
        },
      ],
    };
  }

  function seed(
    handle: DatabaseHandle,
    id: string,
    definition: unknown,
    target: string | null = null,
  ): void {
    handle.db
      .insert(automationAggregates)
      .values({
        id,
        definition: JSON.stringify(definition),
        publicationTarget: target,
        createdAt: NOW,
        updatedAt: NOW,
      })
      .run();
  }

  function usageUrl(key: string): string {
    return `${ASSETS_API_ROUTE}/${encodeURIComponent(key)}/usage`;
  }

  function assetUrl(key: string): string {
    return `${ASSETS_API_ROUTE}/${encodeURIComponent(key)}`;
  }

  it("names the automations that use the file, while the file is still there", async () => {
    const reader = await boot();
    const key = await upload(reader, "guide.pdf", "%PDF-1.4 guide");
    const other = await upload(reader, "guide.pdf", "%PDF-1.4 another guide");

    seed(reader.handle, "launch", automationUsing("launch", key), "post-1");
    seed(reader.handle, "sale", automationUsing("sale", other), "post-2");

    const response = await reader.app.server.inject({
      method: "GET",
      url: usageUrl(key),
      headers: { cookie: reader.cookie },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      asset: {
        name: key,
        fileName: "guide.pdf",
        publicUrl: expect.stringContaining(
          `${reader.app.config.publicOrigin}${ASSETS_ROUTE_PREFIX}/${key}?cap=`,
        ),
      },
      // The automation on the OTHER resource is absent, which is what the
      // minted key buys: two files the operator called the same thing are two
      // identities, and the usage of one is not the usage of the other.
      usedBy: [
        { automationId: "launch", enabled: true, publicationId: "post-1" },
      ],
    });
    // A read, and nothing else: the file is untouched by asking about it.
    expect(existsSync(join(reader.dir, "assets", key))).toBe(true);
  });

  it("counts an automation the current schema can no longer read", async () => {
    const reader = await boot();
    const key = await upload(reader, "guide.pdf", "%PDF-1.4 guide");

    // The shape 3l left behind: a document that no validator accepts today. Its
    // contacts still received the link, so the file is still in use.
    seed(reader.handle, "legacy", {
      id: "legacy",
      steps: [{ action: "send_attachment", asset: key }],
    });

    const response = await reader.app.server.inject({
      method: "GET",
      url: usageUrl(key),
      headers: { cookie: reader.cookie },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().usedBy).toEqual([
      { automationId: "legacy", enabled: false },
    ]);
  });

  it("deletes on request, says what it was used by, and answers 404 once", async () => {
    const reader = await boot();
    const key = await upload(reader, "guide.pdf", "%PDF-1.4 guide");
    seed(reader.handle, "launch", automationUsing("launch", key), "post-1");

    const deleted = await reader.app.server.inject({
      method: "DELETE",
      url: assetUrl(key),
      headers: { cookie: reader.cookie },
    });

    expect(deleted.statusCode).toBe(200);
    expect(deleted.json()).toEqual({
      deleted: {
        name: key,
        fileName: "guide.pdf",
        publicUrl: expect.stringContaining(
          `${reader.app.config.publicOrigin}${ASSETS_ROUTE_PREFIX}/${key}?cap=`,
        ),
      },
      usedBy: [
        { automationId: "launch", enabled: true, publicationId: "post-1" },
      ],
    });
    expect(existsSync(join(reader.dir, "assets", key))).toBe(false);
    expect(
      (
        await reader.app.server.inject({
          method: "GET",
          url: ASSETS_API_ROUTE,
          headers: { cookie: reader.cookie },
        })
      ).json().assets,
    ).toEqual([]);

    // The automation is NOT deleted with the file it used: the operator was
    // warned, and what to do with the automation is their next decision.
    expect(
      reader.handle.db.select().from(automationAggregates).all(),
    ).toHaveLength(1);

    const again = await reader.app.server.inject({
      method: "DELETE",
      url: assetUrl(key),
      headers: { cookie: reader.cookie },
    });
    expect(again.statusCode).toBe(404);
    expect(again.json()).toEqual({ error: "not_found" });
  });

  it("refuses to answer for a resource the catalogue does not have", async () => {
    const reader = await boot();

    for (const url of [usageUrl("ghost.pdf"), assetUrl("ghost.pdf")]) {
      const response = await reader.app.server.inject({
        method: url.endsWith("/usage") ? "GET" : "DELETE",
        url,
        headers: { cookie: reader.cookie },
      });
      expect(response.statusCode).toBe(404);
    }
  });

  it("keeps the file when the automation that used it is deleted", async () => {
    const reader = await boot();
    const key = await upload(reader, "guide.pdf", "%PDF-1.4 guide");
    seed(reader.handle, "launch", automationUsing("launch", key), "post-1");

    const removed = await reader.app.server.inject({
      method: "DELETE",
      url: `${AUTOMATION_ROUTE}/launch`,
      headers: { cookie: reader.cookie },
    });
    expect(removed.statusCode).toBe(200);
    expect(
      reader.handle.db.select().from(automationAggregates).all(),
    ).toHaveLength(0);

    // REQ-293. The automation delivered to contacts whose direct message still
    // carries the button; the button points at `/clicks/<id>`, which redirects
    // to this file. Deleting the automation must leave the material standing,
    // or those messages stop working for people who never asked for anything.
    expect(existsSync(join(reader.dir, "assets", key))).toBe(true);
    expect(
      (
        await reader.app.server.inject({
          method: "GET",
          url: ASSETS_API_ROUTE,
          headers: { cookie: reader.cookie },
        })
      ).json().assets,
    ).toEqual([
      {
        name: key,
        fileName: "guide.pdf",
        publicUrl: expect.stringContaining(
          `${reader.app.config.publicOrigin}${ASSETS_ROUTE_PREFIX}/${key}?cap=`,
        ),
      },
    ]);
  });
});
