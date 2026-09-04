import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const projectRoot = resolve(import.meta.dirname, "../..");
const readDocument = (path: string) =>
  readFileSync(resolve(projectRoot, path), "utf8");

describe("REQ-424: bilingual illustrated Meta setup tutorial", () => {
  it("keeps the pt-BR canonical guide complete, safe, and illustrated", () => {
    const tutorial = readDocument("docs/meta-app-setup.md");

    for (const requirement of [
      "Antes de começar: domínio, HTTPS e instalação",
      "Criar o app e escolher o caso de uso",
      "Adicionar as permissões do Instagram Login",
      "Associar e aceitar a conta testadora",
      "Gerar o token e guardar as credenciais",
      "Validar a conta no MyChat antes do webhook",
      "Cadastrar e verificar o callback HTTPS",
      "Testar comentários antes de assinar a conta",
      "Ativar a assinatura dos eventos",
      "Publicar o app em modo Live",
      "Fazer a prova real da automação",
      "Diagnóstico de erros comuns",
      "META_ACCESS_TOKEN=<token-gerado-pela-meta>",
      "META_APP_SECRET=<segredo-do-app-instagram>",
      "INSTAGRAM_ACCOUNT_ID=<id-da-conta-profissional>",
      "WEBHOOK_VERIFY_TOKEN=<token-aleatorio-de-verificacao>",
      "Instagram Tester",
      "Webhook subscription",
      "política de privacidade",
      "app-published-success.png",
    ]) {
      expect(tutorial).toContain(requirement);
    }

    const imageReferences = [
      ...tutorial.matchAll(/\]\((images\/meta-app-setup\/[^)]+\.png)\)/g),
    ]
      .map((match) => match[1])
      .filter((reference): reference is string => reference !== undefined);
    expect(imageReferences.length).toBeGreaterThan(20);
    for (const reference of imageReferences) {
      expect(existsSync(resolve(projectRoot, "docs", reference))).toBe(true);
    }
  });

  it("keeps the English guide available as the parallel public reference", () => {
    const tutorial = readDocument("docs/meta-app-setup.en.md");

    for (const requirement of [
      "Before you begin",
      "Create the app",
      "Privacy Policy",
      "Instagram Tester",
      "Webhook subscription",
      "Live mode",
      "real automation test",
      "Troubleshooting",
      "META_APP_SECRET=<",
      "/webhook",
    ]) {
      expect(tutorial.toLowerCase()).toContain(requirement.toLowerCase());
    }
  });

  it("makes a real event, execution, and result the proof", () => {
    const tutorial = readDocument("docs/meta-app-setup.md");

    expect(tutorial).toContain("a Meta enviou o evento ao callback HTTPS");
    expect(tutorial).toContain("o MyChat registrou e executou a automação");
    expect(tutorial).toContain(
      "a ação configurada foi concluída conforme esperado",
    );
  });

  it("keeps development topology and a second account out of the public guide", () => {
    for (const path of [
      "docs/meta-app-setup.md",
      "docs/meta-app-setup.en.md",
    ]) {
      const tutorial = readDocument(path).toLowerCase();
      expect(tutorial).not.toContain("segunda conta");
      expect(tutorial).not.toContain("second account");
      expect(tutorial).not.toContain("local tunnel");
      expect(tutorial).not.toContain("usuário de sistema");
      expect(tutorial).not.toContain("system user");
    }
  });

  it("keeps the public entry points and every referenced image on the allowlist", () => {
    const readme = readDocument("README.md");
    const allowlist = JSON.parse(
      readDocument("config/public-allowlist.json"),
    ) as { allowedFiles: string[] };
    const ptBrTutorial = readDocument("docs/meta-app-setup.md");

    expect(readme).toContain(
      "[pt-BR Meta setup guide](docs/meta-app-setup.md)",
    );
    expect(readme).toContain(
      "[English Meta setup guide](docs/meta-app-setup.en.md)",
    );
    expect(allowlist.allowedFiles).toEqual(
      expect.arrayContaining([
        "docs/meta-app-setup.md",
        "docs/meta-app-setup.en.md",
      ]),
    );

    for (const [, reference] of ptBrTutorial.matchAll(
      /\]\((images\/meta-app-setup\/[^)]+\.png)\)/g,
    )) {
      expect(allowlist.allowedFiles).toContain(`docs/${reference}`);
    }
  });
});
