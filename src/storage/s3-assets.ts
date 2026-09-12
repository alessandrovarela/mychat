import { createHash, createHmac } from "node:crypto";
import { dirname, isAbsolute, resolve } from "node:path";
import {
  assetCapabilityUrl,
  assertWritableAsset,
  AssetWriteError,
} from "./assets.js";
import type { AssetBody, AssetCatalogue } from "./assets.js";
import type { AssetCapabilitySecret } from "./assets.js";

/** ADR-010: operator resources live below this bucket prefix. */
export const ASSET_PREFIX = "assets/";
/** Explicit alias for callers that need to distinguish S3's prefix. */
export const S3_ASSET_PREFIX = ASSET_PREFIX;

const WRITE_ERROR_CODES = {
  invalidName: "invalid_name",
  unsupportedContentType: "unsupported_content_type",
  tooLarge: "too_large",
  alreadyExists: "already_exists",
} as const;

const S3_ERROR_CODES = {
  unavailable: "unavailable",
  unauthorized: "unauthorized",
  protocol: "protocol",
} as const;

const S3_ERROR_MESSAGES = {
  unavailable: "asset storage is unavailable",
  unauthorized: "asset storage credentials were rejected",
  protocol: "asset storage rejected the request",
} as const;

export type S3AssetErrorCode =
  (typeof S3_ERROR_CODES)[keyof typeof S3_ERROR_CODES];

/** Stable adapter failure; S3 XML and endpoint details never leave this file. */
export class S3AssetError extends Error {
  readonly code: S3AssetErrorCode;
  readonly status?: number;
  override readonly name = "S3AssetError";

  constructor(code: S3AssetErrorCode, message: string, status?: number) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export interface S3AssetConfig {
  /** S3-compatible endpoint, for example the Cloudflare R2 account endpoint. */
  readonly endpoint: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly bucket: string;
  /** The MyChat public asset-route origin, with or without a trailing slash. */
  readonly publicBaseUrl: string | (() => Promise<string>);
  /** Makes the stable MyChat URL a capability instead of a bucket URL. */
  readonly assetCapabilitySecret?: AssetCapabilitySecret;
  /** Injected only by the deterministic integration test. */
  readonly fetch?: S3Fetcher;
  /** Injected only by the deterministic integration test. */
  readonly now?: () => Date;
}

type S3Fetcher = (input: string | URL, init?: RequestInit) => Promise<Response>;

/**
 * The minimum shape that can safely reach the S3 adapter.  This is deliberately
 * separate from creation: a Settings screen can reject an incomplete form
 * before it tries a provider, and a caller that does test a provider still
 * never has to write an object merely to prove its credentials.
 */
export type S3ConfigurationCheck =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: "invalid_endpoint" | "missing_field";
    };

export function validateS3AssetConfiguration(
  config: Pick<
    S3AssetConfig,
    "endpoint" | "accessKeyId" | "secretAccessKey" | "bucket"
  >,
): S3ConfigurationCheck {
  if (
    config.accessKeyId.trim() === "" ||
    config.secretAccessKey.trim() === "" ||
    config.bucket.trim() === ""
  ) {
    return { ok: false, reason: "missing_field" };
  }

  try {
    const endpoint = new URL(config.endpoint);
    if (endpoint.protocol !== "https:" && endpoint.protocol !== "http:") {
      return { ok: false, reason: "invalid_endpoint" };
    }
  } catch {
    return { ok: false, reason: "invalid_endpoint" };
  }

  return { ok: true };
}

/** A secret-safe result suitable for an operator-facing health indicator. */
export type S3ConnectionCheck =
  | { readonly status: "healthy" }
  | {
      readonly status: "failure";
      readonly reason: S3AssetErrorCode | "invalid_configuration";
    };

