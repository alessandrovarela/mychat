import { createElement } from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ConfirmDialog } from "./ConfirmDialog.js";
import type { ConfirmDialogProps } from "./ConfirmDialog.js";

/**
 * REQ-186: a control that says it is expanded also says WHAT it expands.
 *
 * `aria-expanded` on its own announces a state and names nothing. Someone
 * listening hears "collapsed, button, Advanced", presses it, hears "expanded",
 * and has no way to ask where the thing that opened IS: no route to it, no way
 * to tell it from anything else that changed on the page. `aria-controls`
 * carries the other half, and the pair only means something together.
 *
 * The requirement is therefore two claims, and this file proves them
 * differently because they are different kinds of fact:
 *
 *   - every `aria-expanded` in the interface declares an `aria-controls`. That
 *     is a property of the SOURCE, so it is swept out of the real files. Not
 *     matched as text: a mention in a comment is prose, and the very screens
 *     under the sweep explain this contract in their comments;
 *   - the id it points at is in the document with the control SHUT. That is
 *     behaviour and no reading of source can decide it, so a disclosure is
 *     rendered collapsed and the document is asked for the id. An
 *     `aria-controls` naming an element that is not there is worse than an
 *     absent one: it states a relation the page does not have, and a screen
 *     reader asked to follow it lands nowhere.
 *
 * The sweep is deliberately blind to WHICH files carry a disclosure. Naming the
 * three or four that do today would make this a list, and a list goes stale the
 * first time somebody writes the fourth: the guard exists because that is
 * exactly what happened to the contract the dashboard wrote by hand.
 */

/**
 * Every source file of the interface, as text.
 *
 * `../**` is `src/web/**`: the screens, the components, the entry point and the
 * page `vite build` publishes. Test files come in too and are filtered out
 * below.
 *
 * One `import.meta.glob` and no `node:fs`, the same mechanism
 * `styles/tokens.test.ts` reads the stylesheets with: this program has the DOM
 * and no Node types on purpose (see `src/web/tsconfig.json`), so reaching for
 * the file system would not even typecheck.
 */
const WEB_SOURCES = import.meta.glob<string>("../**/*.{ts,tsx,html}", {
  eager: true,
  query: "?raw",
  import: "default",
});

/** Where the glob keys are relative to: this file's own directory. */
const GLOB_BASE = "src/web/components";

/**
 * Repository-relative, so a failure names a path that can be opened.
 *
 * The keys arrive relative to this directory and in both shapes: `./Button.tsx`
 * for a neighbour, `../screens/automations.tsx` for a file above.
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
 * The body of the interface: every file of `src/web` that is not a test.
 *
 * The tests are out for the reason this very file is a test: a guard for a
 * missing attribute has to be able to WRITE one, both in the fixtures that
 * prove it bites and in the failures it reports, and a fixture is not a screen.
 */
const INTERFACE_FILES: readonly (readonly [string, string])[] = Object.entries(
  WEB_SOURCES,
)
  .map(([key, source]): readonly [string, string] => [
    repositoryPath(key),
    source,
  ])
  .filter(([path]) => !/\.test\.tsx?$/.test(path))
  .sort(([a], [b]) => a.localeCompare(b));

/**
 * The same text with every comment blanked out, character for character.
 *
 * Copied from `styles/tokens.test.ts` rather than shared, because that file is
 * the design system's guard and this one is the interface's: neither owes the
 * other an export. Blanking instead of deleting keeps every later index where
 * it was, so a finding still names the right line.
 *
 * Three forms, because the sweep reads three languages. The block form is the
 * one that matters most here, since a JSX comment is a block comment wrapped in
 * braces and the screens explain this very contract inside them. The `//` form
 * exists only in TypeScript, and the lookbehind keeps it off the `//` inside a
 * URL. The angle-bracket form is the page, which the sweep reads because
 * `vite build` publishes it.
 */
function withoutComments(source: string): string {
  const blank = (text: string): string => text.replace(/[^\n]/g, " ");

  return source
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    .replace(/<!--[\s\S]*?-->/g, blank)
    .replace(/(?<![:\\])\/\/[^\n]*/g, blank);
}

/** A `path:line` prefix, so the report names the file and the exact line. */
function at(path: string, source: string, index: number): string {
  const line = source.slice(0, index).split("\n").length;

  return `${path}:${line}`;
}

