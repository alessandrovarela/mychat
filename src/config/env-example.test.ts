import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DECLARED_ENV_VARIABLES, REFUSED_ENV_VARIABLES } from "./env.js";
import { AUTH_THROTTLE_ENV_VARIABLES, LIMIT_ENV_VARIABLES } from "./limits.js";

const EXAMPLE_URL = new URL("../../.env.example", import.meta.url);

function readExample(): string {
  return readFileSync(EXAMPLE_URL, "utf8");
}

function exampleAssignments(): { key: string; value: string }[] {
  return readExample()
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"))
    .map((line) => {
      const separator = line.indexOf("=");
      return {
        key: line.slice(0, separator),
        value: line.slice(separator + 1),
      };
    });
}

/** Every name the application declares, whatever file declares it. */
const DECLARED = [
  ...DECLARED_ENV_VARIABLES,
  ...Object.values(LIMIT_ENV_VARIABLES),
  ...Object.values(AUTH_THROTTLE_ENV_VARIABLES),
];

/**
 * Proves AC 18: the example file and the variables the code actually reads are
 * the same set. Without this test the example rots in silence, and a
 * self-hoster discovers a missing key only when the process refuses to start.
 */
describe("AC 18: .env.example stays in sync with the code", () => {
  const keys = exampleAssignments().map((assignment) => assignment.key);

  it("declares every variable the environment schema knows about", () => {
    for (const variable of DECLARED_ENV_VARIABLES) {
      expect(keys).toContain(variable);
    }
  });

  it("declares every platform limit override variable", () => {
    for (const variable of Object.values(LIMIT_ENV_VARIABLES)) {
      expect(keys).toContain(variable);
    }
  });

  it("declares every authentication ceiling variable", () => {
    for (const variable of Object.values(AUTH_THROTTLE_ENV_VARIABLES)) {
      expect(keys).toContain(variable);
    }
  });

  it("declares nothing the code does not read", () => {
    const known = new Set<string>(DECLARED);

    expect(keys.filter((key) => !known.has(key))).toEqual([]);
  });

  it("lists each key exactly once", () => {
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("carries keys with no values, so no secret is versioned (AC 17)", () => {
    for (const assignment of exampleAssignments()) {
      expect(assignment.value).toBe("");
    }
  });

  it("never offers a key whose very existence is refused (REQ-033)", () => {
    // A password in the environment is refused at start-up. Listing one here
    // would invite the exact mistake that refusal exists to stop.
    for (const refused of REFUSED_ENV_VARIABLES) {
      expect(keys).not.toContain(refused);
    }
  });
});

/* ------------------------------------------------------------------- guard */

/**
 * Proves REQ-108: a variable read anywhere in the code is declared in the
 * configuration, and a read of an undeclared one fails this suite.
 *
 * The list above only compares two lists with each other, which is exactly how
 * seven variables came to be read for months without ever appearing in either:
 * `MYCHAT_LOCALE`, `SESSION_COOKIE_SECURE` and the five `AUTH_*` of the
 * authentication ceiling. Nothing compared the code against the declaration,
 * so nothing could notice. This is that comparison, and it starts from the
 * code.
 */

const SOURCE_ROOT = new URL("../", import.meta.url);

/**
 * Test files are NOT scanned, and the reason is that they build environments
 * that must not exist: `limits.test.ts` names `MESSAGES_PER_HOUR` precisely to
 * prove that no such variable is configured, and `env.test.ts` writes into
 * `process.env` to prove the loader ignores it. Scanning them would turn every
 * one of those proofs into a failure here.
 */
function isScanned(name: string): boolean {
  return /\.tsx?$/.test(name) && !/\.test\.tsx?$|^test-setup\.ts$/.test(name);
}

function sourceFiles(directory: URL): URL[] {
  const found: URL[] = [];

  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      found.push(...sourceFiles(new URL(`${entry.name}/`, directory)));
      continue;
    }

    if (isScanned(entry.name)) {
      found.push(new URL(entry.name, directory));
    }
  }

  return found;
}

/**
 * A read with the name written at the point of it: `process.env.NAME`,
 * `process.env["NAME"]`, `env["NAME"]`, `deps.env["NAME"]`. The receiver is
 * `process.env` or anything whose last segment is `env`, which is how every
 * module that takes the environment as an argument names its parameter.
 */
const LITERAL_READ =
  /(?:process\.env|(?:[\w$]+\.)?\benv)\s*(?:\.\s*([A-Za-z_$][\w$]*)|\[\s*["']([^"'`]+)["']\s*\])/g;

/**
 * A read through a constant: `env[COOKIE_SECURE_VARIABLE]`. The name is not at
 * the read site, so it is resolved from the constant that holds it.
 */
const IDENTIFIER_READ =
  /(?:process\.env|(?:[\w$]+\.)?\benv)\s*\[\s*([A-Za-z_$][\w$]*)\s*\]/g;

/**
 * A constant that holds variable NAMES, single or in a table:
 * `COOKIE_SECURE_VARIABLE`, `LIMIT_ENV_VARIABLES`. The convention is the
 * project's own, and the test below refuses any indirect read that does not
 * follow it, so it cannot quietly become optional.
 */
const NAME_HOLDER = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*VARIABLES?)\b/g;

/** The shape of an environment variable name, and nothing else. */
const ENV_NAME = /^[A-Z][A-Z0-9_]*$/;

