import { describe, expect, it } from "vitest";
import {
  assessInstallationState,
  diagnoseInstallationFailure,
} from "../../scripts/install-state.js";

const existing = {
  configuration: {
    META_APP_SECRET: "kept-secret",
    MYCHAT_LOCALE: "pt-BR",
    WEBHOOK_VERIFY_TOKEN: "kept-token",
  },
  volumePresent: true,
};

describe("REQ-420: installation reexecution and recovery", () => {
  it("preserves existing configuration, secrets, and volumes by default", () => {
    const decision = assessInstallationState({
      existing,
      requested: { configuration: { MYCHAT_TIMEZONE: "America/Toronto" } },
      replaceSecrets: false,
    });

    expect(decision).toMatchObject({
      action: "resume_installation",
      secrets: {
        preserved: ["META_APP_SECRET", "WEBHOOK_VERIFY_TOKEN"],
        replaced: false,
      },
      volume: { preserved: true },
      recovery: { command: "docker compose up -d", resumeAt: "compose-start" },
    });
  });

  it("requires explicit confirmation before replacing existing secrets", () => {
    const requested = { configuration: { META_APP_SECRET: "replacement" } };
    const waiting = assessInstallationState({
      existing,
      requested,
      replaceSecrets: false,
    });
    const approved = assessInstallationState({
      existing,
      requested,
      replaceSecrets: true,
    });

    expect(waiting).toMatchObject({
      action: "awaiting_secret_confirmation",
      preserved: {
        configuration: true,
        volume: true,
        secrets: ["META_APP_SECRET", "WEBHOOK_VERIFY_TOKEN"],
      },
      recovery: { resumeAt: "secret-confirmation" },
    });
    expect(approved).toMatchObject({
      action: "resume_installation",
      secrets: { preserved: [], replaced: true },
    });
  });

  it("names a failed check, its correction, and deterministic resume point", () => {
    expect(
      diagnoseInstallationFailure({
        check: "permissions",
        detail: "docker socket denied",
      }),
    ).toEqual({
      check: "permissions",
      detail: "docker socket denied",
      fix: "add the operator to the docker group, sign in again, then rerun the installer",
      resumeAt: "prerequisites",
    });
  });

  it("rejects malformed state and implicit secret replacement", () => {
    expect(() =>
      assessInstallationState({
        existing,
        requested: { configuration: {} },
        replaceSecrets: undefined as unknown as boolean,
      }),
    ).toThrow("replaceSecrets must explicitly");
    expect(() =>
      assessInstallationState({
        existing: {
          ...existing,
          volumePresent: "yes",
        } as unknown as typeof existing,
        requested: { configuration: {} },
        replaceSecrets: false,
      }),
    ).toThrow("volumePresent must be a boolean");
  });
});