/**
 * The end of the opening tag that starts at `start`, exclusive.
 *
 * A `>` only closes a tag where it is not inside something else, and in this
 * codebase it is usually inside something else: `onClick={(): void => {...}}`
 * carries one in an arrow, `useState<Draft>` one in a type argument, and both
 * of those live inside an attribute expression. So the walk tracks brace depth
 * and string quotes and accepts a `>` only at depth zero, outside a string,
 * which reads a self-closing `/>` by the same rule.
 */
function tagEnd(source: string, start: number): number {
  let depth = 0;
  let quote = "";

  for (let index = start + 1; index < source.length; index += 1) {
    const character = source[index] ?? "";

    if (quote !== "") {
      if (character === quote && source[index - 1] !== "\\") {
        quote = "";
      }
      continue;
    }

    if (character === '"' || character === "'" || character === "`") {
      quote = character;
    } else if (character === "{") {
      depth += 1;
    } else if (character === "}") {
      depth -= 1;
    } else if (character === ">" && depth === 0) {
      return index + 1;
    }
  }

  return source.length;
}

/**
 * The opening tag that CONTAINS `index`, or nothing if the attribute is written
 * somewhere no tag can be read around it.
 *
 * Walking backwards to the nearest `<` is not enough on its own: an element
 * passed as an earlier attribute (`badge={<StatusBadge>...</StatusBadge>}`)
 * leaves a `<` between the tag and the attribute. So every candidate is read to
 * its own end, and one that closed BEFORE the attribute is not the tag the
 * attribute belongs to.
 */
function tagAround(
  source: string,
  index: number,
): { readonly start: number; readonly end: number } | null {
  for (let start = index; start >= 0; start -= 1) {
    if (source[start] !== "<" || !/[A-Za-z]/.test(source[start + 1] ?? "")) {
      continue;
    }

    const end = tagEnd(source, start);

    if (end > index) {
      return { start, end };
    }
  }

  return null;
}

/** The name of the element a tag opens, for a failure that can be searched. */
function elementOf(tag: string): string {
  return /^<([A-Za-z][\w.-]*)/.exec(tag)?.[1] ?? "";
}

/** An `aria-controls` written as an attribute, and not merely spelled. */
const CONTROLS = /\baria-controls\s*=/;

const EXPANDED = /\baria-expanded\b/g;

interface Disclosure {
  readonly path: string;
  /** `path:line`, already formatted, because that is what a report needs. */
  readonly at: string;
  readonly element: string;
  readonly controls: boolean;
}

function disclosuresIn(path: string, source: string): readonly Disclosure[] {
  const text = withoutComments(source);

  return [...text.matchAll(EXPANDED)].map((match): Disclosure => {
    const tag = tagAround(text, match.index);
    const written = tag === null ? "" : text.slice(tag.start, tag.end);

    return {
      path,
      at: at(path, text, match.index),
      element: elementOf(written),
      controls: tag !== null && CONTROLS.test(written),
    };
  });
}

function findingsFor(disclosures: readonly Disclosure[]): readonly string[] {
  return disclosures.flatMap((disclosure) => {
    if (disclosure.controls) {
      return [];
    }

    // Two different defects, and a report that said "missing" for both would
    // send the next person looking for an attribute in a tag that is not
    // there. The second is the one this guard cannot judge: an attribute it
    // cannot attach to an element is an attribute whose target it never saw.
    return disclosure.element === ""
      ? [
          `${disclosure.at} aria-expanded is written where no element tag can be read around it, so nothing here can say what it controls`,
        ]
      : [
          `${disclosure.at} <${disclosure.element}> declares aria-expanded and no aria-controls, name the region it opens (REQ-186)`,
        ];
  });
}

const DISCLOSURES: readonly Disclosure[] = INTERFACE_FILES.flatMap(
  ([path, source]) => disclosuresIn(path, source),
);

