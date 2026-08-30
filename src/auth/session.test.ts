import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigError } from "../config/errors.js";
import {
  PRIVATE_PREFIXES,
  registerAccess,
  SESSION_ROUTE,
  UNAUTHORIZED,
} from "../http/access.js";
import { IN_MEMORY_DATABASE, openDatabase } from "../storage/database.js";
import type { DatabaseHandle } from "../storage/database.js";
import { createAuditRepository } from "../storage/audit.js";
import {
  createOperatorCredentialStore,
  setOperatorPassword,
} from "./credential.js";
import { AUTH_THROTTLE_DEFAULTS, createAuthThrottle } from "./throttle.js";
import {
  authorise,
  COOKIE_SECURE_VARIABLE,
  createSessionStore,
  DEFAULT_SESSION_TTL_MS,
  endSession,
  loadSessionCookieConfig,
  SESSION_COOKIE_NAME,
  sessionCookieFlags,
  startSession,
} from "./session.js";

/**
 * Proves REQ-031, REQ-035 and REQ-104, plus acceptance criteria 1, 2, 10, 11
 * and 12 of the phase.
 *
 * Two of these tests exist to catch a mistake the obvious ones cannot see:
 *
 *   - "a route registered outside the private scope is answered with no
 *     cookie". Swap the scoped guard for a global hook with an exception list
 *     and every other test here still passes, including the webhook's own. That
 *     is the failure the KEEL calls silent, and this is the test that is not
 *     silent about it.
 *   - "a session nobody ended still authorises after a restart". Without it,
 *     REQ-104's restart proof would also pass on a store that simply forgot
 *     everything it held, which proves nothing about ending a session.
 */

const PASSWORD = "Zq7-Vamp!Krux9";
const START = new Date("2026-08-02T09:00:00.000Z");
const PRIVATE_ROUTE = "/api/probe";
/** Registered on the root instance, which is where every public route lives. */
const PUBLIC_ROUTE = "/public-probe";

let clock: Date;
const workspaces: string[] = [];

interface HarnessOptions {
  /** A file makes a restart observable. Defaults to a memory database. */
  readonly databasePath?: string;
  readonly secure?: boolean;
  readonly ttlMs?: number;
}

interface Harness {
  readonly app: FastifyInstance;
  readonly handle: DatabaseHandle;
  /** What the private handler did, so "nothing happened" is a fact. */
  readonly effects: string[];
  close(): Promise<void>;
}

function buildHarness(options: HarnessOptions = {}): Harness {
  const handle = openDatabase({
    databasePath: options.databasePath ?? IN_MEMORY_DATABASE,
  });
  const effects: string[] = [];
  const app = Fastify({ logger: false });

  registerAccess(
    app,
    {
      sessions: createSessionStore(handle.db),
      credentials: createOperatorCredentialStore(handle.db),
      cookie: {
        secure: options.secure ?? false,
        ttlMs: options.ttlMs ?? DEFAULT_SESSION_TTL_MS,
      },
      now: () => clock,
      throttle: createAuthThrottle(AUTH_THROTTLE_DEFAULTS),
      throttleLimits: AUTH_THROTTLE_DEFAULTS,
      audit: createAuditRepository(handle.db),
    },
    (scope) => {
      scope.post(PRIVATE_ROUTE, async () => {
        // The only thing that can prove "no effect of the intended action
        // occurred": a private handler that leaves a trace when it runs.
        effects.push("probe");
        return { ok: true };
      });
    },
  );

  // OUTSIDE the private scope, exactly like `/webhook`, the resource route and
  // the interface's files. Nothing this module registers may reach it.
  app.get(PUBLIC_ROUTE, async () => ({ ok: true }));

  return {
    app,
    handle,
    effects,
    close: async (): Promise<void> => {
      await app.close();
      handle.close();
    },
  };
}

function workspace(): string {
  const created = mkdtempSync(join(tmpdir(), "mychat-session-"));
  workspaces.push(created);
  return created;
}

