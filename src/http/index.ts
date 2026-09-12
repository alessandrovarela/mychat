export { ASSETS_ROUTE_PREFIX, registerAssetsRoute } from "./assets-route.js";

export type { AssetsRouteConfig } from "./assets-route.js";

export {
  THUMBNAILS_ROUTE_PREFIX,
  registerThumbnailsRoute,
} from "./thumbnails-route.js";

export type { ThumbnailsRouteConfig } from "./thumbnails-route.js";

export { registerFileRoute } from "./file-route.js";

export type { FileRouteConfig } from "./file-route.js";

export { buildWebhookServer, eventIdOf } from "./webhook.js";

export type { EventHandler, WebhookDeps, WebhookServer } from "./webhook.js";

export { createReceivedEventStore } from "./received-events.js";

export type { ReceivedEventStore } from "./received-events.js";

export { verifySignature } from "./signature.js";

export type { SignatureVerdict } from "./signature.js";

export {
  CLICKS_ROUTE_PREFIX,
  createButtonLinkWriter,
  deriveClickSigningSecret,
  registerClicksRoute,
} from "./clicks-route.js";

export type {
  ButtonClickMetricsBatchReader,
  ButtonClickMetricsReader,
} from "./clicks-route.js";

export {
  RESERVED_PREFIXES,
  WEB_DIST_DIR,
  registerStaticRoute,
} from "./static.js";

export type { StaticRouteConfig } from "./static.js";

export {
  INVALID_CREDENTIALS,
  PRIVATE_PREFIXES,
  registerAccess,
  SESSION_ROUTE,
  UNAUTHORIZED,
} from "./access.js";

export type { AccessDeps, PrivateRoutes } from "./access.js";

export {
  ASSETS_API_ROUTE,
  LOCALE_ROUTE,
  registerAssetRoutes,
  registerApiRoutes,
  registerLocaleRoutes,
  registerSetupRoutes,
} from "./api/index.js";

export type { ApiDeps, DashboardMetricsReader } from "./api/index.js";