describe("REQ-186: every aria-expanded declares an aria-controls", () => {
  it("reads the interface, and leaves the tests that write fixtures out", () => {
    const paths = INTERFACE_FILES.map(([path]) => path);

    // A sweep that quietly matched nothing would report success forever, which
    // is the one way a guard fails without saying so.
    expect(paths).toContain("src/web/components/ConfirmDialog.tsx");
    expect(paths).toContain("src/web/screens/automations.tsx");
    expect(paths).toContain("src/web/index.html");
    expect(paths).not.toContain("src/web/components/a11y.test.ts");
    expect(paths).not.toContain("src/web/screens/dashboard.test.tsx");

    for (const [path, source] of INTERFACE_FILES) {
      expect(source.length, path).toBeGreaterThan(0);
    }

    // And it really finds the disclosures. The count is a floor and not a
    // list: the day a fifth one is written this still holds, and the day the
    // reader breaks it does not.
    expect(DISCLOSURES.length).toBeGreaterThanOrEqual(2);
  });

  it("carries no aria-expanded that names nothing", () => {
    expect(findingsFor(DISCLOSURES)).toEqual([]);
  });

  it("reports a lone aria-expanded, naming the file and the line", () => {
    const written = `export function Panel(): ReactElement {
  return (
    <div>
      <Button
        variant="link"
        aria-expanded={open}
        onClick={toggle}
      >
        {label}
      </Button>
    </div>
  );
}`;

    expect(findingsFor(disclosuresIn("fixture.tsx", written))).toEqual([
      "fixture.tsx:6 <Button> declares aria-expanded and no aria-controls, name the region it opens (REQ-186)",
    ]);
  });

  it("accepts the pair, in either order and in both languages", () => {
    const jsx = `<IconButton aria-controls={menuId} aria-expanded={isOpen} />`;
    const page = `<button aria-expanded="false" aria-controls="panel">x</button>`;

    expect(findingsFor(disclosuresIn("fixture.tsx", jsx))).toEqual([]);
    expect(findingsFor(disclosuresIn("fixture.html", page))).toEqual([]);
  });

  it("takes a mention in a comment for prose, and not for a declaration", () => {
    // The screens explain this contract in their own comments, this file
    // included. A guard that matched text would accuse them, and would just as
    // happily let a comment SATISFY the rule for a control that declares
    // nothing, which is the failure that costs something.
    const prose = `/* The control says aria-expanded and points with aria-controls. */
// aria-expanded alone names nothing.
<Button aria-expanded={open} aria-controls={panelId} />`;

    expect(disclosuresIn("fixture.tsx", prose)).toHaveLength(1);
    expect(findingsFor(disclosuresIn("fixture.tsx", prose))).toEqual([]);

    const excused = `<Button aria-expanded={open} /> {/* aria-controls={id} */}`;

    expect(findingsFor(disclosuresIn("fixture.tsx", excused))).toEqual([
      "fixture.tsx:1 <Button> declares aria-expanded and no aria-controls, name the region it opens (REQ-186)",
    ]);
  });

  it("reads the tag the attribute is in, past everything that looks like one", () => {
    // Three things that end a tag and do not: a `>` inside an arrow, a `>`
    // inside a type argument, and a whole element passed as an earlier
    // attribute. Each one would make the reader stop early, and stopping early
    // means judging some other tag's attributes.
    const dense = `<Card
  badge={<StatusBadge state="active">{word}</StatusBadge>}
  onPick={(value: Draft<Row>): void => { pick(value); }}
  aria-expanded={open}
/>`;

    expect(disclosuresIn("fixture.tsx", dense)).toEqual([
      {
        path: "fixture.tsx",
        at: "fixture.tsx:4",
        element: "Card",
        controls: false,
      },
    ]);
  });

  it("refuses an aria-expanded it cannot attach to an element", () => {
    // A disclosure written as data (a props object, a `setAttribute` call) is
    // one this reader cannot follow to a tag. It says so instead of passing:
    // silence there would be a hole shaped exactly like the next defect.
    const data = `const props = { "aria-expanded": open, "aria-controls": panelId };`;

    expect(findingsFor(disclosuresIn("fixture.ts", data))).toEqual([
      "fixture.ts:1 aria-expanded is written where no element tag can be read around it, so nothing here can say what it controls",
    ]);
  });
});

/**
 * The other half of REQ-186, which no sweep of source can answer.
 *
 * `aria-controls` is a promise about the DOCUMENT: the id is there to be
 * followed. A disclosure that unmounts its region while shut breaks that
 * promise in the state the control spends most of its life in, and the source
 * looks perfectly correct the whole time. So one is rendered, left alone, and
 * the document is asked.
 *
 * ConfirmDialog is the specimen because it needs nothing to stand up: no
 * router, no catalogue, no reading in flight. Its labels arrive as props, which
 * is why the words below are fixtures rather than operator text.
 */
