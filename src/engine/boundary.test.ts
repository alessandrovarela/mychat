import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { ESLint } from "eslint";
import { beforeAll, describe, expect, it } from "vitest";

/**
 * Proves acceptance criterion 5 and the ADR-003 hard rule: the boundary is
 * enforced by the lint gate, not by agreement. ESLint runs here on the real
 * project configuration over snippets that never touch disk, so the rule is
 * checked without parking a deliberately broken file in the source tree.
 */

const projectRoot = fileURLToPath(new URL("../..", import.meta.url));

/** A path inside the engine, used only to select the boundary configuration. */
const engineFile = join(projectRoot, "src/engine/boundary-probe.ts");
const outsideEngineFile = join(projectRoot, "src/http/boundary-probe.ts");

let eslint: ESLint;

beforeAll(() => {
  eslint = new ESLint({ cwd: projectRoot });
});

async function lint(source: string, filePath: string) {
  const [result] = await eslint.lintText(source, { filePath });
  if (result === undefined) {
    throw new Error(`ESLint returned no result for ${filePath}`);
  }
  return result;
}

/** Only the boundary rule matters here, not the rest of the ruleset. */
function boundaryViolations(result: ESLint.LintResult) {
  return result.messages.filter(
    (message) => message.ruleId === "no-restricted-imports",
  );
}

const forbidden = [
  ["the storage layer", "../storage/db", "{ db }"],
  ["the HTTP layer", "../http/server", "{ app }"],
  [
    "the storage layer through a deep relative escape",
    "../../src/storage/db",
    "{ db }",
  ],
  ["Fastify", "fastify", "Fastify"],
  ["Drizzle", "drizzle-orm", "{ drizzle }"],
  ["the SQLite driver", "better-sqlite3", "Database"],
  ["the node SQLite module", "node:sqlite", "{ DatabaseSync }"],
  ["the node HTTP module", "node:http", "{ createServer }"],
  ["the node HTTPS module", "node:https", "{ request }"],
  ["the node socket module", "node:net", "{ Socket }"],
  ["an S3 client", "@aws-sdk/client-s3", "{ S3Client }"],
] as const;

describe("AC 5: the lint gate reports a boundary violation", () => {
  it.each(forbidden)("rejects %s", async (_label, specifier, binding) => {
    const source = `import ${binding} from "${specifier}";`;

    const result = await lint(source, engineFile);
    const [violation] = boundaryViolations(result);

    expect(boundaryViolations(result)).toHaveLength(1);
    expect(violation?.severity).toBe(2);
    // The report identifies the file and the exact import: the message says why,
    // and the position points at the offending statement.
    expect(result.filePath).toBe(engineFile);
    expect(violation?.line).toBe(1);
    expect(violation?.message).toContain(specifier);
    expect(violation?.message).toContain("ADR-003");
    expect(violation?.message).toContain("ports");
  });

  it("rejects a type-only import too, since a type import still crosses the boundary", async () => {
    const result = await lint(
      'import type { Db } from "../storage/db";\nexport type Alias = Db;\n',
      engineFile,
    );

    expect(boundaryViolations(result)).toHaveLength(1);
  });

  it("rejects a re-export of the forbidden layer", async () => {
    const result = await lint(
      'export { db } from "../storage/db";\n',
      engineFile,
    );

    expect(boundaryViolations(result)).toHaveLength(1);
  });
});

describe("the boundary rule leaves legitimate code alone", () => {
  it("accepts ports, sibling engine modules and harmless libraries", async () => {
    const source = [
      'import { readFileSync } from "node:fs";',
      'import { z } from "zod";',
      'import type { Clock } from "./ports";',
      'import { decideNextStep } from "./decide";',
      "",
      "export const noop = { readFileSync, z, decideNextStep };",
      "export type Injected = Clock;",
      "",
    ].join("\n");

    const result = await lint(source, engineFile);

    expect(result.messages).toStrictEqual([]);
  });

  it("does not restrict files outside the engine", async () => {
    const result = await lint(
      'import Fastify from "fastify";\nimport { db } from "../storage/db";\nexport const server = { Fastify, db };\n',
      outsideEngineFile,
    );

    expect(
      result.messages.filter(
        (message) => message.ruleId === "no-restricted-imports",
      ),
    ).toStrictEqual([]);
  });
});