const RFC3986_EXTRA = /[!'()*]/g;

function encodeRfc3986(value: string): string {
  return encodeURIComponent(value).replace(
    RFC3986_EXTRA,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function canonicalHeaderValue(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function hmac(key: Uint8Array | string, value: string): Buffer {
  return createHmac("sha256", key).update(value).digest();
}

function awsDate(date: Date): { short: string; long: string } {
  const iso = date
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
  return { short: iso.slice(0, 8), long: iso };
}

function safeAssetName(name: string): boolean {
  if (
    name.length === 0 ||
    name.trim().length === 0 ||
    name === "." ||
    name === ".." ||
    name.includes("\0") ||
    name.includes("/") ||
    name.includes("\\") ||
    name.includes("\r") ||
    name.includes("\n") ||
    isAbsolute(name)
  ) {
    return false;
  }

  const root = resolve(".");
  return dirname(resolve(root, name)) === root;
}

/*
 * The write gate is `assertWritableAsset`, imported rather than spelled again.
 *
 * This binding is the one that runs in PRODUCTION (ADR-010), and it used to
 * carry its own copy of the rule. A copy is how a format narrowed in one place
 * stays accepted in the other: 3k.17 removed `image/webp`, and with two
 * spellings the deployed bucket would have gone on taking a file the platform
 * refuses to deliver. `safeAssetName` below stays local because it is about
 * this adapter's key building, not about what may be written.
 */

function endpointRoot(endpoint: string): string {
  return endpoint.replace(/\/+$/, "");
}

function bucketPath(config: S3AssetConfig): string {
  return `${endpointRoot(config.endpoint)}/${encodeURIComponent(config.bucket)}`;
}

function objectUrl(config: S3AssetConfig, name: string): URL {
  return new URL(
    `${bucketPath(config)}/${ASSET_PREFIX}${encodeURIComponent(name)}`,
  );
}

function listUrl(config: S3AssetConfig, continuationToken?: string): URL {
  const url = new URL(`${bucketPath(config)}/`);
  url.searchParams.set("list-type", "2");
  url.searchParams.set("prefix", ASSET_PREFIX);
  if (continuationToken !== undefined) {
    url.searchParams.set("continuation-token", continuationToken);
  }
  return url;
}

/**
 * Proves read access with the smallest S3 operation this adapter supports.
 * Listing the application's own prefix neither creates nor removes data, so a
 * successful test is useful before credentials are persisted and does not turn
 * object storage into a backup claim.
 */
export async function checkS3Connection(
  config: S3AssetConfig,
): Promise<S3ConnectionCheck> {
  if (!validateS3AssetConfiguration(config).ok) {
    return { status: "failure", reason: "invalid_configuration" };
  }

  const fetcher = config.fetch ?? globalThis.fetch;
  const url = listUrl(config);
  const signed = signedRequest("GET", url, undefined, config);
  try {
    const response = await fetcher(url, {
      method: "GET",
      headers: signed.headers,
    });
    if (response.ok) return { status: "healthy" };
    return { status: "failure", reason: statusCodeFor(response) };
  } catch {
    return { status: "failure", reason: S3_ERROR_CODES.unavailable };
  }
}

/** Encode each URI segment exactly once, as required by SigV4. */
function canonicalPath(pathname: string): string {
  return (
    pathname
      .split("/")
      .map((segment) => {
        try {
          return encodeRfc3986(decodeURIComponent(segment));
        } catch {
          return encodeRfc3986(segment);
        }
      })
      .join("/") || "/"
  );
}

function canonicalQuery(url: URL): string {
  return [...url.searchParams.entries()]
    .map(([key, value]) => [encodeRfc3986(key), encodeRfc3986(value)] as const)
    .sort(([leftKey, leftValue], [rightKey, rightValue]) =>
      leftKey === rightKey
        ? leftValue.localeCompare(rightValue)
        : leftKey.localeCompare(rightKey),
    )
    .map(([key, value]) => `${key}=${value}`)
    .join("&");
}

interface SignedHeaders {
  readonly headers: Record<string, string>;
}

function signedRequest(
  method: string,
  url: URL,
  body: Uint8Array | undefined,
  config: S3AssetConfig,
  extraHeaders: Readonly<Record<string, string>> = {},
): SignedHeaders {
  const date = awsDate((config.now ?? (() => new Date()))());
  const payloadHash = sha256(body ?? new Uint8Array());
  const headers: Record<string, string> = {
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": date.long,
    ...extraHeaders,
  };

  const canonicalEntries: Array<[string, string]> = [["host", url.host]];
  for (const [name, value] of Object.entries(headers)) {
    canonicalEntries.push([name.toLowerCase(), canonicalHeaderValue(value)]);
  }
  canonicalEntries.sort((left, right) => left[0].localeCompare(right[0]));

  const canonicalHeaders = canonicalEntries
    .map(([name, value]) => `${name}:${value}\n`)
    .join("");
  const signedHeaderNames = canonicalEntries.map(([name]) => name).join(";");
  const canonicalRequest = [
    method,
    canonicalPath(url.pathname),
    canonicalQuery(url),
    canonicalHeaders,
    signedHeaderNames,
    payloadHash,
  ].join("\n");

  const scope = `${date.short}/auto/s3/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    date.long,
    scope,
    sha256(canonicalRequest),
  ].join("\n");
  const dateKey = hmac(`AWS4${config.secretAccessKey}`, date.short);
  const regionKey = hmac(dateKey, "auto");
  const serviceKey = hmac(regionKey, "s3");
  const signingKey = hmac(serviceKey, "aws4_request");
  const signature = createHmac("sha256", signingKey)
    .update(stringToSign)
    .digest("hex");

  return {
    headers: {
      ...headers,
      authorization: `AWS4-HMAC-SHA256 Credential=${config.accessKeyId}/${scope}, SignedHeaders=${signedHeaderNames}, Signature=${signature}`,
    },
  };
}

/**
 * A short-lived, read-only URL for one object. This is deliberately separate
 * from the authenticated requests above: the browser receives this URL, never
 * the credentials that created it.
 */
export function presignedS3GetUrl(
  config: S3AssetConfig,
  name: string,
  expiresInSeconds: number = 300,
): string {
  if (!safeAssetName(name)) {
    throw new AssetWriteError(
      WRITE_ERROR_CODES.invalidName,
      `asset name "${name}" is not a safe file name`,
    );
  }
  if (
    !Number.isInteger(expiresInSeconds) ||
    expiresInSeconds < 1 ||
    expiresInSeconds > 604800
  ) {
    throw new S3AssetError(S3_ERROR_CODES.protocol, S3_ERROR_MESSAGES.protocol);
  }

  const url = objectUrl(config, name);
  const date = awsDate((config.now ?? (() => new Date()))());
  const scope = `${date.short}/auto/s3/aws4_request`;
  url.searchParams.set("X-Amz-Algorithm", "AWS4-HMAC-SHA256");
  url.searchParams.set("X-Amz-Credential", `${config.accessKeyId}/${scope}`);
  url.searchParams.set("X-Amz-Date", date.long);
  url.searchParams.set("X-Amz-Expires", String(expiresInSeconds));
  url.searchParams.set("X-Amz-SignedHeaders", "host");

  const canonicalRequest = [
    "GET",
    canonicalPath(url.pathname),
    canonicalQuery(url),
    `host:${url.host}\n`,
    "host",
    "UNSIGNED-PAYLOAD",
  ].join("\n");
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    date.long,
    scope,
    sha256(canonicalRequest),
  ].join("\n");
  const dateKey = hmac(`AWS4${config.secretAccessKey}`, date.short);
  const regionKey = hmac(dateKey, "auto");
  const serviceKey = hmac(regionKey, "s3");
  const signingKey = hmac(serviceKey, "aws4_request");
  const signature = createHmac("sha256", signingKey)
    .update(stringToSign)
    .digest("hex");
  url.searchParams.set("X-Amz-Signature", signature);
  return url.toString();
}

function statusCodeFor(response: Response): S3AssetErrorCode {
  if (response.status === 401 || response.status === 403) {
    return S3_ERROR_CODES.unauthorized;
  }
  return S3_ERROR_CODES.protocol;
}

function protocolFailure(response: Response): S3AssetError {
  const code = statusCodeFor(response);
  return new S3AssetError(code, S3_ERROR_MESSAGES[code], response.status);
}

function missingAsset(name: string): Error {
  return new Error(`asset "${name}" does not exist`);
}

function unescapeXml(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function xmlValues(xml: string, tag: string): string[] {
  const escapedTag = tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const expression = new RegExp(
    `<${escapedTag}>([\\s\\S]*?)</${escapedTag}>`,
    "g",
  );
  return [...xml.matchAll(expression)].map((match) =>
    unescapeXml(match[1] ?? ""),
  );
}

function xmlValue(xml: string, tag: string): string | undefined {
  return xmlValues(xml, tag)[0];
}

function validateListedName(key: string): string | undefined {
  if (!key.startsWith(ASSET_PREFIX)) {
    return undefined;
  }
  const name = key.slice(ASSET_PREFIX.length);
  return safeAssetName(name) ? name : undefined;
}

export interface S3AssetCatalogue extends AssetCatalogue {
  /** Creates a newly signed, five-minute provider URL after an existence check. */
  temporaryUrl(name: string): Promise<string>;
}

export function createS3Assets(config: S3AssetConfig): S3AssetCatalogue {
  const fetcher = config.fetch ?? globalThis.fetch;

  async function request(
    method: string,
    url: URL,
    body?: Uint8Array,
    extraHeaders: Readonly<Record<string, string>> = {},
  ): Promise<Response> {
    const signed = signedRequest(method, url, body, config, extraHeaders);
    try {
      return await fetcher(url, {
        method,
        headers: signed.headers,
        ...(body !== undefined && { body: Buffer.from(body) }),
      });
    } catch {
      throw new S3AssetError(
        S3_ERROR_CODES.unavailable,
        S3_ERROR_MESSAGES.unavailable,
      );
    }
  }

  async function hasObject(name: string): Promise<boolean> {
    const response = await request("HEAD", objectUrl(config, name));
    if (response.ok) {
      return true;
    }
    if (response.status === 404) {
      return false;
    }
    throw protocolFailure(response);
  }

  return {
    async put(name: string, body: AssetBody): Promise<void> {
      assertWritableAsset(name, body);

      if (await hasObject(name)) {
        throw new AssetWriteError(
          WRITE_ERROR_CODES.alreadyExists,
          `asset "${name}" already exists`,
        );
      }

      const response = await request(
        "PUT",
        objectUrl(config, name),
        body.bytes,
        {
          "content-type": body.contentType,
          "if-none-match": "*",
        },
      );

      if (response.ok) {
        return;
      }
      if (response.status === 409 || response.status === 412) {
        throw new AssetWriteError(
          WRITE_ERROR_CODES.alreadyExists,
          `asset "${name}" already exists`,
        );
      }
      throw protocolFailure(response);
    },

    async list(): Promise<string[]> {
      const names = new Set<string>();
      let continuationToken: string | undefined;

      for (;;) {
        const response = await request(
          "GET",
          listUrl(config, continuationToken),
        );
        if (!response.ok) {
          throw protocolFailure(response);
        }

        const xml = await response.text();
        for (const key of xmlValues(xml, "Key")) {
          const name = validateListedName(key);
          if (name !== undefined) {
            names.add(name);
          }
        }

        const truncatedValue = xmlValue(xml, "IsTruncated");
        if (truncatedValue === undefined) {
          throw new S3AssetError(
            S3_ERROR_CODES.protocol,
            S3_ERROR_MESSAGES.protocol,
          );
        }
        if (truncatedValue !== "true") {
          break;
        }

        const next = xmlValue(xml, "NextContinuationToken");
        if (next === undefined || next.length === 0) {
          throw new S3AssetError(
            S3_ERROR_CODES.protocol,
            S3_ERROR_MESSAGES.protocol,
          );
        }
        continuationToken = next;
      }

      return [...names].sort();
    },

    exists(name: string): Promise<boolean> {
      if (!safeAssetName(name)) {
        return Promise.resolve(false);
      }
      return hasObject(name);
    },

    async remove(name: string): Promise<boolean> {
      if (!safeAssetName(name)) {
        return false;
      }

      // HEAD before DELETE, because DeleteObject answers 204 whether or not the
      // key was there: without this the caller could never tell "deleted" from
      // "there was nothing", and the catalogue screen would report a file
      // removed that it never had.
      if (!(await hasObject(name))) {
        return false;
      }

      const response = await request("DELETE", objectUrl(config, name));
      // 404 between the HEAD and the DELETE is somebody else having deleted the
      // same object; the outcome the caller asked for holds either way.
      if (response.ok || response.status === 404) {
        return true;
      }
      throw protocolFailure(response);
    },

    async publicUrl(name: string): Promise<string> {
      if (!safeAssetName(name)) {
        throw new AssetWriteError(
          WRITE_ERROR_CODES.invalidName,
          `asset name "${name}" is not a safe file name`,
        );
      }
      if (!(await hasObject(name))) {
        throw missingAsset(name);
      }
      const source = config.publicBaseUrl;
      const publicBase = (
        typeof source === "function" ? await source() : source
      ).replace(/\/+$/, "");
      return config.assetCapabilitySecret === undefined
        ? `${publicBase}/${ASSET_PREFIX}${encodeURIComponent(name)}`
        : assetCapabilityUrl(publicBase, name, config.assetCapabilitySecret);
    },

    async temporaryUrl(name: string): Promise<string> {
      if (!safeAssetName(name) || !(await hasObject(name))) {
        throw missingAsset(name);
      }
      return presignedS3GetUrl(config, name);
    },
  };
}
