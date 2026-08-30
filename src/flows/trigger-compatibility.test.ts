import { globSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * Proves REQ-170: the trigger type has ONE declaration in the source.
 *
 * The type is `AutomationTrigger["type"]`, and it is the answer to "what can
 * start an automation". The listing screen used to derive the same answer a
 * second time from the other end of the same union
 * (`Automation["trigger"]["type"]`, in `web/screens/automations.tsx`). Equal
 * today, and that is the whole trouble: nothing failed while the two agreed, so
 * the day a third trigger arrives and only one of the two spellings is taught
 * about it, the disagreement lands in a screen rather than in a test.
 *
 * The guard lives HERE, beside the declaration it protects, for the same reason
 * `styles/tokens.test.ts` sits beside the token sheet and `i18n/catalogue.test.ts`
 * beside the catalogues: a rule about a file is read by whoever opens that file,
 * and a contributor who redeclares the type in a screen meets the failure
 * without having to know a repository-wide suite exists. It stays in the domain
 * rather than in `tests/` because `flows/` is where the type is declared and
 * where the requirement's own verification runs, and because a guard that lived
 * outside the module it defends would be the first thing a rename orphans.
 *
 * The sweep PARSES instead of matching text, which is what makes it usable: the
 * screens legitimately carry `import type { TriggerType }`, `export type
 * { TriggerType }` and dozens of usages, and every one of those is a mention of
 * the name that a regular expression would report as a declaration. Only a node
 * that BINDS the name counts, so a comment and a string are invisible on their
 * own, being trivia and data rather than declarations.
 */

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

/** The name under guard, written once so the report can quote it. */
const TRIGGER_TYPE = "TriggerType";

/** The module allowed to declare it: the domain, which derives it from schema. */
const DECLARING_MODULE = "src/flows/trigger-compatibility.ts";

/** Where a declaration was found, as a line a reader can open. */
interface Declaration {
  readonly file: string;
  readonly line: number;
  readonly kind: string;
}

/**
 * The four ways TypeScript binds a TYPE to a name, and nothing else.
 *
 * An import specifier, an export specifier and a type reference all carry the
 * name without binding it, which is exactly the difference this guard is about.
 */
function bindsTriggerType(node: ts.Node): string | undefined {
  if (ts.isTypeAliasDeclaration(node) && node.name.text === TRIGGER_TYPE) {
    return "type alias";
  }

  if (ts.isInterfaceDeclaration(node) && node.name.text === TRIGGER_TYPE) {
    return "interface";
  }

  if (ts.isEnumDeclaration(node) && node.name.text === TRIGGER_TYPE) {
    return "enum";
  }

  if (ts.isClassDeclaration(node) && node.name?.text === TRIGGER_TYPE) {
    return "class";
  }

  return undefined;
}

/**
 * `.tsx` is parsed as TSX and `.ts` is not, because the two grammars disagree:
 * `<T>value` is a type assertion in one and an element in the other, and the
 * wrong choice turns a real file into a parse error the sweep would then read
 * as "no declarations here".
 */
function scriptKindOf(file: string): ts.ScriptKind {
  return file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
}

/**
 * Every declaration of the name in one file, wherever it sits.
 *
 * The whole tree is walked rather than the top-level statements alone: a type
 * declared inside a function, a namespace or a block is still a second source
 * of truth, and it is the shape a redeclaration takes when someone means it to
 * be "local".
 */
function declarationsIn(file: string, text: string): readonly Declaration[] {
  const source = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.ESNext,
    true,
    scriptKindOf(file),
  );

  const found: Declaration[] = [];

  const visit = (node: ts.Node): void => {
    const kind = bindsTriggerType(node);

    if (kind !== undefined) {
      const { line } = source.getLineAndCharacterOfPosition(
        node.getStart(source),
      );

      found.push({ file, line: line + 1, kind });
    }

    ts.forEachChild(node, visit);
  };

  visit(source);

  return found;
}

