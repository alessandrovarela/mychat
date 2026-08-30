import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ComponentType, ReactElement } from "react";
import en from "../i18n/locales/en.json";
import ptBR from "../i18n/locales/pt-BR.json";
import { App, matchRoute } from "./App.js";
import type { SessionProbe } from "./App.js";
import { LocaleProvider } from "./locale.js";
import type { LocaleClient, LocaleState } from "./locale.js";
import { useNavigation } from "./navigation.js";
import { routes as registeredRoutes } from "./routes.js";
import type { RouteEntry } from "./routes.js";
import { AUTOMATION_START_ADDRESS } from "./screens/automations.js";
import { DASHBOARD_ADDRESS } from "./screens/dashboard.js";
import { LOGIN_ADDRESS } from "./screens/login.js";
import type { SessionClient, SessionOutcome } from "./screens/login.js";
import { AppShell, NARROW_VIEWPORT } from "./shell.js";

/**
 * The scaffold the screens land on, and the navigation between them (REQ-112).
 *
 * The route table resolves an address, the shell offers every private address
 * as a destination, and moving between them changes the screen WITHOUT
 * reloading the page. The last part is what the assertions below are careful
 * about: an ordinary `<a href>` would also change the address in a browser, by
 * fetching the whole application again and throwing away everything the page
 * had. In this emulated DOM a followed link navigates nowhere at all, so
 * `window.location.pathname` staying put is exactly what a page reload looks
 * like here, and the shell's own DOM node surviving the change is what proves
 * the application was not rebuilt from scratch around the new screen.
 *
 * This file is also the proof that the split in `vitest.config.ts` works: it
 * needs `document`, `window` and the DOM matchers, and it gets all three while
 * the backend suite keeps running in plain Node.
 */

const LOGIN = "login";
const DASHBOARD = "dashboard";
const AUTOMATIONS = "automations";
const FLOWS = "flows";
const PUBLICATIONS = "publications";
const FORM = "form";
/** The one control a departing screen renders, found by role and this name. */
const DEPART = "depart";

/**
 * Screens the tests own, at the addresses the real table registers. The words
 * on the rail come from the catalogue either way: the shell renders it, not
 * this table.
 */
const table: readonly RouteEntry[] = [
  { path: "/login", Screen: () => <div data-testid={LOGIN} />, public: true },
  { path: "/dashboard", Screen: () => <div data-testid={DASHBOARD} /> },
  { path: "/automations", Screen: () => <div data-testid={AUTOMATIONS} /> },
  { path: "/flows", Screen: () => <div data-testid={FLOWS} /> },
  { path: "/publications", Screen: () => <div data-testid={PUBLICATIONS} /> },
];

/**
 * A screen that asks the APPLICATION to go somewhere, which is the thing no
 * screen could do before REQ-146: the address was the root component's private
 * business and only the rail was handed a way to change it.
 */
function departing(testId: string, to: string): ComponentType {
  return function Departure(): ReactElement {
    const { navigate } = useNavigation();

    return (
      <div data-testid={testId}>
        <button
          type="button"
          aria-label={DEPART}
          onClick={(): void => {
            navigate(to);
          }}
        />
      </div>
    );
  };
}

/**
 * The same addresses, with two screens that navigate: the PUBLIC one, which is
 * the access screen's case, and the automations listing, which opens a detail
 * route carrying a query.
 */
const navigating: readonly RouteEntry[] = [
  {
    path: "/login",
    Screen: departing(LOGIN, DASHBOARD_ADDRESS),
    public: true,
  },
  { path: "/dashboard", Screen: () => <div data-testid={DASHBOARD} /> },
  {
    path: "/automations",
    Screen: departing(AUTOMATIONS, "/automations/form?id=launch"),
  },
  {
    path: "/automations/form",
    Screen: () => <div data-testid={FORM} />,
    rail: false,
    parent: "/automations",
  },
  { path: "/flows", Screen: () => <div data-testid={FLOWS} /> },
  { path: "/publications", Screen: () => <div data-testid={PUBLICATIONS} /> },
];

/** The control of a departing screen. */
function departure(): HTMLElement {
  return screen.getByRole("button", { name: DEPART });
}

/** Where the rail leads, as addresses, in the order an operator tabs them. */
function reachable(): readonly string[] {
  return within(screen.getByRole("navigation"))
    .getAllByRole("link")
    .map((link) => link.getAttribute("href") ?? "");
}

/** The destination that leads to `path`. */
function destinationTo(path: string): HTMLElement {
  const link = within(screen.getByRole("navigation"))
    .getAllByRole("link")
    .find((candidate) => candidate.getAttribute("href") === path);

  if (link === undefined) {
    // A missing destination is REQ-112 failing, so it is said in those words
    // instead of arriving as a click on `undefined`.
    throw new Error(`no destination leads to ${path}`);
  }

  return link;
}

/** The addresses currently marked as the screen on show. */
function marked(): readonly string[] {
  return within(screen.getByRole("navigation"))
    .getAllByRole("link")
    .filter((link) => link.getAttribute("aria-current") === "page")
    .map((link) => link.getAttribute("href") ?? "");
}

/** The rail's own words, exactly as the shipped catalogue writes them. */
const rail = en.nav;

/**
 * The route table the application really ships, with every screen replaced by
 * an empty one at the same address.
 *
 * What the screens draw is not what REQ-159 is about, and the real ones would
 * reach for `fetch`: the requirement is that the CASING offers the way out at
 * every private address the table registers, whatever is inside it.
 */
const stubbed: readonly RouteEntry[] = registeredRoutes.map((route) => ({
  ...route,
  Screen: () => <div data-testid={route.path} />,
}));

interface SessionDouble extends SessionClient {
  /** How many times the interface asked the instance to revoke. */
  closes: number;
  /** What the instance answers. False is a revocation that did NOT happen. */
  ended: boolean;
}

function createSessionDouble(): SessionDouble {
  const double: SessionDouble = {
    closes: 0,
    ended: true,

    open: (): Promise<SessionOutcome> => Promise.resolve({ ok: true }),

    close: (): Promise<boolean> => {
      double.closes += 1;
      return Promise.resolve(double.ended);
    },
  };

  return double;
}

