import fastifyCookie from "@fastify/cookie";
import type { FastifyInstance } from "fastify";
import { verifyOperatorPassword } from "../auth/credential.js";
import type { OperatorCredentialStore } from "../auth/credential.js";
import {
  attemptAuthentication,
  FORWARDED_FOR_HEADER,
  resolveOrigin,
  retryAfterSeconds,
} from "../auth/throttle.js";
import type { AuthThrottle, AuthThrottleLimits } from "../auth/throttle.js";
import {
  authorise,
  endSession,
  SESSION_COOKIE_NAME,
  sessionCookieFlags,
  startSession,
} from "../auth/session.js";
import type { SessionCookieConfig, SessionStore } from "../auth/session.js";
import { t } from "../i18n/index.js";
import type { AuditRepository } from "../storage/audit.js";
import { LOCALE_ROUTE } from "./api/locale.js";

/**
 * The lock on the dashboard: the session routes, and the scope everything
 * private is registered inside (REQ-031, REQ-032, REQ-104).
 *
 * The shape of this module IS the requirement. The guard is a hook on an
 * ENCAPSULATED scope, and a route is private because it was registered inside
 * that scope, not because its address matched a pattern. The alternative, a
 * global hook with a list of exceptions, is what the KEEL forbids in as many
 * words: `/webhook` must stay public, and the day someone adds a route without
 * touching the exception list, a global guard answers the platform with an
 * authentication response. That failure is silent. The platform receives the
 * refusal, deliveries stop with no error visible anywhere, and the subscription
 * can be deactivated. An explicit scope fails the other way: forget to put a
 * route inside it and the route is merely unprotected, which a test catches and
 * an operator can see.
 *
 * `/webhook`, the resource route and the interface's files are registered
 * OUTSIDE this scope, so no hook of this module exists in their context at all.
 * Not "exists and declines to act": does not exist.
 */

/**
 * Addresses a private route may live at (ADR-011 scopes the optional external
 * layer to exactly these two, and the application's own guard covers the same
 * ground so an installation without that layer is protected just the same).
 *
 * Enforced at registration, not merely documented: see `registerAccess`.
 */
export const PRIVATE_PREFIXES: readonly string[] = ["/api", "/dashboard"];

/** Opening a session (POST) and ending one (DELETE). Both public by design. */
export const SESSION_ROUTE = "/api/session";

/** A read the guard lets through, as an exact method set and an exact address. */
export interface PublicRead {
  readonly methods: readonly string[];
  readonly url: string;
}

/**
 * The reads inside the private scope that answer with NO session, and the whole
 * list of them.
 *
 * Everything above argues that a route is private by being registered inside
 * the scope rather than by matching a pattern, and this list is the one place
 * that argument is bent. It is bent narrowly and on purpose:
 *
 *   - the entry is a METHOD SET and an EXACT address, never a prefix. `POST
 *     /api/locale`, which WRITES the instance's preference, shares the address
 *     and is not on this list, so it stays behind the session check.
 *   - the reason is REQ-074: the whole interface is shown in the language the
 *     instance configured, and the sign-in screen is interface. It is the first
 *     screen every operator sees and the one screen there is no session for, so
 *     a private read means the page asks, receives 401, and falls back to the
 *     default language. On a `pt-BR` instance that is the first screen, every
 *     time, in the wrong language.
 *   - what it gives away is a language name (`en`, `pt-BR`) and the set of
 *     catalogues this build ships. That is not operator data, not a secret, and
 *     not a hint about the password: it is a build-time fact plus one setting.
 *
 * It lives here and not as a route registered outside the guarded scope because
 * the route also belongs to the contract of REQ-103 (`src/http/api/contract.ts`
 * refuses at boot a route under `/api` that declares no input or output), and
 * Fastify would refuse a second registration of the same method and address.
 */
export const PUBLIC_READS: readonly PublicRead[] = [
  // HEAD travels with GET because Fastify derives it from the same route: a
  // read that answers without a session must not answer 401 to its own HEAD.
  { methods: ["GET", "HEAD"], url: LOCALE_ROUTE },
];

