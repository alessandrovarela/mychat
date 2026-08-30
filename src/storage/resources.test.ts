import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDiskAssets, createMemoryAssets } from "./assets.js";
import { createContactRepository } from "./contacts.js";
import { IN_MEMORY_DATABASE, openDatabase } from "./database.js";
import type { DatabaseHandle } from "./database.js";

/**
 * Proves REQ-020, REQ-021 and REQ-028.
 *
 * The three belong together because they are the same mistake seen from three
 * angles: a resource resolved too early is a dead link, a resource that never
 * existed is a delivery that fails mid-conversation, and an attribute that does
 * not survive a restart is a contact asked twice for the same thing.
 */

const T0 = new Date("2026-08-01T10:00:00.000Z");
const T1 = new Date("2026-08-01T11:00:00.000Z");

describe("REQ-020: the resource URL is resolved at send time", () => {
  it("gives the URL in force now, not the one in force at load", async () => {
    const assets = createMemoryAssets({ guide: "https://cdn.example/v1.pdf" });

    // "Load time": the flow is bound, and the asset NAME travels, not a URL.
    const atLoad = await assets.publicUrl("guide");

    // The resource is replaced while the execution is under way.
    assets.set("guide", "https://cdn.example/v2.pdf");
    const atSend = await assets.publicUrl("guide");

    expect(atLoad).toBe("https://cdn.example/v1.pdf");
    // Resolving early would have delivered the old URL. Platform media URLs
    // expire, which is why early resolution delivers dead links.
    expect(atSend).toBe("https://cdn.example/v2.pdf");
  });

  it("refuses to invent a URL for a resource that vanished", async () => {
    const assets = createMemoryAssets({ guide: "https://cdn.example/v1.pdf" });

    expect(await assets.exists("guide")).toBe(true);
    expect(() => assets.publicUrl("missing")).toThrow(/missing/);
  });
});

describe("REQ-020: the disk binding", () => {
  let directory: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "mychat-assets-"));
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  it("resolves a file that exists under the public prefix", async () => {
    writeFileSync(join(directory, "guide.pdf"), "%PDF-1.4");
    const assets = createDiskAssets({
      dir: directory,
      publicBaseUrl: "https://tunnel.example/assets/",
    });

    expect(await assets.publicUrl("guide.pdf")).toBe(
      "https://tunnel.example/assets/guide.pdf",
    );
    expect(await assets.list()).toEqual(["guide.pdf"]);
  });

  it("treats a missing directory as an empty catalogue, not a crash", async () => {
    // A fresh clone has no dev-data/. Refusing to list would break `status` and
    // every validation on a machine that has simply uploaded nothing yet.
    const assets = createDiskAssets({
      dir: join(directory, "not-created"),
      publicBaseUrl: "https://tunnel.example/assets",
    });

    expect(await assets.list()).toEqual([]);
    expect(await assets.exists("guide.pdf")).toBe(false);
  });

  it("ignores directories when listing", async () => {
    mkdirSync(join(directory, "nested"));
    writeFileSync(join(directory, "guide.pdf"), "%PDF-1.4");
    const assets = createDiskAssets({
      dir: directory,
      publicBaseUrl: "https://tunnel.example/assets",
    });

    expect(await assets.list()).toEqual(["guide.pdf"]);
  });
});

describe("REQ-028: attributes outlive the execution that wrote them", () => {
  let handle: DatabaseHandle;

  afterEach(() => {
    handle.close();
  });

  it("reads back an attribute written by another execution", async () => {
    handle = openDatabase({ databasePath: IN_MEMORY_DATABASE });
    const contacts = createContactRepository(handle.db, () => T0);

    await contacts.setAttribute("contact-1", "email", "a@example.com");

    expect(await contacts.getAttributes("contact-1")).toEqual({
      email: "a@example.com",
    });
  });

  it("keeps a boolean a boolean, and a number a number", async () => {
    handle = openDatabase({ databasePath: IN_MEMORY_DATABASE });
    const contacts = createContactRepository(handle.db, () => T0);

    await contacts.setAttribute("contact-1", "confirmed", false);
    await contacts.setAttribute("contact-1", "attempts", 2);

    // `false` stored as the string "false" is truthy, and would silently
    // invert a branch that reads it.
    expect(await contacts.getAttributes("contact-1")).toEqual({
      confirmed: false,
      attempts: 2,
    });
  });

  it("overwrites a key instead of accumulating rows", async () => {
    handle = openDatabase({ databasePath: IN_MEMORY_DATABASE });
    const contacts = createContactRepository(handle.db, () => T0);

    await contacts.setAttribute("contact-1", "stage", "asked");
    await contacts.setAttribute("contact-1", "stage", "confirmed");

    expect(await contacts.getAttributes("contact-1")).toEqual({
      stage: "confirmed",
    });
  });

  it("keeps contacts apart", async () => {
    handle = openDatabase({ databasePath: IN_MEMORY_DATABASE });
    const contacts = createContactRepository(handle.db, () => T0);

    await contacts.setAttribute("contact-1", "email", "a@example.com");
    await contacts.setAttribute("contact-2", "email", "b@example.com");

    expect(await contacts.getAttributes("contact-2")).toEqual({
      email: "b@example.com",
    });
  });
});

describe("REQ-028: attributes survive the process", () => {
  let directory: string;
  let databasePath: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "mychat-contacts-"));
    databasePath = join(directory, "mychat.db");
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  it("is readable by a later execution after a restart", async () => {
    const before = openDatabase({ databasePath });
    await createContactRepository(before.db, () => T0).setAttribute(
      "contact-1",
      "confirmed",
      true,
    );
    before.close();

    const after = openDatabase({ databasePath });
    const attributes = await createContactRepository(
      after.db,
      () => T1,
    ).getAttributes("contact-1");

    // Held in memory this would be forgotten by the next deploy, and the
    // contact would be asked again for something they already answered.
    expect(attributes).toEqual({ confirmed: true });
    after.close();
  });
});