/** A finding, as `path:line (kind)`, so a failure names what to open. */
function where({ file, line, kind }: Declaration): string {
  return `${file}:${line} (${kind})`;
}

/** Every source of the project, by repository path, sorted for a stable report. */
const SOURCES: readonly (readonly [string, string])[] = globSync(
  "{src,tests}/**/*.{ts,tsx}",
  { cwd: repoRoot },
)
  .map((relative): readonly [string, string] => [
    relative.split("\\").join("/"),
    readFileSync(`${repoRoot}${relative}`, "utf8"),
  ])
  .sort(([a], [b]) => a.localeCompare(b));

describe("REQ-170: the automation trigger type is declared once", () => {
  it("sweeps the sources it claims to sweep", () => {
    // Guards the guard: a glob that silently matched nothing, or a read that
    // returned empty files, would make every assertion below pass forever.
    const paths = SOURCES.map(([path]) => path);

    expect(paths.length).toBeGreaterThan(20);
    expect(paths).toContain(DECLARING_MODULE);
    expect(paths).toContain("src/web/screens/automations.tsx");
    expect(paths).toContain("src/web/screens/automation-form.tsx");

    for (const [path, text] of SOURCES) {
      expect(text.length, path).toBeGreaterThan(0);
    }
  });

  it("finds the declaration in the domain and nowhere else", () => {
    const declarations = SOURCES.flatMap(([path, text]) =>
      declarationsIn(path, text),
    );

    // The line is not pinned: it moves whenever the file above it does, and
    // what the requirement is about is the COUNT and the owner.
    expect(declarations.map(where)).toEqual([
      expect.stringMatching(
        new RegExp(
          `^${DECLARING_MODULE.replace(/\./g, "\\.")}:\\d+ \\(type alias\\)$`,
        ),
      ),
    ]);
  });

  it("reaches the screen that used to carry the second one", () => {
    // The redeclaration is gone, and the export it stood behind is not: the
    // form imports the name from the screen (`screens/automation-form.tsx`),
    // so a fix that deleted the export instead of re-exporting it would have
    // broken the form while satisfying the count above.
    const screen =
      SOURCES.find(
        ([path]) => path === "src/web/screens/automations.tsx",
      )?.[1] ?? "";

    // Asserted as answers rather than with `toContain` on the source: the file
    // is over a thousand lines, and a failing `toContain` prints every one of
    // them instead of the one fact that is missing.
    const carries = (line: string): boolean => screen.includes(line);

    expect({
      importsTheDomainType: carries(
        'import type { TriggerType } from "../../flows/trigger-compatibility.js";',
      ),
      keepsTheExportTheFormReads: carries("export type { TriggerType };"),
    }).toEqual({
      importsTheDomainType: true,
      keepsTheExportTheFormReads: true,
    });
  });
});

