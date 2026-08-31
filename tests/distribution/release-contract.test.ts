import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { createReleaseManifest } from "../../scripts/release-manifest.js";
import { inspectProductionImage } from "../../scripts/verify-image.js";

const projectRoot = resolve(import.meta.dirname, "../..");
const readProjectFile = (path: string) =>
  readFileSync(resolve(projectRoot, path), "utf8");

describe("distribution release contract", () => {
  it("keeps the published runtime, Compose entrypoint, and release manifest aligned", () => {
    const dockerfile = readProjectFile("Dockerfile");
    const compose = readProjectFile("docker-compose.yml");
    const manifest = createReleaseManifest({
      createdAt: "2026-08-25T03:00:00.000Z",
      repository: "alessandrovarela/mychat",
      revision: "a".repeat(40),
      tag: "v1.2.3",
    });

    expect(inspectProductionImage(dockerfile)).toEqual({
      forbidden: [],
      missing: [],
    });
    expect(manifest.image).toBe("ghcr.io/alessandrovarela/mychat:v1.2.3");
    expect(compose).toContain("image: ghcr.io/alessandrovarela/mychat:latest");
    expect(compose).toMatch(/^\s+- mychat-data:\/var\/lib\/mychat$/m);
  });

  it("keeps every distribution artifact in the public allow-list", () => {
    const allowlist = JSON.parse(
      readProjectFile("config/public-allowlist.json"),
    ) as { allowedFiles: string[]; allowedDirectories: string[] };

    for (const path of [
      ".dockerignore",
      ".prettierignore",
      "Dockerfile",
      "docker-compose.yml",
      "docs/first-use.md",
      "docs/hosting.md",
      "docs/installing.md",
      "docs/operations.en.md",
      "docs/operations.pt-BR.md",
      "docs/releasing.md",
      "docs/runtime.md",
      "docs/updating.md",
      "scripts/first-use.js",
      "scripts/first-use.d.ts",
      "scripts/install-plan.js",
      "scripts/install-plan.d.ts",
      "scripts/install-state.js",
      "scripts/install-state.d.ts",
      "scripts/meta-environments.js",
      "scripts/meta-environments.d.ts",
      "scripts/public-release.js",
      "scripts/release-manifest.js",
      "scripts/update-panel.js",
      "scripts/update-panel.d.ts",
      "scripts/update-plan.js",
      "scripts/update-plan.d.ts",
      "scripts/update-status.js",
      "scripts/update-status.d.ts",
      "scripts/verify-image.js",
    ]) {
      expect(allowlist.allowedFiles).toContain(path);
    }
    expect(allowlist.allowedDirectories).toContain(".github");
    expect(allowlist.allowedDirectories).toContain("tests");
  });
});
