import type { FastifyInstance } from "fastify";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type {
  InitialSetupState,
  InstanceIntegrationDiagnosticsReader,
  InstanceSettings,
  InstanceSettingsChange,
  InstanceSettingsPreference,
  IntegrationSettingsPreference,
  SetupStorageChoice,
  SetupStoragePreference,
} from "../../config/instance-settings.js";
import {
  setOperatorPassword,
  type OperatorCredentialStore,
} from "../../auth/credential.js";
import type {
  CredentialStore,
  StoredCredential,
} from "../../storage/credentials.js";
import type {
  StorageConfigurationStore,
  PersistedStorageConfiguration,
} from "../../storage/storage-configuration.js";
import type { TimeZonePreference } from "../../config/timezone.js";
import { isKnownTimeZone, knownTimeZones } from "../../config/timezone.js";
import type { LocalePreference } from "../../i18n/preference.js";
import {
  TRIGGER_SWITCH_NAMES,
  type TriggerSwitchName,
  type TriggerSwitchPreference,
  type TriggerSwitchState,
} from "../../config/trigger-switches.js";
import {
  apiRoute,
  arrayOf,
  BOOLEAN,
  inputObject,
  INTEGER,
  outputObject,
  refusalObject,
  STATUS,
  STRING,
  TIMESTAMP,
} from "./contract.js";

/**
 * What this instance is CONFIGURED as, over HTTP (REQ-166, REQ-183).
 *
 * One route for the settings that belong to the instance and that no screen can
 * derive on its own. Today that is the time zone (REQ-153), and the reason it
 * needs a road of its own is that the interface had none: the zone reached the
 * panel only inside the answer to `GET /api/dashboard/metrics`, as the zone the
 * buckets of THAT window were cut in, so the Settings screen either read the
 * whole trail to learn one configured string or wrote a guess in its place. It
 * wrote a guess, and the guess said UTC after the zone became configurable.
 *
 * Two methods and one shape, which is the shape `/api/locale` already answers
 * with: what is in force, and what this instance can be switched to. The
 * interface needs both on load, because a selector that cannot list the
 * alternatives is not a selector, and asking for the list separately would let
 * the two answers disagree by one request.
 *
 * The list is built HERE and not in the browser, and that is not a detail. The
 * zone has to be one the aggregation can count in, and the aggregation runs in
 * THIS process: a list taken from the browser's calendar data would offer a
 * name this runtime refuses, and the operator would meet a refusal for picking
 * from a list we drew. See `knownTimeZones` for the two corrections the
 * runtime's own list needs.
 *
 * Why not the two routes that already existed:
 *
 *   - `/api/locale` is read with NO session (see `PUBLIC_READS` in
 *     `src/http/access.ts`), because the sign-in screen is interface and has to
 *     be in the instance's language. Everything that route answers is chosen to
 *     be safe in front of an unauthenticated caller, and where the operator
 *     lives is not that. It also answers the same shape from its POST, so a
 *     language write would echo back a zone nobody wrote.
 *   - `/api/session` opens and ends a session and has no read at all. A setting
 *     of the instance is not a fact about one session, and hanging it there
 *     would say it is.
 *
 * Codes only, like every route of this contract: `America/Sao_Paulo` is an
 * identifier, and the sentence explaining what it means to the operator is the
 * screen's, from the catalogue (REQ-073, REQ-074). The refusal is a code too —
 * `unknown_time_zone` names the one field this route carries.
 *
 * Private, by being registered inside the guarded scope and for no other
 * reason: the Settings screen is behind the session like every other screen
 * that is not sign-in.
 */

export const INSTANCE_ROUTE = "/api/instance";
export const INSTANCE_TRIGGERS_ROUTE = "/api/instance/triggers";
export const INSTANCE_SETTINGS_ROUTE = "/api/instance/settings";
export const INSTANCE_SETUP_ROUTE = "/api/instance/setup";
export const INSTANCE_INTEGRATIONS_ROUTE = "/api/instance/integrations";
export const INSTANCE_CONFIGURATION_ROUTE = "/api/instance/configuration";

