import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { createReleaseManifest } from "../../scripts/release-manifest.js";

const projectRoot = resolve(import.meta.dirname, "../..");
const workflow = readFileSync(
  resolve(projectRoot, ".github/workflows/release.yml"),
  "utf8",
);

describe("release manifest", () => {
  it("records the stable multiarch image and its immutable source revision", () => {
    expect(
      createReleaseManifest({
        createdAt: "2026-08-25T03:00:00.000Z",
        repository: "acme/mychat",
        revision: "a".repeat(40),
        tag: "v1.2.3",
      }),
    ).toEqual({
      image: "ghcr.io/acme/mychat:v1.2.3",
      platforms: ["linux/amd64", "linux/arm64"],
      provenance: {
        revision: "a".repeat(40),
        source: "https://github.com/acme/mychat",
      },
      release: { createdAt: "2026-08-25T03:00:00.000Z", tag: "v1.2.3" },
      schemaVersion: 1,
    });
  });

  it("rejects unstable tags and incomplete release identity", () => {
    expect(() =>
      createReleaseManifest({
        createdAt: "2026-08-25T03:00:00.000Z",
        repository: "acme/mychat",
        revision: "a".repeat(40),
        tag: "v1.2.3-rc.1",
      }),
    ).toThrow("stable");
    expect(() =>
      createReleaseManifest({
        createdAt: "not-a-date",
        repository: "acme/mychat",
        revision: "short",
        tag: "v1.2.3",
      }),
    ).toThrow("revision");
  });

  it("ships only stable tags through an authenticated multiarch release workflow", () => {
    for (const expected of [
      'tags:\n      - "v[0-9]+.[0-9]+.[0-9]+"',
      "docker/login-action@v4",
      "docker/build-push-action@v7",
      "platforms: linux/amd64,linux/arm64",
      "push: true",
      "provenance: mode=max",
      "actions/attest-build-provenance@v3",
      "gh release create",
    ]) {
      expect(workflow).toContain(expected);
    }
    expect(workflow).not.toContain("pull_request:");
  });
});
