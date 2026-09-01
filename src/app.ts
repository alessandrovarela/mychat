import {
  createAuthThrottle,
  createOperatorCredentialStore,
  createSessionStore,
  loadAuthThrottleLimits,
  loadSessionCookieConfig,
} from "./auth/index.js";
import type { EnvConfig } from "./config/env.js";
import { loadEnvConfig } from "./config/env.js";
import { createInstanceSettingsPreference } from "./config/instance-settings.js";
import { loadLimits } from "./config/limits.js";
import { createTimeZonePreference } from "./config/timezone.js";
import { createTriggerSwitchPreference } from "./config/trigger-switches.js";
import { createQueueSource, readDashboardMetrics } from "./dashboard/index.js";
import type { Clock } from "./engine/ports.js";
import {
  createAutomationAggregateLifecycle,
  createAutomationFailureHandler,
} from "./flows/index.js";
import {
  ASSETS_ROUTE_PREFIX,
  buildWebhookServer,
  createButtonLinkWriter,
  deriveClickSigningSecret,
  createReceivedEventStore,
  registerAccess,
  registerApiRoutes,
  registerAssetsRoute,
  registerClicksRoute,
  registerStaticRoute,
  registerThumbnailsRoute,
} from "./http/index.js";
import type { WebhookServer } from "./http/index.js";
import { catalogue, t } from "./i18n/index.js";
import { createLocalePreference } from "./i18n/preference.js";
import {
  CREDENTIAL_CHECK_KEY,
  createCredentialCheckHandler,
  createAccountProfileReader,
  createFetchTransport,
  createFollowLink,
  createInstagramLoginAccount,
  createFetchThumbnailDownload,
  createPlatformSender,
  createPublicationCatalogue,
  readOperationalStatus,
} from "./platform/index.js";
import type { PlatformTransport } from "./platform/index.js";
import {
  createDispatcher,
  createPauseResume,
  createRandomSource,
  createSuspensionTimeoutHandler,
  runSweep,
  startSweep,
  withSendPolicy,
} from "./runtime/index.js";
import type { DispatchDeps, SweepDeps, SweepReport } from "./runtime/index.js";
import {
  createAssetUsageReader,
  createAuditRepository,
  createAutomationAggregateRepository,
  createButtonClickStore,
  createAutomationRunStore,
  createAutomationFailureSequenceStore,
  createContactRepository,
  createConversationStore,
  createCredentialStore,
  createDiskAssets,
  createDiskThumbnails,
  deriveAssetCapabilitySecret,
  createDurableWorkStore,
  createLocalePreferenceStore,
  createPublicationCacheStore,
  createPublicationAutomationCoverageReader,
  createInstanceSettingsStore,
  createTimeZonePreferenceStore,
  createTriggerSwitchStore,
  createS3Assets,
  openDatabase,
} from "./storage/index.js";
import type {
  AssetCatalogue,
  AuditRepository,
  CredentialStore,
  MigrationReport,
} from "./storage/index.js";

/**
 * The composition root (REQ-091): the one place where the concrete
 * implementations meet the ports ADR-003 always presupposed.
 *
 * Building and LISTENING are separate on purpose. Everything that can fail
 * happens while building, so a test composes the entire process and drives it
 * through `inject()` with no port bound, and the process only binds a port once
 * there is nothing left that could refuse to work.
 *
 * The order below is the requirement, not an implementation detail:
 *
 *   configuration -> database and migrations -> credential -> ports ->
 *   dispatcher -> server -> sweep -> (caller) listen
 *
 * Nothing here catches and logs. A failure at any step propagates, because the
 * alternative is a process that answers the platform on a schema it could not
 * migrate or a configuration it could not read, which is worse than a process
 * that refused to start and said why.
 */

export interface AppOptions {
  /** Injected so a test asserts an instant instead of racing the machine's. */
  readonly clock?: Clock;
  /** Injected so the fast suite composes the whole process with no network. */
  readonly transport?: PlatformTransport;
  /** Injected S3 transport for the deterministic bucket integration suite. */
  readonly assetFetch?: (
    input: string | URL,
    init?: RequestInit,
  ) => Promise<Response>;
  /** Overridden only to prove that a failing migration stops the boot. */
  readonly migrationsFolder?: string;
}

export interface App {
  readonly config: EnvConfig;
  /** What the start-up migration run did, for the caller to report. */
  readonly migrations: MigrationReport;
  /** Routed and ready. Binding a port is the caller's move, never this one's. */
  readonly server: WebhookServer;
  /** One pass on demand, beside the periodic loop this app already armed. */
  sweepOnce(): Promise<SweepReport>;
  close(): Promise<void>;
}

