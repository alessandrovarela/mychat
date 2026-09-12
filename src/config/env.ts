import { z } from "zod";
import { t } from "../i18n/index.js";
import { ConfigError, configMessages } from "./errors.js";
import { DEFAULT_TIME_ZONE, isKnownTimeZone } from "./timezone.js";

/**
 * Infrastructure environment configuration and compatibility inputs for an
 * older installation. A fresh installation needs neither an `.env` file nor a
 * Meta value: the wizard persists product configuration later.
 *
 * Pure by design: the environment arrives as an argument, `process.env` is
 * never read here, so a test can exercise any environment shape.
 */

export const STORAGE_DRIVERS = ["disk", "s3"] as const;
export type StorageDriver = (typeof STORAGE_DRIVERS)[number];

const DEFAULT_STORAGE_DRIVER: StorageDriver = "disk";
const DEFAULT_DATABASE_PATH = "./dev-data/mychat.db";
const DEFAULT_ASSETS_DIR = "./dev-data/assets";
/**
 * Where the cached publication thumbnails land on disk. A sibling of the
 * resources directory and never inside it, which is how the bucket holds them
 * too (ADR-010: `assets/` and `thumbs/` are sibling prefixes): what the
 * operator uploaded is browsed and validated as a catalogue, while these are
 * written by this application and only ever read by key.
 */
const DEFAULT_THUMBNAILS_DIR = "./dev-data/thumbs";
const DEFAULT_PORT = 3000;

/**
 * Lifetime assumed for the token seeded from the environment, on the Instagram
 * Login path (ADR-021: sixty days, and no token on that path is eternal).
 *
 * It is an ESTIMATE, and only ever used once: the platform does not report when
 * an already issued token expires, so the seed counts sixty days from the
 * instant it was stored, which is the operator pasting a token they have just
 * generated. The first successful renewal replaces the estimate with the
 * platform's own number, and the ten-day renewal threshold absorbs the drift of
 * a token that was already a few days old. Overridable for the operator who
 * knows their token is older than that.
 */
const DEFAULT_TOKEN_LIFETIME_MS = 60 * 24 * 60 * 60 * 1000;

/**
 * How often the durable-work sweep looks for work that is due (ADR-005).
 *
 * Five seconds is a latency budget, not a platform limit: nothing in the
 * platform documentation constrains it, so it does NOT belong in
 * `limits.ts`, whose contract is that every value there is traceable to
 * `docs/platform-limits.md`. What it costs is one indexed query per interval on
 * a single-profile install, which is nothing; what it buys is that a contact
 * waits at most this long past a due instant.
 */
const DEFAULT_SWEEP_INTERVAL_MS = 5000;

/**
 * How often the platform credential is checked (REQ-088), and how long before
 * expiry a renewal is attempted (REQ-081).
 *
 * Six hours and ten days: both are operational choices, not platform numbers,
 * which is why they live here and not in `limits.ts`. Ten days inside a
 * sixty-day token means roughly forty chances to renew before it dies, so a
 * transient failure is nowhere near fatal.
 */
const DEFAULT_CREDENTIAL_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const DEFAULT_TOKEN_REFRESH_THRESHOLD_MS = 10 * 24 * 60 * 60 * 1000;

/** Required whenever the storage driver is `s3`, unused otherwise. */
const s3Object = z.object({
  S3_ENDPOINT: z.string().min(1),
  S3_ACCESS_KEY_ID: z.string().min(1),
  S3_SECRET_ACCESS_KEY: z.string().min(1),
  S3_BUCKET: z.string().min(1),
});

type S3Variable = keyof z.infer<typeof s3Object>;

const S3_VARIABLES = Object.keys(s3Object.shape) as S3Variable[];