/** The session cookie a response sets, or undefined when it sets none. */
function issuedCookie(response: LightMyRequestResponse): string | undefined {
  const raw = response.headers["set-cookie"];
  const headers = Array.isArray(raw) ? raw : [raw];

  for (const header of headers) {
    if (typeof header !== "string") continue;
    const [pair = ""] = header.split(";");
    const separator = pair.indexOf("=");
    if (pair.slice(0, separator) === SESSION_COOKIE_NAME) {
      return pair.slice(separator + 1);
    }
  }

  return undefined;
}

function setCookieHeader(response: LightMyRequestResponse): string {
  const raw = response.headers["set-cookie"];
  return (Array.isArray(raw) ? raw : [raw])
    .filter((header): header is string => typeof header === "string")
    .find((header) => header.startsWith(`${SESSION_COOKIE_NAME}=`)) as string;
}

async function logIn(
  app: FastifyInstance,
  password = PASSWORD,
): Promise<LightMyRequestResponse> {
  return app.inject({
    method: "POST",
    url: SESSION_ROUTE,
    payload: { password },
  });
}

function callPrivate(
  app: FastifyInstance,
  cookie?: string,
): Promise<LightMyRequestResponse> {
  return app.inject({
    method: "POST",
    url: PRIVATE_ROUTE,
    payload: {},
    ...(cookie !== undefined && {
      cookies: { [SESSION_COOKIE_NAME]: cookie },
    }),
  });
}

beforeEach(() => {
  clock = new Date(START);
});

afterEach(() => {
  while (workspaces.length > 0) {
    const created = workspaces.pop();
    if (created !== undefined) {
      rmSync(created, { recursive: true, force: true });
    }
  }
});

describe("REQ-031: a private route without a valid session does nothing", () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = buildHarness();
    await setOperatorPassword(
      PASSWORD,
      createOperatorCredentialStore(harness.handle.db),
      clock,
    );
  });

  afterEach(async () => {
    await harness.close();
  });

  it("refuses with 401 and never enters the handler", async () => {
    const response = await callPrivate(harness.app);

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: UNAUTHORIZED });
    // Acceptance criterion 1: nothing written, nothing sent. The guard runs on
    // `onRequest`, so the body is not even parsed.
    expect(harness.effects).toEqual([]);
  });

  it("does not redirect to an authentication page", async () => {
    const response = await callPrivate(harness.app);

    // A redirect would hand a machine client an HTML page it cannot read, and
    // is the shape the KEEL forbids in front of the platform's own route.
    expect(response.statusCode).toBe(401);
    expect([301, 302, 303, 307, 308]).not.toContain(response.statusCode);
    expect(response.headers["location"]).toBeUndefined();
  });

  it("answers a tampered cookie exactly as it answers no cookie", async () => {
    const none = await callPrivate(harness.app);
    const forged = await callPrivate(harness.app, "not-a-session-id");

    // Acceptance criterion 2. Telling the two apart would teach a prober which
    // identifiers exist.
    expect(forged.statusCode).toBe(none.statusCode);
    expect(forged.json()).toEqual(none.json());
    expect(harness.effects).toEqual([]);
  });

  it("answers an expired cookie exactly as it answers no cookie", async () => {
    const short = buildHarness({ ttlMs: 60_000 });
    await setOperatorPassword(
      PASSWORD,
      createOperatorCredentialStore(short.handle.db),
      clock,
    );

    const cookie = issuedCookie(await logIn(short.app));
    expect(cookie).toBeDefined();
    await expect(
      callPrivate(short.app, cookie).then((r) => r.statusCode),
    ).resolves.toBe(200);

    clock = new Date(START.getTime() + 60_001);

    const response = await callPrivate(short.app, cookie);

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: UNAUTHORIZED });
    expect(short.effects).toEqual(["probe"]);

    await short.close();
  });

  it("lets the handler run once a session was opened", async () => {
    const cookie = issuedCookie(await logIn(harness.app));

    const response = await callPrivate(harness.app, cookie);

    expect(response.statusCode).toBe(200);
    expect(harness.effects).toEqual(["probe"]);
  });

  it("refuses the wrong password and issues no cookie", async () => {
    const response = await logIn(harness.app, "not-the-password");

    expect(response.statusCode).toBe(401);
    expect(issuedCookie(response)).toBeUndefined();
  });

  it("refuses a body with no password before deriving anything", async () => {
    const response = await harness.app.inject({
      method: "POST",
      url: SESSION_ROUTE,
      payload: {},
    });

    expect(response.statusCode).toBe(400);
    expect(issuedCookie(response)).toBeUndefined();
  });
});

