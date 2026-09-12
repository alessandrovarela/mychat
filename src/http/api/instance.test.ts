import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../../app.js";
import type { App } from "../../app.js";
import {
  createOperatorCredentialStore,
  setOperatorPassword,
  verifyOperatorPassword,
} from "../../auth/credential.js";
import { SESSION_COOKIE_NAME } from "../../auth/session.js";
import {
  DEFAULT_QUESTIONS,
  DEFAULT_WAIT_HOURS,
  INSTANCE_SETTINGS_REFUSALS,
  MAX_WAIT_HOURS,
  MIN_QUESTIONS,
  MIN_WAIT_HOURS,
} from "../../config/instance-settings.js";
import { createSetupStoragePreference } from "../../config/instance-settings.js";
import type { InstanceSettingsPreference } from "../../config/instance-settings.js";
import { LIMIT_DEFAULTS } from "../../config/limits.js";
import type { TimeZonePreference } from "../../config/timezone.js";
import type { LocalePreference } from "../../i18n/preference.js";
import type { TriggerSwitchPreference } from "../../config/trigger-switches.js";
import type { ActiveAutomation } from "../../flows/schema.js";
import {
  createAutomationAggregateRepository,
  createDurableWorkStore,
  createTimeZonePreferenceStore,
  openDatabase,
} from "../../storage/index.js";
import type { DatabaseHandle } from "../../storage/index.js";
import {
  INSTANCE_ROUTE,
  INSTANCE_INTEGRATIONS_ROUTE,
  INSTANCE_CONFIGURATION_ROUTE,
  INSTANCE_SETUP_ROUTE,
  INSTANCE_SETTINGS_ROUTE,
  INSTANCE_TRIGGERS_ROUTE,
  registerInstanceRoutes,
  registerSetupRoutes,
} from "./instance.js";

/**
 * REQ-166 and REQ-183 at the seam that matters: the zone the process was
 * CONFIGURED with is the zone this route answers, until somebody changes it
 * here — and from that moment on, with no restart, it is the zone the
 * aggregation cuts its buckets in.
 *
 * Nothing is injected here, and that is the whole point. A double would prove
 * that a route returns what it was handed, which is the shape of defect this
 * phase exists to close: a capability proven in isolation, never wired, green
 * suite, a screen naming a zone nobody configured. So the environment carries
 * the variable, `createApp` composes the real router, and the answer is read
 * through the contract with an operator's session, exactly as Settings reads
 * it.
 *
 * The last block is the one REQ-183 lives or dies by, and it deliberately does
 * NOT stop at this route: it writes a zone here and then reads
 * `GET /api/dashboard/metrics` off the SAME running process. A route that
 * stored the choice while the metrics went on being cut on the zone the process
 * booted with would pass every assertion about this route and ship the defect
 * whole.
 */

const APP_SECRET = "app-secret";
const VERIFY_TOKEN = "verify-me";
const PASSWORD = "operator-password";
const NOW = new Date("2026-08-04T12:00:00.000Z");

const OPERATOR_ZONE = "America/Sao_Paulo";

/** Nine hours ahead of Sao Paulo: no hour of one is an hour of the other. */
const AHEAD_ZONE = "Asia/Tokyo";

/** What every instance falls back to, and what UTC has to keep meaning. */
const DEFAULT_ZONE = "UTC";

/** A name no calendar data knows, spelled the way a typo spells it. */
const IMPOSSIBLE_ZONE = "America/Sao_Paolo";

const clock = { now: (): Date => NOW };

const dirs: string[] = [];
const apps: App[] = [];
const handles: DatabaseHandle[] = [];
const setupServers: FastifyInstance[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "mychat-instance-"));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const app of apps.splice(0)) {
    await app.close();
  }
  for (const handle of handles.splice(0)) {
    handle.close();
  }
  for (const server of setupServers.splice(0)) {
    await server.close();
  }
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

async function setupServer(initiallyComplete = false): Promise<{
  readonly server: FastifyInstance;
  readonly credentials: ReturnType<typeof createOperatorCredentialStore>;
}> {
  const handle = openDatabase({ databasePath: ":memory:" });
  handles.push(handle);
  const credentials = createOperatorCredentialStore(handle.db);
  let complete = initiallyComplete;
  const server = Fastify({ logger: false });
  setupServers.push(server);

  registerInstanceRoutes(
    server,
    {} as TimeZonePreference,
    {} as TriggerSwitchPreference,
    {} as InstanceSettingsPreference,
    {
      state: {
        isComplete: () => Promise.resolve(complete),
        complete: () => {
          complete = true;
          return Promise.resolve();
        },
      },
      credentials,
      now: () => NOW,
    },
  );
  await server.ready();
  return { server, credentials };
}

describe("REQ-436/REQ-437/REQ-439: secret-safe integration diagnostics", () => {
  it("reports pending and failed integrations with stable codes only", async () => {
    const server = Fastify({ logger: false });
    setupServers.push(server);
    registerInstanceRoutes(
      server,
      {} as TimeZonePreference,
      {} as TriggerSwitchPreference,
      {} as InstanceSettingsPreference,
      undefined,
      {
        read: () =>
          Promise.resolve({
            meta: { status: "pending" as const },
            storage: {
              driver: "r2" as const,
              status: "failure" as const,
              reason: "unauthorized",
            },
          }),
      },
    );
    await server.ready();

    const response = await server.inject({
      method: "GET",
      url: INSTANCE_INTEGRATIONS_ROUTE,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      meta: { status: "pending" },
      storage: { driver: "r2", status: "failure", reason: "unauthorized" },
    });
    expect(response.body).not.toMatch(/token|secret|endpoint|bucket/i);
  });

  it("does not register a diagnostic route until composition supplies one", async () => {
    const { server } = await setupServer();

    const response = await server.inject({
      method: "GET",
      url: INSTANCE_INTEGRATIONS_ROUTE,
    });

    expect(response.statusCode).toBe(404);
  });

  it("answers the installed server version and fresh pending checks from the composed application", async () => {
    const reader = await boot(undefined, false);
    const [configuration, diagnostics] = await Promise.all([
      reader.app.server.inject({
        method: "GET",
        url: INSTANCE_CONFIGURATION_ROUTE,
        headers: { cookie: reader.cookie },
      }),
      reader.app.server.inject({
        method: "GET",
        url: INSTANCE_INTEGRATIONS_ROUTE,
        headers: { cookie: reader.cookie },
      }),
    ]);

    expect(configuration.statusCode).toBe(200);
    expect(configuration.json()).toMatchObject({
      installedVersion: "development",
      onboarding: {
        passwordSet: true,
        webhookReady: false,
        complete: false,
      },
    });
    expect(diagnostics.statusCode).toBe(200);
    expect(diagnostics.json()).toEqual({
      meta: { status: "pending" },
      storage: { driver: "local", status: "pending" },
    });
  });
});