interface ProbeDouble extends SessionProbe {
  /** How many times the interface asked the instance about the session. */
  asked: number;
}

/**
 * The instance's answer to "is there a session?", under the test's control.
 *
 * The real one reads a private route and looks at the status alone. What the
 * doorway is about is what it DOES with the two answers, so the request itself
 * is the part a double replaces.
 */
function createProbe(open: boolean): ProbeDouble {
  const double: ProbeDouble = {
    asked: 0,

    isOpen: (): Promise<boolean> => {
      double.asked += 1;
      return Promise.resolve(open);
    },
  };

  return double;
}

/** The instance's language, so a provider around the app never fetches. */
function localeClient(locale: string): LocaleClient {
  const state: LocaleState = { locale, available: ["en", "pt-BR"] };

  return {
    read: (): Promise<LocaleState> => Promise.resolve(state),
    write: (): Promise<LocaleState> => Promise.resolve(state),
  };
}

/** The control that ends the session, found by role and by its catalogue word. */
function endSessionControl(): HTMLElement {
  return screen.getByRole("button", { name: rail.signOut });
}

/** The control that commits it, inside the confirmation. */
function confirmControl(): HTMLElement {
  return within(screen.getByRole("dialog")).getByRole("button", {
    name: rail.signOutConfirm,
  });
}

/**
 * The control that backs out of it.
 *
 * Two of them carry that name, because the dialog gives its close glyph the
 * same word as its cancel button and both do the same thing. The one an
 * operator READS is the one with the word inside it, and that is the one a test
 * about staying should click.
 */
function stayControl(): HTMLElement {
  const found = within(screen.getByRole("dialog"))
    .getAllByRole("button", { name: rail.signOutStay })
    .find((button) => button.textContent?.trim() === rail.signOutStay);

  if (found === undefined) {
    throw new Error("the confirmation offers no way back");
  }

  return found;
}

/** How far a keyboard is allowed to walk before the search is a failure. */
const KEYBOARD_STOPS = 30;

/**
 * Tabs until `target` holds focus, and says so when it never does.
 *
 * A fixed number of stops would be a test about the rail's current length: what
 * the requirement asks is that the control can be REACHED with the keyboard,
 * which is this loop finding it before it gives up.
 */
async function tabTo(
  user: ReturnType<typeof userEvent.setup>,
  target: HTMLElement,
): Promise<void> {
  for (let stop = 0; stop < KEYBOARD_STOPS; stop += 1) {
    if (document.activeElement === target) {
      return;
    }

    await user.tab();
  }

  throw new Error(`the keyboard never reached ${target.textContent ?? ""}`);
}

beforeEach(() => {
  // Every test starts from an address none of them asserts about: navigation
  // writes the real address bar, and the next test must not inherit it.
  window.history.pushState({}, "", "/");
});

describe("the SPA scaffold", () => {
  it("renders the screen registered for the current address", () => {
    render(<App routes={table} pathname="/automations" />);

    expect(screen.getByTestId(AUTOMATIONS)).toBeInTheDocument();
    expect(screen.queryByTestId(FLOWS)).toBeNull();
  });

  it("claims no screen for an address the table does not register", () => {
    // Matching is exact, and what happens to the address nobody claimed is the
    // doorway's business (REQ-302), asserted in its own block below.
    expect(matchRoute(table, "/nowhere")).toBeUndefined();
  });

  it("reads the address from the browser when none is injected", () => {
    // What the deep link does in production: the server answered `index.html`
    // for `/flows`, and the application has to resolve the screen from the
    // address bar alone.
    window.history.pushState({}, "", "/flows");

    render(<App routes={table} />);

    expect(screen.getByTestId(FLOWS)).toBeInTheDocument();
  });

  it("treats a trailing slash as the same screen", () => {
    expect(matchRoute(table, "/flows/")?.path).toBe("/flows");
  });

  it("registers each address once", () => {
    // The append protocol of `routes.tsx`, guarded: screens are written in
    // parallel and each one adds a line, so two claiming the same address is
    // the collision that would otherwise show up as a screen that never opens,
    // with the second entry silently unreachable.
    const paths = registeredRoutes.map((route) => route.path);

    expect(new Set(paths).size).toBe(paths.length);
  });
});

/**
 * The doorway, on the table the application really ships.
 *
 * `stubbed` and not the hand-rolled one above, and that is the point of these
 * tests rather than a detail: what they prove is that the two addresses the
 * doorway sends an operator to are addresses the REAL table registers. Against
 * a table written here, renaming `/dashboard` in `routes.tsx` would leave every
 * assertion green and the root redirecting to a doorway that redirects again.
 */
