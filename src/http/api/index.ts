import type { FastifyInstance } from "fastify";
import type {
  InstanceIntegrationDiagnosticsReader,
  InstanceSettingsPreference,
} from "../../config/instance-settings.js";
import type { TimeZonePreference } from "../../config/timezone.js";
import type { TriggerSwitchPreference } from "../../config/trigger-switches.js";
import type { AutomationAggregateLifecycle } from "../../flows/automations.js";
import type { LocalePreference } from "../../i18n/preference.js";
import type { PublicationCatalogue } from "../../platform/publications-cache.js";
import type { PublicationAutomationCoverageReader } from "../../storage/publication-automation-coverage.js";
import type { AssetCatalogue } from "../../storage/assets.js";
import type { AssetUsageReader } from "../../storage/asset-usage.js";
import { registerAssetRoutes } from "./assets.js";
import { registerAccountProfileRoute } from "./account-profile.js";
import type { AccountProfileReader } from "../../platform/account-profile.js";
import { registerAutomationAggregateRoutes } from "./automations.js";
import type { ClickMetricsReaders } from "./automations.js";
import { guardContracts, installRefusals } from "./contract.js";
import { registerDashboardRoutes } from "./dashboard.js";
import type {
  DashboardMetricsReader,
  DashboardStatusReader,
} from "./dashboard.js";
import { registerInstanceRoutes } from "./instance.js";
import type { InstanceConfigurationDeps } from "./instance.js";
import { registerLocaleRoutes } from "./locale.js";
import { registerPublicationRoutes } from "./publications.js";

/**
 * Everything the interface talks to, in one scope (REQ-103, ADR-004).
 *
 * Registered through the `privateRoutes` callback of `registerAccess`, which is
 * what makes these routes private: they are behind the session guard because
 * they were registered inside that scope, never because their address matched a
 * pattern. See `src/http/access.ts` for why that distinction is the difference
 * between a working `/webhook` and deliveries that stop in silence.
 *
 * The scope this function opens is its own, so the boot guard and the refusal
 * handler installed here apply to the contract's routes and to nothing else in
 * the process.
 *
 * Ports rather than concrete stores: each dependency is the smallest thing the
 * routes need, so the composition root decides what is behind it and a test
 * drives the whole contract with doubles, no database and no network.
 */

export interface ApiDeps {
  /** Public identity of the Meta account, shown only to the signed-in operator. */
  readonly accountProfile?: AccountProfileReader;
  /** The version-2 aggregate CRUD, independent from the flow catalogue. */
  readonly automations: AutomationAggregateLifecycle;
  /**
   * What was measured of the button clicks, read two ways (REQ-222, REQ-329):
   * one automation for the panel, and the whole listing in a single read so the
   * card draws from the answer it already has.
   */
  readonly clickMetrics?: ClickMetricsReaders;
  /** The dashboard report for one range, usually `readDashboardMetrics`. */
  readonly metrics: DashboardMetricsReader;
  /** The operational alert read shared with the `status` command. */
  readonly status: DashboardStatusReader;
  /** `createPublicationCatalogue({ ... })` satisfies this. */
  readonly publications: PublicationCatalogue;
  /** Page-scoped automation counts for the publication grid (REQ-208). */
  readonly publicationAutomationCoverage?: PublicationAutomationCoverageReader;
  /** The private operator resource catalogue (REQ-047). */
  readonly assets: AssetCatalogue;
  /**
   * Which automations refer to a resource, for the deletion that warns before
   * it breaks delivered messages (REQ-293). `createAssetUsageReader(db)`
   * satisfies this.
   */
  readonly assetUsage?: AssetUsageReader;
  /** `createLocalePreference({ ... })` satisfies this (REQ-102). */
  readonly locale: LocalePreference;
  /**
   * The zone the instance counts and reads its instants in, for the screen
   * that shows it and changes it (REQ-166, REQ-183).
   * `createTimeZonePreference({ ... })` satisfies this.
   *
   * A preference and not a value, and the difference is the requirement: a
   * `{ timeZone: config.timeZone }` read once at start-up is a promise that the
   * zone cannot change under a running process, and it can.
   */
  readonly timeZone: TimeZonePreference;
  /**
   * How long a step waits, how often it asks, how it says goodbye and what its
   * follow button says (REQ-252, REQ-254, REQ-255, REQ-257).
   *
   * The same preference the dispatcher reads, and a preference rather than its
   * values for the same reason the zone is one: a screen showing numbers read
   * at boot would show what the process started with, not what the next wait is
   * created under.
   */
  readonly instanceSettings: InstanceSettingsPreference;
  readonly triggerSwitches?: TriggerSwitchPreference;
  /** Reauthenticated integration settings, never exposed outside private API. */
  readonly configuration?: InstanceConfigurationDeps;
  /** A fresh, server-side verification of integrations for Settings. */
  readonly integrations?: InstanceIntegrationDiagnosticsReader;
  /** Injected so a test asserts an instant instead of racing the machine's. */
  readonly now: () => Date;
}