describe("REQ-436/REQ-441: first setup is the only public configuration route", () => {
  it("tests R2 read-only before persisting and never returns its credentials", async () => {
    const server = Fastify({ logger: false });
    setupServers.push(server);
    let complete = false;
    let stored: unknown;
    registerSetupRoutes(server, {
      state: {
        isComplete: () => Promise.resolve(complete),
        complete: () => {
          complete = true;
          return Promise.resolve();
        },
      },
      credentials: createOperatorCredentialStore(
        openDatabase({ databasePath: ":memory:" }).db,
      ),
      storage: createSetupStoragePreference({
        store: {
          read: () => Promise.resolve(undefined),
          write: (value) => {
            stored = value;
            return Promise.resolve();
          },
        },
        check: () => Promise.resolve({ status: "healthy" }),
      }),
      now: () => NOW,
    });
    await server.ready();

    const response = await server.inject({
      method: "POST",
      url: INSTANCE_SETUP_ROUTE,
      headers: { "content-type": "application/json" },
      payload: {
        password: PASSWORD,
        passwordConfirmation: PASSWORD,
        storage: {
          driver: "r2",
          endpoint: "https://account.r2.cloudflarestorage.com",
          accessKeyId: "key-id",
          secretAccessKey: "never-return-this",
          bucket: "assets",
        },
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ complete: true });
    expect(response.body).not.toContain("never-return-this");
    expect(stored).toMatchObject({ driver: "r2", bucket: "assets" });
  });
});

interface Reader {
  readonly app: App;
  readonly cookie: string;
}

describe("The private configuration boundary masks stored secrets", () => {
  it("only persists a replacement after its credential check succeeds", async () => {
    const handle = openDatabase({ databasePath: ":memory:" });
    handles.push(handle);
    const operatorCredentials = createOperatorCredentialStore(handle.db);
    await setOperatorPassword(PASSWORD, operatorCredentials, NOW);
    let metaWrites = 0;
    let storageWrites = 0;
    const server = Fastify({ logger: false });
    setupServers.push(server);
    registerInstanceRoutes(
      server,
      {} as TimeZonePreference,
      {} as TriggerSwitchPreference,
      {} as InstanceSettingsPreference,
      undefined,
      undefined,
      {
        operatorCredentials,
        platformCredentials: {
          read: () => Promise.resolve(undefined),
          write: () => {
            metaWrites += 1;
            return Promise.resolve();
          },
          recordRefresh: () => Promise.resolve(),
          recordCheck: () => Promise.resolve(),
          remove: () => Promise.resolve(),
        },
        storage: {
          read: () => Promise.resolve(undefined),
          write: () => {
            storageWrites += 1;
            return Promise.resolve();
          },
          remove: () => Promise.resolve(),
        },
        integration: {
          read: () =>
            Promise.resolve({
              publicOrigin: "https://panel.example.test",
              publicOriginVerifiedAt: NOW.toISOString(),
            }),
          choose: (value) => Promise.resolve(value),
        },
        now: () => NOW,
        testMeta: () => Promise.resolve({ status: "healthy" }),
        testStorage: () =>
          Promise.resolve({ status: "failure", reason: "unauthorized" }),
      },
    );
    await server.ready();
    const meta = await server.inject({
      method: "POST",
      url: INSTANCE_CONFIGURATION_ROUTE,
      payload: {
        action: "replace_meta",
        authPath: "instagram_login",
        accountId: "1784",
        accessToken: "secret",
      },
    });
    expect(meta.json()).toEqual({ ok: true, status: "healthy" });
    expect(metaWrites).toBe(1);
    const storage = await server.inject({
      method: "POST",
      url: INSTANCE_CONFIGURATION_ROUTE,
      payload: {
        action: "replace_storage",
        driver: "r2",
        endpoint: "https://r2.example.test",
        accessKeyId: "key",
        secretAccessKey: "secret",
        bucket: "assets",
      },
    });
    expect(storage.json()).toEqual({
      ok: false,
      status: "failure",
      reason: "unauthorized",
    });
    expect(storageWrites).toBe(0);
  });

  it("tests before saving, replaces and removes integrations without returning secrets", async () => {
    const reader = await boot(undefined, false);
    const secret = "meta-token-that-must-not-leak";

    const origin = await reader.app.server.inject({
      method: "POST",
      url: INSTANCE_CONFIGURATION_ROUTE,
      headers: { cookie: reader.cookie, "content-type": "application/json" },
      payload: {
        action: "set_public_origin",
        publicOrigin: "https://panel.example.test",
      },
    });
    expect(origin.statusCode).toBe(200);
    const verified = await reader.app.server.inject({
      method: "POST",
      url: INSTANCE_CONFIGURATION_ROUTE,
      headers: { cookie: reader.cookie, "content-type": "application/json" },
      payload: { action: "test_public_origin" },
    });
    expect(verified.json()).toMatchObject({ ok: true });

    const replaced = await reader.app.server.inject({
      method: "POST",
      url: INSTANCE_CONFIGURATION_ROUTE,
      headers: { cookie: reader.cookie, "content-type": "application/json" },
      payload: {
        action: "replace_meta",
        authPath: "instagram_login",
        accountId: "1784",
        accessToken: secret,
      },
    });
    expect(replaced.statusCode).toBe(200);
    expect(replaced.body).not.toContain(secret);

    const tested = await reader.app.server.inject({
      method: "POST",
      url: INSTANCE_CONFIGURATION_ROUTE,
      headers: { cookie: reader.cookie, "content-type": "application/json" },
      payload: {
        action: "test_meta",
        authPath: "instagram_login",
        accountId: "1784",
        accessToken: secret,
      },
    });
    expect(tested.statusCode).toBe(200);
    expect(tested.body).not.toContain(secret);

    const state = await reader.app.server.inject({
      method: "GET",
      url: INSTANCE_CONFIGURATION_ROUTE,
      headers: { cookie: reader.cookie },
    });
    expect(state.json()).toMatchObject({
      meta: { configured: false },
      webhookVerifyToken: false,
    });
    expect(state.body).not.toContain(secret);

    const removed = await reader.app.server.inject({
      method: "POST",
      url: INSTANCE_CONFIGURATION_ROUTE,
      headers: { cookie: reader.cookie, "content-type": "application/json" },
      payload: { action: "remove_meta" },
    });
    expect(removed.statusCode).toBe(200);
    expect(removed.json()).toEqual({ ok: true });
  });

  it("updates storage, webhook values and the App Secret without exposing secrets", async () => {
    const reader = await boot();
    const token = "webhook-token-that-must-not-leak";
    const appSecret = "app-secret-that-must-not-leak";
    const actions = [
      {
        action: "set_public_origin",
        publicOrigin: "https://panel.example.test",
      },
      { action: "test_public_origin" },
      { action: "replace_storage", driver: "local" },
      { action: "set_webhook_verify_token", webhookVerifyToken: token },
      { action: "set_meta_app_secret", metaAppSecret: appSecret },
    ];
    for (const change of actions) {
      const response = await reader.app.server.inject({
        method: "POST",
        url: INSTANCE_CONFIGURATION_ROUTE,
        headers: { cookie: reader.cookie, "content-type": "application/json" },
        payload: change,
      });
      expect(response.statusCode).toBe(200);
      expect(response.body).not.toContain(token);
    }
    const state = await reader.app.server.inject({
      method: "GET",
      url: INSTANCE_CONFIGURATION_ROUTE,
      headers: { cookie: reader.cookie },
    });
    expect(state.json()).toMatchObject({
      storage: { driver: "local", configured: true },
      publicOrigin: "https://panel.example.test",
      webhookVerifyToken: true,
      meta: { appSecretConfigured: true },
    });
    expect(state.body).not.toContain(token);
    expect(state.body).not.toContain(appSecret);

    const removed = await reader.app.server.inject({
      method: "POST",
      url: INSTANCE_CONFIGURATION_ROUTE,
      headers: { cookie: reader.cookie, "content-type": "application/json" },
      payload: { action: "remove_meta_app_secret" },
    });
    expect(removed.statusCode).toBe(200);
    const afterRemoval = await reader.app.server.inject({
      method: "GET",
      url: INSTANCE_CONFIGURATION_ROUTE,
      headers: { cookie: reader.cookie },
    });
    expect(afterRemoval.json()).toMatchObject({
      meta: { appSecretConfigured: false },
    });
  });

  it("removes the dependent webhook token with the public origin", async () => {
    const reader = await boot(undefined, false);
    const headers = {
      cookie: reader.cookie,
      "content-type": "application/json",
    };
    for (const payload of [
      {
        action: "set_public_origin",
        publicOrigin: "https://panel.example.test",
      },
      { action: "test_public_origin" },
      { action: "set_webhook_verify_token", webhookVerifyToken: "token" },
      { action: "remove_public_origin" },
    ]) {
      const response = await reader.app.server.inject({
        method: "POST",
        url: INSTANCE_CONFIGURATION_ROUTE,
        headers,
        payload,
      });
      expect(response.statusCode).toBe(200);
    }
    const state = await reader.app.server.inject({
      method: "GET",
      url: INSTANCE_CONFIGURATION_ROUTE,
      headers: { cookie: reader.cookie },
    });
    expect(state.json()).toMatchObject({ webhookVerifyToken: false });
    expect(state.json()).not.toHaveProperty("publicOrigin");
  });

  it("generates a webhook token without persisting or exposing it on reads", async () => {
    const reader = await boot(undefined, false);
    await reader.app.server.inject({
      method: "POST",
      url: INSTANCE_CONFIGURATION_ROUTE,
      headers: { cookie: reader.cookie, "content-type": "application/json" },
      payload: {
        action: "set_public_origin",
        publicOrigin: "https://panel.example.test",
      },
    });
    await reader.app.server.inject({
      method: "POST",
      url: INSTANCE_CONFIGURATION_ROUTE,
      headers: { cookie: reader.cookie, "content-type": "application/json" },
      payload: { action: "test_public_origin" },
    });
    const generated = await reader.app.server.inject({
      method: "POST",
      url: INSTANCE_CONFIGURATION_ROUTE,
      headers: { cookie: reader.cookie, "content-type": "application/json" },
      payload: { action: "generate_webhook_verify_token" },
    });
    expect(generated.statusCode).toBe(200);
    expect(generated.json()).toMatchObject({
      ok: true,
      generatedWebhookVerifyToken: expect.any(String),
    });
    const state = await reader.app.server.inject({
      method: "GET",
      url: INSTANCE_CONFIGURATION_ROUTE,
      headers: { cookie: reader.cookie },
    });
    expect(state.json()).toMatchObject({ webhookVerifyToken: false });
    expect(state.body).not.toContain(
      generated.json().generatedWebhookVerifyToken,
    );
  });
});

/** The application as deployed, plus an operator who can open the panel. */
function boot(zone?: string, legacyIntegrations = true): Promise<Reader> {
  return bootIn(tempDir(), zone, legacyIntegrations);
}

/**
 * The same, over a directory the caller keeps: booting twice over one database
 * is what a restart IS, and it is the only way to prove that a choice outlives
 * the process that stored it.
 */
async function bootIn(
  dir: string,
  zone?: string,
  legacyIntegrations = true,
): Promise<Reader> {
  const app = await createApp(
    {
      ...(legacyIntegrations
        ? {
            META_APP_SECRET: APP_SECRET,
            WEBHOOK_VERIFY_TOKEN: VERIFY_TOKEN,
          }
        : {}),
      DATABASE_PATH: join(dir, "mychat.db"),
      ASSETS_DIR: join(dir, "assets"),
      THUMBNAILS_DIR: join(dir, "thumbs"),
      // Far longer than this file takes, so no armed loop races a read.
      SWEEP_INTERVAL_MS: "60000",
      ...(zone === undefined ? {} : { MYCHAT_TIMEZONE: zone }),
    },
    {
      clock,
      publicAddressFetch: () =>
        Promise.resolve(
          new Response(JSON.stringify({ service: "mychat" }), { status: 200 }),
        ),
    },
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
  const session = opened.cookies.find(
    (cookie) => cookie.name === SESSION_COOKIE_NAME,
  );
  expect(session).toBeDefined();

  return { app, cookie: `${SESSION_COOKIE_NAME}=${String(session?.value)}` };
}

interface InstanceState {
  readonly timeZone: string;
  readonly timeZones: readonly string[];
}

interface TriggerState {
  readonly all: { readonly enabled: boolean; readonly updatedAt?: string };
  readonly comments: { readonly enabled: boolean; readonly updatedAt?: string };
  readonly directMessages: {
    readonly enabled: boolean;
    readonly updatedAt?: string;
  };
}

async function triggersOf(reader: Reader): Promise<TriggerState> {
  const response = await reader.app.server.inject({
    method: "GET",
    url: INSTANCE_TRIGGERS_ROUTE,
    headers: { cookie: reader.cookie },
  });
  expect(response.statusCode).toBe(200);
  return response.json<TriggerState>();
}

async function chooseTrigger(
  reader: Reader,
  name: "all" | "comments" | "directMessages",
  enabled: boolean,
): Promise<TriggerState> {
  const response = await reader.app.server.inject({
    method: "POST",
    url: INSTANCE_TRIGGERS_ROUTE,
    headers: { cookie: reader.cookie, "content-type": "application/json" },
    payload: JSON.stringify({ name, enabled }),
  });
  expect(response.statusCode).toBe(200);
  return response.json<TriggerState>();
}

async function settingsOf(reader: Reader): Promise<InstanceState> {
  const response = await reader.app.server.inject({
    method: "GET",
    url: INSTANCE_ROUTE,
    headers: { cookie: reader.cookie },
  });

  expect(response.statusCode).toBe(200);

  return response.json<InstanceState>();
}

/** The Settings screen writing the zone, over the declared contract. */
function chooseZone(
  reader: Reader,
  timeZone: string,
): Promise<{ statusCode: number; body: string }> {
  return reader.app.server
    .inject({
      method: "POST",
      url: INSTANCE_ROUTE,
      headers: { cookie: reader.cookie, "content-type": "application/json" },
      payload: JSON.stringify({ timeZone }),
    })
    .then((response) => ({
      statusCode: response.statusCode,
      body: response.body,
    }));
}

/** The first bucket of the weekly axis: a local midnight, in the zone that
 * cut it. It is the fact no relabelling can fake. */
async function firstDayBucketOf(reader: Reader): Promise<string> {
  const response = await reader.app.server.inject({
    method: "GET",
    url: "/api/dashboard/metrics?range=last_7_days",
    headers: { cookie: reader.cookie },
  });

  expect(response.statusCode).toBe(200);

  const answer = response.json<{
    metrics: { window: { zone: string }; events: { buckets: string[] } };
  }>();

  const first = answer.metrics.events.buckets[0];
  expect(first).toBeDefined();

  return String(first);
}

async function metricsZoneOf(reader: Reader): Promise<string> {
  const response = await reader.app.server.inject({
    method: "GET",
    url: "/api/dashboard/metrics?range=last_7_days",
    headers: { cookie: reader.cookie },
  });

  return response.json<{ metrics: { window: { zone: string } } }>().metrics
    .window.zone;
}

describe("REQ-437/REQ-441: setup never reveals a stored credential", () => {
  it("offers and persists the locale and time zone chosen during first setup", async () => {
    const handle = openDatabase({ databasePath: ":memory:" });
    handles.push(handle);
    const server = Fastify({ logger: false });
    setupServers.push(server);
    let locale = "en";
    let timeZone = "UTC";
    registerSetupRoutes(server, {
      state: {
        isComplete: () => Promise.resolve(false),
        complete: () => Promise.resolve(),
      },
      credentials: createOperatorCredentialStore(handle.db),
      locale: {
        inForce: () => Promise.resolve({ locale, source: "stored" }),
        available: () => ["en", "pt-BR"],
        apply: () => Promise.resolve({ locale, source: "stored" }),
        choose: (next) => {
          locale = next;
          return Promise.resolve({ ok: true, locale: next });
        },
      } as LocalePreference,
      timeZone: {
        inForce: () => Promise.resolve({ timeZone, source: "stored" as const }),
        choose: (next) => {
          timeZone = next;
          return Promise.resolve({ ok: true, timeZone: next });
        },
      },
      now: () => NOW,
    });
    await server.ready();

    const offered = await server.inject({
      method: "GET",
      url: INSTANCE_SETUP_ROUTE,
    });
    expect(offered.json()).toMatchObject({
      complete: false,
      locale: "en",
      locales: ["en", "pt-BR"],
      timeZone: "UTC",
      timeZones: expect.arrayContaining(["UTC"]),
    });

    const completed = await server.inject({
      method: "POST",
      url: INSTANCE_SETUP_ROUTE,
      payload: {
        password: PASSWORD,
        passwordConfirmation: PASSWORD,
        locale: "pt-BR",
        timeZone: "America/Toronto",
      },
    });
    expect(completed.statusCode).toBe(200);
    expect(locale).toBe("pt-BR");
    expect(timeZone).toBe("America/Toronto");
  });

  it("completes first setup from a confirmed password and then refuses reuse", async () => {
    const { server, credentials } = await setupServer();

    const initial = await server.inject({
      method: "GET",
      url: INSTANCE_SETUP_ROUTE,
    });
    expect(initial.statusCode).toBe(200);
    expect(initial.json()).toEqual({ complete: false });

    const mismatch = await server.inject({
      method: "POST",
      url: INSTANCE_SETUP_ROUTE,
      payload: {
        password: PASSWORD,
        passwordConfirmation: "different-password",
      },
    });
    expect(mismatch.statusCode).toBe(422);
    expect(mismatch.json()).toEqual({
      error: "password_confirmation_mismatch",
    });

    const tooShort = await server.inject({
      method: "POST",
      url: INSTANCE_SETUP_ROUTE,
      payload: { password: "123456", passwordConfirmation: "123456" },
    });
    expect(tooShort.statusCode).toBe(422);
    expect(tooShort.json()).toEqual({ error: "too_short" });

    const completed = await server.inject({
      method: "POST",
      url: INSTANCE_SETUP_ROUTE,
      payload: { password: PASSWORD, passwordConfirmation: PASSWORD },
    });
    expect(completed.statusCode).toBe(200);
    // Neither a password nor its derivation can leave the setup boundary.
    expect(completed.json()).toEqual({ complete: true });
    await expect(verifyOperatorPassword(PASSWORD, credentials)).resolves.toBe(
      true,
    );

    const reused = await server.inject({
      method: "POST",
      url: INSTANCE_SETUP_ROUTE,
      payload: { password: PASSWORD, passwordConfirmation: PASSWORD },
    });
    expect(reused.statusCode).toBe(422);
    expect(reused.json()).toEqual({ error: "setup_already_complete" });
  });

  it("rejects an inconsistent installation marker without replacing its password", async () => {
    const { server, credentials } = await setupServer();
    await setOperatorPassword(PASSWORD, credentials, NOW);

    const missing = await server.inject({
      method: "POST",
      url: INSTANCE_SETUP_ROUTE,
      payload: {
        password: "changed-password",
        passwordConfirmation: "changed-password",
      },
    });
    expect(missing.statusCode).toBe(422);
    expect(missing.json()).toEqual({ error: "setup_already_complete" });

    await expect(verifyOperatorPassword(PASSWORD, credentials)).resolves.toBe(
      true,
    );
    await expect(
      verifyOperatorPassword("changed-password", credentials),
    ).resolves.toBe(false);
  });
});

describe("REQ-166: the instance says which zone is in force", () => {
  it("answers the zone the environment configured", async () => {
    const reader = await boot(OPERATOR_ZONE);

    // The identifier and not a word about it: the sentence an operator reads
    // belongs to the screen and to the catalogue.
    expect((await settingsOf(reader)).timeZone).toBe(OPERATOR_ZONE);
  });

  it("answers UTC only when UTC is what is in force", async () => {
    const reader = await boot();

    // The default is a real answer and not a placeholder: an installation that
    // configured nothing IS on UTC, and the screen may say so.
    expect((await settingsOf(reader)).timeZone).toBe(DEFAULT_ZONE);
  });

  it("answers nothing to a caller with no session", async () => {
    const reader = await boot(OPERATOR_ZONE);

    const response = await reader.app.server.inject({
      method: "GET",
      url: INSTANCE_ROUTE,
    });

    // Private by being registered inside the guarded scope, like every route
    // of the panel: the sign-in screen reads the language and nothing else.
    expect(response.statusCode).toBe(401);
  });

  it("refuses a write from a caller with no session", async () => {
    const reader = await boot(OPERATOR_ZONE);

    const response = await reader.app.server.inject({
      method: "POST",
      url: INSTANCE_ROUTE,
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ timeZone: AHEAD_ZONE }),
    });

    expect(response.statusCode).toBe(401);
    // And nothing was stored on the way to the refusal.
    expect((await settingsOf(reader)).timeZone).toBe(OPERATOR_ZONE);
  });
});