const envShape = {
  META_APP_SECRET: z.string().min(1).optional(),
  /**
   * Every Meta value is optional. They are consumed only as a one-time legacy
   * import; a new instance receives them through the authenticated panel.
   */
  META_ACCESS_TOKEN: z.string().min(1).optional(),
  WEBHOOK_VERIFY_TOKEN: z.string().min(1).optional(),
  /**
   * The account's own platform id, the `<ig-id>` of `/<ig-id>/messages`. Also
   * optional, and for the same reason: without it there is no credential to
   * seed, which is exactly what a fresh installation looks like.
   */
  INSTAGRAM_ACCOUNT_ID: z.string().min(1).optional(),
  PORT: z.coerce.number().int().positive().max(65535).default(DEFAULT_PORT),
  /**
   * Where the PLATFORM reaches this process: a tunnel in development, a domain
   * in production. It is what the address of every delivered resource is built
   * from, so a wrong value produces links that lead nowhere with no error on
   * our side.
   */
  PUBLIC_ORIGIN: z.string().min(1).optional(),
  TOKEN_LIFETIME_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(DEFAULT_TOKEN_LIFETIME_MS),
  /**
   * The zone the panel AGGREGATES and labels in (REQ-153).
   *
   * Configuration of the INSTANCE and not a preference of a person, for the
   * reason ADR-023 gives: there is one instance per operated account, so there
   * is no plural of operator to disagree about it. It sits beside
   * `MYCHAT_LOCALE` in the same sense, one instance-wide decision about how the
   * numbers are read.
   *
   * PARSED here, unlike the locale, because the rule is a validation and not a
   * precedence: a zone this build's calendar data does not know cannot be
   * bucketed in at all, so it is rejected by name at start-up like any other
   * value this file refuses. Absent leaves UTC in force, which is what every
   * bucket already was.
   *
   * It is the INITIAL value and no longer the last word (REQ-183). The zone is
   * changeable in the panel, and a choice made there wins on every later read,
   * so what this variable decides is the zone of an instance whose operator has
   * never chosen one. `src/config/timezone.ts` holds that precedence, and the
   * check above is imported from the same file, so the panel refuses exactly
   * what this line refuses.
   */
  MYCHAT_TIMEZONE: z
    .string()
    .min(1)
    .refine(isKnownTimeZone)
    .default(DEFAULT_TIME_ZONE),
  DATABASE_PATH: z.string().min(1).default(DEFAULT_DATABASE_PATH),
  STORAGE_DRIVER: z.enum(STORAGE_DRIVERS).default(DEFAULT_STORAGE_DRIVER),
  ASSETS_DIR: z.string().min(1).default(DEFAULT_ASSETS_DIR),
  THUMBNAILS_DIR: z.string().min(1).default(DEFAULT_THUMBNAILS_DIR),
  SWEEP_INTERVAL_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(DEFAULT_SWEEP_INTERVAL_MS),
  CREDENTIAL_CHECK_INTERVAL_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(DEFAULT_CREDENTIAL_CHECK_INTERVAL_MS),
  TOKEN_REFRESH_THRESHOLD_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(DEFAULT_TOKEN_REFRESH_THRESHOLD_MS),
  ...s3Object.partial().shape,
};

const envObject = z.object(envShape);

const envSchema = envObject.superRefine((value, ctx) => {
  if (value.STORAGE_DRIVER !== "s3") {
    return;
  }

  for (const variable of S3_VARIABLES) {
    if (value[variable] === undefined) {
      ctx.addIssue({
        code: "custom",
        path: [variable],
        message: "required when STORAGE_DRIVER is s3",
      });
    }
  }
});

/** Every variable this schema parses, in the order it declares them. */
const SCHEMA_ENV_VARIABLES: readonly string[] = Object.keys(envShape);

/**
 * Variables this file DECLARES but does not parse, because the rule that reads
 * them cannot move here without dragging behaviour that belongs elsewhere:
 *
 *   - `MYCHAT_LOCALE` seeds the language of a fresh installation, and the rule
 *     around it is a precedence rule, not a validation: the choice stored by
 *     the panel wins, and the variable is consulted only while there is none
 *     (REQ-102, `src/i18n/preference.ts`). An unknown language is not refused
 *     either, it simply leaves the default in force, so there is nothing here
 *     for a schema to reject.
 *   - `SESSION_COOKIE_SECURE` decides the `secure` mark of the session cookie,
 *     and its rule reads a SECOND variable to decide (`NODE_ENV`), refusing the
 *     start altogether when the mark is turned off in production (REQ-035,
 *     `src/auth/session.ts`).
 *
 * Declaring them is not a formality. It is what puts them in `.env.example`,
 * which is the only place an operator can discover that they exist: an instance
 * that should speak Portuguese and shows English is exactly what an undeclared
 * `MYCHAT_LOCALE` looks like (REQ-108).
 *
 * The name is written twice, here and at the point of the read. That is safe
 * for one reason, and only that reason: `env-example.test.ts` scans the sources
 * for environment reads and fails on any name this declaration does not carry,
 * so the two spellings cannot drift apart in silence.
 */