export interface InstanceConfigurationDeps {
  readonly operatorCredentials: OperatorCredentialStore;
  readonly platformCredentials: CredentialStore;
  readonly storage: StorageConfigurationStore;
  readonly integration: IntegrationSettingsPreference;
  readonly now: () => Date;
  /** The release the running server was built from, never a browser value. */
  readonly installedVersion?: string;
  readonly testStorage?: (
    value: Exclude<PersistedStorageConfiguration, { driver: "local" }>,
  ) => Promise<{ status: "healthy" | "failure"; reason?: string }>;
  readonly testMeta?: (
    value: StoredCredential,
  ) => Promise<{ status: "healthy" | "failure"; reason?: string }>;
  /** Reaches the saved public URL from the server, as Meta will. */
  readonly testPublicOrigin?: (
    origin: string,
  ) => Promise<{ status: "healthy" | "failure"; reason?: string }>;
}

const MASKED_CONFIGURATION = outputObject(
  {
    meta: outputObject(
      { configured: BOOLEAN, accountId: STRING, appSecretConfigured: BOOLEAN },
      ["configured", "appSecretConfigured"],
    ),
    storage: outputObject(
      { driver: STRING, configured: BOOLEAN, endpoint: STRING, bucket: STRING },
      ["driver", "configured"],
    ),
    publicOrigin: STRING,
    publicOriginVerifiedAt: STRING,
    webhookVerifyToken: BOOLEAN,
    webhookConfirmedAt: STRING,
    onboarding: outputObject(
      { passwordSet: BOOLEAN, webhookReady: BOOLEAN, complete: BOOLEAN },
      ["passwordSet", "webhookReady", "complete"],
    ),
    installedVersion: STRING,
  },
  ["meta", "storage", "webhookVerifyToken", "onboarding", "installedVersion"],
);
const CONFIGURATION_RESULT = outputObject(
  {
    ok: BOOLEAN,
    status: STRING,
    reason: STRING,
    generatedWebhookVerifyToken: STRING,
  },
  ["ok"],
);

/**
 * The two persisted facts first setup needs. Neither port exposes a secret to
 * the presenter: a password is only supplied to the credential command, and
 * the setup marker can only answer whether setup has already finished.
 */
export interface InstanceSetupDeps {
  readonly state: InitialSetupState;
  readonly credentials: OperatorCredentialStore;
  readonly storage?: SetupStoragePreference;
  readonly locale?: LocalePreference;
  readonly timeZone?: TimeZonePreference;
  readonly now: () => Date;
}

const SETUP_STATE = outputObject(
  {
    complete: BOOLEAN,
    locale: STRING,
    locales: arrayOf(STRING),
    timeZone: STRING,
    timeZones: arrayOf(STRING),
  },
  ["complete"],
);
const SETUP_REFUSALS = refusalObject();

const INTEGRATION_DIAGNOSTIC = outputObject(
  { status: STRING, reason: STRING },
  ["status"],
);

const INTEGRATIONS_STATE = outputObject(
  {
    meta: INTEGRATION_DIAGNOSTIC,
    storage: outputObject({ driver: STRING, status: STRING, reason: STRING }, [
      "driver",
      "status",
    ]),
  },
  ["meta", "storage"],
);

/**
 * The package mounted in the running process is the release in force. This is
 * deliberately read on the server: a browser bundle can outlive an image
 * update in a tab, so putting a version constant in the bundle would make it
 * describe itself rather than the instance it is talking to.
 */
function installedVersion(): string {
  try {
    const imageVersion = readFileSync(
      join(process.cwd(), "VERSION"),
      "utf8",
    ).trim();

    if (imageVersion !== "") return imageVersion;
  } catch {
    // A source checkout does not carry image build metadata.
  }
  try {
    const value = JSON.parse(
      readFileSync(join(process.cwd(), "package.json"), "utf8"),
    ) as { version?: unknown };
    return typeof value.version === "string" && value.version !== "0.0.0"
      ? value.version
      : "development";
  } catch {
    return "development";
  }
}

const INSTANCE_STATE = outputObject(
  {
    /** The IANA zone this instance counts and reads its instants in. */
    timeZone: STRING,
    /**
     * Every zone it can be switched to, sorted, including the one in force.
     * Named for the setting rather than `available`, because a second setting
     * on this route would need a list of its own and the two must not have to
     * share one word.
     */
    timeZones: arrayOf(STRING),
  },
  ["timeZone", "timeZones"],
);

const TRIGGER_VALUE = outputObject({ enabled: BOOLEAN, updatedAt: TIMESTAMP }, [
  "enabled",
]);

