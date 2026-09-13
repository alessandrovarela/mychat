import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { IN_MEMORY_DATABASE, openDatabase } from "./database.js";
import type { DatabaseHandle } from "./database.js";
import {
  PLATFORM_CREDENTIAL_ID,
  createCredentialStore,
  createSecretCipher,
} from "./credentials.js";
import { platformCredentials } from "./schema.js";

const NOW = new Date("2026-09-05T12:00:00.000Z");
const TOKEN = "meta-token-that-must-not-live-in-sqlite";
const KEY = Buffer.alloc(32, 7);

let handle: DatabaseHandle;

beforeEach(() => {
  handle = openDatabase({ databasePath: IN_MEMORY_DATABASE });
});

afterEach(() => {
  handle.close();
});

describe("REQ-437: persisted credentials are encrypted with the local key", () => {
  it("upgrades a legacy plaintext credential on its first encrypted read", async () => {
    const legacy = createCredentialStore(handle.db);
    await legacy.write(
      {
        authPath: "instagram_login",
        accessToken: TOKEN,
        accountId: "account-1",
        expiresAt: new Date("2026-11-04T12:00:00.000Z"),
        lastCheckedAt: new Date("2026-09-04T12:00:00.000Z"),
        lastRefreshedAt: new Date("2026-09-03T12:00:00.000Z"),
      },
      NOW,
    );

    const encrypted = createCredentialStore(handle.db, createSecretCipher(KEY));
    await expect(encrypted.read()).resolves.toMatchObject({
      accessToken: TOKEN,
      accountId: "account-1",
    });

    const [row] = handle.db
      .select()
      .from(platformCredentials)
      .where(eq(platformCredentials.id, PLATFORM_CREDENTIAL_ID))
      .all();
    expect(row?.accessToken).toMatch(/^v1\./);
    expect(row?.accessToken).not.toContain(TOKEN);
    expect(row?.updatedAt).toEqual(NOW);
    await expect(encrypted.read()).resolves.toMatchObject({
      accessToken: TOKEN,
      accountId: "account-1",
    });
  });

  it("round-trips a credential after a restart without an environment secret", async () => {
    const first = createCredentialStore(handle.db, createSecretCipher(KEY));
    await first.write(
      {
        authPath: "instagram_login",
        accessToken: TOKEN,
        accountId: "account-1",
      },
      NOW,
    );

    const [row] = handle.db
      .select()
      .from(platformCredentials)
      .where(eq(platformCredentials.id, PLATFORM_CREDENTIAL_ID))
      .all();
    expect(row?.accessToken).not.toBe(TOKEN);
    expect(row?.accessToken).not.toContain(TOKEN);

    // A second store over the same database and same local key is a restart.
    const restarted = createCredentialStore(handle.db, createSecretCipher(KEY));
    await expect(restarted.read()).resolves.toMatchObject({
      accessToken: TOKEN,
      accountId: "account-1",
    });
  });

  it("rejects a stored secret when a different instance key attempts to read it", async () => {
    const writer = createCredentialStore(handle.db, createSecretCipher(KEY));
    await writer.write(
      {
        authPath: "instagram_login",
        accessToken: TOKEN,
        accountId: "account-1",
      },
      NOW,
    );

    await expect(
      createCredentialStore(
        handle.db,
        createSecretCipher(Buffer.alloc(32, 8)),
      ).read(),
    ).rejects.toThrow("cannot be decrypted");
  });
});
