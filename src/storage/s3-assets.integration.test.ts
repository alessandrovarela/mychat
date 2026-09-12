import { describe, expect, it } from "vitest";
import {
  ASSET_PREFIX,
  checkS3Connection,
  S3AssetError,
  createS3Assets,
  presignedS3GetUrl,
  validateS3AssetConfiguration,
} from "./s3-assets.js";
import type { AssetBody } from "./assets.js";

const PDF: AssetBody = {
  bytes: new TextEncoder().encode("%PDF-1.4 local emulator fixture"),
  contentType: "application/pdf",
};

interface EmulatorRequest {
  readonly method: string;
  readonly headers: Headers;
  readonly body: Buffer;
}

interface Emulator {
  readonly endpoint: string;
  readonly objects: Map<string, { bytes: Buffer; contentType: string }>;
  failList: boolean;
  readonly requests: EmulatorRequest[];
  readonly fetch: (
    input: string | URL,
    init?: RequestInit,
  ) => Promise<Response>;
}

function responseXml(status: number, xml: string): Response {
  return new Response(xml, {
    status,
    headers: { "content-type": "application/xml" },
  });
}

/**
 * A protocol-level emulator, injected as fetch rather than bound to a socket.
 * It still consumes the exact path, query, headers and bytes the adapter sends,
 * while keeping this integration proof free of network permissions and Docker.
 */
