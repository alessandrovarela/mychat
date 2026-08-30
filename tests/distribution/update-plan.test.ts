import { describe, expect, it } from "vitest";
import { createUpdatePlan } from "../../scripts/update-plan.js";

const localAuth = { authenticated: true, kind: "local" } as const;
const currentRelease = {
  digest:
    "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  digestVerified: true,
  version: "1.0.0",
} as const;
const targetRelease = {
  digest:
    "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  digestVerified: true,
  version: "1.1.0",
} as const;

describe("REQ-428: deterministic, recoverable update and rollback plans", () => {
  it("plans every update operation and ordered recovery with explicit releases", () => {
    const plan = createUpdatePlan({
      command: "update",
      currentRelease,
      localAuth,
      targetRelease,
    });

    expect(plan).toMatchObject({
      command: "update",
      currentRelease,
      mode: "plan",
      networkAccessed: false,
      targetRelease,
    });
    expect(plan.steps.map(({ id }) => id)).toEqual([
      "preflight",
      "backup",
      "sync",
      "configure",
      "pull",
      "migrate",
      "restart",
      "health",
    ]);
    expect(plan.failureRecovery.map(({ id }) => id)).toEqual([
      "stop",
      "restore",
      "configure-previous",
      "pull-previous",
      "restart-previous",
      "health-previous",
    ]);
    expect(plan.steps[3]?.command).toContain(
      "ghcr.io/alessandrovarela/mychat:1.1.0@sha256:bbbb",
    );
    expect(plan.failureRecovery[2]?.command).toContain(
      "ghcr.io/alessandrovarela/mychat:1.0.0@sha256:aaaa",
    );
  });

  it("uses the same recovery-safe sequence when a prior explicit release is selected", () => {
    const plan = createUpdatePlan({
      command: "rollback",
      currentRelease: targetRelease,
      localAuth,
      targetRelease: currentRelease,
    });

    expect(plan.command).toBe("rollback");
    expect(plan.steps.map(({ id }) => id)).toEqual([
      "preflight",
      "backup",
      "sync",
      "configure",
      "pull",
      "migrate",
      "restart",
      "health",
    ]);
    expect(plan.failureRecovery[1]).toMatchObject({ id: "restore" });
  });
});

describe("REQ-429: local authentication and immutable authenticated releases", () => {
  it("reports the installed version only after local authentication", () => {
    const plan = createUpdatePlan({
      command: "version",
      currentRelease,
      localAuth,
    });

    expect(plan).toEqual({
      authentication: localAuth,
      command: "version",
      currentRelease,
      mode: "plan",
      networkAccessed: false,
      steps: [],
    });
  });

  it("refuses before planning without local authentication", () => {
    expect(() =>
      createUpdatePlan({
        command: "update",
        currentRelease,
        localAuth: { authenticated: false, kind: "local" },
        targetRelease,
      }),
    ).toThrow("local authentication is required");
  });

  it("refuses latest, prerelease, missing digest, unauthenticated digest, and implicit releases", () => {
    expect(() =>
      createUpdatePlan({
        command: "update",
        currentRelease,
        localAuth,
        targetRelease: { ...targetRelease, version: "latest" },
      }),
    ).toThrow("explicit stable version");
    expect(() =>
      createUpdatePlan({
        command: "update",
        currentRelease,
        localAuth,
        targetRelease: { ...targetRelease, version: "1.1.0-rc.1" },
      }),
    ).toThrow("explicit stable version");
    expect(() =>
      createUpdatePlan({
        command: "update",
        currentRelease,
        localAuth,
        targetRelease: { ...targetRelease, digest: "" },
      }),
    ).toThrow("immutable sha256 digest");
    expect(() =>
      createUpdatePlan({
        command: "update",
        currentRelease,
        localAuth,
        targetRelease: { ...targetRelease, digestVerified: false },
      }),
    ).toThrow("digest must be authenticated");
    expect(() =>
      createUpdatePlan({
        command: "update",
        currentRelease,
        localAuth,
        targetRelease: undefined as never,
      }),
    ).toThrow("targetRelease must be an object");
  });
});
