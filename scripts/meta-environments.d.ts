export type MetaEnvironmentName = "production" | "test";

export interface MetaEnvironment {
  appId: string;
  accountId: string;
  callbackUrl: string;
  appSecret: string;
  envFile: string;
  dataDirectory: string;
}

export const META_ENVIRONMENT_NAMES: MetaEnvironmentName[];
export const META_PROTECTED_FIELDS: (keyof MetaEnvironment)[];

/**
 * Validates both Meta environments before a webhook is started. Throws when a
 * protected identifier, secret, configuration file, or data directory overlaps.
 */
export function assertMetaEnvironmentIsolation(input: {
  production: MetaEnvironment;
  test: MetaEnvironment;
}): {
  production: MetaEnvironment;
  test: MetaEnvironment;
};