describe("REQ-302: the root leads somewhere, and so does an address nobody claimed", () => {
  it("takes the root to the panel when the instance still knows the session", async () => {
    // The bookmarked address, opened directly: the server answered
    // `index.html` for `/`, and the application resolves it from the bar.
    window.history.pushState({}, "", "/");

    render(<App routes={stubbed} probe={createProbe(true)} />);

    await waitFor(() => {
      expect(screen.getByTestId(DASHBOARD_ADDRESS)).toBeInTheDocument();
    });

    expect(window.location.pathname).toBe(DASHBOARD_ADDRESS);
  });

  it("takes the root to the access screen when there is no session", async () => {
    window.history.pushState({}, "", "/");

    render(<App routes={stubbed} probe={createProbe(false)} />);

    await waitFor(() => {
      expect(screen.getByTestId(LOGIN_ADDRESS)).toBeInTheDocument();
    });

    expect(window.location.pathname).toBe(LOGIN_ADDRESS);
    // The access screen, and the access screen alone: a rail beside it would be
    // offering the private set to someone who holds no session.
    expect(screen.queryByRole("navigation")).toBeNull();
  });

  it("leaves an address no screen claimed with a screen anyway", async () => {
    // A favourite of a route that was renamed, or a letter missing from what
    // was typed. Both used to be answered with an empty page and no word.
    window.history.pushState({}, "", "/flowss");

    const { container } = render(
      <App routes={stubbed} probe={createProbe(true)} />,
    );

    await waitFor(() => {
      expect(screen.getByTestId(DASHBOARD_ADDRESS)).toBeInTheDocument();
    });

    expect(container).not.toBeEmptyDOMElement();
    // The bar says where the operator ended up, which is the interface's way of
    // saying the address they asked for is not one of ours.
    expect(window.location.pathname).toBe(DASHBOARD_ADDRESS);
  });

  it("sends that address to the access screen when there is no session either", async () => {
    window.history.pushState({}, "", "/settings/langauge");

    const { container } = render(
      <App routes={stubbed} probe={createProbe(false)} />,
    );

    await waitFor(() => {
      expect(screen.getByTestId(LOGIN_ADDRESS)).toBeInTheDocument();
    });

    expect(container).not.toBeEmptyDOMElement();
    expect(window.location.pathname).toBe(LOGIN_ADDRESS);
  });

  it("replaces the address it came from instead of stacking on it", async () => {
    window.history.pushState({}, "", "/publications");
    window.history.pushState({}, "", "/nowhere");

    render(<App routes={stubbed} probe={createProbe(true)} />);

    await waitFor(() => {
      expect(screen.getByTestId(DASHBOARD_ADDRESS)).toBeInTheDocument();
    });

    window.history.back();

    // Back leaves the doorway behind for good. Pushed instead of replaced, the
    // address that redirects would still be one step back, so going back would
    // be redirected forward again and the operator could never leave the page.
    await waitFor(() => {
      expect(window.location.pathname).toBe("/publications");
    });
  });

  it("asks the instance nothing while the address belongs to a screen", () => {
    const probe = createProbe(false);

    render(<App routes={stubbed} pathname={DASHBOARD_ADDRESS} probe={probe} />);

    expect(screen.getByTestId(DASHBOARD_ADDRESS)).toBeInTheDocument();
    expect(probe.asked).toBe(0);
  });
});

describe("REQ-112: every private screen is reachable from every other", () => {
  it("REQ-353: offers Settings as one destination, not a Language trail", () => {
    render(<App routes={stubbed} pathname="/settings" />);

    const navigation = within(screen.getByRole("navigation"));

    expect(
      navigation.getByRole("link", { name: rail.settings }),
    ).toHaveAttribute("href", "/settings");
    expect(navigation.queryByRole("link", { name: "Language" })).toBeNull();
  });

  it("REQ-206: leads to Settings while the previous language address remains reachable", () => {
    render(<App routes={stubbed} pathname="/settings/language" />);

    expect(screen.getByTestId("/settings/language")).toBeInTheDocument();
    expect(reachable()).toContain("/settings");
    expect(reachable()).not.toContain("/settings/language");
    expect(marked()).toEqual(["/settings"]);
  });

  it("leads to every private screen the route table registers", () => {
    render(<App routes={table} pathname="/dashboard" />);

    const privateScreens = registeredRoutes
      .filter((route) => route.public !== true && route.rail !== false)
      .map((route) => route.path);

    // Guards the guard: a table read as empty would satisfy every assertion
    // below while proving that nothing is reachable from nothing.
    expect(privateScreens.length).toBeGreaterThan(1);
    expect(reachable()).toEqual(expect.arrayContaining(privateScreens));
  });

  it("names every destination, and names no two the same", () => {
    render(<App routes={table} pathname="/dashboard" />);

    const names = within(screen.getByRole("navigation"))
      .getAllByRole("link")
      .map((link) => link.textContent?.trim() ?? "");

    // A key the catalogue does not carry renders the SAME placeholder text
    // everywhere (REQ-075), so distinct and non-empty names are what tells a
    // rail whose words came from the catalogue apart from one whose words are
    // five copies of "(this version has no text for this spot)".
    expect(names).toHaveLength(reachable().length);
    expect(names.filter((name) => name === "")).toEqual([]);
    expect(new Set(names).size).toBe(names.length);
  });

  it("keeps the public screen out of the navigation", () => {
    render(<App routes={table} pathname="/dashboard" />);

    // `/login` is not part of the private set: it is where an operator arrives
    // with no session, and the rail is what the private screens share.
    expect(reachable()).not.toContain("/login");
  });

  it("renders the public screen with no navigation beside it", () => {
    render(<App routes={table} pathname="/login" />);

    expect(screen.getByTestId(LOGIN)).toBeInTheDocument();
    expect(screen.queryByRole("navigation")).toBeNull();
  });

  it("marks the screen on show, and marks no other", () => {
    render(<App routes={table} pathname="/publications" />);

    // Programmatic and not only a different tone: colour alone leaves the
    // current screen unknowable to a screen reader.
    expect(destinationTo("/publications")).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(marked()).toEqual(["/publications"]);
  });

  it("marks the screen on show when the address carries a trailing slash", () => {
    render(<App routes={table} pathname="/publications/" />);

    // The rail marks the ROUTE, not the string in the address bar, or a deep
    // link a person typed with a slash would show no current screen at all.
    expect(marked()).toEqual(["/publications"]);
  });

  it("changes screen without reloading the page", async () => {
    const user = userEvent.setup();

    render(<App routes={table} pathname="/dashboard" />);

    const railBefore = screen.getByRole("navigation");

    await user.click(destinationTo("/publications"));

    // The address moved, which in this emulated DOM only `pushState` can do: a
    // followed link navigates nowhere here, so a destination that reloaded the
    // page would leave the address exactly where it was.
    expect(window.location.pathname).toBe("/publications");

    expect(screen.getByTestId(PUBLICATIONS)).toBeInTheDocument();
    expect(screen.queryByTestId(DASHBOARD)).toBeNull();
    expect(marked()).toEqual(["/publications"]);

    // The same node, not an equal one: the application was re-rendered around
    // the new screen and never rebuilt, which is the difference between routing
    // in the page and fetching it again.
    expect(screen.getByRole("navigation")).toBe(railBefore);
  });

  it("reaches another screen with the keyboard alone", async () => {
    const user = userEvent.setup();

    render(<App routes={table} pathname="/dashboard" />);

    // Two stops in: the rail's first destination, then the second. Tab reaches
    // them because each one is a link with an address, and Enter activates them
    // for the same reason.
    await user.tab();
    await user.tab();

    expect(destinationTo("/automations")).toHaveFocus();

    await user.keyboard("{Enter}");

    expect(window.location.pathname).toBe("/automations");
    expect(screen.getByTestId(AUTOMATIONS)).toBeInTheDocument();
    expect(marked()).toEqual(["/automations"]);
  });

  it("follows the browser going back", async () => {
    const user = userEvent.setup();

    window.history.pushState({}, "", "/dashboard");
    render(<App routes={table} />);

    await user.click(destinationTo("/publications"));

    expect(screen.getByTestId(PUBLICATIONS)).toBeInTheDocument();

    window.history.back();

    // Back and forward change the address with no load, so the screen has to
    // follow the browser: otherwise the address bar says one screen and the
    // page shows another.
    await waitFor(() => {
      expect(screen.getByTestId(DASHBOARD)).toBeInTheDocument();
    });

    expect(window.location.pathname).toBe("/dashboard");
    expect(marked()).toEqual(["/dashboard"]);
  });
});

