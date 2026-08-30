import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ConfigError } from "./errors.js";
import {
  AUTH_THROTTLE_DEFAULTS,
  AUTH_THROTTLE_ENV_VARIABLES,
  LIMIT_DEFAULTS,
  LIMIT_ENV_VARIABLES,
  describeAuthThrottleLimits,
  describeLimits,
  loadLimits,
} from "./limits.js";

/**
 * Proves REQ-006: changing any platform limit is configuration, not code, and
 * the value in force is readable at runtime.
 */
describe("REQ-006: platform limits", () => {
  it("uses the built-in defaults when no limit variable is set (AC 14)", () => {
    expect(loadLimits({})).toEqual(LIMIT_DEFAULTS);
  });

  it("reports which values are in force and where they came from (AC 14)", () => {
    const effective = describeLimits({ PRIVATE_REPLIES_PER_HOUR: "50" });

    expect(effective).toContainEqual({
      key: "privateRepliesPerHour",
      variable: "PRIVATE_REPLIES_PER_HOUR",
      value: 50,
      source: "environment",
    });
    expect(effective).toContainEqual({
      key: "callsPerSecond",
      variable: "CALLS_PER_SECOND",
      value: LIMIT_DEFAULTS.callsPerSecond,
      source: "default",
    });
    expect(effective).toHaveLength(Object.keys(LIMIT_DEFAULTS).length);
  });

  it("lets an environment variable override the default (AC 15)", () => {
    const limits = loadLimits({ MESSAGE_WINDOW_HOURS: "12" });

    expect(limits.messageWindowHours).toBe(12);
    expect(limits.callsPerSecond).toBe(LIMIT_DEFAULTS.callsPerSecond);
  });

  it("exposes an override variable for every limit (AC 15)", () => {
    for (const [key, variable] of Object.entries(LIMIT_ENV_VARIABLES)) {
      const overridden = loadLimits({ [variable]: "7" });

      expect(overridden).toMatchObject({ [key]: 7 });
    }
  });

  it("rejects a non-numeric value instead of falling back to the default", () => {
    expect(() => loadLimits({ RETRY_ATTEMPTS: "many" })).toThrow(ConfigError);
    expect(() => loadLimits({ RETRY_ATTEMPTS: "many" })).toThrow(
      /RETRY_ATTEMPTS/,
    );
  });

  it("rejects a negative value", () => {
    expect(() => loadLimits({ RETRY_BASE_MS: "-1" })).toThrow(
      /RETRY_BASE_MS.*non-negative/,
    );
  });

  it("names every invalid variable in a single error", () => {
    try {
      loadLimits({ CALLS_PER_SECOND: "abc", ALERT_THRESHOLD_PCT: "-5" });
      expect.unreachable("invalid limits must throw");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as ConfigError).variables).toEqual([
        "CALLS_PER_SECOND",
        "ALERT_THRESHOLD_PCT",
      ]);
    }
  });

  it("treats a blank value as unset, so a copied .env.example still works", () => {
    expect(loadLimits({ CALLS_PER_SECOND: "   " })).toEqual(LIMIT_DEFAULTS);
  });

  it("reads only the environment it is given, never process.env", () => {
    const variable = LIMIT_ENV_VARIABLES.callsPerSecond;
    const previous = process.env[variable];
    process.env[variable] = "1";

    try {
      expect(loadLimits({}).callsPerSecond).toBe(LIMIT_DEFAULTS.callsPerSecond);
    } finally {
      if (previous === undefined) {
        delete process.env[variable];
      } else {
        process.env[variable] = previous;
      }
    }
  });
});

