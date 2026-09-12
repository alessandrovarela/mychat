import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { IN_MEMORY_DATABASE, openDatabase } from "../storage/database.js";
import type { DatabaseHandle } from "../storage/database.js";
import { createButtonClickStore } from "../storage/button-clicks.js";
import type { ButtonClickStore } from "../storage/button-clicks.js";
import { createDurableWorkStore } from "../storage/durable-work.js";
import { createQueueingSender } from "../runtime/outbox.js";
import type { SendPayload } from "../platform/sender.js";
import {
  createButtonLinkWriter,
  deriveClickSigningSecret,
  registerClicksRoute,
} from "./clicks-route.js";

const NOW = new Date("2026-08-14T12:00:00.000Z");
const ORIGIN = "https://public.example";

describe("REQ-220/REQ-221: signed attributed click redirect", () => {
  let handle: DatabaseHandle;
  let store: ButtonClickStore;
  let app: FastifyInstance;
  const secret = deriveClickSigningSecret("configured-app-secret");

  beforeEach(() => {
    handle = openDatabase({ databasePath: IN_MEMORY_DATABASE });
    store = createButtonClickStore(handle.db);
    app = Fastify({ logger: false });
    registerClicksRoute(app, {
      store,
      secret,
      clock: { now: () => NOW },
    });
  });

  afterEach(async () => {
    await app.close();
    handle.close();
  });

  async function signedUrl(): Promise<URL> {
    const writer = createButtonLinkWriter({
      store,
      secret,
      publicOrigin: ORIGIN,
    });
    const [button] = await writer.wrap(
      [
        {
          id: "download",
          label: "Download",
          url: "https://destination.example/guide",
        },
      ],
      {
        automationId: "launch",
        contactId: "contact-7",
        executionId: "launch:contact-7:run",
      },
      NOW,
    );
    if (button === undefined) throw new Error("button was not wrapped");
    return new URL(button.url);
  }

  it("records full attribution before redirecting to the persisted URL", async () => {
    const url = await signedUrl();
    const response = await app.inject({
      method: "GET",
      url: `${url.pathname}${url.search}`,
    });

    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe("https://destination.example/guide");
    const row = handle.connection
      .prepare("SELECT * FROM button_clicks")
      .get() as Record<string, unknown>;
    expect(row).toMatchObject({
      occurred_at: NOW.getTime(),
      automation_id: "launch",
      button_id: "download",
      destination_version: 1,
      contact_id: "contact-7",
      execution_id: "launch:contact-7:run",
      button_label: "Download",
    });
  });

  it("wraps every queued card button in authored order once attribution exists", async () => {
    const work = createDurableWorkStore(handle.db);
    const writer = createButtonLinkWriter({
      store,
      secret,
      publicOrigin: ORIGIN,
    });
    const sender = createQueueingSender(
      { work, clock: { now: () => NOW }, buttonLinks: writer },
      {
        automationId: "launch",
        origin: "direct_message",
        since: NOW,
        executionId: "launch:contact-7:run",
      },
    );

    await sender.sendDirectMessage("contact-7", {
      text: "",
      card: {
        buttons: [
          { id: "first", label: "First", url: "https://one.example/a" },
          { id: "second", label: "Second", url: "https://two.example/b" },
        ],
      },
    });

    const [queued] = await work.sendsFor("launch:contact-7:run");
    const payload = queued?.payload as SendPayload | undefined;
    const buttons = payload?.message.card?.buttons ?? [];
    expect(buttons.map((button) => button.id)).toEqual(["first", "second"]);
    expect(buttons.map((button) => new URL(button.url).origin)).toEqual([
      ORIGIN,
      ORIGIN,
    ]);
  });

  it("reads the public origin again when a later button is wrapped", async () => {
    let origin = "https://first.example";
    const writer = createButtonLinkWriter({
      store,
      secret,
      publicOrigin: () => Promise.resolve(origin),
    });
    const wrap = async (executionId: string): Promise<string> => {
      const [button] = await writer.wrap(
        [{ id: "download", label: "Download", url: "https://target.example" }],
        {
          automationId: "launch",
          contactId: "contact-7",
          executionId,
        },
        NOW,
      );
      if (button === undefined) throw new Error("button was not wrapped");
      return button.url;
    };

    expect(new URL(await wrap("run-1")).origin).toBe("https://first.example");
    origin = "https://panel.example";
    expect(new URL(await wrap("run-2")).origin).toBe("https://panel.example");
  });

  it("does not redirect for an altered signature or an arbitrary URL query", async () => {
    const url = await signedUrl();
    url.searchParams.set("signature", `${url.searchParams.get("signature")}0`);
    url.searchParams.set("url", "https://attacker.example/");
    const response = await app.inject({
      method: "GET",
      url: `${url.pathname}${url.search}`,
    });

    expect(response.statusCode).toBe(404);
    expect(response.headers.location).toBeUndefined();
    expect(await store.metrics("launch")).toMatchObject({ total: 0 });
  });

  it("does not redirect when the append fails", async () => {
    const url = await signedUrl();
    const failing = {
      ...store,
      record: () => Promise.reject(new Error("disk")),
    };
    const failingApp = Fastify({ logger: false });
    registerClicksRoute(failingApp, {
      store: failing,
      secret,
      clock: { now: () => NOW },
    });
    const response = await failingApp.inject({
      method: "GET",
      url: `${url.pathname}${url.search}`,
    });

    expect(response.statusCode).toBe(503);
    expect(response.headers.location).toBeUndefined();
    await failingApp.close();
  });
});
