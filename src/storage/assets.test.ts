import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  assetCapability,
  assetCapabilityUrl,
  ASSET_CONTENT_TYPES,
  AssetWriteError,
  MAX_ASSET_BYTES,
  MAX_IMAGE_BYTES,
  assetFileName,
  createDiskAssets,
  createMemoryAssets,
  hasAssetCapability,
  newAssetKey,
  storeNewAsset,
} from "./assets.js";
import type { AssetBody, AssetCatalogue } from "./assets.js";

const PDF: AssetBody = {
  bytes: new TextEncoder().encode("%PDF-1.4 resource"),
  contentType: "application/pdf",
};

/**
 * The second writable format, standing where a text resource used to stand.
 *
 * A plain-text asset is no longer a resource this product can have: the
 * platform's media specification names `pdf` and nothing else as a file
 * (REQ-231), so bytes accepted as `text/plain` would have been accepted at
 * upload and refused at delivery. The tests that only needed A SECOND, DIFFERENT
 * body use this one, and the ones that are ABOUT the refusal name it below.
 */
const IMAGE: AssetBody = {
  bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
  contentType: "image/png",
};

describe("REQ-047: the writable memory asset binding", () => {
  it("puts bytes into the catalogue and keeps the public URL contract", async () => {
    const assets = createMemoryAssets();

    await assets.put("guide.pdf", PDF);

    expect(await assets.list()).toEqual(["guide.pdf"]);
    expect(await assets.exists("guide.pdf")).toBe(true);
    expect(await assets.publicUrl("guide.pdf")).toBe(
      "memory://bucket/guide.pdf",
    );
    expect(assets.bodyOf("guide.pdf")?.bytes).toEqual(PDF.bytes);
    expect(assets.bodyOf("guide.pdf")?.contentType).toBe(PDF.contentType);
  });

  it("copies the input bytes so a caller cannot mutate a stored upload", async () => {
    const assets = createMemoryAssets();
    const bytes = new TextEncoder().encode("before");

    await assets.put("note.png", { bytes, contentType: IMAGE.contentType });
    bytes[0] = new TextEncoder().encode("x")[0] ?? 0;

    expect(new TextDecoder().decode(assets.bodyOf("note.png")?.bytes)).toBe(
      "before",
    );
  });

  it("refuses a duplicate without changing the original bytes", async () => {
    const assets = createMemoryAssets();

    await assets.put("guide.pdf", PDF);
    await expect(assets.put("guide.pdf", IMAGE)).rejects.toMatchObject({
      code: "already_exists",
    });

    expect(assets.bodyOf("guide.pdf")?.bytes).toEqual(PDF.bytes);
    expect(await assets.list()).toEqual(["guide.pdf"]);
  });
});

