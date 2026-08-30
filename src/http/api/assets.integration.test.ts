import { mkdtempSync, rmSync } from "node:fs";
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
import { ASSETS_API_ROUTE } from "./assets.js";
import { openDatabase } from "../../storage/database.js";
import { ASSET_CONTENT_TYPES, MAX_ASSET_BYTES } from "../../storage/assets.js";

const APP_SECRET = "s3-integration-app-secret";
const VERIFY_TOKEN = "s3-integration-verify-token";
const PASSWORD = "s3-integration-operator-password";
const NOW = new Date("2026-08-06T12:00:00.000Z");

interface StoredObject {
  readonly bytes: Buffer;
  readonly contentType: string;
}

interface EmulatorRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: Headers;
  readonly body: Buffer;
}

interface S3Emulator {
  readonly endpoint: string;
  readonly objects: Map<string, StoredObject>;
  readonly requests: EmulatorRequest[];
  readonly fetch: (
    input: string | URL,
    init?: RequestInit,
  ) => Promise<Response>;
}

function xmlResponse(status: number, body: string): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "application/xml" },
  });
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** A protocol-level S3 double, injected through the app composition root. */
function startEmulator(): S3Emulator {
  const objects = new Map<string, StoredObject>();
  const requests: EmulatorRequest[] = [];

  const fetch = async (
    input: string | URL,
    init: RequestInit = {},
  ): Promise<Response> => {
    const url = new URL(input);
    const method = init.method ?? "GET";
    const headers = new Headers(init.headers);
    const body =
      init.body === undefined
        ? Buffer.alloc(0)
        : Buffer.from(init.body as Uint8Array);
    requests.push({ method, url: url.toString(), headers, body });

    const path = decodeURIComponent(url.pathname);
    const bucketPrefix = "/mychat/";
    if (!path.startsWith(bucketPrefix)) {
      return new Response(null, { status: 404 });
    }

    if (method === "GET" && url.searchParams.get("list-type") === "2") {
      const prefix = url.searchParams.get("prefix") ?? "";
      const keys = [...objects.keys()]
        .filter((key) => key.startsWith(prefix))
        .sort();
      return xmlResponse(
        200,
        `<ListBucketResult>${keys
          .map((key) => `<Contents><Key>${escapeXml(key)}</Key></Contents>`)
          .join("")}<IsTruncated>false</IsTruncated></ListBucketResult>`,
      );
    }

    const key = path.slice(bucketPrefix.length);
    const stored = objects.get(key);

    if (method === "HEAD") {
      return stored === undefined
        ? new Response(null, { status: 404 })
        : new Response(null, {
            status: 200,
            headers: { "content-type": stored.contentType },
          });
    }

    if (method === "PUT") {
      if (stored !== undefined) {
        return new Response(null, { status: 412 });
      }
      objects.set(key, {
        bytes: Buffer.from(body),
        contentType: headers.get("content-type") ?? "",
      });
      return new Response(null, { status: 200 });
    }

    if (method === "DELETE") {
      // 204 whether or not the key was there, as S3 and R2 both answer.
      objects.delete(key);
      return new Response(null, { status: 204 });
    }

    return new Response(null, { status: 405 });
  };

  return { endpoint: "http://s3-emulator.invalid", objects, requests, fetch };
}

const directories: string[] = [];
const apps: App[] = [];

function tempDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "mychat-s3-assets-api-"));
  directories.push(directory);
  return directory;
}

function envFor(directory: string): NodeJS.ProcessEnv {
  return {
    META_APP_SECRET: APP_SECRET,
    WEBHOOK_VERIFY_TOKEN: VERIFY_TOKEN,
    DATABASE_PATH: join(directory, "mychat.db"),
    ASSETS_DIR: join(directory, "unused-assets"),
    THUMBNAILS_DIR: join(directory, "thumbs"),
    STORAGE_DRIVER: "s3",
    S3_ENDPOINT: "http://s3-emulator.invalid",
    S3_ACCESS_KEY_ID: "integration-key",
    S3_SECRET_ACCESS_KEY: "integration-secret",
    S3_BUCKET: "mychat",
    SWEEP_INTERVAL_MS: "60000",
  };
}

async function installPassword(directory: string): Promise<void> {
  const handle = openDatabase({ databasePath: join(directory, "mychat.db") });
  try {
    await setOperatorPassword(
      PASSWORD,
      createOperatorCredentialStore(handle.db),
      NOW,
    );
  } finally {
    handle.close();
  }
}

async function sessionCookie(app: App): Promise<string> {
  const response = await app.server.inject({
    method: "POST",
    url: "/api/session",
    headers: { "content-type": "application/json" },
    payload: JSON.stringify({ password: PASSWORD }),
  });
  expect(response.statusCode).toBe(200);
  const cookie = response.cookies.find(
    (candidate) => candidate.name === SESSION_COOKIE_NAME,
  );
  expect(cookie).toBeDefined();
  return `${SESSION_COOKIE_NAME}=${String(cookie?.value)}`;
}

