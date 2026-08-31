const secretKeyPattern = /(?:secret|token|password|key|credential)/i;

function assertPlainObject(value, name) {
  if (!value || Array.isArray(value) || typeof value !== "object") {
    throw new Error(`${name} must be an object`);
  }
}

function assertStringRecord(value, name) {
  assertPlainObject(value, name);
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== "string" || !entry.trim()) {
      throw new Error(`${name}.${key} must be a non-empty string`);
    }
  }
}

function secretKeys(configuration) {
  return Object.keys(configuration)
    .filter((key) => secretKeyPattern.test(key))
    .sort();
}

/**
 * Produces a deterministic reexecution decision without reading or writing the
 * host. The caller is responsible for carrying out any approved action.
 */
export function assessInstallationState({
  existing,
  requested,
  replaceSecrets,
}) {
  assertPlainObject(existing, "existing");
  assertPlainObject(requested, "requested");
  assertStringRecord(existing.configuration, "existing.configuration");
  assertStringRecord(requested.configuration, "requested.configuration");
  if (typeof existing.volumePresent !== "boolean") {
    throw new Error("existing.volumePresent must be a boolean");
  }
  if (typeof replaceSecrets !== "boolean") {
    throw new Error("replaceSecrets must explicitly be true or false");
  }

  const presentSecrets = secretKeys(existing.configuration);
  const requestedSecrets = secretKeys(requested.configuration);
  const replacementRequested = requestedSecrets.length > 0;
  const requiresSecretConfirmation =
    presentSecrets.length > 0 && replacementRequested;

  if (requiresSecretConfirmation && !replaceSecrets) {
    return {
      action: "awaiting_secret_confirmation",
      preserved: {
        configuration: true,
        volume: existing.volumePresent,
        secrets: presentSecrets,
      },
      recovery: {
        command: "rerun with replaceSecrets: true after backing up .env",
        resumeAt: "secret-confirmation",
      },
    };
  }

  return {
    action: "resume_installation",
    configuration: {
      preservedKeys: Object.keys(existing.configuration).sort(),
      requestedNonSecretKeys: Object.keys(requested.configuration)
        .filter((key) => !secretKeyPattern.test(key))
        .sort(),
    },
    secrets: {
      replaced: requiresSecretConfirmation && replaceSecrets,
      preserved: requiresSecretConfirmation ? [] : presentSecrets,
    },
    volume: { preserved: existing.volumePresent },
    recovery: { command: "docker compose up -d", resumeAt: "compose-start" },
  };
}

export function diagnoseInstallationFailure({ check, detail }) {
  if (typeof check !== "string" || !check.trim()) {
    throw new Error("check must be a non-empty string");
  }
  if (typeof detail !== "string" || !detail.trim()) {
    throw new Error("detail must be a non-empty string");
  }

  const fixes = {
    docker:
      "install Docker and the Docker Compose plugin, then rerun the installer",
    permissions:
      "add the operator to the docker group, sign in again, then rerun the installer",
    disk: "free disk space, then rerun the installer",
  };
  const resumeAt = {
    docker: "prerequisites",
    permissions: "prerequisites",
    disk: "compose-start",
  };

  return {
    check,
    detail,
    fix: fixes[check] ?? "resolve the reported check, then rerun the installer",
    resumeAt: resumeAt[check] ?? "environment-check",
  };
}
