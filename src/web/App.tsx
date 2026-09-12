import { useEffect } from "react";
import type { ReactElement } from "react";
import { UNAUTHORIZED_FAILURE } from "./http-failure.js";
import { NavigationProvider, useNavigation } from "./navigation.js";
import { routes as registeredRoutes } from "./routes.js";
import type { RouteEntry } from "./routes.js";
import { DASHBOARD_ADDRESS } from "./screens/dashboard.js";
import { LOGIN_ADDRESS } from "./screens/login.js";
import type { SessionClient } from "./screens/login.js";
import { AppShell } from "./shell.js";

/**
 * The root component: it renders the screen registered for the address on show,
 * and moves between screens without reloading the page (REQ-112).
 *
 * Matching is exact, on purpose. The screens of this phase are flat addresses
 * (`/flows`, `/automations`, `/publications`), and a pattern matcher would be a
 * guess about routes that do not exist yet. When one needs a parameter, the
 * matcher changes here and every screen stays untouched.
 *
 * The address itself is NOT this component's private business any more, which
 * is the whole of REQ-146: it lives in the navigation context
 * (`src/web/navigation.tsx`), which wraps the public screen too, so a screen
 * that has to move somewhere asks for it instead of dispatching a synthetic
 * `popstate` at the window. The root's remaining job is the one it is named
 * for: address in, screen out.
 *
 * The server sends `index.html` for any unknown address (`src/http/static.ts`),
 * which is what lets a deep link be opened directly instead of only reached by
 * navigation inside the application.
 *
 * An address NO entry claims is not a screen: it is a doorway (REQ-302). The
 * root is the first of them and the one an operator types and bookmarks, and it
 * was answering with an empty page, which is the defect this closes; a renamed
 * route in a favourite and a mistyped address were answering with the same
 * empty page, silently. `Doorway` below is where all of them go, and where it
 * leads is decided by the one question that separates the panel from the access
 * screen: whether a session is open.
 */

/**
 * The read the doorway asks the instance to answer, and it is asked for its
 * STATUS and nothing else.
 *
 * It is a private route (everything under `/api` is, bar the language the
 * access screen needs, see `PUBLIC_READS` in `src/http/access.ts`), so its
 * refusal for want of a session is exactly the fact the doorway is missing.
 * That refusal is not assumed here: `src/http/api/instance.test.ts` holds that
 * a read of this address from a caller with no session is answered 401.
 *
 * A read of the instance's own settings rather than of the operator's data:
 * whichever answer comes back is thrown away, and this is the smallest thing
 * behind the guard that nothing else in this file has to understand.
 */
const SESSION_PROBE_ENDPOINT = "/api/instance";
const ONBOARDING_PROBE_ENDPOINT = "/api/instance/configuration";

/**
 * Whether the instance still recognises the session this browser holds.
 *
 * A port, so a test drives the doorway with a double the way it drives the
 * rail's sign out. It exists because the session cookie is `httpOnly`
 * (`src/auth/session.ts`): nothing in the page can read it, so the only honest
 * answer comes from the instance, and a page that guessed would send an
 * operator with an open session back to type their password.
 */
export interface SessionProbe {
  /**
   * False ONLY when the instance refused for want of a session.
   *
   * Every other answer, and no answer at all, is true. An instance that is
   * broken or unreachable says nothing about the session, and the panel is
   * where an operator holding one belongs: it has a failed state of its own,
   * and a session that really has expired is met there by the notice every
   * private screen shares (`src/web/session-expired.tsx`).
   */
  isOpen(): Promise<boolean>;
}

/** The real probe: same origin, so the session cookie travels on its own. */
export const httpSessionProbe: SessionProbe = {
  isOpen: async (): Promise<boolean> => {
    try {
      const response = await fetch(SESSION_PROBE_ENDPOINT);

      return response.status !== Number(UNAUTHORIZED_FAILURE);
    } catch {
      return true;
    }
  },
};

export interface OnboardingProbe {
  isComplete(): Promise<boolean>;
}

export const httpOnboardingProbe: OnboardingProbe = {
  isComplete: async (): Promise<boolean> => {
    try {
      const response = await fetch(ONBOARDING_PROBE_ENDPOINT);
      if (!response.ok) return false;
      const body = (await response.json()) as {
        onboarding?: { complete?: unknown };
      };
      return body.onboarding?.complete === true;
    } catch {
      return false;
    }
  },
};

/**
 * Route tables are injected only by UI tests. Their focused assertions predate
 * the setup journey, so they opt into a complete journey unless a test is
 * explicitly exercising the guard.
 */
const completeOnboardingProbe: OnboardingProbe = {
  isComplete: (): Promise<boolean> => Promise.resolve(true),
};

export interface AppProps {
  /** Injected by tests. The running application always uses the real table. */
  readonly routes?: readonly RouteEntry[];
  /**
   * The address to START at. Injected by tests, where there is no navigation to
   * change the address before the first render.
   */
  readonly pathname?: string;
  /**
   * Injected by tests, and handed to the casing: the rail's sign out revokes
   * the session for real (REQ-159), so a test that drives it needs a double
   * where the running interface has `/api/session`.
   */
  readonly session?: SessionClient;
  /**
   * Injected by tests. Asked by every doorway and every private screen, so a
   * deep link cannot draw a protected screen after the session has ended.
   */
  readonly probe?: SessionProbe;
  readonly onboarding?: OnboardingProbe;
}

/** Trailing slash is not a different screen: `/flows/` and `/flows` are one. */
function normalize(pathname: string): string {
  return pathname.length > 1 && pathname.endsWith("/")
    ? pathname.slice(0, -1)
    : pathname;
}

