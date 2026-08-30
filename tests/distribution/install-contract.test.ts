import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { createInstallPlan } from "../../scripts/install-plan.js";
import { assessInstallationState } from "../../scripts/install-state.js";
import { createFirstUseStatus } from "../../scripts/first-use.js";

const projectRoot = resolve(import.meta.dirname, "../..");

describe("Phase 4b installation contract", () => {
  it("keeps the plan, rerun decision, and first use aligned on a safe local path", () => {
    const plan = createInstallPlan({
      configuration: {
        MYCHAT_LOCALE: "pt-BR",
        MYCHAT_TIMEZONE: "America/Toronto",
        PUBLIC_ORIGIN: "https://chat.example.com",
      },
      consent: false,
      host: { architecture: "arm64", id: "ubuntu", version: "24.04" },
    });
    const rerun = assessInstallationState({
      existing: {
        configuration: {
          META_APP_SECRET: "kept",
          WEBHOOK_VERIFY_TOKEN: "kept",
        },
        volumePresent: true,
      },
      requested: { configuration: { MYCHAT_LOCALE: "pt-BR" } },
      replaceSecrets: false,
    });

    expect(plan.networkAccessed).toBe(false);
    expect(plan.nextGuide).toBe("docs/first-use.md");
    expect(rerun).toMatchObject({
      action: "resume_installation",
      secrets: { preserved: ["META_APP_SECRET", "WEBHOOK_VERIFY_TOKEN"] },
      volume: { preserved: true },
    });
    expect(createFirstUseStatus()).toMatchObject({
      status: "local-draft",
      next: { phase: "4e" },
    });
  });

  it("documents the safe contract and points each operating concern to its guide", () => {
    const guide = readFileSync(
      resolve(projectRoot, "docs/installing.md"),
      "utf8",
    );

    for (const expected of [
      "Ubuntu LTS 22.04 ou 24.04",
      "amd64",
      "arm64",
      "sem efeitos colaterais",
      "não acessa a rede",
      "mychat-data",
      "secret-confirmation",
      "compose-start",
      "first-use.md",
      "operations.pt-BR.md",
      "operations.en.md",
      "hosting.md",
      "Fase 4e",
      "/webhook",
    ]) {
      expect(guide).toContain(expected);
    }
  });
});