function encoded(value: string): string {
  return Buffer.from(value, "utf8").toString("base64");
}

afterEach(async () => {
  for (const app of apps.splice(0)) {
    await app.close();
  }
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("REQ-047: S3-backed asset API integration", () => {
  it("uses the same private API against an injected S3 emulator", async () => {
    const directory = tempDirectory();
    const emulator = startEmulator();
    const app = await createApp(envFor(directory), {
      clock: { now: (): Date => NOW },
      assetFetch: emulator.fetch,
    });
    apps.push(app);
    await installPassword(directory);

    const beforePrivateRead = emulator.requests.length;
    const unauthorized = await app.server.inject({
      method: "GET",
      url: ASSETS_API_ROUTE,
    });
    expect(unauthorized.statusCode).toBe(401);
    expect(emulator.requests).toHaveLength(beforePrivateRead);

    const cookie = await sessionCookie(app);
    const body = {
      name: "emulator-guide.pdf",
      contentType: "application/pdf",
      data: encoded("%PDF-1.4 emulator bytes"),
    };

    const uploaded = await app.server.inject({
      method: "POST",
      url: ASSETS_API_ROUTE,
      headers: { cookie, "content-type": "application/json" },
      payload: JSON.stringify(body),
    });

    expect(uploaded.statusCode).toBe(200);
    const key: string = uploaded.json().asset.name;
    expect(uploaded.json()).toEqual({
      asset: {
        name: key,
        fileName: body.name,
        publicUrl: expect.stringContaining(
          `http://localhost:3000/assets/${key}?cap=`,
        ),
      },
    });
    expect([...emulator.objects.keys()]).toEqual([`assets/${key}`]);
    expect(emulator.objects.get(`assets/${key}`)?.bytes).toEqual(
      Buffer.from("%PDF-1.4 emulator bytes"),
    );

    const listed = await app.server.inject({
      method: "GET",
      url: ASSETS_API_ROUTE,
      headers: { cookie },
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toEqual({
      assets: [
        {
          name: key,
          fileName: body.name,
          publicUrl: expect.stringContaining(
            `http://localhost:3000/assets/${key}?cap=`,
          ),
        },
      ],
      upload: {
        contentTypes: ASSET_CONTENT_TYPES,
        maxBytes: MAX_ASSET_BYTES,
      },
    });

    // The same file name a second time, in the bucket this time: a SECOND
    // object, and the first one still holding the bytes every automation built
    // on it delivers (REQ-292).
    const again = await app.server.inject({
      method: "POST",
      url: ASSETS_API_ROUTE,
      headers: { cookie, "content-type": "application/json" },
      payload: JSON.stringify({ ...body, data: encoded("the second file") }),
    });
    expect(again.statusCode).toBe(200);
    const secondKey: string = again.json().asset.name;
    expect(secondKey).not.toBe(key);
    expect(again.json().asset.fileName).toBe(body.name);
    expect(emulator.objects.get(`assets/${key}`)?.bytes).toEqual(
      Buffer.from("%PDF-1.4 emulator bytes"),
    );
    expect(emulator.objects.get(`assets/${secondKey}`)?.bytes).toEqual(
      Buffer.from("the second file"),
    );

    // And the deletion this API now carries, against the bucket adapter
    // (REQ-293): explicit, one object, and nothing else touched.
    const deleted = await app.server.inject({
      method: "DELETE",
      url: `${ASSETS_API_ROUTE}/${encodeURIComponent(secondKey)}`,
      headers: { cookie },
    });
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json()).toEqual({
      deleted: {
        name: secondKey,
        fileName: body.name,
        publicUrl: expect.stringContaining(
          `http://localhost:3000/assets/${secondKey}?cap=`,
        ),
      },
      usedBy: [],
    });
    expect([...emulator.objects.keys()]).toEqual([`assets/${key}`]);
  });

  it("keeps unsupported and unsafe uploads out of the bucket", async () => {
    const directory = tempDirectory();
    const emulator = startEmulator();
    const app = await createApp(envFor(directory), {
      clock: { now: (): Date => NOW },
      assetFetch: emulator.fetch,
    });
    apps.push(app);
    await installPassword(directory);
    const cookie = await sessionCookie(app);

    for (const body of [
      {
        name: "picture.gif",
        contentType: "image/gif",
        data: encoded("not supported"),
      },
      {
        name: "../outside.pdf",
        contentType: "application/pdf",
        data: encoded("unsafe name"),
      },
    ]) {
      const response = await app.server.inject({
        method: "POST",
        url: ASSETS_API_ROUTE,
        headers: { cookie, "content-type": "application/json" },
        payload: JSON.stringify(body),
      });
      expect(response.statusCode).toBe(422);
    }

    expect(emulator.objects).toEqual(new Map());
  });
});
