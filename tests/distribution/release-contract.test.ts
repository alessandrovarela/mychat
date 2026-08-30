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
      "Dockerfile",
      "docker-compose.yml",
      "docs/releasing.md",
      "docs/runtime.md",
      "scripts/public-release.js",
      "scripts/release-manifest.js",
      "scripts/verify-image.js",
    ]) {
      expect(allowlist.allowedFiles).toContain(path);
    }
    expect(allowlist.allowedDirectories).toContain(".github");
    expect(allowlist.allowedDirectories).toContain("tests");
  });
});
