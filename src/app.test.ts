import { createHmac } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createOperatorCredentialStore,
  setOperatorPassword,
} from "./auth/credential.js";
import { SESSION_COOKIE_NAME } from "./auth/session.js";
import { run } from "./cli/main.js";
import { ConfigError } from "./config/errors.js";
import { ASSETS_ROUTE_PREFIX } from "./http/index.js";
import { t } from "./i18n/index.js";
import {
  CREDENTIAL_CHECK_KEY,
  PUBLICATION_LISTING_PAGE_SIZE,
} from "./platform/index.js";
import type { PlatformRequest, PlatformTransport } from "./platform/index.js";
import {
  createAuditRepository,
  createCredentialStore,
  createDurableWorkStore,
  createPublicationCacheStore,
  MigrationError,
  openDatabase,
  thumbnailKeyFor,
  WORK_KINDS,
} from "./storage/index.js";
import {
  assetCapabilityUrl,
  deriveAssetCapabilitySecret,
} from "./storage/index.js";
import type { DatabaseHandle } from "./storage/index.js";
import { createApp } from "./app.js";
import type { App } from "./app.js";

/**
 * Proves REQ-091 and REQ-096: one call brings the whole process up, a failure
 * before listening stops it and says why, and the environment seeds the
 * credential exactly once in the life of an installation.
 *
 * No port is bound anywhere here. The composition is driven through Fastify's
 * own `inject()`, which is what lets the fast suite exercise the real wiring
 * without assuming any port is free (KEEL rule for this suite). The platform
 * transport is injected too, so nothing leaves the machine.
 */

const APP_SECRET = "app-secret";
const VERIFY_TOKEN = "verify-me";
const ENV_TOKEN = "token-from-the-environment";
const ACCOUNT_ID = "17841400000000000";
const NOW = new Date("2026-08-01T12:00:00.000Z");
const SIXTY_DAYS_MS = 60 * 24 * 60 * 60 * 1000;

const clock = { now: (): Date => NOW };

const dirs: string[] = [];
const apps: App[] = [];
const handles: DatabaseHandle[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "mychat-app-"));
  dirs.push(dir);
  return dir;
}

function baseEnv(
  dir: string,
  overrides: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  return {
    META_APP_SECRET: APP_SECRET,
    WEBHOOK_VERIFY_TOKEN: VERIFY_TOKEN,
    DATABASE_PATH: join(dir, "mychat.db"),
    ASSETS_DIR: join(dir, "assets"),
    THUMBNAILS_DIR: join(dir, "thumbs"),
    // Far longer than any test takes, so the armed loop never races a pass the
    // test drives itself. The one test that wants the loop lowers it.
    SWEEP_INTERVAL_MS: "60000",
    ...overrides,
  };
}

/** A transport that answers without a network and remembers what it was asked. */
function stubTransport(status = 200): {
  transport: PlatformTransport;
  requests: PlatformRequest[];
} {
  const requests: PlatformRequest[] = [];

  return {
    requests,
    transport: (request: PlatformRequest) => {
      requests.push(request);
      return Promise.resolve({ status, body: { id: ACCOUNT_ID } });
    },
  };
}

async function boot(
  env: NodeJS.ProcessEnv,
  transport: PlatformTransport = stubTransport().transport,
): Promise<App> {
  const app = await createApp(env, { clock, transport });
  apps.push(app);
  return app;
}

