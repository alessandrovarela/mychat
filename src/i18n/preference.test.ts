import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { guardContracts, installRefusals } from "../http/api/contract.js";
import { LOCALE_ROUTE, registerLocaleRoutes } from "../http/api/locale.js";
import { createLocalePreferenceStore } from "../storage/preferences.js";
import { openDatabase } from "../storage/database.js";
import type { DatabaseHandle } from "../storage/database.js";
import {
  createLocalePreference,
  INITIAL_LOCALE_VARIABLE,
  LOCALE_PREFERENCE_KEY,
  UNKNOWN_LOCALE,
} from "./preference.js";
import type { LocalePreference } from "./preference.js";
import { createTranslator, DEFAULT_LOCALE } from "./translator.js";
import type { Translator } from "./translator.js";

/**
 * Proves REQ-102: the language chosen in the panel is stored in the instance
 * and holds for the sessions that follow, INCLUDING after the process
 * restarts, while the environment supplies only the initial value.
 *
 * The restart is proven the only way it can be: a real database file, written
 * through one connection and read through another, with the first one closed in
 * between. An in-memory database would prove that a value survives a variable,
 * which is not what criterion 44 asks about.
 *
 * The catalogues are invented rather than the shipped ones, and deliberately:
 * this file is about the RULE (who decides the language), and inventing the
 * locales keeps it from passing merely because `en` happens to be the default
 * everywhere.
 */

const NOW = new Date("2026-08-02T15:00:00.000Z");
const OTHER = "pt-BR";

const CATALOGUES = {
  en: { probe: "english" },
  [OTHER]: { probe: "português" },
};

const dirs: string[] = [];
const handles: DatabaseHandle[] = [];
const servers: FastifyInstance[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "mychat-locale-"));
  dirs.push(dir);
  return dir;
}

function open(dir: string): DatabaseHandle {
  const handle = openDatabase({ databasePath: join(dir, "mychat.db") });
  handles.push(handle);
  return handle;
}

interface Instance {
  readonly preference: LocalePreference;
  readonly catalogue: Translator;
  close(): void;
}

/**
 * One run of the process: its own connection, its own translator, its own view
 * of the environment. Starting a second one over the same directory is what a
 * restart is.
 */
function boot(dir: string, env: NodeJS.ProcessEnv = {}): Instance {
  const handle = open(dir);
  const catalogue = createTranslator(CATALOGUES);

  return {
    catalogue,
    preference: createLocalePreference({
      store: createLocalePreferenceStore(handle.db),
      catalogue,
      env,
      now: () => NOW,
    }),
    close: () => {
      handle.close();
      handles.splice(handles.indexOf(handle), 1);
    },
  };
}

async function serve(preference: LocalePreference): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  servers.push(app);

  await app.register(async (scope) => {
    // The same boot guard the API scope installs, so a contract this route
    // failed to declare stops here instead of reaching `api-contract.test.ts`
    // as a mystery.
    guardContracts(scope);
    installRefusals(scope);
    registerLocaleRoutes(scope, preference);
  });

  await app.ready();
  return app;
}

