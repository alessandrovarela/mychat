import { beforeEach, describe, expect, it } from "vitest";
import {
  applyThemeChoice,
  chooseTheme,
  readThemeChoice,
  THEME_ATTRIBUTE,
  THEME_CHOICES,
  THEME_STORAGE_KEY,
} from "./theme.js";

/**
 * The theme of the panel, and the two halves of REQ-326 that no screen can
 * prove on its own: what the choice is kept in, and what applies it before a
 * single pixel is painted.
 *
 * The screen's half (a control with three answers, the answer in force showing
 * when the page comes back) is in `screens/settings.test.tsx`. What is here is
 * the mechanism under it, plus the one guard that reaches across a boundary the
 * type system cannot: the page carries an inline copy of the key and the
 * attribute, because a module cannot run early enough, and nothing but a test
 * can hold the copy against the original.
 */

/**
 * The page, as text, read the way `styles/tokens.test.ts` reads the sheets.
 *
 * A `./index.html?raw` import would read the same file and would break
 * `tests/import-extensions.test.ts`, which requires every relative specifier in
 * the repository to end in `.js` (REQ-082).
 */
const PAGES = import.meta.glob<string>("./*.html", {
  eager: true,
  query: "?raw",
  import: "default",
});

const page = PAGES["./index.html"] ?? "";

/** The inline script of the page, which is where the early application lives. */
const inlineScript = ((): string => {
  const opened = page.indexOf("<script>");
  const closed = page.indexOf("</script>", opened);

  return opened < 0 || closed < 0 ? "" : page.slice(opened, closed);
})();

beforeEach(() => {
  // jsdom keeps one document and one store for the whole file, so a test that
  // did not clean up would hand the next one a theme it never chose.
  window.localStorage.clear();
  document.documentElement.removeAttribute(THEME_ATTRIBUTE);
});

/** Replaces the store for one call, and puts the real one back afterwards. */
function withStore(store: unknown, run: () => void): void {
  const real = Object.getOwnPropertyDescriptor(window, "localStorage");

  Object.defineProperty(window, "localStorage", {
    configurable: true,
    get: () => store,
  });

  try {
    run();
  } finally {
    if (real === undefined) {
      Reflect.deleteProperty(window, "localStorage");
    } else {
      Object.defineProperty(window, "localStorage", real);
    }
  }
}

describe("REQ-326: the choice is kept on the machine, not in the instance", () => {
  it("offers the three answers, the system among them", () => {
    expect([...THEME_CHOICES]).toEqual(["system", "light", "dark"]);
  });

  it("answers the system while this machine has chosen nothing", () => {
    expect(readThemeChoice()).toBe("system");
  });

  it("reads back the choice a previous visit stored", () => {
    chooseTheme("dark");

    // The whole of "survives a reload", at this level: nothing is held in
    // memory between the write and the read, so a fresh page asking the same
    // question gets the same answer.
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");
    expect(readThemeChoice()).toBe("dark");
  });

  it("sends nothing anywhere: the store is the whole of the write", () => {
    // A preference of the INSTANCE goes over `/api`; this one must not, or a
    // second machine signing into the same panel would inherit it. The proof
    // is that the module needs no client at all: `chooseTheme` takes no port,
    // and the only trace of the call is on this machine.
    chooseTheme("light");

    expect([...Array(window.localStorage.length).keys()].map(String)).toEqual([
      "0",
    ]);
    expect(window.localStorage.key(0)).toBe(THEME_STORAGE_KEY);
  });

  it("treats a value it never wrote as no choice at all", () => {
    // Left by an older build, or typed into the developer tools. Adopting it
    // would put the interface into a theme that has no name and no palette.
    window.localStorage.setItem(THEME_STORAGE_KEY, "midnight");

    expect(readThemeChoice()).toBe("system");
  });

  it("survives a browser that refuses to be read at all", () => {
    // Site data blocked: touching the property throws instead of answering.
    withStore(
      {
        getItem: (): string => {
          throw new Error("denied");
        },
      },
      () => {
        expect(readThemeChoice()).toBe("system");
      },
    );
  });

  it("still applies the theme when the store refuses to remember it", () => {
    withStore(
      {
        setItem: (): void => {
          throw new Error("denied");
        },
      },
      () => {
        chooseTheme("dark");
      },
    );

    // What is lost is the reload. What is not lost is the page in front of the
    // operator, which is the part they asked for.
    expect(document.documentElement.getAttribute(THEME_ATTRIBUTE)).toBe("dark");
  });
});

describe("REQ-326: the mark goes on the root element", () => {
  it("marks the document element, and nowhere smaller", () => {
    applyThemeChoice("dark");

    expect(document.documentElement.getAttribute(THEME_ATTRIBUTE)).toBe("dark");
    expect(document.body.hasAttribute(THEME_ATTRIBUTE)).toBe(false);
  });

  it("takes the mark off for the system, rather than writing a third value", () => {
    applyThemeChoice("light");
    applyThemeChoice("system");

    // `[data-theme="system"]` is a scope the stylesheet does not answer to: it
    // would look like a forced theme and behave like none.
    expect(document.documentElement.hasAttribute(THEME_ATTRIBUTE)).toBe(false);
  });
});

describe("REQ-326: the page applies the choice before the first paint", () => {
  it("reads the page and finds the inline script", () => {
    // A glob that matched nothing would pass every assertion below it.
    expect(page).toContain("<title>MyChat</title>");
    expect(inlineScript).not.toBe("");
  });

  it("spells the same key and the same attribute this module exports", () => {
    // The one copy in the repository, and the reason it exists: a module runs
    // after the document is parsed, so a page that waited for `main.tsx` would
    // paint the system theme and swap. This is what holds the copy in step.
    expect(inlineScript).toContain(`"${THEME_STORAGE_KEY}"`);
    expect(inlineScript).toContain(`"${THEME_ATTRIBUTE}"`);
    expect(inlineScript).toContain("document.documentElement");
  });

  it("forces only the two themes the stylesheet answers to", () => {
    for (const choice of THEME_CHOICES) {
      expect(
        inlineScript.includes(`"${choice}"`),
        `the page compares against ${choice}`,
      ).toBe(choice !== "system");
    }
  });

  it("survives a store that throws instead of answering", () => {
    // Uncaught, the throw would abort the script while the parser is still in
    // the head, and the page would be left with no theme applied at all.
    expect(inlineScript).toContain("try {");
    expect(inlineScript).toContain("catch");
  });

  it("is the only place the interface applies the choice at load", () => {
    // `settings.tsx` READS the choice to show it and writes it when the
    // operator picks one; no module applies it on the way in, which is what
    // makes the script above load bearing rather than a duplicate.
    const modules = import.meta.glob<string>("./main.tsx", {
      eager: true,
      query: "?raw",
      import: "default",
    });

    expect(modules["./main.tsx"] ?? "").not.toContain("applyThemeChoice");
  });
});