const TRIGGER_STATE = outputObject(
  {
    all: TRIGGER_VALUE,
    comments: TRIGGER_VALUE,
    directMessages: TRIGGER_VALUE,
  },
  ["all", "comments", "directMessages"],
);

function presentTriggers(state: TriggerSwitchState): unknown {
  const present = (value: TriggerSwitchState[TriggerSwitchName]) => ({
    enabled: value.enabled,
    ...(value.updatedAt !== undefined && {
      updatedAt: value.updatedAt.toISOString(),
    }),
  });
  return {
    all: present(state.all),
    comments: present(state.comments),
    directMessages: present(state.directMessages),
  };
}

/**
 * What the instance decides about waiting, over HTTP (REQ-252, REQ-254,
 * REQ-255, REQ-257).
 *
 * The four values AND the bounds they live between, in one answer, for the
 * reason the zone comes with its list of zones: a screen that cannot see the
 * bounds either repeats them in the browser (two copies of 168, and one of them
 * wrong the day it moves) or lets the operator type a number it can only be
 * refused for. They are declared once, by the rule that owns them, and travel
 * from there.
 *
 * Numbers and codes only. The sentence that names 168 to an operator belongs to
 * the screen and to the catalogue (REQ-073), which is also why a refusal
 * carries `limit`: the words are the screen's, the number is ours.
 */
const INSTANCE_SETTINGS_STATE = outputObject(
  {
    waitHours: INTEGER,
    questions: INTEGER,
    closingMessage: STRING,
    followButtonLabel: STRING,
    limits: outputObject(
      {
        waitHoursMin: INTEGER,
        waitHoursMax: INTEGER,
        questionsMin: INTEGER,
        followButtonLabelChars: INTEGER,
      },
      [
        "waitHoursMin",
        "waitHoursMax",
        "questionsMin",
        "followButtonLabelChars",
      ],
    ),
  },
  ["waitHours", "questions", "closingMessage", "followButtonLabel", "limits"],
);

/** Registers the deliberately narrow public first-setup boundary. */
export function registerSetupRoutes(
  scope: FastifyInstance,
  setup: InstanceSetupDeps,
): void {
  /**
   * The only API fact exposed before login. It carries no configuration or
   * credential detail, only which screen the browser must render.
   */
  apiRoute(scope, {
    method: "GET",
    url: INSTANCE_SETUP_ROUTE,
    contract: {
      querystring: inputObject({}),
      response: { 200: SETUP_STATE },
    },
    handler: async () => {
      const [locale, timeZone] = await Promise.all([
        setup.locale?.inForce(),
        setup.timeZone?.inForce(),
      ]);
      return {
        status: STATUS.ok,
        payload: {
          complete: await setup.state.isComplete(),
          ...(locale !== undefined && {
            locale: locale.locale,
            locales: [...setup.locale!.available()],
          }),
          ...(timeZone !== undefined && {
            timeZone: timeZone.timeZone,
            timeZones: [...knownTimeZones(timeZone.timeZone)],
          }),
        },
      };
    },
  });

  apiRoute<
    unknown,
    unknown,
    {
      password: string;
      passwordConfirmation: string;
      storage?: SetupStorageChoice;
      locale?: string;
      timeZone?: string;
    }
  >(scope, {
    method: "POST",
    url: INSTANCE_SETUP_ROUTE,
    contract: {
      body: inputObject(
        {
          password: STRING,
          passwordConfirmation: STRING,
          storage: inputObject(
            {
              driver: { type: "string", enum: ["local", "r2", "s3"] },
              endpoint: STRING,
              accessKeyId: STRING,
              secretAccessKey: STRING,
              bucket: STRING,
            },
            ["driver"],
          ),
          locale: STRING,
          timeZone: STRING,
        },
        ["password", "passwordConfirmation"],
      ),
      response: { 200: SETUP_STATE, 422: SETUP_REFUSALS },
    },
    handler: async ({ body }) => {
      if (await setup.state.isComplete()) {
        return {
          status: STATUS.refused,
          payload: { error: "setup_already_complete" },
        };
      }
      if ((await setup.credentials.read()) !== undefined) {
        return {
          status: STATUS.refused,
          payload: { error: "setup_already_complete" },
        };
      }
      if (body.password !== body.passwordConfirmation) {
        return {
          status: STATUS.refused,
          payload: { error: "password_confirmation_mismatch" },
        };
      }
      if (
        body.locale !== undefined &&
        setup.locale !== undefined &&
        !setup.locale.available().includes(body.locale)
      ) {
        return { status: STATUS.refused, payload: { error: "unknown_locale" } };
      }
      if (body.timeZone !== undefined && !isKnownTimeZone(body.timeZone)) {
        return {
          status: STATUS.refused,
          payload: { error: "unknown_time_zone" },
        };
      }

      const storage = body.storage ?? { driver: "local" as const };
      const selected =
        setup.storage === undefined
          ? storage.driver === "local"
            ? { ok: true as const }
            : { ok: false as const, reason: "storage_not_configured" }
          : await setup.storage.choose(storage, setup.now());
      if (!selected.ok) {
        return { status: STATUS.refused, payload: { error: selected.reason } };
      }
      const saved = await setOperatorPassword(
        body.password,
        setup.credentials,
        setup.now(),
      );
      if (!saved.ok) {
        return { status: STATUS.refused, payload: { error: saved.reason } };
      }
      if (body.locale !== undefined && setup.locale !== undefined) {
        await setup.locale.choose(body.locale);
      }
      if (body.timeZone !== undefined && setup.timeZone !== undefined) {
        await setup.timeZone.choose(body.timeZone);
      }
      await setup.state.complete(setup.now());
      return { status: STATUS.ok, payload: { complete: true } };
    },
  });
}