describe("REQ-183: the zone offered is a zone this process can count in", () => {
  it("lists the zone in force among the ones it offers", async () => {
    const reader = await boot(OPERATOR_ZONE);
    const state = await settingsOf(reader);

    // A selector whose value matches no option shows the FIRST option instead,
    // which would put a zone nobody configured on the screen as fact. The
    // runtime's own list is not enough for this: it carries canonical names
    // only, and `Asia/Kolkata` is a name it answers `Asia/Calcutta` for.
    expect(state.timeZones).toContain(state.timeZone);
    // UTC is the default of every installation and is NOT in the runtime's
    // list (measured: 418 identifiers, all with an area prefix). Without it an
    // instance could never be switched back to what it started as.
    expect(state.timeZones).toContain(DEFAULT_ZONE);
    expect(state.timeZones).toContain(AHEAD_ZONE);
    expect([...state.timeZones].sort()).toEqual([...state.timeZones]);
  });

  it("offers the zone the environment named even when it is an alias", async () => {
    // `Asia/Kolkata` is a name every formatter accepts and the runtime's list
    // does not carry: it answers `Asia/Calcutta` for it.
    const reader = await boot("Asia/Kolkata");
    const state = await settingsOf(reader);

    expect(state.timeZone).toBe("Asia/Kolkata");
    expect(state.timeZones).toContain("Asia/Kolkata");
  });
});

