import { URL } from "node:url";

const ENVIRONMENT_NAMES = ["production", "test"];

const protectedFields = [
  "appId",
  "accountId",
  "callbackUrl",
  "appSecret",
  "envFile",
  "dataDirectory",
];

function assertPlainObject(value, name) {
  if (!value || Array.isArray(value) || typeof value !== "object") {
    throw new Error(`${name} must be an object`);
  }
}

function normaliseCallbackUrl(value, name) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name}.callbackUrl must be a valid HTTPS URL`);
  }

  if (url.protocol !== "https:" || url.username || url.password) {
    throw new Error(`${name}.callbackUrl must be a valid HTTPS URL`);
  }

  return url.href;
}

function normaliseEnvironment(value, name) {
  assertPlainObject(value, name);
  const environment = {};

  for (const field of protectedFields) {
    const candidate = value[field];
    if (typeof candidate !== "string" || !candidate.trim()) {
      throw new Error(`${name}.${field} must be a non-empty string`);
    }
    environment[field] =
      field === "callbackUrl"
        ? normaliseCallbackUrl(candidate.trim(), name)
        : candidate.trim();
  }

  return environment;
}

/**
 * Validates the complete Meta configuration before a webhook is started.
 * Both environments must own every protected Meta identifier and local path.
 */
export function assertMetaEnvironmentIsolation({ production, test }) {
  const environments = {
    production: normaliseEnvironment(production, "production"),
    test: normaliseEnvironment(test, "test"),
  };

  for (const field of protectedFields) {
    if (environments.production[field] === environments.test[field]) {
      throw new Error(
        `Meta environment collision: production and test share ${field}`,
      );
    }
  }

  return environments;
}

export const META_ENVIRONMENT_NAMES = ENVIRONMENT_NAMES;
export const META_PROTECTED_FIELDS = protectedFields;