export function registerInstanceRoutes(
  scope: FastifyInstance,
  timeZone: TimeZonePreference,
  triggers: TriggerSwitchPreference,
  settings: InstanceSettingsPreference,
  setup?: InstanceSetupDeps,
  integrations?: InstanceIntegrationDiagnosticsReader,
  configuration?: InstanceConfigurationDeps,
): void {
  if (configuration !== undefined) {
    const present = async (): Promise<unknown> => {
      const [meta, storage, integration] = await Promise.all([
        configuration.platformCredentials.read(),
        configuration.storage.read(),
        configuration.integration.read(),
      ]);
      return {
        meta: {
          configured: meta !== undefined,
          appSecretConfigured: integration.metaAppSecret !== undefined,
          ...(meta !== undefined && { accountId: meta.accountId }),
        },
        storage:
          storage === undefined
            ? { driver: "local", configured: false }
            : storage.driver === "local"
              ? { driver: "local", configured: true }
              : {
                  driver: storage.driver,
                  configured: true,
                  endpoint: storage.endpoint,
                  bucket: storage.bucket,
                },
        ...(integration.publicOrigin !== undefined && {
          publicOrigin: integration.publicOrigin,
        }),
        ...(integration.publicOriginVerifiedAt !== undefined && {
          publicOriginVerifiedAt: integration.publicOriginVerifiedAt,
        }),
        webhookVerifyToken: integration.webhookVerifyToken !== undefined,
        ...(integration.webhookConfirmedAt !== undefined && {
          webhookConfirmedAt: integration.webhookConfirmedAt,
        }),
        onboarding: {
          passwordSet:
            setup === undefined ? true : await setup.state.isComplete(),
          webhookReady: integration.webhookConfirmedAt !== undefined,
          complete:
            meta !== undefined &&
            integration.publicOrigin !== undefined &&
            integration.webhookConfirmedAt !== undefined,
        },
        installedVersion: configuration.installedVersion ?? installedVersion(),
      };
    };
    apiRoute(scope, {
      method: "GET",
      url: INSTANCE_CONFIGURATION_ROUTE,
      contract: {
        querystring: inputObject({}),
        response: { 200: MASKED_CONFIGURATION },
      },
      handler: async () => ({ status: STATUS.ok, payload: await present() }),
    });
    apiRoute<
      unknown,
      unknown,
      {
        action: string;
        authPath?: "instagram_login" | "system_user";
        accessToken?: string;
        accountId?: string;
        driver?: "local" | "r2" | "s3";
        endpoint?: string;
        accessKeyId?: string;
        secretAccessKey?: string;
        bucket?: string;
        publicOrigin?: string;
        webhookVerifyToken?: string;
        metaAppSecret?: string;
      }
    >(scope, {
      method: "POST",
      url: INSTANCE_CONFIGURATION_ROUTE,
      contract: {
        body: inputObject(
          {
            action: STRING,
            authPath: {
              type: "string",
              enum: ["instagram_login", "system_user"],
            },
            accessToken: STRING,
            accountId: STRING,
            driver: { type: "string", enum: ["local", "r2", "s3"] },
            endpoint: STRING,
            accessKeyId: STRING,
            secretAccessKey: STRING,
            bucket: STRING,
            publicOrigin: STRING,
            webhookVerifyToken: STRING,
            metaAppSecret: STRING,
          },
          ["action"],
        ),
        response: { 200: CONFIGURATION_RESULT, 422: refusalObject() },
      },
      handler: async ({ body }) => {
        const failure = (reason: string) => ({
          status: STATUS.refused,
          payload: { error: reason },
        });
        if (body.action === "generate_webhook_verify_token") {
          const current = await configuration.integration.read();
          if (current.publicOriginVerifiedAt === undefined) {
            return failure("public_origin_not_verified");
          }
          return {
            status: STATUS.ok,
            payload: {
              ok: true,
              generatedWebhookVerifyToken:
                randomBytes(24).toString("base64url"),
            },
          };
        }
        const currentIntegration = async () => configuration.integration.read();
        const requireVerifiedPublicOrigin = async (): Promise<
          | { readonly ok: true }
          | {
              readonly ok: false;
              readonly response: ReturnType<typeof failure>;
            }
        > => {
          const integration = await currentIntegration();
          return integration.publicOriginVerifiedAt === undefined
            ? { ok: false, response: failure("public_origin_not_verified") }
            : { ok: true };
        };
        if (body.action === "test_public_origin") {
          const current = await currentIntegration();
          if (current.publicOrigin === undefined)
            return failure("public_origin_required");
          const origin = current.publicOrigin;
          const result = await (async () => {
            try {
              return await (configuration.testPublicOrigin?.(origin) ??
                Promise.resolve({
                  status: "failure" as const,
                  reason: "unreachable",
                }));
            } catch {
              return { status: "failure" as const, reason: "unreachable" };
            }
          })();
          if (result.status !== "healthy") {
            return { status: STATUS.ok, payload: { ok: false, ...result } };
          }
          await configuration.integration.choose(
            {
              ...current,
              publicOriginVerifiedAt: configuration.now().toISOString(),
            },
            configuration.now(),
          );
          return { status: STATUS.ok, payload: { ok: true, ...result } };
        }
        if (
          body.action !== "set_public_origin" &&
          body.action !== "remove_public_origin"
        ) {
          const verified = await requireVerifiedPublicOrigin();
          if (!verified.ok) return verified.response;
        }
        if (body.action === "replace_meta" || body.action === "test_meta") {
          if (
            body.authPath === undefined ||
            body.accessToken === undefined ||
            body.accountId === undefined
          )
            return failure("meta_fields_required");
          const value: StoredCredential = {
            authPath: body.authPath,
            accessToken: body.accessToken,
            accountId: body.accountId,
          };
          const result = await (async () => {
            try {
              return await (configuration.testMeta?.(value) ??
                Promise.resolve({ status: "healthy" as const }));
            } catch {
              return { status: "failure" as const, reason: "unreachable" };
            }
          })();
          if (body.action === "test_meta") {
            return {
              status: STATUS.ok,
              payload: { ok: result.status === "healthy", ...result },
            };
          }
          if (result.status !== "healthy") {
            return { status: STATUS.ok, payload: { ok: false, ...result } };
          }
          await configuration.platformCredentials.write(
            value,
            configuration.now(),
          );
          return { status: STATUS.ok, payload: { ok: true, ...result } };
        }
        if (body.action === "remove_meta") {
          if (configuration.platformCredentials.remove === undefined) {
            return failure("meta_remove_unavailable");
          }
          await configuration.platformCredentials.remove();
          return { status: STATUS.ok, payload: { ok: true } };
        }
        if (
          body.action === "set_meta_app_secret" ||
          body.action === "remove_meta_app_secret"
        ) {
          if (
            body.action === "set_meta_app_secret" &&
            body.metaAppSecret === undefined
          ) {
            return failure("value_required");
          }
          const current = await configuration.integration.read();
          await configuration.integration.choose(
            {
              ...current,
              ...(body.action === "set_meta_app_secret"
                ? { metaAppSecret: body.metaAppSecret }
                : { metaAppSecret: undefined }),
            },
            configuration.now(),
          );
          return { status: STATUS.ok, payload: { ok: true } };
        }
        if (
          body.action === "replace_storage" ||
          body.action === "test_storage"
        ) {
          if (body.driver === undefined)
            return failure("storage_driver_required");
          const value: PersistedStorageConfiguration =
            body.driver === "local"
              ? { driver: "local" }
              : body.endpoint === undefined ||
                  body.accessKeyId === undefined ||
                  body.secretAccessKey === undefined ||
                  body.bucket === undefined
                ? (null as never)
                : {
                    driver: body.driver,
                    endpoint: body.endpoint,
                    accessKeyId: body.accessKeyId,
                    secretAccessKey: body.secretAccessKey,
                    bucket: body.bucket,
                  };
          if (value === null) return failure("storage_fields_required");
          const result =
            value.driver === "local"
              ? { status: "healthy" as const }
              : await (async () => {
                  try {
                    return await (configuration.testStorage?.(value) ??
                      Promise.resolve({ status: "healthy" as const }));
                  } catch {
                    return {
                      status: "failure" as const,
                      reason: "unreachable",
                    };
                  }
                })();
          if (body.action === "test_storage") {
            return {
              status: STATUS.ok,
              payload: { ok: result.status === "healthy", ...result },
            };
          }
          if (result.status !== "healthy") {
            return { status: STATUS.ok, payload: { ok: false, ...result } };
          }
          await configuration.storage.write(value, configuration.now());
          return { status: STATUS.ok, payload: { ok: true } };
        }
        if (body.action === "remove_storage") {
          if (configuration.storage.remove === undefined) {
            return failure("storage_remove_unavailable");
          }
          await configuration.storage.remove();
          return { status: STATUS.ok, payload: { ok: true } };
        }
        if (
          body.action === "set_public_origin" ||
          body.action === "remove_public_origin" ||
          body.action === "set_webhook_verify_token" ||
          body.action === "remove_webhook_verify_token"
        ) {
          const current = await configuration.integration.read();
          const next = {
            ...current,
            ...(body.action === "set_public_origin" && {
              publicOrigin: body.publicOrigin,
              publicOriginVerifiedAt: undefined,
              webhookConfirmedAt: undefined,
            }),
            ...(body.action === "remove_public_origin" && {
              publicOrigin: undefined,
              publicOriginVerifiedAt: undefined,
              webhookVerifyToken: undefined,
              webhookConfirmedAt: undefined,
            }),
            ...(body.action === "set_webhook_verify_token" && {
              webhookVerifyToken: body.webhookVerifyToken,
              webhookConfirmedAt: undefined,
            }),
            ...(body.action === "remove_webhook_verify_token" && {
              webhookVerifyToken: undefined,
            }),
          };
          if (
            body.action.startsWith("set_") &&
            (body.action === "set_public_origin"
              ? body.publicOrigin
              : body.webhookVerifyToken) === undefined
          )
            return failure("value_required");
          try {
            await configuration.integration.choose(next, configuration.now());
          } catch {
            return failure("invalid_public_origin");
          }
          return { status: STATUS.ok, payload: { ok: true } };
        }
        return failure("unknown_configuration_action");
      },
    });
  }
  if (integrations !== undefined) {
    apiRoute(scope, {
      method: "GET",
      url: INSTANCE_INTEGRATIONS_ROUTE,
      contract: {
        querystring: inputObject({}),
        response: { 200: INTEGRATIONS_STATE },
      },
      handler: async () => {
        const diagnostics = await integrations.read();
        // This projection is intentionally the only HTTP representation: no
        // endpoint, bucket, account id, token, or provider error text escapes.
        return { status: STATUS.ok, payload: diagnostics };
      },
    });
  }

  if (setup !== undefined) registerSetupRoutes(scope, setup);

  /**
   * Read on every request and never captured: this is the whole of REQ-183 at
   * this layer. A value resolved once at registration would answer the zone the
   * PROCESS started with for as long as it ran, which is exactly the behaviour
   * the requirement removes.
   */
  async function state(): Promise<{
    timeZone: string;
    timeZones: readonly string[];
  }> {
    const inForce = await timeZone.inForce();

    return {
      timeZone: inForce.timeZone,
      timeZones: knownTimeZones(inForce.timeZone),
    };
  }

  apiRoute(scope, {
    method: "GET",
    url: INSTANCE_ROUTE,
    contract: {
      // Empty and closed: this route takes no parameter, so an unexpected one
      // is refused instead of ignored.
      querystring: inputObject({}),
      response: { 200: INSTANCE_STATE },
    },
    handler: async () => ({ status: STATUS.ok, payload: await state() }),
  });

  apiRoute<unknown, unknown, { timeZone: string }>(scope, {
    method: "POST",
    url: INSTANCE_ROUTE,
    contract: {
      body: inputObject({ timeZone: STRING }, ["timeZone"]),
      response: { 200: INSTANCE_STATE, 422: refusalObject() },
    },
    handler: async ({ body }) => {
      const chosen = await timeZone.choose(body.timeZone);

      if (!chosen.ok) {
        // 422 and not 400: the request was well formed, and the domain refused
        // what it carried. Nothing was stored, so the previous zone stands and
        // the next read of the dashboard still cuts its buckets in it.
        return { status: STATUS.refused, payload: { error: chosen.refusal } };
      }

      // Re-read rather than echoed: the answer to a write is the same answer
      // the GET gives, so a screen that adopts it cannot end up displaying a
      // zone the instance did not keep.
      return { status: STATUS.ok, payload: await state() };
    },
  });

  apiRoute(scope, {
    method: "GET",
    url: INSTANCE_TRIGGERS_ROUTE,
    contract: {
      querystring: inputObject({}),
      response: { 200: TRIGGER_STATE },
    },
    handler: async () => ({
      status: STATUS.ok,
      payload: presentTriggers(await triggers.read()),
    }),
  });

  apiRoute<unknown, unknown, { name: TriggerSwitchName; enabled: boolean }>(
    scope,
    {
      method: "POST",
      url: INSTANCE_TRIGGERS_ROUTE,
      contract: {
        body: inputObject(
          {
            name: { type: "string", enum: [...TRIGGER_SWITCH_NAMES] },
            enabled: BOOLEAN,
          },
          ["name", "enabled"],
        ),
        response: { 200: TRIGGER_STATE },
      },
      handler: async ({ body }) => ({
        status: STATUS.ok,
        payload: presentTriggers(
          await triggers.choose(body.name, body.enabled),
        ),
      }),
    },
  );

  function presentSettings(value: InstanceSettings): unknown {
    return { ...value, limits: settings.bounds };
  }

  apiRoute(scope, {
    method: "GET",
    url: INSTANCE_SETTINGS_ROUTE,
    contract: {
      querystring: inputObject({}),
      response: { 200: INSTANCE_SETTINGS_STATE },
    },
    // Read on every request and never captured, exactly like the zone above: a
    // value resolved at registration would answer what the PROCESS started with
    // for as long as it ran.
    handler: async () => ({
      status: STATUS.ok,
      payload: presentSettings(await settings.read()),
    }),
  });

  apiRoute<unknown, unknown, InstanceSettingsChange>(scope, {
    method: "POST",
    url: INSTANCE_SETTINGS_ROUTE,
    contract: {
      /*
       * Every field optional, and none of them required: a screen changing the
       * deadline must not have to resend a closing message it never read, and
       * a body naming a field nobody declared is still refused by the contract
       * (`additionalProperties` is closed) rather than silently ignored.
       *
       * The bounds are NOT declared here as `minimum`/`maximum`. A schema
       * refusal answers 400 with a message about a path, and REQ-252 and
       * REQ-257 ask for the LIMIT to be named: the domain refuses instead, at
       * 422, with the code and the number the screen puts into a sentence.
       */
      body: inputObject({
        waitHours: INTEGER,
        questions: INTEGER,
        closingMessage: STRING,
        followButtonLabel: STRING,
      }),
      response: {
        200: INSTANCE_SETTINGS_STATE,
        422: refusalObject({ limit: INTEGER }),
      },
    },
    handler: async ({ body }) => {
      const chosen = await settings.choose(body);

      if (!chosen.ok) {
        // 422 and not 400: the request was well formed and the domain refused
        // what it carried. Nothing was stored, so every value stands as it was
        // and the waits already counting are untouched either way (REQ-253).
        return {
          status: STATUS.refused,
          payload: {
            error: chosen.refusal.code,
            ...(chosen.refusal.limit !== undefined && {
              limit: chosen.refusal.limit,
            }),
          },
        };
      }

      // Re-read rather than echoed, like the zone: the answer to a write is the
      // answer the GET gives, so a screen adopting it cannot end up displaying
      // a value the instance did not keep.
      return { status: STATUS.ok, payload: presentSettings(chosen.settings) };
    },
  });
}