/** Every string literal of that shape inside one declaration. */
const NAME_LITERAL = /["']([A-Z][A-Z0-9_]*)["']/g;

interface Read {
  readonly file: string;
  readonly name: string;
}

interface Unresolved {
  readonly file: string;
  readonly identifier: string;
}

interface Scan {
  readonly reads: Read[];
  readonly unresolved: Unresolved[];
}

/**
 * Reads every source file and reports which environment variables it reads.
 *
 * What it cannot see, stated plainly because a guard whose blind spots are
 * unwritten is a guard nobody can trust: a name assembled at runtime (a
 * concatenation, a template) is invisible to it. The two shapes above are the
 * ones this codebase uses, and the second test turns any other indirect shape
 * into a failure rather than a silent pass.
 */
function scanSources(): Scan {
  const reads: Read[] = [];
  const unresolved: Unresolved[] = [];
  const holders = new Map<string, string[]>();
  const files = sourceFiles(SOURCE_ROOT).map((url) => ({
    name: url.pathname.slice(SOURCE_ROOT.pathname.length),
    text: readFileSync(url, "utf8"),
  }));

  // First pass: the constants that hold names, so an indirect read can be
  // resolved no matter which file declares the constant it goes through.
  for (const file of files) {
    for (const declaration of file.text.matchAll(NAME_HOLDER)) {
      const identifier = declaration[1] ?? "";
      // The declaration ends at the first `;` that closes a line, which is
      // where a formatted table, array or single literal ends.
      const from = declaration.index;
      const to = file.text.indexOf(";\n", from);
      const initialiser = file.text.slice(
        from,
        to === -1 ? file.text.length : to,
      );

      const names = [...initialiser.matchAll(NAME_LITERAL)].map(
        (literal) => literal[1] ?? "",
      );

      holders.set(identifier, names);

      for (const name of names) {
        reads.push({ file: file.name, name });
      }
    }
  }

  for (const file of files) {
    for (const read of file.text.matchAll(LITERAL_READ)) {
      const name = read[1] ?? read[2] ?? "";
      // A property access that is not a variable name (`env.hasOwnProperty`)
      // is not a read of configuration.
      if (ENV_NAME.test(name)) {
        reads.push({ file: file.name, name });
      }
    }

    for (const read of file.text.matchAll(IDENTIFIER_READ)) {
      const identifier = read[1] ?? "";

      // A lowercase identifier is a parameter or a loop variable fed from a
      // table, and the table itself was resolved in the first pass. An
      // UPPERCASE one is a module constant, and it must be a constant this
      // scan can read the name out of.
      if (!/^[A-Z]/.test(identifier)) {
        continue;
      }

      if ((holders.get(identifier) ?? []).length === 0) {
        unresolved.push({ file: file.name, identifier });
      }
    }
  }

  return { reads, unresolved };
}

describe("REQ-108: no variable is read without being declared", () => {
  const { reads, unresolved } = scanSources();

  /**
   * Variables of the RUNTIME, not of this product. `NODE_ENV` is set by Node
   * and by the tooling, never by the operator's `.env`, and is read only to
   * decide the default of the session cookie; `VITEST` and `CI` are set by the
   * test runner and by the pipeline. Declaring them would list them in
   * `.env.example` and invite an operator to set a variable this application
   * does not own.
   */
  const RUNTIME_ENV_VARIABLES = ["NODE_ENV", "VITEST", "CI"];

  /**
   * Refused names are declared too, just not as configuration: they are the
   * names that must NOT exist (REQ-033), read only to refuse the start when one
   * of them is set.
   */
  const ALLOWED = new Set<string>([
    ...DECLARED,
    ...REFUSED_ENV_VARIABLES,
    ...RUNTIME_ENV_VARIABLES,
  ]);

  it("sees the reads that are actually there", () => {
    // Guards the guard: a scan that matched nothing would pass every assertion
    // below while proving nothing at all. Each of these is read in a different
    // shape, in a different file: `env["NODE_ENV"]` and `process.env["..."]`
    // literally, `deps.env[INITIAL_LOCALE_VARIABLE]` and
    // `env[COOKIE_SECURE_VARIABLE]` through a constant, and the ceiling
    // through a table of them.
    const names = new Set(reads.map((read) => read.name));

    expect(names).toContain("NODE_ENV");
    expect(names).toContain("DATABASE_PATH");
    expect(names).toContain("MYCHAT_LOCALE");
    expect(names).toContain("SESSION_COOKIE_SECURE");
    expect(names).toContain("AUTH_TRUSTED_PROXY_HOPS");
  });

  it("declares every variable the code reads", () => {
    const undeclared = reads
      .filter((read) => !ALLOWED.has(read.name))
      .map((read) => `${read.file}: ${read.name}`);

    expect([...new Set(undeclared)]).toEqual([]);
  });

  it("resolves every name a read goes through", () => {
    // An indirect read whose constant this scan cannot open is a hole in it:
    // the name would never be checked against the declaration. Naming the
    // constant `*_VARIABLE` (or `*_VARIABLES` for a table) is what closes it.
    const opaque = unresolved.map(
      (read) => `${read.file}: env[${read.identifier}]`,
    );

    expect(opaque).toEqual([]);
  });

  it("lists in the example every variable the code reads", () => {
    // The other half of REQ-108, from the code's side: being declared is not
    // enough, the operator has to be able to find it. Runtime and refused
    // names are excluded, since neither belongs in the example.
    const keys = new Set(
      exampleAssignments().map((assignment) => assignment.key),
    );
    const excluded = new Set([
      ...RUNTIME_ENV_VARIABLES,
      ...REFUSED_ENV_VARIABLES,
    ]);

    const missing = reads
      .filter((read) => !excluded.has(read.name) && !keys.has(read.name))
      .map((read) => `${read.file}: ${read.name}`);

    expect([...new Set(missing)]).toEqual([]);
  });
});
