import type { PlatformAccount } from "./account.js";
import { isSuccess } from "./transport.js";
import type { PlatformTransport } from "./transport.js";

/** The small, public-facing identity a signed-in operator may see. */
export interface AccountProfile {
  readonly connected: boolean;
  readonly name?: string;
  readonly pictureUrl?: string;
}

export interface AccountProfileReader {
  read(): Promise<AccountProfile>;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== ""
    ? value.trim()
    : undefined;
}

/**
 * Reads the account's display identity without making its credential part of
 * any HTTP response. It is intentionally best-effort: the navigation remains
 * usable while Meta is unavailable, and a missing profile picture is not a
 * reason to hide the account name.
 */
export function createAccountProfileReader(deps: {
  readonly account: PlatformAccount;
  readonly transport: PlatformTransport;
}): AccountProfileReader {
  return {
    async read(): Promise<AccountProfile> {
      try {
        const credential = await deps.account.current();
        const response = await deps.transport({
          method: "GET",
          host: credential.host,
          path: `/${credential.accountId}`,
          query: {
            fields: "username,profile_picture_url",
            access_token: credential.accessToken,
          },
        });

        if (!isSuccess(response)) return { connected: false };

        const body = response.body as {
          username?: unknown;
          profile_picture_url?: unknown;
        } | null;
        const name = text(body?.username) ?? credential.accountId;
        const pictureUrl = text(body?.profile_picture_url);

        return {
          connected: true,
          name,
          ...(pictureUrl !== undefined && { pictureUrl }),
        };
      } catch {
        return { connected: false };
      }
    },
  };
}