describe("REQ-146: the application exposes a navigation to every screen", () => {
  it("takes the PUBLIC screen into the application", async () => {
    const user = userEvent.setup();

    render(<App routes={navigating} pathname="/login" />);

    // Where the access screen lives: outside the shell, with no rail beside it,
    // which is exactly why it used to be handed no navigator at all and why
    // signing in was a dead end.
    expect(screen.queryByRole("navigation")).toBeNull();

    await user.click(departure());

    expect(screen.getByTestId(DASHBOARD)).toBeInTheDocument();
    expect(screen.queryByTestId(LOGIN)).toBeNull();
    // The address moved, which in this emulated DOM only `pushState` can do,
    // and the private casing is now around the screen.
    expect(window.location.pathname).toBe(DASHBOARD_ADDRESS);
    expect(marked()).toEqual([DASHBOARD_ADDRESS]);
  });

  it("changes screen with nothing dispatched at the window", async () => {
    const user = userEvent.setup();
    const announced: string[] = [];
    const record = (): void => {
      announced.push(window.location.pathname);
    };

    window.addEventListener("popstate", record);
    render(<App routes={navigating} pathname="/login" />);

    await user.click(departure());
    window.removeEventListener("popstate", record);

    // The defect REQ-146 names, from the inside: a screen with no navigator
    // could only write the address bar and then fire a `popstate` at the page,
    // because that synthetic event was the one channel the root listened on.
    // The screen changed and no such event happened, so the state behind the
    // navigation is what rendered it.
    expect(screen.getByTestId(DASHBOARD)).toBeInTheDocument();
    expect(announced).toEqual([]);
  });

  it("keeps the query out of what resolves a screen", async () => {
    const user = userEvent.setup();

    render(<App routes={navigating} pathname="/automations" />);

    await user.click(departure());

    // `/automations/form?id=launch` is one screen and a parameter: the screen
    // is resolved by the pathname, and the query survives in the address bar,
    // which is where the form reads its own identifier from.
    expect(screen.getByTestId(FORM)).toBeInTheDocument();
    expect(window.location.pathname).toBe("/automations/form");
    expect(window.location.search).toBe("?id=launch");
  });

  it("leads to a panel the route table registers", () => {
    // The address the access screen navigates to (`src/web/screens/login.tsx`),
    // checked against the table that answers it: a destination no route claims
    // would render nothing at all, and the dead end would come back wearing an
    // empty page instead of a sign-out button.
    const panel = registeredRoutes.find(
      (route) => route.path === DASHBOARD_ADDRESS,
    );

    expect(panel).toBeDefined();
    expect(panel?.public).not.toBe(true);
  });

  it("reinvents navigation in no screen of the interface", async () => {
    // The requirement's own words, guarded structurally rather than by
    // behaviour: `history.pushState` and a `PopStateEvent` dispatched at the
    // window are what three production files were doing, and a fourth copy
    // would pass every behavioural test in this file.
    const sources = import.meta.glob("./**/*.tsx", {
      eager: true,
      query: "?raw",
      import: "default",
    }) as Record<string, string>;

    const offenders = Object.entries(sources)
      .filter(([file]) => !file.endsWith(".test.tsx"))
      // The one module that IS the navigation. Everything else asks it.
      .filter(([file]) => !file.endsWith("/navigation.tsx"))
      .filter(
        ([, source]) =>
          source.includes("history.pushState") ||
          source.includes("PopStateEvent"),
      )
      .map(([file]) => file);

    // Guards the guard: a glob that read nothing would report no offender.
    expect(Object.keys(sources).length).toBeGreaterThan(1);
    expect(offenders).toEqual([]);
  });
});