function startEmulator(): Emulator {
  const objects = new Map<string, { bytes: Buffer; contentType: string }>();
  const requests: EmulatorRequest[] = [];
  let failList = false;

  const emulatorFetch = async (
    input: string | URL,
    init: RequestInit = {},
  ): Promise<Response> => {
    const url = new URL(input);
    const method = init.method ?? "GET";
    const headers = new Headers(init.headers);
    const body =
      init.body === undefined
        ? Buffer.alloc(0)
        : Buffer.from(init.body as Uint8Array);
    requests.push({ method, headers, body });

    const path = decodeURIComponent(url.pathname);
    const bucketPrefix = "/mychat/";
    if (!path.startsWith(bucketPrefix)) {
      return new Response(null, { status: 404 });
    }

    if (method === "GET" && url.searchParams.get("list-type") === "2") {
      if (failList) {
        return responseXml(
          500,
          "<Error><Code>InternalError</Code><Message>private emulator detail</Message></Error>",
        );
      }

      const continuation = url.searchParams.get("continuation-token");
      const allKeys = [...objects.keys()].sort();
      const start = continuation === null ? 0 : Number(continuation);
      const page = allKeys.slice(start, start + 1);
      const truncated = start + page.length < allKeys.length;
      const next = truncated ? String(start + page.length) : undefined;
      const escaped = (value: string): string =>
        value
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;")
          .replace(/"/g, "&quot;")
          .replace(/'/g, "&apos;");
      return responseXml(
        200,
        `<ListBucketResult>${page
          .map((key) => `<Contents><Key>${escaped(key)}</Key></Contents>`)
          .join("")}<IsTruncated>${String(truncated)}</IsTruncated>${
          next === undefined
            ? ""
            : `<NextContinuationToken>${next}</NextContinuationToken>`
        }</ListBucketResult>`,
      );
    }

    const key = path.slice(bucketPrefix.length);
    const stored = objects.get(key);

    if (method === "HEAD") {
      return stored === undefined
        ? new Response(null, { status: 404 })
        : new Response(null, {
            status: 200,
            headers: { "content-type": stored.contentType },
          });
    }

    if (method === "PUT") {
      if (stored !== undefined) {
        return responseXml(
          412,
          "<Error><Code>PreconditionFailed</Code></Error>",
        );
      }
      objects.set(key, {
        bytes: body,
        contentType: headers.get("content-type") ?? "",
      });
      return new Response(null, { status: 200 });
    }

    if (method === "DELETE") {
      // 204 whether or not the key was there, exactly as S3 and R2 answer: the
      // adapter cannot learn from this response whether it deleted anything,
      // which is why it asks with HEAD first.
      objects.delete(key);
      return new Response(null, { status: 204 });
    }

    return new Response(null, { status: 405 });
  };

  return {
    endpoint: "http://s3-emulator.invalid",
    objects,
    get failList() {
      return failList;
    },
    set failList(value: boolean) {
      failList = value;
    },
    requests,
    fetch: emulatorFetch,
  };
}

describe("REQ-047: S3-compatible asset binding", () => {
  it("validates form data and tests read access without writing an object", async () => {
    const emulator = startEmulator();
    const config = {
      endpoint: emulator.endpoint,
      accessKeyId: "test-key",
      secretAccessKey: "test-secret",
      bucket: "mychat",
    };

    expect(validateS3AssetConfiguration(config)).toEqual({ ok: true });
    expect(
      validateS3AssetConfiguration({ ...config, endpoint: "not an endpoint" }),
    ).toEqual({ ok: false, reason: "invalid_endpoint" });
    expect(
      validateS3AssetConfiguration({ ...config, secretAccessKey: " " }),
    ).toEqual({ ok: false, reason: "missing_field" });

    await expect(
      checkS3Connection({
        ...config,
        publicBaseUrl: "https://cdn.example.test",
        fetch: emulator.fetch,
      }),
    ).resolves.toEqual({ status: "healthy" });
    expect(emulator.requests.map((request) => request.method)).toEqual(["GET"]);
    expect(emulator.objects).toEqual(new Map());
  });

  it("reports only a stable diagnostic when the provider rejects credentials", async () => {
    const emulator = startEmulator();
    emulator.failList = true;

    await expect(
      checkS3Connection({
        endpoint: emulator.endpoint,
        accessKeyId: "test-key",
        secretAccessKey: "test-secret",
        bucket: "mychat",
        publicBaseUrl: "https://cdn.example.test",
        fetch: emulator.fetch,
      }),
    ).resolves.toEqual({ status: "failure", reason: "protocol" });
  });

  it("creates a five-minute read capability for one object without exposing credentials", () => {
    const url = new URL(
      presignedS3GetUrl(
        {
          endpoint: "https://account.r2.cloudflarestorage.com",
          accessKeyId: "test-key",
          secretAccessKey: "test-secret",
          bucket: "mychat",
          publicBaseUrl: "https://unused.example",
          now: () => new Date("2026-08-06T12:34:56.000Z"),
        },
        "guide.pdf",
      ),
    );

    expect(url.pathname).toBe("/mychat/assets/guide.pdf");
    expect(url.searchParams.get("X-Amz-Expires")).toBe("300");
    expect(url.searchParams.get("X-Amz-SignedHeaders")).toBe("host");
    expect(url.searchParams.get("X-Amz-Signature")).toMatch(/^[a-f0-9]{64}$/);
    expect(url.toString()).not.toContain("test-secret");
  });

  it("uses the assets prefix and the same catalogue contract as disk", async () => {
    const emulator = startEmulator();
    const assets = createS3Assets({
      endpoint: emulator.endpoint,
      accessKeyId: "test-key",
      secretAccessKey: "test-secret",
      bucket: "mychat",
      publicBaseUrl: "https://cdn.example.test/",
      now: () => new Date("2026-08-06T12:34:56.000Z"),
      fetch: emulator.fetch,
    });

    await assets.put("guide.pdf", PDF);

    expect([...emulator.objects.keys()]).toEqual([`${ASSET_PREFIX}guide.pdf`]);
    expect(
      Uint8Array.from(emulator.objects.get("assets/guide.pdf")?.bytes ?? []),
    ).toEqual(PDF.bytes);
    expect(await assets.list()).toEqual(["guide.pdf"]);
    expect(await assets.exists("guide.pdf")).toBe(true);
    expect(await assets.exists("missing.pdf")).toBe(false);
    expect(await assets.publicUrl("guide.pdf")).toBe(
      "https://cdn.example.test/assets/guide.pdf",
    );

    const signed = emulator.requests.find(
      (request) => request.method === "PUT",
    );
    expect(signed?.headers.get("authorization")).toContain("AWS4-HMAC-SHA256");
    expect(signed?.headers.get("x-amz-content-sha256")).toBeDefined();
  });

  it("reads the public base again when a persisted origin changes", async () => {
    const emulator = startEmulator();
    let publicBaseUrl = "https://first.example/assets";
    const assets = createS3Assets({
      endpoint: emulator.endpoint,
      accessKeyId: "test-key",
      secretAccessKey: "test-secret",
      bucket: "mychat",
      publicBaseUrl: () => Promise.resolve(publicBaseUrl),
      assetCapabilitySecret: "capability-secret",
      fetch: emulator.fetch,
    });
    await assets.put("guide.pdf", PDF);

    expect(new URL(await assets.publicUrl("guide.pdf")).origin).toBe(
      "https://first.example",
    );
    publicBaseUrl = "https://panel.example/assets";
    expect(new URL(await assets.publicUrl("guide.pdf")).origin).toBe(
      "https://panel.example",
    );
  });

  it("refuses a collision without replacing the original object", async () => {
    const emulator = startEmulator();
    const assets = createS3Assets({
      endpoint: emulator.endpoint,
      accessKeyId: "test-key",
      secretAccessKey: "test-secret",
      bucket: "mychat",
      publicBaseUrl: "https://cdn.example.test",
      fetch: emulator.fetch,
    });

    await assets.put("guide.pdf", PDF);
    await expect(
      assets.put("guide.pdf", {
        bytes: new TextEncoder().encode("replacement"),
        contentType: PDF.contentType,
      }),
    ).rejects.toMatchObject({
      code: "already_exists",
    });
    expect(
      Uint8Array.from(emulator.objects.get("assets/guide.pdf")?.bytes ?? []),
    ).toEqual(PDF.bytes);
  });

  it("translates protocol failures without exposing the provider response", async () => {
    const emulator = startEmulator();
    emulator.failList = true;
    const assets = createS3Assets({
      endpoint: emulator.endpoint,
      accessKeyId: "test-key",
      secretAccessKey: "test-secret",
      bucket: "mychat",
      publicBaseUrl: "https://cdn.example.test",
      fetch: emulator.fetch,
    });

    const failure = await assets.list().catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(S3AssetError);
    expect((failure as S3AssetError).code).toBe("protocol");
    expect((failure as Error).message).toBe(
      "asset storage rejected the request",
    );
    expect((failure as Error).message).not.toContain("private emulator detail");
  });

  it("deletes one object, and tells a deletion from an absence (REQ-293)", async () => {
    const emulator = startEmulator();
    const assets = createS3Assets({
      endpoint: emulator.endpoint,
      accessKeyId: "test-key",
      secretAccessKey: "test-secret",
      bucket: "mychat",
      publicBaseUrl: "https://cdn.example.test",
      fetch: emulator.fetch,
    });

    await assets.put("guide.pdf", PDF);

    expect(await assets.remove("guide.pdf")).toBe(true);
    expect([...emulator.objects.keys()]).toEqual([]);
    // The bucket answers 204 to both deletions; the second `false` is the HEAD
    // this adapter asks first, and without it the catalogue screen would report
    // a file removed that was never there.
    expect(await assets.remove("guide.pdf")).toBe(false);
    expect(await assets.remove("../outside.pdf")).toBe(false);
    expect(
      emulator.requests.filter((request) => request.method === "DELETE"),
    ).toHaveLength(1);
  });

  it("refuses unsafe names before contacting the bucket", async () => {
    const emulator = startEmulator();
    const assets = createS3Assets({
      endpoint: emulator.endpoint,
      accessKeyId: "test-key",
      secretAccessKey: "test-secret",
      bucket: "mychat",
      publicBaseUrl: "https://cdn.example.test",
      fetch: emulator.fetch,
    });

    await expect(assets.put("../outside.pdf", PDF)).rejects.toMatchObject({
      code: "invalid_name",
    });
    expect(emulator.requests).toHaveLength(0);
  });
});
