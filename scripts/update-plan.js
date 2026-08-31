/* global console, process */

import { fileURLToPath } from "node:url";

export const UPDATE_COMMANDS = Object.freeze(["version", "update", "rollback"]);

const stableVersionPattern = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const digestPattern = /^sha256:[a-f0-9]{64}$/;

function assertPlainObject(value, name) {
  if (!value || Array.isArray(value) || typeof value !== "object") {
    throw new TypeError(`${name} must be an object`);
  }
}

function validateCommand(command) {
  if (!UPDATE_COMMANDS.includes(command)) {
    throw new Error(`unsupported update command: ${command}`);
  }
  return command;
}

function validateLocalAuth(localAuth) {
  assertPlainObject(localAuth, "localAuth");
  if (localAuth.kind !== "local" || localAuth.authenticated !== true) {
    throw new Error("local authentication is required");
  }
  return { authenticated: true, kind: "local" };
}

function validateRelease(release, name) {
  assertPlainObject(release, name);
  if (
    typeof release.version !== "string" ||
    !stableVersionPattern.test(release.version)
  ) {
    throw new Error(`${name}.version must be an explicit stable version`);
  }
  if (
    typeof release.digest !== "string" ||
    !digestPattern.test(release.digest)
  ) {
    throw new Error(`${name}.digest must be an immutable sha256 digest`);
  }
  if (release.digestVerified !== true) {
    throw new Error(`${name}.digest must be authenticated`);
  }

  return {
    digest: release.digest,
    digestVerified: true,
    version: release.version,
  };
}

function step(id, command, purpose) {
  return Object.freeze({ command, id, purpose });
}

function imageReference(release) {
  return `ghcr.io/alessandrovarela/mychat:${release.version}@${release.digest}`;
}

function recoverySteps(currentRelease) {
  const image = imageReference(currentRelease);
  return Object.freeze([
    step("stop", "docker compose stop app", "stop the failed release"),
    step(
      "restore",
      "restore the pre-migration backup into mychat-data",
      "restore data captured before migration",
    ),
    step(
      "configure-previous",
      `set compose app image to ${image}`,
      "restore the previous immutable image reference",
    ),
    step(
      "pull-previous",
      "docker compose pull app",
      "pull the previous immutable image",
    ),
    step(
      "restart-previous",
      "docker compose up -d app",
      "restart the previous release",
    ),
    step(
      "health-previous",
      "docker compose ps --status running",
      "confirm the restored release is healthy",
    ),
  ]);
}

function operationSteps(targetRelease) {
  const image = imageReference(targetRelease);
  return Object.freeze([
    step(
      "preflight",
      "verify compose, volume, backup storage, and authenticated release",
      "refuse an unsafe update before changing state",
    ),
    step(
      "backup",
      "create a consistent backup of mychat-data",
      "preserve data before migration",
    ),
    step(
      "sync",
      "litestream replicate -exec /bin/true",
      "synchronize the backup before changing the release",
    ),
    step(
      "configure",
      `set compose app image to ${image}`,
      "pin the requested immutable image",
    ),
    step(
      "pull",
      "docker compose pull app",
      "pull the requested immutable image",
    ),
    step(
      "migrate",
      "docker compose run --rm app npm run db:migrate",
      "migrate persistent data",
    ),
    step("restart", "docker compose up -d app", "start the requested release"),
    step(
      "health",
      "docker compose ps --status running",
      "verify the requested release is healthy",
    ),
  ]);
}

/**
 * Produces a reviewable local update plan. It never executes Docker, accesses
 * the network, reads credentials, or mutates the installation.  A caller must
 * supply local authentication and an authenticated immutable release before a
 * command can be planned.
 */
export function createUpdatePlan({
  command,
  currentRelease,
  localAuth,
  targetRelease,
}) {
  const validatedCommand = validateCommand(command);
  const authentication = validateLocalAuth(localAuth);
  const current = validateRelease(currentRelease, "currentRelease");

  if (validatedCommand === "version") {
    return Object.freeze({
      authentication,
      command: "version",
      currentRelease: current,
      mode: "plan",
      networkAccessed: false,
      steps: Object.freeze([]),
    });
  }

  const target = validateRelease(targetRelease, "targetRelease");
  if (target.version === current.version && target.digest === current.digest) {
    throw new Error("targetRelease must differ from currentRelease");
  }

  return Object.freeze({
    authentication,
    command: validatedCommand,
    currentRelease: current,
    failureRecovery: recoverySteps(current),
    mode: "plan",
    networkAccessed: false,
    steps: operationSteps(target),
    targetRelease: target,
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  console.log(
    JSON.stringify(
      createUpdatePlan({
        command: "update",
        currentRelease: {
          digest:
            "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          digestVerified: true,
          version: "1.0.0",
        },
        localAuth: { authenticated: true, kind: "local" },
        targetRelease: {
          digest:
            "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          digestVerified: true,
          version: "1.1.0",
        },
      }),
      null,
      2,
    ),
  );
}
