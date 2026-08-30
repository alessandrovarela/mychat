import { describe, expect, it } from "vitest";

/**
 * The guardians of the design system. Each one is a `describe` below, named by
 * the REQ it proves — the file's own headings are the list, so this paragraph
 * never has to be counted again. It carried "the two guardians" for two phases
 * after the third and the fourth landed.
 *
 * REQ-110 is a rule about what the next person may write: every colour, font
 * size, spacing step and corner radius comes from a token, so a theme change is
 * a change to `styles/tokens/` and never a hunt through the screens. A rule
 * nobody checks decays in a week, so this file checks it.
 *
 * REQ-111 is the same idea applied to legibility. "Readable in the dark theme"
 * is an opinion until someone computes it, so that guardian resolves each
 * declared text-and-surface pair in BOTH themes and puts the WCAG contrast
 * ratio against the 4.5:1 floor. The formula is written out below rather than
 * installed: it is five lines, and the project takes no new dependency.
 *
 * They all read the real files, not a copy of them. Every source arrives
 * through one `import.meta.glob`, which is how `locale.tsx` reads the
 * catalogues: this program has the DOM and no Node types on purpose (see
 * `src/web/tsconfig.json`), so `node:fs` is not available here and reaching for
 * it would not typecheck.
 */

/**
 * Every source file of the interface, as text.
 *
 * `../**` is `src/web/**`: screens, components, the entry point, the
 * stylesheets and the page. Test files come in too and are filtered out below.
 *
 * `index.html` is in the sweep because it is PUBLISHED: `vite build` takes it
 * as the entry and ships it, so a colour or a measurement written into it
 * reaches an operator's screen exactly like one written into a component. The
 * glob read only `.ts`, `.tsx` and `.css` until REQ-189, and the page went
 * unswept the whole time; it happens to carry no colour and no length, which is
 * the only reason the hole cost nothing rather than the reason it was allowed.
 */
const WEB_SOURCES = import.meta.glob<string>("../**/*.{ts,tsx,css,html}", {
  eager: true,
  query: "?raw",
  import: "default",
});

/** Where the glob keys are relative to: this file's own directory. */
const GLOB_BASE = "src/web/styles";

/**
 * Repository-relative, so a failure names a path that can be opened.
 *
 * The keys arrive relative to this directory and in both shapes: `./app.css`
 * for a neighbour, `../screens/dashboard.tsx` for a file above.
 */
function repositoryPath(globKey: string): string {
  const segments = GLOB_BASE.split("/");

  for (const step of globKey.split("/")) {
    if (step === "..") {
      segments.pop();
    } else if (step !== ".") {
      segments.push(step);
    }
  }

  return segments.join("/");
}

/**
 * Where a literal is a DEFINITION instead of a usage, and is therefore allowed.
 *
 * `styles/tokens/` is the design system ported into the application: the
 * palette, the type scale, the spacing ladder and the document rules that
 * consume them all live there. It is the bottom of the stack, so there is
 * nothing above it to reference, and the hex values it declares are the very
 * thing every other file is required to point at.
 */
const TOKEN_SHEET_PREFIX = "src/web/styles/tokens/";

/**
 * Files the guardian reads: the screens, the components, the entry point and
 * any stylesheet that is not the token sheet.
 *
 * Tests are excluded, and this file is the reason why: a guardian that hunts
 * hex literals has to carry hex literals, both in the fixtures that prove it
 * bites and in the failures it reports. A test that asserts a value is stating
 * an expectation, not styling a screen, and REQ-110 is about screens.
 */
function isGuarded(path: string): boolean {
  return !path.startsWith(TOKEN_SHEET_PREFIX) && !/\.test\.tsx?$/.test(path);
}

/** Every file of `src/web`, by repository path, sorted so a report is stable. */
const WEB_FILES: ReadonlyMap<string, string> = new Map(
  Object.entries(WEB_SOURCES)
    .map(([key, source]): readonly [string, string] => [
      repositoryPath(key),
      source,
    ])
    .sort(([a], [b]) => a.localeCompare(b)),
);

const GUARDED_FILES: readonly (readonly [string, string])[] = [
  ...WEB_FILES,
].filter(([path]) => isGuarded(path));

/**
 * The palette, as text, taken from the same sweep rather than imported.
 *
 * A `./tokens/colors.css?raw` import would read the same file and would break
 * `tests/import-extensions.test.ts`, which requires every relative specifier in
 * the repository to end in `.js` (REQ-082). One reading mechanism, no
 * exception to a rule that exists for a different reason.
 */
const COLOUR_TOKENS_PATH = `${TOKEN_SHEET_PREFIX}colors.css`;
const colourTokens = WEB_FILES.get(COLOUR_TOKENS_PATH) ?? "";

/** The sheet that paints every component, and therefore every mark and pair. */
const COMPONENT_SHEET_PATH = "src/web/components/components.css";
const componentSheet = WEB_FILES.get(COMPONENT_SHEET_PATH) ?? "";

/** A `path:line` prefix, so the report names the file and the exact line. */
function at(path: string, source: string, index: number): string {
  const line = source.slice(0, index).split("\n").length;

  return `${path}:${line}`;
}

/**
 * The same text with every comment blanked out, character for character.
 *
 * A comment that spells a token name is prose, not a reference: this file's own
 * header would otherwise be a finding. Blanking instead of deleting keeps every
 * later index where it was, so a finding still names the right line.
 *
 * Three forms, because the sweep reads three languages. The block form is CSS
 * and TypeScript alike; the `//` form exists only in TypeScript, and the
 * lookbehind keeps it off the `//` inside a URL, which is the one place where
 * the two slashes are not a comment; the angle-bracket form is the page, which
 * joined the sweep with REQ-189 and arrives carrying a comment of its own.
 *
 * Shared by three of the guardians below, which is why it sits up here with the
 * readers rather than inside the one that needed it first: a token named in a
 * comment is not a reference (REQ-173), is not a request (REQ-191), and does
 * not paint anything (REQ-187).
 */
function withoutComments(source: string): string {
  const blank = (text: string): string => text.replace(/[^\n]/g, " ");

  return source
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    .replace(/<!--[\s\S]*?-->/g, blank)
    .replace(/(?<![:\\])\/\/[^\n]*/g, blank);
}

/* ------------------------------------------------------------------ *
 * REQ-110: no literal where a token belongs
 * ------------------------------------------------------------------ */

/**
 * Colour written by hand, in every notation a value could arrive in.
 *
 * Applied to the WHOLE file, because a colour literal is wrong wherever it
 * appears: in a stylesheet, in a template literal of CSS, in an inline style
 * object. The hexadecimal pattern only accepts the four lengths CSS defines
 * (3, 4, 6 and 8 digits), which keeps it off things like `#root` and `#/path`.
 *
 * `color-mix()` is deliberately absent: it takes colours rather than declaring
 * one, and the token sheet uses it to derive the focus ring from `--rule-focus`
 * without repeating a value.
 */