describe("REQ-047: upload validation is shared by both bindings", () => {
  const invalidNames = [
    "",
    ".",
    "..",
    "nested/guide.pdf",
    "..\\guide.pdf",
    "/tmp/guide.pdf",
    "../guide.pdf",
    "guide\n.pdf",
  ];

  it.each(invalidNames)("refuses unsafe name %j in memory", async (name) => {
    const assets = createMemoryAssets();

    await expect(assets.put(name, PDF)).rejects.toMatchObject({
      code: "invalid_name",
    });
    expect(await assets.list()).toEqual([]);
  });

  it("accepts JPEG and PNG beside PDF, and nothing else", async () => {
    const assets = createMemoryAssets();

    for (const [name, contentType] of [
      ["photo.jpg", "image/jpeg"],
      ["image.png", "image/png"],
      ["guide.pdf", "application/pdf"],
    ] as const) {
      await assets.put(name, {
        bytes: new Uint8Array([1, 2, 3]),
        contentType,
      });
    }

    expect(await assets.list()).toEqual([
      "guide.pdf",
      "image.png",
      "photo.jpg",
    ]);
    // The list is asserted EXACTLY, not by membership: what this requirement is
    // about is what the list does NOT contain (REQ-231), and a `toContain` per
    // accepted type would have gone on passing with `image/webp` still in it.
    expect([...ASSET_CONTENT_TYPES]).toEqual([
      "application/pdf",
      "image/jpeg",
      "image/png",
    ]);
  });

  /**
   * REQ-231: a format the platform will not carry is refused HERE.
   *
   * The measured fact, from the official documentation on 2026-08-16
   * (graph.instagram.com v26.0, "Send messages"): image `png` and `jpeg` up to
   * 8 MB, file `pdf` up to 25 MB. WebP is not in it, and it was accepted by
   * this catalogue until 3k.17 — so an operator could upload one, select it,
   * activate the automation, and learn the truth at the delivery, with the
   * contact already waiting.
   */
  const unsendable = [
    // The one this task was written for.
    ["cover.webp", "image/webp"],
    ["animation.gif", "image/gif"],
    // Accepted here until 3k.17 too, and refused by the platform for exactly
    // the same reason: the only file format it names is pdf.
    ["notes.txt", "text/plain"],
    ["rows.csv", "text/csv"],
    ["data.json", "application/json"],
  ] as const;

  it.each(unsendable)(
    "refuses %s at the upload, because the delivery would refuse it",
    async (name, contentType) => {
      const assets = createMemoryAssets();

      await expect(
        assets.put(name, { bytes: new Uint8Array([1, 2, 3]), contentType }),
      ).rejects.toMatchObject({ code: "unsupported_content_type" });
      // And no partial object left behind to be selected later.
      expect(await assets.list()).toEqual([]);
    },
  );

  it("names the accepted formats in the refusal", async () => {
    const assets = createMemoryAssets();

    const failure = (await assets
      .put("cover.webp", {
        bytes: new Uint8Array([1, 2, 3]),
        contentType: "image/webp",
      })
      .catch((error: unknown) => error)) as AssetWriteError;

    // Told only that the format is wrong, the operator's next move is to try
    // another file and find out; told which formats work, their next move is to
    // convert the one they have.
    for (const accepted of ASSET_CONTENT_TYPES) {
      expect(failure.message).toContain(accepted);
    }
  });

  it("refuses an upload over the documented 25 MB ceiling", async () => {
    const assets = createMemoryAssets();

    await expect(
      assets.put("too-large.pdf", {
        bytes: new Uint8Array(MAX_ASSET_BYTES + 1),
        contentType: "application/pdf",
      }),
    ).rejects.toMatchObject({ code: "too_large" });

    expect(await assets.list()).toEqual([]);
  });

  it("meters an IMAGE against its own, tighter 8 MB ceiling", async () => {
    const assets = createMemoryAssets();

    // Same page, same table, a third of the size. Against the file ceiling
    // alone this PNG is accepted at upload and lost at delivery.
    await expect(
      assets.put("huge.png", {
        bytes: new Uint8Array(MAX_IMAGE_BYTES + 1),
        contentType: "image/png",
      }),
    ).rejects.toMatchObject({ code: "too_large" });

    expect(MAX_IMAGE_BYTES).toBeLessThan(MAX_ASSET_BYTES);
    expect(await assets.list()).toEqual([]);
  });

  it("accepts an image exactly at its ceiling", async () => {
    const assets = createMemoryAssets();

    await assets.put("at-the-limit.png", {
      bytes: new Uint8Array(MAX_IMAGE_BYTES),
      contentType: "image/png",
    });

    expect(await assets.list()).toEqual(["at-the-limit.png"]);
  });

  it("exposes a stable typed failure for callers that need to localise it", async () => {
    const assets = createMemoryAssets();

    const failure = await assets
      .put("../secret.pdf", PDF)
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AssetWriteError);
    expect((failure as AssetWriteError).code).toBe("invalid_name");
  });
});

