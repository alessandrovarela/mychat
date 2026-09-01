import { describe, expect, it } from "vitest";
import { createAccountProfileReader } from "./account-profile.js";
import type { AccountCredential, PlatformAccount } from "./account.js";

const credential: AccountCredential = {
  path: "instagram_login",
  host: "graph.instagram.com",
  accessToken: "secret-token",
  accountId: "account-1",
};

function account(): PlatformAccount {
  return {
    current: () => Promise.resolve(credential),
    check: () => Promise.resolve({ ok: true }),
    refreshIfNeeded: () => Promise.resolve({ kind: "not_needed" }),
  };
}

describe("account profile", () => {
  it("returns only the public Meta identity", async () => {
    const reader = createAccountProfileReader({
      account: account(),
      transport: async (request) => {
        expect(request).toMatchObject({
          method: "GET",
          host: credential.host,
          path: "/account-1",
          query: { fields: "username,profile_picture_url" },
        });
        return {
          status: 200,
          body: {
            username: "mychat",
            profile_picture_url: "https://cdn.example.test/avatar.jpg",
          },
        };
      },
    });

    await expect(reader.read()).resolves.toEqual({
      connected: true,
      name: "mychat",
      pictureUrl: "https://cdn.example.test/avatar.jpg",
    });
  });

  it("hides the identity when Meta cannot answer", async () => {
    const reader = createAccountProfileReader({
      account: account(),
      transport: async () => ({ status: 503, body: {} }),
    });

    await expect(reader.read()).resolves.toEqual({ connected: false });
  });
});
