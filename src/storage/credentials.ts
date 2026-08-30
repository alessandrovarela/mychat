import { eq } from "drizzle-orm";
import type { AuthPath } from "../platform/account.js";
import type { MyChatDatabase } from "./database.js";
import { platformCredentials } from "./schema.js";
import type { PlatformCredentialRow } from "./schema.js";

/**
 * Where the platform credential lives between restarts.
 *
 * It has to be persisted rather than read from the environment on every start,
 * because a renewed token is a NEW value the application produced (REQ-081): an
 * environment variable would go stale sixty days later and the operator would
 * have no idea why deliveries stopped. The environment seeds the first token;
 * from then on this table is authoritative.
 */

/** The single row. One instance, one operator, one credential. */
export const PLATFORM_CREDENTIAL_ID = "platform";

export interface StoredCredential {
  readonly authPath: AuthPath;
  readonly accessToken: string;
  readonly accountId: string;
  /** Absent on a path whose token does not expire. */
  readonly expiresAt?: Date;
  readonly lastCheckedAt?: Date;
  readonly lastRefreshedAt?: Date;
}

export interface CredentialStore {
  /** Undefined on a fresh installation: nothing is configured yet. */
  read(): Promise<StoredCredential | undefined>;
  /** Seeds or replaces the credential wholesale. */
  write(credential: StoredCredential, now: Date): Promise<void>;
  /** After a renewal: the new token and the new expiry, together. */
  recordRefresh(
    accessToken: string,
    expiresAt: Date | undefined,
    now: Date,
  ): Promise<void>;
  /** After a health check, whatever it concluded. */
  recordCheck(now: Date): Promise<void>;
}

function toStored(row: PlatformCredentialRow): StoredCredential {
  return {
    authPath: row.authPath as AuthPath,
    accessToken: row.accessToken,
    accountId: row.accountId,
    ...(row.expiresAt !== null && { expiresAt: row.expiresAt }),
    ...(row.lastCheckedAt !== null && { lastCheckedAt: row.lastCheckedAt }),
    ...(row.lastRefreshedAt !== null && {
      lastRefreshedAt: row.lastRefreshedAt,
    }),
  };
}

export function createCredentialStore(db: MyChatDatabase): CredentialStore {
  const where = eq(platformCredentials.id, PLATFORM_CREDENTIAL_ID);

  return {
    read(): Promise<StoredCredential | undefined> {
      const [row] = db.select().from(platformCredentials).where(where).all();
      return Promise.resolve(row === undefined ? undefined : toStored(row));
    },

    write(credential: StoredCredential, now: Date): Promise<void> {
      db.insert(platformCredentials)
        .values({
          id: PLATFORM_CREDENTIAL_ID,
          authPath: credential.authPath,
          accessToken: credential.accessToken,
          accountId: credential.accountId,
          expiresAt: credential.expiresAt ?? null,
          lastCheckedAt: credential.lastCheckedAt ?? null,
          lastRefreshedAt: credential.lastRefreshedAt ?? null,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: platformCredentials.id,
          set: {
            authPath: credential.authPath,
            accessToken: credential.accessToken,
            accountId: credential.accountId,
            expiresAt: credential.expiresAt ?? null,
            updatedAt: now,
          },
        })
        .run();

      return Promise.resolve();
    },

    recordRefresh(
      accessToken: string,
      expiresAt: Date | undefined,
      now: Date,
    ): Promise<void> {
      db.update(platformCredentials)
        .set({
          accessToken,
          expiresAt: expiresAt ?? null,
          lastRefreshedAt: now,
          lastCheckedAt: now,
          updatedAt: now,
        })
        .where(where)
        .run();

      return Promise.resolve();
    },

    recordCheck(now: Date): Promise<void> {
      db.update(platformCredentials)
        .set({ lastCheckedAt: now, updatedAt: now })
        .where(where)
        .run();

      return Promise.resolve();
    },
  };
}
