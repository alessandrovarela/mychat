export {
  createOperatorCredentialStore,
  hashPassword,
  MINIMUM_PASSWORD_LENGTH,
  OPERATOR_CREDENTIAL_ID,
  PASSWORD_ALGORITHM,
  setOperatorPassword,
  verifyOperatorPassword,
} from "./credential.js";

export type {
  OperatorCredentialStore,
  SetPasswordOutcome,
  StoredOperatorCredential,
} from "./credential.js";

export {
  authorise,
  COOKIE_SECURE_VARIABLE,
  createSessionStore,
  DEFAULT_SESSION_TTL_MS,
  endSession,
  loadSessionCookieConfig,
  newSessionId,
  SESSION_COOKIE_NAME,
  SESSION_COOKIE_SAME_SITE,
  sessionCookieFlags,
  startSession,
} from "./session.js";

export type {
  SessionCookieConfig,
  SessionCookieFlags,
  SessionStore,
  StoredSession,
} from "./session.js";

export {
  attemptAuthentication,
  AUTH_THROTTLE_DEFAULTS,
  AUTH_THROTTLE_ENV_VARIABLES,
  createAuthThrottle,
  FORWARDED_FOR_HEADER,
  loadAuthThrottleLimits,
  originKey,
  recordThrottleRefusal,
  resolveOrigin,
  retryAfterSeconds,
  THROTTLE_REASON_KEY,
  throttleRefusalReason,
  UNKNOWN_ORIGIN,
} from "./throttle.js";

export type {
  AuthAttemptVerdict,
  AuthThrottle,
  AuthThrottleLimits,
} from "./throttle.js";
