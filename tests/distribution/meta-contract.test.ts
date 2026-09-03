import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { assertMetaEnvironmentIsolation } from "../../scripts/meta-environments.js";

const root = resolve(import.meta.dirname, "../..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");

describe("Phase 4c Meta distribution contract", () => {
  it("publishes both safe guides without the private topology note", () => {
    const allowlist = JSON.parse(read("config/public-allowlist.json")) as {
      allowedFiles: string[];
    };
    expect(allowlist.allowedFiles).toEqual(
      expect.arrayContaining([
        "README.pt-BR.md",
        "docs/authentication.md",
        "docs/meta-app-setup.md",
        "docs/meta-app-setup.en.md",
      ]),
    );
    expect(allowlist.allowedFiles).not.toContain("docs/meta-environments.md");

    for (const path of [
      "README.md",
      "docs/meta-app-setup.md",
      "docs/meta-app-setup.en.md",
    ]) {
      const document = read(path);
      expect(document).not.toContain("mychat.crivo.digital");
      expect(document).not.toContain("mychat-local.crivo.digital");
      expect(document).not.toContain("mychat-production");
      expect(document).not.toContain("mychat-test");
    }
  });

  it("aligns isolation guidance with the executable guard", () => {
    expect(read("docs/meta-environments.md")).toContain("App ID");
    expect(() =>
      assertMetaEnvironmentIsolation({
        production: {
          appId: "production-app",
          accountId: "production-account",
          callbackUrl: "https://prod.example/webhook",
          appSecret: "production-configured",
          envFile: ".env.production",
          dataDirectory: "data/production",
        },
        test: {
          appId: "production-app",
          accountId: "test-account",
          callbackUrl: "https://test.example/webhook",
          appSecret: "test-configured",
          envFile: ".env.test",
          dataDirectory: "data/test",
        },
      }),
    ).toThrow("share appId");
  });

  it("records the real topology and keeps secrets outside the reference", () => {
    const document = read("docs/meta-environments.md");

    for (const required of [
      "https://mychat.crivo.digital",
      "https://mychat-local.crivo.digital/webhook",
      "OVHcloud",
      "AMD64",
      "mychat-local",
      "mychat-production",
      "mychat-test",
      "App Meta",
      "Conta Instagram",
      "Dados persistidos",
      "Checklist de verificação",
      "As duas rotas `/webhook` precisam permanecer públicas",
      "O domínio da produção nunca aponta para o túnel local",
    ]) {
      expect(document).toContain(required);
    }

    for (const forbidden of [
      "META_ACCESS_TOKEN=",
      "META_APP_SECRET=",
      "WEBHOOK_VERIFY_TOKEN=",
      "AWS_ACCESS_KEY_ID=",
      "AWS_SECRET_ACCESS_KEY=",
      "-----BEGIN",
      "ssh-rsa ",
      "ssh-ed25519 ",
    ]) {
      expect(document).not.toContain(forbidden);
    }

    expect(document).not.toMatch(
      /mychat\.crivo\.digital[^\n]*(?:mychat-local|localhost)/i,
    );
  });
});
