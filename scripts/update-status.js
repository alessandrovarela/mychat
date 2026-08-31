const stableTagPattern = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const dayMilliseconds = 24 * 60 * 60 * 1000;

function assertStableTag(value, name) {
  if (typeof value !== "string" || !stableTagPattern.test(value)) {
    throw new Error(`${name} must be a stable vMAJOR.MINOR.PATCH tag`);
  }
}

function assertIsoTimestamp(value, name) {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    throw new Error(`${name} must be an ISO-8601 timestamp`);
  }
}

function versionParts(tag) {
  return tag.slice(1).split(".").map(Number);
}

function isNewer(candidate, current) {
  const candidateParts = versionParts(candidate);
  const currentParts = versionParts(current);
  for (const [index, part] of candidateParts.entries()) {
    const currentPart = currentParts[index];
    if (part !== currentPart) {
      return part > currentPart;
    }
  }
  return false;
}

function readManifestTag(manifest) {
  const tag = manifest?.release?.tag;
  return typeof tag === "string" && stableTagPattern.test(tag)
    ? tag
    : undefined;
}

function normalizedState(state) {
  if (state === undefined) {
    return {};
  }
  if (!state || Array.isArray(state) || typeof state !== "object") {
    throw new Error("state must be an object");
  }
  const { dismissedVersion, lastCheckedAt } = state;
  if (dismissedVersion !== undefined) {
    assertStableTag(dismissedVersion, "state.dismissedVersion");
  }
  if (lastCheckedAt !== undefined) {
    assertIsoTimestamp(lastCheckedAt, "state.lastCheckedAt");
  }
  return { dismissedVersion, lastCheckedAt };
}

/**
 * Checks a published release manifest at most once per 24 hours. The injected
 * reader deliberately receives no arguments: this contract cannot append
 * instance identity, analytics, or any other telemetry to the manifest read.
 */
export async function checkUpdateStatus({
  currentVersion,
  fetchManifest,
  now,
  state,
}) {
  assertStableTag(currentVersion, "currentVersion");
  assertIsoTimestamp(now, "now");
  if (typeof fetchManifest !== "function") {
    throw new Error("fetchManifest must be a function");
  }

  const prior = normalizedState(state);
  const checkedAt = new Date(now).toISOString();
  if (
    prior.lastCheckedAt !== undefined &&
    Date.parse(checkedAt) - Date.parse(prior.lastCheckedAt) < dayMilliseconds
  ) {
    return {
      check: "deferred",
      dismissedVersion: prior.dismissedVersion,
      lastCheckedAt: prior.lastCheckedAt,
      update: undefined,
    };
  }

  try {
    const releasedVersion = readManifestTag(await fetchManifest());
    const update =
      releasedVersion !== undefined && isNewer(releasedVersion, currentVersion)
        ? {
            dismissed: releasedVersion === prior.dismissedVersion,
            version: releasedVersion,
          }
        : undefined;
    return {
      check: "checked",
      dismissedVersion: prior.dismissedVersion,
      lastCheckedAt: checkedAt,
      update,
    };
  } catch {
    // An unavailable or malformed manifest must never prevent normal use.
    return {
      check: "unavailable",
      dismissedVersion: prior.dismissedVersion,
      lastCheckedAt: checkedAt,
      update: undefined,
    };
  }
}

/** Records a version-specific dismissal without changing the check history. */
export function dismissUpdate({ state, version }) {
  assertStableTag(version, "version");
  return { ...normalizedState(state), dismissedVersion: version };
}
