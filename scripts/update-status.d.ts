export interface UpdateStatusState {
  dismissedVersion?: string;
  lastCheckedAt?: string;
}

export interface UpdateStatus {
  check: "checked" | "deferred" | "unavailable";
  dismissedVersion?: string;
  lastCheckedAt: string;
  update?: { dismissed: boolean; version: string };
}

/**
 * Reads a release manifest at most once per day. `fetchManifest` has no
 * parameters, so the status check cannot carry instance telemetry.
 */
export function checkUpdateStatus(input: {
  currentVersion: string;
  fetchManifest: () => Promise<unknown>;
  now: string;
  state?: UpdateStatusState;
}): Promise<UpdateStatus>;

export function dismissUpdate(input: {
  state?: UpdateStatusState;
  version: string;
}): UpdateStatusState;