/**
 * Bodies of the two refusals.
 *
 * Codes, not sentences: they are read by the interface, which renders its own
 * translated text from the catalogue. Putting prose here would both hardcode an
 * operator-facing string and pick a language for a client that has one.
 */
export const UNAUTHORIZED = "unauthorized";
export const INVALID_CREDENTIALS = "invalid_credentials";

export const TOO_MANY_ATTEMPTS = "too_many_attempts";

const ERROR_RESPONSE = {
  type: "object",
  required: ["error"],
  properties: { error: { type: "string" } },
  additionalProperties: false,
} as const;

/**
 * Input and output declared for both routes, which every `/api/*` route in this
 * application owes (REQ-103). The password has a floor of one character only so
 * that an empty body is refused before anything is derived; the real minimum
 * belongs to the command that SETS the password, and repeating it here would
 * tell an attacker how short a password they can stop guessing at.
 */
const OPEN_SESSION_SCHEMA = {
  body: {
    type: "object",
    required: ["password"],
    properties: { password: { type: "string", minLength: 1 } },
    additionalProperties: false,
  },
  response: {
    200: {
      type: "object",
      required: ["ok"],
      properties: { ok: { type: "boolean" } },
      additionalProperties: false,
    },
    401: ERROR_RESPONSE,
    429: ERROR_RESPONSE,
  },
} as const;

const END_SESSION_SCHEMA = {
  response: { 204: { type: "null" } },
} as const;

export interface AccessDeps {
  readonly sessions: SessionStore;
  readonly credentials: OperatorCredentialStore;
  readonly cookie: SessionCookieConfig;
  readonly now: () => Date;
  readonly throttle: AuthThrottle;
  readonly throttleLimits: AuthThrottleLimits;
  readonly audit: AuditRepository;
}

/** Registers whatever must sit behind the session check. */
export type PrivateRoutes = (scope: FastifyInstance) => void;

function isPrivateUrl(url: string): boolean {
  return PRIVATE_PREFIXES.some(
    (prefix) => url === prefix || url.startsWith(`${prefix}/`),
  );
}

/**
 * Whether this request is one of the declared public reads.
 *
 * The address compared is the ROUTE's own pattern, which the router resolved
 * before this runs, and not the address the client typed: a path the client
 * dressed up (percent encoding, a trailing segment, a query string) still
 * arrives here as the pattern it matched, or as no route at all.
 */
function isPublicRead(method: string, routeUrl: string | undefined): boolean {
  return PUBLIC_READS.some(
    (read) => read.url === routeUrl && read.methods.includes(method),
  );
}