describe("REQ-183: the zone changes here and holds with no restart", () => {
  it("answers the stored zone from the next read on", async () => {
    const reader = await boot(OPERATOR_ZONE);

    const written = await chooseZone(reader, AHEAD_ZONE);

    expect(written.statusCode).toBe(200);
    // The answer to the write is the answer the GET gives, so a screen that
    // adopts it cannot end up showing a zone the instance did not keep.
    expect(JSON.parse(written.body)).toEqual(await settingsOf(reader));
    expect((await settingsOf(reader)).timeZone).toBe(AHEAD_ZONE);
  });

  it("cuts the next aggregation in the zone just chosen, in the same process", async () => {
    const reader = await boot(OPERATOR_ZONE);

    // Sao Paulo is three hours behind UTC, so its midnights are at 03:00 UTC.
    const before = await firstDayBucketOf(reader);
    expect(before.endsWith("T03:00:00.000Z")).toBe(true);
    expect(await metricsZoneOf(reader)).toBe(OPERATOR_ZONE);

    expect((await chooseZone(reader, AHEAD_ZONE)).statusCode).toBe(200);

    // Nine hours ahead: Tokyo's midnights are at 15:00 UTC of the day before.
    // Nothing was restarted between these two reads, and the buckets moved —
    // which is the requirement, and what a label copied from the settings
    // could not fake.
    const after = await firstDayBucketOf(reader);
    expect(after.endsWith("T15:00:00.000Z")).toBe(true);
    expect(after).not.toBe(before);
    expect(await metricsZoneOf(reader)).toBe(AHEAD_ZONE);
  });

  it("keeps the choice when the environment says otherwise", async () => {
    const dir = tempDir();

    // Two processes over one database, which is what a restart is: the second
    // one is even configured with a different zone, and the operator's choice
    // still wins (the environment is the INITIAL value and nothing more).
    const first = await bootIn(dir, OPERATOR_ZONE);
    expect((await chooseZone(first, AHEAD_ZONE)).statusCode).toBe(200);

    const second = await bootIn(dir, DEFAULT_ZONE);

    expect((await settingsOf(second)).timeZone).toBe(AHEAD_ZONE);
    expect(await metricsZoneOf(second)).toBe(AHEAD_ZONE);
  });
});

