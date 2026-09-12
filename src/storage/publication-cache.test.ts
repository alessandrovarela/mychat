import {
  existsSync,
  mkdtempSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createDiskThumbnails,
  createMemoryThumbnails,
  THUMBNAIL_PREFIX,
  thumbnailKeyFor,
} from "./publication-cache.js";
import type { ThumbnailBody, ThumbnailStore } from "./publication-cache.js";

/**
 * Proves the half of REQ-118 that lives in the bindings: a store answers for
 * the copies IT holds, and for nothing else.
 *
 * The key is derived from the publication id, so every binding of ADR-016
 * spells it identically. That is what makes a key recorded in the database
 * worthless as proof that a picture can be served: the caller has to ask the
 * store in use, and each store has to answer honestly, including about copies
 * some other binding made under the very same key.
 */

const PUBLICATION_ID = "17895695668004550";

const BODY: ThumbnailBody = {
  bytes: new TextEncoder().encode("pixels"),
  contentType: "image/jpeg",
};

const KEY = thumbnailKeyFor(PUBLICATION_ID, BODY.contentType);

describe("the in-memory thumbnail binding", () => {
  it("holds nothing until a copy is put, and holds it afterwards", async () => {
    const thumbnails = createMemoryThumbnails();

    expect(await thumbnails.has(KEY)).toBe(false);

    await thumbnails.put(KEY, BODY);

    expect(await thumbnails.has(KEY)).toBe(true);
  });

  it("answers for its own process only, so a fresh one holds nothing", async () => {
    const filled = createMemoryThumbnails();
    await filled.put(KEY, BODY);

    // What a restart looks like from in here, and what the real instance did
    // between 02/08 and 03/08: the bytes died with the process, and the key
    // that named them stayed in the table.
    expect(await createMemoryThumbnails().has(KEY)).toBe(false);
  });
});

describe("the disk thumbnail binding", () => {
  let parent: string;
  let directory: string;
  let thumbnails: ThumbnailStore;

  beforeEach(() => {
    parent = mkdtempSync(join(tmpdir(), "mychat-thumb-store-"));
    directory = join(parent, "thumbs");
    thumbnails = createDiskThumbnails({
      dir: directory,
      publicBaseUrl: "https://tunnel.example",
    });
  });

  afterEach(() => {
    rmSync(parent, { recursive: true, force: true });
  });

  it("holds nothing while its directory has never been written to", async () => {
    // `put` is what creates the directory, so its absence is the absence of
    // every copy. This is the observation that identified the defect: the real
    // instance had thirteen keys in the table and no `dev-data/thumbs` at all.
    expect(existsSync(directory)).toBe(false);
    expect(await thumbnails.has(KEY)).toBe(false);
  });

  it("holds the copy it wrote, and stops holding one removed behind its back", async () => {
    await thumbnails.put(KEY, BODY);
    expect(await thumbnails.has(KEY)).toBe(true);

    unlinkSync(join(directory, `${PUBLICATION_ID}.jpg`));

    expect(await thumbnails.has(KEY)).toBe(false);
  });

  it("reads the public origin again when it changes", async () => {
    let origin = "https://first.example";
    const current = createDiskThumbnails({
      dir: directory,
      publicBaseUrl: () => Promise.resolve(origin),
    });
    await current.put(KEY, BODY);

    expect(new URL(await current.publicUrl(KEY)).origin).toBe(
      "https://first.example",
    );
    origin = "https://panel.example";
    expect(new URL(await current.publicUrl(KEY)).origin).toBe(
      "https://panel.example",
    );
  });

  it("does not hold a key it would refuse to write", async () => {
    writeFileSync(join(parent, "escaped.jpg"), BODY.bytes);

    // The file exists, and the answer is still no: containment is decided the
    // same way `put` and `publicUrl` decide it, so a publication id shaped like
    // a path never gets this binding to answer for something outside its
    // directory.
    expect(await thumbnails.has(`${THUMBNAIL_PREFIX}../escaped.jpg`)).toBe(
      false,
    );
    expect(await thumbnails.has("assets/escaped.jpg")).toBe(false);
  });

  it("does not hold a copy another binding made under the same key", async () => {
    const memory = createMemoryThumbnails();
    await memory.put(KEY, BODY);

    // One key, two bindings, two different answers, and this is precisely why
    // the question has to be asked of the binding in use (REQ-118).
    expect(await memory.has(KEY)).toBe(true);
    expect(await thumbnails.has(KEY)).toBe(false);
  });
});