/** A second connection to the same file, for asserting what the app wrote. */
function inspect(dir: string): DatabaseHandle {
  const handle = openDatabase({ databasePath: join(dir, "mychat.db") });
  handles.push(handle);
  return handle;
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

describe("REQ-091: one command brings the process up", () => {
  it("applies the migrations and answers the webhook handshake", async () => {
    const app = await boot(baseEnv(tempDir()));

    expect(app.migrations.applied.length).toBeGreaterThan(0);

    const response = await app.server.inject({
      method: "GET",
      url: "/webhook",
      query: {
        "hub.mode": "subscribe",
        "hub.verify_token": VERIFY_TOKEN,
        "hub.challenge": "1158201444",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toBe("1158201444");
  });

  it("serves the resources route on the same instance", async () => {
    const dir = tempDir();
    mkdirSync(join(dir, "assets"), { recursive: true });
    writeFileSync(join(dir, "assets", "guide.txt"), "the resource", "utf8");

    const app = await boot(baseEnv(dir));
    const url = new URL(
      assetCapabilityUrl(
        `${app.config.publicOrigin}${ASSETS_ROUTE_PREFIX}`,
        "guide.txt",
        deriveAssetCapabilitySecret(APP_SECRET),
      ),
    );
    const response = await app.server.inject({
      method: "GET",
      url: `${url.pathname}${url.search}`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toBe("the resource");
  });

  it("builds the resource address from the origin the platform reaches", async () => {
    // The route prefix and the address handed to a contact are the same string
    // by construction, so they cannot drift apart in silence.
    const app = await boot(
      baseEnv(tempDir(), { PUBLIC_ORIGIN: "https://tunnel.example.com/" }),
    );

    expect(app.config.publicOrigin).toBe("https://tunnel.example.com");
    expect(`${app.config.publicOrigin}${ASSETS_ROUTE_PREFIX}`).toBe(
      "https://tunnel.example.com/assets",
    );
  });

  it("registers a handler for every kind of durable work", async () => {
    const dir = tempDir();
    const app = await boot(baseEnv(dir));

    const work = createDurableWorkStore(inspect(dir).db);
    for (const kind of WORK_KINDS) {
      await work.enqueue(
        { kind, dedupeKey: `probe:${kind}`, payload: {} },
        NOW,
      );
    }

    const report = await app.sweepOnce();

    // A kind with no handler is left in the queue forever, and nothing anywhere
    // says so: this list is the only place that wiring mistake becomes visible.
    expect(report.unhandled).toEqual([]);
    expect(report.examined).toBeGreaterThanOrEqual(WORK_KINDS.length);
  });

  it("wires definitive send failures to the persistent automatic pause", async () => {
    const dir = tempDir();
    const app = await boot(
      baseEnv(dir, {
        META_ACCESS_TOKEN: ENV_TOKEN,
        INSTAGRAM_ACCOUNT_ID: ACCOUNT_ID,
      }),
      stubTransport(400).transport,
    );
    const database = inspect(dir);
    const aggregate = {
      schema_version: 2,
      kind: "automation",
      id: "launch-post",
      state: "active",
      trigger: {
        type: "direct_message",
        match: { keywords: ["hello"], mode: "contains" },
      },
      rules: { once_per_contact: false },
      steps: [
        {
          id: "private-message",
          action: "send_dm",
          message: { text: "hello" },
        },
      ],
    } as const;
    database.connection
      .prepare(
        `INSERT INTO automation_aggregates
         (id, definition, publication_target, created_at, updated_at)
         VALUES (?, ?, NULL, ?, ?)`,
      )
      .run(
        "launch-post",
        JSON.stringify(aggregate),
        NOW.getTime(),
        NOW.getTime(),
      );

    const work = createDurableWorkStore(database.db);
    for (let index = 0; index < 3; index += 1) {
      await work.enqueue(
        {
          kind: "send",
          dedupeKey: `auto-pause:${index}`,
          executionId: `launch-post:contact-${index}:run`,
          contactId: `contact-${index}`,
          sendClass: "direct_message",
          payload: {
            action: "direct_message",
            origin: "direct_message",
            since: NOW.toISOString(),
            contactId: `contact-${index}`,
            message: { text: "hello" },
          },
        },
        NOW,
      );
    }

    const report = await app.sweepOnce();
    expect(report.failed).toBeGreaterThanOrEqual(3);
    const persisted = database.connection
      .prepare(
        `SELECT occurred_ats FROM automation_failure_sequences WHERE automation_id = ?`,
      )
      .get("launch-post") as { occurred_ats: string };
    expect(JSON.parse(persisted.occurred_ats)).toHaveLength(3);

    const automation = database.connection
      .prepare(`SELECT definition FROM automation_aggregates WHERE id = ?`)
      .get("launch-post") as { definition: string };
    expect(JSON.parse(automation.definition).state).toBe("draft");
    const [alert] = await createAuditRepository(database.db).query({
      kind: "alert",
      subtype: "automation_auto_paused",
    });
    expect(alert?.automationId).toBe("launch-post");
    // The identifier is what names it in the trail (REQ-279): an automation
    // holds no name, and the sentence the screens show is composed from the
    // publication when they draw it.
    expect(alert?.reason).toContain("launch-post");

    await setOperatorPassword(
      "auto-pause-operator",
      createOperatorCredentialStore(database.db),
      NOW,
    );
    const opened = await app.server.inject({
      method: "POST",
      url: "/api/session",
      payload: { password: "auto-pause-operator" },
    });
    const session = opened.cookies.find(
      (cookie) => cookie.name === SESSION_COOKIE_NAME,
    );
    expect(opened.statusCode).toBe(200);
    expect(session).toBeDefined();
    const cookie = `${SESSION_COOKIE_NAME}=${String(session?.value)}`;

    const listed = await app.server.inject({
      method: "GET",
      url: "/api/automations",
      headers: { cookie },
    });
    expect(listed.statusCode).toBe(200);
    expect(
      listed.json<{ automations: { definition: { state: string } }[] }>()
        .automations[0]?.definition.state,
    ).toBe("draft");

    const enabled = await app.server.inject({
      method: "POST",
      url: "/api/automations",
      headers: { cookie },
      payload: { definition: aggregate },
    });
    expect(enabled.statusCode).toBe(200);
    const remaining = database.connection
      .prepare(
        `SELECT occurred_ats FROM automation_failure_sequences WHERE automation_id = ?`,
      )
      .get("launch-post") as { occurred_ats: string } | undefined;
    expect(remaining).toBeUndefined();
  });

  it("arms the periodic sweep, which runs a pass with nobody driving it", async () => {
    const dir = tempDir();
    const { transport, requests } = stubTransport();

    await boot(
      baseEnv(dir, {
        META_ACCESS_TOKEN: ENV_TOKEN,
        INSTAGRAM_ACCOUNT_ID: ACCOUNT_ID,
        SWEEP_INTERVAL_MS: "5",
      }),
      transport,
    );

    const work = createDurableWorkStore(inspect(dir).db);

    // The credential check is due at boot, so the first pass of the loop picks
    // it up and defers it to the next interval. One attempt is proof that the
    // loop is running, and it also proves the transport reached the account.
    await vi.waitFor(
      async () => {
        const item = await work.findByKey(CREDENTIAL_CHECK_KEY);
        expect(item?.attempts).toBeGreaterThanOrEqual(1);
      },
      { timeout: 5000, interval: 10 },
    );

    expect(requests.map((request) => request.path)).toContain("/me");
  });
});

describe("REQ-091: nothing serves in a state it cannot honour", () => {
  it("refuses to build when a required variable is missing, naming it", async () => {
    // `createApp` never binds a port, so a rejection here IS the process not
    // listening: `main.ts` has nothing to listen on.
    const error: unknown = await createApp(
      { DATABASE_PATH: join(tempDir(), "mychat.db") },
      { clock },
    ).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(ConfigError);
    expect((error as ConfigError).variables).toEqual([
      "META_APP_SECRET",
      "WEBHOOK_VERIFY_TOKEN",
    ]);
    expect((error as ConfigError).message).toContain("META_APP_SECRET");
  });

  it("refuses to build when a migration fails, naming the migration", async () => {
    const dir = tempDir();
    const folder = join(dir, "migrations");
    mkdirSync(join(folder, "meta"), { recursive: true });
    writeFileSync(
      join(folder, "meta", "_journal.json"),
      JSON.stringify({ entries: [{ tag: "0000_broken" }] }),
      "utf8",
    );
    writeFileSync(
      join(folder, "0000_broken.sql"),
      "CREATE TABLE ( not valid sql;",
      "utf8",
    );

    const error: unknown = await createApp(baseEnv(dir), {
      clock,
      migrationsFolder: folder,
    }).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(MigrationError);
    expect((error as MigrationError).tag).toBe("0000_broken");
    expect((error as MigrationError).message).toContain("0000_broken");
  });

  it("composes an S3 storage driver when its binding is configured", async () => {
    const dir = tempDir();
    const app = await createApp(
      baseEnv(dir, {
        STORAGE_DRIVER: "s3",
        S3_ENDPOINT: "https://account.r2.cloudflarestorage.com",
        S3_ACCESS_KEY_ID: "key",
        S3_SECRET_ACCESS_KEY: "secret",
        S3_BUCKET: "mychat",
      }),
      { clock },
    );
    apps.push(app);

    expect(app.config.storage.driver).toBe("s3");
    expect(app.config.storage.thumbnailsDir).toBe(join(dir, "thumbs"));
  });

  it("serves S3 deployment thumbnails from the configured local volume", async () => {
    const dir = tempDir();
    const publicationId = "18153371755481491";
    const pixels = "JPEG-bytes-from-the-production-volume";
    const thumbnailsDir = join(dir, "production-thumbnails");
    mkdirSync(thumbnailsDir, { recursive: true });
    writeFileSync(join(thumbnailsDir, `${publicationId}.jpg`), pixels, "utf8");

    const app = await createApp(
      baseEnv(dir, {
        STORAGE_DRIVER: "s3",
        THUMBNAILS_DIR: thumbnailsDir,
        S3_ENDPOINT: "https://account.r2.cloudflarestorage.com",
        S3_ACCESS_KEY_ID: "key",
        S3_SECRET_ACCESS_KEY: "secret",
        S3_BUCKET: "mychat",
      }),
      { clock },
    );
    apps.push(app);

    const response = await app.server.inject({
      method: "GET",
      url: `/thumbs/${publicationId}.jpg`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toBe(pixels);
  });
});

describe("REQ-091: a fresh installation starts and is told what is missing", () => {
  it("starts with no credential configured, and status says so without failing", async () => {
    const dir = tempDir();
    const app = await boot(baseEnv(dir));

    const handshake = await app.server.inject({
      method: "GET",
      url: "/webhook",
      query: {
        "hub.mode": "subscribe",
        "hub.verify_token": VERIFY_TOKEN,
        "hub.challenge": "42",
      },
    });
    expect(handshake.statusCode).toBe(200);

    const lines: string[] = [];
    const code = await run(["status"], join(dir, "mychat.db"), (line) =>
      lines.push(line),
    );

    // Zero, and that is the assertion: a fresh installation is not a fault, and
    // refusing to start would have denied the operator this very report.
    expect(code).toBe(0);
    expect(lines).toContain(t("status.credentialMissing"));
  });

  it("does not schedule a credential check while there is nothing to check", async () => {
    const dir = tempDir();
    await boot(baseEnv(dir));

    const work = createDurableWorkStore(inspect(dir).db);

    // Checking a credential that was never configured would raise an alert on
    // every fresh installation, and `status` would exit non-zero over it.
    expect(await work.findByKey(CREDENTIAL_CHECK_KEY)).toBeUndefined();
  });
});

describe("REQ-096: the environment seeds the credential only once", () => {
  it("stores the environment credential when the store has none", async () => {
    const dir = tempDir();
    await boot(
      baseEnv(dir, {
        META_ACCESS_TOKEN: ENV_TOKEN,
        INSTAGRAM_ACCOUNT_ID: ACCOUNT_ID,
      }),
    );

    const stored = await createCredentialStore(inspect(dir).db).read();

    expect(stored).toMatchObject({
      authPath: "instagram_login",
      accessToken: ENV_TOKEN,
      accountId: ACCOUNT_ID,
    });
    // Set, not absent: a credential with no expiry is one this path never
    // renews, and the installation would die at sixty days (REQ-081).
    expect(stored?.expiresAt).toEqual(new Date(NOW.getTime() + SIXTY_DAYS_MS));
  });

  it("does not overwrite the token and the expiry the renewal produced", async () => {
    const dir = tempDir();
    const renewedAt = new Date("2026-09-01T00:00:00.000Z");
    const renewedExpiry = new Date("2026-10-31T00:00:00.000Z");
    const renewedToken = "token-the-renewal-produced";

    // The installation as it stands after one automatic renewal.
    const seeded = createCredentialStore(inspect(dir).db);
    await seeded.write(
      {
        authPath: "instagram_login",
        accessToken: ENV_TOKEN,
        accountId: ACCOUNT_ID,
        expiresAt: new Date("2026-09-30T00:00:00.000Z"),
      },
      NOW,
    );
    await seeded.recordRefresh(renewedToken, renewedExpiry, renewedAt);

    // The restart, with the stale token still sitting in the environment.
    await boot(
      baseEnv(dir, {
        META_ACCESS_TOKEN: ENV_TOKEN,
        INSTAGRAM_ACCOUNT_ID: ACCOUNT_ID,
      }),
    );

    const stored = await createCredentialStore(inspect(dir).db).read();

    expect(stored?.accessToken).toBe(renewedToken);
    expect(stored?.expiresAt).toEqual(renewedExpiry);
    expect(stored?.lastRefreshedAt).toEqual(renewedAt);
  });

  it("schedules the credential check once, however many times it starts", async () => {
    const dir = tempDir();
    const env = baseEnv(dir, {
      META_ACCESS_TOKEN: ENV_TOKEN,
      INSTAGRAM_ACCOUNT_ID: ACCOUNT_ID,
    });

    const first = await boot(env);
    await first.close();
    apps.splice(apps.indexOf(first), 1);
    await boot(env);

    const work = createDurableWorkStore(inspect(dir).db);
    const pending = await work.due(new Date(8.64e15), 100);

    // Idempotent by construction: the dedupe key IS the identity of the work,
    // so a second boot finds the row rather than adding one beside it.
    expect(
      pending.filter((item) => item.kind === "credential_check"),
    ).toHaveLength(1);
  });
});

/**
 * REQ-107: every route that declares an input schema receives the object it
 * declared, proved against the COMPOSED application.
 *
 * The junction below is the one no other file covers, and that is why these
 * tests live here rather than beside the routes they exercise.
 * `src/auth/session.test.ts` and `src/http/api-contract.test.ts` build a bare
 * `Fastify({ logger: false })`, so they never meet the body parser the webhook
 * needs; the rest of this file composes the real application but never sent it
 * a body. Between the two, a parser registered on the ROOT instance handed
 * every route an envelope (`{ raw, parsed }`) instead of its body, every `/api`
 * route with a closed input schema answered 400 to a correct request, and 962
 * tests stayed green.
 *
 * The last test is the other half of the same requirement: the raw bytes still
 * have to reach the signature check (REQ-002), and they are read from the exact
 * bytes received rather than from a re-serialisation of the parsed object.
 */
describe("REQ-107: the composed application delivers the declared body", () => {
  const PASSWORD = "operator-password";

  /** The application as deployed, plus an operator who can sign in. */
  async function bootWithOperator(): Promise<App> {
    const dir = tempDir();
    const app = await boot(baseEnv(dir));

    // Written through a second connection, after the boot applied the
    // migrations. `verifyOperatorPassword` reads the store on every attempt, so
    // the sign-in below sees it with nothing restarted.
    await setOperatorPassword(
      PASSWORD,
      createOperatorCredentialStore(inspect(dir).db),
      NOW,
    );

    return app;
  }

  it("hands a public route the object it declared, not a parser envelope", async () => {
    const app = await bootWithOperator();

    const response = await app.server.inject({
      method: "POST",
      url: "/api/session",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ password: PASSWORD }),
    });

    // 200 and not 400: a 400 here means the route never saw `password`, which
    // is what an envelope around the body produces. The password also has to
    // arrive with its VALUE intact, and that is what the 200 proves: this
    // answer is only reachable by deriving the stored hash from these bytes.
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });
    expect(
      response.cookies.some((cookie) => cookie.name === SESSION_COOKIE_NAME),
    ).toBe(true);
  });

  it("still verifies the platform's signature over the bytes received", async () => {
    const app = await bootWithOperator();

    // Indented on purpose: re-serialising the parsed object would produce
    // different bytes and a different digest, so this body only passes if the
    // check reads what actually arrived (REQ-002).
    const payload = JSON.stringify(
      {
        object: "instagram",
        entry: [{ id: "17841400000000000", time: 1754049600 }],
      },
      null,
      2,
    );

    const response = await app.server.inject({
      method: "POST",
      url: "/webhook",
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": `sha256=${createHmac("sha256", APP_SECRET)
          .update(payload)
          .digest("hex")}`,
      },
      payload,
    });

    expect(response.statusCode).toBe(200);
  });

  it("REQ-205: keeps the webhook public and acknowledged while a trigger is suppressed", async () => {
    const dir = tempDir();
    const app = await boot(baseEnv(dir));
    const db = inspect(dir).db;
    await setOperatorPassword(PASSWORD, createOperatorCredentialStore(db), NOW);
    const opened = await app.server.inject({
      method: "POST",
      url: "/api/session",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ password: PASSWORD }),
    });
    const session = opened.cookies.find(
      (cookie) => cookie.name === SESSION_COOKIE_NAME,
    );
    const cookie = `${SESSION_COOKIE_NAME}=${String(session?.value)}`;
    expect(
      (
        await app.server.inject({
          method: "POST",
          url: "/api/instance/triggers",
          headers: { cookie, "content-type": "application/json" },
          payload: JSON.stringify({ name: "all", enabled: false }),
        })
      ).statusCode,
    ).toBe(200);

    const payload = JSON.stringify({
      object: "instagram",
      entry: [
        {
          id: "17841400000000000",
          time: Math.floor(NOW.getTime() / 1000),
          changes: [
            {
              field: "comments",
              value: {
                id: "comment-trigger-off",
                text: "guide",
                from: { id: "contact-1", username: "someone" },
                media: { id: "media-1" },
              },
            },
          ],
        },
      ],
    });
    const webhook = await app.server.inject({
      method: "POST",
      url: "/webhook",
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": `sha256=${createHmac("sha256", APP_SECRET)
          .update(payload)
          .digest("hex")}`,
      },
      payload,
    });

    expect(webhook.statusCode).toBe(200);
    await vi.waitFor(async () => {
      const suppressed = await createAuditRepository(db).query({
        kind: "event_received",
        outcome: "suppressed",
      });
      expect(suppressed).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            subtype: "comment",
            reason: "trigger_switch_all_disabled",
          }),
        ]),
      );
    });
  });
});

/**
 * REQ-109: the address the publication listing hands out is one this process
 * answers, proved against the COMPOSED application.
 *
 * The same shape of defect as REQ-107 above, and found the same way: an
 * operator opened the grid and saw thirteen publications of a real account with
 * the alternative text where the picture belongs. Every test of the catalogue
 * passed, because they all compose the in-memory double, whose addresses
 * (`memory://bucket/thumbs/<id>.jpg`) no browser resolves and no test ever
 * fetched. True about the component, false about the process.
 *
 * So the assertion here is not that a URL was produced. It is that the URL the
 * composed application puts in the listing, fetched from the composed
 * application, answers with the picture.
 */
describe("REQ-109: the composed application serves the thumbnail it hands out", () => {
  const PASSWORD = "operator-password";
  const ORIGIN = "https://tunnel.example.com";
  /** The two ids from the operator's own screen, one copied and one not. */
  const CACHED_ID = "18153371755481491";
  const MISSING_ID = "18153371755481492";
  const PIXELS = "JPEG-bytes-of-a-thumbnail";
  const EARLIER = new Date("2026-07-20T12:00:00.000Z");

  interface Grid {
    readonly app: App;
    /** The operator's session, which the listing (not the picture) needs. */
    readonly cookie: string;
  }

  /**
   * The application as deployed, with the cache as a refresh leaves it: two
   * publications, each with a thumbnail key, and the bytes of only one of them
   * on disk.
   */
  async function bootWithGrid(): Promise<Grid> {
    const dir = tempDir();
    mkdirSync(join(dir, "thumbs"), { recursive: true });
    writeFileSync(join(dir, "thumbs", `${CACHED_ID}.jpg`), PIXELS, "utf8");

    const app = await boot(baseEnv(dir, { PUBLIC_ORIGIN: ORIGIN }));
    const db = inspect(dir).db;

    await setOperatorPassword(PASSWORD, createOperatorCredentialStore(db), NOW);

    await createPublicationCacheStore(db).replace(
      [
        {
          id: CACHED_ID,
          mediaType: "IMAGE",
          publishedAt: NOW,
          thumbnailKey: thumbnailKeyFor(CACHED_ID, "image/jpeg"),
        },
        {
          id: MISSING_ID,
          mediaType: "VIDEO",
          publishedAt: EARLIER,
          thumbnailKey: thumbnailKeyFor(MISSING_ID, "image/jpeg"),
        },
      ],
      NOW,
    );

    const opened = await app.server.inject({
      method: "POST",
      url: "/api/session",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ password: PASSWORD }),
    });
    const session = opened.cookies.find(
      (cookie) => cookie.name === SESSION_COOKIE_NAME,
    );
    expect(session).toBeDefined();

    return {
      app,
      cookie: `${SESSION_COOKIE_NAME}=${String(session?.value)}`,
    };
  }

  interface ListedEntry {
    readonly id: string;
    readonly thumbnailUrl?: string;
  }

  /** The grid exactly as the screen reads it, through the contract. */
  async function grid(deps: Grid): Promise<ListedEntry[]> {
    const listed = await deps.app.server.inject({
      method: "GET",
      url: "/api/publications",
      headers: { cookie: deps.cookie },
    });

    expect(listed.statusCode).toBe(200);

    const body = listed.json() as {
      listing: { source: string; items: ListedEntry[] };
    };

    // Read from storage and nothing else (REQ-070): the stub transport in this
    // file would answer a media walk with an account id, and the grid must not
    // depend on it having been asked at all.
    expect(body.listing.source).toBe("cache");

    return body.listing.items;
  }

  it("answers, with the picture, at the address it put in the listing", async () => {
    const deps = await bootWithGrid();
    const entry = (await grid(deps)).find((item) => item.id === CACHED_ID);

    expect(entry?.thumbnailUrl).toBeDefined();
    const address = new URL(String(entry?.thumbnailUrl));

    // Where the defect lived: `memory://bucket/thumbs/<id>.jpg` parses as a URL
    // perfectly well, and no browser opens it.
    expect(["http:", "https:"]).toContain(address.protocol);
    expect(address.origin).toBe(ORIGIN);

    // No cookie on this one, on purpose: an `<img>` in the grid is a plain
    // fetch of a public address, and this route is registered outside the
    // operator's lock exactly as the resource route is.
    const picture = await deps.app.server.inject({
      method: "GET",
      url: address.pathname,
    });

    expect(picture.statusCode).toBe(200);
    expect(picture.body).toBe(PIXELS);
    // Announced as an image, or the browser is left to guess and the cell
    // stays empty with a 200 behind it.
    expect(picture.headers["content-type"]).toBe("image/jpeg");
  });

  it("keeps a publication whose copy is missing, listed and with no picture", async () => {
    const deps = await bootWithGrid();
    const items = await grid(deps);

    // The grid does not break over a copy that is not there: the publication is
    // still on screen and still selectable, which is what makes it a target.
    expect(items.map((item) => item.id)).toEqual([CACHED_ID, MISSING_ID]);
    expect(items.find((item) => item.id === MISSING_ID)?.thumbnailUrl).toBe(
      undefined,
    );
  });
});

/**
 * REQ-144 against the COMPOSED application: a publication older than the first
 * page of the grid is still reachable, by identifier.
 *
 * Here rather than only in `src/http/api/publications.test.ts` because the
 * defect this replaces was never visible to a component test. Reading the first
 * page and matching against it is correct on every fixture small enough to fit
 * in one page, which is every fixture anyone writes by hand. It only fails on an
 * account with a history, where it shows the picture of the recent targets and
 * the marker of an absent thumbnail on all the older ones, with nothing failing
 * anywhere. So the account here is deliberately bigger than a page, the target
 * is the OLDEST publication in it, and the assertion is that the address the
 * composed application answers with fetches the picture from that same process.
 */
describe("REQ-144: the composed application finds a publication by identifier", () => {
  const PASSWORD = "operator-password";
  const ORIGIN = "https://tunnel.example.com";
  const PIXELS = "JPEG-bytes-of-an-old-thumbnail";
  /** More than one page, so "older than the first page" is a real place. */
  const COUNT = PUBLICATION_LISTING_PAGE_SIZE + 6;

  /** Seventeen digits, built as text: that many digits is past a safe integer. */
  function idAt(index: number): string {
    return `181533717554${String(80000 + COUNT - index)}`;
  }

  const OLDEST_ID = idAt(COUNT - 1);

  interface Reader {
    readonly app: App;
    readonly cookie: string;
  }

  /** The application as deployed, with an account that has published a while. */
  async function bootWithHistory(): Promise<Reader> {
    const dir = tempDir();
    mkdirSync(join(dir, "thumbs"), { recursive: true });

    const app = await boot(baseEnv(dir, { PUBLIC_ORIGIN: ORIGIN }));
    const db = inspect(dir).db;

    await setOperatorPassword(PASSWORD, createOperatorCredentialStore(db), NOW);

    for (let index = 0; index < COUNT; index += 1) {
      writeFileSync(join(dir, "thumbs", `${idAt(index)}.jpg`), PIXELS, "utf8");
    }

    await createPublicationCacheStore(db).replace(
      Array.from({ length: COUNT }, (_unused, index) => ({
        id: idAt(index),
        mediaType: "IMAGE",
        publishedAt: new Date(NOW.getTime() - index * 86_400_000),
        thumbnailKey: thumbnailKeyFor(idAt(index), "image/jpeg"),
      })),
      NOW,
    );

    const opened = await app.server.inject({
      method: "POST",
      url: "/api/session",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ password: PASSWORD }),
    });
    const session = opened.cookies.find(
      (cookie) => cookie.name === SESSION_COOKIE_NAME,
    );
    expect(session).toBeDefined();

    return { app, cookie: `${SESSION_COOKIE_NAME}=${String(session?.value)}` };
  }

  it("answers for a target the first page of the grid never reaches", async () => {
    const deps = await bootWithHistory();

    const listed = await deps.app.server.inject({
      method: "GET",
      url: "/api/publications",
      headers: { cookie: deps.cookie },
    });
    const page = listed.json() as { listing: { items: { id: string }[] } };

    // The premise, asserted: the grid is a page of the newest publications, so
    // this target is out of reach of any caller that reads pages and matches.
    expect(page.listing.items.map((item) => item.id)).not.toContain(OLDEST_ID);

    const found = await deps.app.server.inject({
      method: "GET",
      url: `/api/publications/by-id?ids=${OLDEST_ID}`,
      headers: { cookie: deps.cookie },
    });

    expect(found.statusCode).toBe(200);
    const lookup = found.json() as {
      publications: { items: { id: string; thumbnailUrl?: string }[] };
    };

    expect(lookup.publications.items.map((item) => item.id)).toEqual([
      OLDEST_ID,
    ]);

    // And the address answers, from this process, with the picture: the whole
    // of REQ-144 is that the operator SEES the thumbnail of an old target, and
    // an id handed back beside an address nobody serves would not be that.
    const address = new URL(String(lookup.publications.items[0]?.thumbnailUrl));
    expect(address.origin).toBe(ORIGIN);

    const picture = await deps.app.server.inject({
      method: "GET",
      url: address.pathname,
    });

    expect(picture.statusCode).toBe(200);
    expect(picture.body).toBe(PIXELS);
  });

  it("keeps the lookup behind the operator's session, like the grid", async () => {
    const deps = await bootWithHistory();

    // Registered inside the private scope and not by matching its address,
    // which is the distinction `src/http/access.ts` exists to keep.
    const refused = await deps.app.server.inject({
      method: "GET",
      url: `/api/publications/by-id?ids=${OLDEST_ID}`,
    });

    expect(refused.statusCode).toBe(401);
  });
});

/** REQ-208 at the composition root: the HTTP route must receive the direct
 * storage reader, not the lifecycle whose only broad read is `list()`. */
describe("REQ-208: the composed application reads page-scoped automation coverage", () => {
  const PASSWORD = "operator-password";

  it("wires the private route to v2 automation aggregates", async () => {
    const dir = tempDir();
    const app = await boot(baseEnv(dir));
    const database = inspect(dir);

    await setOperatorPassword(
      PASSWORD,
      createOperatorCredentialStore(database.db),
      NOW,
    );

    const insert = database.connection.prepare(
      `INSERT INTO automation_aggregates
       (id, definition, publication_target, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
    );
    const aggregate = (
      id: string,
      state: "active" | "draft",
      target: string,
    ) => ({
      schema_version: 2,
      kind: "automation",
      id,
      state,
      trigger: {
        type: "comment",
        target,
        match: { keywords: ["guide"], mode: "contains" },
      },
      rules: { once_per_contact: false },
      steps: [
        {
          id: "message",
          action: "send_dm",
          message: { text: "Here" },
        },
      ],
    });
    insert.run(
      "own-active",
      JSON.stringify(aggregate("own-active", "active", "post-1")),
      "post-1",
      NOW.getTime(),
      NOW.getTime(),
    );
    // A publication outside the page asked for: the route must not fold it
    // into the coverage of the two it was asked about.
    insert.run(
      "elsewhere",
      JSON.stringify(aggregate("elsewhere", "active", "post-9")),
      "post-9",
      NOW.getTime(),
      NOW.getTime(),
    );

    const opened = await app.server.inject({
      method: "POST",
      url: "/api/session",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ password: PASSWORD }),
    });
    const session = opened.cookies.find(
      (cookie) => cookie.name === SESSION_COOKIE_NAME,
    );

    const response = await app.server.inject({
      method: "GET",
      url: "/api/publications/automation-coverage?ids=post-1&ids=post-2",
      headers: { cookie: `${SESSION_COOKIE_NAME}=${String(session?.value)}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      coverage: [
        {
          publicationId: "post-1",
          active: 1,
          inactive: 0,
          automations: [{ id: "own-active", enabled: true }],
        },
        {
          publicationId: "post-2",
          active: 0,
          inactive: 0,
          automations: [],
        },
      ],
      // The other half of the same answer, wired through the composed process
      // (REQ-294): both rows parse here, so there is nothing to report, and the
      // field travels anyway rather than appearing only on a bad day.
      unreadable: [],
    });
  });
});

/**
 * REQ-260 against the COMPOSED application: the target that reaches storage is
 * a publication IDENTIFIER, and an address is refused rather than stored.
 *
 * This block used to prove the opposite (REQ-130): the process resolved a URL
 * into an identifier before writing, because a URL stored as text produced an
 * automation that installed, reported itself enabled and never fired. Phase 3l
 * removed the URL from the vocabulary instead, so what has to be asserted at
 * the junction is that the removal reaches the ROUTE the screen posts to, and
 * not only the schema module.
 */
describe("REQ-260: the composed application stores an identifier, not an address", () => {
  const PASSWORD = "operator-password";
  const PUBLICATION_ID = "18045384452548993";
  const PUBLICATION_URL = "https://www.instagram.com/p/DYBHQBile6_/";

  function automationTargeting(target: string): unknown {
    return {
      schema_version: 2,
      kind: "automation",
      id: "post-de-agosto",
      state: "active",
      trigger: {
        type: "comment",
        target,
        match: { keywords: ["quero"], mode: "contains" },
      },
      rules: { once_per_contact: true },
      steps: [
        {
          id: "private-message",
          action: "send_dm",
          message: { text: "Olá" },
        },
      ],
    };
  }

  /** The application as deployed, with a credential and an operator session. */
  async function bootWithSession(): Promise<{ app: App; cookie: string }> {
    const dir = tempDir();
    const app = await boot(
      baseEnv(dir, {
        META_ACCESS_TOKEN: ENV_TOKEN,
        INSTAGRAM_ACCOUNT_ID: ACCOUNT_ID,
      }),
      // Nothing on this path asks the platform anything any more, and that is
      // half of REQ-260: creating an automation costs no request and works
      // with the platform unreachable.
      () => Promise.resolve({ status: 200, body: { id: ACCOUNT_ID } }),
    );

    await setOperatorPassword(
      PASSWORD,
      createOperatorCredentialStore(inspect(dir).db),
      NOW,
    );

    const opened = await app.server.inject({
      method: "POST",
      url: "/api/session",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ password: PASSWORD }),
    });
    const session = opened.cookies.find(
      (cookie) => cookie.name === SESSION_COOKIE_NAME,
    );
    expect(session).toBeDefined();

    const cookie = `${SESSION_COOKIE_NAME}=${String(session?.value)}`;

    return { app, cookie };
  }

  it("stores the identifier the webhook will carry, with nothing resolved", async () => {
    const { app, cookie } = await bootWithSession();

    const response = await app.server.inject({
      method: "POST",
      url: "/api/automations",
      headers: { "content-type": "application/json", cookie },
      payload: JSON.stringify({
        definition: automationTargeting(PUBLICATION_ID),
      }),
    });

    expect(response.statusCode).toBe(200);

    // And it is what was WRITTEN: read again through the contract, with nothing
    // restarted.
    const read = await app.server.inject({
      method: "GET",
      url: "/api/automations/post-de-agosto",
      headers: { cookie },
    });

    expect(
      (
        read.json() as {
          automation: { definition: { trigger: { target: string } } };
        }
      ).automation.definition.trigger.target,
    ).toBe(PUBLICATION_ID);
  });

  it("refuses an address through the real route, and stores nothing", async () => {
    const { app, cookie } = await bootWithSession();

    const response = await app.server.inject({
      method: "POST",
      url: "/api/automations",
      headers: { "content-type": "application/json", cookie },
      payload: JSON.stringify({
        definition: automationTargeting(PUBLICATION_URL),
      }),
    });

    // The schema's refusal, arriving as the route's own 422: an address is not
    // a target this build knows how to store.
    expect(response.statusCode).toBe(422);
    expect(response.json<{ error: string }>().error).toBe("invalid_definition");

    const listed = await app.server.inject({
      method: "GET",
      url: "/api/automations",
      headers: { cookie },
    });

    expect(listed.json<{ automations: unknown[] }>().automations).toEqual([]);
  });
});

/**
 * REQ-213 supersedes the v1 copy choice: the composed v2 write owns its
 * delivery and cannot create or point at a flow as a side effect.
 */
describe("REQ-213: the composed aggregate owns its delivery", () => {
  it("stores one aggregate without changing the flow catalogue", async () => {
    const dir = tempDir();
    const app = await boot(baseEnv(dir));
    await setOperatorPassword(
      "operator-password",
      createOperatorCredentialStore(inspect(dir).db),
      NOW,
    );
    const opened = await app.server.inject({
      method: "POST",
      url: "/api/session",
      payload: { password: "operator-password" },
    });
    const session = opened.cookies.find(
      (cookie) => cookie.name === SESSION_COOKIE_NAME,
    );
    const cookie = SESSION_COOKIE_NAME + "=" + String(session?.value);
    const response = await app.server.inject({
      method: "POST",
      url: "/api/automations",
      headers: { cookie },
      payload: {
        definition: {
          schema_version: 2,
          kind: "automation",
          id: "post-de-agosto",
          state: "active",
          trigger: {
            type: "comment",
            target: "17895695668004550",
            match: { keywords: ["quero"], mode: "contains" },
          },
          rules: { once_per_contact: true },
          steps: [
            {
              id: "private-message",
              action: "send_dm",
              message: { text: "Olá" },
            },
          ],
        },
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).not.toHaveProperty("copy");
    const flows = await app.server.inject({
      method: "GET",
      url: "/api/flows",
      headers: { cookie },
    });
    expect(flows.statusCode).toBe(404);
  });
});