describe("REQ-183: an impossible zone is refused, naming the field", () => {
  it("refuses a zone this build's calendar data does not know", async () => {
    const reader = await boot(OPERATOR_ZONE);

    const refused = await chooseZone(reader, IMPOSSIBLE_ZONE);

    // 422 and not 400: the body was well formed, and the domain refused what it
    // carried. The code names the field the request got wrong, and the sentence
    // an operator reads is the screen's, from the catalogue.
    expect(refused.statusCode).toBe(422);
    expect(JSON.parse(refused.body)).toEqual({ error: "unknown_time_zone" });

    // Nothing was stored, so the previous zone stands — on this route and, more
    // to the point, in the aggregation.
    expect((await settingsOf(reader)).timeZone).toBe(OPERATOR_ZONE);
    expect(await metricsZoneOf(reader)).toBe(OPERATOR_ZONE);
  });

  it("refuses an empty zone rather than storing one nothing can read", async () => {
    const reader = await boot(OPERATOR_ZONE);

    expect((await chooseZone(reader, "")).statusCode).toBe(422);
    expect((await settingsOf(reader)).timeZone).toBe(OPERATOR_ZONE);
  });

  it("refuses a body that names a field nobody declared", async () => {
    const reader = await boot(OPERATOR_ZONE);

    const response = await reader.app.server.inject({
      method: "POST",
      url: INSTANCE_ROUTE,
      headers: { cookie: reader.cookie, "content-type": "application/json" },
      payload: JSON.stringify({ zone: AHEAD_ZONE }),
    });

    // 400 this time: the request violated the contract, and no domain function
    // ran. Silently ignoring the unknown field would answer 200 to a write that
    // did nothing.
    expect(response.statusCode).toBe(400);
    expect((await settingsOf(reader)).timeZone).toBe(OPERATOR_ZONE);
  });

  it("falls back to the environment when the stored zone stopped existing", async () => {
    const dir = tempDir();
    const reader = await bootIn(dir, OPERATOR_ZONE);

    // Written straight into the table, behind the route, because the route
    // cannot produce this: it is what a build whose calendar data changed under
    // a stored choice would find. Honouring it would throw inside every
    // aggregation, and the panel would be broken by a setting.
    const handle = openDatabase({ databasePath: join(dir, "mychat.db") });
    handles.push(handle);
    await createTimeZonePreferenceStore(handle.db).write(IMPOSSIBLE_ZONE, NOW);

    expect((await settingsOf(reader)).timeZone).toBe(OPERATOR_ZONE);
    expect(await metricsZoneOf(reader)).toBe(OPERATOR_ZONE);
  });
});

