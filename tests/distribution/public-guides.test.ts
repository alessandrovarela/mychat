import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const projectRoot = resolve(import.meta.dirname, "../..");
const readDocument = (path: string) =>
  readFileSync(resolve(projectRoot, path), "utf8");

describe("REQ-076: bilingual public installation and first-use guides", () => {
  const guides = ["README.md", "README.pt-BR.md"] as const;

  it.each(guides)(
    "%s covers a safe install and both first-use outcomes",
    (path) => {
      const guide = readDocument(path);

      for (const expected of [
        "docker compose up -d",
        "mychat-data",
        ".env",
        "META_APP_SECRET",
        "WEBHOOK_VERIFY_TOKEN",
        "Meta",
      ]) {
        expect(guide).toContain(expected);
      }
      expect(guide).toContain(
        path === "README.md" ? "second account" : "segunda conta",
      );
      expect(guide).toContain(path === "README.md" ? "Phase 4e" : "Fase 4e");
      expect(guide).toContain(path === "README.md" ? "draft" : "rascunho");
    },
  );

  it("does not treat a local draft as proof of a Meta delivery", () => {
    const english = readDocument("README.md").toLowerCase();
    expect(english).toContain("not evidence");
    expect(english).toContain("sends nothing to meta");

    const portuguese = readDocument("README.pt-BR.md").toLowerCase();
    expect(portuguese).toContain("ele prova só");
    expect(portuguese).toContain("não envia nada à meta");
  });
});

describe("REQ-089: documented Meta authentication paths", () => {
  it("names the distinct prerequisites, hosts, permissions, and token models", () => {
    const guide = readDocument("docs/authentication.md").replace(/\s+/g, " ");

    for (const expected of [
      "Instagram Login",
      "System user",
      "business portfolio",
      "graph.instagram.com",
      "graph.facebook.com",
      "instagram_business_manage_comments",
      "instagram_manage_comments",
      "60 days",
      "Does not expire",
      "PlatformAccount",
    ]) {
      expect(guide).toContain(expected);
    }
  });

  it("keeps credentials masked and preserves the public webhook boundary", () => {
    const guide = readDocument("docs/authentication.md").replace(/\s+/g, " ");

    expect(guide).toContain("<masked-token>");
    expect(guide).toContain("Never put an access token");
    expect(guide).toContain("`/webhook` must remain public");
    expect(guide).toContain("explicit `/webhook` bypass");
    expect(guide).toContain("own HTTPS address");
  });
});