const DIALOG: ConfirmDialogProps = {
  title: "~confirm.title~",
  consequence: "~confirm.consequence~",
  groups: [
    {
      title: "~confirm.group~",
      items: [{ id: "~confirm.id~", name: "~confirm.name~" }],
    },
  ],
  listLabel: "~confirm.list~",
  hideLabel: "~confirm.hide~",
  confirmLabel: "~confirm.commit~",
  cancelLabel: "~confirm.cancel~",
  onConfirm: (): void => undefined,
  onCancel: (): void => undefined,
};

describe("REQ-186: what a shut disclosure points at is in the document", () => {
  it("keeps the region reachable by id while the control is collapsed", () => {
    render(createElement(ConfirmDialog, DIALOG));

    const control = screen.getByRole("button", { name: DIALOG.listLabel });

    expect(control).toHaveAttribute("aria-expanded", "false");

    const target = control.getAttribute("aria-controls") ?? "";

    expect(target).not.toBe("");

    const region = document.getElementById(target);

    // The whole point: shut, and still there to be followed.
    expect(region).not.toBeNull();
    expect(region).not.toBeVisible();

    // Present is not the same as populated. The region is an empty shell while
    // the control is shut, so nothing inside it can be walked into by any
    // route, which is what the `hidden` above only claims.
    expect(screen.queryByText("~confirm.name~")).toBeNull();
  });
});

/* ------------------------------------------------------------------ *
 * REQ-199: a region hidden by `hidden` collapses through the sheet
 * ------------------------------------------------------------------ */

/**
 * The stylesheets, read the same way the sources above are.
 *
 * `hidden` is a `display: none` the BROWSER declares, which means it sits at the
 * bottom of the cascade: ANY author `display` outranks it. A region styled as a
 * grid or a flex column and hidden with the attribute therefore lays itself out
 * anyway, and what the operator gets is an empty panel floating over a card.
 *
 * The workaround the interface used twice was a wrapper: a plain `<div>` around
 * the region, carrying the id and the attribute, with no `display` of its own to
 * outrank anything. It works, and it costs an element per disclosure plus the
 * paragraph of comment that explains why it is there. Two rules in the sheet buy
 * both back.
 */
const STYLESHEETS = import.meta.glob<string>("../**/*.css", {
  eager: true,
  query: "?raw",
  import: "default",
});

const CSS = Object.values(STYLESHEETS).join("\n");

/** A `className="one two"` written as a literal, which is how the sweep reads. */
const CLASS_ATTRIBUTE = /\bclassName\s*=\s*"([^"]*)"/;

/** The attribute itself, `hidden` or `hidden={...}`, and never a prop named so. */
const HIDDEN = /\shidden(?=[\s/>=])/g;

/**
 * Every class that some element of the interface hides with the attribute.
 *
 * Read off the tag rather than declared in a list here, so a disclosure written
 * next month is swept by the same rule that swept these two.
 */
function hiddenClassesIn(path: string, source: string): readonly string[] {
  const body = withoutComments(source);
  const found: string[] = [];

  for (const match of body.matchAll(HIDDEN)) {
    const tag = tagAround(body, match.index);

    if (tag === null) {
      continue;
    }

    const text = body.slice(tag.start, tag.end);
    const classes = CLASS_ATTRIBUTE.exec(text)?.[1] ?? "";

    for (const name of classes.split(/\s+/).filter(Boolean)) {
      found.push(`${at(path, source, match.index)} ${elementOf(text)} ${name}`);
    }
  }

  return found;
}

/** Whether the sheet declares `display` for a bare class selector. */
function declaresDisplay(className: string): boolean {
  const rule = new RegExp(`\\.${className}\\s*\\{[^}]*\\bdisplay\\s*:`, "u");

  return rule.test(CSS);
}

/** Whether the sheet collapses that same class when the attribute is on it. */
function collapsesWhenHidden(className: string): boolean {
  const rule = new RegExp(
    `\\.${className}\\[hidden\\]\\s*\\{[^}]*\\bdisplay\\s*:\\s*none`,
    "u",
  );

  return rule.test(CSS);
}

