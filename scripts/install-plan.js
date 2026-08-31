/* global console, process */

import { fileURLToPath } from "node:url";

export const SUPPORTED_UBUNTU_LTS = ["22.04", "24.04"];
export const SUPPORTED_ARCHITECTURES = ["amd64", "arm64"];

const secretKeyPattern = /(?:secret|token|password|key|credential)/i;

function assertPlainObject(value, name) {
  if (!value || Array.isArray(value) || typeof value !== "object") {
    throw new Error(`${name} must be an object`);
  }
}

function assertNonSecretConfig(config) {
  assertPlainObject(config, "configuration");
  for (const [key, value] of Object.entries(config)) {
    if (secretKeyPattern.test(key)) {
      throw new Error(`configuration must not contain secrets: ${key}`);
    }
    if (typeof value !== "string" || !value.trim()) {
      throw new Error(`configuration value must be a non-empty string: ${key}`);
    }
  }
}

export function detectArchitecture(architecture) {
  const normalised = String(architecture ?? "")
    .trim()
    .toLowerCase();
  const aliases = { aarch64: "arm64", x86_64: "amd64" };
  const detected = aliases[normalised] ?? normalised;
  if (!SUPPORTED_ARCHITECTURES.includes(detected)) {
    throw new Error(
      `unsupported architecture: ${architecture}; expected amd64 or arm64`,
    );
  }
  return detected;
}

function validateHost(host) {
  assertPlainObject(host, "host");
  if (host.id !== "ubuntu" || !SUPPORTED_UBUNTU_LTS.includes(host.version)) {
    throw new Error(
      `supported host is Ubuntu LTS ${SUPPORTED_UBUNTU_LTS.join(" or ")}`,
    );
  }
  return {
    architecture: detectArchitecture(host.architecture),
    id: "ubuntu",
    version: host.version,
  };
}

/**
 * Produces an operator-reviewable installation plan. It never probes a host,
 * touches a file, requests a secret, or executes a command.
 */
export function createInstallPlan({ configuration, consent, host }) {
  const validatedHost = validateHost(host);
  assertNonSecretConfig(configuration);
  if (typeof consent !== "boolean") {
    throw new Error("consent must explicitly be true or false");
  }

  const prerequisiteCommands = [
    "sudo apt-get update",
    "sudo apt-get install --yes ca-certificates curl docker.io docker-compose-v2",
    "sudo usermod -aG docker $USER",
  ];
  const configurationEntries = Object.entries(configuration)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`);

  return {
    architecture: validatedHost.architecture,
    configuration: {
      destination: ".env",
      entries: configurationEntries,
      secretValuesCollected: false,
    },
    host: validatedHost,
    mode: "plan",
    networkAccessed: false,
    prerequisites: {
      consentRequired: true,
      consented: consent,
      commands: consent ? prerequisiteCommands : [],
      deferredCommands: consent ? [] : prerequisiteCommands,
    },
    secrets: {
      destination: ".env",
      generatedByOperator: true,
      keys: ["META_APP_SECRET", "WEBHOOK_VERIFY_TOKEN"],
      commands: [
        "openssl rand -hex 32 # META_APP_SECRET",
        "openssl rand -hex 32 # WEBHOOK_VERIFY_TOKEN",
      ],
      values: [],
    },
    startup: {
      commands: ["docker compose pull", "docker compose up -d"],
      composeFile: "docker-compose.yml",
      persistentVolume: "mychat-data",
    },
    health: {
      command: "docker compose ps --status running",
      expected: "mychat is running and bound to 127.0.0.1:3000",
      recovery: "docker compose logs --tail=100 mychat",
    },
    nextGuide: "docs/first-use.md",
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [architecture = "amd64"] = process.argv.slice(2);
  console.log(
    JSON.stringify(
      createInstallPlan({
        configuration: {
          MYCHAT_LOCALE: "pt-BR",
          MYCHAT_TIMEZONE: "America/Sao_Paulo",
          PUBLIC_ORIGIN: "https://chat.example.com",
        },
        consent: false,
        host: { architecture, id: "ubuntu", version: "24.04" },
      }),
      null,
      2,
    ),
  );
}
