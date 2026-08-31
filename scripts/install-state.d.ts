export interface InstallationState {
  configuration: Record<string, string>;
  volumePresent: boolean;
}

export interface InstallationDecision {
  action: "awaiting_secret_confirmation" | "resume_installation";
  recovery: { command: string; resumeAt: string };
}

export function assessInstallationState(input: {
  existing: InstallationState;
  requested: { configuration: Record<string, string> };
  replaceSecrets: boolean;
}): InstallationDecision;

export function diagnoseInstallationFailure(input: {
  check: string;
  detail: string;
}): { check: string; detail: string; fix: string; resumeAt: string };