interface SeedDeps {
  readonly credentials: CredentialStore;
  readonly audit: AuditRepository;
  readonly config: EnvConfig;
  readonly now: Date;
}

/**
 * Seeds the platform credential from the environment, and ONLY when the store
 * has none (REQ-096).
 *
 * The guard is the whole point. `write` replaces wholesale, so seeding on every
 * boot would put the environment's token back over the one the automatic
 * renewal produced, silently, and the installation would still die at sixty
 * days with REQ-081 passing every test it has. The environment seeds the first
 * token; from that moment the store is authoritative.
 *
 * Returns whether a credential is configured at all, which is a different
 * question from whether one was written now: a fresh installation has neither,
 * and that is not a fault.
 */
async function seedCredential(deps: SeedDeps): Promise<boolean> {
  const stored = await deps.credentials.read();
  if (stored !== undefined) {
    return true;
  }

  const { metaAccessToken, instagramAccountId, tokenLifetimeMs } = deps.config;
  if (metaAccessToken === undefined || instagramAccountId === undefined) {
    return false;
  }

  // The platform does not report when an already issued token expires, so the
  // expiry is counted from now. It is an estimate, and the first renewal
  // replaces it with the platform's own number: what matters is that it is SET,
  // because a credential with no expiry is one this path never renews.
  const expiresAt = new Date(deps.now.getTime() + tokenLifetimeMs);

  await deps.credentials.write(
    {
      // The only adapter that exists (ADR-022). A second path would choose here
      // and nowhere else, which is the point of the port.
      authPath: "instagram_login",
      accessToken: metaAccessToken,
      accountId: instagramAccountId,
      expiresAt,
    },
    deps.now,
  );

  // On the record, because it is the one moment the environment writes into the
  // store: an operator asking later where this token came from finds an answer.
  await deps.audit.record(
    {
      kind: "alert",
      subtype: "credential_seeded",
      outcome: "ok",
      reason: t("app.credentialSeeded", { expiresAt: expiresAt.toISOString() }),
    },
    deps.now,
  );

  return true;
}