const COLOUR_LITERALS: readonly {
  readonly kind: string;
  readonly find: RegExp;
}[] = [
  {
    kind: "hexadecimal colour",
    find: /#(?:[\da-f]{8}|[\da-f]{6}|[\da-f]{4}|[\da-f]{3})\b/gi,
  },
  { kind: "rgb() colour", find: /\brgba?\(/gi },
  { kind: "hsl() colour", find: /\bhsla?\(/gi },
  { kind: "hwb() colour", find: /\bhwb\(/gi },
  { kind: "lab() colour", find: /\b(?:ok)?lab\(/gi },
  { kind: "lch() colour", find: /\b(?:ok)?lch\(/gi },
];

/**
 * Properties whose value paints something, so a named colour in them is a
 * colour literal too: `color: white` slips past every pattern above.
 *
 * `currentColor`, `transparent`, `inherit` and `none` are not in the list of
 * names below, which is what lets an inline SVG carry `fill="currentColor"`,
 * the one way an icon can take the colour of the text beside it.
 */
const COLOUR_PROPERTIES =
  /^(color|background|background-[a-z]+|border|border-[a-z-]+|outline|outline-[a-z]+|fill|stroke|caret-color|accent-color|text-decoration|text-decoration-[a-z]+|box-shadow|text-shadow)$/;

/**
 * Every colour the CSS standard gives a name to (REQ-197), and not a list
 * someone curated.
 *
 * The curated list this replaced held twenty-two names, and the hole was
 * MEASURED rather than supposed: `color: rebeccapurple` in `index.html`
 * produced the finding for the `12px` beside it and no finding for the colour.
 * The same silence covered `crimson`, `indigo`, `coral`, `salmon`, `khaki`,
 * `beige`, `ivory`, `plum`, `tan`, `turquoise` and `violet`. A guard whose
 * vocabulary is what someone remembered is a guard that passes whatever they
 * forgot, and the next person writes exactly that.
 *
 * `transparent`, `currentColor`, `inherit` and `none` are deliberately absent:
 * none of them is a colour value with a colour in it, and the first two are how
 * an inline SVG takes the colour of the text beside it.
 */
const CSS_COLOUR_NAMES: ReadonlySet<string> = new Set([
  "aliceblue",
  "antiquewhite",
  "aqua",
  "aquamarine",
  "azure",
  "beige",
  "bisque",
  "black",
  "blanchedalmond",
  "blue",
  "blueviolet",
  "brown",
  "burlywood",
  "cadetblue",
  "chartreuse",
  "chocolate",
  "coral",
  "cornflowerblue",
  "cornsilk",
  "crimson",
  "cyan",
  "darkblue",
  "darkcyan",
  "darkgoldenrod",
  "darkgray",
  "darkgreen",
  "darkgrey",
  "darkkhaki",
  "darkmagenta",
  "darkolivegreen",
  "darkorange",
  "darkorchid",
  "darkred",
  "darksalmon",
  "darkseagreen",
  "darkslateblue",
  "darkslategray",
  "darkslategrey",
  "darkturquoise",
  "darkviolet",
  "deeppink",
  "deepskyblue",
  "dimgray",
  "dimgrey",
  "dodgerblue",
  "firebrick",
  "floralwhite",
  "forestgreen",
  "fuchsia",
  "gainsboro",
  "ghostwhite",
  "gold",
  "goldenrod",
  "gray",
  "green",
  "greenyellow",
  "grey",
  "honeydew",
  "hotpink",
  "indianred",
  "indigo",
  "ivory",
  "khaki",
  "lavender",
  "lavenderblush",
  "lawngreen",
  "lemonchiffon",
  "lightblue",
  "lightcoral",
  "lightcyan",
  "lightgoldenrodyellow",
  "lightgray",
  "lightgreen",
  "lightgrey",
  "lightpink",
  "lightsalmon",
  "lightseagreen",
  "lightskyblue",
  "lightslategray",
  "lightslategrey",
  "lightsteelblue",
  "lightyellow",
  "lime",
  "limegreen",
  "linen",
  "magenta",
  "maroon",
  "mediumaquamarine",
  "mediumblue",
  "mediumorchid",
  "mediumpurple",
  "mediumseagreen",
  "mediumslateblue",
  "mediumspringgreen",
  "mediumturquoise",
  "mediumvioletred",
  "midnightblue",
  "mintcream",
  "mistyrose",
  "moccasin",
  "navajowhite",
  "navy",
  "oldlace",
  "olive",
  "olivedrab",
  "orange",
  "orangered",
  "orchid",
  "palegoldenrod",
  "palegreen",
  "paleturquoise",
  "palevioletred",
  "papayawhip",
  "peachpuff",
  "peru",
  "pink",
  "plum",
  "powderblue",
  "purple",
  "rebeccapurple",
  "red",
  "rosybrown",
  "royalblue",
  "saddlebrown",
  "salmon",
  "sandybrown",
  "seagreen",
  "seashell",
  "sienna",
  "silver",
  "skyblue",
  "slateblue",
  "slategray",
  "slategrey",
  "snow",
  "springgreen",
  "steelblue",
  "tan",
  "teal",
  "thistle",
  "tomato",
  "turquoise",
  "violet",
  "wheat",
  "white",
  "whitesmoke",
  "yellow",
  "yellowgreen",
]);

/**
 * The words of a value, so each can be held against the set above. Letters
 * only: a name is never spelled with a digit or a dash, and reading the value
 * word by word is what lets the set be a set instead of one enormous
 * alternation that has to be ordered by length to work.
 */
const VALUE_WORDS = /[a-z]+/gi;

/**
 * Properties that carry a step of a scale, and therefore may not carry a
 * number: spacing, corner radius and font size. The three families REQ-110
 * names, and no more.
 *
 * What is deliberately NOT here, and why:
 *
 *   - border and outline WIDTH: a hairline is 1px in every theme, it is not a
 *     step of any ladder, and the design system itself writes it out;
 *   - width, height and their logical forms: the size of a progress bar or of
 *     a thumbnail cell is a measurement of that widget. No token claims to know
 *     it, so demanding one would only produce a token per widget;
 *   - anything unitless, `0`, `100%` and `1fr`: they carry no px and no rem, so
 *     they never reach the pattern below.
 */
const SCALED_PROPERTIES: readonly RegExp[] = [
  /^(margin|padding|inset)(-|$)/,
  /(^|-)gap$/,
  /^(top|right|bottom|left)$/,
  /(^|-)radius$/,
  /^font-size$/,
];

/** A length written by hand. Percentages, `fr` and plain numbers are not. */
const LENGTH_LITERAL = /(?<![\w.#$-])\d*\.?\d+(?:px|rem)\b/g;

/** The name of a property, in CSS and in a React style object alike. */
const PROPERTY = /([A-Za-z][\w-]*)\s*:\s*/g;

/** An HTML or JSX attribute, which is how an inline SVG paints itself. */
const ATTRIBUTE = /([A-Za-z][\w-]*)\s*=\s*"([^"\n]*)"/g;

/** `fontSize` and `font-size` are the same property written twice. */
function cssName(property: string): string {
  return property.replace(/([a-z\d])([A-Z])/g, "$1-$2").toLowerCase();
}

/**
 * The value that starts at `from`, read to its end and no further.
 *
 * Both syntaxes end a value differently and both have to be read here: a
 * stylesheet ends it at `;` or at the closing brace, a React style object ends
 * it at the comma before the next property. A comma INSIDE parentheses ends
 * nothing, which is what keeps `minmax(9rem, 1fr)` one value instead of two.
 */
function valueFrom(source: string, from: number): string {
  let depth = 0;

  for (let index = from; index < source.length; index += 1) {
    const character = source[index];

    if (character === "(") {
      depth += 1;
    } else if (character === ")") {
      depth -= 1;
    } else if (
      character === ";" ||
      character === "{" ||
      character === "}" ||
      character === "\n" ||
      (character === "," && depth === 0)
    ) {
      return source.slice(from, index);
    }
  }

  return source.slice(from);
}

interface Declaration {
  readonly property: string;
  readonly value: string;
  readonly index: number;
}

function declarationsIn(source: string): readonly Declaration[] {
  const written = [...source.matchAll(PROPERTY)].map((match): Declaration => ({
    property: cssName(match[1] ?? ""),
    value: valueFrom(source, match.index + match[0].length),
    index: match.index,
  }));

  const attributes = [...source.matchAll(ATTRIBUTE)].map(
    (match): Declaration => ({
      property: cssName(match[1] ?? ""),
      value: match[2] ?? "",
      index: match.index,
    }),
  );

  return [...written, ...attributes];
}

function colourFindings(path: string, source: string): readonly string[] {
  const findings: string[] = [];

  for (const { kind, find } of COLOUR_LITERALS) {
    for (const match of source.matchAll(find)) {
      findings.push(
        `${at(path, source, match.index)} ${kind} ${match[0]}, use a token from styles/tokens/colors.css`,
      );
    }
  }

  for (const { property, value, index } of declarationsIn(source)) {
    if (!COLOUR_PROPERTIES.test(property)) {
      continue;
    }

    for (const word of value.matchAll(VALUE_WORDS)) {
      if (!CSS_COLOUR_NAMES.has(word[0].toLowerCase())) {
        continue;
      }

      findings.push(
        `${at(path, source, index)} named colour ${word[0]} in ${property}, use a token from styles/tokens/colors.css`,
      );
    }
  }

  return findings;
}

function measureFindings(path: string, source: string): readonly string[] {
  const findings: string[] = [];

  for (const { property, value, index } of declarationsIn(source)) {
    if (!SCALED_PROPERTIES.some((family) => family.test(property))) {
      continue;
    }

    for (const length of value.matchAll(LENGTH_LITERAL)) {
      findings.push(
        `${at(path, source, index)} literal ${length[0]} in ${property}, use a step of the scale in styles/tokens/`,
      );
    }
  }

  return findings;
}

describe("REQ-110: the interface consumes only the design system tokens", () => {
  it("reads the screens and the stylesheets, and not the token sheet", () => {
    const paths = GUARDED_FILES.map(([path]) => path);

    // A sweep that silently matched nothing would pass every assertion below
    // forever, which is the one way a guardian fails without saying so.
    expect(paths).toContain("src/web/screens/dashboard.tsx");
    expect(paths).toContain("src/web/screens/publications.tsx");
    expect(paths).toContain("src/web/main.tsx");
    expect(paths).toContain("src/web/styles/app.css");

    expect(paths).toContain("src/web/index.html");
    expect(paths.some((path) => path.startsWith(TOKEN_SHEET_PREFIX))).toBe(
      false,
    );

    // Every file arrives with its text. Vitest hands back an empty module for
    // a stylesheet unless `css` is enabled (see `vitest.config.ts`), and an
    // empty file is a file where nothing is ever found.
    for (const [path, source] of GUARDED_FILES) {
      expect(source.length, path).toBeGreaterThan(0);
    }
  });

  it("carries no colour literal", () => {
    const findings = GUARDED_FILES.flatMap(([path, source]) =>
      colourFindings(path, source),
    );

    expect(findings).toEqual([]);
  });

  it("carries no literal spacing, radius or font size", () => {
    const findings = GUARDED_FILES.flatMap(([path, source]) =>
      measureFindings(path, source),
    );

    expect(findings).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * REQ-189: the sweep reaches every file the build publishes
 * ------------------------------------------------------------------ */

/**
 * Not a guardian of its own so much as the reach of the ones above.
 *
 * REQ-110 hunts literals through `src/web`, and for two phases its glob read
 * `.ts`, `.tsx` and `.css`. `index.html` is none of those and is the document
 * `vite build` ships, so a colour or a length written into it went to
 * production past a gate that never opened the file. Nothing was hiding there,
 * which is luck: the page carries a title, a viewport and a script tag, and the
 * next person to add a splash background or a theme colour would have found no
 * gate in the way.
 *
 * A reach is not provable by a passing sweep, since a sweep that reads nothing
 * passes too. So the page is named in the file list AND handed to the reader
 * carrying a colour, in both notations a document can write one in.
 */
const PAGE_PATH = "src/web/index.html";

describe("REQ-189: the guardians reach the page the build publishes", () => {
  it("reads index.html, the entry document vite ships", () => {
    expect(WEB_FILES.has(PAGE_PATH)).toBe(true);
    expect(GUARDED_FILES.map(([path]) => path)).toContain(PAGE_PATH);
    expect((WEB_FILES.get(PAGE_PATH) ?? "").length).toBeGreaterThan(0);
  });

  it("reports a colour written into the page, naming the file", () => {
    // Two notations, because a document has two: an attribute whose value is a
    // colour, and a `style` attribute carrying a declaration the CSS reader has
    // to find inside it.
    const written = `<!doctype html>
<html lang="en">
  <head>
    <meta name="theme-color" content="#0b5fff" />
  </head>
  <body style="background: white">
    <div id="root"></div>
  </body>
</html>`;

    expect(colourFindings(PAGE_PATH, written)).toEqual([
      `${PAGE_PATH}:4 hexadecimal colour #0b5fff, use a token from styles/tokens/colors.css`,
      `${PAGE_PATH}:6 named colour white in background, use a token from styles/tokens/colors.css`,
    ]);
  });

  it("reports a length written into the page, naming the file", () => {
    expect(
      measureFindings(PAGE_PATH, '<div id="root" style="padding: 12px"></div>'),
    ).toEqual([
      `${PAGE_PATH}:1 literal 12px in padding, use a step of the scale in styles/tokens/`,
    ]);
  });

  it("takes an anchor for an anchor and not for a colour", () => {
    // A document is full of `#name`, which is the one thing the hexadecimal
    // pattern could plausibly be confused by now that it reads one.
    expect(colourFindings(PAGE_PATH, '<a href="#root">go</a>')).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * REQ-197: the guard knows every colour the standard names
 * ------------------------------------------------------------------ */

/**
 * The vocabulary of the guardian above, rather than its reach.
 *
 * REQ-189 taught the sweep to open every published file, and the file it opened
 * first was the one where `rebeccapurple` had been measured going through
 * untouched. Reach and vocabulary are different holes, and closing the first
 * left the second exactly where it was: a curated list of twenty-two names, so
 * the guard read the whole page and recognised a fifth of what CSS calls a
 * colour.
 *
 * The names below are the ones that were measured silent, and the assertions
 * are per-name on purpose: one `expect` over a batch would pass with the batch
 * half-recognised.
 */
const ONCE_INVISIBLE_COLOURS = [
  "rebeccapurple",
  "crimson",
  "indigo",
  "coral",
  "salmon",
  "khaki",
  "beige",
  "ivory",
  "plum",
  "tan",
  "turquoise",
  "violet",
] as const;

describe("REQ-197: every colour the CSS standard names is a literal", () => {
  it.each(ONCE_INVISIBLE_COLOURS)("reports %s", (name) => {
    expect(colourFindings("src/web/screens/x.tsx", `color: ${name};`)).toEqual([
      `src/web/screens/x.tsx:1 named colour ${name} in color, use a token from styles/tokens/colors.css`,
    ]);
  });

  it("holds the whole standard and not a sample of it", () => {
    // The set is the vocabulary, so its size is the claim. 148 is every name in
    // CSS Color Level 4: the 147 CSS2 inherited from X11, plus `rebeccapurple`,
    // which Level 4 added and which is the very name that was measured going
    // through the curated list untouched.
    expect(CSS_COLOUR_NAMES.size).toBe(148);
    expect(CSS_COLOUR_NAMES.has("transparent")).toBe(false);
  });

  it("still lets an icon take the colour of the text beside it", () => {
    // `currentColor` is the one way an inline SVG inherits, and a guard that
    // called it a literal would push every icon back to a hard-coded fill.
    expect(colourFindings("src/web/x.tsx", 'fill="currentColor"')).toEqual([]);
    expect(colourFindings("src/web/x.css", "background: transparent;")).toEqual(
      [],
    );
  });

  it("reads a name whatever case it is written in", () => {
    expect(colourFindings("src/web/x.tsx", "color: RebeccaPurple;")).toEqual([
      "src/web/x.tsx:1 named colour RebeccaPurple in color, use a token from styles/tokens/colors.css",
    ]);
  });

  it("takes a name for a name and not for a word that contains one", () => {
    // `--surface-fixture` carries no colour, and neither does a font stack that
    // happens to spell one: the guard reads words, so a token reference and a
    // family name have to survive it.
    expect(
      colourFindings("src/web/x.css", "background: var(--surface-fixture);"),
    ).toEqual([]);
    expect(colourFindings("src/web/x.css", "color: var(--fg-1);")).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * REQ-111: both themes clear the contrast floor
 * ------------------------------------------------------------------ */

/** WCAG 2.2 level AA for body text. Not negotiable, and never lowered. */
const MINIMUM_CONTRAST = 4.5;

/** The index of the `}` that closes the `{` at `open`, braces balanced. */
function closingBrace(source: string, open: number): number {
  let depth = 0;

  for (let index = open; index < source.length; index += 1) {
    if (source[index] === "{") {
      depth += 1;
    }

    if (source[index] === "}") {
      depth -= 1;

      if (depth === 0) {
        return index;
      }
    }
  }

  throw new Error(`unbalanced braces from ${open}`);
}

/** The body of the first `{ ... }` that follows `header`, braces balanced. */
function blockAfter(source: string, header: string): string {
  const start = source.indexOf(header);

  expect(start, `missing block: ${header}`).toBeGreaterThanOrEqual(0);

  const open = source.indexOf("{", start);

  return source.slice(open + 1, closingBrace(source, open));
}

function declarationsOf(block: string): ReadonlyMap<string, string> {
  const declarations = new Map<string, string>();

  for (const [, name, value] of block.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    declarations.set(name ?? "", (value ?? "").trim());
  }

  return declarations;
}

const LIGHT_TOKENS = declarationsOf(blockAfter(colourTokens, ":root {"));

/**
 * The dark theme, and the mechanic REQ-111 asks for: the browser's own
 * preference. The media query redefines the primitives ON TOP of the light
 * ones, so the semantic aliases (`--text-body`, `--surface-card`) are declared
 * once and resolve to the other palette with no second list to keep in step.
 * That layering is why the map below starts from the light one.
 */
const DARK_TOKENS = new Map([
  ...LIGHT_TOKENS,
  ...declarationsOf(
    blockAfter(
      blockAfter(colourTokens, "@media (prefers-color-scheme: dark)"),
      ":root {",
    ),
  ),
]);

/** Follows `var(--x)` aliases down to the value that is actually a colour. */
function valueOf(tokens: ReadonlyMap<string, string>, name: string): string {
  const declared = tokens.get(name);

  expect(declared, `undeclared token: ${name}`).toBeDefined();

  const alias = /^var\((--[\w-]+)\)$/.exec(declared ?? "");

  return alias === null ? (declared ?? "") : valueOf(tokens, alias[1] ?? "");
}

/**
 * The three channels of an opaque colour, 0 to 255.
 *
 * Opaque on purpose: a translucent value has no contrast of its own, it has the
 * contrast of whatever ends up behind it. A token that arrives here with an
 * alpha is a pair that was declared wrong, and the assertion says so by name
 * instead of quietly returning a number nobody can trust.
 */
function channelsOf(colour: string): readonly number[] {
  const hex = /^#([\da-f]{3}|[\da-f]{6})$/i.exec(colour);

  expect(hex, `not an opaque colour: ${colour}`).not.toBeNull();

  const digits = hex?.[1] ?? "";
  const full =
    digits.length === 3
      ? [...digits].map((digit) => `${digit}${digit}`).join("")
      : digits;

  return [0, 2, 4].map((offset) =>
    Number.parseInt(full.slice(offset, offset + 2), 16),
  );
}

/**
 * WCAG 2 relative luminance and contrast ratio, written out instead of
 * installed (https://www.w3.org/TR/WCAG22/#dfn-relative-luminance): each
 * channel is taken out of the sRGB transfer curve, weighted for how much the
 * eye sees of it, and the two luminances go into (lighter + 0.05) / (darker +
 * 0.05). The 0.05 is the light a screen reflects when it is showing black.
 */
function luminanceOf(colour: string): number {
  const [red = 0, green = 0, blue = 0] = channelsOf(colour).map((channel) => {
    const ratio = channel / 255;

    return ratio <= 0.03928 ? ratio / 12.92 : ((ratio + 0.055) / 1.055) ** 2.4;
  });

  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function contrastOf(text: string, background: string): number {
  const first = luminanceOf(text);
  const second = luminanceOf(background);
  const lighter = Math.max(first, second);
  const darker = Math.min(first, second);

  return (lighter + 0.05) / (darker + 0.05);
}

interface Pair {
  readonly text: string;
  readonly background: string;
}

function inkOn(background: string, ...texts: readonly string[]): Pair[] {
  return texts.map((text) => ({ text, background }));
}

/**
 * Every pair of text and background the interface paints, and nothing else.
 *
 * "Paints" is the whole rule, and REQ-187 is what made it one: a pair nobody
 * puts on a screen still resolves, still computes a ratio and still passes,
 * which reads as a guarantee and is not one. Each entry below therefore names
 * the rule it comes from, and the guardian under this list refuses a pair whose
 * tokens no rule uses in that role.
 *
 * Two shapes of evidence, and both are real:
 *
 *   - a rule that declares the background AND the colour, which is the pair
 *     written out. `REQ-187` checks these mechanically and requires every one
 *     of them to appear here;
 *   - a rule that declares one of the two and INHERITS the other. Those are the
 *     entries a parser cannot derive, because the two declarations sit in
 *     different rules joined by the document tree: `.mc-panel` paints the card
 *     and `.mc-panel__title` the ink inside it. They are written by hand and
 *     named below.
 *
 * The names are the sheet's own. Where the design system has a semantic alias
 * the components reference it, and where the sheet writes the primitive
 * (`--fg-1`, `--fg-3`) so does this list, because the pair measured has to be
 * the pair spelled. The guardian compares by resolved colour, so two spellings
 * of one value are one measurement and never a second entry to keep in step.
 */
const CONTRAST_PAIRS: readonly Pair[] = [
  // The three resting surfaces. Title ink is `base.css` (`h1, h2, h3`), body
  // ink is `body` and the link pair is `base.css` too (`a`, `a:hover`); muted
  // is the second tier a card or a field carries (`.mc-card__sentence`,
  // `.mc-select-wrap__chevron`), faint is the meta line under it
  // (`.mc-card__meta`, `.mc-pubtile__id`, `.mc-input::placeholder`), and
  // `--danger-ink` is `.mc-field__error`, which sits below its field on
  // whichever surface the form stands on, and since REQ-308 the advice that
  // says the same refusal before it happens (`.mc-field__advice--limit`).
  // `--warning-ink` is the other nature of that layer
  // (`.mc-field__advice--truncation`, REQ-307), and it is the first time this
  // ink is written anywhere but on its own tint, so it is measured on the two
  // grounds a form stands on rather than assumed to travel.
  ...inkOn(
    "--surface-app",
    "--text-title",
    "--text-body",
    "--text-muted",
    "--fg-3",
    "--text-link",
    "--text-link-hover",
    "--warning-ink",
    "--danger-ink",
  ),
  ...inkOn(
    "--surface-card",
    "--text-title",
    "--text-body",
    "--text-muted",
    "--fg-3",
    "--text-link",
    "--text-link-hover",
    "--warning-ink",
    "--danger-ink",
  ),
  ...inkOn("--surface-field", "--text-body", "--text-muted", "--fg-3"),
  // The page itself, spelled as the sheets spell it, carrying the second word
  // of the wordmark (`.mc-brand__accent`, REQ-331). The rail and the bar it
  // folds into on a handset both fill with `--bg-page`, and the mark writes the
  // accent on that: it is the one place the accent is text on a resting
  // surface rather than on a tint or on a fill of its own. It is written out
  // here because `.mc-brand` fills nothing, so the tree guardian below has no
  // block surface to join the ink to.
  //
  // The access screen stands on `--surface-app` instead, and that ground is
  // already measured: `--text-link` IS `--accent` (colors.css declares the
  // alias once and no themed scope redeclares it), so the entry above is the
  // same measurement and a second one would be the same numbers twice.
  ...inkOn("--bg-page", "--accent"),
  // A control that answers to the pointer moves its background and keeps the
  // ink its resting rule set, so both tiers the sheet rests on come with it:
  // `--fg-1` on `.mc-btn--secondary`, `--fg-2` on `.mc-btn--ghost`.
  ...inkOn("--bg-hover", "--text-body", "--text-muted"),
  ...inkOn("--bg-active", "--text-body", "--text-muted"),
  // The saturated fills, all four carrying the ink meant for a saturated fill:
  // `.mc-btn--primary` and its two states, `.mc-btn--destructive`.
  ...inkOn("--accent", "--fg-on-accent"),
  ...inkOn("--accent-hover", "--fg-on-accent"),
  ...inkOn("--accent-active", "--fg-on-accent"),
  ...inkOn("--danger", "--fg-on-accent"),
  // The fifth saturated fill, and the only one that is not a control: the badge
  // of a section that holds nothing incomplete (`.mc-sechead--done
  // .mc-sechead__num`), which carries a check drawn in the ink a saturated fill
  // takes. A glyph would answer to the 3:1 of REQ-176 and is held to 4.5:1 all
  // the same, because it is painted with `color`.
  ...inkOn("--success", "--fg-on-accent"),
  // The tinted surfaces. Each carries three inks and they are three different
  // things: the badge's own dark tier (`.mc-badge--active`), the body ink a
  // notice writes its sentence in (`.mc-notice--success`), and the full-strength
  // colour of the glyph beside it (`.mc-notice--success .mc-notice__icon`).
  // The glyph would answer to the 3:1 of REQ-176 and is held to 4.5:1 anyway,
  // because it is painted with `color` and the floor here is never lowered.
  //
  // The first of them carries the chip of a keyword as well (`.mc-chip--accent`
  // inside `.mc-keywords`), and since REQ-305 that chip has no edge round it:
  // the tint reaches 1.11:1 on the field it sits in in the light theme and
  // 1.16:1 in the dark one, so what says a word is there is the INK on it,
  // which is the pair measured here, and never the outline.
  ...inkOn("--accent-soft", "--accent-ink"),
  ...inkOn("--info-soft", "--fg-1", "--accent"),
  ...inkOn("--success-soft", "--success-ink", "--fg-1", "--success"),
  ...inkOn("--warning-soft", "--warning-ink", "--fg-1", "--warning"),
  ...inkOn("--danger-soft", "--danger-ink", "--fg-1", "--danger"),
  // The conversation the preview QUOTES (REQ-298), which is the one family
  // below that does not move with the theme. Fixed colour is exactly what takes
  // a drawing out of the palette, and out of the palette is out of this list
  // unless its pairs are written down like everybody else's: the ratio is the
  // same in both themes, and that is the measurement, not an excuse to skip it.
  //
  // The screen is the ground the thread sits on (`.mc-phone`). It carries the
  // messages that have no bubble of their own, a card or a photograph or a file
  // (`.mc-msg__bubble:has(...)`), and the two labels each bubble is read under
  // (`.mc-msg__step`, `.mc-msg__who`), which is the tier the status bar takes
  // too (`.mc-phone__bar`).
  ...inkOn("--direct-screen", "--direct-ink", "--direct-meta"),
  // The two bubbles: the contact's, and the account's with the white a
  // saturated fill asks for (`.mc-msg__bubble`, `.mc-msg--mine .mc-msg__bubble`).
  //
  // The contact's fill carries a second ink since REQ-289: a PURE link arrives
  // as a bubble whose whole content is the address, and an address is written
  // in the blue that says it opens something (`.mc-preview-link__url`). It is
  // the same blue the card's button strips take, on a lighter ground, so the
  // pair is measured here as well rather than assumed from that one.
  ...inkOn("--direct-bubble", "--direct-ink", "--direct-link"),
  ...inkOn("--direct-mine", "--direct-mine-ink"),
  // The delivery as it lands. The card and the block a link's destination
  // builds write the conversation's own ink (`.mc-preview-card`,
  // `.mc-preview-link__og`), the second line its quieter grey
  // (`.mc-preview-card__text`, `.mc-preview-link__host`), and each button strip
  // the blue the contact presses (`.mc-preview-card__button`).
  ...inkOn(
    "--direct-card",
    "--direct-ink",
    "--direct-card-meta",
    "--direct-link",
  ),
  // Where a picture has not arrived: the word standing in for the thumbnail the
  // destination site will offer sits on it (`.mc-preview-link__image`), and so
  // does the text of a cover that failed to load (`.mc-preview-card__image`),
  // in the ink the card around it writes.
  ...inkOn("--direct-media", "--direct-meta", "--direct-ink"),
];

function belowFloor(
  theme: string,
  tokens: ReadonlyMap<string, string>,
): readonly string[] {
  return CONTRAST_PAIRS.flatMap(({ text, background }) => {
    const ink = valueOf(tokens, text);
    const surface = valueOf(tokens, background);
    const ratio = contrastOf(ink, surface);

    return ratio >= MINIMUM_CONTRAST
      ? []
      : [
          `${theme}: ${text} (${ink}) on ${background} (${surface}) is ${ratio.toFixed(2)}:1, below ${MINIMUM_CONTRAST}:1`,
        ];
  });
}

describe("REQ-111: every screen is legible in both themes", () => {
  it("follows the system preference, with no switch to operate", () => {
    // `color-scheme` is what makes the browser's own furniture follow: form
    // controls, scrollbars and the canvas behind the page. Without it a dark
    // page keeps a white scrollbar and white autofilled fields.
    expect(WEB_FILES.has(COLOUR_TOKENS_PATH)).toBe(true);
    expect(LIGHT_TOKENS.size).toBeGreaterThan(0);
    expect(colourTokens).toContain("color-scheme: light dark;");
    expect(colourTokens).toContain("@media (prefers-color-scheme: dark)");
  });

  it("declares a different palette for the dark theme", () => {
    const repainted = [...DARK_TOKENS].filter(
      ([name, value]) => LIGHT_TOKENS.get(name) !== value,
    );

    // Ink and surfaces at the very least: a dark theme that only moved the
    // accent is a light theme with a different button.
    expect(repainted.map(([name]) => name)).toEqual(
      expect.arrayContaining(["--fg-1", "--bg-page", "--bg-sunken"]),
    );
  });

  it("clears 4.5:1 on every declared pair, light theme", () => {
    expect(belowFloor("light", LIGHT_TOKENS)).toEqual([]);
  });

  it("clears 4.5:1 on every declared pair, dark theme", () => {
    expect(belowFloor("dark", DARK_TOKENS)).toEqual([]);
  });

  it("keeps the forced scopes in step with the preference", () => {
    // `[data-theme="light"]` and `[data-theme="dark"]` restate the primitives so
    // one region can show a theme on purpose. Restating is duplication, and
    // duplication drifts: a value corrected in the media query and forgotten
    // here would give a specimen a contrast the guardian above never measured.
    const drift = [
      ["light", LIGHT_TOKENS, '[data-theme="light"]'],
      ["dark", DARK_TOKENS, '[data-theme="dark"]'],
    ] as const;

    const findings = drift.flatMap(([theme, tokens, selector]) =>
      [...declarationsOf(blockAfter(colourTokens, selector))].flatMap(
        ([name, value]) =>
          tokens.get(name) === value
            ? []
            : [
                `${selector}: ${name} is ${value}, the ${theme} theme declares ${tokens.get(name) ?? "nothing"}`,
              ],
      ),
    );

    expect(findings).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * REQ-305: the chip of a keyword stands on a measured pair
 * ------------------------------------------------------------------ */

/**
 * The colour half of REQ-305, which the shape half made load bearing.
 *
 * The chip of a keyword lost its outline when it took the entry's pill
 * (`.mc-keywords .mc-chip` in the component sheet), so the tint and the ink on
 * it are the whole of what says a word is there. `--accent-soft` reaches
 * 1.11:1 on the field it sits in in the light theme and 1.16:1 in the dark one:
 * the fill is not what separates the chip from its field, and the outline it
 * replaced did not do that job either, at roughly 1.6:1 in the light theme.
 *
 * So the pair that has to hold is the INK on the tint, and this says out loud
 * that it is one of the pairs floored above rather than leaving it to be read
 * off a list of forty. REQ-111 measures it, REQ-187 proves a rule paints it,
 * and what is added here is the naming: this pair belongs to this chip, and
 * dropping it from `CONTRAST_PAIRS` fails by the requirement's own name.
 */
describe("REQ-305: the chip of a keyword is measured, in both themes", () => {
  it("writes the tint and its ink in one rule of the component sheet", () => {
    // A sheet that failed to load would pass everything below it.
    expect(componentSheet.length).toBeGreaterThan(0);

    const tone = blockAfter(componentSheet, ".mc-chip--accent {");

    expect(tone).toContain("background: var(--accent-soft);");
    expect(tone).toContain("color: var(--accent-ink);");

    // And the rule that shapes the chip inside the field repaints neither, so
    // the pair measured here is the pair the field really shows. A colour
    // written there would be a combination no entry of the list has seen.
    const shape = blockAfter(componentSheet, ".mc-keywords .mc-chip {");

    expect(shape).toContain("border-radius: var(--radius-pill);");
    expect(shape).not.toMatch(/(?:^|[;{\s])background:/);
    expect(shape).not.toMatch(/(?:^|[;{\s])color:/);
  });

  it("floors that pair in the light theme and in the dark one", () => {
    expect(
      CONTRAST_PAIRS.some(
        ({ text, background }) =>
          text === "--accent-ink" && background === "--accent-soft",
      ),
      "--accent-ink on --accent-soft is measured",
    ).toBe(true);

    const findings = (
      [
        ["light", LIGHT_TOKENS],
        ["dark", DARK_TOKENS],
      ] as const
    ).flatMap(([theme, tokens]) => {
      const ratio = contrastOf(
        valueOf(tokens, "--accent-ink"),
        valueOf(tokens, "--accent-soft"),
      );

      return ratio >= MINIMUM_CONTRAST
        ? []
        : [
            `${theme}: --accent-ink on --accent-soft is ${ratio.toFixed(2)}:1, below ${MINIMUM_CONTRAST}:1`,
          ];
    });

    expect(findings).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * REQ-331: the wordmark's second word stands on a measured pair
 * ------------------------------------------------------------------ */

/**
 * The colour half of REQ-331, and the accent under it moved the week it landed.
 *
 * The mark is the product's name in type since the square carrying its first
 * letter came out: `My` in the ink of the text around it, `Chat` in the accent
 * (`.mc-brand__accent` in the component sheet). That second word is TEXT on a
 * resting surface, which is a place the accent had never been written: it fills
 * buttons, tints notices and writes ink on its own soft tint, and every one of
 * those pairs is a different measurement from this one.
 *
 * `--accent` in the dark theme was repainted by REQ-299 (`#7aa2ff` became
 * `#5b93ff`), so this is measured on the palette as it stands and never
 * inherited from what the old accent scored.
 *
 * `.mc-brand` fills no surface of its own, so REQ-195 below has no block to
 * join the ink to and the pair has to be in `CONTRAST_PAIRS` by hand. That is
 * exactly the entry a later edit can drop without a single test going red, so
 * its PRESENCE is asserted here, by the requirement's own name, the way REQ-305
 * above does for the chip of a keyword.
 */
describe("REQ-331: the wordmark is measured, in both themes", () => {
  it("writes the accent as text, in the component sheet", () => {
    // A sheet that failed to load would pass everything below it.
    expect(componentSheet.length).toBeGreaterThan(0);

    const mark = blockAfter(componentSheet, ".mc-brand {");
    const accent = blockAfter(componentSheet, ".mc-brand__accent {");

    expect(mark).toContain("color: var(--fg-1);");
    expect(accent).toContain("color: var(--accent);");

    // And neither of them fills anything, which is what makes the ground under
    // the mark the ground of whatever places it, and this list the only place
    // the pair is measured.
    expect(mark).not.toMatch(/(?:^|[;{\s])background:/);
    expect(accent).not.toMatch(/(?:^|[;{\s])background:/);
  });

  it("floors the accent on the page in the light theme and in the dark one", () => {
    expect(
      CONTRAST_PAIRS.some(
        ({ text, background }) =>
          text === "--accent" && background === "--bg-page",
      ),
      "--accent on --bg-page is measured",
    ).toBe(true);

    const findings = (
      [
        ["light", LIGHT_TOKENS],
        ["dark", DARK_TOKENS],
      ] as const
    ).flatMap(([theme, tokens]) => {
      const ratio = contrastOf(
        valueOf(tokens, "--accent"),
        valueOf(tokens, "--bg-page"),
      );

      return ratio >= MINIMUM_CONTRAST
        ? []
        : [
            `${theme}: --accent on --bg-page is ${ratio.toFixed(2)}:1, below ${MINIMUM_CONTRAST}:1`,
          ];
    });

    expect(findings).toEqual([]);
  });

  it("floors it on the ground the access screen stands on too", () => {
    // The public screen fills with `--surface-app` (`.mc-public`), and the
    // alias `--text-link` already carries this measurement there, so no second
    // entry is written for it. That is only true while the alias holds, and a
    // day it stopped holding is a day this ground silently lost its floor.
    for (const tokens of [LIGHT_TOKENS, DARK_TOKENS]) {
      expect(valueOf(tokens, "--text-link")).toBe(valueOf(tokens, "--accent"));
    }

    const findings = (
      [
        ["light", LIGHT_TOKENS],
        ["dark", DARK_TOKENS],
      ] as const
    ).flatMap(([theme, tokens]) => {
      const ratio = contrastOf(
        valueOf(tokens, "--accent"),
        valueOf(tokens, "--surface-app"),
      );

      return ratio >= MINIMUM_CONTRAST
        ? []
        : [
            `${theme}: --accent on --surface-app is ${ratio.toFixed(2)}:1, below ${MINIMUM_CONTRAST}:1`,
          ];
    });

    expect(findings).toEqual([]);
  });

  it("keeps no square in the sheet for the mark to come back to", () => {
    // The square was a rule and not only a span: leaving it behind would leave
    // the next person a mark to reinstate with one line of JSX.
    expect(componentSheet).not.toContain("brandmark");
  });
});

/* ------------------------------------------------------------------ *
 * REQ-187: the pair measured is the pair painted
 * ------------------------------------------------------------------ */

/**
 * The fifth guardian, and the only one that guards another guardian.
 *
 * REQ-111 above computes a ratio for every entry of `CONTRAST_PAIRS` and holds
 * it to 4.5:1. What it cannot ask is whether the entry is a combination the
 * product HAS. A pair nobody paints resolves like any other, computes a number
 * like any other and passes like any other, and the green tick then states a
 * guarantee about a screen that does not exist. That is worse than no check:
 * a colour really carried by that surface goes unmeasured, and nobody looks,
 * because the list says the surface is covered.
 *
 * Two questions, and each is answered by parsing the sheets rather than by
 * matching text, so a token named in a comment paints nothing:
 *
 *   - is each token of a pair used in its ROLE? A surface has to be the value
 *     of some `background`, an ink the value of some `color`. This is the
 *     question that caught `--text-code` and `--info-ink`, both declared, both
 *     measured here, neither ever written into a rule.
 *   - is each pair a rule WRITES OUT measured? A rule that declares a
 *     background and a colour together is painting that pair with no
 *     inheritance to argue about, so the list has to carry it.
 *
 * What this deliberately does NOT do is resolve the cascade. Most pairs are
 * produced by two rules joined through the document tree (`.mc-panel` fills the
 * card, `.mc-panel__title` writes the ink on it) and following that statically
 * means implementing the cascade, selector matching included. So the role check
 * is per token and not per rule, and it accepts an ink used with some other
 * surface. It is the weaker question, and it is the one that bites: an ink no
 * rule ever writes reaches no surface at all.
 */

/** Every stylesheet, the token sheet included: `base.css` paints the document. */
const STYLE_SHEETS: readonly (readonly [string, string])[] = [
  ...WEB_FILES,
].filter(([path]) => path.endsWith(".css"));

interface StyleRule {
  readonly path: string;
  readonly selector: string;
  readonly body: string;
  /** Where the body starts in the file, so a finding names the real line. */
  readonly bodyStart: number;
}

/**
 * Every rule of a stylesheet, by selector and body.
 *
 * At-rules are told apart by their `@`, and a conditional group is walked INTO
 * rather than reported: a rule inside `@media (prefers-color-scheme: dark)`
 * paints exactly like a rule outside it. An at-STATEMENT (`@import`) ends at
 * its semicolon and opens no block, which is why the loop steps over one.
 */
function rulesIn(
  path: string,
  text: string,
  from = 0,
  to = text.length,
): readonly StyleRule[] {
  const rules: StyleRule[] = [];
  let start = from;
  let index = from;

  while (index < to) {
    const character = text[index];

    if (character === "{") {
      const prelude = text.slice(start, index).trim();
      const close = closingBrace(text, index);
      const body = text.slice(index + 1, close);

      if (prelude.startsWith("@")) {
        rules.push(...rulesIn(path, text, index + 1, close));
      } else {
        rules.push({ path, selector: prelude, body, bodyStart: index + 1 });
      }

      index = close + 1;
      start = index;
      continue;
    }

    if (character === ";" || character === "}") {
      index += 1;
      start = index;
      continue;
    }

    index += 1;
  }

  return rules;
}

/**
 * A declaration that fills a surface or writes text, and only when its value is
 * a bare token.
 *
 * The lookbehind is the whole accuracy of this reader: `border-color`,
 * `accent-color` and `caret-color` all end in `color` and none of them paints
 * text, while `background-image` and `background-size` end in neither. A value
 * that is not a bare `var(--x)` is skipped on purpose: `background: transparent`
 * fills nothing and lets the surface beneath show through, and
 * `background: linear-gradient(...)` is a mark rather than a surface for text.
 */
const PAINT =
  /(?<![\w-])(background-color|background|color)\s*:\s*var\(\s*(--[\w-]+)\s*\)/g;

interface Paint {
  readonly path: string;
  readonly selector: string;
  /** The token the rule fills its background with, or nothing if it fills none. */
  readonly surface: string | null;
  /** The token the rule writes text in, or nothing if it inherits its ink. */
  readonly ink: string | null;
}

/** The last declaration of a block wins, which is what the loop leaves behind. */
function paintOf(rule: StyleRule): Paint {
  let surface: string | null = null;
  let ink: string | null = null;

  for (const [, property, token = null] of rule.body.matchAll(PAINT)) {
    if (property === "color") {
      ink = token;
    } else {
      surface = token;
    }
  }

  return { path: rule.path, selector: rule.selector, surface, ink };
}

const PAINTS: readonly Paint[] = STYLE_SHEETS.flatMap(([path, source]) =>
  rulesIn(path, withoutComments(source)).map(paintOf),
);

function rulesByToken(
  role: (paint: Paint) => string | null,
): ReadonlyMap<string, readonly Paint[]> {
  const grouped = new Map<string, Paint[]>();

  for (const paint of PAINTS) {
    const token = role(paint);

    if (token !== null) {
      const found = grouped.get(token) ?? [];

      found.push(paint);
      grouped.set(token, found);
    }
  }

  return grouped;
}

const SURFACE_RULES = rulesByToken((paint) => paint.surface);
const INK_RULES = rulesByToken((paint) => paint.ink);

/** How a rule comes by its ink, which is half of what a rejected pair must say. */
function inkOfRule(paint: Paint): string {
  return paint.ink === null
    ? `${paint.selector} (inherits its ink)`
    : `${paint.selector} (color: var(${paint.ink}))`;
}

function unpaintedPairs(pairs: readonly Pair[]): readonly string[] {
  return pairs.flatMap(({ text, background }) => {
    const painters = SURFACE_RULES.get(background) ?? [];

    if (painters.length === 0) {
      return [
        `${background} is measured as a surface and no rule fills one with it`,
      ];
    }

    return INK_RULES.has(text)
      ? []
      : [
          `${text} on ${background} is a pair no rule paints: nothing declares color: var(${text}), and ${background} is filled by ${painters.map(inkOfRule).join(", ")}`,
        ];
  });
}

/**
 * A pair as the two colours it resolves to, in BOTH themes: the measurement.
 *
 * Compared by colour and not by name, because `--text-body` and `--text-title`
 * are one measurement written twice and the floor is about light, not about
 * spelling. Both themes go into the key: `--surface-card` and `--surface-field`
 * are the same white in the light theme and two different greys in the dark
 * one, so a single-theme key would let one stand in for the other.
 */
function measurementOf(pair: Pair): string {
  return [LIGHT_TOKENS, DARK_TOKENS]
    .map(
      (tokens) =>
        `${valueOf(tokens, pair.text)} on ${valueOf(tokens, pair.background)}`,
    )
    .join(" | ");
}

function unmeasuredPaints(
  paints: readonly Paint[],
  pairs: readonly Pair[],
): readonly string[] {
  const measured = new Set(pairs.map(measurementOf));

  return paints.flatMap(({ path, selector, surface, ink }) =>
    surface === null ||
    ink === null ||
    measured.has(measurementOf({ text: ink, background: surface }))
      ? []
      : [
          `${path}: ${selector} writes color: var(${ink}) on background: var(${surface}), a pair no entry of CONTRAST_PAIRS measures`,
        ],
  );
}

/* ------------------------------------------------------------------ *
 * REQ-195: the pair the document tree makes, not the one a rule writes
 * ------------------------------------------------------------------ */

/**
 * The sixth guardian, and the question REQ-187 above says out loud that it does
 * not answer: the pair produced by TWO rules joined through the document tree.
 *
 * That gap had a cost, and it was measured before it was closed. `--fg-3` was
 * corrected once for contrast and cleared every surface it was measured
 * against; the surfaces it was measured against were the RESTING ones. A card
 * that fills `--bg-hover` under the pointer and carries `.mc-card__meta` in
 * `--fg-3` puts the two together in the document and in no rule, so the pair
 * existed on screen at 4.43:1 while every guardian passed.
 *
 * Resolving the cascade in general means implementing selector matching, which
 * is why REQ-187 declined it. What is tractable is the convention this
 * stylesheet is actually written in: `.mc-block__element` lives inside
 * `.mc-block`, by construction, and the sheet is hand written and consistent
 * about it. So the block a surface is filled on is crossed with every ink its
 * own elements write, and each crossing is a pair the screen can produce.
 *
 * It is an over-approximation and that is the safe direction: it can name a
 * pair that no arrangement of the markup actually puts together, and the answer
 * to one of those is to clear the floor anyway or to say in the sheet why it
 * cannot happen. It cannot MISS a pair the tree makes.
 */

/** The BEM block a selector belongs to: `.mc-card--interactive:hover` is `mc-card`. */
function blockOf(selector: string): string | null {
  const first = /\.(mc-[A-Za-z0-9_-]+)/.exec(selector)?.[1];

  if (first === undefined) {
    return null;
  }

  return (first.split("__")[0] ?? "").split("--")[0] ?? null;
}

/**
 * The block MODIFIER a selector carries, or nothing when it names the plain
 * block: `.mc-notice--error` is `error`, `.mc-notice__title` is nothing.
 *
 * It is what keeps two states of one component from being read as one element.
 * A notice is `--info` or `--error`, never both, so the accent glyph of the
 * first is not ink on the tinted surface of the second, and the first draft of
 * this sweep reported exactly that pair at 4.49:1 (a real ratio, of a screen
 * nobody can produce).
 */
function modifierOf(selector: string): string | null {
  const first = /\.(mc-[A-Za-z0-9_-]+)/.exec(selector)?.[1];

  return first === undefined || !first.includes("--")
    ? null
    : (first.split("--")[1] ?? null);
}

interface BlockInk {
  readonly ink: string;
  /** The state the ink belongs to, or nothing when it belongs to every state. */
  readonly modifier: string | null;
}

/** Every ink written by an ELEMENT of a block, which is what sits inside it. */
const INKS_BY_BLOCK: ReadonlyMap<string, readonly BlockInk[]> = (() => {
  const grouped = new Map<string, BlockInk[]>();

  for (const paint of PAINTS) {
    const block = blockOf(paint.selector);

    // An element that fills its OWN background sits on that and not on the
    // block's, so nothing joins its ink to the block's surface. Without this,
    // `.mc-sechead--done .mc-sechead__num` (a badge filled with `--success`
    // inside a head that is not) reads as ink on the head. It was written
    // against `.mc-nav__brandmark`, an accent square inside a page-coloured
    // rail, and that square is gone since REQ-331 took the mark to type.
    if (
      paint.ink === null ||
      paint.surface !== null ||
      block === null ||
      !paint.selector.includes("__")
    ) {
      continue;
    }

    const found = grouped.get(block) ?? [];

    found.push({ ink: paint.ink, modifier: modifierOf(paint.selector) });
    grouped.set(block, found);
  }

  return grouped;
})();

interface TreePair extends Pair {
  /** Where the surface is filled, so a failure can be opened rather than hunted. */
  readonly where: string;
}

/**
 * Every ink of a block, over every surface THE BLOCK ITSELF is filled with.
 *
 * The surface must come from the block and never from a sibling element:
 * elements do not contain each other, so a meter's filled bar
 * (`.mc-cap__fill--critical`, a saturated fill carrying no text) is not the
 * surface under a label that `.mc-cap__name` writes. The first draft crossed
 * every element with every other and reported exactly those.
 *
 * An ink written under a state (`.mc-notice--info .mc-notice__icon`) joins only
 * the surface of THAT state, since the states of one component are mutually
 * exclusive; an ink written under the plain block joins them all.
 */
const TREE_PAIRS: readonly TreePair[] = PAINTS.flatMap((paint) => {
  const block = blockOf(paint.selector);
  const surface = paint.surface;

  if (surface === null || block === null || paint.selector.includes("__")) {
    return [];
  }

  const state = modifierOf(paint.selector);

  return (INKS_BY_BLOCK.get(block) ?? [])
    .filter(({ modifier }) => modifier === null || modifier === state)
    .map(({ ink }): TreePair => ({
      text: ink,
      background: surface,
      where: `${paint.path}: ${paint.selector}`,
    }));
});

describe("REQ-195: an ink reaching a surface through the tree clears the floor", () => {
  it.each([
    ["light", LIGHT_TOKENS],
    ["dark", DARK_TOKENS],
  ])("holds every pair the tree can make, in the %s theme", (theme, tokens) => {
    const findings = TREE_PAIRS.flatMap(({ text, background, where }) => {
      const ink = valueOf(tokens, text);
      const surface = valueOf(tokens, background);
      const ratio = contrastOf(ink, surface);

      return ratio >= MINIMUM_CONTRAST
        ? []
        : [
            `${theme}: ${text} (${ink}) on ${background} (${surface}) is ${ratio.toFixed(2)}:1, below ${MINIMUM_CONTRAST}:1, joined by the tree at ${where}`,
          ];
    });

    expect(findings).toEqual([]);
  });

  it("reaches the pair that was measured on screen and passed every guardian", () => {
    // The specimen, and the reason the sweep is not trusted to be non-empty by
    // its own size: `--fg-3` on `--bg-hover` is exactly what `.mc-card__meta`
    // inside `.mc-card--interactive:hover` produces, and it is the pair no rule
    // writes out.
    //
    // `--bg-active` is deliberately NOT asserted, and finding out why corrected
    // the report this requirement came from. The interaction language gives a
    // pressed state a second step of surface, and the interactive CARD never
    // implements one: no rule fills a block with `--bg-active` where an element
    // writes ink, so that pair is not something the tree makes today. It was
    // measured as a token pair, which is a different question, and it is
    // cleared too.
    const reached = new Set(
      TREE_PAIRS.map((pair) => `${pair.text} on ${pair.background}`),
    );

    expect(reached).toContain("--fg-3 on --bg-hover");
  });
});

describe("REQ-187: every measured pair is a pair the sheets paint", () => {
  it("reads real rules, and not the declarations of the token sheet", () => {
    // A reader that matched nothing would call every pair unpainted, and one
    // that took `:root { --surface-app: ... }` for a rule would call the token
    // sheet a painter of everything. Two rules of the real sheets, read whole.
    const painted = new Map(PAINTS.map((paint) => [paint.selector, paint]));

    expect(painted.get("body")).toEqual({
      path: `${TOKEN_SHEET_PREFIX}base.css`,
      selector: "body",
      surface: "--surface-app",
      ink: "--text-body",
    });

    // `:root` declares tokens and paints nothing, in every sheet it appears in.
    expect(painted.get(":root")).toEqual({
      path: expect.stringContaining(TOKEN_SHEET_PREFIX),
      selector: ":root",
      surface: null,
      ink: null,
    });

    // A sweep that lost the sheets would pass everything below it.
    expect(SURFACE_RULES.size).toBeGreaterThan(10);
    expect(INK_RULES.size).toBeGreaterThan(10);
  });

  it("has the whole story, because no screen paints in an inline style", () => {
    // The reader above takes the stylesheets. A colour written into a React
    // style object would be a pair it never sees, so this says out loud that
    // none is: the only tokens the screens spell are lengths (`--space-10`,
    // `--measure-form`). The day a screen paints, this fails instead of the
    // guardian going quietly half blind.
    const inline = GUARDED_FILES.filter(([path]) =>
      path.endsWith(".tsx"),
    ).flatMap(([path, source]) =>
      declarationsIn(withoutComments(source))
        .filter(
          ({ property, value }) =>
            COLOUR_PROPERTIES.test(property) && value.includes("var(--"),
        )
        .map(
          ({ property, index }) =>
            `${at(path, source, index)} paints ${property} outside a stylesheet`,
        ),
    );

    expect(inline).toEqual([]);
  });

  it("carries no pair the interface never paints", () => {
    expect(unpaintedPairs(CONTRAST_PAIRS)).toEqual([]);
  });

  it("names an unpainted surface when a pair is invented", () => {
    // `--rule` draws every hairline in the system and fills no background, so
    // measuring text on it is measuring text on a line.
    expect(unpaintedPairs(inkOn("--rule", "--text-body"))).toEqual([
      "--rule is measured as a surface and no rule fills one with it",
    ]);
  });

  it("measures every pair a rule writes out", () => {
    expect(unmeasuredPaints(PAINTS, CONTRAST_PAIRS)).toEqual([]);
  });

  it("reports a rule whose pair the list forgot", () => {
    // A rule that declares both is painting that pair outright, so the list
    // owes it a measurement. Written as a fixture rather than added to the
    // sheet, because the sheet is the thing under test.
    const invented: Paint = {
      path: COMPONENT_SHEET_PATH,
      selector: ".mc-invented",
      surface: "--surface-card",
      ink: "--warning",
    };

    expect(unmeasuredPaints([invented], CONTRAST_PAIRS)).toEqual([
      `${COMPONENT_SHEET_PATH}: .mc-invented writes color: var(--warning) on background: var(--surface-card), a pair no entry of CONTRAST_PAIRS measures`,
    ]);

    // And the same rule IS accepted once the pair is measured, spelled with the
    // other name for the same colour: the comparison is by value, so a list
    // that says `--text-title` covers a rule that writes `--fg-1`.
    expect(
      unmeasuredPaints([invented], inkOn("--surface-card", "--warning")),
    ).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * REQ-173: no var(--token) points at nothing
 * ------------------------------------------------------------------ */

/**
 * The third guardian. REQ-110 above proves that a screen carries no literal
 * where a token belongs; it never asks whether the token it points AT exists.
 * So `var(--acent)`, one letter off `--accent`, passes the linter, passes the
 * bundler and passes REQ-110, and then paints nothing: CSS resolves an
 * undeclared custom property to the empty value, the declaration is dropped,
 * and the element renders with no colour at all. The failure is silent by
 * construction, which is exactly the kind a gate has to catch.
 *
 * The sweep below is the whole interface, the token sheet INCLUDED: the sheet
 * references its own tokens (`--text-body: var(--fg-1)`, `--ring-focus` builds
 * on `--rule-focus`), and a broken link there breaks every screen downstream.
 * Only the tests are left out, and for the same reason REQ-110 leaves them
 * out: a guardian and its fixtures have to be able to write the very thing they
 * hunt (this file and `dashboard.test.tsx` both spell `var(--x)` in prose while
 * explaining what they do).
 */
const REFERENCE_FILES: readonly (readonly [string, string])[] = [
  ...WEB_FILES,
].filter(([path]) => !/\.test\.tsx?$/.test(path));

/**
 * `var(--x)`, `var( --x )` and `var(--x, fallback)` alike: the name only.
 *
 * A fallback is read and then ignored on purpose. `var(--acent, 1rem)` is not
 * a working declaration with a spare value, it is a typo that silently paints
 * the fallback forever: the reserve exists for a token that is unset at
 * RUNTIME, not for one that exists nowhere in the repository. Reading the name
 * and stopping at the comma is also what keeps a nested `var(--a, var(--b))`
 * honest, since the inner reference is matched in its own right.
 */
const VAR_REFERENCE = /var\(\s*(--[\w-]+)/g;

/**
 * A custom property being DECLARED, in a stylesheet (`--x: value`) or in a
 * React style object (`"--x": value`).
 *
 * The lookbehind is what keeps a BEM selector out: in `.mc-btn--primary:hover`
 * the dashes are preceded by a letter, so `--primary` declares nothing.
 */
const CUSTOM_PROPERTY = /(?<![\w-])(--[\w-]+)\s*["'`]?\s*:/g;

/** Every token sheet, which is where a token is supposed to be declared. */
const TOKEN_SHEETS: readonly (readonly [string, string])[] = [
  ...WEB_FILES,
].filter(([path]) => path.startsWith(TOKEN_SHEET_PREFIX));

/**
 * Every token the design system declares, from every sheet of it.
 *
 * `declarationsOf` is the same reader the contrast guardian uses, run over the
 * whole file rather than over one block: a name declared in the media query or
 * in a forced scope is declared, and for the question this section asks (does
 * the name exist at all?) the last value wins and none of them matter.
 */
const DECLARED_TOKENS: ReadonlyMap<string, string> = new Map(
  TOKEN_SHEETS.flatMap(([, source]) => [
    ...declarationsOf(withoutComments(source)),
  ]),
);

/**
 * Custom properties declared outside the token sheet.
 *
 * A component may declare its own local variable on a wrapper and read it back
 * further down; that is a declaration, not an orphan reference. They are pooled
 * across the sweep rather than scoped per file because a custom property
 * inherits through the DOM: a variable set on a shell element is legitimately
 * consumed by a rule that lives in another sheet. This guardian hunts names
 * that exist NOWHERE, which no amount of inheritance can excuse.
 */
const LOCAL_PROPERTIES: ReadonlySet<string> = new Set(
  REFERENCE_FILES.filter(([path]) => !path.startsWith(TOKEN_SHEET_PREFIX))
    .flatMap(([, source]) => [
      ...withoutComments(source).matchAll(CUSTOM_PROPERTY),
    ])
    .map((match) => match[1] ?? ""),
);

interface Reference {
  readonly path: string;
  readonly name: string;
  readonly index: number;
  readonly source: string;
}

function referencesIn(path: string, source: string): readonly Reference[] {
  const text = withoutComments(source);

  return [...text.matchAll(VAR_REFERENCE)].map((match) => ({
    path,
    name: match[1] ?? "",
    index: match.index,
    source: text,
  }));
}

const REFERENCES: readonly Reference[] = REFERENCE_FILES.flatMap(
  ([path, source]) => referencesIn(path, source),
);

/** A bare alias, `--text-body: var(--fg-1)`, the shape `valueOf` follows. */
const BARE_ALIAS = /^var\((--[\w-]+)\)$/;

/**
 * Follows an alias chain to the value at its end, and reports where it breaks.
 *
 * `--text-body` is `var(--fg-1)` and `--fg-1` is a colour: the intermediate is
 * a declared token like any other, so the walk names it only if the chain runs
 * off the end. The visited list is not decoration either: two tokens that alias
 * each other would otherwise spin here forever instead of failing.
 */
function chainFindings(name: string): readonly string[] {
  const visited: string[] = [];
  let current = name;

  for (;;) {
    if (visited.includes(current)) {
      return [`alias cycle: ${[...visited, current].join(" -> ")}`];
    }

    visited.push(current);

    const value = DECLARED_TOKENS.get(current);

    if (value === undefined) {
      return [`${visited.join(" -> ")} ends on undeclared token ${current}`];
    }

    const alias = BARE_ALIAS.exec(value);

    if (alias === null) {
      return [];
    }

    current = alias[1] ?? "";
  }
}

/** The body of the first unconditional `:root {`, or nothing if there is none. */
function rootBlockOf(source: string): string {
  return source.includes(":root {") ? blockAfter(source, ":root {") : "";
}

describe("REQ-173: every var(--token) points at a declared token", () => {
  it("reads the stylesheets, the screens and the token sheet itself", () => {
    const paths = REFERENCE_FILES.map(([path]) => path);

    // A sweep that quietly matched nothing would report success forever.
    expect(paths).toContain("src/web/components/components.css");
    expect(paths).toContain(`${TOKEN_SHEET_PREFIX}base.css`);
    expect(paths).toContain(COLOUR_TOKENS_PATH);
    expect(paths).toContain("src/web/screens/login.tsx");

    expect(DECLARED_TOKENS.size).toBeGreaterThan(50);
    expect(REFERENCES.length).toBeGreaterThan(100);

    // Both syntaxes reach the sweep: the stylesheets, and the inline style
    // objects, where a token arrives as a string no CSS parser ever looks at.
    expect(
      REFERENCES.some(({ path }) => path === "src/web/screens/login.tsx"),
    ).toBe(true);
  });

  it("references no token that is declared nowhere", () => {
    const findings = REFERENCES.flatMap(({ path, name, index, source }) =>
      DECLARED_TOKENS.has(name) || LOCAL_PROPERTIES.has(name)
        ? []
        : [
            `${at(path, source, index)} var(${name}) is declared nowhere, declare it in styles/tokens/ or fix the name`,
          ],
    );

    expect(findings).toEqual([]);
  });

  it("resolves every alias chain to a value", () => {
    // The reference sweep above already checks each hop, since the token sheet
    // is swept like any other file. This walks the chains end to end anyway,
    // which is what proves the intermediates are not accused of anything and
    // that no two tokens alias each other in a circle.
    const findings = [...DECLARED_TOKENS.keys()].flatMap(chainFindings);

    expect(findings).toEqual([]);

    // The walk has to actually walk: these two are aliases today, and if the
    // design system ever stops using them the assertion says so out loud
    // instead of leaving the check above testing nothing.
    expect(DECLARED_TOKENS.get("--text-body")).toMatch(BARE_ALIAS);
    expect(DECLARED_TOKENS.get("--font-ui")).toMatch(BARE_ALIAS);
  });

  it("declares every token unconditionally, never in one theme alone", () => {
    // A token declared only inside `@media (prefers-color-scheme: dark)` or
    // only inside `[data-theme="light"]` exists in one theme and is the empty
    // value in the other: the reference resolves to nothing and the declaration
    // is dropped, the same silent blank REQ-173 is about. Every sheet therefore
    // declares its full set at the unconditional `:root`, and the conditional
    // blocks may only REPAINT names that already exist there.
    const findings = TOKEN_SHEETS.flatMap(([path, source]) => {
      const text = withoutComments(source);
      const unconditional = declarationsOf(rootBlockOf(text));

      return [...declarationsOf(text).keys()].flatMap((name) =>
        unconditional.has(name)
          ? []
          : [
              `${path}: ${name} is declared only in a conditional block, so it is unset in the other theme`,
            ],
      );
    });

    expect(findings).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * REQ-326: a theme the operator forces is a WHOLE theme
 * ------------------------------------------------------------------ */

/**
 * The two ways a forced theme used to come out half applied, and the guardians
 * that now reach both.
 *
 * They are the same defect twice. A theme is forced by `[data-theme]`, and the
 * sheets did not all answer to it:
 *
 *   1. a DERIVED token (`--surface-app: var(--bg-sunken)`) is resolved on the
 *      element its DECLARATION sits on, and every one of them is declared at
 *      `:root`. The forced scopes restate only the primitives, so a region
 *      carrying the mark used to repaint the primitives and leave the aliases
 *      resolving against whatever the media query had given `:root`. Measured
 *      in Chrome: light region on a dark system, `--bg-sunken` light and
 *      `--surface-app` still dark. The case above, `keeps the forced scopes in
 *      step with the preference`, could not see it: it compares what WAS
 *      restated, and the whole defect is what was not.
 *   2. `shadow.css` answered to `prefers-color-scheme` alone, so a forced light
 *      theme on a dark system drew light surfaces under shadows built for dark
 *      ones. Unreachable while nothing could force a theme, one click away the
 *      moment an operator can pick one (REQ-326).
 */

/** The sheet elevation lives in, read the way the palette is read. */
const SHADOW_TOKENS_PATH = `${TOKEN_SHEET_PREFIX}shadow.css`;
const shadowTokens = WEB_FILES.get(SHADOW_TOKENS_PATH) ?? "";

/** Where a sheet restates what a forced theme must re-resolve per element. */
const FORCED_SCOPE_NAME = "[data-theme]";
const FORCED_SCOPE = `${FORCED_SCOPE_NAME} {`;

/** The dark half of one sheet, or nothing when the sheet has no dark half. */
function darkBlockOf(source: string): string {
  const query = "@media (prefers-color-scheme: dark)";

  return source.includes(query)
    ? blockAfter(blockAfter(source, query), ":root {")
    : "";
}

/** Every token this sheet, or any other, repaints for the dark theme. */
const REPAINTED: ReadonlySet<string> = new Set(
  TOKEN_SHEETS.flatMap(([, source]) => [
    ...declarationsOf(darkBlockOf(withoutComments(source))).keys(),
  ]),
);

/** The names a value reads, in declaration order. */
function tokensRead(value: string): readonly string[] {
  return [...value.matchAll(/var\((--[\w-]+)\)/g)].map(
    (match) => match[1] ?? "",
  );
}

/**
 * Every token whose value MOVES with the theme, primitives and the chains that
 * hang off them.
 *
 * Grown to a fixed point rather than listed: `--surface-app` reads `--bg-sunken`
 * and would be found in one pass, but a token reading `--surface-app` is just
 * as theme varying and nothing says a chain may only be one link long.
 */
const THEME_VARYING: ReadonlySet<string> = ((): ReadonlySet<string> => {
  const varying = new Set(REPAINTED);

  for (let grew = true; grew;) {
    grew = false;

    for (const [name, value] of DECLARED_TOKENS) {
      if (
        !varying.has(name) &&
        tokensRead(value).some((read) => varying.has(read))
      ) {
        varying.add(name);
        grew = true;
      }
    }
  }

  return varying;
})();

/**
 * The same value, whitespace collapsed.
 *
 * A multi-line declaration is wrapped by the formatter at the width its own
 * block leaves it, so the copy under `[data-theme]` is indented differently
 * from the one at `:root` and is the same declaration. Comparing the text
 * character for character would report a drift that does not exist.
 */
function normalized(value: string): string {
  return value.replace(/\s+/g, " ");
}

/**
 * Every derived token a forced theme cannot reach, named with its sheet.
 *
 * Takes the sheets rather than reading them, so the fixture below can hand it a
 * sheet that really has the hole and prove the sweep bites.
 */
function unreachableWhenForced(
  sheets: readonly (readonly [string, string])[],
): readonly string[] {
  return sheets.flatMap(([path, source]) => {
    const text = withoutComments(source);
    const forced = text.includes(FORCED_SCOPE)
      ? declarationsOf(blockAfter(text, FORCED_SCOPE))
      : new Map<string, string>();

    return [...declarationsOf(rootBlockOf(text))].flatMap(([name, value]) =>
      tokensRead(value).some((read) => THEME_VARYING.has(read)) &&
      normalized(forced.get(name) ?? "") !== normalized(value)
        ? [
            `${path}: ${name} reads a token the theme repaints and is not restated under ${FORCED_SCOPE_NAME}, so a forced theme resolves it against the theme it is NOT in`,
          ]
        : [],
    );
  });
}

describe("REQ-326: a forced theme reaches every token, not only the primitives", () => {
  it("restates every derived token where a forced theme can reach it", () => {
    expect(unreachableWhenForced(TOKEN_SHEETS)).toEqual([]);
  });

  it("says so when a derived token is left at the root alone", () => {
    // The sheet as it was before this task: the alias declared once, at
    // `:root`, with the forced scopes restating the primitive under it.
    const before = [
      [
        "fixture.css",
        ':root { --bg-sunken: #ffffff; --surface-app: var(--bg-sunken); }\n[data-theme="dark"] { --bg-sunken: #000000; }',
      ],
    ] as const;

    expect(unreachableWhenForced(before)).toEqual([
      expect.stringContaining("--surface-app"),
    ]);
  });

  it("leaves alone a derived token no theme ever moves", () => {
    // `--font-ui: var(--font-sans)` is derived and answers to no theme, so
    // demanding a copy of it under the forced scope would be noise.
    const steady = [
      [
        "fixture.css",
        ":root { --font-sans: system-ui; --font-ui: var(--font-sans); }",
      ],
    ] as const;

    expect(unreachableWhenForced(steady)).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * REQ-326: elevation follows the theme that was chosen
 * ------------------------------------------------------------------ */

const LIGHT_SHADOWS = declarationsOf(blockAfter(shadowTokens, ":root {"));

const DARK_SHADOWS = new Map([
  ...LIGHT_SHADOWS,
  ...declarationsOf(darkBlockOf(shadowTokens)),
]);

describe("REQ-326: the shadows answer to the choice, not only to the system", () => {
  it("reads the elevation sheet", () => {
    // A sweep that read an empty module would pass everything below it.
    expect(shadowTokens).toContain("--shadow-1");
    expect(shadowTokens).toContain("@media (prefers-color-scheme: dark)");
  });

  it("forces every shadow the dark theme repaints, in both directions", () => {
    // Both, and the light one is the dangerous half: an operator forcing light
    // on a system set to dark is the combination nobody drew, black at 40% and
    // 66% under a white card. Forcing dark on a light system is the mirror.
    const repainted = [...declarationsOf(darkBlockOf(shadowTokens)).keys()];

    expect(repainted.length).toBeGreaterThan(0);

    const findings = ['[data-theme="light"]', '[data-theme="dark"]'].flatMap(
      (selector) => {
        const forced = declarationsOf(blockAfter(shadowTokens, selector));

        return repainted.flatMap((name) =>
          forced.has(name)
            ? []
            : [
                `${selector} does not restate ${name}, so it keeps the system's`,
              ],
        );
      },
    );

    expect(findings).toEqual([]);
  });

  it("keeps the forced scopes in step with the preference", () => {
    // The same duplication the palette carries, held the same way: a value
    // corrected in the media query and forgotten here would give a chosen
    // theme an elevation the theme it copies does not have.
    const drift = [
      ["light", LIGHT_SHADOWS, '[data-theme="light"]'],
      ["dark", DARK_SHADOWS, '[data-theme="dark"]'],
    ] as const;

    const findings = drift.flatMap(([theme, tokens, selector]) =>
      [...declarationsOf(blockAfter(shadowTokens, selector))].flatMap(
        ([name, value]) =>
          normalized(tokens.get(name) ?? "") === normalized(value)
            ? []
            : [
                `${selector}: ${name} is ${value}, the ${theme} theme declares ${tokens.get(name) ?? "nothing"}`,
              ],
      ),
    );

    expect(findings).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * REQ-191: no token stays declared with nobody reading it
 * ------------------------------------------------------------------ */

/**
 * The sixth guardian, and the exact mirror of REQ-173 above.
 *
 * REQ-173 fails when a rule asks for a token the design system never declares.
 * The reverse costs nothing at runtime and everything over time: a token whose
 * last reader was deleted stays in the sheet, reads as part of the system, and
 * is eventually repainted by somebody who believes it is on a screen. It is the
 * same mechanism the catalogue has under REQ-172, where a sentence nobody asks
 * for is reworded as though it were live.
 *
 * Ten were found the day this landed, and two of them had already done damage:
 * `--text-code` and `--info-ink` were declared, were MEASURED by the contrast
 * guardian, and were written into no rule at all. A dead token does not merely
 * sit there; it gets measured, and the measurement is then quoted as a
 * guarantee, which is what REQ-187 above now refuses.
 *
 * A mention in a comment is not a reading, which is what parsing buys over
 * matching text: the paragraph you are reading names two of the ten, and both
 * have to stay dead.
 */
const REFERENCED_TOKENS: ReadonlySet<string> = new Set(
  REFERENCES.map(({ name }) => name),
);

function unreferencedTokens(
  declared: readonly string[],
  referenced: ReadonlySet<string>,
): readonly string[] {
  return declared.flatMap((name) =>
    referenced.has(name)
      ? []
      : [`${name} is declared in styles/tokens/ and no var(${name}) reads it`],
  );
}

describe("REQ-191: no token stays declared with nobody reading it", () => {
  it("reads a reference out of a rule, and not out of a comment", () => {
    // Guards the guard, and guards it against the failure mode that matters:
    // a collector that matched text would count the mention below and call a
    // dead token live forever, which is a check that can never fail.
    const found = referencesIn(
      "fixture.css",
      `.mc-fixture {
         color: var(--read-by-a-rule);
       }
       /* var(--named-in-a-comment) is a mention, not a reading. */`,
    ).map(({ name }) => name);

    expect(found).toEqual(["--read-by-a-rule"]);
  });

  it("collects from both sides of the boundary", () => {
    // A collector that read no stylesheet would accuse most of the system, and
    // one that read no screen would accuse the tokens only a React style object
    // spells: `--measure-form` is read by `screens/publications.tsx` and by
    // `screens/settings.tsx`, in a string no CSS parser ever looks at.
    expect(REFERENCED_TOKENS.has("--accent")).toBe(true);
    expect(REFERENCED_TOKENS.has("--measure-form")).toBe(true);
    expect(REFERENCED_TOKENS.has("--nobody-declared-this")).toBe(false);
  });

  it("declares no token the interface has stopped reading", () => {
    expect(
      unreferencedTokens([...DECLARED_TOKENS.keys()], REFERENCED_TOKENS),
    ).toEqual([]);
  });

  it("reports a token nobody reads, naming it", () => {
    expect(
      unreferencedTokens(["--declared-and-forgotten"], REFERENCED_TOKENS),
    ).toEqual([
      "--declared-and-forgotten is declared in styles/tokens/ and no var(--declared-and-forgotten) reads it",
    ]);
  });
});

/* ------------------------------------------------------------------ *
 * REQ-176: every graphical mark has a floor of its own
 * ------------------------------------------------------------------ */

/**
 * The fourth guardian, and the one REQ-111 above cannot stand in for.
 *
 * `CONTRAST_PAIRS` is a list of INK on SURFACE, and every entry of it is text.
 * A bar, a meter fill and a chart column carry a datum with no letters in them,
 * so none of them has a pair up there. They clear the floor today only because
 * the tokens they happen to be painted with (`--accent`, `--success`,
 * `--warning`, `--danger`) are also measured as text somewhere else, which is
 * luck and not a rule: repaint `--accent` for a button and every bar in the
 * product moves with it, unmeasured.
 *
 * WCAG 2.2 asks for 3:1 on non-text that carries information (1.4.11), not the
 * 4.5:1 text asks for. The two floors live side by side here: neither replaces
 * the other, and a token that serves as both ink and mark has to clear both.
 *
 * What is deliberately NOT measured here, because it is decoration and has its
 * own rule: the rules between rows and the chart baseline (`--rule`), the
 * shadows, and the focus ring. They separate and they point; they never say
 * what the number is. What IS measured is the three families REQ-176 names: the
 * table bar, the cap fill and the chart column.
 */
const MINIMUM_MARK_CONTRAST = 3;

/**
 * The token a rule paints its `background` with, read from the real sheet.
 *
 * `background-image` and the borders are stepped over on purpose: the question
 * is what fills the shape, and `.mc-trend__bar` declares a `border-right` in the
 * card's own colour one line above the fill it is asked about.
 */
function backgroundTokenOf(selector: string): string {
  const rule = blockAfter(componentSheet, `${selector} {`);
  const painted = /(?:^|[\s;{])background\s*:\s*([^;]+)/.exec(rule);

  expect(painted, `${selector} paints no background`).not.toBeNull();

  const token = /^var\(\s*(--[\w-]+)\s*\)$/.exec((painted?.[1] ?? "").trim());

  expect(
    token,
    `${selector} paints ${painted?.[1] ?? ""}, not a token`,
  ).not.toBeNull();

  return token?.[1] ?? "";
}

interface Mark {
  /** The class that paints the mark, exactly as the sheet spells it. */
  readonly mark: string;
  /** The token the mark is filled with. */
  readonly paint: string;
  /** The class that paints what the mark sits ON. */
  readonly surfaceRule: string;
  /** The token that surface is filled with. */
  readonly surface: string;
}

/**
 * Every graphical mark that carries a datum, with the surface under each one.
 *
 * The surface is the NEAREST painted thing, which is not always the card: the
 * cap fill sits inside `.mc-cap__track`, a pill the meter paints in
 * `--bg-active`, and measuring that fill against the card would be measuring a
 * surface it never touches.
 *
 * The cap fill appears twice, against the track AND against the card, and that
 * is the measurement talking rather than caution. The track is 1.20:1 from the
 * card in the light theme and 1.27:1 in the dark one, which is a surface an eye
 * barely finds: the fill is therefore read against both, and both have to hold.
 * The bars have one surface each because the things under them paint nothing of
 * their own: `.mc-trend__track` and the table cell let the panel and the table
 * wrapper show through.
 *
 * Every claim in this list is checked against the sheet below, because a list
 * written by hand is a copy, and a copy drifts the day a rule is renamed.
 */
const INFORMATION_MARKS: readonly Mark[] = [
  {
    mark: ".mc-table__bar",
    paint: "--accent",
    surfaceRule: ".mc-tablewrap",
    surface: "--surface-card",
  },
  {
    mark: ".mc-trend__bar",
    paint: "--accent",
    surfaceRule: ".mc-panel",
    surface: "--surface-card",
  },
  {
    mark: ".mc-cap__fill--normal",
    paint: "--success",
    surfaceRule: ".mc-cap__track",
    surface: "--bg-active",
  },
  {
    mark: ".mc-cap__fill--normal",
    paint: "--success",
    surfaceRule: ".mc-panel",
    surface: "--surface-card",
  },
  {
    mark: ".mc-cap__fill--attention",
    paint: "--warning",
    surfaceRule: ".mc-cap__track",
    surface: "--bg-active",
  },
  {
    mark: ".mc-cap__fill--attention",
    paint: "--warning",
    surfaceRule: ".mc-panel",
    surface: "--surface-card",
  },
  {
    mark: ".mc-cap__fill--critical",
    paint: "--danger",
    surfaceRule: ".mc-cap__track",
    surface: "--bg-active",
  },
  {
    mark: ".mc-cap__fill--critical",
    paint: "--danger",
    surfaceRule: ".mc-panel",
    surface: "--surface-card",
  },
  /*
   * The switch, which is a mark carrying a STATE rather than a datum, and the
   * reason it belongs in this list all the same: 1.4.11 is about "information
   * required to identify a component and its state", and off-versus-on is
   * exactly that. It is measured on every surface a switch really sits on in
   * this product — the card of a section head, the sunken block of a question
   * that is shut, the tint of one that is open — because the track is the same
   * two fills wherever it lands.
   *
   * This is what kept `--rule-strong` out of the track. It is the line colour
   * the prototype drew the switch in and it reaches 1.52:1 on a card in the
   * light theme and 1.64:1 in the dark one: a control the eye has to hunt for,
   * and the arithmetic is above rather than in a reviewer's opinion.
   */
  {
    mark: ".mc-switch__track",
    paint: "--fg-3",
    surfaceRule: ".mc-panel",
    surface: "--surface-card",
  },
  {
    mark: ".mc-switch__track",
    paint: "--fg-3",
    surfaceRule: ".mc-opening-step",
    surface: "--bg-sunken",
  },
  {
    mark: ".mc-switch input:checked + .mc-switch__track",
    paint: "--success",
    surfaceRule: ".mc-panel",
    surface: "--surface-card",
  },
  {
    mark: ".mc-switch input:checked + .mc-switch__track",
    paint: "--success",
    surfaceRule: ".mc-opening-step:has(input:checked)",
    surface: "--accent-soft",
  },
  // And the pin against the track it travels on: the position of that pin is
  // half of what says on from off, so a pin the same weight as its track says
  // nothing at all.
  {
    mark: ".mc-switch__track::after",
    paint: "--bg-page",
    surfaceRule: ".mc-switch__track",
    surface: "--fg-3",
  },
  {
    mark: ".mc-switch__track::after",
    paint: "--bg-page",
    surfaceRule: ".mc-switch input:checked + .mc-switch__track",
    surface: "--success",
  },
];

/**
 * Every mark under the floor, named with its theme and the ratio measured.
 *
 * Takes the palette rather than reading one, which is what lets the guard of
 * the guard below hand it a repainted map and prove that a mark too close to
 * its surface is reported instead of passed over.
 */
function marksBelowFloor(
  theme: string,
  tokens: ReadonlyMap<string, string>,
): readonly string[] {
  return INFORMATION_MARKS.flatMap(({ mark, paint, surfaceRule, surface }) => {
    const ink = valueOf(tokens, paint);
    const ground = valueOf(tokens, surface);
    const ratio = contrastOf(ink, ground);

    return ratio >= MINIMUM_MARK_CONTRAST
      ? []
      : [
          `${theme}: ${mark} (${paint} ${ink}) on ${surfaceRule} (${surface} ${ground}) is ${ratio.toFixed(2)}:1, below ${MINIMUM_MARK_CONTRAST}:1`,
        ];
  });
}

describe("REQ-176: every graphical mark clears 3:1 on what it sits on", () => {
  it("names a mark the sheet really paints, with the token it really uses", () => {
    // The list above is prose until this runs. A rule renamed, a fill repainted
    // from `--success` to something else, a track that stops painting at all:
    // each of them leaves the floor measuring a pair the product no longer has,
    // and each of them fails here by name instead of passing quietly.
    expect(componentSheet.length).toBeGreaterThan(0);

    const findings = INFORMATION_MARKS.flatMap(
      ({ mark, paint, surfaceRule, surface }) => [
        ...(backgroundTokenOf(mark) === paint
          ? []
          : [
              `${COMPONENT_SHEET_PATH}: ${mark} is painted ${backgroundTokenOf(mark)}, this floor measures ${paint}`,
            ]),
        ...(backgroundTokenOf(surfaceRule) === surface
          ? []
          : [
              `${COMPONENT_SHEET_PATH}: ${surfaceRule} is painted ${backgroundTokenOf(surfaceRule)}, this floor measures ${surface}`,
            ]),
      ],
    );

    expect(findings).toEqual([]);

    // The three families REQ-176 names are all present. A list that lost one
    // would still pass every assertion below it, having measured nothing.
    const measured = INFORMATION_MARKS.map(({ mark }) => mark);

    expect(measured).toContain(".mc-table__bar");
    expect(measured).toContain(".mc-trend__bar");
    expect(measured).toContain(".mc-cap__fill--critical");
  });

  it("clears 3:1 on every graphical mark, light theme", () => {
    expect(marksBelowFloor("light", LIGHT_TOKENS)).toEqual([]);
  });

  it("clears 3:1 on every graphical mark, dark theme", () => {
    expect(marksBelowFloor("dark", DARK_TOKENS)).toEqual([]);
  });

  it("reports the mark, the theme and the ratio when one sinks", () => {
    // The accent repainted as the very surface it sits on: 1.00:1, the worst a
    // mark can do. It is written as an ALIAS and not as a colour, so the
    // fixture still takes every value from the sheet and this file carries no
    // colour of its own.
    const card = valueOf(LIGHT_TOKENS, "--surface-card");
    const flattened = new Map([
      ...LIGHT_TOKENS,
      ["--accent", "var(--surface-card)"],
    ]);

    // Both accent marks are named, and the three cap fills are NOT: the fill is
    // painted from another token, so the guard has to leave it alone while the
    // bars burn. Compared whole rather than by membership, which is what makes
    // the absences an assertion instead of an assumption.
    expect(marksBelowFloor("light", flattened)).toEqual([
      `light: .mc-table__bar (--accent ${card}) on .mc-tablewrap (--surface-card ${card}) is 1.00:1, below 3:1`,
      `light: .mc-trend__bar (--accent ${card}) on .mc-panel (--surface-card ${card}) is 1.00:1, below 3:1`,
    ]);

    // The same proof in the other theme, on the other family: the dark palette
    // is a different map, and a guardian that only ever bit in the light one
    // would leave half the product unmeasured.
    const track = valueOf(DARK_TOKENS, "--bg-active");
    const sunkFill = new Map([
      ...DARK_TOKENS,
      ["--success", "var(--bg-active)"],
    ]);
    const cardDark = valueOf(DARK_TOKENS, "--surface-card");
    const trackOnCard = contrastOf(track, cardDark).toFixed(2);
    // `--success` is read by two families, and repainting it has to burn both:
    // the meter's fill and the switch that is ON. The knob comes with them, and
    // from the other side — it is the one entry where `--success` is the
    // SURFACE, so a guard that only followed the paint would miss it.
    const litTint = valueOf(DARK_TOKENS, "--accent-soft");
    const pin = valueOf(DARK_TOKENS, "--bg-page");
    const trackOnTint = contrastOf(track, litTint).toFixed(2);
    const pinOnTrack = contrastOf(pin, track).toFixed(2);

    expect(marksBelowFloor("dark", sunkFill)).toEqual([
      `dark: .mc-cap__fill--normal (--success ${track}) on .mc-cap__track (--bg-active ${track}) is 1.00:1, below 3:1`,
      `dark: .mc-cap__fill--normal (--success ${track}) on .mc-panel (--surface-card ${cardDark}) is ${trackOnCard}:1, below 3:1`,
      `dark: .mc-switch input:checked + .mc-switch__track (--success ${track}) on .mc-panel (--surface-card ${cardDark}) is ${trackOnCard}:1, below 3:1`,
      `dark: .mc-switch input:checked + .mc-switch__track (--success ${track}) on .mc-opening-step:has(input:checked) (--accent-soft ${litTint}) is ${trackOnTint}:1, below 3:1`,
      `dark: .mc-switch__track::after (--bg-page ${pin}) on .mc-switch input:checked + .mc-switch__track (--success ${track}) is ${pinOnTrack}:1, below 3:1`,
    ]);
  });
});

/* ------------------------------------------------------------------ *
 * REQ-268: one tap size, and every button is cut to it
 * ------------------------------------------------------------------ */

/**
 * The eighth guardian, and the first one about hands rather than about ink.
 *
 * REQ-268 is two claims, and they fail in opposite directions:
 *
 *   - there is ONE token. A system carrying `--tap` and `--tap-min` has no tap
 *     size, it has a preference, and the second name is where every dense row
 *     goes to ask for its exemption. This sheet declared `--tap-min: 2.25rem`
 *     for two phases, 36px, and it was read by the buttons, the fields and the
 *     icon buttons alike: the whole product sat eight pixels under the floor
 *     with nothing anywhere to say so;
 *   - every button is cut to that token. A rule may not write the height out
 *     by hand, and it may not take the floor away: `.mc-btn--link` declared
 *     `min-height: 0` and produced a "Delete" about eighteen pixels tall,
 *     beside an "Edit" in the same row that was fine.
 *
 * The floor is COMPUTED and not restated: the declared rem is multiplied by the
 * root size and compared against the 44px WCAG 2.5.5 asks for, so a token
 * edited down to 2rem fails on the arithmetic instead of on somebody noticing.
 *
 * What no guardian here can do is measure a rendered button, since jsdom
 * applies no stylesheet. Those pixels are read in a browser, at 320, 390, 768
 * and 1440 and in both themes, and what is guarded here is the half that rots:
 * the token staying single, and the rules staying written against it.
 */

/** The one token a control's size may come from. */
const TAP_TOKEN = "--tap";

/** WCAG 2.5.5 for a pointer target, in the unit the guideline is written in. */
const TAP_FLOOR_PX = 44;

/**
 * What a rem is worth to a reader who changed nothing.
 *
 * A reader who enlarged the browser's text gets a bigger target than this,
 * which is the whole reason the token is a rem and not a pixel count.
 */
const ROOT_FONT_PX = 16;

const SPACING_SHEET_PATH = `${TOKEN_SHEET_PREFIX}spacing.css`;

/** A length in rem or px as a number of pixels, or NaN if it is neither. */
function pixelsOf(length: string): number {
  const written = /^\s*([\d.]+)(rem|px)\s*$/.exec(length);

  if (written === null) {
    return Number.NaN;
  }

  return Number(written[1]) * (written[2] === "rem" ? ROOT_FONT_PX : 1);
}

/**
 * What a button is, read off the naming convention and not off a list of
 * screens: every class of this system whose name carries `btn` is a button or a
 * modifier of one. `.mc-btn`, `.mc-btn--ghost`, `.mc-iconbtn`, and the
 * `.mc-btn--sm` that used to exist and must not come back.
 *
 * A list of screens would go stale on the next component. The controls this
 * convention does not name are covered from the other side, in
 * `components/components.test.tsx`, which collects the classes off buttons it
 * really rendered rather than off the sheet.
 */
const BUTTON_SELECTOR = /\.mc-[\w-]*btn[\w-]*/;

/** What decides how big a target is, in both the physical and logical names. */
const SIZE_PROPERTY = /^(min-|max-)?(height|width|block-size|inline-size)$/;

/**
 * Values that declare no size at all, so they neither obey the token nor break
 * it: the block modifier's `width: 100%`, an `auto` that hands the decision to
 * the content.
 *
 * `0` is deliberately absent. `min-height: 0` is not "no opinion", it is the
 * floor removed, and it is how the link weight lost its target.
 */
const NO_SIZE =
  /^(auto|100%|inherit|initial|revert|unset|fit-content|max-content|min-content)$/;

/** The selector as one line, so a finding reads on one line too. */
function oneLine(selector: string): string {
  return selector.replace(/\s+/g, " ");
}

function tapFindings(path: string, source: string): readonly string[] {
  const text = withoutComments(source);
  const findings: string[] = [];

  for (const rule of rulesIn(path, text)) {
    if (!BUTTON_SELECTOR.test(rule.selector)) {
      continue;
    }

    for (const declaration of declarationsIn(rule.body)) {
      if (!SIZE_PROPERTY.test(declaration.property)) {
        continue;
      }

      const where = at(path, text, rule.bodyStart + declaration.index);
      const value = declaration.value.trim();
      const literal = [...value.matchAll(LENGTH_LITERAL)][0]?.[0];

      if (literal !== undefined) {
        findings.push(
          `${where} ${declaration.property}: ${value} on ${oneLine(rule.selector)} writes ${literal} by hand, the one tap size is var(${TAP_TOKEN})`,
        );
        continue;
      }

      if (!value.includes(`var(${TAP_TOKEN})`) && !NO_SIZE.test(value)) {
        findings.push(
          `${where} ${declaration.property}: ${value} on ${oneLine(rule.selector)} sizes a button from something that is not var(${TAP_TOKEN})`,
        );
      }
    }
  }

  return findings;
}

/** The stylesheets of the interface: the component sheet and the app sheet. */
const STYLESHEETS: readonly (readonly [string, string])[] =
  GUARDED_FILES.filter(([path]) => path.endsWith(".css"));

/** Every button rule of the interface, with the file it was written in. */
const BUTTON_RULES: readonly StyleRule[] = STYLESHEETS.flatMap(
  ([path, source]) =>
    rulesIn(path, withoutComments(source)).filter((rule) =>
      BUTTON_SELECTOR.test(rule.selector),
    ),
);

describe("REQ-268: one tap size, declared once", () => {
  it("declares the token in the spacing sheet and nowhere else", () => {
    const spacing = WEB_FILES.get(SPACING_SHEET_PATH) ?? "";

    // A sweep that read an empty module would pass everything below forever.
    expect(spacing.length).toBeGreaterThan(0);

    // One declaration, in one sheet. A second one in another file is the same
    // ambiguity as a second name, settled by load order instead of by anyone.
    const declaredIn = TOKEN_SHEETS.flatMap(([path, source]) =>
      [...withoutComments(source).matchAll(/--tap\s*:/g)].map(() => path),
    );

    expect(declaredIn).toEqual([SPACING_SHEET_PATH]);
  });

  it("has no second name claiming to be a target size", () => {
    // `--tap-min` is the name this replaced, and a guard that only knew the new
    // name would happily let the old one come back beside it.
    const rivals = [...DECLARED_TOKENS.keys()].filter(
      (name) =>
        name !== TAP_TOKEN &&
        /tap|hit|touch|target|(control|button)-(size|height)/.test(name),
    );

    expect(rivals).toEqual([]);
  });

  it("clears the 44px of WCAG 2.5.5, and grows with the reader's text", () => {
    const declared = DECLARED_TOKENS.get(TAP_TOKEN) ?? "";

    // In rem, which is the half of the requirement a pixel value throws away:
    // a person who enlarged the browser's text gets a target that grew too.
    expect(declared).toMatch(/rem$/);
    expect(pixelsOf(declared)).toBeGreaterThanOrEqual(TAP_FLOOR_PX);
  });
});

describe("REQ-268: no button is sized outside the token", () => {
  it("reads the real stylesheets, and finds the buttons in them", () => {
    const paths = STYLESHEETS.map(([path]) => path);

    expect(paths).toContain("src/web/components/components.css");
    expect(paths).toContain("src/web/styles/app.css");

    // The walker really walks: a parser that returned nothing would make the
    // sweep below pass on an empty set, which is a check that cannot fail.
    expect(BUTTON_RULES.length).toBeGreaterThan(5);

    // And the two rules that carry the size for the whole product are among
    // them, each one really declaring a size rather than merely existing.
    const sized = BUTTON_RULES.filter((rule) =>
      declarationsIn(rule.body).some(({ property }) =>
        SIZE_PROPERTY.test(property),
      ),
    ).map((rule) => rule.selector);

    expect(sized).toContain(".mc-btn");
    expect(sized).toContain(".mc-iconbtn");
  });

  it("reports a second size, a floor removed, and one hidden in a query", () => {
    // The detector proved on fixtures, so a green sweep below means the sheets
    // are clean and not that the pattern quietly stopped matching.
    expect(
      tapFindings("f.css", ".mc-btn--sm {\n  min-height: 1.75rem;\n}"),
    ).toEqual([
      "f.css:2 min-height: 1.75rem on .mc-btn--sm writes 1.75rem by hand, the one tap size is var(--tap)",
    ]);

    expect(
      tapFindings("f.css", ".mc-btn--link {\n  min-height: 0;\n}"),
    ).toEqual([
      "f.css:2 min-height: 0 on .mc-btn--link sizes a button from something that is not var(--tap)",
    ]);

    // Behind a media query, which is the one place a button gets shrunk and
    // nobody working on a desktop ever sees it.
    expect(
      tapFindings(
        "f.css",
        "@media (max-width: 35rem) {\n  .mc-iconbtn {\n    height: 1.75rem;\n  }\n}",
      ),
    ).toHaveLength(1);

    // And it leaves alone what declares no size, what takes the token, and what
    // derives from the token by arithmetic.
    expect(tapFindings("f.css", ".mc-btn--block {\n  width: 100%;\n}")).toEqual(
      [],
    );
    expect(
      tapFindings("f.css", ".mc-btn {\n  min-height: var(--tap);\n}"),
    ).toEqual([]);
    expect(
      tapFindings(
        "f.css",
        ".mc-btn {\n  min-height: calc(var(--tap) + var(--space-2));\n}",
      ),
    ).toEqual([]);

    // A rule that is not a button is none of this guardian's business: the
    // thumbnail cell of a tile is a measurement of that widget.
    expect(
      tapFindings("f.css", ".mc-pubtile__frame {\n  height: 4.5rem;\n}"),
    ).toEqual([]);
  });

  it("takes every button height in the interface from var(--tap)", () => {
    const findings = STYLESHEETS.flatMap(([path, source]) =>
      tapFindings(path, source),
    );

    expect(findings).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * REQ-281: one rule decides the floor of every multi-line box
 * ------------------------------------------------------------------ */

/**
 * The ninth guardian, and the second one about a size rather than about ink.
 *
 * REQ-281 is one claim written twice: a box that takes more than one line has a
 * floor of 74px everywhere in the interface, and ONE rule says so. The two
 * halves fail together. `.mc-textarea` declared 9rem, 144px, an empty box the
 * height of an essay under a label that asks for a sentence; and beside it two
 * modifiers declared floors of their own, so which floor a screen got depended
 * on which modifier it happened to pass. A floor a modifier can move is not a
 * floor, it is a default.
 *
 * The sweep is written against the SELECTOR and not against a list of files: a
 * height declared on `textarea` as an element, in a sheet nobody thought to
 * look in, sizes exactly the same boxes as a height declared on the class. What
 * it finds is compared whole against the two rules that are allowed to exist,
 * so a third one is a failure and not a detail.
 *
 * What no guardian here can do is measure a rendered box, since jsdom applies
 * no stylesheet. Those pixels are read in a browser; what is guarded here is
 * the half that rots, which is the count of rules that have an opinion.
 */

/** The floor the prototype (`docs/prototipo-automacao.html`) draws. */
const TEXTAREA_FLOOR_PX = 74;

/** A selector about a multi-line box, whether by class or by element name. */
const TEXTAREA_SELECTOR = /\.mc-textarea|(?:^|[\s,>+~])textarea\b/;

/** What decides how short a box may be, in the physical name and the logical. */
const FLOOR_PROPERTY = /^(min-)?(height|block-size)$/;

/** Every floor a sheet declares for a multi-line box, by selector and value. */
function floorFindings(path: string, source: string): readonly string[] {
  const findings: string[] = [];

  for (const rule of rulesIn(path, withoutComments(source))) {
    if (!TEXTAREA_SELECTOR.test(rule.selector)) {
      continue;
    }

    for (const { property, value } of declarationsIn(rule.body)) {
      if (FLOOR_PROPERTY.test(property)) {
        findings.push(`${oneLine(rule.selector)} ${property}: ${value.trim()}`);
      }
    }
  }

  return findings;
}

describe("REQ-281: one rule decides the floor of every multi-line box", () => {
  it("reads every stylesheet of the interface, the component sheet included", () => {
    const paths = STYLE_SHEETS.map(([path]) => path);

    // A sweep that read nothing would pass everything below forever.
    expect(paths).toContain(COMPONENT_SHEET_PATH);
    expect(paths).toContain("src/web/styles/app.css");
    expect(paths.length).toBeGreaterThan(2);
  });

  it("reports a floor written on a class, on the element, or in a query", () => {
    // The detector proved on fixtures, so a green sweep below means the sheets
    // really carry one rule and not that the pattern quietly stopped matching.
    expect(
      floorFindings(
        "f.css",
        ".mc-textarea--fixture {\n  min-height: 16rem;\n}",
      ),
    ).toEqual([".mc-textarea--fixture min-height: 16rem"]);

    // The element, which no sweep written against the class would ever see.
    expect(floorFindings("f.css", "textarea {\n  height: 12rem;\n}")).toEqual([
      "textarea height: 12rem",
    ]);

    // Behind a media query, which is the one place a box gets resized and
    // nobody working on a desktop ever sees it.
    expect(
      floorFindings(
        "f.css",
        "@media (max-width: 35rem) {\n  .mc-textarea {\n    min-height: 20rem;\n  }\n}",
      ),
    ).toEqual([".mc-textarea min-height: 20rem"]);

    // And it leaves alone what is not a floor, and what is not a box: the
    // shorthand `line-height` ends in the same word and sizes nothing.
    expect(
      floorFindings("f.css", ".mc-textarea {\n  line-height: 1.5;\n}"),
    ).toEqual([]);
    expect(
      floorFindings("f.css", ".mc-input {\n  min-height: var(--tap);\n}"),
    ).toEqual([]);
  });

  it("finds two rules with an opinion, and the floor is the prototype's", () => {
    const declared = STYLE_SHEETS.flatMap(([path, source]) =>
      floorFindings(path, source),
    );

    // The floor of the whole interface, and the ONE departure the prototype
    // itself draws: a box for a sentence rather than for a paragraph
    // (REQ-266).
    expect(declared).toEqual([
      ".mc-textarea min-height: 4.625rem",
      ".mc-textarea--compact min-height: 3.5rem",
    ]);

    // In rem, which is the half a pixel value throws away: a reader who
    // enlarged the browser's text gets a box that grew with it. The pixels are
    // arithmetic off the sheet, so a value edited down fails on the number.
    const floor = /min-height: (.+)$/.exec(declared[0] ?? "")?.[1] ?? "";

    expect(floor).toMatch(/rem$/);
    expect(pixelsOf(floor)).toBe(TEXTAREA_FLOOR_PX);
  });
});

/* ------------------------------------------------------------------ *
 * REQ-299: the application paints in the prototype's palette
 * ------------------------------------------------------------------ */

/**
 * The tenth guardian, and the first one that reads a file outside `src/web`.
 *
 * `docs/prototipo-automacao.html` is where a screen is proposed in this project
 * and it is the artefact the user APPROVES BY LOOKING AT IT. Every value in it
 * therefore carries a decision that no measurement in this file can stand in
 * for: which blue an accent is, how dark a tint sits under a notice. When the
 * application and the prototype disagree, the application is the one that is
 * wrong, and until REQ-299 nothing said so: thirteen tokens of the dark theme
 * had drifted apart and the divergence was found by a person comparing two
 * files by eye, months after it happened.
 *
 * What this checks is exactly the requirement and not more of it: every token
 * the two files BOTH declare has to carry the same value, in both themes. A
 * token only the prototype spells is out of reach here (its radius, spacing and
 * font tokens live in the sibling sheets of `tokens/`, not in this one), and a
 * token only the application spells is an extension it is entitled to, which
 * the last assertion below defends against a future reading of "adopt the
 * palette" as "delete whatever the prototype forgot".
 *
 * It measures nothing. REQ-111 and REQ-176 above already hold every pair and
 * every mark against their floors, and they read the same sheet this one does,
 * so a value adopted from the prototype that sank a pair would fail there by
 * name. The two guardians are complementary on purpose: this one says the
 * palette is the approved one, those say the approved one is legible.
 */
const PROTOTYPE_PATH = "docs/prototipo-automacao.html";

/**
 * The prototype, as text, through the same mechanism as everything else here.
 *
 * A glob for a single file rather than an import, and the reason is the rule in
 * `tests/import-extensions.test.ts` (REQ-082): every relative specifier in the
 * repository ends in `.js`, and a `?raw` import of an `.html` file would be the
 * one exception. `import.meta.glob` is not a specifier and needs none.
 */
const PROTOTYPE_SOURCES = import.meta.glob<string>(
  "../../../docs/prototipo-automacao.html",
  { eager: true, query: "?raw", import: "default" },
);

const prototypeSheet = withoutComments(
  Object.values(PROTOTYPE_SOURCES)[0] ?? "",
);

/**
 * The two palettes of each file, as each file DECLARES them and not as a
 * browser would resolve them.
 *
 * Own declarations, which matters more than it looks: `DARK_TOKENS` above
 * layers the dark block on top of the light one, because that is what the
 * cascade does, and a comparison built that way would hold the application's
 * dark `--rule-focus` against a prototype value that is really the LIGHT one
 * showing through a token the prototype never redeclares. Comparing what each
 * file writes keeps the question answerable: the two agree where both spoke.
 *
 * The dark palette read from the prototype is the one behind the media query
 * and not the forced scope, because the media query is what the user's browser
 * applied while they were looking at the page and approving it.
 */
const APPLICATION_PALETTES: readonly (readonly [
  string,
  ReadonlyMap<string, string>,
])[] = [
  ["light", LIGHT_TOKENS],
  [
    "dark",
    declarationsOf(
      blockAfter(
        blockAfter(colourTokens, "@media (prefers-color-scheme: dark)"),
        ":root {",
      ),
    ),
  ],
];

const PROTOTYPE_PALETTES: readonly (readonly [
  string,
  ReadonlyMap<string, string>,
])[] = [
  ["light", declarationsOf(blockAfter(prototypeSheet, ":root {"))],
  [
    "dark",
    declarationsOf(
      blockAfter(
        blockAfter(prototypeSheet, "@media (prefers-color-scheme: dark)"),
        ':root:not([data-theme="light"])',
      ),
    ),
  ],
];

/** The tokens both files declare in one theme, which is what REQ-299 binds. */
function sharedTokens(theme: string): readonly string[] {
  const proposed = PROTOTYPE_PALETTES.find(([name]) => name === theme)?.[1];
  const shipped = APPLICATION_PALETTES.find(([name]) => name === theme)?.[1];

  return [...(proposed ?? [])]
    .map(([name]) => name)
    .filter((name) => shipped?.has(name) === true);
}

/** Every shared token the application spells differently, named with both. */
function paletteDrift(): readonly string[] {
  return PROTOTYPE_PALETTES.flatMap(([theme, proposed]) => {
    const shipped =
      APPLICATION_PALETTES.find(([name]) => name === theme)?.[1] ?? new Map();

    return [...proposed].flatMap(([name, approved]) => {
      const painted = shipped.get(name);

      return painted === undefined || painted === approved
        ? []
        : [
            `${theme}: ${name} is ${painted} in ${COLOUR_TOKENS_PATH}, ${approved} in ${PROTOTYPE_PATH}`,
          ];
    });
  });
}

/**
 * The tokens the application declares and the prototype does not, by name.
 *
 * Four of them, and all four are STATES: the pressed primary button, the two
 * states of the destructive one, and the ink a field writes its error in. A
 * prototype proposes a screen at rest, so it never had to name them, and the
 * application needs them the moment a finger lands on a control. Written out
 * rather than derived, because the claim is that these survive an adoption of
 * the palette, and a list computed from the same two files would agree with
 * whatever the files happened to say.
 */
const APPLICATION_ONLY_TOKENS: readonly string[] = [
  "--accent-active",
  "--danger-hover",
  "--danger-active",
  "--danger-ink",
];

describe("REQ-299: the palette is the one the prototype proposes", () => {
  it("reads the prototype and the token sheet, and finds a palette in each", () => {
    // A glob that matched nothing, a selector that moved, a `<style>` block
    // renamed: each leaves every assertion below comparing an empty map against
    // an empty map and reporting success.
    expect(prototypeSheet.length).toBeGreaterThan(0);
    expect(colourTokens.length).toBeGreaterThan(0);

    for (const [theme, palette] of PROTOTYPE_PALETTES) {
      expect(
        palette.size,
        `prototype declares no ${theme} palette`,
      ).toBeGreaterThan(20);
    }

    // And the two really overlap, on the families the requirement is about.
    for (const theme of ["light", "dark"]) {
      const shared = sharedTokens(theme);

      expect(shared, `${theme}: nothing shared`).toEqual(
        expect.arrayContaining([
          "--bg-page",
          "--fg-1",
          "--fg-on-accent",
          "--accent",
          "--accent-soft",
          "--success",
          "--warning",
          "--danger",
        ]),
      );
      expect(shared.length, `${theme}: too little shared`).toBeGreaterThan(20);
    }
  });

  it("carries the prototype's value in every token the two both declare", () => {
    expect(paletteDrift()).toEqual([]);
  });

  it("reports a repainted token, naming the theme and both values", () => {
    // The dark accent put back where it was before REQ-299. Written as the
    // value of another token rather than as a colour, so the fixture still
    // takes everything from the sheets and this file carries no palette of its
    // own; the light accent is a value the dark theme certainly does not want.
    const stale = valueOf(LIGHT_TOKENS, "--accent");
    const approved =
      PROTOTYPE_PALETTES.find(([name]) => name === "dark")?.[1].get(
        "--accent",
      ) ?? "";
    const drifted = new Map([
      ...(APPLICATION_PALETTES.find(([name]) => name === "dark")?.[1] ??
        new Map<string, string>()),
      ["--accent", stale],
    ]);

    const findings = [
      ...(PROTOTYPE_PALETTES.find(([name]) => name === "dark")?.[1] ??
        new Map<string, string>()),
    ].flatMap(([name, value]) =>
      drifted.get(name) === undefined || drifted.get(name) === value
        ? []
        : [
            `dark: ${name} is ${drifted.get(name) ?? ""} in ${COLOUR_TOKENS_PATH}, ${value} in ${PROTOTYPE_PATH}`,
          ],
    );

    expect(findings).toEqual([
      `dark: --accent is ${stale} in ${COLOUR_TOKENS_PATH}, ${approved} in ${PROTOTYPE_PATH}`,
    ]);
  });

  it("keeps the tokens the application has and the prototype never named", () => {
    // The other half of REQ-299, and the half that fails silently: adopting a
    // palette by copying the prototype's list over this one would take the
    // pressed button and the error ink with it, and every guardian above would
    // still be green because nothing measures a token that stopped existing.
    const missing = APPLICATION_PALETTES.flatMap(([theme, palette]) =>
      APPLICATION_ONLY_TOKENS.flatMap((name) =>
        palette.has(name) ? [] : [`${theme}: ${name} is no longer declared`],
      ),
    );

    expect(missing).toEqual([]);

    // And they are extensions rather than tokens the prototype simply spells
    // elsewhere: if one of these turns up there, this list is the wrong list.
    const claimed = PROTOTYPE_PALETTES.flatMap(([theme, palette]) =>
      APPLICATION_ONLY_TOKENS.flatMap((name) =>
        palette.has(name) ? [`${theme}: ${name} is in the prototype too`] : [],
      ),
    );

    expect(claimed).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * REQ-298: the quoted conversation keeps its colour, and its measurement
 * ------------------------------------------------------------------ */

/**
 * The eleventh guardian, and the only one that defends a family from the
 * palette instead of holding it to the palette.
 *
 * The preview beside the automation form draws Instagram's direct, and
 * Instagram's direct does not repaint itself when the operator changes the
 * theme of our panel. The drawing is a CITATION of another product, so it takes
 * the fixed colour the prototype approves and none of the product's tokens.
 * `components.test.tsx` holds those values against the prototype rule by rule;
 * what is guarded here is the other half of "fixed", which is the half a
 * stylesheet cannot say out loud: that no theme ever restates one of them.
 *
 * And the half that fails in silence. A colour that leaves the palette leaves
 * the contrast guardian with it: the pairs of a family nobody measures still
 * appear on a screen, and the green tick above then covers every surface except
 * the one that was taken out of the system on purpose. So the entries are in
 * `CONTRAST_PAIRS` beside every other pair the product paints, and the sweep
 * below refuses a fixed surface that some rule fills and no entry measures.
 */
const FIXED_PREFIX = "--direct-";

/** Every fixed token, read from the palette rather than listed here. */
const FIXED_TOKENS: readonly string[] = [...LIGHT_TOKENS.keys()].filter(
  (name) => name.startsWith(FIXED_PREFIX),
);

/**
 * Every scope that restates one of them, named with the token.
 *
 * Takes the blocks rather than reading them, so the fixture below can hand it a
 * scope that really does restate one and prove the sweep bites.
 */
function fixedTokensRestated(
  scopes: readonly (readonly [string, string])[],
): readonly string[] {
  return scopes.flatMap(([where, block]) =>
    [...declarationsOf(block).keys()]
      .filter((name) => name.startsWith(FIXED_PREFIX))
      .map(
        (name) =>
          `${where} restates ${name}, so the conversation the preview quotes changes with the theme`,
      ),
  );
}

/** The three places a token can be given a second value in this sheet. */
const THEMED_SCOPES: readonly (readonly [string, string])[] = [
  [
    "@media (prefers-color-scheme: dark)",
    blockAfter(
      blockAfter(colourTokens, "@media (prefers-color-scheme: dark)"),
      ":root {",
    ),
  ],
  ['[data-theme="light"]', blockAfter(colourTokens, '[data-theme="light"]')],
  ['[data-theme="dark"]', blockAfter(colourTokens, '[data-theme="dark"]')],
  // The block that restates the DERIVED colours so a forced theme reaches them
  // on a region and not only on the root (REQ-326). It carries aliases and must
  // never carry one of these: a fixed colour restated there would change with
  // the theme on every element that forces one.
  [FORCED_SCOPE_NAME, blockAfter(colourTokens, FORCED_SCOPE)],
];

/**
 * The one fixed fill nothing is ever written on: the three bars of the status
 * bar, drawn in the meta grey. They are furniture in a drawing that is itself a
 * picture, with no datum, no state and no text, so they answer to neither of
 * the two floors: demanding a pair for them would be demanding a measurement of
 * a shape nobody reads. Every other fill in the quotation carries words.
 */
const QUOTED_FURNITURE: readonly string[] = [".mc-phone__signal span"];

/**
 * Every fixed token a rule paints with that the list never measures in the same
 * role: filled as a surface with no ink held against it, or written as ink with
 * no surface held under it.
 *
 * Both halves, because the family can lose its measurement from either end. It
 * takes the pairs rather than reading `CONTRAST_PAIRS`, so the fixture below
 * can hand it a list with one entry taken out and prove that it says so.
 */
function unmeasuredFixedPaints(pairs: readonly Pair[]): readonly string[] {
  const asSurface = new Set(pairs.map(({ background }) => background));
  const asInk = new Set(pairs.map(({ text }) => text));

  const surfaces = [...SURFACE_RULES]
    .filter(([token]) => token.startsWith(FIXED_PREFIX))
    .flatMap(([token, painters]) => {
      const carrying = painters.filter(
        ({ selector }) => !QUOTED_FURNITURE.includes(selector),
      );

      return carrying.length === 0 || asSurface.has(token)
        ? []
        : [
            `${token} fills ${carrying.map(({ selector }) => selector).join(", ")} and no entry of CONTRAST_PAIRS measures an ink on it`,
          ];
    });

  const inks = [...INK_RULES]
    .filter(([token]) => token.startsWith(FIXED_PREFIX))
    .flatMap(([token, writers]) =>
      asInk.has(token)
        ? []
        : [
            `${token} writes ${writers.map(({ selector }) => selector).join(", ")} and no entry of CONTRAST_PAIRS measures it on a surface`,
          ],
    );

  return [...surfaces, ...inks];
}

describe("REQ-298: the preview quotes a conversation, in fixed colour", () => {
  it("declares the family once, in colour a browser can measure", () => {
    // A prefix that matched nothing would leave every assertion below sweeping
    // an empty list and reporting success.
    expect(FIXED_TOKENS.length).toBeGreaterThan(8);

    for (const name of FIXED_TOKENS) {
      // Opaque, and therefore measurable: a translucent value has the contrast
      // of whatever ends up behind it, which in a citation is nothing anyone
      // controls. `channelsOf` asserts by name if one arrives.
      expect(channelsOf(valueOf(LIGHT_TOKENS, name))).toHaveLength(3);
    }
  });

  it("gives no theme a second value for any of them", () => {
    expect(fixedTokensRestated(THEMED_SCOPES)).toEqual([]);

    // And the two palettes really do resolve them to one colour, which is what
    // the assertion above is protecting: the same drawing under both themes.
    for (const name of FIXED_TOKENS) {
      expect(valueOf(DARK_TOKENS, name)).toBe(valueOf(LIGHT_TOKENS, name));
    }
  });

  it("reports a fixed colour that started following the theme, naming it", () => {
    // The defect this exists to catch, written as the next person would write
    // it: the account's bubble given a second value under the dark theme,
    // because every other token in that block has one.
    const drifted = `:root { ${FIXED_PREFIX}mine: ${valueOf(DARK_TOKENS, "--accent")}; }`;

    expect(
      fixedTokensRestated([["@media (prefers-color-scheme: dark)", drifted]]),
    ).toEqual([
      `@media (prefers-color-scheme: dark) restates ${FIXED_PREFIX}mine, so the conversation the preview quotes changes with the theme`,
    ]);
  });

  it("measures every fixed colour the sheet paints with", () => {
    // The sweep reads the real sheets: `SURFACE_RULES` and `INK_RULES` are the
    // maps REQ-187 holds the whole product to, so a fixed colour is in them the
    // moment a rule paints with it.
    expect(SURFACE_RULES.has("--direct-screen")).toBe(true);
    expect(INK_RULES.has("--direct-ink")).toBe(true);

    // And the one exception is the sheet's and not this file's opinion.
    expect(
      (SURFACE_RULES.get("--direct-meta") ?? []).map(
        ({ selector }) => selector,
      ),
    ).toEqual(QUOTED_FURNITURE);

    expect(unmeasuredFixedPaints(CONTRAST_PAIRS)).toEqual([]);
  });

  it("reports a fixed pair the list forgot, from either end", () => {
    // The half that fails in silence, as it would arrive: the colours are
    // changed, the drawing is right, and one pair never reaches the floor
    // because nobody wrote it down. A surface with nothing measured on it, and
    // an ink measured on nothing, are the two ways in.
    const withoutSurface = CONTRAST_PAIRS.filter(
      ({ background }) => background !== "--direct-bubble",
    );
    const withoutInk = CONTRAST_PAIRS.filter(
      ({ text }) => text !== "--direct-card-meta",
    );

    expect(unmeasuredFixedPaints(withoutSurface)).toEqual([
      `--direct-bubble fills ${(SURFACE_RULES.get("--direct-bubble") ?? []).map(({ selector }) => selector).join(", ")} and no entry of CONTRAST_PAIRS measures an ink on it`,
    ]);
    expect(unmeasuredFixedPaints(withoutInk)).toEqual([
      `--direct-card-meta writes ${(INK_RULES.get("--direct-card-meta") ?? []).map(({ selector }) => selector).join(", ")} and no entry of CONTRAST_PAIRS measures it on a surface`,
    ]);
  });
});
