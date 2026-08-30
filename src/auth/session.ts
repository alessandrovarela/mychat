import { randomBytes } from "node:crypto";
import { eq, lte } from "drizzle-orm";
import { ConfigError, configMessages } from "../config/errors.js";
import { t } from "../i18n/index.js";
import type { MyChatDatabase } from "../storage/database.js";
import { sessions } from "../storage/schema.js";

/**
 * The operator's session (REQ-031, REQ-035, REQ-104).
 *
 * Two decisions carry this whole file, and both come from REQ-104's last
 * clause, "inclusive after the process restarts":
 *
 *   1. The session is a ROW, not a self-describing signed token. A token
 *      carrying its own expiry stays valid until that expiry because nothing
 *      anywhere can be asked about it, so ending a session could only be
 *      enforced by a deny list, and a deny list held in memory is forgotten by
 *      the next restart. Here the row IS the authorisation: ending a session
 *      deletes it, and a cookie whose row is gone authorises nobody, before or
 *      after a restart.
 *   2. The store is read on EVERY request, never cached. A session cached at
 *      start-up would keep authorising a cookie the operator had already
 *      revoked, which is the same defect `verifyOperatorPassword` avoids for
 *      the password, for the same reason.
 *
 * What the cookie carries is an opaque random value and nothing else: no
 * identifier of the operator, no expiry, no signature to forge, nothing that
 * says anything to whoever reads it off the wire.
 */

/** Name of the cookie the interface carries. */
export const SESSION_COOKIE_NAME = "mychat_session";

/**
 * Bytes of randomness behind a session id.
 *
 * 256 bits from the system CSPRNG: the id is a bearer credential, so guessing
 * one IS logging in, and the only defence is that the space cannot be walked.
 */
const SESSION_ID_BYTES = 32;

/**
 * How long a session lasts unless the caller says otherwise.
 *
 * Seven days is an operational choice, not a platform number, which is why it
 * is here and not in `limits.ts` (whose contract is that every value there is
 * traceable to the platform documentation). It bounds the damage of a browser
 * left open on a machine nobody owns any more: past this instant the row
 * authorises nothing, whether or not anything has swept it.
 */
export const DEFAULT_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * `SameSite` in force. Fixed rather than configured: `lax` keeps a link that
 * lands on the dashboard working, and REQ-035 asks for the mark to be there,
 * not for it to be adjustable.
 */
export const SESSION_COOKIE_SAME_SITE = "lax";

/** The environment variable that decides `secure`. */
export const COOKIE_SECURE_VARIABLE = "SESSION_COOKIE_SECURE";

export interface StoredSession {
  readonly id: string;
  readonly createdAt: Date;
  readonly expiresAt: Date;
}

export interface SessionStore {
  open(session: StoredSession): Promise<void>;
  /** The row, or undefined when no session with this id exists. */
  find(id: string): Promise<StoredSession | undefined>;
  /** Removes the row. Silent when there is none: ending twice is not a fault. */
  end(id: string): Promise<void>;
  /** Removes every row already past its expiry. Returns how many went. */
  purgeExpired(now: Date): Promise<number>;
}

export function createSessionStore(db: MyChatDatabase): SessionStore {
  return {
    open(session: StoredSession): Promise<void> {
      db.insert(sessions)
        .values({
          id: session.id,
          createdAt: session.createdAt,
          expiresAt: session.expiresAt,
        })
        .run();

      return Promise.resolve();
    },

    find(id: string): Promise<StoredSession | undefined> {
      const [row] = db.select().from(sessions).where(eq(sessions.id, id)).all();
      return Promise.resolve(row);
    },

    end(id: string): Promise<void> {
      db.delete(sessions).where(eq(sessions.id, id)).run();
      return Promise.resolve();
    },

    purgeExpired(now: Date): Promise<number> {
      const removed = db
        .delete(sessions)
        .where(lte(sessions.expiresAt, now))
        .returning()
        .all();

      return Promise.resolve(removed.length);
    },
  };
}

/** A value no attacker can predict and no operator can be recognised by. */
export function newSessionId(): string {
  return randomBytes(SESSION_ID_BYTES).toString("base64url");
}

/**
 * Opens a session and returns the row that was written. The id it carries is
 * what goes into the cookie, and the only copy of it that means anything is the
 * one in the database.
 */
export async function startSession(
  store: SessionStore,
  now: Date,
  ttlMs: number = DEFAULT_SESSION_TTL_MS,
): Promise<StoredSession> {
  const session: StoredSession = {
    id: newSessionId(),
    createdAt: now,
    expiresAt: new Date(now.getTime() + ttlMs),
  };

  await store.open(session);

  return session;
}

