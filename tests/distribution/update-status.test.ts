import { describe, expect, it, vi } from "vitest";
import {
  checkUpdateStatus,
  dismissUpdate,
} from "../../scripts/update-status.js";

const now = "2026-08-25T12:00:00.000Z";

describe("REQ-430: private daily update status", () => {
  it("checks a manifest without passing telemetry and exposes a newer stable release", async () => {
    const fetchManifest = vi.fn(async (...arguments_: unknown[]) => {
      expect(arguments_).toEqual([]);
      return { release: { tag: "v1.3.0" } };
    });

    await expect(
      checkUpdateStatus({ currentVersion: "v1.2.3", fetchManifest, now }),
    ).resolves.toEqual({
      check: "checked",
      dismissedVersion: undefined,
      lastCheckedAt: now,
      update: { dismissed: false, version: "v1.3.0" },
    });
    expect(fetchManifest).toHaveBeenCalledTimes(1);
  });

  it("does not fetch more than once in a day", async () => {
    const fetchManifest = vi.fn();
    const state = { lastCheckedAt: "2026-08-25T00:01:00.000Z" };

    await expect(
      checkUpdateStatus({
        currentVersion: "v1.2.3",
        fetchManifest,
        now,
        state,
      }),
    ).resolves.toMatchObject({
      check: "deferred",
      lastCheckedAt: state.lastCheckedAt,
      update: undefined,
    });
    expect(fetchManifest).not.toHaveBeenCalled();
  });

  it("allows the operator to dismiss exactly one available version", async () => {
    const state = dismissUpdate({ state: {}, version: "v1.3.0" });

    await expect(
      checkUpdateStatus({
        currentVersion: "v1.2.3",
        fetchManifest: async () => ({ release: { tag: "v1.3.0" } }),
        now,
        state,
      }),
    ).resolves.toMatchObject({
      update: { dismissed: true, version: "v1.3.0" },
    });
    await expect(
      checkUpdateStatus({
        currentVersion: "v1.2.3",
        fetchManifest: async () => ({ release: { tag: "v1.3.1" } }),
        now,
        state,
      }),
    ).resolves.toMatchObject({
      update: { dismissed: false, version: "v1.3.1" },
    });
  });

  it("fails open when a manifest cannot be read or trusted", async () => {
    await expect(
      checkUpdateStatus({
        currentVersion: "v1.2.3",
        fetchManifest: async () => Promise.reject(new Error("offline")),
        now,
      }),
    ).resolves.toMatchObject({ check: "unavailable", update: undefined });
    await expect(
      checkUpdateStatus({
        currentVersion: "v1.2.3",
        fetchManifest: async () => ({ release: { tag: "next" } }),
        now,
      }),
    ).resolves.toMatchObject({ check: "checked", update: undefined });
  });

  it("does not mistake a lower major release for an update", async () => {
    await expect(
      checkUpdateStatus({
        currentVersion: "v2.0.0",
        fetchManifest: async () => ({ release: { tag: "v1.999.999" } }),
        now,
      }),
    ).resolves.toMatchObject({ check: "checked", update: undefined });
  });
});