describe("REQ-147: a detail route keeps the operator's place on the rail", () => {
  it("marks the parent route while a detail route is open", () => {
    render(<App routes={navigating} pathname="/automations/form" />);

    // The form is not a rail destination and never will be, so before this the
    // rail marked NOTHING: the operator was inside a form with no indication of
    // which part of the product it belonged to.
    expect(screen.getByTestId(FORM)).toBeInTheDocument();
    expect(marked()).toEqual(["/automations"]);
    expect(destinationTo("/automations")).toHaveAttribute(
      "aria-current",
      "page",
    );
  });

  it("marks it for a deep link that carries a parameter", () => {
    // What the server answers `index.html` for: the operator opened the edit
    // address directly, so the application resolves it from the address bar.
    window.history.pushState({}, "", "/automations/form?id=launch");

    render(<App routes={navigating} />);

    expect(screen.getByTestId(FORM)).toBeInTheDocument();
    expect(marked()).toEqual(["/automations"]);
  });

  it("keeps the mark on the parent after navigating into the detail", async () => {
    const user = userEvent.setup();

    render(<App routes={navigating} pathname="/automations" />);

    expect(marked()).toEqual(["/automations"]);

    await user.click(departure());

    // The place does not move because the screen did: the operator is still in
    // automations, in a form belonging to them.
    expect(screen.getByTestId(FORM)).toBeInTheDocument();
    expect(marked()).toEqual(["/automations"]);
  });

  it("REQ-227: registers the entry of a new automation as a detail of the listing", () => {
    // The screen the "New automation" control now leads to. It demands a
    // session like every other private screen, the rail does not offer it (it
    // is reached from the listing), and the rail keeps marking the automations
    // while it is open.
    const entry = registeredRoutes.find(
      (route) => route.path === AUTOMATION_START_ADDRESS,
    );

    expect(entry).toBeDefined();
    expect(entry?.public).not.toBe(true);
    expect(entry?.rail).toBe(false);
    expect(entry?.parent).toBe("/automations");
  });

  it("REQ-227: keeps the operator in the automations while the entry is open", () => {
    render(<App routes={stubbed} pathname={AUTOMATION_START_ADDRESS} />);

    expect(screen.getByTestId(AUTOMATION_START_ADDRESS)).toBeInTheDocument();
    expect(marked()).toEqual(["/automations"]);
  });

  it("gives every detail route of the real table a parent the rail leads to", () => {
    render(<App routes={navigating} pathname="/dashboard" />);

    const details = registeredRoutes.filter((route) => route.rail === false);

    // Guards the guard: a table with no detail route would satisfy an empty
    // loop and prove nothing about the requirement.
    expect(details.length).toBeGreaterThan(0);

    for (const detail of details) {
      expect(detail.parent).toBeDefined();
      expect(reachable()).toContain(detail.parent);
    }
  });
});

describe("REQ-159: the session can be ended from any private screen", () => {
  it("offers the control on every private address the table registers", () => {
    const privateScreens = stubbed.filter((route) => route.public !== true);

    // Guards the guard: a table read as empty would satisfy an empty loop and
    // prove that nothing offers anything anywhere.
    expect(privateScreens.length).toBeGreaterThan(1);

    for (const route of privateScreens) {
      const mounted = render(
        <App
          routes={stubbed}
          pathname={route.path}
          session={createSessionDouble()}
        />,
      );

      expect(screen.getByTestId(route.path)).toBeInTheDocument();
      // Including the detail route, which is reached from another screen and
      // never from the rail: being deep inside the product is exactly when
      // going back to the access screen to sign out is worst.
      expect(endSessionControl()).toBeInTheDocument();

      mounted.unmount();
    }
  });

  it("is drawn by the CASING, not by the screen inside it", () => {
    // The regression this task exists for, stated as a test: the only sign-out
    // of the interface used to belong to one screen's state, so the day that
    // screen stopped being rendered the control left the product with it. A
    // screen that draws NOTHING still has to offer the way out.
    render(
      <AppShell current={DASHBOARD_ADDRESS} session={createSessionDouble()}>
        <div />
      </AppShell>,
    );

    expect(endSessionControl()).toBeInTheDocument();
  });

  it("keeps it off the public screen, which has no session to end", () => {
    render(
      <App
        routes={stubbed}
        pathname={LOGIN_ADDRESS}
        session={createSessionDouble()}
      />,
    );

    expect(screen.getByTestId(LOGIN_ADDRESS)).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: rail.signOut }),
    ).not.toBeInTheDocument();
  });

  it("revokes the session and lands on the access screen", async () => {
    const user = userEvent.setup();
    const client = createSessionDouble();

    render(
      <App routes={stubbed} pathname={DASHBOARD_ADDRESS} session={client} />,
    );

    await user.click(endSessionControl());

    // Asked first, and nothing sent yet: the rail is a row of cheap
    // destinations, and this one costs the session and whatever is open.
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    expect(client.closes).toBe(0);

    await user.click(confirmControl());

    await waitFor(() => {
      expect(window.location.pathname).toBe(LOGIN_ADDRESS);
    });

    // The instance was asked to revoke, which is what tells this apart from a
    // control that merely changed the address and left the session standing.
    expect(client.closes).toBe(1);
    expect(screen.getByTestId(LOGIN_ADDRESS)).toBeInTheDocument();
    // The public screen has no rail beside it, so the way out went with it.
    expect(screen.queryByRole("navigation")).toBeNull();
  });

  it("lets the operator stay, and sends nothing when they do", async () => {
    const user = userEvent.setup();
    const client = createSessionDouble();

    render(
      <App routes={stubbed} pathname={DASHBOARD_ADDRESS} session={client} />,
    );

    await user.click(endSessionControl());
    await user.click(stayControl());

    // A confirmation with no way back is not a confirmation, it is an
    // announcement: the session is untouched and the screen did not move.
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(client.closes).toBe(0);
    expect(window.location.pathname).not.toBe(LOGIN_ADDRESS);
    expect(screen.getByTestId(DASHBOARD_ADDRESS)).toBeInTheDocument();
    expect(screen.queryByTestId(LOGIN_ADDRESS)).toBeNull();
  });

  it("stays where it is when the instance did not confirm the revocation", async () => {
    const user = userEvent.setup();
    const client = createSessionDouble();
    client.ended = false;

    render(
      <App routes={stubbed} pathname={DASHBOARD_ADDRESS} session={client} />,
    );

    await user.click(endSessionControl());
    await user.click(confirmControl());

    const alert = await screen.findByRole("alert");

    expect(alert).toHaveTextContent(rail.signOutFailedTitle);
    expect(alert).toHaveTextContent(rail.signOutFailed);

    // Only the instance can revoke, so a refused request leaves the session
    // open: showing the access screen here would be the interface claiming a
    // revocation that never happened.
    expect(window.location.pathname).not.toBe(LOGIN_ADDRESS);
    expect(screen.getByTestId(DASHBOARD_ADDRESS)).toBeInTheDocument();
    expect(screen.queryByTestId(LOGIN_ADDRESS)).toBeNull();
    // The dialog holds its ground, beside the control that failed.
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    // And trying again is one click, not a dialog the operator has to reopen.
    client.ended = true;
    await user.click(confirmControl());

    await waitFor(() => {
      expect(window.location.pathname).toBe(LOGIN_ADDRESS);
    });

    expect(client.closes).toBe(2);
  });

  it("reaches it, and commits it, with the keyboard alone", async () => {
    const user = userEvent.setup();
    const client = createSessionDouble();

    render(
      <App routes={stubbed} pathname={DASHBOARD_ADDRESS} session={client} />,
    );

    // Past every destination of the rail and onto the control below them: it is
    // a real button, so Tab reaches it and Enter activates it with no key
    // handling of ours.
    await tabTo(user, endSessionControl());
    await user.keyboard("{Enter}");

    const confirm = await screen.findByRole("button", {
      name: rail.signOutConfirm,
    });

    await tabTo(user, confirm);
    await user.keyboard("{Enter}");

    await waitFor(() => {
      expect(window.location.pathname).toBe(LOGIN_ADDRESS);
    });

    expect(client.closes).toBe(1);
  });

  it("shows the confirmation working, without losing its word", async () => {
    const user = userEvent.setup();
    const client = createSessionDouble();
    let release = (): void => {};
    client.close = (): Promise<boolean> =>
      new Promise((resolve) => {
        release = (): void => resolve(true);
      });

    render(
      <App routes={stubbed} pathname={DASHBOARD_ADDRESS} session={client} />,
    );

    await user.click(endSessionControl());
    await user.click(confirmControl());

    // Revoking is a request, and a request can be slow: the commit is out of
    // reach while it is in flight and still says what it is doing, which is
    // what a spinner with no word cannot do.
    const pending = await screen.findByRole("button", {
      name: rail.signingOut,
    });

    expect(pending).toBeDisabled();

    release();

    await waitFor(() => {
      expect(window.location.pathname).toBe(LOGIN_ADDRESS);
    });
  });

  it("names it from the catalogue, in the language the instance is in", async () => {
    render(
      <LocaleProvider client={localeClient("pt-BR")}>
        <App
          routes={stubbed}
          pathname={DASHBOARD_ADDRESS}
          session={createSessionDouble()}
        />
      </LocaleProvider>,
    );

    // The word travels through the catalogue and nowhere else: a label written
    // in the code would answer to the English name in every language.
    expect(
      await screen.findByRole("button", { name: ptBR.nav.signOut }),
    ).toBeInTheDocument();
    expect(ptBR.nav.signOut).not.toBe(rail.signOut);
  });
});