/**
 * REQ-032's other half, and the reason this task exists.
 *
 * The webhook's own proof lives in `src/http/webhook.test.ts`, where the real
 * route is. What is proved HERE is the property that makes it durable: the
 * guard is not something that runs everywhere and declines to act, it is
 * something that exists only inside the scope it was registered in.
 */
describe("REQ-032: the guard is scoped, not global with exceptions", () => {
  let harness: Harness;

  beforeEach(() => {
    harness = buildHarness();
  });

  afterEach(async () => {
    await harness.close();
  });

  it("answers a route registered outside the scope with no cookie at all", async () => {
    const response = await harness.app.inject({
      method: "GET",
      url: PUBLIC_ROUTE,
    });

    // A global hook with a list of exceptions passes every other test in this
    // file and fails this one, which is exactly the point: the exception list
    // would not have this address on it, and neither would tomorrow's.
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });
  });

  it("still answers it when the request carries a garbage cookie", async () => {
    const response = await harness.app.inject({
      method: "GET",
      url: PUBLIC_ROUTE,
      cookies: { [SESSION_COOKIE_NAME]: "forged" },
    });

    expect(response.statusCode).toBe(200);
  });

  it("refuses at boot to hold a public address inside the private scope", async () => {
    const handle = openDatabase({ databasePath: IN_MEMORY_DATABASE });
    const app = Fastify({ logger: false });

    registerAccess(
      app,
      {
        sessions: createSessionStore(handle.db),
        credentials: createOperatorCredentialStore(handle.db),
        cookie: { secure: true, ttlMs: DEFAULT_SESSION_TTL_MS },
        now: () => clock,
        throttle: createAuthThrottle(AUTH_THROTTLE_DEFAULTS),
        throttleLimits: AUTH_THROTTLE_DEFAULTS,
        audit: createAuditRepository(handle.db),
      },
      (scope) => {
        // The mistake this catches: `/webhook` behind the session check answers
        // the platform with a 401, deliveries stop, and nothing reports it.
        scope.post("/webhook", async () => ({ ok: true }));
      },
    );

    await expect(app.ready()).rejects.toThrow();

    await app.close();
    handle.close();
  });

  it("names the two addresses that may be private, and no others", () => {
    expect([...PRIVATE_PREFIXES]).toEqual(["/api", "/dashboard"]);
    expect(PRIVATE_PREFIXES).not.toContain("/webhook");
  });
});