export async function createApp(
  env: NodeJS.ProcessEnv,
  options: AppOptions = {},
): Promise<App> {
  const clock: Clock = options.clock ?? { now: (): Date => new Date() };
  const now = (): Date => clock.now();
  const transport = options.transport ?? createFetchTransport();

  // 1. Configuration. Throws naming every variable that is missing or invalid.
  const config = loadEnvConfig(env);
  const limits = loadLimits(env);

  // Thumbnails are a local cache served by this process. This remains true
  // when operator assets use S3-compatible storage, so deployments must use
  // their configured persistent volume rather than an internal working path.
  const thumbnailsDir = config.storage.thumbnailsDir;

  // 2. Database and migrations, in that order and before anything can serve.
  const handle = openDatabase({
    databasePath: config.databasePath,
    ...(options.migrationsFolder !== undefined && {
      migrationsFolder: options.migrationsFolder,
    }),
  });

  try {
    const db = handle.db;

    const audit = createAuditRepository(db);
    const credentials = createCredentialStore(db);
    const work = createDurableWorkStore(db);

    const automationAggregates = createAutomationAggregateRepository(db, clock);
    const buttonClicks = createButtonClickStore(db);
    const clickSecret = deriveClickSigningSecret(config.metaAppSecret);
    const buttonLinks = createButtonLinkWriter({
      store: buttonClicks,
      secret: clickSecret,
      publicOrigin: config.publicOrigin,
    });

    // 2b. The language of the instance (REQ-102), before anything says a word:
    // the credential seeding below already writes an operator-facing sentence
    // into the trail, and it has to be in the language this instance chose. The
    // environment is read only when the store has no choice in it.
    const locale = createLocalePreference({
      store: createLocalePreferenceStore(db),
      catalogue,
      env,
      now,
    });

    await locale.apply();

    // 2c. The zone of the instance (REQ-183), by the same rule and out of the
    // same table: the stored choice wins, and `MYCHAT_TIMEZONE` is the initial
    // value for an instance whose operator has never chosen one. Nothing is
    // applied at start-up because there is nothing to apply — the zone is used
    // only when something is read, so a choice made a second ago decides the
    // next read and no restart is involved.
    const timeZone = createTimeZonePreference({
      store: createTimeZonePreferenceStore(db),
      initial: config.timeZone,
      now,
    });

    const triggerSwitches = createTriggerSwitchPreference({
      store: createTriggerSwitchStore(db),
      now,
    });

    // 2d. How long a step waits, how often it asks, how it says goodbye and
    // what its follow button says (REQ-252, REQ-254, REQ-255, REQ-257). Out of
    // the same table and by the same rule as the two above: the stored choice
    // is the whole answer, and an absent row is a fresh installation running on
    // the defaults. The label ceiling comes from the platform limits, so the
    // number the panel refuses above is the number the platform truncates at.
    const instanceSettings = createInstanceSettingsPreference({
      store: createInstanceSettingsStore(db),
      now,
      followButtonLabelChars: limits.quickReplyLabelChars,
      closingMessageBytes: limits.messageTextBytes,
    });

    // 3. The credential, seeded only if the store has none.
    const credentialConfigured = await seedCredential({
      credentials,
      audit,
      config,
      now: now(),
    });

    // 4. The ports. Every binding hands out a stable MyChat capability; the
    // bucket itself is never an address a recipient can fetch directly.
    const assetCapabilitySecret = deriveAssetCapabilitySecret(
      config.metaAppSecret,
    );
    let assets: AssetCatalogue;
    let assetsDir: string | undefined;
    let temporaryAssetUrl: ((name: string) => Promise<string>) | undefined;
    if (config.storage.driver === "disk") {
      assetsDir = config.storage.assetsDir;
      assets = createDiskAssets({
        dir: assetsDir,
        publicBaseUrl: `${config.publicOrigin}${ASSETS_ROUTE_PREFIX}`,
        assetCapabilitySecret,
      });
    } else {
      const s3Assets = createS3Assets({
        endpoint: config.storage.endpoint,
        accessKeyId: config.storage.accessKeyId,
        secretAccessKey: config.storage.secretAccessKey,
        bucket: config.storage.bucket,
        publicBaseUrl: `${config.publicOrigin}${ASSETS_ROUTE_PREFIX}`,
        assetCapabilitySecret,
        ...(options.assetFetch !== undefined && { fetch: options.assetFetch }),
      });
      assets = s3Assets;
      temporaryAssetUrl = (name) => s3Assets.temporaryUrl(name);
    }

    // The publication thumbnails, on the same principle and for the same
    // reason (REQ-109). The base is the ORIGIN and not a route prefix,
    // because the key already carries `thumbs/`, exactly as it will in the
    // bucket (ADR-010): the address handed to the grid is
    // `${origin}/thumbs/<file>`, and `registerThumbnailsRoute` below answers
    // at precisely that prefix, derived from the same constant.
    //
    // Disk and not the in-memory double, and that is the whole fix: the
    // double hands out `memory://bucket/...`, an address no browser resolves,
    // so every cell of the real grid rendered its alternative text while the
    // listing tests passed. What the binding produces has to be an address
    // this process answers for, and that is what `app.test.ts` now proves
    // against the composed application.
    const thumbnails = createDiskThumbnails({
      dir: thumbnailsDir,
      publicBaseUrl: config.publicOrigin,
    });

    const account = createInstagramLoginAccount({
      credentials,
      transport,
      refreshThresholdMs: config.tokenRefreshThresholdMs,
    });
    // Both the publication picker and insights read the same persistent cache.
    // The dashboard never calls the platform and is honest when an old post is
    // absent from this cache.
    const publicationCache = createPublicationCacheStore(db);
    const publications = createPublicationCatalogue({
      account,
      transport,
      cache: publicationCache,
      thumbnails,
      download: createFetchThumbnailDownload(),
    });

    // ONE run store for the two components that touch it: the dispatcher
    // claims a run here and the automation lifecycle drops them on deletion
    // (REQ-120). Two instances over the same database would behave the same,
    // and this way the pairing is visible at the point of wiring.
    const runs = createAutomationRunStore(db);
    const automationFailureSequences = createAutomationFailureSequenceStore(db);
    const automationFailures = createAutomationFailureHandler({
      aggregates: automationAggregates,
      failures: automationFailureSequences,
      audit,
      clock,
    });

    // 5. The dispatcher: the hook the webhook declared and never had filled.
    //
    // Its dependencies are named here rather than inline, because the sweep
    // below needs the very same ones: a paused run is picked back up by the
    // same component that runs a resumed one (REQ-098), and two bundles built
    // side by side would be two chances for them to drift apart.
    const dispatchDeps: DispatchDeps = {
      clock,
      // Runtime reads the self-contained aggregate directly. No flow catalogue
      // and no parameter binding participate in an execution (REQ-213), and
      // there are no v1 stores left composed here: task 3k.7 removed them.
      automationAggregates,
      work,
      buttonLinks,
      conversations: createConversationStore(db),
      contacts: createContactRepository(db, now),
      assets,
      // REQ-126: a step may declare several wordings, and this is what decides
      // which one goes out. Without this line the process would not compile,
      // which is the point of the port being required: an installation that
      // silently answered fifty comments with one sentence is the failure the
      // several wordings exist to prevent.
      random: createRandomSource(),
      audit,
      runs,
      triggerSwitches,
      // REQ-027: the first platform READ the engine needs. Without this line
      // every follow gate stays shut with cause `not_configured`.
      follow: createFollowLink({ account, transport }),
      messageWindowHours: limits.messageWindowHours,
      // REQ-252, REQ-254: the deadline and the number of questions the steps
      // stopped declaring. The preference itself and not its values, so a
      // change made in the panel decides the next wait with nothing restarted.
      instanceSettings,
    };

    const dispatch = createDispatcher(dispatchDeps);

    // 6. The server. One Fastify instance, with the webhook and the capability
    // route public, and no session in front of either.
    const server = buildWebhookServer({
      verifyToken: config.webhookVerifyToken,
      appSecret: config.metaAppSecret,
      events: createReceivedEventStore(db),
      audit,
      now,
      onEvent: dispatch,
    });

    // Public by design, authenticated by its own HMAC and never by a session.
    // It resolves only an immutable persisted destination and records before
    // redirecting, so neither a query parameter nor a failed write can forward
    // a contact somewhere unaccounted for (REQ-220/REQ-221).
    registerClicksRoute(server, {
      store: buttonClicks,
      secret: clickSecret,
      clock,
    });

    registerAssetsRoute(server, {
      secret: assetCapabilitySecret,
      ...(assetsDir !== undefined
        ? { dir: assetsDir }
        : { temporaryUrl: temporaryAssetUrl! }),
    });

    // Registered beside it and outside the operator's lock, for the same
    // reason: a picture of a publication the profile already shows the world
    // is not what a session protects, and these bytes are read by an `<img>`
    // in the grid rather than by a caller of the contract.
    registerThumbnailsRoute(server, { dir: thumbnailsDir });

    // 6b. The operator's lock (REQ-031, REQ-035, REQ-104). Registered on the
    // same instance as the webhook and never in front of it: a route is private
    // only by being registered inside the scope this call opens, so `/webhook`
    // and the two file routes above cannot be reached by it.
    const throttleLimits = loadAuthThrottleLimits(env);

    // The flow lifecycle is composed here, and not inline below, because the
    // detacher needs its `reach`: a detach changes how far two flows reach at
    // once (the origin loses a reference, the copy gains its only one), and the
    // screen reporting it must not have to ask a second component what just
    // happened. Wrapped in a lambda rather than passed as a method reference,
    // so the port stays a plain function and never depends on a receiver.
    registerAccess(
      server,
      {
        sessions: createSessionStore(db),
        credentials: createOperatorCredentialStore(db),
        cookie: loadSessionCookieConfig(env),
        now,
        // REQ-034. The count lives in memory on purpose (its whole horizon is
        // minutes, and a restart costs an attacker one window); what must
        // survive is the evidence, and that goes to the audit table.
        throttle: createAuthThrottle(throttleLimits),
        throttleLimits,
        audit,
      },
      (scope) => {
        // EVERY private route goes here, and nowhere else: a route is private
        // by being registered in this scope, never by its address matching a
        // pattern.
        registerApiRoutes(scope, {
          // REQ-063 reaching the application at last: the lifecycle reads the
          // stores on every call and holds no copy, so a create, an edit, an
          // activation or a deletion is in force for the next inbound event
          // with nothing restarted.
          automations: createAutomationAggregateLifecycle(
            automationAggregates,
            automationFailureSequences,
            {
              sync: () => publications.syncIds(now()),
            },
          ),
          // REQ-329: the listing answers with the counts already measured, in
          // one grouped read, so the card shows them without a request of its
          // own and without asking the platform anything.
          clickMetrics: {
            forListing: (automationIds) =>
              buttonClicks.metricsForAutomations(automationIds),
          },
          // The operator's catalogue is exposed through the authenticated API
          // below. This is the same binding used by the engine; the public
          // `/assets` route registered above remains outside that scope.
          assets,
          accountProfile: createAccountProfileReader({ account, transport }),
          // REQ-293: what a deletion will break, read before it happens. Over
          // the stored definitions as text, so an automation the current schema
          // can no longer parse still counts as a user of the file.
          assetUsage: createAssetUsageReader(db),
          metrics: async (range, at) =>
            readDashboardMetrics(
              {
                audit,
                work,
                queue: createQueueSource(db),
                clicks: buttonClicks,
                publications: publicationCache,
                limits,
                // REQ-153. Without this line the panel would count every bucket
                // on the epoch and label it UTC, whatever the operator
                // configured: the zone decides which day an event belongs to,
                // so it has to reach the aggregation and not only the screen.
                //
                // Asked HERE, inside the reader, and not once when this closure
                // was built (REQ-183). `config.timeZone` sat in this line, and
                // being a value it froze the zone at the instant the process
                // started: a choice made in the panel changed the label on the
                // Settings screen and left every bucket cut on the old clock
                // until somebody restarted. The store is a single indexed row
                // per read, against a query that already walks the window.
                zone: (await timeZone.inForce()).timeZone,
              },
              range,
              at,
            ),
          status: () => readOperationalStatus({ credentials, audit, work }),
          triggerSwitches,
          publications,
          publicationAutomationCoverage:
            createPublicationAutomationCoverageReader(db),
          locale,
          // REQ-166, REQ-183. The same preference the aggregation above reads,
          // so the zone the Settings screen names is the zone the numbers were
          // cut in: one source, asked again on every read, two consumers.
          timeZone,
          // REQ-252, REQ-254, REQ-255, REQ-257. The same preference the
          // dispatcher reads, so what the Settings screen shows is what the
          // next wait is created under: one source, two consumers.
          instanceSettings,
          now,
        });
      },
    );

    // The interface, out of the files `vite build` produced (REQ-105, ADR-004):
    // one process serves the platform's routes and the operator's screens. The
    // catch-all it adds answers for nothing else: `/webhook`, `/api` and the
    // resource prefix are reserved inside `static.ts`, whatever the order of
    // registration here.
    registerStaticRoute(server);

    // 7. The sweep, with a handler for every kind of durable work. A kind with
    // no handler is left in the queue forever, so all three are wired here or
    // nowhere (ADR-005: one mechanism, one loop).
    const sweep: SweepDeps = {
      work,
      clock,
      handlers: {
        send: withSendPolicy(
          createPlatformSender({ account, transport, limits, now }),
          // `audit` is what carries the platform's answer to a send into the
          // trail (REQ-039). Without it every message still goes out and the
          // dashboard's error and too-many-requests counts are simply zero.
          { work, clock, limits, audit, conclusions: automationFailures },
        ),
        suspension: createSuspensionTimeoutHandler({
          audit,
          clock,
          // REQ-098: without this line a paused run would reach its deadline
          // and stop there, one step short of what the flow promised. The
          // deadline of a pause is a resumption, and this is what performs it.
          resume: createPauseResume(dispatchDeps),
        }),
        credential_check: createCredentialCheckHandler({
          account,
          audit,
          clock,
          intervalMs: config.credentialCheckIntervalMs,
        }),
      },
    };

    if (credentialConfigured) {
      // The check reschedules itself, so it needs one row to exist. Enqueuing
      // it on every boot is idempotent by construction: the dedupe key is the
      // identity of the work, and the store hands back the existing row.
      //
      // Only when there IS a credential: checking one that was never configured
      // would raise an alert on every fresh installation, and a fresh
      // installation is not a fault.
      await work.enqueue(
        {
          kind: "credential_check",
          dedupeKey: CREDENTIAL_CHECK_KEY,
          payload: {},
        },
        now(),
      );
    }

    const loop = startSweep(sweep, config.sweepIntervalMs);

    return {
      config,
      migrations: handle.migrations,
      server,
      sweepOnce: (): Promise<SweepReport> => runSweep(sweep),
      close: async (): Promise<void> => {
        loop.stop();
        // Drains the post-response work first: closing under a running handler
        // is how a delivery disappears on deploy with nothing recording it.
        await server.whenIdle();
        await server.close();
        handle.close();
      },
    };
  } catch (error) {
    // An open connection to a database nobody will serve from is exactly what
    // must not survive this function.
    handle.close();
    throw error;
  }
}