describe("REQ-047: the writable disk asset binding", () => {
  let parent: string;
  let directory: string;
  let assets: AssetCatalogue;

  beforeEach(() => {
    parent = mkdtempSync(join(tmpdir(), "mychat-writable-assets-"));
    directory = join(parent, "assets");
    assets = createDiskAssets({
      dir: directory,
      publicBaseUrl: "https://tunnel.example/assets/",
    });
  });

  afterEach(() => {
    rmSync(parent, { recursive: true, force: true });
  });

  it("creates the directory on first write and survives a fresh binding", async () => {
    expect(existsSync(directory)).toBe(false);

    await assets.put("guide.pdf", PDF);

    expect(Uint8Array.from(readFileSync(join(directory, "guide.pdf")))).toEqual(
      PDF.bytes,
    );
    expect(await assets.list()).toEqual(["guide.pdf"]);
    expect(await assets.publicUrl("guide.pdf")).toBe(
      "https://tunnel.example/assets/guide.pdf",
    );

    const afterRestart = createDiskAssets({
      dir: directory,
      publicBaseUrl: "https://tunnel.example/assets",
    });
    expect(await afterRestart.exists("guide.pdf")).toBe(true);
    expect(await afterRestart.list()).toEqual(["guide.pdf"]);
  });

  it("does not overwrite bytes when the same name is uploaded twice", async () => {
    await assets.put("guide.pdf", PDF);

    await expect(assets.put("guide.pdf", IMAGE)).rejects.toMatchObject({
      code: "already_exists",
    });
    expect(Uint8Array.from(readFileSync(join(directory, "guide.pdf")))).toEqual(
      PDF.bytes,
    );
  });

  it("never writes outside its configured directory", async () => {
    const outside = join(parent, "escaped.png");

    await expect(
      assets.put("../escaped.png", {
        bytes: IMAGE.bytes,
        contentType: IMAGE.contentType,
      }),
    ).rejects.toMatchObject({ code: "invalid_name" });

    expect(existsSync(outside)).toBe(false);
    expect(await assets.exists("../escaped.png")).toBe(false);
    await expect(assets.publicUrl("../escaped.png")).rejects.toThrow();
  });
});

/**
 * Proves REQ-292 at the binding, where "never overwrites" is a fact about the
 * object store rather than a promise the route makes.
 */
describe("REQ-292: the identity of a resource is minted, not typed", () => {
  it("gives two uploads of the same file name two identities", async () => {
    const assets = createMemoryAssets();

    const first = await storeNewAsset(assets, "guide.pdf", PDF);
    const second = await storeNewAsset(assets, "guide.pdf", {
      bytes: new TextEncoder().encode("%PDF-1.4 a different guide"),
      contentType: "application/pdf",
    });

    expect(second.name).not.toBe(first.name);
    expect(first.fileName).toBe("guide.pdf");
    expect(second.fileName).toBe("guide.pdf");
    // The first resource is untouched, which is the whole requirement: an
    // automation already delivered goes on delivering these bytes.
    expect(assets.bodyOf(first.name)?.bytes).toEqual(PDF.bytes);
    expect(await assets.list()).toEqual([first.name, second.name].sort());
  });

  it("keeps the extension last, so the file is still typed by it", async () => {
    const assets = createMemoryAssets();

    const stored = await storeNewAsset(assets, "guide.pdf", PDF);

    expect(stored.name).toMatch(/^guide~[0-9a-f]{8}\.pdf$/);
    expect(await assets.publicUrl(stored.name)).toBe(
      `memory://bucket/${encodeURIComponent(stored.name)}`,
    );
  });

  it("derives the name to show from the key, and leaves other names alone", () => {
    expect(assetFileName(newAssetKey("guide.pdf"))).toBe("guide.pdf");
    expect(assetFileName(newAssetKey("report-12345678.pdf"))).toBe(
      "report-12345678.pdf",
    );
    expect(assetFileName(newAssetKey("no-extension"))).toBe("no-extension");
    // Nothing was minted here: a file that predates the minting shows the name
    // it has, and is selected by the same string it always was.
    expect(assetFileName("existing.pdf")).toBe("existing.pdf");
  });

  it("refuses the operator's own name before minting anything from it", async () => {
    const assets = createMemoryAssets();

    await expect(
      storeNewAsset(assets, "../escape.pdf", PDF),
    ).rejects.toMatchObject({ code: "invalid_name" });
    await expect(
      storeNewAsset(assets, "cover.webp", {
        bytes: IMAGE.bytes,
        contentType: "image/webp",
      }),
    ).rejects.toMatchObject({ code: "unsupported_content_type" });
    expect(await assets.list()).toEqual([]);
  });

  it("mints again rather than replacing when a key is already taken", async () => {
    const assets = createMemoryAssets();
    const taken: string[] = [];
    const put = assets.put.bind(assets);
    let first = true;

    // The collision this loop exists for, made to happen once: a 32-bit token
    // repeating is not something a test can wait for.
    const colliding: AssetCatalogue = {
      ...assets,
      async put(name, body) {
        if (first) {
          first = false;
          taken.push(name);
          throw new AssetWriteError("already_exists", `asset "${name}" exists`);
        }
        taken.push(name);
        return put(name, body);
      },
    };

    const stored = await storeNewAsset(colliding, "guide.pdf", PDF);

    expect(taken).toHaveLength(2);
    expect(stored.name).toBe(taken[1]);
    expect(await assets.list()).toEqual([stored.name]);
  });
});