describe("REQ-170: the guard tells a declaration from a mention", () => {
  /** The detector under test, run on invented sources instead of on disk. */
  function kindsIn(text: string, file = "fixture.ts"): readonly string[] {
    return declarationsIn(file, text).map(({ kind }) => kind);
  }

  it("bites every way a second declaration could be written", () => {
    expect(
      kindsIn('export type TriggerType = Automation["trigger"]["type"];'),
    ).toEqual(["type alias"]);
    expect(kindsIn("type TriggerType = string;")).toEqual(["type alias"]);
    expect(
      kindsIn("export interface TriggerType { readonly kind: string }"),
    ).toEqual(["interface"]);
    expect(kindsIn("enum TriggerType { comment, direct_message }")).toEqual([
      "enum",
    ]);
    expect(kindsIn("class TriggerType {}")).toEqual(["class"]);

    // Hidden inside a function, which is how a redeclaration arrives when its
    // author believes it to be private.
    expect(kindsIn("function read() { type TriggerType = string; }")).toEqual([
      "type alias",
    ]);

    // In a screen, which is the file the defect was actually in.
    expect(
      kindsIn(
        'export type TriggerType = Automation["trigger"]["type"];',
        "src/web/screens/automations.tsx",
      ),
    ).toEqual(["type alias"]);
  });

  it("accuses no import, re-export, usage, comment or string", () => {
    const innocent = [
      'import type { TriggerType } from "../../flows/trigger-compatibility.js";',
      'import { TRIGGER_TYPES, type TriggerType } from "./trigger-compatibility.js";',
      'import type { TriggerType as Trigger } from "./trigger-compatibility.js";',
      "export type { TriggerType };",
      'export type { TriggerType } from "./trigger-compatibility.js";',
      'const trigger: TriggerType = "comment";',
      "function serves(trigger: TriggerType): boolean { return true; }",
      "interface Option { readonly triggers?: readonly TriggerType[] }",
      "/** export type TriggerType = string; the shape this guard forbids. */",
      "// type TriggerType = string;",
      "const fixture = 'export type TriggerType = string;';",
      // A different name that merely begins with the guarded one.
      "export type TriggerTypes = readonly string[];",
      "type TriggerTypeLabel = string;",
    ];

    expect(innocent.filter((text) => kindsIn(text).length > 0)).toEqual([]);
  });
});

/**
 * Proves REQ-261: no module under `src/web` is left standing with nobody
 * importing it.
 *
 * Phase 3l is a removal, and a removal is where orphans are made: a screen loses
 * the field it drew, the helper behind that field keeps compiling, and nothing
 * fails. `screens/scalar-value.ts` was exactly that (six exports, no caller and
 * no test) and it survived REQ-158 and REQ-168 leaving the product because a
 * module that nobody imports breaks nothing. That is the whole difficulty: the
 * compiler is silent about dead code by design, so the guard has to be written.
 *
 * The check sits beside the trigger sweep because it is the same sweep: the
 * sources are already parsed here, and a second walk of the tree in another file
 * would be a second answer to "what is the source of this project".
 *
 * A TEST is not a consumer. That is deliberate and it is the lesson of REQ-140:
 * a module exercised only by its own test is a parallel implementation nobody
 * runs, and counting the test would make this guard blind to precisely the shape
 * it exists to catch.
 */

/**
 * The two modules nothing imports ON PURPOSE, each with the file that loads it.
 *
 * Named rather than pattern-matched, and each one's loader asserted below: an
 * allowance that is not checked is how the exemption list becomes the place
 * orphans go to hide.
 */
const WEB_ENTRY_POINTS: Readonly<Record<string, string>> = {
  /** The SPA's entry, loaded by the page Vite builds from. */
  "src/web/main.tsx": "src/web/index.html",
  /** The DOM setup of the browser suite, loaded by the runner. */
  "src/web/test-setup.ts": "vitest.config.ts",
};

/** Whether this repository path is a test rather than a module of the product. */
function isTestModule(path: string): boolean {
  return /\.test\.tsx?$/.test(path);
}

/**
 * Every relative module specifier one source DEPENDS on.
 *
 * Parsed rather than matched, for the reason the sweep above is parsed: a doc
 * comment in `web/routes.tsx` spells out `import { FlowsScreen } from
 * "./screens/flows.js"` to explain how a screen would be added, and a regular
 * expression reads that sentence as a dependency on a file that does not exist.
 *
 * Dynamic `import()` counts, because a route split into a chunk is still a
 * consumer, and a guard that only saw static imports would call a lazily loaded
 * screen an orphan.
 */
function dependenciesIn(file: string, text: string): readonly string[] {
  const source = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.ESNext,
    true,
    scriptKindOf(file),
  );

  const found: string[] = [];

  const visit = (node: ts.Node): void => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      found.push(node.moduleSpecifier.text);
    }

    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments[0] !== undefined &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      found.push(node.arguments[0].text);
    }

    ts.forEachChild(node, visit);
  };

  visit(source);

  return found.filter((specifier) => specifier.startsWith("."));
}

