import { eq } from "drizzle-orm";
import { INSTANCE_SETTINGS_PREFERENCE_KEY } from "../config/instance-settings.js";
import type { InstanceSettingsStore } from "../config/instance-settings.js";
import { TIME_ZONE_PREFERENCE_KEY } from "../config/timezone.js";
import type { TimeZonePreferenceStore } from "../config/timezone.js";
import {
  TRIGGER_SWITCHES_PREFERENCE_KEY,
  type TriggerSwitchStore,
} from "../config/trigger-switches.js";
import { LOCALE_PREFERENCE_KEY } from "../i18n/preference.js";
import type { LocalePreferenceStore } from "../i18n/preference.js";
import type { MyChatDatabase } from "./database.js";
import { instancePreferences } from "./schema.js";

/**
 * Where a choice the operator made in the panel survives a restart (REQ-102).
 *
 * One row per setting, key and value, because the language is the first
 * inhabitant of this table and will not be the last: a column per preference
 * would make a migration out of every later decision. The absence of a row is
 * itself the fact that matters, and the reason the environment is not written
 * here at start-up: "the operator never chose" and "the operator chose the same
 * thing the environment says" are different states, and only an empty table can
 * tell them apart.
 */

export interface PreferenceStore {
  /** Undefined when nothing was ever written under this key. */
  read(key: string): Promise<string | undefined>;
  write(key: string, value: string, now: Date): Promise<void>;
}

export function createPreferenceStore(db: MyChatDatabase): PreferenceStore {
  return {
    read(key: string): Promise<string | undefined> {
      const [row] = db
        .select()
        .from(instancePreferences)
        .where(eq(instancePreferences.key, key))
        .all();

      return Promise.resolve(row?.value);
    },

    write(key: string, value: string, now: Date): Promise<void> {
      db.insert(instancePreferences)
        .values({ key, value, updatedAt: now })
        .onConflictDoUpdate({
          target: instancePreferences.key,
          set: { value, updatedAt: now },
        })
        .run();

      return Promise.resolve();
    },
  };
}

/**
 * The same table seen through the one key the language uses, which is what
 * `createLocalePreference` asks for. The key is imported and never retyped: the
 * rule and its storage must name the same row.
 */
export function createLocalePreferenceStore(
  db: MyChatDatabase,
): LocalePreferenceStore {
  const store = createPreferenceStore(db);

  return {
    read: (): Promise<string | undefined> => store.read(LOCALE_PREFERENCE_KEY),
    write: (locale: string, now: Date): Promise<void> =>
      store.write(LOCALE_PREFERENCE_KEY, locale, now),
  };
}

/**
 * The same table seen through the row the time zone uses (REQ-183).
 *
 * The second inhabitant, and the reason the first one was a key and a value
 * rather than a column: nothing here had to change for it. The key is imported
 * from the rule that owns it, exactly as the locale's is.
 */
export function createTimeZonePreferenceStore(
  db: MyChatDatabase,
): TimeZonePreferenceStore {
  const store = createPreferenceStore(db);

  return {
    read: (): Promise<string | undefined> =>
      store.read(TIME_ZONE_PREFERENCE_KEY),
    write: (zone: string, now: Date): Promise<void> =>
      store.write(TIME_ZONE_PREFERENCE_KEY, zone, now),
  };
}

/**
 * The same key/value table seen through the document that says how long a step
 * waits, how often it asks and what it says (REQ-252, REQ-254, REQ-255,
 * REQ-257).
 *
 * The fourth inhabitant, and again nothing here had to change for it: one row,
 * one JSON, and the key imported from the rule that owns it.
 */
export function createInstanceSettingsStore(
  db: MyChatDatabase,
): InstanceSettingsStore {
  const store = createPreferenceStore(db);

  return {
    read: (): Promise<string | undefined> =>
      store.read(INSTANCE_SETTINGS_PREFERENCE_KEY),
    write: (value: string, now: Date): Promise<void> =>
      store.write(INSTANCE_SETTINGS_PREFERENCE_KEY, value, now),
  };
}

/** The same key/value table seen through the emergency trigger document. */
export function createTriggerSwitchStore(
  db: MyChatDatabase,
): TriggerSwitchStore {
  const store = createPreferenceStore(db);

  return {
    read: (): Promise<string | undefined> =>
      store.read(TRIGGER_SWITCHES_PREFERENCE_KEY),
    write: (value: string, now: Date): Promise<void> =>
      store.write(TRIGGER_SWITCHES_PREFERENCE_KEY, value, now),
  };
}
