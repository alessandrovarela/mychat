import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { createUpdatePlan } from "../../scripts/update-plan.js";
import { createUpdatePanel } from "../../scripts/update-panel.js";

const root = resolve(import.meta.dirname, "../..");
const release = (version: string) => ({
  version,
  digest: `sha256:${"a".repeat(64)}`,
  digestVerified: true,
});
const auth = { kind: "local" as const, authenticated: true };

describe("Phase 4d update contract", () => {
  it("keeps terminal and panel on one authenticated recovery path", async () => {
    const input = {
      command: "update" as const,
      localAuth: auth,
      currentRelease: release("1.0.0"),
      targetRelease: release("1.1.0"),
    };
    const plan = createUpdatePlan(input);
    if (plan.command !== "update") throw new Error("expected update plan");
    const panel = (await createUpdatePanel({
      stateStore: { append: () => undefined },
    }).requestUpdate(input)) as typeof plan;
    expect(plan.steps).toEqual(panel.steps);
    expect(plan.steps.map((step) => step.id)).toContain("backup");
    expect(plan.failureRecovery.map((step) => step.id)).toContain("restore");
  });

  it("documents recovery and private daily checks", () => {
    const guide = readFileSync(resolve(root, "docs/updating.md"), "utf8");
    for (const text of [
      "digest",
      "preflight",
      "backup",
      "reautenticação",
      "uma vez por dia",
      "telemetria",
      "Fase 4e",
    ])
      expect(guide).toContain(text);
  });
});
