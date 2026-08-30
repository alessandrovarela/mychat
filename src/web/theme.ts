/**
 * The theme of the panel, and where the operator's choice is kept (REQ-326).
 *
 * Three answers, and the third is not a colour: light, dark, or whatever the
 * operating system is set to. Until this file existed there was only the third,
 * and no way to say so.
 *
 * The choice belongs to the MACHINE and not to the instance, which is why it
 * does not travel the road the language and the time zone take. Those two are
 * facts about the account being operated: the panel speaks one language and
 * counts in one clock, and every browser that signs in must agree with them, so
 * they are stored in the instance's database and read back over `/api`. A theme
 * is a fact about the screen in front of a person: the same operator on a
 * laptop at noon and a phone at midnight is one instance and two answers.
 * `localStorage` is therefore not a shortcut around the API here, it is the
 * correct store, and a second machine signing into the same panel keeps its own
 * choice with no write of ours.
 *
 * -------------------------------------------------------------------------
 * WHERE THE MARK GOES, and why it is the root element and nothing smaller.
 *
 * `styles/tokens/colors.css` declares the palette in three layers: the light
 * values at `:root`, the dark ones inside `@media (prefers-color-scheme: dark)`,
 * and the two forced scopes `[data-theme="light"]` / `[data-theme="dark"]` that
 * outrank the media query. This file writes `data-theme` on
 * `document.documentElement`, so the forced scope lands on the same element the
 * unconditional `:root` declarations live on.
 *
 * That is not a preference either. A custom property whose value is another
 * custom property (`--surface-app: var(--bg-sunken)`) is resolved on the
 * element the DECLARATION sits on, and the semantic aliases are declared at
 * `:root`. Marking the root therefore resolves them against the forced
 * primitives; marking a region would leave the aliases resolving against
 * whatever the media query gave `:root`, and half the theme would stay behind.
 * Measured in Chrome, by 3p.3 and again by this task: inside a forced light
 * region on a dark system, `--bg-sunken` came out light while `--surface-app`,
 * which is nothing but an alias of it, stayed dark. The two values are written
 * out in the comment over that block in `colors.css`, where a colour literal is
 * a definition rather than a usage. The sheet now restates the derived tokens
 * under a bare `[data-theme]` selector so a region works too, and
 * `styles/tokens.test.ts` guards that restatement, but the root is still where
 * this file marks: it is the only element that needs no restatement to be
 * right.
 *
 * -------------------------------------------------------------------------
 * WHAT DOES NOT MOVE WITH IT.
 *
 * The colours of the conversation the preview quotes (`--direct-*`, REQ-298).
 * They are a citation of Instagram's direct, and Instagram's direct does not
 * change palette when the operator changes the theme of our panel. They are
 * declared once, in no themed scope, and the guardian in `tokens.test.ts`
 * refuses a restatement under any of them, this file's `[data-theme]` included.
 *
 * -------------------------------------------------------------------------
 * WHEN IT IS APPLIED.
 *
 * Not here, on load. `index.html` carries a small inline script that reads the
 * same key and writes the same attribute BEFORE the first paint, because a
 * module runs after the document has been parsed and the page would show the
 * system theme for a frame and then swap. Nothing else in the interface applies
 * the choice at load, so that script is not a duplicate of a call made here: it
 * is the only place where the timing is right. `theme.test.ts` holds the two
 * against each other, so the key and the attribute cannot drift apart.
 */

/** The three answers an operator can give, and the only ones ever stored. */
export type ThemeChoice = "light" | "dark" | "system";

/**
 * The order the selector offers them in: the answer in force before this
 * setting existed comes first, then the two that override it.
 */
export const THEME_CHOICES: readonly ThemeChoice[] = [
  "system",
  "light",
  "dark",
];

/** Where the choice lives on this machine. Spelled again in `index.html`. */
export const THEME_STORAGE_KEY = "mychat.theme";

/** What the forced scopes of `colors.css` key on. Spelled again in the page. */
export const THEME_ATTRIBUTE = "data-theme";

/** No mark at all: the palette falls back to `prefers-color-scheme`. */
const SYSTEM: ThemeChoice = "system";

function isChoice(value: string | null): value is ThemeChoice {
  return THEME_CHOICES.includes(value as ThemeChoice);
}

/**
 * The choice this machine holds, and the system whenever it holds nothing.
 *
 * Anything the store answers that is not one of the three is the same as no
 * answer: a value left by an older version, or by a person with the developer
 * tools open, must not put the interface into a theme that has no name.
 *
 * The read is guarded because reading storage can THROW rather than answer
 * null: a browser with cookies and site data blocked raises on the property
 * itself. A panel that cannot remember a theme is a small loss; a panel that
 * fails to render because it could not remember one is not.
 */
export function readThemeChoice(): ThemeChoice {
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);

    return isChoice(stored) ? stored : SYSTEM;
  } catch {
    return SYSTEM;
  }
}

/**
 * Marks the document with the choice, or takes the mark off for the system.
 *
 * Removing rather than writing `data-theme="system"`: there is no third palette
 * to force, and an attribute the stylesheet does not answer to would be a mark
 * that looks like it means something.
 */
export function applyThemeChoice(choice: ThemeChoice): void {
  if (choice === SYSTEM) {
    document.documentElement.removeAttribute(THEME_ATTRIBUTE);
  } else {
    document.documentElement.setAttribute(THEME_ATTRIBUTE, choice);
  }
}

/**
 * Stores the choice and applies it, in that order.
 *
 * The store first, so that a browser refusing to remember shows the theme the
 * operator asked for anyway, for as long as the page is open. The screen calls
 * this and nothing else: there is no save button over this setting, because
 * there is nothing to send anywhere and no answer to wait for.
 */
export function chooseTheme(choice: ThemeChoice): void {
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, choice);
  } catch {
    // Storage refused. The choice still applies to the page in front of the
    // operator; what is lost is the reload, and nothing here can buy it back.
  }

  applyThemeChoice(choice);
}