export const DELEGATED_ENV_VARIABLES: readonly string[] = [
  "MYCHAT_LOCALE",
  "SESSION_COOKIE_SECURE",
];

/**
 * Every variable this application declares. `.env.example` is checked against
 * this list, which is what keeps the example from drifting in silence.
 */
export const DECLARED_ENV_VARIABLES: readonly string[] = [
  ...SCHEMA_ENV_VARIABLES,
  ...DELEGATED_ENV_VARIABLES,
];

/**
 * Names that would carry the operator's password in plain text (REQ-033).
 *
 * Deliberately NOT part of `envShape`: these are not configuration with a
 * stricter rule, they are configuration that must not exist. Declaring one
 * would put it in `.env.example` and invite exactly the thing being refused.
 *
 * The list is names an operator would plausibly reach for, so the refusal
 * arrives when the mistake is made rather than never. It cannot be exhaustive,
 * which is why it is a guard rail and not the guarantee: the guarantee is that
 * nothing anywhere reads a password out of the environment, and `set-password`
 * is the only way in.
 */
export const REFUSED_ENV_VARIABLES: readonly string[] = [
  "OPERATOR_PASSWORD",
  "OPERATOR_PASSWORD_HASH",
  "ADMIN_PASSWORD",
  "DASHBOARD_PASSWORD",
  "MYCHAT_PASSWORD",
];

/**
 * Operator-facing text for the refusal, named here rather than in `errors.ts`
 * only because it belongs to the one check that lives in this file. Like every
 * other configuration message it names the variable and never its value: this
 * goes to a terminal and to a log, and a password reaching either is a leaked
 * password whether or not the process then refused to start.
 */
function plaintextPasswordMessage(variables: readonly string[]): string {
  return t("config.plaintextPassword", { variables: variables.join(", ") });
}

/** Refused names actually set to something, in the order they are declared. */
function refusedIn(env: NodeJS.ProcessEnv): string[] {
  return REFUSED_ENV_VARIABLES.filter(
    (variable) => (env[variable] ?? "").trim() !== "",
  );
}

export type StorageConfig = {
  /**
   * Publication thumbnails are served by this process, even when operator
   * assets use S3-compatible storage. Their cache must therefore stay on a
   * configured, writable local volume.
   */
  readonly thumbnailsDir: string;
} & (
  | {
      readonly driver: "disk";
      readonly assetsDir: string;
    }
  | {
      readonly driver: "s3";
      readonly endpoint: string;
      readonly accessKeyId: string;
      readonly secretAccessKey: string;
      readonly bucket: string;
    }
);

export interface EnvConfig {
  /** Empty until legacy import or the encrypted panel configuration exists. */
  readonly metaAppSecret: string;
  /** Absent on a fresh installation: nothing is configured yet. */
  readonly metaAccessToken?: string;
  /** Empty until legacy import or the encrypted panel configuration exists. */
  readonly webhookVerifyToken: string;
  /** Absent on a fresh installation, like the token it goes with. */
  readonly instagramAccountId?: string;
  readonly port: number;
  /** Public origin, with no trailing slash, so a path can be appended to it. */
  readonly publicOrigin: string;
  /** Present only when a legacy environment explicitly supplied the origin. */
  readonly legacyPublicOrigin?: string;
  /** Lifetime assumed for a token seeded from the environment, in milliseconds. */
  readonly tokenLifetimeMs: number;
  /**
   * The zone the dashboard counts and labels in (REQ-153). A zone name this
   * build knows, `UTC` when the operator named none: the aggregation floors
   * every bucket in it, so this decides which day an event belongs to and not
   * merely how the column is written.
   */
  readonly timeZone: string;
  readonly databasePath: string;
  readonly storage: StorageConfig;
  /** Interval of the durable-work sweep, in milliseconds. */
  readonly sweepIntervalMs: number;
  /** Interval of the platform credential health check, in milliseconds. */
  readonly credentialCheckIntervalMs: number;
  /** How long before expiry a token renewal is attempted, in milliseconds. */
  readonly tokenRefreshThresholdMs: number;
}

/**
 * Keeps only the variables this schema parses, trimmed. A variable set to an
 * empty (or whitespace-only) value counts as absent: that is what a blank line
 * in `.env` means, and a blank secret must be reported as missing rather than
 * accepted as a valid empty credential.
 *
 * The delegated variables are deliberately left out: their owner reads them
 * from the environment itself, and collecting them here would parse them twice
 * under two different rules.
 */
