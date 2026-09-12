export { IN_MEMORY_DATABASE, openDatabase } from "./database.js";

export type {
  DatabaseConfig,
  DatabaseHandle,
  MyChatDatabase,
} from "./database.js";

export { MigrationError, StorageError } from "./errors.js";

export {
  DEFAULT_MIGRATIONS_FOLDER,
  MIGRATIONS_TABLE,
  readAppliedMigrations,
  readMigrations,
  runMigrations,
} from "./migrations.js";

export type { Migration, MigrationReport } from "./migrations.js";

export { createAutomationAggregateRepository } from "./automation-aggregates.js";

export { createButtonClickStore, recordButtonClick } from "./button-clicks.js";

export type {
  AttributedButtonClick,
  ButtonClickMetrics,
  ButtonClickStore,
  ButtonDestination,
} from "./button-clicks.js";

export {
  createAuditRepository,
  subtypeGroupOf,
  UNKNOWN_SUBTYPE,
} from "./audit.js";

export type {
  AuditActionSubtype,
  AuditAlertSubtype,
  AuditEntry,
  AuditEventSubtype,
  AuditKind,
  AuditOutcome,
  AuditQuery,
  AuditRecord,
  AuditRepository,
  AuditSubtype,
  AuditSubtypeGroup,
} from "./audit.js";

export {
  auditEntries,
  automationFailureSequences,
  automationAggregates,
  buttonClicks,
  buttonDestinations,
} from "./schema.js";

export type { AuditEntryRow } from "./schema.js";
export type { ButtonClickRow, ButtonDestinationRow } from "./schema.js";

export { createAutomationRunStore } from "./automation-runs.js";

export type { AutomationRunStore } from "./automation-runs.js";

export {
  AUTOMATION_FAILURE_LIMIT,
  AUTOMATION_FAILURE_WINDOW_MS,
  createAutomationFailureSequenceStore,
} from "./automation-failures.js";

export type { AutomationFailureSequenceStore } from "./automation-failures.js";

export { automationRuns, receivedEvents } from "./schema.js";

export type { AutomationRunRow, ReceivedEventRow } from "./schema.js";
export type { AutomationFailureSequenceRow } from "./schema.js";

export {
  createDurableWorkStore,
  SEND_CLASSES,
  WORK_KINDS,
  WORK_STATUSES,
} from "./durable-work.js";

export type {
  DurableWorkStore,
  EnqueueResult,
  SendClass,
  WorkItem,
  WorkKind,
  WorkRequest,
  WorkStatus,
} from "./durable-work.js";

export { durableWork, platformCredentials } from "./schema.js";

export type { DurableWorkRow, PlatformCredentialRow } from "./schema.js";

export {
  createCredentialStore,
  PLATFORM_CREDENTIAL_ID,
} from "./credentials.js";

export type { CredentialStore, StoredCredential } from "./credentials.js";
export { createSecretCipher } from "./credentials.js";
export type { SecretCipher } from "./credentials.js";

export {
  createStorageConfigurationStore,
  STORAGE_CONFIGURATION_ID,
} from "./storage-configuration.js";
export type {
  PersistedStorageConfiguration,
  PersistedStorageDriver,
  StorageConfigurationStore,
} from "./storage-configuration.js";

export { createContactRepository } from "./contacts.js";

export type { ContactAttributeStore } from "./contacts.js";

export {
  ASSET_CONTENT_TYPES,
  ASSET_KEY_SEPARATOR,
  MAX_ASSET_BYTES,
  MAX_IMAGE_BYTES,
  MEMORY_ASSET_BASE,
  AssetWriteError,
  assertWritableAsset,
  assetFileName,
  createDiskAssets,
  createMemoryAssets,
  maxBytesFor,
  newAssetKey,
  storeNewAsset,
} from "./assets.js";

export type {
  AssetBody,
  AssetCatalogue,
  AssetCapabilitySecret,
  AssetContentType,
  AssetWriteErrorCode,
  DiskAssetConfig,
  MemoryAssets,
  StoredAsset,
} from "./assets.js";

export {
  assetCapability,
  assetCapabilityUrl,
  deriveAssetCapabilitySecret,
  hasAssetCapability,
} from "./assets.js";

export { createAssetUsageReader } from "./asset-usage.js";

export type { AssetUsage, AssetUsageReader } from "./asset-usage.js";

export {
  ASSET_PREFIX,
  S3_ASSET_PREFIX,
  S3AssetError,
  createS3Assets,
} from "./s3-assets.js";

export type {
  S3AssetCatalogue,
  S3AssetConfig,
  S3AssetErrorCode,
} from "./s3-assets.js";

export { contactAttributes } from "./schema.js";

export type { ContactAttributeRow } from "./schema.js";

export { createConversationStore } from "./conversations.js";

export type { ConversationStore } from "./conversations.js";

export { contactConversations } from "./schema.js";

export type { ContactConversationRow } from "./schema.js";

export {
  createDiskThumbnails,
  createMemoryThumbnails,
  createPublicationCacheStore,
  MEMORY_THUMBNAIL_BASE,
  THUMBNAIL_PREFIX,
  thumbnailKeyFor,
} from "./publication-cache.js";

export type {
  CachedPublication,
  CachedPublicationPage,
  DiskThumbnailConfig,
  MemoryThumbnails,
  PublicationCacheStore,
  PublicationPageQuery,
  ThumbnailBody,
  ThumbnailStore,
} from "./publication-cache.js";

export { publicationCache } from "./schema.js";

export type { PublicationCacheRow } from "./schema.js";

export { createPublicationAutomationCoverageReader } from "./publication-automation-coverage.js";

export type {
  PublicationAutomationCoverage,
  PublicationAutomationCoverageReader,
  PublicationAutomationReference,
} from "./publication-automation-coverage.js";

export {
  createInstanceSettingsStore,
  createLocalePreferenceStore,
  createPreferenceStore,
  createTimeZonePreferenceStore,
  createTriggerSwitchStore,
} from "./preferences.js";

export type { PreferenceStore } from "./preferences.js";

export { instancePreferences } from "./schema.js";

export type { InstancePreferenceRow } from "./schema.js";