describe("REQ-360: product artefacts do not teach the obsolete 20-character maximum", () => {
  const ARTEFACTS = [
    "docs/platform-limits.md",
    "docs/prototipo-automacao.html",
    "mychat-design-system/project/components/forms/KeywordField.d.ts",
    "mychat-design-system/project/guidelines/wordmark.html",
  ] as const;

  it("keeps 20 historical when it is mentioned and never presents it as the current maximum", () => {
    for (const path of ARTEFACTS) {
      const artefact = readFileSync(
        new URL(`../../${path}`, import.meta.url),
        "utf8",
      );
      expect(
        artefact,
        `${path} must not teach 20 characters as the current maximum`,
      ).not.toMatch(
        /(?:no\s+máximo|limite(?:\s+atual)?|máximo)\s+(?:de\s+)?20\s+caracteres/i,
      );
    }
    expect(
      readFileSync(
        new URL("../../docs/platform-limits.md", import.meta.url),
        "utf8",
      ),
    ).toMatch(/registro histórico, não normativo/i);
    expect(
      readFileSync(
        new URL("../../docs/prototipo-automacao.html", import.meta.url),
        "utf8",
      ),
    ).toContain("O texto continua sendo salvo inteiro.");
  });
});

/**
 * Proves REQ-006 for the second family of limits: the authentication ceiling
 * is configuration too, and the value in force is readable at runtime.
 *
 * It used to be declared inside `src/auth/throttle.ts`, which meant `.env.example`
 * never listed it and nothing reported it: an operator could not find out that
 * `AUTH_TRUSTED_PROXY_HOPS` existed, let alone which value was in force behind
 * their proxy. What it does is proven in `src/auth/throttle.test.ts`; what is
 * proven here is that it is declared and reported like every other limit.
 */
describe("REQ-006: the authentication ceiling is configuration", () => {
  it("reports every value in force and where it came from", () => {
    const effective = describeAuthThrottleLimits({});

    expect(effective).toContainEqual({
      key: "attempts",
      variable: "AUTH_ATTEMPT_LIMIT",
      value: AUTH_THROTTLE_DEFAULTS.attempts,
      source: "default",
    });
    expect(effective).toHaveLength(Object.keys(AUTH_THROTTLE_DEFAULTS).length);
  });

  it("reports an overridden value as coming from the environment", () => {
    // The value an operator behind Caddy has to set, and the one they most
    // need to be able to read back: with the default of zero the ceiling
    // counts the proxy instead of the caller, and becomes global.
    const effective = describeAuthThrottleLimits({
      AUTH_TRUSTED_PROXY_HOPS: "1",
    });

    expect(effective).toContainEqual({
      key: "trustedProxyHops",
      variable: "AUTH_TRUSTED_PROXY_HOPS",
      value: 1,
      source: "environment",
    });
  });

  it("exposes an override variable for every value of the ceiling", () => {
    // Guards the guard: a sixth limit added with no variable, or with a
    // variable nothing declares, fails here instead of being unconfigurable.
    expect(Object.keys(AUTH_THROTTLE_ENV_VARIABLES).sort()).toEqual(
      Object.keys(AUTH_THROTTLE_DEFAULTS).sort(),
    );

    for (const effective of describeAuthThrottleLimits({})) {
      expect(effective.variable).toBe(
        AUTH_THROTTLE_ENV_VARIABLES[effective.key],
      );
    }
  });

  it("refuses an invalid value instead of reporting a number nobody chose", () => {
    expect(() =>
      describeAuthThrottleLimits({ AUTH_ATTEMPT_LIMIT: "0" }),
    ).toThrow(ConfigError);
    expect(() => describeAuthThrottleLimits({ AUTH_BLOCK_MS: "2.5" })).toThrow(
      /AUTH_BLOCK_MS/,
    );
  });

  it("keeps the two families apart", () => {
    // The ceiling is NOT a platform quota: nothing in the platform's
    // documentation sustains those numbers, and mixing them into
    // `PlatformLimits` would break the contract REQ-079 rests on.
    for (const variable of Object.values(AUTH_THROTTLE_ENV_VARIABLES)) {
      expect(Object.values(LIMIT_ENV_VARIABLES)).not.toContain(variable);
    }

    for (const key of Object.keys(AUTH_THROTTLE_DEFAULTS)) {
      expect(LIMIT_DEFAULTS).not.toHaveProperty(key);
    }
  });
});