describe("REQ-199: what the attribute hides, the sheet collapses", () => {
  it("gives every hidden region the rule that outranks its own display", () => {
    const findings = INTERFACE_FILES.flatMap(([path, source]) =>
      hiddenClassesIn(path, source).flatMap((entry) => {
        const className = entry.slice(entry.lastIndexOf(" ") + 1);

        if (!declaresDisplay(className) || collapsesWhenHidden(className)) {
          return [];
        }

        return [
          `${entry} is hidden by the attribute and declares a display of its own, so it needs .${className}[hidden] { display: none } in components.css`,
        ];
      }),
    );

    expect(findings).toEqual([]);
  });

  it("reads the regions that made the rule, and not an empty set", () => {
    // A sweep that matched nothing would pass the case above forever. These two
    // are the disclosures the requirement was written from, so the sweep has to
    // be able to see them.
    const swept = INTERFACE_FILES.flatMap(([path, source]) =>
      hiddenClassesIn(path, source),
    ).map((entry) => entry.slice(entry.lastIndexOf(" ") + 1));

    expect(swept).toContain("mc-reachlist");
    expect(swept).toContain("mc-detail");
  });

  it("holds the rule for each of them in the sheet", () => {
    for (const name of ["mc-reachlist", "mc-detail"]) {
      expect(declaresDisplay(name), `${name} declares a display`).toBe(true);
      expect(collapsesWhenHidden(name), `${name} collapses hidden`).toBe(true);
    }
  });
});

/* ------------------------------------------------------------------ *
 * REQ-276: a link goes somewhere, a button does something
 * ------------------------------------------------------------------ */

/**
 * REQ-276: nothing in the interface is an anchor that ACTS.
 *
 * The distinction is not decoration. A link navigates and a button does
 * something, and the browser gives the two different behaviour on purpose:
 * Space activates a button and does nothing to a link, a screen reader
 * announces "link" and lets someone jump between destinations, and the middle
 * button opens an address in another tab. An `<a>` with no address has none of
 * that to offer, so whatever it does it does through a click handler, and what
 * the operator was given is a button drawn wrong.
 *
 * It also escapes the tap floor, and that is the half the phase measured. The
 * sweeps of REQ-268 walk the sheet's BUTTONS: a control that is not one is a
 * control no rule was ever asked to size, and an underlined word has no visible
 * frame for a thumb to aim at even where a height is declared.
 *
 * Swept out of the SOURCE and over the whole interface, for the reason the
 * disclosure guard above is: rendering every screen would need a client and a
 * session for each, and naming the four files that carry an anchor today would
 * make this a list that goes stale the first time somebody writes the fifth.
 */

/** An anchor's opening tag: `<a` followed by whitespace or the tag's end. */
const ANCHOR = /<a(?=[\s/>])/g;

/** An `href` written as an attribute of this tag, and not merely spelled. */
const HREF = /\shref\s*=/;

/**
 * An address that goes nowhere: empty, blank, or the page already open.
 *
 * `#` is the one that matters, because it is what a caller writes when a
 * component demands an `href` it has no address for, and it is
 * indistinguishable from a real destination to every check that only asks
 * whether the attribute is there.
 *
 * Read INSIDE an expression as well, and that is the case this guard was
 * written against rather than a hypothesis: the navigation rail carried
 * `href={item.href ?? "#"}` until REQ-276, so every destination whose caller
 * left the address out rendered an anchor going nowhere, and the attribute was
 * there the whole time.
 */
