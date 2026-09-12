import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { publishPublicRelease } from "../../scripts/public-publish.js";

const temporaryDirectories: string[] = [];
const projectRoot = resolve(import.meta.dirname, "../..");
const config = JSON.parse(
  readFileSync(resolve(projectRoot, "config/public-allowlist.json"), "utf8"),
);

function temporaryDirectory() {
  const directory = mkdtempSync(
    resolve(tmpdir(), "mychat-public-publish-test-"),
  );
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

function gitFor({
  branch = "main",
  publicRemote = "git@github.com:owner/mychat.git",
  publicDir,
}: {
  branch?: string;
  publicDir?: string;
  publicRemote?: string;
} = {}) {
  const calls: string[] = [];
  const git = (args: string[], { cwd }: { cwd?: string } = {}) => {
    calls.push(args.join(" "));
    const command = args.join(" ");
    if (command === "branch --show-current")
      return { status: 0, stdout: branch };
    if (command === "remote get-url origin") {
      return {
        status: 0,
        stdout:
          cwd === publicDir
            ? publicRemote
            : "git@github.com:owner/mychat-dev.git",
      };
    }
    if (command === "remote get-url public")
      return { status: 0, stdout: publicRemote };
    if (command === "status --porcelain") return { status: 0, stdout: "" };
    if (command === "diff --cached --quiet") return { status: 1, stdout: "" };
    return { status: 0, stdout: "" };
  };
  return { calls, git };
}

describe("guarded public publisher", () => {
  it("refuses an unauthorized source branch before touching the public checkout", () => {
    const publicDir = temporaryDirectory();
    mkdirSync(resolve(publicDir, ".git"));
    const { calls, git } = gitFor({
      branch: "feature/unsafe",
      publicDir,
    });

    expect(() =>
      publishPublicRelease({
        config,
        git,
        publicDir,
        synchronize: () => {
          throw new Error("must not synchronize");
        },
      }),
    ).toThrow("authorized source branch");
    expect(calls).not.toContain("add --all");
  });

  it("pushes only after source and destination checks pass", () => {
    const publicDir = temporaryDirectory();
    mkdirSync(resolve(publicDir, ".git"));
    const { calls, git } = gitFor({ publicDir });

    expect(
      publishPublicRelease({ config, git, publicDir, sourceDir: projectRoot }),
    ).toMatchObject({ published: true });
    expect(calls).toContain("push origin main");
  });
});