/**
 * The repository path a specifier names, or nothing when it names no source.
 *
 * The `.js` of an ESM specifier is the compiled name of a `.ts` or a `.tsx`
 * (that is the rule `tests/import-extensions.test.ts` enforces), and a directory
 * is its `index`. Anything that resolves to no source of this project is dropped
 * rather than reported: a JSON catalogue and a stylesheet are legitimate
 * imports, and they are not modules this guard is about.
 */
function targetOf(from: string, specifier: string): string | undefined {
  const segments = from.split("/").slice(0, -1);

  for (const segment of specifier.split("/")) {
    if (segment === ".") continue;
    else if (segment === "..") segments.pop();
    else segments.push(segment);
  }

  const base = segments.join("/").replace(/\.js$/, "");
  const paths = new Set(SOURCES.map(([path]) => path));

  return [`${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`]
    .filter((candidate) => paths.has(candidate))
    .at(0);
}

describe("REQ-261: every module of the interface has a consumer", () => {
  /** Which non-test sources import each module of the project. */
  const CONSUMERS: ReadonlyMap<string, readonly string[]> = (() => {
    const found = new Map<string, string[]>();

    for (const [path, text] of SOURCES) {
      if (isTestModule(path)) continue;

      for (const specifier of dependenciesIn(path, text)) {
        const target = targetOf(path, specifier);
        if (target === undefined || target === path) continue;
        found.set(target, [...(found.get(target) ?? []), path]);
      }
    }

    return found;
  })();

  it("resolves the dependencies it claims to resolve", () => {
    // Guards the guard: a resolver that answered `undefined` for everything
    // would report no consumer for anything and still pass the assertion below
    // by way of the exemption list being the whole answer.
    expect(CONSUMERS.get("src/web/components/Button.tsx")).toContain(
      "src/web/components/index.ts",
    );
    expect(CONSUMERS.get("src/flows/schema.ts")).toContain(
      "src/flows/index.ts",
    );
    expect(CONSUMERS.get("src/web/screens/automation-form.tsx")).not.toEqual(
      [],
    );
  });

  it("reads a doc comment as prose and not as a dependency", () => {
    // `web/routes.tsx` documents how a screen is registered by writing the
    // import out. The file it names has been removed from the product, so a
    // text-level sweep would resolve it to nothing and quietly under-report.
    expect(
      dependenciesIn(
        "fixture.tsx",
        '/**\n * import { FlowsScreen } from "./screens/flows.js";\n */\nimport { a } from "./real.js";\n',
      ),
    ).toEqual(["./real.js"]);
  });

  it("counts a dynamic import as a consumer", () => {
    expect(
      dependenciesIn(
        "fixture.tsx",
        'const late = () => import("./screens/late.js");\n',
      ),
    ).toEqual(["./screens/late.js"]);
  });

  it("leaves no module of src/web without one", () => {
    const orphans = SOURCES.map(([path]) => path)
      .filter(
        (path) =>
          path.startsWith("src/web/") &&
          !isTestModule(path) &&
          !(path in WEB_ENTRY_POINTS) &&
          (CONSUMERS.get(path) ?? []).length === 0,
      )
      .sort((a, b) => a.localeCompare(b));

    // Named rather than counted: a failure has to say WHICH module to delete.
    expect(orphans).toEqual([]);
  });

  it("checks that each exempted entry point really is loaded", () => {
    // An exemption nobody verifies is where the next orphan is filed. Each
    // entry is asserted against the file that loads it, by name.
    const loaded = Object.entries(WEB_ENTRY_POINTS).map(([entry, loader]) => {
      const text = readFileSync(`${repoRoot}${loader}`, "utf8");
      const name = entry.slice(entry.lastIndexOf("/") + 1);

      return [entry, text.includes(name)] as const;
    });

    expect(Object.fromEntries(loaded)).toEqual({
      "src/web/main.tsx": true,
      "src/web/test-setup.ts": true,
    });
  });
});
