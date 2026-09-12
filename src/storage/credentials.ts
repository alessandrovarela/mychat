import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
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

const CIPHER_VERSION = "v1";
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;

/** Encrypts persisted secret values with the instance's local 256-bit key. */
export interface SecretCipher {
  encrypt(value: string): string;
  decrypt(value: string): string;
}

/**
 * AES-256-GCM keeps the database from containing a usable platform token.
 * The key is supplied by the local-volume key store, never an environment
 * variable, so a renewed credential remains readable after a restart.
 */
export function createSecretCipher(key: Buffer): SecretCipher {
  if (key.length !== 32) {
    throw new Error("A local secret cipher requires a 32-byte key");
  }

  return {
    encrypt(value: string): string {
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      const encrypted = Buffer.concat([
        cipher.update(value, "utf8"),
        cipher.final(),
      ]);
      const tag = cipher.getAuthTag();
      return [
        CIPHER_VERSION,
        iv.toString("base64url"),
        tag.toString("base64url"),
        encrypted.toString("base64url"),
      ].join(".");
    },

    decrypt(value: string): string {
      const [version, ivText, tagText, ciphertext] = value.split(".");
      if (
        version !== CIPHER_VERSION ||
        ivText === undefined ||
        tagText === undefined ||
        ciphertext === undefined
      ) {
        throw new Error("Stored secret has an unsupported encryption format");
      }

      const iv = Buffer.from(ivText, "base64url");
      const tag = Buffer.from(tagText, "base64url");
      if (iv.length !== IV_BYTES || tag.length !== AUTH_TAG_BYTES) {
        throw new Error("Stored secret has an invalid encryption format");
      }

      try {
        const decipher = createDecipheriv("aes-256-gcm", key, iv);
        decipher.setAuthTag(tag);
        return Buffer.concat([
          decipher.update(Buffer.from(ciphertext, "base64url")),
          decipher.final(),
        ]).toString("utf8");
      } catch {
        throw new Error(
          "Stored secret cannot be decrypted with this instance key",
        );
      }
    },
  };
}

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
  /** Removes the credential rather than leaving an unusable token behind. */
  remove?(): Promise<void>;
}

function toStored(
  row: PlatformCredentialRow,
  cipher: SecretCipher | undefined,
): StoredCredential {
  // Credentials written before local encryption was introduced are retained
  // for one read so an upgrade does not lock an operator out of their Meta
  // integration. The next replacement or refresh writes the encrypted form.
  const accessToken =
    cipher === undefined || !row.accessToken.startsWith(`${CIPHER_VERSION}.`)
      ? row.accessToken
      : cipher.decrypt(row.accessToken);
  return {
    authPath: row.authPath as AuthPath,
    accessToken,
    accountId: row.accountId,
    ...(row.expiresAt !== null && { expiresAt: row.expiresAt }),
    ...(row.lastCheckedAt !== null && { lastCheckedAt: row.lastCheckedAt }),
    ...(row.lastRefreshedAt !== null && {
      lastRefreshedAt: row.lastRefreshedAt,
    }),
  };
}

export function createCredentialStore(
  db: MyChatDatabase,
  cipher?: SecretCipher,
): CredentialStore {
  const where = eq(platformCredentials.id, PLATFORM_CREDENTIAL_ID);

  return {
    read(): Promise<StoredCredential | undefined> {
      const [row] = db.select().from(platformCredentials).where(where).all();
      return Promise.resolve().then(() =>
        row === undefined ? undefined : toStored(row, cipher),
      );
    },

    write(credential: StoredCredential, now: Date): Promise<void> {
      db.insert(platformCredentials)
        .values({
          id: PLATFORM_CREDENTIAL_ID,
          authPath: credential.authPath,
          accessToken:
            cipher?.encrypt(credential.accessToken) ?? credential.accessToken,
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
            accessToken:
              cipher?.encrypt(credential.accessToken) ?? credential.accessToken,
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
          accessToken: cipher?.encrypt(accessToken) ?? accessToken,
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

    remove(): Promise<void> {
      db.delete(platformCredentials).where(where).run();
      return Promise.resolve();
    },
  };
}
