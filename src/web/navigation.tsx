import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import type { MouseEvent, ReactElement, ReactNode } from "react";

/**
 * The navigation of the interface: the address on show, and the ONE way to
 * change it (REQ-146).
 *
 * It exists because the address used to be `App.tsx`'s private business. The
 * root component held it in state and handed the function that changed it to
 * the shell alone, so a SCREEN that had to move somewhere had no navigator at
 * all. Three production files answered that the only way left to them:
 * `history.pushState` followed by a `PopStateEvent` the page dispatched at
 * itself, because a synthetic `popstate` was the one channel the root was
 * listening on. The access screen could not even do that: it is rendered
 * outside the shell, being the only public one, and signing in left the
 * operator on a screen whose only control was "sign out".
 *
 * So the address moves into a context that wraps the WHOLE application, public
 * screen included, and the hack has one owner instead of three copies:
 *
 *   - `navigate(path)` writes the address bar with `pushState`, which changes
 *     the address with no request, and then sets the state the application
 *     renders from. Nothing is dispatched at the window: the state IS the
 *     channel, and a page that has to fire an event at itself to notice its own
 *     navigation is a page telling itself a rumour.
 *   - `address` is read BACK from the browser after the push rather than kept
 *     as it was written. `/automations/form?id=launch` is one screen and a
 *     query, and what resolves a screen is the pathname; the form reads its own
 *     parameter from the address bar.
 *   - `popstate` is still listened for, and that is not the same thing: back and
 *     forward are the BROWSER changing the address, and following them is what
 *     keeps the page from showing one screen while the address bar says another.
 *
 * `follow` is the click handler every destination in the interface uses. A
 * destination stays a real `<a href>`, so it is reachable with Tab, opens in
 * another tab on the middle button and can be copied; what is intercepted is
 * the ordinary activation, which would otherwise fetch `index.html` again and
 * throw away the language the page had already read (REQ-112).
 *
 * One address change, one place to ask about it, and that is what the EXIT
 * GUARD is for (REQ-295). A screen holding work nobody saved has to be asked
 * before it is replaced, and the exits it can see for itself are the ones it
 * draws: the rail of the shell is a different component, drawn beside it and
 * never inside it. So the screen registers a guard here, with `useExitGuard`,
 * and `navigate` asks it before the address moves. Every caller is covered by
 * construction, the rail included, because `navigate` is already the ONE way
 * the address changes.
 *
 * The guard belongs to the screen and dies with it: the hook takes it back
 * when the screen unmounts, so the next screen inherits no warning of anybody
 * else's. And there is at most one, because there is at most one screen: the
 * root renders exactly the entry the address matched.
 */

/**
 * A screen's answer to being replaced: false HOLDS the navigation where it is.
 *
 * It is asked with the address the operator was going to, because a screen that
 * holds an exit has to be able to take the operator there afterwards, and the
 * one it would guess is not the one they chose.
 */
export type ExitGuard = (path: string) => boolean;

export interface NavigationValue {
  /**
   * The address on show, as a pathname. Never carries a query: two addresses
   * that differ only by one are the same screen, and the screen is what this
   * value decides.
   */
  readonly address: string;
  /**
   * Goes to an address, inside the page, unless the screen on show holds it
   * back (REQ-295).
   */
  navigate(path: string): void;
  /**
   * Goes to an address REPLACING the one on show, which leaves no entry behind
   * in the browser's history.
   *
   * For an address that was never a destination: the doorway of `App.tsx` sends
   * the root, and anything else no screen claimed, wherever the session says it
   * belongs. Pushing there would leave the address that redirects sitting one
   * step back, so the browser's back button would land on it and be redirected
   * forward again, and the operator would be unable to leave the page at all.
   *
   * NO exit guard is asked here, and that is the difference between the two:
   * this is the interface deciding where an address belongs, not an operator
   * leaving a screen. The doorway only runs where no screen matched, so there
   * is no screen holding anything, and the access screen redirects into the
   * panel of a session that has just opened.
   */
  redirect(path: string): void;
  /**
   * The click handler for a link to `path`: keeps an ordinary activation inside
   * the page and leaves every other one to the browser.
   */
  follow(path: string): (event: MouseEvent) => void;
  /**
   * Registers the screen's exit guard and answers with the way to take it back
   * (REQ-295). Screens use `useExitGuard`, which ties the taking-back to the
   * life of the screen itself.
   */
  holdExit(guard: ExitGuard): () => void;
}