describe("REQ-204: the instance persists its three trigger switches", () => {
  it("answers all three on when no preference row exists", async () => {
    expect(await triggersOf(await boot())).toEqual({
      all: { enabled: true },
      comments: { enabled: true },
      directMessages: { enabled: true },
    });
  });

  it("preserves channel values when Tudo is changed and survives restart", async () => {
    const dir = tempDir();
    const first = await bootIn(dir);

    await chooseTrigger(first, "comments", false);
    const globalOff = await chooseTrigger(first, "all", false);
    expect(globalOff.comments.enabled).toBe(false);
    expect(globalOff.directMessages.enabled).toBe(true);

    await first.app.close();
    apps.splice(apps.indexOf(first.app), 1);
    const restarted = await bootIn(dir);
    const restored = await triggersOf(restarted);
    expect(restored.all.enabled).toBe(false);
    expect(restored.comments.enabled).toBe(false);
    expect(restored.directMessages.enabled).toBe(true);
    expect(restored.all.updatedAt).toBe(NOW.toISOString());
    expect(restored.comments.updatedAt).toBe(NOW.toISOString());
  });

  it("keeps both reads and writes private", async () => {
    const reader = await boot();
    const read = await reader.app.server.inject({
      method: "GET",
      url: INSTANCE_TRIGGERS_ROUTE,
    });
    const write = await reader.app.server.inject({
      method: "POST",
      url: INSTANCE_TRIGGERS_ROUTE,
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ name: "all", enabled: false }),
    });
    expect(read.statusCode).toBe(401);
    expect(write.statusCode).toBe(401);
  });
});

