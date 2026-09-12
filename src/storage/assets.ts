import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import type { AssetStorage } from "../engine/ports.js";

/**
 * The asset contract and the bindings this phase needs (ADR-016).
 *
 * One contract, four bindings by design: an in-memory double for the fast
 * suite, local disk for development, an in-process S3 emulator for the
 * integration suite, and R2 in production. The last two arrive with
 * deployment; what REQ-020 and REQ-021 need is the contract plus the first
 * two, and adding a binding later must not touch a single caller — which is the
 * whole reason the contract exists.
 *
 * The catalogue extends the engine's `AssetStorage` with two reads the engine
 * does not need but validation does: whether a name exists, and what exists.
 * Keeping them out of the port is deliberate — the engine must not be able to
 * browse storage, only to resolve a name it was given. `put` stays on this
 * catalogue instead of the engine port for the same capability boundary.
 */

/**
 * The formats the platform will actually carry, and therefore the only ones a
 * resource may be uploaded in (REQ-231).
 *
 * This is the whole of the rule: a format refused HERE is refused while the
 * operator is choosing the file, and a format accepted here is one the delivery
 * cannot fail on. The list used to be wider, and every extra entry was a trap
 * of the same shape — bytes accepted at upload that the Send API declines
 * later, with the contact already waiting for them.
 *
 * The platform's media specification lists exactly three things this product
 * sends: image `png` and `jpeg` (8 MB), and file `pdf` (25 MB) — "Send
 * messages", graph.instagram.com v26.0, consulted 2026-08-16, and recorded in
 * `docs/platform-limits.md`. What that list does NOT contain is the point:
 *
 *   - `webp` is absent, and it was accepted here until 3k.17. An operator could
 *     upload one, select it, activate the automation and only discover the
 *     refusal at delivery.
 *   - `text/plain`, `text/csv` and `application/json` are absent too, for the
 *     same reason: "Texto" in that documentation is a text MESSAGE, not a text
 *     file, and the only file format named is pdf.
 *
 * ONE list for the attachment and for the card's cover, deliberately. The two
 * travel differently — the cover goes inside the generic template as
 * `image_url`, the attachment as media — and the documentation gives image
 * formats in one place only, the page cited above. With no separate evidence
 * that a template's cover accepts more, the conservative set is the honest one:
 * being wrong here costs an upload the operator has to redo, and being wrong
 * the other way costs a delivery the contact never receives.
 */
export const ASSET_CONTENT_TYPES = [
  "application/pdf",
  "image/jpeg",
  "image/png",
] as const;

export type AssetContentType = (typeof ASSET_CONTENT_TYPES)[number];

/** The documented 25 MB ceiling for a PDF/file message. */
export const MAX_ASSET_BYTES = 25 * 1024 * 1024;

/**
 * The documented 8 MB ceiling for an image, which is NOT the file ceiling.
 *
 * Same page, same table, a third of the size. Enforcing only the larger number
 * would accept a 20 MB PNG at upload and lose it at delivery, which is the
 * defect this module exists to move earlier.
 */
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

/** Content types metered against the image ceiling rather than the file one. */
function isImageContentType(contentType: string): boolean {
  return contentType.startsWith("image/");
}

/** The ceiling in force for one media type, in bytes. */
export function maxBytesFor(contentType: string): number {
  return isImageContentType(normalizedContentType(contentType))
    ? MAX_IMAGE_BYTES
    : MAX_ASSET_BYTES;
}

/** The bytes and media type that a binding persists for one named resource. */
export interface AssetBody {
  readonly bytes: Uint8Array;
  /** A media type, optionally carrying parameters such as `charset`. */
  readonly contentType: string;
}

export type AssetWriteErrorCode =
  "invalid_name" | "unsupported_content_type" | "too_large" | "already_exists";

