import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const composeUrl = new URL("../../docker-compose.yml", import.meta.url);
const exampleUrl = new URL("../../.env.example", import.meta.url);

function compose(): string {
  return readFileSync(composeUrl, "utf8");
}

describe("REQ-042: published Compose runtime", () => {
  it("uses a published image and never a local build", () => {
    const source = compose();

    expect(source).toContain("image: ghcr.io/alessandrovarela/mychat:latest");
    expect(source).not.toMatch(/^\s*build:/m);
    expect(source).toContain("env_file:");
    expect(source).toContain("- .env");
  });

  it("documents the environment file consumed by Compose", () => {
    const example = readFileSync(exampleUrl, "utf8");

    expect(example).toContain("Docker Compose reads this");
    expect(example).toContain("META_APP_SECRET=");
    expect(example).toContain("WEBHOOK_VERIFY_TOKEN=");
  });
});

describe("REQ-043: durable runtime state", () => {
  it("keeps database and disk storage in a named volume outside the image", () => {
    const source = compose();

    expect(source).toContain("DATABASE_PATH: /var/lib/mychat/mychat.db");
    expect(source).toContain("ASSETS_DIR: /var/lib/mychat/assets");
    expect(source).toContain("THUMBNAILS_DIR: /var/lib/mychat/thumbs");
    expect(source).toMatch(/^\s+- mychat-data:\/var\/lib\/mychat$/m);
    expect(source).toMatch(/^volumes:\n {2}mychat-data:/m);
  });
});