describe("REQ-148: the interface declares a main landmark", () => {
  it("holds the private screen in exactly one main", () => {
    render(<App routes={navigating} pathname="/dashboard" />);

    // `getAllByRole` and not `getByRole`: two landmarks are as bad as none,
    // because a screen reader offering two "main content" regions has told the
    // operator that neither is it.
    const landmarks = screen.getAllByRole("main");

    expect(landmarks).toHaveLength(1);
    expect(
      within(landmarks[0] as HTMLElement).getByTestId(DASHBOARD),
    ).toBeInTheDocument();
    // The rail is a landmark of its own and stays outside: the work is what
    // `main` means, and a region containing the navigation is the whole page.
    expect(
      within(landmarks[0] as HTMLElement).queryByRole("navigation"),
    ).toBeNull();
  });

  it("holds the public screen in exactly one main too", () => {
    render(<App routes={navigating} pathname="/login" />);

    const landmarks = screen.getAllByRole("main");

    expect(landmarks).toHaveLength(1);
    expect(
      within(landmarks[0] as HTMLElement).getByTestId(LOGIN),
    ).toBeInTheDocument();
  });
});

/* ------------------------------------------------------------------ *
 * 3k.21: the casing on a handset
 * ------------------------------------------------------------------ */

/**
 * The rail is 15rem of fixed column, and until this task it was 15rem of fixed
 * column on a 390px handset too: the whole sheet carried one layout media query
 * and it covered the automation editor. Below 48rem the rail is now a drawer
 * behind a menu button, and the assertions below are the three kinds of claim
 * that makes.
 *
 *   - what the SHEET declares, read as text. jsdom applies no stylesheet, so
 *     nothing rendered here can say whether the fixed column went away; the
 *     rules are therefore held statically, the way `automation-form.test.tsx`
 *     holds the editor's;
 *   - what the CASING asks the viewport. The cutoff is written twice by
 *     necessity — once in a media query, once for the control that only exists
 *     below it — and two cutoffs that drift give a screen a rail and a menu
 *     button at the same time. So the query the casing passes to `matchMedia`
 *     is held against the condition the sheet declares;
 *   - what a KEYBOARD can do while the drawer is open, which is the half no
 *     stylesheet decides.
 */
const SHEETS = import.meta.glob<string>("./components/components.css", {
  eager: true,
  query: "?raw",
  import: "default",
});

const COMPONENT_SHEET = Object.values(SHEETS)[0] ?? "";

/** The body of the first `{ ... }` after `header`, braces balanced. */
function blockAfter(source: string, header: string): string {
  const open = source.indexOf("{", source.indexOf(header));
  let depth = 0;

  for (let index = open; index < source.length; index += 1) {
    depth += source[index] === "{" ? 1 : source[index] === "}" ? -1 : 0;

    if (depth === 0) {
      return source.slice(open + 1, index);
    }
  }

  return "";
}

/**
 * The narrow-viewport block that carries `selector`.
 *
 * By content and not by position: the sheet has more than one block under this
 * condition (the editor keeps its own, guarded elsewhere), and a reader that
 * took the first would be asserting about whichever one happens to be written
 * higher up in the file.
 */
function narrowBlockFor(selector: string): string {
  const header = `@media ${NARROW_VIEWPORT}`;

  for (
    let at = COMPONENT_SHEET.indexOf(header);
    at >= 0;
    at = COMPONENT_SHEET.indexOf(header, at + 1)
  ) {
    const body = blockAfter(COMPONENT_SHEET.slice(at), header);

    if (body.includes(selector)) {
      return body;
    }
  }

  return "";
}

