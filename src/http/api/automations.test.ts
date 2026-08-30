import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAutomationAggregateLifecycle } from "../../flows/automations.js";
import type {
  AutomationAggregateLifecycle,
  StoredDefinition,
} from "../../flows/automations.js";
import type { UnifiedAutomation } from "../../flows/schema.js";
import { createAutomationAggregateRepository } from "../../storage/automation-aggregates.js";
import { IN_MEMORY_DATABASE, openDatabase } from "../../storage/database.js";
import type { DatabaseHandle } from "../../storage/database.js";
import {
  automationAggregates,
  automationPendingPublicationBaselines,
} from "../../storage/schema.js";
import { guardContracts, installRefusals } from "./contract.js";
import { registerAutomationAggregateRoutes } from "./automations.js";
import type { ClickMetricsReaders } from "./automations.js";

const NOW = new Date("2026-08-14T12:00:00.000Z");
const AUTOMATION: UnifiedAutomation = {
  schema_version: 2,
  kind: "automation",
  id: "launch",
  state: "active",
  trigger: {
    type: "comment",
    target: "post-1",
    match: { keywords: ["guide"], mode: "contains" },
  },
  rules: { once_per_contact: true, first_reply_delay_seconds: 5 },
  steps: [
    {
      id: "message",
      action: "send_dm",
      message: { text: "Here" },
    },
  ],
};
const NEXT_PUBLICATION_AUTOMATION: UnifiedAutomation = {
  ...AUTOMATION,
  id: "next-publication",
  scope: { type: "next_publication" },
  trigger: {
    type: "comment",
    match: { keywords: ["guide"], mode: "contains" },
  },
};
const STORED: StoredDefinition<UnifiedAutomation> = {
  definition: AUTOMATION,
  createdAt: NOW,
  updatedAt: NOW,
};

let open: FastifyInstance[] = [];

async function harness(
  lifecycle: AutomationAggregateLifecycle,
  clickMetrics?: ClickMetricsReaders,
): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  open.push(app);
  await app.register(async (scope) => {
    guardContracts(scope);
    installRefusals(scope);
    registerAutomationAggregateRoutes(scope, lifecycle, clickMetrics);
  });
  await app.ready();
  return app;
}

afterEach(async () => {
  await Promise.all(open.map((app) => app.close()));
  open = [];
});

