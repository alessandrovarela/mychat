import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const projectRoot = resolve(import.meta.dirname, "../..");
const readDocument = (path: string) =>
  readFileSync(resolve(projectRoot, path), "utf8");

describe("REQ-423: documented hosting comparison", () => {
  it("compares non-mandatory providers using official sources and a consulted date", () => {
    const hosting = readDocument("docs/hosting.md");

    expect(hosting).toContain("consultadas em **2026-08-25**");
    expect(hosting).toContain("https://www.hetzner.com/cloud/");
    expect(hosting).toContain("https://www.digitalocean.com/pricing/droplets");
    expect(hosting).toContain("https://www.oracle.com/cloud/price-list/");
    for (const criterion of [
      "Preço",
      "Regiões",
      "arquitetura",
      "Armazenamento",
      "backup",
      "Facilidade",
    ]) {
      expect(hosting).toContain(criterion);
    }
    expect(hosting).toContain("nenhum é obrigatório");
    expect(hosting).toContain("Fase 4e");
  });
});

describe("REQ-427: bilingual recoverable operations", () => {
  const documents = [
    [
      "docs/operations.pt-BR.md",
      "Pré-condições",
      "Resultado esperado",
      "Recuperação",
      "Fase 4e",
      ["HTTPS", "R2", "Litestream", "restauração", "rollback", "Diagnóstico"],
    ],
    [
      "docs/operations.en.md",
      "Prerequisites",
      "Expected outcome",
      "Recovery",
      "Phase 4e",
      ["HTTPS", "R2", "Litestream", "restore", "rollback", "Diagnostics"],
    ],
  ] as const;

  for (const [
    path,
    prerequisites,
    expected,
    recovery,
    deferred,
    operations,
  ] of documents) {
    it(`${path} documents every operation with a safe recovery path`, () => {
      const guide = readDocument(path);

      for (const operation of operations) {
        expect(guide.toLowerCase()).toContain(operation.toLowerCase());
      }
      expect(guide).toContain(prerequisites);
      expect(guide).toContain(expected);
      expect(guide).toContain(recovery);
      expect(guide).toContain(deferred);
    });
  }
});