/**
 * REQ-252, REQ-254, REQ-255 and REQ-257 over the contract, and one of them over
 * the WHOLE composed application.
 *
 * The rule itself is proven in `src/config/instance-settings.test.ts`, over a
 * store held in a variable. What is proven here is everything that would still
 * be broken with that suite green: that the route exists, that it is behind the
 * session like every other screen's, that a refusal arrives as a code with the
 * number the screen has to name, and, in the last block, that a deadline
 * written HERE is the deadline the next wait is actually created with, in the
 * same running process. That last one is the shape of defect this phase keeps
 * finding: a capability proven in isolation, never wired, and an operator who
 * sets six hours and is waited on for a week.
 */

const ACCOUNT = "17841400000000000";

interface SettingsState {
  readonly waitHours: number;
  readonly questions: number;
  readonly closingMessage: string;
  readonly followButtonLabel: string;
  readonly limits: {
    readonly waitHoursMin: number;
    readonly waitHoursMax: number;
    readonly questionsMin: number;
    readonly followButtonLabelChars: number;
  };
}

async function settingsStateOf(reader: Reader): Promise<SettingsState> {
  const response = await reader.app.server.inject({
    method: "GET",
    url: INSTANCE_SETTINGS_ROUTE,
    headers: { cookie: reader.cookie },
  });

  expect(response.statusCode).toBe(200);
  return response.json<SettingsState>();
}

/** The Settings screen writing one or more values, over the declared contract. */
function chooseSettings(
  reader: Reader,
  body: Record<string, unknown>,
): Promise<{ statusCode: number; body: string }> {
  return reader.app.server
    .inject({
      method: "POST",
      url: INSTANCE_SETTINGS_ROUTE,
      headers: { cookie: reader.cookie, "content-type": "application/json" },
      payload: JSON.stringify(body),
    })
    .then((response) => ({
      statusCode: response.statusCode,
      body: response.body,
    }));
}

