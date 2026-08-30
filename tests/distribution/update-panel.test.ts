import { describe, expect, it } from "vitest";
import { createUpdatePanel } from "../../scripts/update-panel.js";
import type { UpdatePanelRequest } from "../../scripts/update-panel.js";

const currentRelease = {
  digest: "sha256:" + "a".repeat(64),
  digestVerified: true,
  version: "v1.0.0",
};
const targetRelease = {
  digest: "sha256:" + "b".repeat(64),
  digestVerified: true,
  version: "v1.1.0",
};
const localAuth = { authenticated: true, kind: "local" };

describe("authenticated update panel", () => {
  it("reuses the restricted terminal operation after local reauthentication and persists its progress", async () => {
    const persisted: unknown[] = [];
    const calls: unknown[] = [];
    const terminalOperation = async (request: UpdatePanelRequest) => {
      calls.push(request);
      return { state: "completed", steps: ["preflight", "backup"] };
    };
    const panel = createUpdatePanel({
      stateStore: {
        append: async (entry) => {
          persisted.push(entry);
        },
      },
      terminalOperation,
    });

    await expect(
      panel.requestUpdate({ currentRelease, localAuth, targetRelease }),
    ).resolves.toEqual({ state: "completed", steps: ["preflight", "backup"] });
    expect(calls).toEqual([
      { command: "update", currentRelease, localAuth, targetRelease },
    ]);
    expect(persisted).toEqual([
      { operation: "update", state: "running" },
      {
        operation: "update",
        result: { state: "completed", steps: ["preflight", "backup"] },
        state: "completed",
      },
    ]);
  });

  it("refuses a panel session without fresh local authentication before recording or operating", async () => {
    const persisted: unknown[] = [];
    const calls: unknown[] = [];
    const panel = createUpdatePanel({
      stateStore: {
        append: (entry) => {
          persisted.push(entry);
        },
      },
      terminalOperation: (request) => {
        calls.push(request);
      },
    });

    await expect(
      panel.requestUpdate({
        currentRelease,
        localAuth: { authenticated: false, kind: "local" },
        targetRelease,
      }),
    ).rejects.toThrow("reauthentication");
    expect(calls).toEqual([]);
    expect(persisted).toEqual([]);
  });

  it("persists a terminal reversal and failure so a reopened panel can report the result", async () => {
    const persisted: unknown[] = [];
    const panel = createUpdatePanel({
      stateStore: {
        append: (entry) => {
          persisted.push(entry);
        },
      },
      terminalOperation: async () => ({
        state: "reverted",
        reason: "health check failed",
      }),
    });

    await panel.requestUpdate({ currentRelease, localAuth, targetRelease });
    expect(persisted.at(-1)).toEqual({
      operation: "update",
      result: { reason: "health check failed", state: "reverted" },
      state: "reverted",
    });

    const failureStore: unknown[] = [];
    const failingPanel = createUpdatePanel({
      stateStore: {
        append: (entry) => {
          failureStore.push(entry);
        },
      },
      terminalOperation: () => {
        throw new Error("backup unavailable");
      },
    });
    await expect(
      failingPanel.requestUpdate({ currentRelease, localAuth, targetRelease }),
    ).rejects.toThrow("backup unavailable");
    expect(failureStore.at(-1)).toEqual({
      error: "backup unavailable",
      operation: "update",
      state: "failed",
    });
  });
});