export function registerApiRoutes(scope: FastifyInstance, deps: ApiDeps): void {
  const triggerSwitches: TriggerSwitchPreference = deps.triggerSwitches ?? {
    read: () =>
      Promise.resolve({
        all: { enabled: true },
        comments: { enabled: true },
        directMessages: { enabled: true },
      }),
    choose: () => Promise.reject(new Error("trigger switches not configured")),
    allows: () => Promise.resolve(true),
  };
  scope.register(async (api) => {
    // Before any route is registered, or the hook would not see them: a route
    // whose contract is incomplete must stop the process at boot rather than
    // reach an interface expecting a shape nobody declared.
    guardContracts(api);
    installRefusals(api);

    registerAutomationAggregateRoutes(api, deps.automations, deps.clickMetrics);
    registerDashboardRoutes(
      api,
      deps.metrics,
      deps.status,
      triggerSwitches,
      deps.now,
    );
    registerPublicationRoutes(
      api,
      deps.publications,
      deps.now,
      deps.publicationAutomationCoverage,
    );
    registerLocaleRoutes(api, deps.locale);
    registerInstanceRoutes(
      api,
      deps.timeZone,
      triggerSwitches,
      deps.instanceSettings,
      undefined,
      deps.integrations,
      deps.configuration,
    );
    registerAssetRoutes(
      api,
      deps.assets,
      // A composition that forgot to wire the reader REFUSES the question
      // instead of answering "used nowhere": the empty answer is the one that
      // gets a file deleted, and the whole point of REQ-293 is that the
      // operator sees what a deletion costs before paying it.
      deps.assetUsage ?? {
        read: () => Promise.reject(new Error("asset usage not configured")),
      },
    );
    registerAccountProfileRoute(
      api,
      deps.accountProfile ?? {
        read: () => Promise.resolve({ connected: false }),
      },
    );
  });
}

export {
  API_PREFIX,
  CONTRACT_GAPS,
  CONTRACT_VIOLATION,
  contractGaps,
  describeGaps,
  routeLabel,
  STATUS,
} from "./contract.js";

export type {
  ApiContract,
  ContractGap,
  ContractGapCode,
  ContractIssue,
  RegisteredRoute,
} from "./contract.js";

export { LOCALE_ROUTE, registerLocaleRoutes } from "./locale.js";

export {
  INSTANCE_ROUTE,
  INSTANCE_SETTINGS_ROUTE,
  INSTANCE_TRIGGERS_ROUTE,
  INSTANCE_SETUP_ROUTE,
  registerInstanceRoutes,
  registerSetupRoutes,
} from "./instance.js";

export { registerAutomationAggregateRoutes } from "./automations.js";

export type { ClickMetricsReaders } from "./automations.js";

export {
  ASSET_API_ROUTE,
  ASSET_USAGE_API_ROUTE,
  ASSETS_API_ROUTE,
  registerAssetRoutes,
} from "./assets.js";

export type { DashboardMetricsReader } from "./dashboard.js";
