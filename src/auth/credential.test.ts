import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigError } from "../config/errors.js";
import { loadEnvConfig } from "../config/env.js";
import { IN_MEMORY_DATABASE, openDatabase } from "../storage/database.js";
import type { DatabaseHandle } from "../storage/database.js";
import { operatorCredential } from "../storage/schema.js";
import type { OperatorCredentialRow } from "../storage/schema.js";
import {
  createOperatorCredentialStore,
  MINIMUM_PASSWORD_LENGTH,
  PASSWORD_ALGORITHM,
  setOperatorPassword,
  verifyOperatorPassword,
} from "./credential.js";
import type { OperatorCredentialStore } from "./credential.js";

/**
 * Proves REQ-033: the operator's password is stored only as a brute-force
 * resistant derivation, and plain text is refused wherever it could enter.
 *
 * Also proves the half of REQ-101 that has nothing to do with a terminal: a
 * second run replaces the credential in force, and the replacement decides who
 * authenticates from that instant, in the same process.
 */

const PASSWORD = "Zq7-Vamp!Krux9";
const OTHER_PASSWORD = "Bx4=Fjord?Wisp2";
const NOW = new Date("2026-08-02T09:00:00.000Z");

/** A complete environment, so a refusal under test is the only thing failing. */
const ENVIRONMENT = {
  META_APP_SECRET: "app-secret",
  WEBHOOK_VERIFY_TOKEN: "verify-token",
};

let handle: DatabaseHandle;
let store: OperatorCredentialStore;

beforeEach(() => {
  handle = openDatabase({ databasePath: IN_MEMORY_DATABASE });
  store = createOperatorCredentialStore(handle.db);
});

afterEach(() => {
  handle.close();
});

/** The row exactly as SQLite holds it, with nothing this module mapped. */
function storedRow(): OperatorCredentialRow | undefined {
  return handle.db.select().from(operatorCredential).all()[0];
}

describe("REQ-033: only a derivation of the password is persisted", () => {
  it("writes a hash that carries no trace of the password", async () => {
    await setOperatorPassword(PASSWORD, store, NOW);

    const row = storedRow();

    expect(row).toBeDefined();
    expect(row?.passwordHash).not.toBe(PASSWORD);
    expect(row?.passwordHash).not.toContain(PASSWORD);
    // The whole serialized row, so a password smuggled into any other column
    // would fail this too.
    expect(JSON.stringify(row)).not.toContain(PASSWORD);
  });

  it("uses argon2id at the parameters chosen, not at a library default", async () => {
    await setOperatorPassword(PASSWORD, store, NOW);

    // The encoded prefix is the only place these are observable, and observing
    // them is the point: a dependency that changed its defaults would weaken
    // the one thing standing between a stolen database and the account, with
    // no other symptom.
    expect(storedRow()?.passwordHash).toMatch(
      /^\$argon2id\$v=19\$m=19456,t=2,p=1\$/,
    );
    expect(storedRow()?.algorithm).toBe(PASSWORD_ALGORITHM);
  });

  it("records when the credential last changed", async () => {
    await setOperatorPassword(PASSWORD, store, NOW);

    expect(storedRow()?.updatedAt).toEqual(NOW);
  });

  it("keeps exactly one row however often it is set", async () => {
    await setOperatorPassword(PASSWORD, store, NOW);
    await setOperatorPassword(OTHER_PASSWORD, store, NOW);

    expect(handle.db.select().from(operatorCredential).all()).toHaveLength(1);
  });

  it("salts, so the same password twice is not the same stored value", async () => {
    await setOperatorPassword(PASSWORD, store, NOW);
    const first = storedRow()?.passwordHash;

    await setOperatorPassword(PASSWORD, store, NOW);

    // Without a per-credential salt, two installations sharing a password would
    // share a hash, and one cracked derivation would open both.
    expect(storedRow()?.passwordHash).not.toBe(first);
  });
});

describe("verifying a candidate against the credential in force", () => {
  it("accepts the password that was set and refuses anything else", async () => {
    await setOperatorPassword(PASSWORD, store, NOW);

    await expect(verifyOperatorPassword(PASSWORD, store)).resolves.toBe(true);
    await expect(verifyOperatorPassword(OTHER_PASSWORD, store)).resolves.toBe(
      false,
    );
  });

  it("authenticates nobody while no password has been set", async () => {
    await expect(verifyOperatorPassword("", store)).resolves.toBe(false);
    await expect(verifyOperatorPassword(PASSWORD, store)).resolves.toBe(false);
  });

  it("refuses a row written by an algorithm it cannot verify", async () => {
    await setOperatorPassword(PASSWORD, store, NOW);
    const hash = storedRow()?.passwordHash ?? "";

    await store.write(hash, "some-future-derivation", NOW);

    // Verifying with a function that did not produce the hash is not a check,
    // it is a coin toss dressed as one.
    await expect(verifyOperatorPassword(PASSWORD, store)).resolves.toBe(false);
  });
});