/**
 * The session a cookie authorises, or undefined.
 *
 * Undefined covers three cases deliberately made indistinguishable, which is
 * acceptance criterion 2: no cookie at all, a cookie whose id is not a row
 * (tampered, forged, or belonging to a session that was ended), and a cookie
 * whose row has run out. All three mean the same thing to a caller, and telling
 * them apart in the answer would teach a prober which ids exist.
 *
 * An expired row is deleted on the way out. There is no sweep for this table,
 * and a row that can never authorise again has no reason to be kept.
 */
export async function authorise(
  store: SessionStore,
  cookie: string | undefined,
  now: Date,
): Promise<StoredSession | undefined> {
  if (cookie === undefined || cookie === "") {
    return undefined;
  }

  const session = await store.find(cookie);

  if (session === undefined) {
    return undefined;
  }

  if (session.expiresAt.getTime() <= now.getTime()) {
    await store.end(session.id);
    return undefined;
  }

  return session;
}

/**
 * Ends a session (REQ-104). The row goes, so the cookie the operator still
 * holds stops authorising at this instant and stays that way through any number
 * of restarts: there is nothing left anywhere for it to match.
 */
export function endSession(
  store: SessionStore,
  cookie: string | undefined,
): Promise<void> {
  if (cookie === undefined || cookie === "") {
    return Promise.resolve();
  }

  return store.end(cookie);
}

export interface SessionCookieConfig {
  /**
   * Whether the browser may only send the cookie over TLS.
   *
   * Conditional by necessity, not by taste (REQ-035 and acceptance criteria 10
   * and 11): local development runs on `http://localhost` with no TLS, because
   * the KEEL forbids `npm run dev` from requiring Docker or a proxy, and a
   * browser silently refuses to store a `secure` cookie sent over plain HTTP.
   * Hard-coding it on would leave the operator unable to log in locally with no
   * error to read; hard-coding it off would ship production without the mark.
   */
  readonly secure: boolean;
  /** Lifetime of the session this cookie carries, in milliseconds. */
  readonly ttlMs: number;
}

/**
 * The flags every session cookie is emitted with (REQ-035).
 *
 * Assembled here rather than at the call site so there is exactly one place
 * that can get it wrong, and one place a test can read.
 */
export interface SessionCookieFlags {
  readonly httpOnly: true;
  readonly secure: boolean;
  readonly sameSite: typeof SESSION_COOKIE_SAME_SITE;
  readonly path: "/";
  /** Seconds, which is what the header carries. */
  readonly maxAge: number;
}

export function sessionCookieFlags(
  config: SessionCookieConfig,
): SessionCookieFlags {
  return {
    // Never readable from JavaScript: a single injected script on the dashboard
    // would otherwise be enough to walk off with the session.
    httpOnly: true,
    secure: config.secure,
    sameSite: SESSION_COOKIE_SAME_SITE,
    // The whole origin, so the cookie reaches every private route rather than
    // only the one that issued it.
    path: "/",
    maxAge: Math.floor(config.ttlMs / 1000),
  };
}

/**
 * Reads the cookie policy out of the environment.
 *
 * The rule, in full:
 *
 *   - `SESSION_COOKIE_SECURE` unset: `secure` follows `NODE_ENV`, on in
 *     production and off anywhere else. This is what lets `npm run dev` work
 *     with no configuration at all, which is the constraint that made the flag
 *     conditional in the first place.
 *   - Set to `false` in production: REFUSED, naming the variable. Production
 *     requires the mark on (acceptance criterion 10), and there is no
 *     legitimate reason to turn it off there: a TLS-terminating proxy still
 *     speaks HTTPS to the browser, which is who decides whether to send the
 *     cookie. Refusing at start-up is the only way this is a decision instead
 *     of an accident nobody notices.
 *   - Set to anything that is not `true` or `false`: refused as an invalid
 *     value, like every other environment variable. Guessing that `0` means off
 *     would be a security decision taken by a typo.
 */
export function loadSessionCookieConfig(
  env: NodeJS.ProcessEnv,
  ttlMs: number = DEFAULT_SESSION_TTL_MS,
): SessionCookieConfig {
  const declared = (env[COOKIE_SECURE_VARIABLE] ?? "").trim().toLowerCase();
  const production =
    (env["NODE_ENV"] ?? "").trim().toLowerCase() === "production";

  if (declared === "") {
    return { secure: production, ttlMs };
  }

  if (declared === "false") {
    if (production) {
      throw new ConfigError(
        t("auth.insecureCookieInProduction", {
          variable: COOKIE_SECURE_VARIABLE,
        }),
        [COOKIE_SECURE_VARIABLE],
      );
    }

    return { secure: false, ttlMs };
  }

  if (declared === "true") {
    return { secure: true, ttlMs };
  }

  throw new ConfigError(
    configMessages.invalidEnvVariables([COOKIE_SECURE_VARIABLE]),
    [COOKIE_SECURE_VARIABLE],
  );
}