describe("REQ-035: the cookie carries httpOnly, secure and sameSite", () => {
  it("emits all three marks under the production configuration", async () => {
    const harness = buildHarness({ secure: true });
    await setOperatorPassword(
      PASSWORD,
      createOperatorCredentialStore(harness.handle.db),
      clock,
    );

    const header = setCookieHeader(await logIn(harness.app));

    // Acceptance criterion 10, read off the header the browser actually gets.
    expect(header).toContain("HttpOnly");
    expect(header).toContain("Secure");
    expect(header).toContain("SameSite=Lax");
    expect(header).toContain("Path=/");

    await harness.close();
  });

  it("drops only `secure` in development, and the session still works", async () => {
    const harness = buildHarness({ secure: false });
    await setOperatorPassword(
      PASSWORD,
      createOperatorCredentialStore(harness.handle.db),
      clock,
    );

    const response = await logIn(harness.app);
    const header = setCookieHeader(response);

    // Acceptance criterion 11. `npm run dev` serves `http://localhost` with no
    // TLS (the KEEL forbids requiring Docker or a proxy for it), and a browser
    // silently refuses to store a `secure` cookie sent over plain HTTP: the
    // operator would be unable to log in, with no error to read anywhere.
    expect(header).not.toContain("Secure");
    expect(header).toContain("HttpOnly");
    expect(header).toContain("SameSite=Lax");

    const cookie = issuedCookie(response);
    await expect(
      callPrivate(harness.app, cookie).then((r) => r.statusCode),
    ).resolves.toBe(200);

    await harness.close();
  });

  it("assembles the flags in one place", () => {
    expect(
      sessionCookieFlags({ secure: true, ttlMs: DEFAULT_SESSION_TTL_MS }),
    ).toEqual({
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      path: "/",
      maxAge: DEFAULT_SESSION_TTL_MS / 1000,
    });
  });
});

describe("the environment decides `secure`, and production may not turn it off", () => {
  it("is on in production with nothing configured", () => {
    expect(loadSessionCookieConfig({ NODE_ENV: "production" }).secure).toBe(
      true,
    );
  });

  it("is off anywhere else with nothing configured", () => {
    // What makes `npm run dev` work with no configuration at all.
    expect(loadSessionCookieConfig({}).secure).toBe(false);
    expect(loadSessionCookieConfig({ NODE_ENV: "development" }).secure).toBe(
      false,
    );
  });

  it("can be turned on explicitly outside production", () => {
    expect(
      loadSessionCookieConfig({ [COOKIE_SECURE_VARIABLE]: "true" }).secure,
    ).toBe(true);
  });

  it("can be turned off explicitly outside production", () => {
    expect(
      loadSessionCookieConfig({ [COOKIE_SECURE_VARIABLE]: "false" }).secure,
    ).toBe(false);
  });

  it("refuses to start when production asks for the mark to be off", () => {
    try {
      loadSessionCookieConfig({
        NODE_ENV: "production",
        [COOKIE_SECURE_VARIABLE]: "false",
      });
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as ConfigError).variables).toEqual([
        COOKIE_SECURE_VARIABLE,
      ]);
      return;
    }

    expect.unreachable("production must not emit a cookie without `secure`");
  });

  it("refuses a value that is neither true nor false", () => {
    // Guessing that `0` means off would be a security decision taken by a typo.
    expect(() =>
      loadSessionCookieConfig({ [COOKIE_SECURE_VARIABLE]: "0" }),
    ).toThrow(ConfigError);
  });
});

