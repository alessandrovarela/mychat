import { describe, expect, it } from "vitest";
import {
  assertMetaEnvironmentIsolation,
  META_ENVIRONMENT_NAMES,
  META_PROTECTED_FIELDS,
} from "../../scripts/meta-environments.js";

const production = {
  accountId: "17890000000000001",
  appId: "10000000000000001",
  appSecret: "production-secret",
  callbackUrl: "https://chat.example.com/webhook",
  dataDirectory: "/var/lib/mychat-production",
  envFile: "/etc/mychat/production.env",
};

const test = {
  accountId: "17890000000000002",
  appId: "10000000000000002",
  appSecret: "test-secret",
  callbackUrl: "https://lab.chat.example.com/webhook",
  dataDirectory: "/var/lib/mychat-test",
  envFile: "/etc/mychat/test.env",
};

describe("REQ-425: deterministic Meta environment isolation", () => {
  it("accepts two complete, HTTPS, independently-owned environments before webhook startup", () => {
    expect(META_ENVIRONMENT_NAMES).toEqual(["production", "test"]);
    expect(META_PROTECTED_FIELDS).toEqual([
      "appId",
      "accountId",
      "callbackUrl",
      "appSecret",
      "envFile",
      "dataDirectory",
    ]);
    expect(assertMetaEnvironmentIsolation({ production, test })).toEqual({
      production,
      test,
    });
  });

  it.each(META_PROTECTED_FIELDS)(
    "refuses shared %s before a webhook can start",
    (field) => {
      expect(() =>
        assertMetaEnvironmentIsolation({
          production,
          test: { ...test, [field]: production[field] },
        }),
      ).toThrow(
        `Meta environment collision: production and test share ${field}`,
      );
    },
  );

  it("refuses incomplete environments and non-HTTPS callbacks", () => {
    expect(() =>
      assertMetaEnvironmentIsolation({
        production: { ...production, appSecret: "" },
        test,
      }),
    ).toThrow("production.appSecret must be a non-empty string");
    expect(() =>
      assertMetaEnvironmentIsolation({
        production: {
          ...production,
          callbackUrl: "http://chat.example.com/webhook",
        },
        test,
      }),
    ).toThrow("production.callbackUrl must be a valid HTTPS URL");
  });
});