/**
 * Acceptance criterion 5, at the level below the command: replacing the
 * credential decides who authenticates from that instant, with no restart. The
 * store instance is the same object throughout, which is what makes "no
 * restart" a claim this test can make at all.
 */
describe("REQ-101: a replacement takes effect without restarting", () => {
  it("stops accepting the previous password and starts accepting the new one", async () => {
    await setOperatorPassword(PASSWORD, store, NOW);
    await expect(verifyOperatorPassword(PASSWORD, store)).resolves.toBe(true);

    await setOperatorPassword(OTHER_PASSWORD, store, NOW);

    await expect(verifyOperatorPassword(PASSWORD, store)).resolves.toBe(false);
    await expect(verifyOperatorPassword(OTHER_PASSWORD, store)).resolves.toBe(
      true,
    );
  });

  it("reports whether it created a credential or replaced one", async () => {
    await expect(setOperatorPassword(PASSWORD, store, NOW)).resolves.toEqual({
      ok: true,
      replaced: false,
    });

    await expect(
      setOperatorPassword(OTHER_PASSWORD, store, NOW),
    ).resolves.toEqual({ ok: true, replaced: true });
  });
});

describe("a password too short to be worth deriving", () => {
  it("is refused and leaves the credential in force untouched", async () => {
    await setOperatorPassword(PASSWORD, store, NOW);

    const outcome = await setOperatorPassword(
      "x".repeat(MINIMUM_PASSWORD_LENGTH - 1),
      store,
      NOW,
    );

    expect(outcome).toEqual({ ok: false, reason: "too_short" });
    // The previous password still authenticates: a refusal that had written
    // anything would have locked the operator out over their own typo.
    await expect(verifyOperatorPassword(PASSWORD, store)).resolves.toBe(true);
  });

  it("writes nothing at all when there was no credential yet", async () => {
    await setOperatorPassword("short", store, NOW);

    expect(storedRow()).toBeUndefined();
  });
});

/**
 * Acceptance criterion 6, the other half of REQ-033: plain text is refused in
 * the CONFIGURATION too, not only in storage. A password accepted from an
 * environment variable is a password in every child process and every crash
 * dump of this one.
 */
describe("REQ-033: a plain-text password in the environment stops start-up", () => {
  function refusal(env: NodeJS.ProcessEnv): ConfigError {
    try {
      loadEnvConfig(env);
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      return error as ConfigError;
    }

    expect.unreachable("a plain-text password must be refused");
  }

  it("refuses and names the variable", () => {
    const error = refusal({ ...ENVIRONMENT, OPERATOR_PASSWORD: PASSWORD });

    expect(error.variables).toContain("OPERATOR_PASSWORD");
  });

  it("never puts the value in the message it prints", () => {
    const error = refusal({ ...ENVIRONMENT, ADMIN_PASSWORD: PASSWORD });

    // The message is assembled from the locale catalogue, so what is asserted
    // here is what this code controls: the value is not in it. Which name the
    // sentence carries is `variables`, checked above, and the catalogue
    // interpolates that same list.
    expect(error.message).not.toContain(PASSWORD);
    expect(error.variables).toEqual(["ADMIN_PASSWORD"]);
  });

  it("names every offending variable, not just the first", () => {
    const error = refusal({
      ...ENVIRONMENT,
      OPERATOR_PASSWORD: PASSWORD,
      DASHBOARD_PASSWORD: PASSWORD,
    });

    expect(error.variables).toEqual([
      "OPERATOR_PASSWORD",
      "DASHBOARD_PASSWORD",
    ]);
  });

  it("refuses before reporting anything else that is missing", () => {
    // On an otherwise empty environment the missing-variable report would
    // normally fire. The exposed password outranks it: it is the one problem
    // that is already doing damage.
    const error = refusal({ OPERATOR_PASSWORD: PASSWORD });

    expect(error.variables).toEqual(["OPERATOR_PASSWORD"]);
  });

  it("starts normally when no such variable is set", () => {
    expect(() => loadEnvConfig({ ...ENVIRONMENT })).not.toThrow();
  });

  it("treats a blank refused variable as absent, like every other one", () => {
    // An empty assignment is what a commented-out line becomes, and refusing
    // that would stop a process over a password nobody set.
    expect(() =>
      loadEnvConfig({ ...ENVIRONMENT, OPERATOR_PASSWORD: "   " }),
    ).not.toThrow();
  });
});
