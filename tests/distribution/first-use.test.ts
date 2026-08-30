import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createFirstUseStatus,
  firstUseGuide,
} from "../../scripts/first-use.js";

const projectRoot = resolve(import.meta.dirname, "../..");

describe("first-use guidance", () => {
  it("keeps a no-Meta journey honestly local and saved as a draft", () => {
    expect(createFirstUseStatus()).toMatchObject({
      automation: "saved-draft",
      meta: "not-configured",
      status: "local-draft",
      next: {
        phase: "4e",
        status: "deferred-external-verification",
      },
    });
  });

  it("does not treat Meta configuration as verification without a second account", () => {
    const guide = firstUseGuide();

    expect(createFirstUseStatus({ metaConfigured: true })).toMatchObject({
      automation: "saved-draft",
      meta: "configured",
      status: "awaiting-external-verification",
      next: { phase: "4e" },
    });
    expect(guide.local.doesNotProve).toEqual([
      "Meta received an event",
      "the automation executed from a Meta event",
      "a second account received the result",
    ]);
    expect(guide.real.expectedStatus.next.requires).toEqual(
      expect.arrayContaining([
        "a separate test account",
        "received event evidence",
        "execution evidence",
        "result evidence",
      ]),
    );
  });

  it("documents both paths and explicitly defers the external proof to phase 4e", () => {
    const document = readFileSync(
      resolve(projectRoot, "docs/first-use.md"),
      "utf8",
    );

    for (const expected of [
      "sem Meta",
      "rascunho local",
      "segunda conta",
      "Fase 4e",
      "recebimento do evento",
      "execução da automação",
      "resultado recebido",
    ]) {
      expect(document).toContain(expected);
    }
  });

  it("rejects an ambiguous Meta configuration value", () => {
    expect(() =>
      createFirstUseStatus({ metaConfigured: "yes" as never }),
    ).toThrow("metaConfigured must be a boolean");
  });
});
