/* global URL, console, process */

import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const defaultConfigPath = resolve(projectRoot, "config/public-allowlist.json");

const forbiddenPathParts = new Set([
  ".helmit",
  ".git",
  "dev-data",
  "mychat-design-system",
]);
const forbiddenFileNames = new Set(["AGENTS.md", "CLAUDE.md", "HANDOFF.md"]);
const privateDocumentation = new Set([
  "docs/analise-ux-automacoes-concorrentes.md",
  "docs/guia-de-testes-fase-3.md",
  "docs/handoff-design.md",
  "docs/meta-app-setup.md",
  "docs/platform-limits.md",
  "docs/prototipo-automacao.html",
]);
const secretPatterns = [
  new RegExp(
    "-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE " + "KEY-----",
    "i",
  ),
  /\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/,
  new RegExp(
    "\\b(?:EAACEdEose0" +
      "cBA|IGQ" +
      "WRP|sk_(?:live|proj)_[A-Za-z0-9]{16,})[A-Za-z0-9_-]*\\b",
    "i",
  ),
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/,
];
const environmentSecretPattern =
  /(?:^|[\n\r])[ \t]*(?:[A-Z][A-Z0-9_]*?(?:TOKEN|SECRET|PASSWORD|API_KEY|PRIVATE_KEY)|DATABASE_URL)[ \t]*=[ \t]*[^\s#][^\n\r#]*/;
const placeholderPattern =
  /(?:example|replace|changeme|your[_ -]?|<[^>]+>|dummy|test[_ -]?only)/i;

function normaliseRelativePath(path) {
  return path.split(sep).join("/");
}

function assertSafeRelativePath(path) {
  if (!path || path.startsWith("/") || path.split("/").includes("..")) {
    throw new Error(
      `public release path must be relative and contained: ${path}`,
    );
  }

  const parts = path.split("/");
  if (
    parts.some((part) => forbiddenPathParts.has(part)) ||
    forbiddenFileNames.has(parts.at(-1)) ||
    path === ".env" ||
    (path.startsWith(".env.") && path !== ".env.example") ||
    privateDocumentation.has(path)
  ) {
    throw new Error(`public release path is forbidden: ${path}`);
  }
}

function parseConfig(configPath = defaultConfigPath) {
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  const { allowedDirectories, allowedFiles, publicRemote, sourceRemote } =
    config;

  if (
    !Array.isArray(allowedDirectories) ||
    !Array.isArray(allowedFiles) ||
    sourceRemote !== "origin" ||
    publicRemote !== "public"
  ) {
    throw new Error("public allowlist has an invalid remote or path schema");
  }

  for (const path of [...allowedFiles, ...allowedDirectories]) {
    if (typeof path !== "string") {
      throw new Error("public allowlist paths must be strings");
    }
    assertSafeRelativePath(path);
  }

  return config;
}

function isAllowed(path, config) {
  return (
    config.allowedFiles.includes(path) ||
    config.allowedDirectories.some(
      (directory) => path === directory || path.startsWith(`${directory}/`),
    )
  );
}

function assertNoSecret(path, content) {
  const patterns =
    path === ".env.example"
      ? [...secretPatterns, environmentSecretPattern]
      : secretPatterns;

  for (const pattern of patterns) {
    const match = content.match(pattern);
    if (match && !placeholderPattern.test(match[0])) {
      throw new Error(`detectable secret in public release file: ${path}`);
    }
  }
}

function listFiles(root) {
  const files = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolutePath = resolve(directory, entry.name);
      const path = normaliseRelativePath(relative(root, absolutePath));

      if (entry.isSymbolicLink()) {
        throw new Error(
          `symbolic links are not allowed in a public release: ${path}`,
        );
      }
      if (entry.isDirectory()) {
        visit(absolutePath);
      } else if (entry.isFile()) {
        files.push(path);
      } else {
        throw new Error(`unsupported public release entry: ${path}`);
      }
    }
  };

  visit(root);
  return files.sort();
}

export function assertRemoteTopology(remotes, config) {
  if (config.sourceRemote !== "origin" || config.publicRemote !== "public") {
    throw new Error(
      "public release must use origin as source and public as destination",
    );
  }
  if (!remotes.origin || !remotes.public || remotes.origin === remotes.public) {
    throw new Error(
      "public release requires distinct origin and public remotes",
    );
  }
}

export function verifyPublicTree(root, config = parseConfig()) {
  const files = listFiles(root);

  for (const path of files) {
    assertSafeRelativePath(path);
    if (!isAllowed(path, config)) {
      throw new Error(`public release file is not allow-listed: ${path}`);
    }
    assertNoSecret(path, readFileSync(resolve(root, path), "utf8"));
  }

  return files;
}

export function preparePublicRelease({
  config = parseConfig(),
  outputDir,
  sourceDir = projectRoot,
}) {
  const source = resolve(sourceDir);
  const output = resolve(outputDir);
  if (source === output || output.startsWith(`${source}${sep}`)) {
    throw new Error(
      "public release output must be outside the private source tree",
    );
  }
  if (existsSync(output)) {
    throw new Error(`public release output must not already exist: ${output}`);
  }

  const staging = mkdtempSync(resolve(tmpdir(), "mychat-public-release-"));
  try {
    for (const path of config.allowedFiles) {
      const sourcePath = resolve(source, path);
      if (existsSync(sourcePath)) {
        if (
          !statSync(sourcePath).isFile() ||
          lstatSync(sourcePath).isSymbolicLink()
        ) {
          throw new Error(`allow-listed entry must be a regular file: ${path}`);
        }
        mkdirSync(resolve(staging, dirname(path)), { recursive: true });
        cpSync(sourcePath, resolve(staging, path));
      }
    }
    for (const directory of config.allowedDirectories) {
      const sourcePath = resolve(source, directory);
      if (existsSync(sourcePath)) {
        if (
          !statSync(sourcePath).isDirectory() ||
          lstatSync(sourcePath).isSymbolicLink()
        ) {
          throw new Error(
            `allow-listed entry must be a directory: ${directory}`,
          );
        }
        cpSync(sourcePath, resolve(staging, directory), {
          errorOnExist: true,
          recursive: true,
        });
      }
    }

    const files = verifyPublicTree(staging, config);
    renameSync(staging, output);
    return files;
  } catch (error) {
    rmSync(staging, { force: true, recursive: true });
    throw error;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [sourceDir, outputDir] = process.argv.slice(2);
  if (!sourceDir || !outputDir) {
    throw new Error(
      "usage: node scripts/public-release.js <private-source> <empty-output>",
    );
  }

  const files = preparePublicRelease({ sourceDir, outputDir });
  console.log(`public release prepared: ${files.length} allow-listed files`);
}
