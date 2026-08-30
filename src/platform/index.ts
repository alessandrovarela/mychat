export { AUTH_PATHS, CREDENTIAL_FAILURES } from "./account.js";

export type {
  AccountCredential,
  AuthPath,
  CredentialFailure,
  CredentialHealth,
  PlatformAccount,
  RefreshOutcome,
} from "./account.js";

export { createFetchTransport, isSuccess } from "./transport.js";

export type {
  PlatformRequest,
  PlatformResponse,
  PlatformTransport,
} from "./transport.js";

export {
  createInstagramLoginAccount,
  INSTAGRAM_LOGIN_HOST,
  INSTAGRAM_LOGIN_SCOPES,
} from "./instagram-login.js";

export type { InstagramLoginDeps } from "./instagram-login.js";

export {
  CREDENTIAL_CHECK_KEY,
  createCredentialCheckHandler,
  runCredentialCheck,
} from "./credential-check.js";

export type {
  CredentialCheckDeps,
  CredentialCheckOutcome,
} from "./credential-check.js";

export {
  describeResponseError,
  describeThrown,
  MEDIA_PAGE_SIZE,
  MEDIA_PATH,
  nextPageRequest,
  PUBLICATION_PAGE_LIMIT,
} from "./publications.js";

export type { MediaPage } from "./publications.js";

export {
  createFetchThumbnailDownload,
  createPublicationCatalogue,
  PUBLICATION_LISTING_PAGE_SIZE,
} from "./publications-cache.js";

export type {
  PublicationCatalogue,
  PublicationCatalogueDeps,
  PublicationEntry,
  PublicationListing,
  PublicationLookup,
  ThumbnailDownload,
} from "./publications-cache.js";

export { buildSendRequest, createPlatformSender } from "./sender.js";

export type { SenderDeps, SendPayload } from "./sender.js";

export { checkWindow, DELIVERY_WINDOWS, windowFor } from "./windows.js";

export type {
  DeliveryWindow,
  ExecutionOrigin,
  WindowLimits,
  WindowVerdict,
} from "./windows.js";

export { readOperationalStatus } from "./status.js";

export type { OperationalStatus, StatusDeps } from "./status.js";
export { createFollowLink, FOLLOW_FIELD } from "./follow.js";

export type { FollowLinkDeps } from "./follow.js";
