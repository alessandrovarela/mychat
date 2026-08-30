import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { assertMetaEnvironmentIsolation } from "../../scripts/meta-environments.js";

const root = resolve(import.meta.dirname, "../..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");

describe("Phase 4c Meta distribution contract", () => {
  it("publishes safe guides without private setup notes", () => {
    const allowlist = JSON.parse(read("config/public-allowlist.json")) as {
      allowedFiles: string[];
    };
    expect(allowlist.allowedFiles).toEqual(
      expect.arrayContaining([
        "README.pt-BR.md",
        "docs/authentication.md",
        "docs/meta-app-setup.en.md",
        "docs/meta-environments.md",
      ]),
    );
    expect(allowlist.allowedFiles).not.toContain("docs/meta-app-setup.md");
  });

  it("aligns isolation guidance with the executable guard", () => {
    expect(read("docs/meta-environments.md")).toContain("App ID");
    expect(() =>
      assertMetaEnvironmentIsolation({
        production: {
          appId: "a",
          accountId: "p",
          callbackUrl: "https://prod.example/webhook",
          appSecret: "p",
          envFile: ".env.production",
          dataDirectory: "data/production",
        },
        test: {
          appId: "a",
          accountId: "t",
          callbackUrl: "https://test.example/webhook",
          appSecret: "t",
          envFile: ".env.test",
          dataDirectory: "data/test",
        },
      }),
    ).toThrow("share appId");
  });
});
