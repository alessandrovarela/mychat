/* global URL, console, process */

import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertPublicationContext,
  preparePublicRelease,
} from "./public-release.js";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));

function runGit(args, { cwd, allowFailure = false } = {}) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.error || (!allowFailure && result.status !== 0)) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr.trim()}`);
  }
  return { status: result.status, stdout: result.stdout.trim() };
}

function gitOutput(git, args, cwd) {
  return git(args, { cwd }).stdout;
}

function publicAllowlist(root) {
  return JSON.parse(
    readFileSync(resolve(root, "config/public-allowlist.json"), "utf8"),
  );
}

function sourceContext({ config, git, sourceDir }) {
  return {
    branch: gitOutput(git, ["branch", "--show-current"], sourceDir),
    remotes: {
      [config.sourceRemote]: gitOutput(
        git,
        ["remote", "get-url", config.sourceRemote],
        sourceDir,
      ),
      [config.publicRemote]: gitOutput(
        git,
        ["remote", "get-url", config.publicRemote],
        sourceDir,
      ),
    },
  };
}

function assertPublicCheckout({ config, git, publicDir, publicRemote }) {
  if (!existsSync(resolve(publicDir, ".git"))) {
    throw new Error(
      "public publish destination must be an existing Git checkout",
    );
  }
  if (
    gitOutput(git, ["branch", "--show-current"], publicDir) !==
    config.sourceBranch
  ) {
    throw new Error(
      "public publish destination is not on the authorized branch",
    );
  }
  if (
    gitOutput(git, ["remote", "get-url", "origin"], publicDir) !== publicRemote
  ) {
    throw new Error(
      "public publish destination does not match the configured public remote",
    );
  }
  if (gitOutput(git, ["status", "--porcelain"], publicDir)) {
    throw new Error(
      "public publish destination must be clean before synchronization",
    );
  }
}

function synchronizePublicTree(source, destination) {
  for (const entry of readdirSync(destination)) {
    if (entry !== ".git") {
      rmSync(resolve(destination, entry), { force: true, recursive: true });
    }
  }
  for (const entry of readdirSync(source)) {
    cpSync(resolve(source, entry), resolve(destination, entry), {
      recursive: true,
    });
  }
}

export function publishPublicRelease({
  config,
  git = runGit,
  publicDir,
  sourceDir = projectRoot,
  synchronize = synchronizePublicTree,
}) {
  const context = sourceContext({ config, git, sourceDir });
  assertPublicationContext(context, config);
  assertPublicCheckout({
    config,
    git,
    publicDir,
    publicRemote: context.remotes[config.publicRemote],
  });

  const stagingRoot = mkdtempSync(resolve(tmpdir(), "mychat-public-publish-"));
  const stagingTree = resolve(stagingRoot, "tree");
  try {
    const files = preparePublicRelease({
      config,
      outputDir: stagingTree,
      sourceDir,
    });
    synchronize(stagingTree, publicDir);
    git(["add", "--all"], { cwd: publicDir });
    const staged = git(["diff", "--cached", "--quiet"], {
      allowFailure: true,
      cwd: publicDir,
    });
    if (staged.status === 0) {
      return { files, published: false };
    }
    git(["commit", "-m", "chore: sync public release"], { cwd: publicDir });
    git(["push", "origin", config.sourceBranch], { cwd: publicDir });
    return { files, published: true };
  } finally {
    rmSync(stagingRoot, { force: true, recursive: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [publicDir] = process.argv.slice(2);
  if (!publicDir) {
    throw new Error("usage: node scripts/public-publish.js <public-checkout>");
  }
  const result = publishPublicRelease({
    config: publicAllowlist(projectRoot),
    publicDir: resolve(publicDir),
  });
  console.log(
    result.published
      ? `public release published: ${result.files.length} files`
      : "public release already matches the derived tree",
  );
}
