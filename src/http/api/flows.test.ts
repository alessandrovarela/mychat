import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { registerApiRoutes } from "./index.js";
import type { ApiDeps } from "./index.js";

let open = Fastify({ logger: false });

afterEach(async () => {
  await open.close();
  open = Fastify({ logger: false });
});

describe("REQ-216: flows are not an operator API", () => {
  it("does not register CRUD under /api/flows", async () => {
    await open.register(async (scope) => {
      registerApiRoutes(scope, {} as unknown as ApiDeps);
    });
    await open.ready();

    for (const method of ["GET", "POST", "PATCH", "DELETE"] as const) {
      const response = await open.inject({ method, url: "/api/flows/example" });
      expect(response.statusCode).toBe(404);
    }
    expect(
      (await open.inject({ method: "GET", url: "/api/flows" })).statusCode,
    ).toBe(404);
  });
});
