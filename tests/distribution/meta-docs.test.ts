import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const projectRoot = resolve(import.meta.dirname, "../..");
const readDocument = (path: string) =>
  readFileSync(resolve(projectRoot, path), "utf8");

describe("REQ-424: bilingual illustrated Meta setup tutorial", () => {
  const tutorials = [
    [
      "docs/meta-app-setup.md",
      [
        "O que você vai precisar",
        "Criar o app",
        "permissões",
        "Política de Privacidade",
        "META_APP_SECRET=<",
        "/webhook",
        "Testador do Instagram",
        "Assinatura do webhook",
        "modo Live",
        "outra conta",
        "Armadilha",
        "[captura]",
      ],
    ],
    [
      "docs/meta-app-setup.en.md",
      [
        "Before you begin",
        "Create the app",
        "permissions",
        "Privacy Policy",
        "META_APP_SECRET=<",
        "/webhook",
        "Instagram Tester",
        "Webhook subscription",
        "Live mode",
        "second account",
        "Troubleshooting",
        "[screenshot:",
      ],
    ],
  ] as const;

  for (const [path, requirements] of tutorials) {
    it(`${path} covers the complete safe Meta setup`, () => {
      const tutorial = readDocument(path);

      for (const requirement of requirements) {
        expect(tutorial.toLowerCase()).toContain(requirement.toLowerCase());
      }
      expect(tutorial).toMatch(/META_ACCESS_TOKEN=<[^>\n]+>/);
      expect(tutorial).toMatch(/META_APP_SECRET=<[^>\n]+>/);
    });
  }

  it("makes a second-account event, execution, and result the proof", () => {
    const tutorial = readDocument("docs/meta-app-setup.en.md");

    expect(tutorial).toContain("Meta sent an event");
    expect(tutorial).toContain("executed the automation");
    expect(tutorial).toContain("second account received");
  });
});
