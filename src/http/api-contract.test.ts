import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import type { AutomationAggregateLifecycle } from "../flows/automations.js";
import { contractGaps, registerApiRoutes, routeLabel } from "./api/index.js";
import type { ApiDeps, RegisteredRoute } from "./api/index.js";

const NOW = new Date("2026-08-14T12:00:00.000Z");
let open: FastifyInstance[] = [];

function lifecycle(): AutomationAggregateLifecycle {
  return {
    list: async () => [],
    read: async () => undefined,
    save: async () => ({
      ok: false,
      refusal: "invalid_definition",
      issues: [],
    }),
    remove: async () => false,
  };
}

async function appWithRoutes(): Promise<{
  app: FastifyInstance;
  routes: readonly RegisteredRoute[];
}> {
  const app = Fastify({ logger: false });
  open.push(app);
  const routes: RegisteredRoute[] = [];
  app.addHook("onRoute", (route) => {
    routes.push({ method: route.method, url: route.url, schema: route.schema });
  });
  registerApiRoutes(app, {
    automations: lifecycle(),
    publications: {} as ApiDeps["publications"],
    metrics: {} as ApiDeps["metrics"],
    status: {} as ApiDeps["status"],
    assets: {} as ApiDeps["assets"],
    locale: {} as ApiDeps["locale"],
    timeZone: {} as ApiDeps["timeZone"],
    instanceSettings: {} as ApiDeps["instanceSettings"],
    now: () => NOW,
  });
  await app.ready();
  return { app, routes };
}

afterEach(async () => {
  await Promise.all(open.map((app) => app.close()));
  open = [];
});

describe("REQ-103/REQ-216: the current API contract", () => {
  it("declares every registered API route and registers no flow CRUD", async () => {
    const { routes } = await appWithRoutes();
    const api = routes.filter(
      (route) => route.url === "/api" || route.url.startsWith("/api/"),
    );

    expect(api.flatMap(contractGaps)).toEqual([]);
    expect(api.map(routeLabel)).not.toEqual(
      expect.arrayContaining([
        "GET /api/flows",
        "POST /api/flows",
        "DELETE /api/flows/:id",
      ]),
    );
  });

  it("refuses a malformed aggregate envelope before calling the domain", async () => {
    const { app } = await appWithRoutes();
    const response = await app.inject({
      method: "POST",
      url: "/api/automations",
      payload: {},
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: "invalid_request",
      issues: [expect.objectContaining({ path: "definition" })],
    });
  });
});
