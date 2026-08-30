import { t } from "../i18n/index.js";

/**
 * Operator-facing configuration messages. The text lives in the locale
 * catalogue (REQ-073); this module only names the keys and supplies the
 * values, so translating never means touching this file.
 *
 * Non-negotiable rule, unchanged by the move: a message names variables, never
 * their values. A configuration failure is printed to a terminal or a log, and
 * a secret that reaches either one is a leaked secret.
 */
export const configMessages = {
  missingEnvVariables: (variables: readonly string[]): string =>
    t("config.missingEnvVariables", { variables: variables.join(", ") }),

  invalidEnvVariables: (variables: readonly string[]): string =>
    t("config.invalidEnvVariables", { variables: variables.join(", ") }),

  invalidLimitVariables: (variables: readonly string[]): string =>
    t("config.invalidLimitVariables", { variables: variables.join(", ") }),
} as const;

/**
 * Raised when the environment cannot produce a usable configuration. Carries
 * the offending variable names so a caller can react without parsing prose.
 */
export class ConfigError extends Error {
  readonly variables: readonly string[];

  constructor(message: string, variables: readonly string[]) {
    super(message);
    this.name = "ConfigError";
    this.variables = variables;
  }
}
