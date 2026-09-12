import { eq } from "drizzle-orm";
import type { SecretCipher } from "./credentials.js";
import type { MyChatDatabase } from "./database.js";
import { storageConfiguration } from "./schema.js";
import type { StorageConfigurationRow } from "./schema.js";

export const STORAGE_CONFIGURATION_ID = "assets";
export type PersistedStorageDriver = "local" | "r2" | "s3";

export type PersistedStorageConfiguration =
  | { readonly driver: "local" }
  | {
      readonly driver: "r2" | "s3";
      readonly endpoint: string;
      readonly accessKeyId: string;
      readonly secretAccessKey: string;
      readonly bucket: string;
    };

export interface StorageConfigurationStore {
  read(): Promise<PersistedStorageConfiguration | undefined>;
  write(value: PersistedStorageConfiguration, now: Date): Promise<void>;
  remove?(): Promise<void>;
}

function fromRow(
  row: StorageConfigurationRow,
  cipher: SecretCipher,
): PersistedStorageConfiguration {
  if (row.driver === "local") return { driver: "local" };
  if (
    (row.driver !== "r2" && row.driver !== "s3") ||
    row.endpoint === null ||
    row.accessKeyId === null ||
    row.secretAccessKey === null ||
    row.bucket === null
  ) {
    throw new Error("Stored storage configuration is invalid");
  }
  return {
    driver: row.driver,
    endpoint: row.endpoint,
    accessKeyId: row.accessKeyId,
    secretAccessKey: cipher.decrypt(row.secretAccessKey),
    bucket: row.bucket,
  };
}

export function createStorageConfigurationStore(
  db: MyChatDatabase,
  cipher: SecretCipher,
): StorageConfigurationStore {
  const where = eq(storageConfiguration.id, STORAGE_CONFIGURATION_ID);
  return {
    read: () => {
      const [row] = db.select().from(storageConfiguration).where(where).all();
      return Promise.resolve(
        row === undefined ? undefined : fromRow(row, cipher),
      );
    },
    write: (value, now) => {
      const row =
        value.driver === "local"
          ? {
              id: STORAGE_CONFIGURATION_ID,
              driver: value.driver,
              endpoint: null,
              accessKeyId: null,
              secretAccessKey: null,
              bucket: null,
              updatedAt: now,
            }
          : {
              id: STORAGE_CONFIGURATION_ID,
              driver: value.driver,
              endpoint: value.endpoint,
              accessKeyId: value.accessKeyId,
              secretAccessKey: cipher.encrypt(value.secretAccessKey),
              bucket: value.bucket,
              updatedAt: now,
            };
      db.insert(storageConfiguration)
        .values(row)
        .onConflictDoUpdate({ target: storageConfiguration.id, set: row })
        .run();
      return Promise.resolve();
    },
    remove: () => {
      db.delete(storageConfiguration).where(where).run();
      return Promise.resolve();
    },
  };
}
