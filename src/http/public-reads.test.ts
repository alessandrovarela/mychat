import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import type { OperatorCredentialStore } from "../auth/credential.js";
import { SESSION_COOKIE_NAME } from "../auth/session.js";
import type { SessionStore, StoredSession } from "../auth/session.js";
import {
  AUTH_THROTTLE_DEFAULTS,
  createAuthThrottle,
} from "../auth/throttle.js";
import { createLocalePreference } from "../i18n/preference.js";
import type { LocalePreferenceStore } from "../i18n/preference.js";
import { createTranslator } from "../i18n/translator.js";
import type { AuditEntry, AuditRepository } from "../storage/audit.js";
import { PUBLIC_READS, registerAccess, UNAUTHORIZED } from "./access.js";
import { LOCALE_ROUTE, registerLocaleRoutes } from "./api/locale.js";

/**
 * Proves the one hole in the private scope, and proves it is one hole.
 *
 * REQ-074 says the operator meets the whole interface in the language the
 * instance configured, and the sign-in screen is interface. It is also the one
 * screen there is no session for, so while READING `/api/locale` was private
 * the page asked, received 401, and rendered the sign-in form in the default
 * language: on a `pt-BR` instance, the first screen every operator sees, every
 * time, in English.
 *
 * What follows is the whole trade, from outside: the READ answers with no
 * session, the WRITE on the same address does not, and a neighbouring private
 * route is untouched. The invented catalogues keep it about the RULE rather
 * than about `en` happening to be the default everywhere.
 */

const NOW = new Date("2026-08-02T16:00:00.000Z");
const OTHER = "pt-BR";
const SESSION_ID = "a-session-that-exists";
const PROBE_ROUTE = "/api/probe";

const CATALOGUES = { en: { probe: "english" }, [OTHER]: { probe: "outra" } };

const CREDENTIALS: OperatorCredentialStore = {
  read: async () => undefined,
  write: async () => undefined,
};

function createAuditDouble(): AuditRepository {
  const rows: AuditEntry[] = [];

  return {
    record: async (entry, occurredAt) => {
      const stored: AuditEntry = { id: rows.length + 1, occurredAt, ...entry };
      rows.push(stored);
      return stored;
    },
    query: async () => rows,
  };
}

function createSessionStoreDouble(): SessionStore {
  const rows = new Map<string, StoredSession>();

  return {
    open: async (session) => {
      rows.set(session.id, session);
    },
    find: async (id) => rows.get(id),
    end: async (id) => {
      rows.delete(id);
    },
    purgeExpired: async () => 0,
  };
}

interface Harness {
  readonly app: FastifyInstance;
  /** Every locale the preference store was asked to write, in order. */
  readonly writes: string[];
  readonly cookie: string;
}

let open: FastifyInstance[] = [];

async function buildHarness(): Promise<Harness> {
  const app = Fastify({ logger: false });
  open.push(app);

  const writes: string[] = [];
  let chosen: string | undefined;

  const store: LocalePreferenceStore = {
    read: async () => chosen,
    write: async (locale) => {
      writes.push(locale);
      chosen = locale;
    },
  };

  const sessions = createSessionStoreDouble();
  await sessions.open({
    id: SESSION_ID,
    createdAt: NOW,
    expiresAt: new Date(NOW.getTime() + 60_000),
  });

  registerAccess(
    app,
    {
      sessions,
      credentials: CREDENTIALS,
      cookie: { secure: false, ttlMs: 60_000 },
      now: () => NOW,
      throttle: createAuthThrottle(AUTH_THROTTLE_DEFAULTS),
      throttleLimits: AUTH_THROTTLE_DEFAULTS,
      audit: createAuditDouble(),
    },
    (scope) => {
      registerLocaleRoutes(
        scope,
        createLocalePreference({
          store,
          catalogue: createTranslator(CATALOGUES),
          env: {},
          now: () => NOW,
        }),
      );

      // A neighbour registered in the same scope, so the test can tell "this
      // one route answers without a session" from "the guard stopped working".
      scope.get(
        PROBE_ROUTE,
        {
          schema: {
            querystring: { type: "object", additionalProperties: false },
            response: { 200: { type: "object", additionalProperties: true } },
          },
        },
        async () => ({ reached: true }),
      );
    },
  );

  await app.ready();

  return { app, writes, cookie: `${SESSION_COOKIE_NAME}=${SESSION_ID}` };
}

afterEach(async () => {
  await Promise.all(open.map((app) => app.close()));
  open = [];
});

describe("REQ-074: the language is readable before there is a session", () => {
  it("answers the read with no cookie at all", async () => {
    const harness = await buildHarness();

    const response = await harness.app.inject({
      method: "GET",
      url: LOCALE_ROUTE,
    });

    // The sign-in screen asks this before it can have a session, and a 401 here
    // is exactly what made it render in the wrong language.
    expect(response.statusCode).toBe(200);
    expect(response.json<{ available: string[] }>().available).toEqual([
      "en",
      OTHER,
    ]);
  });

  it("keeps the WRITE on the same address behind the session check", async () => {
    const harness = await buildHarness();

    const response = await harness.app.inject({
      method: "POST",
      url: LOCALE_ROUTE,
      payload: { locale: OTHER },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: UNAUTHORIZED });
    // Criterion 1: refused AND with no effect. The guard runs on `onRequest`,
    // before the body is parsed, so the store was never reached.
    expect(harness.writes).toEqual([]);
  });

  it("stores the choice once a session carries it", async () => {
    const harness = await buildHarness();

    const response = await harness.app.inject({
      method: "POST",
      url: LOCALE_ROUTE,
      headers: { cookie: harness.cookie },
      payload: { locale: OTHER },
    });

    expect(response.statusCode).toBe(200);
    expect(harness.writes).toEqual([OTHER]);
  });

  it("leaves every other route in the scope private", async () => {
    const harness = await buildHarness();

    const refused = await harness.app.inject({
      method: "GET",
      url: PROBE_ROUTE,
    });

    expect(refused.statusCode).toBe(401);

    const allowed = await harness.app.inject({
      method: "GET",
      url: PROBE_ROUTE,
      headers: { cookie: harness.cookie },
    });

    expect(allowed.statusCode).toBe(200);
  });

  it("opens exactly one address, and only for reading", () => {
    // The list itself, said out loud: a second entry added later without a
    // reason of its own has to change this assertion first.
    expect(PUBLIC_READS).toEqual([
      { methods: ["GET", "HEAD"], url: LOCALE_ROUTE },
    ]);
  });
});