/**
 * The click handler factory of `NavigationValue`, named so a screen can carry
 * it into the plain functions it renders with: those are not components, so
 * they cannot read the context themselves and receive it as a property.
 */
export type Follow = NavigationValue["follow"];

/**
 * Writes the address bar and answers with the pathname the browser resolved,
 * which is what a screen is registered under.
 */
function pushAddress(path: string): string {
  window.history.pushState({}, "", path);

  return window.location.pathname;
}

/** The same, over the entry on show instead of on top of it. */
function replaceAddress(path: string): string {
  window.history.replaceState({}, "", path);

  return window.location.pathname;
}

/**
 * Whether a click on a link is the activation this page answers: a middle
 * click, a modified click and a click something else already handled all belong
 * to the browser, and none of them takes the current screen away.
 *
 * Exported because the rail asks the same question before it intercepts a click
 * of its own (`components/AppNav.tsx`), which is the one destination in the
 * interface that does not go through `follow`. It matters twice over now that a
 * screen can hold an exit (REQ-295): a click that opens another tab leaves the
 * screen where it is, so it loses nothing, and being asked whether to discard
 * work over it is being asked about nothing.
 */
export function replacesTheScreen(event: MouseEvent): boolean {
  const wantsNewWindow =
    event.metaKey || event.ctrlKey || event.shiftKey || event.altKey;

  return !event.defaultPrevented && event.button === 0 && !wantsNewWindow;
}

/**
 * Keeps an ordinary activation of a link inside the page, and lets every other
 * one through.
 */
function following(
  navigate: (path: string) => void,
  path: string,
): (event: MouseEvent) => void {
  return (event: MouseEvent): void => {
    if (!replacesTheScreen(event)) {
      return;
    }

    event.preventDefault();
    navigate(path);
  };
}

interface ExitGate {
  /** Registers `guard`, and answers with the way to take it back. */
  hold(guard: ExitGuard): () => void;
  /** Whether the screen on show lets the address become `path`. */
  lets(path: string): boolean;
}

/**
 * Holds the exit guard of the screen on show, and asks it.
 *
 * ONE guard and not a list, because the root renders one screen at a time: a
 * stack would be modelling an arrangement this interface does not have, and it
 * would answer the question "who is holding this?" with "somebody".
 *
 * The taking-back is compared against the guard that registered it. React
 * mounts the next screen's effects around the previous screen's cleanup, and a
 * cleanup that cleared whatever it found would take away the guard of the
 * screen that had just arrived.
 */
function exitGate(): ExitGate {
  let held: ExitGuard | undefined;

  const hold = (guard: ExitGuard): (() => void) => {
    held = guard;

    return (): void => {
      if (held === guard) {
        held = undefined;
      }
    };
  };

  const lets = (path: string): boolean => held === undefined || held(path);

  return { hold, lets };
}

/**
 * The gate of a screen mounted with no provider around it.
 *
 * Module-wide because `detached` is one object for the whole module, and it is
 * the same arrangement the real one has: one interface, one screen, one guard.
 * A test that mounts a screen on its own gets the behaviour the application
 * has, instead of a navigator that quietly ignores what the screen registered.
 */
const detachedGate = exitGate();

