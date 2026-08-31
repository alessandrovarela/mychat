export type Architecture = "amd64" | "arm64";

export interface InstallPlan {
  architecture: Architecture;
  configuration: {
    destination: ".env";
    entries: string[];
    secretValuesCollected: false;
  };
  host: {
    architecture: Architecture;
    id: "ubuntu";
    version: "22.04" | "24.04";
  };
  mode: "plan";
  networkAccessed: false;
  prerequisites: {
    consentRequired: true;
    consented: boolean;
    commands: string[];
    deferredCommands: string[];
  };
  secrets: {
    destination: ".env";
    generatedByOperator: true;
    keys: ["META_APP_SECRET", "WEBHOOK_VERIFY_TOKEN"];
    commands: string[];
    values: [];
  };
  startup: {
    commands: ["docker compose pull", "docker compose up -d"];
    composeFile: "docker-compose.yml";
    persistentVolume: "mychat-data";
  };
  health: { command: string; expected: string; recovery: string };
  nextGuide: "docs/first-use.md";
}

export const SUPPORTED_UBUNTU_LTS: string[];
export const SUPPORTED_ARCHITECTURES: Architecture[];

export function detectArchitecture(architecture: unknown): Architecture;
export function createInstallPlan(input: {
  configuration: Record<string, string>;
  consent: boolean;
  host: { architecture: unknown; id: string; version: string };
}): InstallPlan;