afterEach(async () => {
  for (const app of servers.splice(0)) {
    await app.close();
  }
  for (const handle of handles.splice(0)) {
    handle.close();
  }
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("REQ-102: the environment is the initial value, never the decision", () => {
  it("uses the environment while the operator has never chosen", async () => {
    const { preference } = boot(tempDir(), {
      [INITIAL_LOCALE_VARIABLE]: OTHER,
    });

    expect(await preference.inForce()).toEqual({
      locale: OTHER,
      source: "environment",
    });
  });

  it("falls back to the default when nothing is stored and nothing is set", async () => {
    const { preference } = boot(tempDir());

    expect(await preference.inForce()).toEqual({
      locale: DEFAULT_LOCALE,
      source: "default",
    });
  });

  it("ignores the environment once a choice exists, even a contradicting one", async () => {
    // The whole of the requirement's second sentence. Read the environment
    // first and this test is the one that fails, on the only machine that
    // matters: the one where the variable IS set.
    const { preference } = boot(tempDir(), {
      [INITIAL_LOCALE_VARIABLE]: DEFAULT_LOCALE,
    });

    await preference.choose(OTHER);

    expect(await preference.inForce()).toEqual({
      locale: OTHER,
      source: "stored",
    });
  });

  it("keeps a stored language this build cannot render as a choice made", async () => {
    const dir = tempDir();
    const first = boot(dir);
    await first.preference.choose(OTHER);
    first.close();

    // A build shipping only English reads the same row: the text falls back,
    // the row is left alone, and the choice is still there for the build that
    // can render it.
    const handle = open(dir);
    const catalogue = createTranslator({ en: CATALOGUES.en });
    const preference = createLocalePreference({
      store: createLocalePreferenceStore(handle.db),
      catalogue,
      env: {},
      now: () => NOW,
    });

    expect(await preference.inForce()).toEqual({
      locale: DEFAULT_LOCALE,
      source: "stored",
    });
  });
});

describe("REQ-102: the choice survives the process (criterion 44)", () => {
  it("is read back by a run that never saw the request that made it", async () => {
    const dir = tempDir();

    const first = boot(dir, { [INITIAL_LOCALE_VARIABLE]: DEFAULT_LOCALE });
    await first.preference.choose(OTHER);
    // The restart proper: the connection that wrote the row is gone.
    first.close();

    const second = boot(dir, { [INITIAL_LOCALE_VARIABLE]: DEFAULT_LOCALE });

    expect(await second.preference.apply()).toEqual({
      locale: OTHER,
      source: "stored",
    });
    // And the process really speaks it: applying is what makes the trail and
    // the terminal answer in the operator's language too (REQ-074).
    expect(second.catalogue.current()).toBe(OTHER);
    expect(second.catalogue.t("probe")).toBe("português");
  });

  it("stores the choice under the one key the table is read by", async () => {
    const dir = tempDir();
    const { preference } = boot(dir);

    await preference.choose(OTHER);

    const handle = open(dir);
    const rows = handle.connection
      .prepare("select key, value from instance_preferences")
      .all() as { key: string; value: string }[];

    expect(rows).toEqual([{ key: LOCALE_PREFERENCE_KEY, value: OTHER }]);
  });

  it("writes nothing at all while the operator has not chosen", async () => {
    const dir = tempDir();
    const { preference } = boot(dir, { [INITIAL_LOCALE_VARIABLE]: OTHER });

    await preference.apply();

    const handle = open(dir);
    const rows = handle.connection
      .prepare("select key from instance_preferences")
      .all();

    // An empty table is the fact that lets the environment still matter. Seed
    // it at start-up and the variable becomes the decision, forever.
    expect(rows).toEqual([]);
  });
});

describe("REQ-102: the panel reads and writes the language over /api", () => {
  it("answers what is in force and what this build can be switched to", async () => {
    const { preference } = boot(tempDir(), {
      [INITIAL_LOCALE_VARIABLE]: OTHER,
    });
    const app = await serve(preference);

    const response = await app.inject({ method: "GET", url: LOCALE_ROUTE });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      locale: OTHER,
      available: [DEFAULT_LOCALE, OTHER],
    });
  });

  it("stores the choice and the next read answers with it", async () => {
    const { preference } = boot(tempDir());
    const app = await serve(preference);

    const written = await app.inject({
      method: "POST",
      url: LOCALE_ROUTE,
      payload: { locale: OTHER },
    });

    expect(written.statusCode).toBe(200);
    expect(written.json()).toEqual({
      locale: OTHER,
      available: [DEFAULT_LOCALE, OTHER],
    });

    const read = await app.inject({ method: "GET", url: LOCALE_ROUTE });

    expect(read.json<{ locale: string }>().locale).toBe(OTHER);
  });

  it("refuses a language this build carries no catalogue for, storing nothing", async () => {
    const { preference } = boot(tempDir());
    const app = await serve(preference);

    const response = await app.inject({
      method: "POST",
      url: LOCALE_ROUTE,
      payload: { locale: "zz-ZZ" },
    });

    // 422: the request was well formed and the domain refused what it carried.
    expect(response.statusCode).toBe(422);
    expect(response.json()).toEqual({ error: UNKNOWN_LOCALE });
    expect((await preference.inForce()).source).toBe("default");
  });

  it("refuses a body that does not declare a language", async () => {
    const { preference } = boot(tempDir());
    const app = await serve(preference);

    const response = await app.inject({
      method: "POST",
      url: LOCALE_ROUTE,
      payload: {},
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: "invalid_request",
      issues: [{ source: "body", path: "locale", rule: "required" }],
    });
  });
});
