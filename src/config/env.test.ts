import { describe, expect, it } from "vitest";
import { ConfigError } from "./errors.js";
import { loadEnvConfig } from "./env.js";

const SECRET = "s3cr3t-value-that-must-never-be-printed";

const credentials = {
  META_APP_SECRET: SECRET,
  META_ACCESS_TOKEN: `token-${SECRET}`,
  WEBHOOK_VERIFY_TOKEN: `verify-${SECRET}`,
};

const s3Credentials = {
  S3_ENDPOINT: "https://account.r2.cloudflarestorage.com",
  S3_ACCESS_KEY_ID: `key-${SECRET}`,
  S3_SECRET_ACCESS_KEY: `secret-${SECRET}`,
  S3_BUCKET: "mychat",
};

function expectConfigError(env: NodeJS.ProcessEnv): ConfigError {
  try {
    loadEnvConfig(env);
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigError);
    return error as ConfigError;
  }

  expect.unreachable("an invalid environment must throw");
}

/**
 * Product credentials are optional bootstrap imports. Their absence must never
 * stop a first installation from reaching the wizard.
 */
describe("environment configuration", () => {
  it("accepts a complete environment and applies the defaults", () => {
    const config = loadEnvConfig({ ...credentials });

    expect(config).toEqual({
      metaAppSecret: credentials.META_APP_SECRET,
      metaAccessToken: credentials.META_ACCESS_TOKEN,
      webhookVerifyToken: credentials.WEBHOOK_VERIFY_TOKEN,
      port: 3000,
      publicOrigin: "http://localhost:3000",
      tokenLifetimeMs: 60 * 24 * 60 * 60 * 1000,
      // What every dashboard bucket already was before the zone could be
      // configured, so an installation that names none counts as it did.
      timeZone: "UTC",
      databasePath: "./dev-data/mychat.db",
      storage: {
        driver: "disk",
        assetsDir: "./dev-data/assets",
        thumbnailsDir: "./dev-data/thumbs",
      },
      sweepIntervalMs: 5000,
      credentialCheckIntervalMs: 6 * 60 * 60 * 1000,
      tokenRefreshThresholdMs: 10 * 24 * 60 * 60 * 1000,
    });
  });

  it("starts a new installation with no environment file at all", () => {
    const config = loadEnvConfig({});

    expect(config.metaAppSecret).toBe("");
    expect(config.metaAccessToken).toBeUndefined();
    expect(config.webhookVerifyToken).toBe("");
    expect(config.instagramAccountId).toBeUndefined();
  });

  it("defaults the public origin to the port actually listened on", () => {
    // The address of every delivered resource is built from this, so a default
    // that disagreed with the port would produce links that lead nowhere.
    expect(loadEnvConfig({ ...credentials, PORT: "8080" }).publicOrigin).toBe(
      "http://localhost:8080",
    );
  });

  it("strips the trailing slash of a configured public origin", () => {
    const config = loadEnvConfig({
      ...credentials,
      PUBLIC_ORIGIN: "https://tunnel.example.com/",
    });

    expect(config.publicOrigin).toBe("https://tunnel.example.com");
  });

  it("lets the environment set the sweep interval", () => {
    const config = loadEnvConfig({ ...credentials, SWEEP_INTERVAL_MS: "250" });

    expect(config.sweepIntervalMs).toBe(250);
  });

  it("rejects a sweep interval that is not a positive whole number", () => {
    // Zero would spin the loop, and a negative value is a typo the operator
    // must see rather than have silently corrected behind their back.
    expect(() =>
      loadEnvConfig({ ...credentials, SWEEP_INTERVAL_MS: "0" }),
    ).toThrow();
    expect(() =>
      loadEnvConfig({ ...credentials, SWEEP_INTERVAL_MS: "not-a-number" }),
    ).toThrow();
  });

  it("lets the environment override the defaults", () => {
    const config = loadEnvConfig({
      ...credentials,
      DATABASE_PATH: "/var/lib/mychat/mychat.db",
      ASSETS_DIR: "/var/lib/mychat/assets",
      THUMBNAILS_DIR: "/var/lib/mychat/thumbs",
    });

    expect(config.databasePath).toBe("/var/lib/mychat/mychat.db");
    expect(config.storage).toEqual({
      driver: "disk",
      assetsDir: "/var/lib/mychat/assets",
      thumbnailsDir: "/var/lib/mychat/thumbs",
    });
  });

  it("does not treat blank legacy credentials as configuration", () => {
    const config = loadEnvConfig({
      META_APP_SECRET: "  ",
      WEBHOOK_VERIFY_TOKEN: "  ",
    });

    expect(config.metaAppSecret).toBe("");
    expect(config.webhookVerifyToken).toBe("");
  });

  it("does not require the S3 variables while the driver is disk", () => {
    const config = loadEnvConfig({ ...credentials, STORAGE_DRIVER: "disk" });

    expect(config.storage).toEqual({
      driver: "disk",
      assetsDir: "./dev-data/assets",
      thumbnailsDir: "./dev-data/thumbs",
    });
  });

  it("lists the missing S3 variables when the driver is s3", () => {
    const error = expectConfigError({ ...credentials, STORAGE_DRIVER: "s3" });

    expect(error.variables).toEqual([
      "S3_ENDPOINT",
      "S3_ACCESS_KEY_ID",
      "S3_SECRET_ACCESS_KEY",
      "S3_BUCKET",
    ]);
    expect(error.message).not.toContain(SECRET);
  });

  it("accepts the s3 driver once every S3 variable is present", () => {
    const config = loadEnvConfig({
      ...credentials,
      STORAGE_DRIVER: "s3",
      ...s3Credentials,
    });

    expect(config.storage).toEqual({
      driver: "s3",
      thumbnailsDir: "./dev-data/thumbs",
      endpoint: s3Credentials.S3_ENDPOINT,
      accessKeyId: s3Credentials.S3_ACCESS_KEY_ID,
      secretAccessKey: s3Credentials.S3_SECRET_ACCESS_KEY,
      bucket: s3Credentials.S3_BUCKET,
    });
  });

  it("reports only the S3 variables that are still missing", () => {
    const error = expectConfigError({
      META_APP_SECRET: SECRET,
      META_ACCESS_TOKEN: `token-${SECRET}`,
      WEBHOOK_VERIFY_TOKEN: `verify-${SECRET}`,
      STORAGE_DRIVER: "s3",
      S3_ENDPOINT: s3Credentials.S3_ENDPOINT,
      S3_ACCESS_KEY_ID: s3Credentials.S3_ACCESS_KEY_ID,
      S3_SECRET_ACCESS_KEY: s3Credentials.S3_SECRET_ACCESS_KEY,
    });

    expect(error.variables).toEqual(["S3_BUCKET"]);
  });

  it("rejects an unsupported storage driver without echoing the value", () => {
    const error = expectConfigError({
      ...credentials,
      STORAGE_DRIVER: "dropbox",
    });

    expect(error.variables).toEqual(["STORAGE_DRIVER"]);
    expect(error.message).toContain("Invalid values");
    expect(error.message).not.toContain("dropbox");
  });

  it("reads only the environment it is given, never process.env", () => {
    const previous = process.env.META_APP_SECRET;
    process.env.META_APP_SECRET = SECRET;

    try {
      const config = loadEnvConfig({});

      expect(config.metaAppSecret).toBe("");
    } finally {
      if (previous === undefined) {
        delete process.env.META_APP_SECRET;
      } else {
        process.env.META_APP_SECRET = previous;
      }
    }
  });
});
