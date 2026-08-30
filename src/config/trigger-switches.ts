/**
 * Emergency instance-wide trigger switches (REQ-204).
 *
 * One persisted document keeps the three decisions together. The global
 * switch is an override: changing it never rewrites either channel, so the
 * operator gets the previous channel choices back when everything is enabled
 * again. An absent row is a fresh installation and means all three are on.
 */

export const TRIGGER_SWITCHES_PREFERENCE_KEY = "triggerSwitches";

export const TRIGGER_SWITCH_NAMES = [
  "all",
  "comments",
  "directMessages",
] as const;

export type TriggerSwitchName = (typeof TRIGGER_SWITCH_NAMES)[number];

export interface TriggerSwitchValue {
  readonly enabled: boolean;
  /** Absent until this particular switch has been changed by an operator. */
  readonly updatedAt?: Date;
}

export interface TriggerSwitchState {
  readonly all: TriggerSwitchValue;
  readonly comments: TriggerSwitchValue;
  readonly directMessages: TriggerSwitchValue;
}

export interface TriggerSwitchStore {
  read(): Promise<string | undefined>;
  write(value: string, now: Date): Promise<void>;
}

export interface TriggerSwitchPreference {
  read(): Promise<TriggerSwitchState>;
  choose(
    name: TriggerSwitchName,
    enabled: boolean,
  ): Promise<TriggerSwitchState>;
  allows(origin: "comment" | "direct_message"): Promise<boolean>;
}

interface StoredSwitches {
  readonly all?: TriggerSwitchValue;
  readonly comments?: TriggerSwitchValue;
  readonly directMessages?: TriggerSwitchValue;
}

const DEFAULT_VALUE: TriggerSwitchValue = { enabled: true };

function validValue(value: unknown): TriggerSwitchValue | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }

  const candidate = value as Record<string, unknown>;
  if (typeof candidate["enabled"] !== "boolean") return undefined;
  const rawAt = candidate["updatedAt"];
  const updatedAt = typeof rawAt === "string" ? new Date(rawAt) : undefined;

  return {
    enabled: candidate["enabled"],
    ...(updatedAt !== undefined &&
      !Number.isNaN(updatedAt.getTime()) && {
        updatedAt,
      }),
  };
}

function decode(raw: string | undefined): TriggerSwitchState {
  let stored: StoredSwitches = {};
  if (raw !== undefined) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        !Array.isArray(parsed)
      ) {
        stored = parsed as StoredSwitches;
      }
    } catch {
      // A malformed historical row must fail open: these are emergency
      // switches, and only a valid explicit choice is allowed to stop traffic.
    }
  }

  return {
    all: validValue(stored.all) ?? DEFAULT_VALUE,
    comments: validValue(stored.comments) ?? DEFAULT_VALUE,
    directMessages: validValue(stored.directMessages) ?? DEFAULT_VALUE,
  };
}

function encode(state: TriggerSwitchState): string {
  return JSON.stringify({
    all: {
      enabled: state.all.enabled,
      ...(state.all.updatedAt !== undefined && {
        updatedAt: state.all.updatedAt.toISOString(),
      }),
    },
    comments: {
      enabled: state.comments.enabled,
      ...(state.comments.updatedAt !== undefined && {
        updatedAt: state.comments.updatedAt.toISOString(),
      }),
    },
    directMessages: {
      enabled: state.directMessages.enabled,
      ...(state.directMessages.updatedAt !== undefined && {
        updatedAt: state.directMessages.updatedAt.toISOString(),
      }),
    },
  });
}

export function createTriggerSwitchPreference(deps: {
  readonly store: TriggerSwitchStore;
  readonly now: () => Date;
}): TriggerSwitchPreference {
  const read = async (): Promise<TriggerSwitchState> =>
    decode(await deps.store.read());

  return {
    read,
    choose: async (name, enabled): Promise<TriggerSwitchState> => {
      const previous = await read();
      const changedAt = deps.now();
      const state: TriggerSwitchState = {
        ...previous,
        [name]: { enabled, updatedAt: changedAt },
      };
      await deps.store.write(encode(state), changedAt);
      return state;
    },
    allows: async (origin): Promise<boolean> => {
      const state = await read();
      if (!state.all.enabled) return false;
      return origin === "comment"
        ? state.comments.enabled
        : state.directMessages.enabled;
    },
  };
}