/** Every query the casing asked the viewport about, and how to move it. */
interface Viewport {
  readonly asked: readonly string[];
  /** Crosses the cutoff the way a rotation does, listeners and all. */
  readonly crossTo: (narrow: boolean) => void;
}

/**
 * A viewport of a given width.
 *
 * jsdom implements no `matchMedia` at all, which is why the casing guards the
 * call: with nothing installed here every test above this line renders the wide
 * casing, and that is the point — the rail is what the product had, and none of
 * those tests knows this task happened.
 */
function viewport(narrow: boolean): Viewport {
  const asked: string[] = [];
  const following = new Set<(event: MediaQueryListEvent) => void>();
  let matches = narrow;

  const list = {
    media: NARROW_VIEWPORT,
    get matches(): boolean {
      return matches;
    },
    addEventListener(
      _type: string,
      listener: (event: MediaQueryListEvent) => void,
    ): void {
      following.add(listener);
    },
    removeEventListener(
      _type: string,
      listener: (event: MediaQueryListEvent) => void,
    ): void {
      following.delete(listener);
    },
  };

  window.matchMedia = (query: string): MediaQueryList => {
    asked.push(query);

    return list as unknown as MediaQueryList;
  };

  return {
    asked,
    crossTo: (next: boolean): void => {
      matches = next;

      act(() => {
        for (const listener of following) {
          listener({
            matches: next,
            media: NARROW_VIEWPORT,
          } as MediaQueryListEvent);
        }
      });
    },
  };
}

/** The control that opens the drawer, by role and by its catalogue word. */
function menuControl(): HTMLElement {
  return (
    screen.queryByRole("button", { name: rail.menu }) ??
    screen.getByRole("button", { name: rail.closeMenu })
  );
}

/** The rail whether it is on show or shut away, which is what an id follows. */
function drawer(): HTMLElement {
  return screen.getByRole("navigation", { hidden: true });
}

afterEach(() => {
  // jsdom ships without it, so removing the double is what restores the
  // environment the rest of this file runs in.
  Reflect.deleteProperty(window, "matchMedia");
});