/**
 * What a screen rendered outside the provider sees.
 *
 * Only a test mounts a screen that way, and the honest answer there is the
 * browser itself: the address bar moves, so the destination a screen asked for
 * is observable, and nothing is re-rendered because there is no application
 * around it to re-render. The same shape `locale.tsx` gives a screen with no
 * provider, and for the same reason: a screen must render, not throw, when it
 * is mounted on its own.
 */
const detached: NavigationValue = {
  get address(): string {
    return window.location.pathname;
  },

  navigate: (path: string): void => {
    if (detachedGate.lets(path)) {
      pushAddress(path);
    }
  },

  redirect: (path: string): void => {
    replaceAddress(path);
  },

  follow: (path: string) => following(detached.navigate, path),

  holdExit: detachedGate.hold,
};

const NavigationContext = createContext<NavigationValue>(detached);

export interface NavigationProviderProps {
  readonly children: ReactNode;
  /**
   * The address to START at. Injected by tests, where there is no navigation to
   * change the address before the first render.
   *
   * A starting value and not a controlled one: navigating inside the page has
   * to change what is on screen, and a prop that won every render would pin the
   * application to the address a test happened to mount it at.
   */
  readonly pathname?: string;
}

export function NavigationProvider({
  children,
  pathname,
}: NavigationProviderProps): ReactElement {
  /**
   * The address on show, in state rather than read from `window.location` at
   * render time: `pushState` changes the address with no load and therefore
   * tells React nothing, so the address has to live somewhere a change renders
   * from.
   */
  const [address, setAddress] = useState(
    () => pathname ?? window.location.pathname,
  );

  useEffect(() => {
    // Back and forward change the address with no load of their own. Without
    // this they would move the address bar and leave the previous screen on the
    // page, which is the classic way a hand-rolled router lies about where the
    // operator is.
    const adopt = (): void => {
      setAddress(window.location.pathname);
    };

    window.addEventListener("popstate", adopt);

    return (): void => {
      window.removeEventListener("popstate", adopt);
    };
  }, []);

  /** The guard of the screen on show, for as long as that screen is on show. */
  const gate = useMemo(exitGate, []);

  const navigate = useCallback(
    (path: string): void => {
      // The screen answers first. A screen that holds the exit is a screen with
      // something to say about it, and saying it is the whole of REQ-295: what
      // used to happen here was the address changing under work nobody saved.
      if (gate.lets(path)) {
        setAddress(pushAddress(path));
      }
    },
    [gate],
  );

  const redirect = useCallback((path: string): void => {
    setAddress(replaceAddress(path));
  }, []);

  const value = useMemo<NavigationValue>(
    () => ({
      address,
      navigate,
      redirect,
      follow: (path: string) => following(navigate, path),
      holdExit: gate.hold,
    }),
    [address, navigate, redirect, gate],
  );

  return (
    <NavigationContext.Provider value={value}>
      {children}
    </NavigationContext.Provider>
  );
}

/** What every screen uses to go somewhere else. */
export function useNavigation(): NavigationValue {
  return useContext(NavigationContext);
}

/**
 * Holds the interface back from replacing this screen, while `guard` is one
 * (REQ-295).
 *
 * `undefined` is the ordinary state and it registers NOTHING, so a screen with
 * nothing to lose costs the navigation not one question: the guard exists only
 * while the screen has something to say, and the argument is where the screen
 * says what that is. The criterion stays in the screen, which is the only place
 * that knows it.
 *
 * The cleanup is the point of the hook. A guard the screen forgot to take back
 * would go on holding the exits of the screen that came after it, which is a
 * worse defect than the one it closes: the operator would be asked to confirm
 * the loss of work that is not there and belongs to nobody.
 */
export function useExitGuard(guard: ExitGuard | undefined): void {
  const { holdExit } = useNavigation();

  useEffect(() => {
    if (guard === undefined) {
      return undefined;
    }

    return holdExit(guard);
  }, [guard, holdExit]);
}