export function matchRoute(
  table: readonly RouteEntry[],
  pathname: string,
): RouteEntry | undefined {
  const wanted = normalize(pathname);

  return table.find((route) => normalize(route.path) === wanted);
}

export function App(props: AppProps = {}): ReactElement {
  const routes = props.routes ?? registeredRoutes;
  const probe = props.probe ?? httpSessionProbe;
  const onboarding =
    props.onboarding ??
    (props.routes === undefined
      ? httpOnboardingProbe
      : completeOnboardingProbe);

  // The provider is ABOVE the screen and not inside the shell: the access
  // screen is rendered outside the shell, being the only public one, and it is
  // the screen that most needed a navigator (REQ-146).
  return (
    <NavigationProvider pathname={props.pathname}>
      <Screen
        routes={routes}
        session={props.session}
        probe={probe}
        onboarding={onboarding}
      />
    </NavigationProvider>
  );
}

interface DoorwayProps {
  readonly probe: SessionProbe;
  readonly onboarding: OnboardingProbe;
}

/**
 * Where an address no screen claimed leads (REQ-302).
 *
 * The root is the address an operator types and keeps in their favourites, and
 * it is NOT a destination: it is the question "where do I belong?", and only
 * the instance can answer it. So the doorway asks, and then sends them to the
 * panel or to the access screen. Anything else nobody claimed is sent through
 * the same door on purpose: a favourite of a route that was renamed and a typed
 * address with a letter missing are both an operator who meant somewhere real,
 * and both used to be answered with an empty page and no word at all.
 *
 * A doorway and not a screen that says "this address does not exist", which was
 * the alternative: that screen would be interface copy, every operator-visible
 * word of this product comes from the catalogue, and the catalogue is written
 * by other tasks of this phase. It also answers a question nobody asked. What
 * an operator loses this way is the fact that they mistyped, and what they get
 * back is the address bar: the redirect REPLACES the address, so the bar reads
 * `/dashboard` and not what was typed, which is the interface saying where it
 * took them.
 *
 * It draws nothing while it asks. That is a screen with no content for as long
 * as one request takes and never a moment longer, which is a different thing
 * from the blank page this closes: that one had no next step at all.
 */
function Doorway({ probe, onboarding }: DoorwayProps): null {
  const { redirect } = useNavigation();

  useEffect(() => {
    let cancelled = false;

    void Promise.all([probe.isOpen(), onboarding.isComplete()]).then(
      ([open, complete]): void => {
        // An answer that arrives after the operator has already gone somewhere
        // else is an answer to a question nobody is asking any more, and acting
        // on it would drag them off the screen they asked for.
        if (!cancelled) {
          redirect(
            open ? (complete ? DASHBOARD_ADDRESS : "/setup") : LOGIN_ADDRESS,
          );
        }
      },
    );

    return (): void => {
      cancelled = true;
    };
  }, [probe, onboarding, redirect]);

  return null;
}

interface ScreenProps {
  readonly routes: readonly RouteEntry[];
  readonly session?: SessionClient;
  readonly probe: SessionProbe;
  readonly onboarding: OnboardingProbe;
}

interface PrivateScreenProps {
  readonly route: RouteEntry;
  readonly screen: ReactElement;
  readonly session?: SessionClient;
  readonly probe: SessionProbe;
  readonly onboarding: OnboardingProbe;
}

/**
 * The guard around every private screen.
 *
 * Static hosting has to send the SPA document for a deep link. The browser
 * therefore asks the same private endpoint as `Doorway`; a 401 replaces the
 * deep link with `/login`. The screen remains mounted while that asynchronous
 * answer is in flight, so navigation never becomes a blank page on a slow
 * connection.
 */
function PrivateScreen({
  route,
  screen,
  session,
  probe,
  onboarding,
}: PrivateScreenProps): ReactElement | null {
  const { redirect } = useNavigation();

  useEffect(() => {
    let cancelled = false;

    void Promise.all([probe.isOpen(), onboarding.isComplete()]).then(
      ([open, complete]): void => {
        if (cancelled) return;

        if (!open) {
          redirect(LOGIN_ADDRESS);
        } else if (complete && route.path === "/setup") {
          // A confirmation can arrive while the operator is reading the
          // checklist. The next render of this route must release them instead
          // of leaving an all-complete checklist as a dead end.
          redirect(DASHBOARD_ADDRESS);
        } else if (
          !complete &&
          route.path !== "/instance" &&
          route.path !== "/setup"
        ) {
          redirect("/setup");
        }
      },
    );

    return (): void => {
      cancelled = true;
    };
  }, [probe, onboarding, redirect, route.path]);

  return (
    <AppShell
      current={
        route.path === "/setup" ? route.path : (route.parent ?? route.path)
      }
      session={session}
      onboardingPending={route.path === "/setup" || route.path === "/instance"}
    >
      {screen}
    </AppShell>
  );
}

/** The screen registered for the address the navigation reports. */
function Screen({
  routes,
  session,
  probe,
  onboarding,
}: ScreenProps): ReactElement | null {
  const { address } = useNavigation();

  const match = matchRoute(routes, address);

  if (match === undefined) {
    return <Doorway probe={probe} onboarding={onboarding} />;
  }

  const screen = <match.Screen />;

  // The public screen renders with no rail beside it. There is nothing to
  // navigate to without a session, and offering the private set to someone who
  // holds none would be a promise every one of those screens refuses. It is
  // still the page's `main` landmark, because a screen with no navigation
  // around it is all main content there is (REQ-148).
  return match.public === true ? (
    <main className="mc-public">{screen}</main>
  ) : (
    <PrivateScreen
      route={match}
      screen={screen}
      session={session}
      probe={probe}
      onboarding={onboarding}
    />
  );
}
