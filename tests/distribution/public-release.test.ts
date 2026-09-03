import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertRemoteTopology,
  preparePublicRelease,
  verifyPublicTree,
} from "../../scripts/public-release.js";

const projectRoot = resolve(import.meta.dirname, "../..");
const config = JSON.parse(
  readFileSync(resolve(projectRoot, "config/public-allowlist.json"), "utf8"),
);
const temporaryDirectories: string[] = [];

function temporaryDirectory() {
  const directory = mkdtempSync(
    resolve(tmpdir(), "mychat-public-release-test-"),
  );
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("public release allowlist", () => {
  it("allows the two public Meta guides but excludes the internal topology", () => {
    expect(config.allowedFiles).toEqual(
      expect.arrayContaining([
        "docs/meta-app-setup.md",
        "docs/meta-app-setup.en.md",
      ]),
    );
    expect(config.allowedFiles).not.toContain("docs/meta-environments.md");
  });

  it("derives a clean public tree from explicit files and directories only", () => {
    const source = temporaryDirectory();
    const output = resolve(temporaryDirectory(), "public");
    mkdirSync(resolve(source, "src"), { recursive: true });
    mkdirSync(resolve(source, ".helmit"), { recursive: true });
    writeFileSync(resolve(source, "package.json"), '{"name":"mychat"}\n');
    writeFileSync(resolve(source, ".prettierignore"), "*.md\n");
    writeFileSync(
      resolve(source, ".env.example"),
      "META_APP_SECRET=\nWEBHOOK_VERIFY_TOKEN=\nMETA_TOKEN=replace-me\n",
    );
    writeFileSync(
      resolve(source, "src/index.ts"),
      "export const version = 1;\n",
    );
    writeFileSync(
      resolve(source, ".helmit/STATE.md"),
      "private process state\n",
    );
    writeFileSync(resolve(source, ".env"), "META_TOKEN=real-token\n");

    expect(
      preparePublicRelease({ config, outputDir: output, sourceDir: source }),
    ).toEqual([
      ".env.example",
      ".prettierignore",
      "package.json",
      "src/index.ts",
    ]);
    expect(readFileSync(resolve(output, ".prettierignore"), "utf8")).toBe(
      "*.md\n",
    );
    expect(readFileSync(resolve(output, ".env.example"), "utf8")).toContain(
      "replace-me",
    );
    expect(readFileSync(resolve(output, ".env.example"), "utf8")).toContain(
      "META_APP_SECRET=\nWEBHOOK_VERIFY_TOKEN=",
    );
    expect(readFileSync(resolve(output, "src/index.ts"), "utf8")).toContain(
      "version",
    );
    expect(
      JSON.parse(readFileSync(resolve(output, "package.json"), "utf8")),
    ).toMatchObject({
      private: false,
      scripts: { test: "MYCHAT_PUBLIC_RELEASE=1 vitest run" },
    });
    expect(() =>
      readFileSync(resolve(output, ".helmit/STATE.md"), "utf8"),
    ).toThrow();
    expect(() => readFileSync(resolve(output, ".env"), "utf8")).toThrow();
  });

  it("rejects process artifacts, unapproved files, and detectable secrets before release", () => {
    const tree = temporaryDirectory();
    mkdirSync(resolve(tree, ".helmit"), { recursive: true });
    writeFileSync(resolve(tree, ".helmit/STATE.md"), "private process state\n");
    expect(() => verifyPublicTree(tree, config)).toThrow("forbidden");

    rmSync(resolve(tree, ".helmit"), { force: true, recursive: true });
    writeFileSync(
      resolve(tree, "internal-notes.txt"),
      "not for public release\n",
    );
    expect(() => verifyPublicTree(tree, config)).toThrow("not allow-listed");

    rmSync(resolve(tree, "internal-notes.txt"));
    writeFileSync(
      resolve(tree, ".env.example"),
      "API_TOKEN=super-secret-value\n",
    );
    expect(() => verifyPublicTree(tree, config)).toThrow("detectable secret");
  });

  it("requires origin as private source and public as a distinct destination", () => {
    expect(() =>
      assertRemoteTopology(
        { origin: "git@github.com:owner/mychat-lab.git" },
        config,
      ),
    ).toThrow("distinct origin and public remotes");
    expect(() =>
      assertRemoteTopology(
        {
          origin: "git@github.com:owner/mychat-lab.git",
          public: "git@github.com:owner/mychat.git",
        },
        { ...config, publicRemote: "upstream" },
      ),
    ).toThrow("origin as source and public as destination");
    expect(() =>
      assertRemoteTopology(
        {
          origin: "git@github.com:owner/mychat-lab.git",
          public: "git@github.com:owner/mychat.git",
        },
        config,
      ),
    ).not.toThrow();
  });
});