describe("3k.21: below the cutoff the rail is a drawer", () => {
  it("asks the viewport the question the stylesheet answers", () => {
    const view = viewport(false);

    render(<App routes={table} pathname="/dashboard" />);

    // A sweep that read an empty module would pass every static assertion in
    // this block forever: vitest replaces a stylesheet with nothing unless
    // `css` is on (see `vitest.config.ts`).
    expect(COMPONENT_SHEET.length).toBeGreaterThan(0);

    // One cutoff, spelled in both languages of the product: the sheet's
    // condition and the question the casing puts to `matchMedia`.
    expect(view.asked).toContain(NARROW_VIEWPORT);
    expect(COMPONENT_SHEET).toContain(`@media ${NARROW_VIEWPORT}`);
  });

  it("takes the fixed column away and puts the rail over the work", () => {
    const narrow = narrowBlockFor(".mc-shell {");

    // The column: `.mc-shell` is `var(--width-sidebar) 1fr` everywhere else,
    // and one column with a row for the bar under this condition.
    expect(blockAfter(narrow, ".mc-shell {")).toContain(
      "grid-template-columns: minmax(0, 1fr);",
    );
    expect(blockAfter(narrow, ".mc-shell {")).toContain(
      "grid-template-rows: minmax(0, 1fr);",
    );

    // The rail: out of the flow, over the work, and reaching both edges of the
    // viewport rather than being a card in a column.
    expect(blockAfter(narrow, ".mc-nav {")).toContain("position: fixed;");

    // A shut drawer collapses. `hidden` is the browser's own `display: none`
    // and it loses to the `display: flex` the rail declares for itself, so
    // without this rule the drawer lies over the screen with nothing to close
    // it (REQ-199).
    expect(blockAfter(COMPONENT_SHEET, ".mc-nav[hidden] {")).toContain(
      "display: none;",
    );

    // And the work breathes: desktop gutters on a 390px handset leave a column
    // of about 326px, with every card padded again inside it.
    expect(blockAfter(narrow, ".mc-page {")).toContain(
      "padding: var(--space-5) var(--space-4) var(--space-10);",
    );
  });

  it("offers no menu control at all while the rail is a column", () => {
    viewport(false);

    render(<App routes={table} pathname="/dashboard" />);

    // Not hidden, not off screen, not disabled: absent. A control taken out by
    // a `display` rule is one that comes back as an invisible tab stop the day
    // a class is renamed, and above the cutoff nothing about the casing moved.
    expect(screen.queryByRole("button", { name: rail.menu })).toBeNull();
    expect(screen.getByRole("navigation")).toBeVisible();
    expect(screen.getByRole("main")).not.toHaveAttribute("inert");
  });

  it("names the control, says it is shut, and says what it opens", () => {
    viewport(true);

    render(<App routes={table} pathname="/dashboard" />);

    const control = menuControl();

    // The state, programmatically: colour and a glyph leave a screen reader
    // with a button that opens something unnamed and never says whether it is
    // already open.
    expect(control).toHaveAttribute("aria-expanded", "false");

    const target = control.getAttribute("aria-controls") ?? "";

    expect(target).not.toBe("");

    // And what it points at is IN the document while shut, which is the half of
    // REQ-186 no reading of the source can decide: an `aria-controls` naming an
    // element that is not there states a relation the page does not have.
    expect(document.getElementById(target)).toBe(drawer());
    expect(drawer()).not.toBeVisible();
  });

  it("opens the drawer and puts focus on the first destination", async () => {
    const user = userEvent.setup();

    viewport(true);
    render(<App routes={table} pathname="/dashboard" />);

    await user.click(menuControl());

    expect(
      screen.getByRole("button", { name: rail.closeMenu }),
    ).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("navigation")).toBeVisible();
    // Focus goes IN. Left on the button, the next Tab would walk into the work
    // behind the scrim, which is the region the drawer is covering.
    expect(destinationTo("/dashboard")).toHaveFocus();
  });

  it("slides the mobile header away on downward work scrolling and reveals it on the way back", () => {
    viewport(true);
    render(<App routes={table} pathname="/dashboard" />);

    const shell = document.querySelector(".mc-shell") as HTMLElement;
    const work = screen.getByRole("main");

    Object.defineProperty(work, "scrollTop", { configurable: true, value: 80 });
    fireEvent.scroll(work);
    expect(shell).toHaveClass("mc-shell--bar-hidden");

    Object.defineProperty(work, "scrollTop", { configurable: true, value: 20 });
    fireEvent.scroll(work);
    expect(shell).not.toHaveClass("mc-shell--bar-hidden");
  });

  it("keeps a visible close control in the header while the drawer is open", async () => {
    const user = userEvent.setup();
    viewport(true);
    render(<App routes={table} pathname="/dashboard" />);

    await user.click(menuControl());
    const close = screen.getByRole("button", { name: rail.closeMenu });
    expect(close).toBeVisible();
    expect(close.querySelector("path")?.getAttribute("d")).toBe("M18 6 6 18");

    await user.click(close);
    expect(menuControl()).toHaveAttribute("aria-expanded", "false");
    expect(menuControl()).toHaveFocus();
  });

  it("keeps the keyboard inside the drawer while it is open", async () => {
    const user = userEvent.setup();

    viewport(true);
    // The one table whose screen carries a control of its own: a trap tested
    // over an empty screen proves nothing, because there is nowhere to escape
    // TO. This screen has a button, and the assertions below are that the
    // keyboard never reaches it.
    render(<App routes={navigating} pathname="/automations" />);

    await user.click(menuControl());

    const panel = screen.getByRole("navigation");
    const behind = departure();

    expect(within(screen.getByRole("main")).getByRole("button")).toBe(behind);

    // Right around the drawer and past its end, several times over: the trap
    // wraps, so every stop is inside the rail — never the screen behind it, and
    // never the button either, which the drawer is covering while it is open.
    for (let stop = 0; stop < KEYBOARD_STOPS; stop += 1) {
      await user.tab();

      const here = document.activeElement as HTMLElement;

      expect(here).not.toBe(behind);
      expect(here).not.toBe(menuControl());
      expect(panel.contains(here)).toBe(true);
    }

    // And backwards, which is a different branch of the same trap.
    for (let stop = 0; stop < KEYBOARD_STOPS; stop += 1) {
      await user.tab({ shift: true });

      expect(panel.contains(document.activeElement)).toBe(true);
    }

    // The other half, and the one a trap cannot give: the work is out of the
    // accessibility tree and out of reach of the pointer while it is covered.
    expect(screen.getByRole("main")).toHaveAttribute("inert");
  });

  it("closes on Escape and gives the control its focus back", async () => {
    const user = userEvent.setup();

    viewport(true);
    render(<App routes={table} pathname="/dashboard" />);

    await user.click(menuControl());
    await user.keyboard("{Escape}");

    expect(menuControl()).toHaveAttribute("aria-expanded", "false");
    expect(drawer()).not.toBeVisible();
    // Back on the button. Focus dropped on `body` is a keyboard operator who
    // has to walk the page from the top again to get anywhere at all.
    expect(menuControl()).toHaveFocus();
    expect(screen.getByRole("main")).not.toHaveAttribute("inert");
  });

  it("closes on the scrim, which is how a pointer leaves a drawer", async () => {
    const user = userEvent.setup();

    viewport(true);
    render(<App routes={table} pathname="/dashboard" />);

    await user.click(menuControl());

    // Found by class and not by role, because it HAS no role: it is a surface
    // that says what is out of play, and giving it one would put a nameless
    // control in the tab order between the drawer and the work.
    const scrim = document.querySelector(".mc-shell__scrim");

    expect(scrim).not.toBeNull();

    await user.click(scrim as HTMLElement);

    expect(menuControl()).toHaveAttribute("aria-expanded", "false");
    expect(menuControl()).toHaveFocus();
    expect(document.querySelector(".mc-shell__scrim")).toBeNull();
    expect(screen.getByRole("main")).not.toHaveAttribute("inert");
  });

  it("puts the drawer away when a destination is picked", async () => {
    const user = userEvent.setup();

    viewport(true);
    render(<App routes={table} pathname="/dashboard" />);

    await user.click(menuControl());
    await user.click(destinationTo("/publications"));

    // The drawer covers the work, and the work is the screen just asked for:
    // leaving it open would put the rail over the answer.
    expect(screen.getByTestId(PUBLICATIONS)).toBeInTheDocument();
    expect(menuControl()).toHaveAttribute("aria-expanded", "false");
    expect(menuControl()).toHaveFocus();
    expect(screen.getByRole("main")).not.toHaveAttribute("inert");
  });

  it("takes the drawer with the viewport when it grows past the cutoff", async () => {
    const user = userEvent.setup();
    const view = viewport(true);

    render(<App routes={table} pathname="/dashboard" />);

    await user.click(menuControl());

    view.crossTo(false);

    // The rail is a column again, so there is nothing to open: a drawer left
    // "open" here would only be holding the work inert with no scrim in sight
    // to say why nothing answers.
    expect(screen.queryByRole("button", { name: rail.menu })).toBeNull();
    expect(screen.getByRole("navigation")).toBeVisible();
    expect(screen.getByRole("main")).not.toHaveAttribute("inert");
  });

  it("names the control from the catalogue, in the language in force", async () => {
    viewport(true);

    render(
      <LocaleProvider client={localeClient("pt-BR")}>
        <App routes={table} pathname="/dashboard" />
      </LocaleProvider>,
    );

    // The word travels through the catalogue and nowhere else: a label written
    // in the code would answer to the English name in every language, and this
    // one is the ONLY name the control has.
    expect(
      await screen.findByRole("button", { name: ptBR.nav.menu }),
    ).toBeInTheDocument();
    expect(ptBR.nav.menu).not.toBe(rail.menu);
  });
});
