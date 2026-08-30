import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Proves REQ-041: the repository carries the MIT licence file and declares the
 * licence in the manifest. Both halves matter: a LICENSE nobody declares is
 * invisible to tooling, and a declaration with no file is a promise with no
 * text behind it.
 */
describe("REQ-041: MIT licence", () => {
  it("ships a LICENSE file with the MIT text", () => {
    const licence = readFileSync(
      new URL("../LICENSE", import.meta.url),
      "utf8",
    );

    expect(licence).toContain("MIT License");
    expect(licence).toContain("Permission is hereby granted, free of charge");
    expect(licence).toContain('THE SOFTWARE IS PROVIDED "AS IS"');
  });

  it("declares the licence in the manifest", () => {
    const manifest: unknown = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    );

    expect(manifest).toMatchObject({ license: "MIT" });
  });
});