/**
 * Proves REQ-079: the configuration carries no figure the official
 * documentation does not sustain.
 *
 * The project once shipped an hourly cap of 200 messages and 200 API calls.
 * Neither exists in the official documentation: the real quotas are per second,
 * and the single official hourly ceiling belongs to private replies. Those two
 * numbers were defaults in this file and assertions in the spec, which is the
 * worst place for an invented figure to sit, because everything downstream
 * treats it as confirmed.
 */
describe("REQ-079: every limit is sustained by the documentation", () => {
  const DOCUMENT = readFileSync(
    new URL("../../docs/platform-limits.md", import.meta.url),
    "utf8",
  );

  /**
   * Where each platform-derived limit must appear in the document, expressed
   * against the value in force: change a default without changing the
   * document, and the pattern stops matching.
   *
   * `retryAttempts`, `retryBaseMs` and `alertThresholdPct` are deliberately
   * absent: they are the project's own operational choices, not quotas the
   * platform publishes, so there is no source to cite for them.
   */
  const DOCUMENTED: Readonly<Record<string, (value: number) => RegExp>> = {
    messageWindowHours: (value) => new RegExp(`${value} horas`),
    commentReplyWindowDays: (value) => new RegExp(`${value} dias`),
    privateRepliesPerHour: (value) => new RegExp(`${value} chamadas/h`),
    callsPerSecond: (value) => new RegExp(`${value} chamadas/s`),
    mediaCallsPerSecond: (value) => new RegExp(`${value} chamadas/s`),
    // Bytes, not characters — the document says so in those words, and the
    // pattern demands the unit rather than only the number.
    messageTextBytes: (value) => new RegExp(`${value} bytes`),
    linkButtonLabelChars: (value) => new RegExp(`${value} caracteres`),
    quickReplyLabelChars: (value) => new RegExp(`${value} caracteres`),
    // One sentence in the document sustains both: "título e subtítulo com 80
    // caracteres", said of the generic template's element.
    cardTitleChars: (value) => new RegExp(`${value} caracteres`),
    cardDescriptionChars: (value) => new RegExp(`${value} caracteres`),
  };

  it("carries no hourly cap on messages or on API calls (D3)", () => {
    // The regression guard proper: these keys are what the survey invented.
    expect(LIMIT_DEFAULTS).not.toHaveProperty("messagesPerHour");
    expect(LIMIT_DEFAULTS).not.toHaveProperty("apiCallsPerHour");
    expect(Object.values(LIMIT_ENV_VARIABLES)).not.toContain(
      "MESSAGES_PER_HOUR",
    );
    expect(Object.values(LIMIT_ENV_VARIABLES)).not.toContain(
      "API_CALLS_PER_HOUR",
    );
  });

  it("keeps the two windows separate and distinct (D4)", () => {
    // A private reply has seven days from the comment; a direct message has
    // twenty-four hours. Collapsing them into one number loses six days on one
    // path and invents six on the other.
    expect(LIMIT_DEFAULTS.messageWindowHours).toBe(24);
    expect(LIMIT_DEFAULTS.commentReplyWindowDays).toBe(7);
  });

  it("points every platform limit at the document that confirms it", () => {
    for (const [key, pattern] of Object.entries(DOCUMENTED)) {
      const value = LIMIT_DEFAULTS[key as keyof typeof LIMIT_DEFAULTS];

      expect(
        DOCUMENT,
        `${key} = ${value} is not backed by docs/platform-limits.md`,
      ).toMatch(pattern(value));
    }
  });

  it("checks every platform-derived limit, so a new one cannot slip in unchecked", () => {
    // Guards the guard: adding a limit without either documenting it or
    // classifying it as an operational choice must fail here, not pass in
    // silence.
    const operational = [
      "retryAttempts",
      "retryBaseMs",
      "alertThresholdPct",
      "criticalThresholdPct",
    ];
    const classified = new Set([...Object.keys(DOCUMENTED), ...operational]);

    expect(
      Object.keys(LIMIT_DEFAULTS).filter((k) => !classified.has(k)),
    ).toEqual([]);
  });
});