/** Proves REQ-293's floor: the catalogue can delete, and says what it did. */
describe("REQ-293: deleting one resource from the catalogue", () => {
  it("removes it from the memory binding and reports whether it was there", async () => {
    const assets = createMemoryAssets();
    const stored = await storeNewAsset(assets, "guide.pdf", PDF);

    expect(await assets.remove(stored.name)).toBe(true);
    expect(await assets.exists(stored.name)).toBe(false);
    expect(await assets.list()).toEqual([]);
    expect(assets.bodyOf(stored.name)).toBeUndefined();
    // Twice is not an error, and it is not a second deletion either.
    expect(await assets.remove(stored.name)).toBe(false);
  });

  it("removes the file from disk and never unlinks outside the directory", async () => {
    const parent = mkdtempSync(join(tmpdir(), "mychat-remove-assets-"));
    const directory = join(parent, "assets");
    const assets = createDiskAssets({
      dir: directory,
      publicBaseUrl: "https://tunnel.example/assets",
    });
    const outside = join(parent, "keep.pdf");
    writeFileSync(outside, "%PDF-1.4 not the catalogue's");

    const stored = await storeNewAsset(assets, "guide.pdf", PDF);
    expect(existsSync(join(directory, stored.name))).toBe(true);

    expect(await assets.remove("../keep.pdf")).toBe(false);
    expect(existsSync(outside)).toBe(true);

    expect(await assets.remove(stored.name)).toBe(true);
    expect(existsSync(join(directory, stored.name))).toBe(false);
    expect(await assets.remove(stored.name)).toBe(false);

    rmSync(parent, { recursive: true, force: true });
  });
});

describe("REQ-433: public asset capabilities", () => {
  const SECRET = "asset-link-test-secret";

  it("binds a stable capability to one exact asset name", () => {
    const name = "guide~8f3c1a92.pdf";
    const capability = assetCapability(name, SECRET);

    expect(hasAssetCapability(name, capability, SECRET)).toBe(true);
    expect(hasAssetCapability("other.pdf", capability, SECRET)).toBe(false);
    expect(hasAssetCapability(name, `${capability}x`, SECRET)).toBe(false);
    expect(hasAssetCapability(name, undefined, SECRET)).toBe(false);
  });

  it("builds a public MyChat address without a bucket or object path", () => {
    const address = assetCapabilityUrl(
      "https://mychat.example/assets/",
      "guia da semana.pdf",
      SECRET,
    );
    const url = new URL(address);

    expect(url.origin).toBe("https://mychat.example");
    expect(url.pathname).toBe("/assets/guia%20da%20semana.pdf");
    expect(url.searchParams.get("cap")).toBe(
      assetCapability("guia da semana.pdf", SECRET),
    );
    expect(address).not.toContain("s3");
  });

  it("refuses a name that cannot be safely represented in a public link", () => {
    expect(() =>
      assetCapabilityUrl("https://mychat.example/assets", "../x", SECRET),
    ).toThrow(AssetWriteError);
  });
});