const NOWHERE =
  /\shref\s*=\s*(?:(["'`])\s*#?\s*\1|\{[^}]*(["'`])\s*#?\s*\2[^}]*\})/;

/** The class a screen would write by hand to draw an action as a link. */
const LINK_WEIGHT = /mc-btn--link\b/;

/** A screen spelling the button shape itself instead of asking ButtonLink. */
const MANUAL_BUTTON_LINK = /\bmc-btn(?:--[\w-]+)?\b/;

interface Anchor {
  readonly path: string;
  /** `path:line`, already formatted, because that is what a report needs. */
  readonly at: string;
  /** The opening tag, whole, so a failure can be read without opening a file. */
  readonly written: string;
}

function anchorsIn(path: string, source: string): readonly Anchor[] {
  const text = withoutComments(source);

  return [...text.matchAll(ANCHOR)].map((match): Anchor => {
    const end = tagEnd(text, match.index);

    return {
      path,
      at: at(path, text, match.index),
      written: text.slice(match.index, end).replace(/\s+/g, " "),
    };
  });
}

function actingAnchors(anchors: readonly Anchor[]): readonly string[] {
  return anchors.flatMap((anchor) =>
    HREF.test(anchor.written)
      ? NOWHERE.test(anchor.written)
        ? [
            `${anchor.at} ${anchor.written} carries an address that goes nowhere, so it acts instead of navigating (REQ-276)`,
          ]
        : []
      : [
          `${anchor.at} ${anchor.written} declares no href, so it is an action drawn as a destination (REQ-276)`,
        ],
  );
}

function manualButtonLinks(anchors: readonly Anchor[]): readonly string[] {
  return anchors.flatMap((anchor) =>
    MANUAL_BUTTON_LINK.test(anchor.written)
      ? [
          `${anchor.at} ${anchor.written} writes the button shape by hand instead of using ButtonLink (REQ-351)`,
        ]
      : [],
  );
}

const ANCHORS: readonly Anchor[] = INTERFACE_FILES.flatMap(([path, source]) =>
  anchorsIn(path, source),
);

describe("REQ-276: every anchor of the interface goes somewhere", () => {
  it("reads the interface, and finds the anchors really in it", () => {
    // Guards the sweep: a matcher that found nothing would report success
    // forever. The screens that carry a destination today are named here as
    // evidence that the reader works, never as the list it checks.
    expect(ANCHORS.length).toBeGreaterThan(3);
    expect(ANCHORS.map(({ path }) => path)).toContain(
      "src/web/components/AppNav.tsx",
    );
    expect(ANCHORS.map(({ path }) => path)).toContain(
      "src/web/components/ButtonLink.tsx",
    );
  });

  it("takes an anchor for an anchor, and not a word that begins with one", () => {
    // `<article>` and `<AssetPicker>` both start `<a`, and a sweep that read
    // them as anchors would accuse two elements that are not links at all.
    expect(
      anchorsIn("f.tsx", "<article><AssetPicker /><a href={x}>go</a>"),
    ).toHaveLength(1);
  });

  it("reads the whole tag, past a handler carrying its own angle bracket", () => {
    // `onClick={(): void => follow(path)}` puts a `>` inside an attribute, and
    // a reader that stopped at the first one would judge a tag it never saw.
    const [only] = anchorsIn(
      "f.tsx",
      `<a onClick={(): void => go()} href="/x">go</a>`,
    );

    expect(only?.written).toContain('href="/x"');
    expect(
      actingAnchors(anchorsIn("f.tsx", `<a onClick={(): void => go()}>x</a>`)),
    ).toHaveLength(1);
  });

  it("reports an anchor with no address, and one pointing at nowhere", () => {
    // The two shapes, on fixtures, so a green sweep below means the interface
    // is clean and not that the detector stopped matching.
    expect(
      actingAnchors(anchorsIn("f.tsx", "<a onClick={act}>Remove</a>")),
    ).toEqual([
      "f.tsx:1 <a onClick={act}> declares no href, so it is an action drawn as a destination (REQ-276)",
    ]);
    expect(
      actingAnchors(anchorsIn("f.tsx", `<a href="#" onClick={act}>Remove</a>`)),
    ).toHaveLength(1);
    // The one the rail really carried: the attribute is there, and the address
    // it resolves to for a caller that named none is the page already open.
    expect(
      actingAnchors(anchorsIn("f.tsx", `<a href={item.href ?? "#"}>Go</a>`)),
    ).toHaveLength(1);
    // And a real destination passes, written either way.
    expect(
      actingAnchors(
        anchorsIn(
          "f.tsx",
          `<a href="/x">Go</a><a href={to}>Go</a><a href={ok ? "/a" : "/b"}>Go</a>`,
        ),
      ),
    ).toEqual([]);
  });

  it("carries no anchor that acts instead of navigating", () => {
    expect(actingAnchors(ANCHORS)).toEqual([]);
  });

  it("asks for no link weight, in any screen", () => {
    // The type refuses `variant="link"` on both components. The source sweep
    // guards the untyped door too, so no screen can bring that weight back by
    // spelling a class around either control.
    const findings = INTERFACE_FILES.flatMap(([path, source]) => {
      const text = withoutComments(source);
      const found = LINK_WEIGHT.exec(text);

      return found === null
        ? []
        : [
            `${at(path, text, found.index)} draws an action as a link (REQ-276)`,
          ];
    });

    expect(findings).toEqual([]);
  });
});

describe("REQ-351: ButtonLink owns every link with the button shape", () => {
  it("detects a class written by hand on an anchor", () => {
    expect(
      manualButtonLinks(
        anchorsIn(
          "f.tsx",
          '<a className="mc-btn mc-btn--primary" href="/x">Go</a>',
        ),
      ),
    ).toHaveLength(1);
  });

  it("finds no hand-written button link in the interface", () => {
    expect(manualButtonLinks(ANCHORS)).toEqual([]);
  });
});