// Keep the stable machine codes separate from the human detail. The latter is
// intentionally not part of the storage contract: the API/localisation layer
// decides what an operator sees, while this module only needs a typed reason.
const ASSET_WRITE_CODES = {
  invalidName: "invalid_name",
  unsupportedContentType: "unsupported_content_type",
  tooLarge: "too_large",
  alreadyExists: "already_exists",
} as const satisfies Record<string, AssetWriteErrorCode>;

/** Stable failure identity for an upload; the API layer localises the detail. */
export class AssetWriteError extends Error {
  readonly code: AssetWriteErrorCode;
  override readonly name = "AssetWriteError";

  constructor(code: AssetWriteErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

/**
 * A valid resource key is one flat file name, not a path. This is shared by
 * both bindings so a name accepted by the memory double cannot later escape
 * the disk directory when the same application is deployed.
 */
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

  // Keep this containment check even after the explicit separator checks: it
  // protects the contract if a future platform-specific path spelling slips
  // through the string checks above.
  const root = resolve(".");
  return dirname(resolve(root, name)) === root;
}

function normalizedContentType(contentType: string): string {
  return contentType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
}

function contentTypeIsSupported(contentType: string): boolean {
  return (ASSET_CONTENT_TYPES as readonly string[]).includes(
    normalizedContentType(contentType),
  );
}

/**
 * The one gate every binding writes through (ADR-016).
 *
 * Exported and shared rather than copied, because the copy is what makes the
 * rule a lie: the disk binding and the R2 binding held two spellings of this
 * function, and a format narrowed in one of them would still have been accepted
 * in production by the other.
 */
export function assertWritableAsset(name: string, body: AssetBody): void {
  if (!safeAssetName(name)) {
    throw new AssetWriteError(
      ASSET_WRITE_CODES.invalidName,
      `asset name "${name}" is not a safe file name`,
    );
  }

  if (
    typeof body.contentType !== "string" ||
    !contentTypeIsSupported(body.contentType)
  ) {
    // The accepted formats are NAMED in the refusal (REQ-231). A refusal that
    // only says no leaves the operator guessing which of their files will work,
    // and the guess is answered by trying — which is exactly the trip to the
    // delivery this list exists to prevent.
    throw new AssetWriteError(
      ASSET_WRITE_CODES.unsupportedContentType,
      `asset content type "${String(body.contentType)}" is not supported (accepted: ${ASSET_CONTENT_TYPES.join(", ")})`,
    );
  }

  if (!(body.bytes instanceof Uint8Array)) {
    throw new AssetWriteError(
      ASSET_WRITE_CODES.unsupportedContentType,
      "asset body must be a byte array",
    );
  }

  // Per media type, not one number for everything: an image is metered against
  // a ceiling a third the size of a file's.
  const ceiling = maxBytesFor(body.contentType);
  if (body.bytes.byteLength > ceiling) {
    throw new AssetWriteError(
      ASSET_WRITE_CODES.tooLarge,
      `asset "${name}" exceeds the ${ceiling} byte limit`,
    );
  }
}

/**
 * The separator between the file name an operator sent and the token that
 * makes the stored key unique (REQ-292).
 *
 * `~` and not `-`, because the key has to be readable back: the display name is
 * derived from the key by removing this suffix, and a file legitimately called
 * `report-1a2b3c4d.pdf` would be indistinguishable from a minted one if the
 * separator were the dash people put in their own file names. It is also one of
 * RFC 3986's unreserved characters, so it survives `encodeURIComponent` in the
 * public URL and SigV4's canonical path in the bucket adapter untouched.
 */
export const ASSET_KEY_SEPARATOR = "~";

/** Four random bytes, spelled as eight hexadecimal characters. */
const ASSET_KEY_TOKEN_BYTES = 4;
const MINTED_KEY = /~[0-9a-f]{8}$/;

/**
 * How many keys are minted before giving up. A collision needs the same random
 * 32-bit token under the same file name, so this loop exists for correctness
 * rather than for a case anybody will see.
 */
const KEY_ATTEMPTS = 5;

/** A resource as the catalogue holds it: the key, and the name it was sent as. */
export interface StoredAsset {
  /** The immutable identity, the key every binding and definition refers to. */
  readonly name: string;
  /** What the operator called the file, for the screen to show (REQ-292). */
  readonly fileName: string;
}

/** `guide.pdf` -> `["guide", ".pdf"]`; a name with no extension keeps none. */
function splitExtension(fileName: string): readonly [string, string] {
  const dot = fileName.lastIndexOf(".");
  return dot <= 0
    ? [fileName, ""]
    : [fileName.slice(0, dot), fileName.slice(dot)];
}

/**
 * A key nothing else holds, for a file the operator called `fileName`.
 *
 * The extension is preserved and stays LAST, because it is what the public file
 * route types the response by: a key ending in `~a1b2c3d4` would be served as
 * `application/octet-stream` and the platform would refuse to deliver it.
 */
export function newAssetKey(fileName: string): string {
  const [stem, extension] = splitExtension(fileName);
  const token = randomBytes(ASSET_KEY_TOKEN_BYTES).toString("hex");
  return `${stem}${ASSET_KEY_SEPARATOR}${token}${extension}`;
}

/**
 * The name to SHOW for a stored key, derived rather than stored.
 *
 * Deriving it is what keeps this change out of every binding: there is no
 * metadata table to write, no migration, and a file that was already in the
 * bucket before keys were minted shows the name it has. The cost is one
 * cosmetic mistake: a resource uploaded by hand as `report~1a2b3c4d.pdf` is
 * shown as `report.pdf`. The key it is selected and delivered by is untouched.
 */
export function assetFileName(name: string): string {
  const [stem, extension] = splitExtension(name);
  return `${stem.replace(MINTED_KEY, "")}${extension}`;
}

/**
 * Upload as REQ-292 defines it: every upload creates a resource of its own.
 *
 * The name an operator sends is a LABEL, never the identity. Sending
 * `guide.pdf` twice produces two resources, and neither one changes: the
 * automations pointing at the first keep delivering the first, including the
 * automations that already delivered it to a contact whose direct message still
 * carries the link. Overwriting would rewrite what was already sent, and
 * refusing (which this route did until 3n.3) only forces the operator to invent
 * a name for a file that already has one.
 *
 * `put` stays the floor underneath: it refuses an existing key, so a mint that
 * collided is retried rather than silently replacing an object.
 */
export async function storeNewAsset(
  assets: AssetCatalogue,
  fileName: string,
  body: AssetBody,
): Promise<StoredAsset> {
  // Validated on what the operator SENT, so the refusal names their file and
  // not a key they never saw. `put` runs the same gate on the minted key.
  assertWritableAsset(fileName, body);

  for (let attempt = 0; attempt < KEY_ATTEMPTS; attempt += 1) {
    const name = newAssetKey(fileName);
    try {
      await assets.put(name, body);
      return { name, fileName };
    } catch (error) {
      if (
        error instanceof AssetWriteError &&
        error.code === ASSET_WRITE_CODES.alreadyExists
      ) {
        continue;
      }
      throw error;
    }
  }

  throw new AssetWriteError(
    ASSET_WRITE_CODES.alreadyExists,
    `no free key could be minted for "${fileName}"`,
  );
}

function assetPath(dir: string, name: string): string | undefined {
  if (!safeAssetName(name)) {
    return undefined;
  }

  const root = resolve(dir);
  const target = resolve(root, name);
  return dirname(target) === root ? target : undefined;
}

export interface AssetCatalogue extends AssetStorage {
  /** Does this resource exist right now? Asked at write time (REQ-021). */
  exists(name: string): Promise<boolean>;
  /** Every resource available, for an error message that can be acted on. */
  list(): Promise<string[]>;
  /** Persist a new resource; an existing name is never overwritten. */
  put(name: string, body: AssetBody): Promise<void>;
  /**
   * Delete one resource. `false` when there was nothing to delete (REQ-293).
   *
   * On the CATALOGUE and deliberately not on the engine's `AssetStorage` port:
   * an execution resolves a name to a URL and must not be able to destroy the
   * material it is sending. Deleting is an act of the operator in the catalogue
   * screen, and this is the only door to it.
   */
  remove(name: string): Promise<boolean>;
}

export interface MemoryAssets extends AssetCatalogue {
  /** Test-only escape hatch for replacing a URL without writing bytes. */
  set(name: string, url: string): void;
  /** The bytes held by this in-process binding, if it was written with put. */
  bodyOf(name: string): AssetBody | undefined;
}

/** URL root handed out by the in-memory binding; it is never fetched. */
export const MEMORY_ASSET_BASE = "memory://bucket";

/**
 * A public asset address is a capability, not an identity session: the
 * recipient needs no MyChat account, but changing the resource name must not
 * select another object. The token intentionally carries no storage detail.
 */
export type AssetCapabilitySecret = string | Uint8Array;

/** Derive a key dedicated to links; it is never the raw platform secret. */
export function deriveAssetCapabilitySecret(metaAppSecret: string): Buffer {
  return createHmac("sha256", metaAppSecret)
    .update("mychat/asset-capability/v1")
    .digest();
}

export function assetCapability(
  name: string,
  secret: AssetCapabilitySecret,
): string {
  return createHmac("sha256", secret).update(name).digest("base64url");
}

/** Constant-time capability check for the public asset route. */
export function hasAssetCapability(
  name: string,
  capability: string | undefined,
  secret: AssetCapabilitySecret,
): boolean {
  if (!safeAssetName(name) || capability === undefined) {
    return false;
  }

  const expected = Buffer.from(assetCapability(name, secret));
  const received = Buffer.from(capability);
  return (
    received.length === expected.length && timingSafeEqual(received, expected)
  );
}

/** Build the stable MyChat URL that is sent to the platform or recipient. */
export function assetCapabilityUrl(
  publicBaseUrl: string,
  name: string,
  secret: AssetCapabilitySecret,
): string {
  if (!safeAssetName(name)) {
    throw new AssetWriteError(
      ASSET_WRITE_CODES.invalidName,
      `asset name "${name}" is not a safe file name`,
    );
  }

  const base = publicBaseUrl.replace(/\/+$/, "");
  return `${base}/${encodeURIComponent(name)}?cap=${assetCapability(name, secret)}`;
}

/**
 * The fast-suite binding. Also the honest way to prove REQ-020: the entries can
 * change between two resolutions, which is what "resolved at send time" means.
 */
export function createMemoryAssets(
  entries: Record<string, string> = {},
  publicBaseUrl: string = MEMORY_ASSET_BASE,
): MemoryAssets {
  const base = publicBaseUrl.replace(/\/+$/, "");
  const store = new Map(Object.entries(entries));
  const bodies = new Map<string, AssetBody>();

  return {
    publicUrl(name: string): Promise<string> {
      if (!safeAssetName(name)) {
        throw new AssetWriteError(
          ASSET_WRITE_CODES.invalidName,
          `asset name "${name}" is not a safe file name`,
        );
      }
      const url = store.get(name);
      if (url === undefined) {
        // Not a catalogue message: validation refused this at write time, so
        // reaching it means the resource vanished between write and send.
        throw new Error(`asset "${name}" does not exist`);
      }
      return Promise.resolve(url);
    },
    exists(name: string): Promise<boolean> {
      return Promise.resolve(safeAssetName(name) && store.has(name));
    },
    list(): Promise<string[]> {
      return Promise.resolve([...store.keys()].sort());
    },
    async put(name: string, body: AssetBody): Promise<void> {
      assertWritableAsset(name, body);
      if (store.has(name)) {
        throw new AssetWriteError(
          ASSET_WRITE_CODES.alreadyExists,
          `asset "${name}" already exists`,
        );
      }

      // Copy the bytes so a caller cannot mutate a resource after a successful
      // upload by retaining and changing its input buffer.
      bodies.set(name, { ...body, bytes: new Uint8Array(body.bytes) });
      store.set(name, `${base}/${encodeURIComponent(name)}`);
    },
    remove(name: string): Promise<boolean> {
      if (!safeAssetName(name)) {
        return Promise.resolve(false);
      }
      bodies.delete(name);
      return Promise.resolve(store.delete(name));
    },
    set(name: string, url: string): void {
      store.set(name, url);
      bodies.delete(name);
    },
    bodyOf(name: string): AssetBody | undefined {
      return bodies.get(name);
    },
  };
}

export interface DiskAssetConfig {
  readonly dir: string;
  /**
   * Prefix the platform fetches from. In development this is whatever tunnel
   * exposes the process, which is exactly what makes the `[human]` proof of
   * this phase possible without a bucket.
   */
  readonly publicBaseUrl: string | (() => Promise<string>);
  /** Present in the composed application; absent only for legacy local doubles. */
  readonly assetCapabilitySecret?: AssetCapabilitySecret;
}

/** The development binding: files on disk, served under a public prefix. */
export function createDiskAssets(config: DiskAssetConfig): AssetCatalogue {
  return {
    async publicUrl(name: string): Promise<string> {
      const file = assetPath(config.dir, name);
      if (file === undefined || !existsSync(file)) {
        throw new Error(`asset "${name}" does not exist`);
      }
      const source = config.publicBaseUrl;
      const base = (
        typeof source === "function" ? await source() : source
      ).replace(/\/+$/, "");
      return config.assetCapabilitySecret === undefined
        ? `${base}/${encodeURIComponent(name)}`
        : assetCapabilityUrl(base, name, config.assetCapabilitySecret);
    },
    exists(name: string): Promise<boolean> {
      const file = assetPath(config.dir, name);
      return Promise.resolve(file !== undefined && existsSync(file));
    },
    list(): Promise<string[]> {
      // A missing directory is an empty catalogue, not a crash: a fresh clone
      // has no `dev-data/`, and refusing to list would break `status` and every
      // validation on a machine that has simply not uploaded anything yet.
      if (!existsSync(config.dir)) {
        return Promise.resolve([]);
      }
      return Promise.resolve(
        readdirSync(config.dir, { withFileTypes: true })
          .filter((entry) => entry.isFile())
          .map((entry) => entry.name)
          .sort(),
      );
    },
    async put(name: string, body: AssetBody): Promise<void> {
      assertWritableAsset(name, body);

      const file = assetPath(config.dir, name);
      // `safeAssetName` is part of `assetPath`, so this should only be
      // unreachable if the two helpers drift. Keep the same typed refusal as
      // the input validation rather than letting fs receive an unsafe path.
      if (file === undefined) {
        throw new AssetWriteError(
          ASSET_WRITE_CODES.invalidName,
          `asset name "${name}" is not a safe file name`,
        );
      }

      mkdirSync(config.dir, { recursive: true });

      try {
        // O_EXCL (`wx`) makes the collision check and creation one operation,
        // so concurrent uploads cannot replace bytes or race into a partial
        // overwrite. Validation happened before opening the file, and a
        // rejected input therefore never leaves an object behind.
        writeFileSync(file, body.bytes, { flag: "wx" });
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code === "EEXIST") {
          throw new AssetWriteError(
            ASSET_WRITE_CODES.alreadyExists,
            `asset "${name}" already exists`,
          );
        }
        throw cause;
      }
    },
    remove(name: string): Promise<boolean> {
      // Through `assetPath`, which carries the containment check: a delete is
      // as able to leave this directory as a write is, and a name that cannot
      // be written here must not be able to unlink somewhere else.
      const file = assetPath(config.dir, name);
      if (file === undefined) {
        return Promise.resolve(false);
      }

      try {
        unlinkSync(file);
        return Promise.resolve(true);
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code === "ENOENT") {
          return Promise.resolve(false);
        }
        throw cause;
      }
    },
  };
}