describe("REQ-213/REQ-217: version-2 aggregate API", () => {
  it("lists and reads the complete persisted aggregate", async () => {
    const app = await harness({
      list: async () => [STORED],
      read: async () => STORED,
      save: vi.fn(),
      remove: vi.fn(),
    });

    expect(
      (await app.inject({ method: "GET", url: "/api/automations" })).json(),
    ).toEqual({
      automations: [
        {
          definition: AUTOMATION,
          createdAt: NOW.toISOString(),
          updatedAt: NOW.toISOString(),
        },
      ],
    });
    expect(
      (
        await app.inject({ method: "GET", url: "/api/automations/launch" })
      ).json(),
    ).toMatchObject({ automation: { definition: AUTOMATION } });
  });

  it("posts one self-contained definition and preserves conflict refusal", async () => {
    const save = vi.fn(async () => ({
      ok: false as const,
      refusal: "publication_target_conflict" as const,
      target: "post-1",
    }));
    const app = await harness({
      list: async () => [],
      read: async () => undefined,
      save,
      remove: async () => false,
    });
    const response = await app.inject({
      method: "POST",
      url: "/api/automations",
      payload: { definition: AUTOMATION },
    });

    expect(save).toHaveBeenCalledWith(AUTOMATION);
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({
      error: "publication_target_conflict",
      target: "post-1",
    });
  });

  it("returns the named global conflict without dropping its scope", async () => {
    const global = {
      ...AUTOMATION,
      scope: { type: "global" as const },
      trigger: {
        type: "comment" as const,
        match: { keywords: ["guide"], mode: "contains" as const },
      },
    };
    const app = await harness({
      list: async () => [],
      read: async () => undefined,
      save: async () => ({
        ok: false as const,
        refusal: "global_match_conflict" as const,
        automationId: "existing-global",
      }),
      remove: async () => false,
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/automations",
      payload: { definition: global },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({
      error: "global_match_conflict",
      automationId: "existing-global",
    });
  });

  it("deletes aggregates and returns 404 when none exists", async () => {
    const remove = vi.fn(async (id: string) => id === "launch");
    const app = await harness({
      list: async () => [],
      read: async () => undefined,
      save: vi.fn(),
      remove,
    });

    expect(
      (await app.inject({ method: "DELETE", url: "/api/automations/launch" }))
        .statusCode,
    ).toBe(200);
    expect(
      (await app.inject({ method: "DELETE", url: "/api/automations/missing" }))
        .statusCode,
    ).toBe(404);
  });
});

describe("REQ-380: next-publication activation baseline", () => {
  let handle: DatabaseHandle;

  beforeEach(() => {
    handle = openDatabase({ databasePath: IN_MEMORY_DATABASE });
  });

  afterEach(() => handle.close());

  it("persists the complete synchronized baseline with the active pending automation", async () => {
    const store = createAutomationAggregateRepository(handle.db, {
      now: () => NOW,
    });
    const app = await harness(
      createAutomationAggregateLifecycle(store, undefined, {
        sync: async () => ({
          ok: true as const,
          ids: ["post-old", "post-old-2"],
        }),
      }),
    );

    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/automations",
          payload: { definition: NEXT_PUBLICATION_AUTOMATION },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      handle.db.select().from(automationPendingPublicationBaselines).all(),
    ).toEqual([
      { automationId: "next-publication", publicationId: "post-old" },
      { automationId: "next-publication", publicationId: "post-old-2" },
    ]);
  });

  it("refuses activation when synchronization fails without writing a pending automation", async () => {
    const store = createAutomationAggregateRepository(handle.db, {
      now: () => NOW,
    });
    const app = await harness(
      createAutomationAggregateLifecycle(store, undefined, {
        sync: async () => ({
          ok: false as const,
          reason: "acervo indisponível",
        }),
      }),
    );

    const response = await app.inject({
      method: "POST",
      url: "/api/automations",
      payload: { definition: NEXT_PUBLICATION_AUTOMATION },
    });

    expect(response.statusCode).toBe(422);
    expect(response.json()).toEqual({
      error: "pending_publication_sync_failed",
      reason: "acervo indisponível",
    });
    expect(await store.list()).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * REQ-294: the ROUTE, over a real table holding a document it refuses
 * ------------------------------------------------------------------ */

/**
 * The only cases here that own a database, and they have to.
 *
 * Everything above runs on a lifecycle double, which is right for a route's
 * own contract and is exactly what hid this defect: the double lists what it
 * was handed, so the suite stayed green while the real route answered 500 to
 * every request the moment ONE stored document stopped matching the schema.
 * The operator met that 500 as a screen saying the automations could not be
 * read, which is the empty screen by another road: his readable automations
 * were all there, in the same table, one row away.
 */
const LEGACY_WITH_ATTACHMENT = {
  schema_version: 2,
  kind: "automation",
  id: "legacy-attachment",
  state: "active",
  trigger: {
    type: "comment",
    target: "post-2",
    match: { keywords: ["guide"], mode: "contains" },
  },
  rules: { once_per_contact: false },
  steps: [
    {
      id: "message",
      action: "send_dm",
      message: {
        text: "Here",
        attachments: [{ kind: "document", file: "guide.pdf" }],
      },
    },
  ],
};

describe("REQ-294: the real listing survives a document the schema refuses", () => {
  let handle: DatabaseHandle;
  let app: FastifyInstance;

  beforeEach(async () => {
    handle = openDatabase({ databasePath: IN_MEMORY_DATABASE });
    const store = createAutomationAggregateRepository(handle.db, {
      now: () => NOW,
    });
    await store.save(AUTOMATION);
    // Written as text, the way the version before this one left it: `save`
    // reads the row back through the current schema and refuses it, so the
    // repository is not the door such a row comes through.
    handle.db
      .insert(automationAggregates)
      .values({
        id: "legacy-attachment",
        definition: JSON.stringify(LEGACY_WITH_ATTACHMENT),
        publicationTarget: "post-2",
        createdAt: NOW,
        updatedAt: NOW,
      })
      .run();
    app = await harness(createAutomationAggregateLifecycle(store));
  });

  afterEach(() => handle.close());

  it("answers 200 with every automation it can read", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/automations",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      automations: [
        {
          definition: AUTOMATION,
          createdAt: NOW.toISOString(),
          updatedAt: NOW.toISOString(),
        },
      ],
    });
  });

  it("says the refused automation exists, instead of 404 or 500", async () => {
    const refused = await app.inject({
      method: "GET",
      url: "/api/automations/legacy-attachment",
    });

    // 404 would say it is gone, and somebody trusting that answer would go
    // looking for what deleted it. 500 would say the instance is broken, and
    // the listing two cases up shows that it is not. It is stored, this
    // version refuses it, and it cannot be edited: that is the sentence.
    expect(refused.statusCode).toBe(422);
    expect(refused.json()).toEqual({ error: "automation_unreadable" });

    const absent = await app.inject({
      method: "GET",
      url: "/api/automations/never-stored",
    });
    expect(absent.statusCode).toBe(404);
    expect(absent.json()).toEqual({ error: "automation_not_found" });
  });

  it("still deletes the refused row, which is the only thing left to do with it", async () => {
    // Reading it is refused, running it is refused, and editing it means
    // writing a whole new definition. Removing it needs neither the document
    // nor a compatibility layer: the identifier is its own column.
    expect(
      (
        await app.inject({
          method: "DELETE",
          url: "/api/automations/legacy-attachment",
        })
      ).statusCode,
    ).toBe(200);
  });
});

describe("REQ-329: the counts already measured reach the listing", () => {
  const WEBINAR: UnifiedAutomation = {
    ...AUTOMATION,
    id: "webinar",
    trigger: {
      type: "comment",
      target: "post-2",
      match: { keywords: ["seat"], mode: "contains" },
    },
  };
  const LISTED: readonly StoredDefinition<UnifiedAutomation>[] = [
    STORED,
    { definition: WEBINAR, createdAt: NOW, updatedAt: NOW },
  ];
  const LAUNCH_CLICKS = {
    automationId: "launch",
    total: 3,
    buttons: [
      { buttonId: "download", total: 2 },
      { buttonId: "more", total: 1 },
    ],
  };
  const WEBINAR_CLICKS = { automationId: "webinar", total: 0, buttons: [] };

  function listing(
    clickMetrics?: ClickMetricsReaders,
  ): Promise<FastifyInstance> {
    return harness(
      {
        list: async () => LISTED,
        read: vi.fn(),
        save: vi.fn(),
        remove: vi.fn(),
      },
      clickMetrics,
    );
  }

  it("answers the whole page with one read, and pairs each count with its own automation", async () => {
    // Deliberately keyed in the opposite order to the listing: a presenter
    // zipping two arrays by position would hand the launch its zero.
    const forListing = vi.fn(() =>
      Promise.resolve(
        new Map([
          ["webinar", WEBINAR_CLICKS],
          ["launch", LAUNCH_CLICKS],
        ]),
      ),
    );
    const app = await listing({ forListing });

    expect(
      (await app.inject({ method: "GET", url: "/api/automations" })).json(),
    ).toEqual({
      automations: [
        {
          definition: AUTOMATION,
          createdAt: NOW.toISOString(),
          updatedAt: NOW.toISOString(),
          clicks: LAUNCH_CLICKS,
        },
        {
          definition: WEBINAR,
          createdAt: NOW.toISOString(),
          updatedAt: NOW.toISOString(),
          clicks: WEBINAR_CLICKS,
        },
      ],
    });
    // Once for the page, never once per row: the whole point of the batch read
    // is that a listing of twenty automations is not twenty questions.
    expect(forListing).toHaveBeenCalledTimes(1);
    expect(forListing).toHaveBeenCalledWith(["launch", "webinar"]);
  });

  it("leaves the counts out instead of inventing a zero when the read fails", async () => {
    const app = await listing({
      forListing: () => Promise.reject(new Error("unavailable")),
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/automations",
    });

    // The automations are what the operator asked for and they arrive whole.
    // What must not arrive is a zero nobody counted.
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      automations: [
        {
          definition: AUTOMATION,
          createdAt: NOW.toISOString(),
          updatedAt: NOW.toISOString(),
        },
        {
          definition: WEBINAR,
          createdAt: NOW.toISOString(),
          updatedAt: NOW.toISOString(),
        },
      ],
    });
  });

  it("does not expose a per-automation click metrics route", async () => {
    const app = await listing({ forListing: vi.fn() });

    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/automations/launch/clicks",
        })
      ).statusCode,
    ).toBe(404);
  });
});
