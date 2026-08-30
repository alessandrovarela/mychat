import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { globSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * Proves REQ-082: every relative import carries an explicit file extension, so
 * the code resolves under Node ESM at runtime.
 *
 * The package is ESM (`"type": "module"`) and there is no bundler in the
 * project, so Node performs no extension guessing: `./ports` is a hard
 * resolution failure at start-up. `tsconfig.json` sets `moduleResolution` to
 * NodeNext, which makes `npm run build` reject an omission — this test is the
 * fast, mapped proof of the same rule, and it names the offending file and
 * specifier instead of failing somewhere inside the compiler's output.
 *
 * The check parses each file and walks its import/export statements, rather
 * than matching text: `src/engine/boundary.test.ts` legitimately carries
 * extensionless imports INSIDE string fixtures fed to the linter, and a
 * text-level regex would flag those.
 */

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

/** A relative specifier is one Node resolves from the importing file's path. */
function isRelative(specifier: string): boolean {
  return specifier.startsWith("./") || specifier.startsWith("../");
}

interface Offender {
  readonly file: string;
  readonly specifier: string;
}

/**
 * Collects every relative import/export specifier that omits the extension.
 * Only the module specifier of a real statement is visited, so string literals
 * elsewhere in the file are never mistaken for imports.
 */
function findOffenders(file: string): Offender[] {
  const source = ts.createSourceFile(
    file,
    readFileSync(file, "utf8"),
    ts.ScriptTarget.ESNext,
    true,
  );

  const offenders: Offender[] = [];

  for (const statement of source.statements) {
    const isModuleStatement =
      ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement);
    if (!isModuleStatement) {
      continue;
    }

    const specifier = statement.moduleSpecifier;
    // `export { x }` with no `from` clause has no specifier to check.
    if (specifier === undefined || !ts.isStringLiteral(specifier)) {
      continue;
    }

    const value = specifier.text;
    if (isRelative(value) && !value.endsWith(".js")) {
      offenders.push({ file: file.replace(repoRoot, ""), specifier: value });
    }
  }

  return offenders;
}

describe("REQ-082: relative imports resolve under Node ESM", () => {
  const files = globSync("{src,tests}/**/*.ts", { cwd: repoRoot }).map(
    (relative) => `${repoRoot}${relative}`,
  );

  it("finds TypeScript sources to check", () => {
    // Guards the check itself: a glob that silently matches nothing would make
    // every assertion below pass while proving nothing.
    expect(files.length).toBeGreaterThan(20);
  });

  it("has no relative import without an explicit extension", () => {
    const offenders = files.flatMap(findOffenders);

    expect(offenders).toStrictEqual([]);
  });
});