describe("REQ-104: ending a session, and the restart that follows", () => {
  it("stops the same cookie from authorising, at that instant", async () => {
    const harness = buildHarness();
    await setOperatorPassword(
      PASSWORD,
      createOperatorCredentialStore(harness.handle.db),
      clock,
    );

    const cookie = issuedCookie(await logIn(harness.app));
    await expect(
      callPrivate(harness.app, cookie).then((r) => r.statusCode),
    ).resolves.toBe(200);

    const ended = await harness.app.inject({
      method: "DELETE",
      url: SESSION_ROUTE,
      cookies: { [SESSION_COOKIE_NAME]: cookie as string },
    });

    expect(ended.statusCode).toBe(204);

    const after = await callPrivate(harness.app, cookie);
    expect(after.statusCode).toBe(401);
    expect(harness.effects).toEqual(["probe"]);

    await harness.close();
  });

  it("keeps refusing that cookie after the process restarts", async () => {
    const databasePath = join(workspace(), "mychat.db");

    const first = buildHarness({ databasePath });
    await setOperatorPassword(
      PASSWORD,
      createOperatorCredentialStore(first.handle.db),
      clock,
    );
    const cookie = issuedCookie(await logIn(first.app));

    await first.app.inject({
      method: "DELETE",
      url: SESSION_ROUTE,
      cookies: { [SESSION_COOKIE_NAME]: cookie as string },
    });
    // The restart: this process is gone, database file and all.
    await first.close();

    const second = buildHarness({ databasePath });
    const response = await callPrivate(second.app, cookie);

    // Acceptance criterion 12, and the reason the session is a row instead of a
    // signed token: a token would still be valid here, and revoking it would
    // need a deny list that the restart just erased.
    expect(response.statusCode).toBe(401);
    expect(second.effects).toEqual([]);

    await second.close();
  });

  it("still authorises a session nobody ended, after the same restart", async () => {
    const databasePath = join(workspace(), "mychat.db");

    const first = buildHarness({ databasePath });
    await setOperatorPassword(
      PASSWORD,
      createOperatorCredentialStore(first.handle.db),
      clock,
    );
    const cookie = issuedCookie(await logIn(first.app));
    await first.close();

    const second = buildHarness({ databasePath });
    const response = await callPrivate(second.app, cookie);

    // The control. Without it the test above would pass just as well on a store
    // that forgot every session on restart, which would revoke nothing and log
    // the operator out of a session they never ended.
    expect(response.statusCode).toBe(200);
    expect(second.effects).toEqual(["probe"]);

    await second.close();
  });
});

describe("the session store, underneath the routes", () => {
  let handle: DatabaseHandle;

  beforeEach(() => {
    handle = openDatabase({ databasePath: IN_MEMORY_DATABASE });
  });

  afterEach(() => {
    handle.close();
  });

  it("gives every session an unpredictable identifier", async () => {
    const store = createSessionStore(handle.db);

    const first = await startSession(store, clock);
    const second = await startSession(store, clock);

    expect(first.id).not.toBe(second.id);
    // 32 bytes of base64url. Guessing one IS logging in, so the only defence is
    // a space that cannot be walked.
    expect(first.id).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("authorises the identifier it issued and nothing else", async () => {
    const store = createSessionStore(handle.db);
    const session = await startSession(store, clock);

    await expect(authorise(store, session.id, clock)).resolves.toEqual(session);
    await expect(authorise(store, undefined, clock)).resolves.toBeUndefined();
    await expect(authorise(store, "", clock)).resolves.toBeUndefined();
    await expect(
      authorise(store, `${session.id}x`, clock),
    ).resolves.toBeUndefined();
  });

  it("stops authorising at the expiry, and drops the row on the way", async () => {
    const store = createSessionStore(handle.db);
    const session = await startSession(store, clock, 1000);

    const expired = new Date(clock.getTime() + 1000);

    await expect(
      authorise(store, session.id, expired),
    ).resolves.toBeUndefined();
    // Nothing sweeps this table, and a row that can never authorise again has
    // no reason to be kept.
    await expect(store.find(session.id)).resolves.toBeUndefined();
  });

  it("ends a session that exists, and shrugs at one that does not", async () => {
    const store = createSessionStore(handle.db);
    const session = await startSession(store, clock);

    await endSession(store, session.id);
    await expect(store.find(session.id)).resolves.toBeUndefined();

    // Ending twice, or ending a cookie that was never a session, is not a
    // fault: the operator is asking for a state that is already true.
    await expect(endSession(store, session.id)).resolves.toBeUndefined();
    await expect(endSession(store, undefined)).resolves.toBeUndefined();
  });

  it("purges what has run out and keeps what has not", async () => {
    const store = createSessionStore(handle.db);
    const short = await startSession(store, clock, 1000);
    const long = await startSession(store, clock, 60_000);

    await expect(
      store.purgeExpired(new Date(clock.getTime() + 1000)),
    ).resolves.toBe(1);
    await expect(store.find(short.id)).resolves.toBeUndefined();
    await expect(store.find(long.id)).resolves.toBeDefined();
  });
});
