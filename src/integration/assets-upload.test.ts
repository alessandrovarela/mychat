import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createOperatorCredentialStore,
  setOperatorPassword,
} from "../auth/credential.js";
import { SESSION_COOKIE_NAME } from "../auth/session.js";
import { createApp } from "../app.js";
import type { App } from "../app.js";
import { ASSETS_API_ROUTE } from "../http/api/assets.js";
import { ASSETS_ROUTE_PREFIX } from "../http/assets-route.js";
import { ASSET_CONTENT_TYPES, MAX_ASSET_BYTES } from "../storage/assets.js";
import { openDatabase } from "../storage/database.js";

const APP_SECRET = "integration-app-secret";
const VERIFY_TOKEN = "integration-verify-token";
const PASSWORD = "integration-operator-password";
const NOW = new Date("2026-08-06T12:00:00.000Z");

const apps: App[] = [];
const directories: string[] = [];

function tempDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "mychat-assets-upload-"));
  directories.push(directory);
  return directory;
}

function envFor(directory: string): NodeJS.ProcessEnv {
  return {
    META_APP_SECRET: APP_SECRET,
    WEBHOOK_VERIFY_TOKEN: VERIFY_TOKEN,
    DATABASE_PATH: join(directory, "mychat.db"),
    ASSETS_DIR: join(directory, "assets"),
    THUMBNAILS_DIR: join(directory, "thumbs"),
    SWEEP_INTERVAL_MS: "60000",
  };
}

async function boot(directory: string): Promise<App> {
  const app = await createApp(envFor(directory), {
    clock: { now: (): Date => NOW },
  });
  apps.push(app);
  return app;
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

describe("REQ-047: disk upload integration", () => {
  it("survives a process restart, remains listed, and is served publicly", async () => {
    const directory = tempDirectory();
    const first = await boot(directory);
    await installPassword(directory);
    const firstCookie = await sessionCookie(first);

    const uploaded = await first.server.inject({
      method: "POST",
      url: ASSETS_API_ROUTE,
      headers: {
        cookie: firstCookie,
        "content-type": "application/json",
      },
      payload: JSON.stringify({
        name: "restart-guide.pdf",
        contentType: "application/pdf",
        data: encoded("%PDF-1.4 survives restart"),
      }),
    });

    expect(uploaded.statusCode).toBe(200);
    // The stored identity is minted, not typed (REQ-292): what the operator
    // sent is the name shown, and the key is what survives the restart below.
    const key: string = uploaded.json().asset.name;
    expect(uploaded.json().asset.fileName).toBe("restart-guide.pdf");
    expect(existsSync(join(directory, "assets", key))).toBe(true);

    await first.close();
    apps.splice(apps.indexOf(first), 1);

    const second = await boot(directory);
    const secondCookie = await sessionCookie(second);
    const listed = await second.server.inject({
      method: "GET",
      url: ASSETS_API_ROUTE,
      headers: { cookie: secondCookie },
    });

    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toEqual({
      assets: [
        {
          name: key,
          fileName: "restart-guide.pdf",
          publicUrl: expect.stringContaining(
            `${second.config.publicOrigin}${ASSETS_ROUTE_PREFIX}/${key}?cap=`,
          ),
        },
      ],
      upload: {
        contentTypes: ASSET_CONTENT_TYPES,
        maxBytes: MAX_ASSET_BYTES,
      },
    });

    const publicRead = await second.server.inject({
      method: "GET",
      url:
        new URL(listed.json().assets[0].publicUrl).pathname +
        new URL(listed.json().assets[0].publicUrl).search,
    });
    expect(publicRead.statusCode).toBe(200);
    expect(publicRead.body).toBe("%PDF-1.4 survives restart");
    expect(publicRead.headers["content-type"]).toBe("application/pdf");
  });

  it("keeps rejected names outside the directory and leaves no partial file", async () => {
    const directory = tempDirectory();
    const app = await boot(directory);
    await installPassword(directory);
    const cookie = await sessionCookie(app);

    const response = await app.server.inject({
      method: "POST",
      url: ASSETS_API_ROUTE,
      headers: { cookie, "content-type": "application/json" },
      payload: JSON.stringify({
        name: "../escaped.pdf",
        contentType: "application/pdf",
        data: encoded("%PDF-1.4 must not escape"),
      }),
    });

    expect(response.statusCode).toBe(422);
    expect(response.json()).toEqual({ error: "invalid_name" });
    expect(existsSync(join(directory, "escaped.pdf"))).toBe(false);
    expect(existsSync(join(directory, "assets", "escaped.pdf"))).toBe(false);

    const publicRead = await app.server.inject({
      method: "GET",
      url: `${ASSETS_ROUTE_PREFIX}/..%2Fescaped.pdf`,
    });
    expect(publicRead.statusCode).toBe(404);
  });

  it("rejects unsupported types and the documented size limit before writing", async () => {
    const directory = tempDirectory();
    const app = await boot(directory);
    await installPassword(directory);
    const cookie = await sessionCookie(app);

    const unsupported = await app.server.inject({
      method: "POST",
      url: ASSETS_API_ROUTE,
      headers: { cookie, "content-type": "application/json" },
      payload: JSON.stringify({
        name: "picture.gif",
        contentType: "image/gif",
        data: encoded("unsupported"),
      }),
    });
    expect(unsupported.statusCode).toBe(422);
    expect(unsupported.json()).toEqual({ error: "unsupported_content_type" });

    const tooLarge = Buffer.alloc(MAX_ASSET_BYTES + 1).toString("base64");
    const oversized = await app.server.inject({
      method: "POST",
      url: ASSETS_API_ROUTE,
      headers: { cookie, "content-type": "application/json" },
      payload: JSON.stringify({
        name: "too-large.pdf",
        contentType: "application/pdf",
        data: tooLarge,
      }),
    });

    expect(oversized.statusCode).toBe(422);
    expect(oversized.json()).toEqual({ error: "too_large" });
    expect(existsSync(join(directory, "assets", "picture.gif"))).toBe(false);
    expect(existsSync(join(directory, "assets", "too-large.pdf"))).toBe(false);
  }, 20_000);

  it("does not expose a private catalogue or write without a session", async () => {
    const directory = tempDirectory();
    const app = await boot(directory);

    const listed = await app.server.inject({
      method: "GET",
      url: ASSETS_API_ROUTE,
    });
    const uploaded = await app.server.inject({
      method: "POST",
      url: ASSETS_API_ROUTE,
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({
        name: "anonymous.txt",
        contentType: "text/plain",
        data: encoded("must not be stored"),
      }),
    });

    expect(listed.statusCode).toBe(401);
    expect(uploaded.statusCode).toBe(401);
    expect(existsSync(join(directory, "assets", "anonymous.txt"))).toBe(false);
  });
});