function registerSessionRoutes(scope: FastifyInstance, deps: AccessDeps): void {
  /**
   * Authenticating (REQ-035). The credential is read from the store on every
   * attempt by `verifyOperatorPassword`, so a password replaced a second ago
   * decides this answer.
   */
  scope.post(
    SESSION_ROUTE,
    { schema: OPEN_SESSION_SCHEMA },
    async (request, reply) => {
      const { password } = request.body as { password: string };
      const now = deps.now();

      // Not `request.ip`: that follows Fastify's global `trustProxy`, which
      // would change what every other route sees. How many proxies actually sit
      // in front (ADR-013) is the throttle's own configuration.
      const origin = resolveOrigin(
        {
          remoteAddress: request.socket.remoteAddress,
          forwardedFor: request.headers[FORWARDED_FOR_HEADER],
        },
        deps.throttleLimits.trustedProxyHops,
      );

      // The ceiling is consulted BEFORE the password is checked (REQ-034): a
      // blocked origin is refused even when it finally guesses right, and the
      // order lives in `attemptAuthentication` rather than here, so a second
      // entry point cannot get it wrong.
      const outcome = await attemptAuthentication(
        origin,
        password,
        {
          throttle: deps.throttle,
          audit: deps.audit,
          verify: (candidate) =>
            verifyOperatorPassword(candidate, deps.credentials),
        },
        now,
      );

      if (outcome.kind === "throttled") {
        // Already on the trail: `attemptAuthentication` recorded the refusal
        // with the origin and the reason before returning.
        return reply
          .header("retry-after", retryAfterSeconds(outcome.retryAt, now))
          .code(429)
          .send({ error: TOO_MANY_ATTEMPTS });
      }

      if (outcome.kind === "rejected") {
        // No session is opened and no cookie is set: a refusal must leave the
        // browser holding nothing it can retry with.
        return reply.code(401).send({ error: INVALID_CREDENTIALS });
      }

      const session = await startSession(
        deps.sessions,
        deps.now(),
        deps.cookie.ttlMs,
      );

      return reply
        .setCookie(
          SESSION_COOKIE_NAME,
          session.id,
          sessionCookieFlags(deps.cookie),
        )
        .code(200)
        .send({ ok: true });
    },
  );

  /**
   * Ending a session (REQ-104).
   *
   * PUBLIC, like the route that opens one, and for a reason worth stating: it
   * acts only on the session its own cookie names, so it is self-authenticating,
   * and behind the guard an operator whose cookie had already expired could
   * never clear it. Answering 204 whatever the cookie was is the same refusal
   * to distinguish that `authorise` makes: ending an unknown session and ending
   * a real one look identical from outside.
   */
  scope.delete(
    SESSION_ROUTE,
    { schema: END_SESSION_SCHEMA },
    async (request, reply) => {
      await endSession(deps.sessions, request.cookies[SESSION_COOKIE_NAME]);

      // The row is gone, which is what actually revokes. Clearing the cookie is
      // housekeeping on top of that: REQ-104 is about the cookie the operator
      // still holds authorising nothing, including one this response never
      // reached.
      return reply
        .clearCookie(SESSION_COOKIE_NAME, { path: "/" })
        .code(204)
        .send();
    },
  );
}

/**
 * Registers the session routes and the private scope on an existing instance.
 * No server is built here: the process has one Fastify instance.
 *
 * Everything this module owns lives in ONE child scope, which is also the only
 * place `@fastify/cookie` is registered: outside it nothing in this process
 * reads or writes a cookie, and `/webhook` does not so much as parse a header
 * on its behalf.
 */
export function registerAccess(
  app: FastifyInstance,
  deps: AccessDeps,
  privateRoutes: PrivateRoutes = (): void => {},
): void {
  app.register(async (scope) => {
    await scope.register(fastifyCookie);

    // Siblings, not parent and child: the session routes are registered here,
    // the guard is added inside the nested scope below, and a Fastify hook only
    // ever applies downwards. That is what lets `/api/session` be reachable
    // with no session while `/api/flows` is not.
    registerSessionRoutes(scope, deps);

    await scope.register(async (guarded) => {
      // The converse of the KEEL's rule, checked at boot rather than trusted: a
      // route registered in here must be one of the addresses declared private.
      // It is what stops the opposite mistake, someone registering `/webhook`
      // (or any public route) inside the guarded scope, where it would answer
      // the platform with a 401 and stop deliveries in silence.
      guarded.addHook("onRoute", (route) => {
        if (!isPrivateUrl(route.url)) {
          throw new Error(
            t("auth.routeOutsidePrivateScope", {
              url: route.url,
              prefixes: PRIVATE_PREFIXES.join(", "),
            }),
          );
        }
      });

      // `onRequest`, the earliest hook there is: the body is not parsed, no
      // validation runs and no handler is entered, so acceptance criterion 1
      // ("nothing written, nothing sent") holds by construction rather than by
      // every handler remembering to check.
      guarded.addHook("onRequest", async (request, reply) => {
        if (isPublicRead(request.method, request.routeOptions.url)) {
          // Declared above, one entry, and read-only: the interface has to know
          // which language to render the sign-in screen in before it can have a
          // session at all.
          return;
        }

        const session = await authorise(
          deps.sessions,
          request.cookies[SESSION_COOKIE_NAME],
          deps.now(),
        );

        if (session === undefined) {
          // 401, never a redirect to a login page. A redirect is what turns a
          // machine client's request into an HTML page it cannot read, and the
          // interface is a single page application that routes itself: it reads
          // this status and shows its own screen.
          await reply.code(401).send({ error: UNAUTHORIZED });
          return reply;
        }

        return;
      });

      privateRoutes(guarded);
    });
  });
}
