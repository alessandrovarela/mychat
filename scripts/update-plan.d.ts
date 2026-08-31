export type UpdateCommand = "version" | "update" | "rollback";

export interface AuthenticatedRelease {
  version: string;
  digest: `sha256:${string}`;
  digestVerified: true;
}

export interface LocalUpdateAuthentication {
  kind: "local";
  authenticated: true;
}

export interface UpdatePlanStep {
  id: string;
  command: string;
  purpose: string;
}

export interface VersionPlan {
  authentication: LocalUpdateAuthentication;
  command: "version";
  currentRelease: AuthenticatedRelease;
  mode: "plan";
  networkAccessed: false;
  steps: readonly [];
}

export interface ReleaseOperationPlan {
  authentication: LocalUpdateAuthentication;
  command: "update" | "rollback";
  currentRelease: AuthenticatedRelease;
  failureRecovery: readonly UpdatePlanStep[];
  mode: "plan";
  networkAccessed: false;
  steps: readonly UpdatePlanStep[];
  targetRelease: AuthenticatedRelease;
}

export type UpdatePlan = VersionPlan | ReleaseOperationPlan;

/** Input is deliberately broad because the runtime rejects untrusted CLI data. */
export interface UpdatePlanInput {
  command: unknown;
  currentRelease: unknown;
  localAuth: unknown;
  targetRelease?: unknown;
}

export const UPDATE_COMMANDS: readonly UpdateCommand[];

export function createUpdatePlan(input: {
  command: "version";
  currentRelease: AuthenticatedRelease;
  localAuth: LocalUpdateAuthentication;
  targetRelease?: never;
}): VersionPlan;
export function createUpdatePlan(input: {
  command: "update" | "rollback";
  currentRelease: AuthenticatedRelease;
  localAuth: LocalUpdateAuthentication;
  targetRelease: AuthenticatedRelease;
}): ReleaseOperationPlan;
export function createUpdatePlan(input: UpdatePlanInput): UpdatePlan;