describe("REQ-252/REQ-254/REQ-255/REQ-257: the instance answers its four settings", () => {
  it("answers the defaults, and the bounds a field has to be offered between", async () => {
    const state = await settingsStateOf(await boot());

    expect(state.waitHours).toBe(DEFAULT_WAIT_HOURS);
    expect(state.questions).toBe(DEFAULT_QUESTIONS);
    // Words, and from the catalogue: an empty goodbye would be the message the
    // contact never receives, and an empty label a button with nothing on it.
    expect(state.closingMessage).not.toBe("");
    expect(state.followButtonLabel).not.toBe("");
    expect(state.followButtonLabel.length).toBeLessThanOrEqual(
      LIMIT_DEFAULTS.quickReplyLabelChars,
    );
    // The bounds travel with the values, exactly as the list of zones travels
    // with the zone: a screen that had to carry its own 168 would carry a wrong
    // one the day this one moved.
    expect(state.limits).toEqual({
      waitHoursMin: MIN_WAIT_HOURS,
      waitHoursMax: MAX_WAIT_HOURS,
      questionsMin: MIN_QUESTIONS,
      followButtonLabelChars: LIMIT_DEFAULTS.quickReplyLabelChars,
    });
  });

  it("keeps a written value across a restart", async () => {
    const dir = tempDir();
    const first = await bootIn(dir);

    const written = await chooseSettings(first, {
      waitHours: 24,
      questions: 2,
      closingMessage: "No problem, comment again whenever.",
      followButtonLabel: "Done",
    });

    expect(written.statusCode).toBe(200);
    // The answer to a write is the answer the GET gives, so a screen adopting
    // it cannot end up showing a value the instance did not keep.
    expect(JSON.parse(written.body)).toEqual(await settingsStateOf(first));

    // Two processes over one database, which is what a restart is.
    const second = await bootIn(dir);
    expect(await settingsStateOf(second)).toMatchObject({
      waitHours: 24,
      questions: 2,
      closingMessage: "No problem, comment again whenever.",
      followButtonLabel: "Done",
    });
  });

  it("refuses a deadline outside the range, naming the bound it broke", async () => {
    const reader = await boot();

    const tooLong = await chooseSettings(reader, { waitHours: 200 });
    expect(tooLong.statusCode).toBe(422);
    expect(JSON.parse(tooLong.body)).toEqual({
      error: INSTANCE_SETTINGS_REFUSALS.waitHours,
      limit: MAX_WAIT_HOURS,
    });

    const tooShort = await chooseSettings(reader, { waitHours: 0 });
    expect(tooShort.statusCode).toBe(422);
    expect(JSON.parse(tooShort.body)).toEqual({
      error: INSTANCE_SETTINGS_REFUSALS.waitHours,
      limit: MIN_WAIT_HOURS,
    });

    // 422 and not 400: the body was well formed and the domain refused what it
    // carried. Nothing was stored either time.
    expect((await settingsStateOf(reader)).waitHours).toBe(DEFAULT_WAIT_HOURS);
  });

  it("refuses fewer than one question, naming the minimum", async () => {
    const reader = await boot();

    const refused = await chooseSettings(reader, { questions: 0 });

    expect(refused.statusCode).toBe(422);
    expect(JSON.parse(refused.body)).toEqual({
      error: INSTANCE_SETTINGS_REFUSALS.questions,
      limit: MIN_QUESTIONS,
    });
    expect((await settingsStateOf(reader)).questions).toBe(DEFAULT_QUESTIONS);
  });

  it("stores a follow button label past the platform's cut, whole", async () => {
    const reader = await boot();

    // Twenty is where the platform truncates a quick reply's title, and the
    // measurement of 2026-08-19 settled that it truncates rather than refuses:
    // 67 characters were accepted, 35 were drawn with an ellipsis, and the echo
    // of the tap came back with all 67 (REQ-306, docs/platform-limits.md). So
    // the route stores it, and stores the whole of it.
    const long = `${"a".repeat(LIMIT_DEFAULTS.quickReplyLabelChars)}bcdefg`;
    const written = await chooseSettings(reader, { followButtonLabel: long });

    expect(written.statusCode).toBe(200);
    // Asserted through a fresh READ and not off the write's answer: the row is
    // what the automations will be built against, and a rule that cut the label
    // on the way out would answer 200 here just the same.
    expect((await settingsStateOf(reader)).followButtonLabel).toBe(long);
  });

  it("refuses a goodbye of nothing", async () => {
    const reader = await boot();
    const before = await settingsStateOf(reader);

    const refused = await chooseSettings(reader, { closingMessage: "  " });

    expect(refused.statusCode).toBe(422);
    expect(JSON.parse(refused.body)).toEqual({
      error: INSTANCE_SETTINGS_REFUSALS.closingMessage,
    });
    expect((await settingsStateOf(reader)).closingMessage).toBe(
      before.closingMessage,
    );
  });

  it("refuses a body naming a field nobody declared", async () => {
    const reader = await boot();

    const response = await chooseSettings(reader, { timeoutHours: 6 });

    // 400 this time: the request violated the contract and no domain function
    // ran. Ignoring the unknown field would answer 200 to a write that did
    // nothing, which is how a screen ends up showing a value nobody stored.
    expect(response.statusCode).toBe(400);
    expect((await settingsStateOf(reader)).waitHours).toBe(DEFAULT_WAIT_HOURS);
  });

  it("keeps both the read and the write private", async () => {
    const reader = await boot();

    const read = await reader.app.server.inject({
      method: "GET",
      url: INSTANCE_SETTINGS_ROUTE,
    });
    const write = await reader.app.server.inject({
      method: "POST",
      url: INSTANCE_SETTINGS_ROUTE,
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ waitHours: 1 }),
    });

    expect(read.statusCode).toBe(401);
    expect(write.statusCode).toBe(401);
    expect((await settingsStateOf(reader)).waitHours).toBe(DEFAULT_WAIT_HOURS);
  });
});

describe("REQ-252: the deadline written here is the one the next wait is created with", () => {
  /** An automation whose first step waits for the contact to confirm. */
  const automation: ActiveAutomation = {
    schema_version: 2,
    kind: "automation",
    id: "guide-automation",
    state: "active",
    trigger: {
      type: "comment",
      target: "media-1",
      match: { keywords: ["guide"], mode: "contains" },
    },
    rules: { once_per_contact: true, first_reply_delay_seconds: 5 },
    steps: [
      {
        id: "confirm",
        action: "confirm_optin",
        text: "may I send you the guide?",
        quick_reply_label: "Yes",
        on_timeout: "abandon",
      },
      {
        id: "deliver",
        action: "send_dm",
        message: { text: "here it is" },
      },
    ],
  };

  function commentDelivery(commentId: string): string {
    return JSON.stringify({
      object: "instagram",
      entry: [
        {
          id: ACCOUNT,
          time: Math.floor(NOW.getTime() / 1000),
          changes: [
            {
              field: "comments",
              value: {
                id: commentId,
                text: "send me the guide",
                from: { id: `contact-${commentId}` },
                media: { id: "media-1" },
              },
            },
          ],
        },
      ],
    });
  }

  async function deliver(reader: Reader, commentId: string): Promise<void> {
    const payload = commentDelivery(commentId);
    const response = await reader.app.server.inject({
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
  }

  it("waits for exactly as long as the panel just said, with nothing restarted", async () => {
    const dir = tempDir();
    const reader = await bootIn(dir);
    const handle = openDatabase({ databasePath: join(dir, "mychat.db") });
    handles.push(handle);

    const stored = await createAutomationAggregateRepository(handle.db, {
      now: () => NOW,
    }).save(automation);
    expect(stored.ok).toBe(true);

    expect((await chooseSettings(reader, { waitHours: 6 })).statusCode).toBe(
      200,
    );

    await deliver(reader, "comment-1");

    const work = createDurableWorkStore(handle.db);
    const far = new Date(NOW.getTime() + 400 * 60 * 60 * 1000);

    await vi.waitFor(async () => {
      const [wait] = (await work.due(far)).filter(
        (item) => item.kind === "suspension",
      );
      expect(wait).toBeDefined();
      // Six hours, from the instant the step asked. This is the assertion the
      // whole task turns on: with the setting stored and never read by the
      // dispatcher, the wait would have been created on the engine's own idea
      // of a deadline and every assertion about the route would still pass.
      expect(wait?.dueAt.getTime()).toBe(NOW.getTime() + 6 * 60 * 60 * 1000);
    });
  });
});