function collectDeclared(env: NodeJS.ProcessEnv): Record<string, string> {
  const collected: Record<string, string> = {};

  for (const variable of SCHEMA_ENV_VARIABLES) {
    const raw = env[variable];
    if (raw === undefined) {
      continue;
    }

    const trimmed = raw.trim();
    if (trimmed !== "") {
      collected[variable] = trimmed;
    }
  }

  return collected;
}

function toStorageConfig(parsed: z.infer<typeof envObject>): StorageConfig {
  if (parsed.STORAGE_DRIVER !== "s3") {
    return {
      driver: "disk",
      assetsDir: parsed.ASSETS_DIR,
      thumbnailsDir: parsed.THUMBNAILS_DIR,
    };
  }

  // Presence was already proved by the refinement above: parsing again is how
  // the S3 fields become non-optional without an unchecked assertion.
  const s3 = s3Object.parse(parsed);

  return {
    driver: "s3",
    thumbnailsDir: parsed.THUMBNAILS_DIR,
    endpoint: s3.S3_ENDPOINT,
    accessKeyId: s3.S3_ACCESS_KEY_ID,
    secretAccessKey: s3.S3_SECRET_ACCESS_KEY,
    bucket: s3.S3_BUCKET,
  };
}

/**
 * Validates the environment and returns the configuration in force, or throws
 * a single error listing every variable that is absent and every one whose
 * value was rejected. Values never appear in the message.
 */
export function loadEnvConfig(env: NodeJS.ProcessEnv): EnvConfig {
  // Checked BEFORE anything else, and the priority is the requirement rather
  // than taste: a password sitting in the environment is already exposed to
  // every child process and every crash dump, so it is worth reporting even on
  // an environment that is missing half of what it needs. Reported second, it
  // would be hidden by whichever variable happened to be absent as well.
  const refused = refusedIn(env);
  if (refused.length > 0) {
    throw new ConfigError(plaintextPasswordMessage(refused), refused);
  }

  const declared = collectDeclared(env);
  const result = envSchema.safeParse(declared);

  if (!result.success) {
    const missing: string[] = [];
    const invalid: string[] = [];

    for (const issue of result.error.issues) {
      const variable = issue.path[0];
      if (typeof variable !== "string") {
        continue;
      }

      // Absent from the collected environment means missing, present means the
      // value itself was rejected. The two deserve different instructions.
      const reported = declared[variable] === undefined ? missing : invalid;
      if (!reported.includes(variable)) {
        reported.push(variable);
      }
    }

    const parts: string[] = [];
    if (missing.length > 0) {
      parts.push(configMessages.missingEnvVariables(missing));
    }
    if (invalid.length > 0) {
      parts.push(configMessages.invalidEnvVariables(invalid));
    }

    throw new ConfigError(parts.join(" "), [...missing, ...invalid]);
  }

  const parsed = result.data;

  // Normalised here rather than at every use: the assets route is appended to
  // this, and `https://host/` plus `/assets` is a URL with a double slash that
  // the platform fetches and does not find.
  const publicOrigin = (
    parsed.PUBLIC_ORIGIN ?? `http://localhost:${String(parsed.PORT)}`
  ).replace(/\/+$/, "");

  return {
    metaAppSecret: parsed.META_APP_SECRET ?? "",
    ...(parsed.META_ACCESS_TOKEN !== undefined && {
      metaAccessToken: parsed.META_ACCESS_TOKEN,
    }),
    webhookVerifyToken: parsed.WEBHOOK_VERIFY_TOKEN ?? "",
    ...(parsed.INSTAGRAM_ACCOUNT_ID !== undefined && {
      instagramAccountId: parsed.INSTAGRAM_ACCOUNT_ID,
    }),
    port: parsed.PORT,
    publicOrigin,
    ...(parsed.PUBLIC_ORIGIN !== undefined && {
      legacyPublicOrigin: publicOrigin,
    }),
    tokenLifetimeMs: parsed.TOKEN_LIFETIME_MS,
    timeZone: parsed.MYCHAT_TIMEZONE,
    databasePath: parsed.DATABASE_PATH,
    storage: toStorageConfig(parsed),
    sweepIntervalMs: parsed.SWEEP_INTERVAL_MS,
    credentialCheckIntervalMs: parsed.CREDENTIAL_CHECK_INTERVAL_MS,
    tokenRefreshThresholdMs: parsed.TOKEN_REFRESH_THRESHOLD_MS,
  };
}
