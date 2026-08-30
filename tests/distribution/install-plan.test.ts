import { describe, expect, it } from "vitest";
import {
  createInstallPlan,
  detectArchitecture,
} from "../../scripts/install-plan.js";

const configuration = {
  MYCHAT_LOCALE: "pt-BR",
  MYCHAT_TIMEZONE: "America/Sao_Paulo",
  PUBLIC_ORIGIN: "https://chat.example.com",
};

describe("REQ-419: deterministic Ubuntu installation plan", () => {
  it("plans an arm64 Ubuntu LTS installation without accessing a host or collecting secrets", () => {
    const plan = createInstallPlan({
      configuration,
      consent: false,
      host: { architecture: "aarch64", id: "ubuntu", version: "24.04" },
    });

    expect(plan).toMatchObject({
      architecture: "arm64",
      host: { architecture: "arm64", id: "ubuntu", version: "24.04" },
      mode: "plan",
      networkAccessed: false,
      nextGuide: "docs/first-use.md",
    });
    expect(plan.configuration).toEqual({
      destination: ".env",
      entries: [
        "MYCHAT_LOCALE=pt-BR",
        "MYCHAT_TIMEZONE=America/Sao_Paulo",
        "PUBLIC_ORIGIN=https://chat.example.com",
      ],
      secretValuesCollected: false,
    });
    expect(plan.secrets).toMatchObject({
      generatedByOperator: true,
      keys: ["META_APP_SECRET", "WEBHOOK_VERIFY_TOKEN"],
      values: [],
    });
    expect(JSON.stringify(plan)).not.toContain("real-secret");
  });

  it("requires explicit consent before including privileged prerequisite commands", () => {
    const withheld = createInstallPlan({
      configuration,
      consent: false,
      host: { architecture: "x86_64", id: "ubuntu", version: "22.04" },
    });
    const approved = createInstallPlan({
      configuration,
      consent: true,
      host: { architecture: "amd64", id: "ubuntu", version: "22.04" },
    });

    expect(withheld.prerequisites).toMatchObject({
      consentRequired: true,
      consented: false,
      commands: [],
    });
    expect(withheld.prerequisites.deferredCommands).toContain(
      "sudo apt-get update",
    );
    expect(approved.prerequisites.commands).toContain("sudo apt-get update");
  });

  it("includes generated-secret, compose startup, health, recovery, and next-guide steps", () => {
    const plan = createInstallPlan({
      configuration,
      consent: true,
      host: { architecture: "arm64", id: "ubuntu", version: "24.04" },
    });

    expect(plan.secrets.commands).toEqual([
      "openssl rand -hex 32 # META_APP_SECRET",
      "openssl rand -hex 32 # WEBHOOK_VERIFY_TOKEN",
    ]);
    expect(plan.startup).toMatchObject({
      commands: ["docker compose pull", "docker compose up -d"],
      persistentVolume: "mychat-data",
    });
    expect(plan.health).toMatchObject({
      command: "docker compose ps --status running",
      recovery: "docker compose logs --tail=100 mychat",
    });
  });

  it("rejects unsupported hosts, architectures, implicit consent, and secret input", () => {
    expect(() => detectArchitecture("riscv64")).toThrow(
      "unsupported architecture",
    );
    expect(() =>
      createInstallPlan({
        configuration,
        consent: false,
        host: { architecture: "amd64", id: "debian", version: "12" },
      }),
    ).toThrow("Ubuntu LTS");
    expect(() =>
      createInstallPlan({
        configuration,
        consent: undefined as unknown as boolean,
        host: { architecture: "amd64", id: "ubuntu", version: "24.04" },
      }),
    ).toThrow("consent must explicitly");
    expect(() =>
      createInstallPlan({
        configuration: { ...configuration, META_APP_SECRET: "real-secret" },
        consent: true,
        host: { architecture: "amd64", id: "ubuntu", version: "24.04" },
      }),
    ).toThrow("must not contain secrets");
  });
});
