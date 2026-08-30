import { describe, expect, it, vi } from "vitest";
import {
  createAutomationAggregateLifecycle,
  createAutomationFailureHandler,
} from "./automations.js";
import type {
  AutomationAggregateStore,
  StoredDefinition,
} from "./automations.js";
import type { UnifiedAutomation } from "./schema.js";

const T0 = new Date("2026-08-01T10:00:00.000Z");

function definition(state: "draft" | "active" = "active"): UnifiedAutomation {
  const base = {
    schema_version: 2 as const,
    kind: "automation" as const,
    id: "launch-guide",
    trigger: {
      type: "comment" as const,
      target: "publication-1",
      match: { keywords: ["guide"], mode: "contains" as const },
    },
    rules: { once_per_contact: true, first_reply_delay_seconds: 5 as const },
    steps: [{ id: "reply", action: "reply_comment" as const, text: "Sent" }],
  };
  return state === "active" ? { ...base, state } : { ...base, state };
}

function memoryStore(initial?: UnifiedAutomation): AutomationAggregateStore {
  const records = new Map<string, StoredDefinition<UnifiedAutomation>>();
  if (initial !== undefined) {
    records.set(initial.id, {
      definition: initial,
      createdAt: T0,
      updatedAt: T0,
    });
  }
  return {
    list: async () => [...records.values()],
    findById: async (id) => records.get(id),
    save: async (value) => {
      const previous = records.get(value.id);
      const stored = {
        definition: value,
        createdAt: previous?.createdAt ?? T0,
        updatedAt: T0,
      };
      records.set(value.id, stored);
      return { ok: true, stored };
    },
    remove: async (id) => records.delete(id),
  };
}

describe("v2 automation lifecycle", () => {
  it("saves, lists, reads, deletes, and preserves draft/active state", async () => {
    const lifecycle = createAutomationAggregateLifecycle(memoryStore());
    expect(await lifecycle.save(definition("draft"))).toMatchObject({
      ok: true,
      created: true,
    });
    expect((await lifecycle.list())[0]?.definition.state).toBe("draft");
    expect(await lifecycle.read("launch-guide")).toMatchObject({
      definition: { id: "launch-guide" },
    });
    expect(await lifecycle.save(definition("active"))).toMatchObject({
      ok: true,
      created: false,
    });
    expect(await lifecycle.read("launch-guide")).toMatchObject({
      definition: { state: "active" },
    });
    expect(await lifecycle.remove("launch-guide")).toBe(true);
    expect(await lifecycle.read("launch-guide")).toBeUndefined();
  });

  it("preserves validation refusals", async () => {
    const lifecycle = createAutomationAggregateLifecycle(memoryStore());
    const invalid = await lifecycle.save({ ...definition(), name: "" });
    expect(invalid).toMatchObject({ ok: false, refusal: "invalid_definition" });
  });

  it("preserves an explicit global scope through the lifecycle", async () => {
    const lifecycle = createAutomationAggregateLifecycle(memoryStore());
    const global = {
      ...definition(),
      id: "global-guide",
      scope: { type: "global" as const },
      trigger: {
        type: "comment" as const,
        match: { keywords: ["guide"], mode: "contains" as const },
      },
    };

    expect(await lifecycle.save(global)).toMatchObject({ ok: true });
    expect(await lifecycle.read("global-guide")).toMatchObject({
      definition: { scope: { type: "global" } },
    });
  });

  it("resets failures when a draft is reactivated", async () => {
    const reset = vi.fn(async () => undefined);
    const lifecycle = createAutomationAggregateLifecycle(
      memoryStore(definition("draft")),
      { recordFailure: async () => [], reset },
    );
    expect((await lifecycle.save(definition("active"))).ok).toBe(true);
    expect(reset).toHaveBeenCalledWith("launch-guide");
  });
});

describe("automatic pause", () => {
  it("moves the aggregate to draft and audits the third definitive failure", async () => {
    const store = memoryStore(definition("active"));
    const save = vi.spyOn(store, "save");
    const audit = { record: vi.fn(async () => undefined) };
    const outcomes = createAutomationFailureHandler({
      aggregates: store,
      failures: {
        recordFailure: async () => [T0, T0, T0],
        reset: async () => undefined,
      },
      audit,
      clock: { now: () => T0 },
    });

    await outcomes.failed("launch-guide", "platform refused delivery");

    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({ state: "draft" }),
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        subtype: "automation_auto_paused",
        automationId: "launch-guide",
      }),
      T0,
    );
  });

  it("clears the failure sequence after a successful delivery", async () => {
    const reset = vi.fn(async () => undefined);
    const outcomes = createAutomationFailureHandler({
      aggregates: memoryStore(),
      failures: { recordFailure: async () => [], reset },
      audit: { record: async () => undefined },
      clock: { now: () => T0 },
    });
    await outcomes.succeeded("launch-guide");
    expect(reset).toHaveBeenCalledWith("launch-guide");
  });
});
