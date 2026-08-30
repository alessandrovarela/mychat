/**
 * The one place that knows requests leave the process.
 *
 * Injected everywhere else, so the fast suite proves the SHAPE of every call
 * (host, path, recipient, body) against a captured request, with no network and
 * no credential (ADR-017, ADR-018). What only the real platform can answer —
 * whether it accepts that shape — is what the phase's `[human]` criteria are
 * for; no amount of local mocking substitutes for them, and pretending
 * otherwise is how an adapter passes every test and fails in production.
 */

export interface PlatformRequest {
  readonly method: "GET" | "POST";
  /** `graph.instagram.com` or `graph.facebook.com`, from the account port. */
  readonly host: string;
  /** Path only, leading slash included. */
  readonly path: string;
  readonly query?: Readonly<Record<string, string>>;
  readonly body?: unknown;
}

export interface PlatformResponse {
  readonly status: number;
  readonly body: unknown;
  /** Seconds the platform asked the caller to wait, when it says so. */
  readonly retryAfterSeconds?: number;
}

export type PlatformTransport = (
  request: PlatformRequest,
) => Promise<PlatformResponse>;

/** Everything below 300 is an acceptance; the callers only need that much. */
export function isSuccess(response: PlatformResponse): boolean {
  return response.status >= 200 && response.status < 300;
}

/**
 * The real transport. Never exercised by the fast suite, by design: what it
 * adds over the injected double is `fetch`, and a test of `fetch` is a test of
 * Node.
 */
export function createFetchTransport(): PlatformTransport {
  return async (request: PlatformRequest): Promise<PlatformResponse> => {
    const url = new URL(`https://${request.host}${request.path}`);
    for (const [key, value] of Object.entries(request.query ?? {})) {
      url.searchParams.set(key, value);
    }

    const response = await fetch(url, {
      method: request.method,
      ...(request.body !== undefined && {
        headers: { "content-type": "application/json" },
        body: JSON.stringify(request.body),
      }),
    });

    const retryAfter = response.headers.get("retry-after");
    const text = await response.text();

    return {
      status: response.status,
      // A non-JSON body from an error page must not throw here: the caller
      // decides what an unparseable answer means, and losing the status code
      // on the way would take away the only thing it could decide with.
      body: parseJson(text),
      ...(retryAfter !== null &&
        Number.isFinite(Number(retryAfter)) && {
          retryAfterSeconds: Number(retryAfter),
        }),
    };
  };
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}
