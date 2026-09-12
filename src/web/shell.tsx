import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { ReactElement, ReactNode } from "react";
import {
  AppNav,
  Brand,
  Button,
  ConfirmDialog,
  IconButton,
  Notice,
} from "./components/index.js";
import type { IconName, NavItem } from "./components/index.js";
import { useLocale } from "./locale.js";
import { useNavigation } from "./navigation.js";
import { httpSessionClient, LOGIN_ADDRESS } from "./screens/login.js";
import type { SessionClient } from "./screens/login.js";

interface AccountProfile {
  readonly connected: boolean;
  readonly name?: string;
  readonly pictureUrl?: string;
}

interface AccountProfileClient {
  read(): Promise<AccountProfile>;
}

const httpAccountProfileClient: AccountProfileClient = {
  async read(): Promise<AccountProfile> {
    const response = await fetch("/api/account-profile");
    if (!response.ok) throw new Error("account profile unavailable");
    return ((await response.json()) as { profile: AccountProfile }).profile;
  },
};

/**
 * The casing every private screen is rendered inside: the navigation rail, and
 * the column the screen occupies beside it (REQ-112).
 *
 * The arrangement is the prototype's, ported rather than invented
 * (`mychat-design-system/project/ui_kits/panel/index.html`): a fixed rail of
 * flat addresses, the work above and the settings below, the brand set in type
 * because the repository ships no logo (`Brand`, REQ-331). `.mc-shell` is a two
 * column grid the height of the viewport and each column scrolls on its own,
 * which is what the content column's `.mc-work` is for.
 *
 * The rail carries the SIGN OUT of REQ-159, and that is the one place in the
 * interface where it can live: the casing is what every private screen shares,
 * so a control here is reachable from all of them and from none of the public
 * ones. Before it, the only way to end a session was the panel the access
 * screen draws after a successful sign-in, and entering stopped rendering that
 * panel the moment entering started leading to the dashboard (REQ-146): the one
 * call to `DELETE /api/session` in the interface was still proven by a test and
 * no longer reachable by a person.
 *
 * Three decisions behind the control, because none of them is obvious:
 *
 *   - it ASKS FIRST. The rail is a row of cheap destinations where a misclick
 *     costs a screen change, and this one costs the session: the operator types
 *     the password again and whatever was open goes with it. The confirmation
 *     is the design system's `ConfirmDialog` in its destructive weight, the same
 *     shape the two other irreversible operations of the product use.
 *   - the FAILURE stays in the dialog. `close()` answers false when the instance
 *     did not confirm the revocation, and the session is then still open: the
 *     dialog holds its ground and says so, beside the control that failed, so
 *     the operator can try again. Navigating away on a failed revocation would
 *     show the access screen over a session that is still standing, which is the
 *     exact lie `login.tsx` refuses to tell.
 *   - it goes to `/login` only once the instance CONFIRMED. That is where an
 *     operator with no session belongs, and `/login` stays deliberately outside
 *     this navigation: it is the one public screen and not part of the private
 *     set.
 *
 * What the prototype's rail carries and this one still does NOT is the session
 * note ("the session is open"). Nothing here asks the instance whether the
 * cookie is still valid, so the sentence would be one the page invented, and it
 * would keep saying it after the session expired. A control that ENDS a session
 * is a different promise from a sentence that claims one exists.
 *
 * Every word comes from the catalogue, the product name included. Not because
 * the name is translated (every catalogue carries the same word for it) but
 * because no operator-visible string is written in the code, and a component
 * knows no language: the words arrive as properties (REQ-074).
 *
 * The screen beside the rail is the page's `main` landmark (REQ-148). The rail
 * is already a `navigation` landmark, so before this the one region a screen
 * reader could not jump to was the work itself, which is the region an operator
 * is actually here for.
 *
 * ---------------------------------------------------------------------------
 * The casing on a HANDSET, which is what the paragraphs above never described.
 *
 * A 15rem column of destinations on a 390px screen is 62% of the width spent on
 * a rail, and it was spent on every screen of the product: the sheet carried
 * exactly one layout media query and it covered the automation editor. So below
 * 48rem the rail leaves the flow entirely and becomes a DRAWER, reached from a
 * menu button in a bar at the top. 48rem is the editor's own cutoff, spelled
 * once in `NARROW_VIEWPORT` here and once in `components.css`, and the two are
 * held together by a guard in `app.test.tsx`.
 *
 * A drawer rather than a panel pushed above the work: the destinations are a
 * short flat list, and pushing them into the flow would move the screen down
 * every time the menu is opened, which on a phone means losing the place you
 * were reading. The drawer covers, the work stays where it was, and the scrim
 * says out loud that what is behind it is not in play.
 *
 * Whether the button EXISTS is decided in JavaScript and not by a `display`
 * rule, which is deliberate: a control hidden by CSS is still a control the
 * markup carries, and the day a rule is renamed it comes back as an invisible
 * tab stop above the first destination. `matchMedia` asks the same question the
 * sheet asks, so above 48rem the casing renders exactly what it rendered
 * before: a rail, a screen, and no menu control anywhere in the document.
 *
 * While the drawer is open, the keyboard cannot leave it and the pointer cannot
 * reach past it. BOTH mechanisms are here and they answer different questions:
 *
 *   - the DRAWER traps Tab. `keydown` is taken over while it is open and focus
 *     is moved along the drawer's own stops, wrapping at each end. This is the
 *     guarantee that can be measured: it holds in any DOM, and it is the half a
 *     test can prove;
 *   - the work is `inert`. That is the browser's own instrument, and it does
 *     what a trap cannot: it takes `main` out of the accessibility tree and out
 *     of reach of the pointer, so a screen reader's virtual cursor does not
 *     wander into a region sitting behind a scrim.
 *
 * The button is NOT one of the stops the trap walks, which is deliberate and is
 * the same contract `Modal` has with the control that opens it: the drawer runs
 * from edge to edge of the viewport and covers the bar, so a Tab that landed on
 * the button would put the focus ring on something nobody can see. It is still
 * a button in the document, still says `aria-expanded="true"`, and a screen
 * reader that reaches it can still shut the drawer with it.
 *
 * Escape closes, the way it closes the dialogs of this product, so does the
 * scrim, and closing always puts focus back on the button that opened the
 * drawer: focus dropped on `body` is a keyboard operator starting the page
 * again from the top.
 */

/**
 * The one viewport question the casing asks, in the sheet's own words.
 *
 * Exported because `app.test.tsx` holds it against the stylesheet: two cutoffs
 * that drift apart give a screen a menu button and a fixed rail at once, or
 * neither, and nothing in a running browser would say so.
 */
export const NARROW_VIEWPORT = "(max-width: 48rem)";

/**
 * The query, or nothing where the DOM does not implement one.
 *
 * jsdom ships no `matchMedia` at all, and the whole suite of the interface runs
 * in jsdom: without this guard every existing test of the casing would fail on
 * a missing function rather than on anything it asserts. Nothing is the WIDE
 * answer, which is the safe one — the rail is what the product had.
 */
function narrowViewport(): MediaQueryList | null {
  return typeof window.matchMedia === "function"
    ? window.matchMedia(NARROW_VIEWPORT)
    : null;
}

/**
 * Whether the viewport is a handset's, kept in step with it.
 *
 * Read at the first render rather than after it: starting wide and correcting
 * in an effect would draw the rail's column for one frame on every phone.
 */
function useNarrowViewport(): boolean {
  const [narrow, setNarrow] = useState<boolean>(
    () => narrowViewport()?.matches ?? false,
  );

  useEffect(() => {
    const query = narrowViewport();

    if (query === null) {
      return undefined;
    }

    // Read again on mount: a rotation between the first render and this effect
    // would otherwise leave the casing describing the previous viewport.
    setNarrow(query.matches);

    const follow = (event: MediaQueryListEvent): void => {
      setNarrow(event.matches);
    };

    query.addEventListener("change", follow);

    return (): void => {
      query.removeEventListener("change", follow);
    };
  }, []);

  return narrow;
}

/**
 * Everything inside the drawer a keyboard can land on, in document order: the
 * destinations, and the sign out under them.
 *
 * Read off the DOM rather than listed here, because the rail's contents are a
 * property of `AppNav` and of what the casing hands it: a list written out
 * would be a copy that stops matching the day a destination is added.
 */
const DRAWER_STOPS = "a[href], button:not([disabled])";

function stopsOf(root: HTMLElement | null): readonly HTMLElement[] {
  return root === null
    ? []
    : [...root.querySelectorAll<HTMLElement>(DRAWER_STOPS)];
}

export interface AppShellProps {
  /**
   * The address of the screen on show, which is the id the rail marks with
   * `aria-current="page"`. The matched ROUTE's path, or the parent it declares
   * when the screen is a detail one (REQ-147), so `/flows/` and `/flows` mark
   * the same destination and the automation form marks the automations.
   */
  readonly current: string;
  /** The screen registered for `current`. */
  readonly children: ReactNode;
  /**
   * Injected by tests. The running interface always talks to `/api/session`,
   * through the same client the access screen uses: one revocation, written
   * once, so a second copy cannot drift from the route that actually revokes.
   */
  readonly session?: SessionClient;
  /** Injected by tests; production reads the authenticated identity endpoint. */
  readonly accountProfile?: AccountProfileClient;
  /** Restricts navigation while the required connection journey is incomplete. */
  readonly onboardingPending?: boolean;
}

/**
 * One destination of the rail.
 *
 * The id and the address are the same string on purpose: the id is what the
 * rail compares against the screen on show, and the screen on show IS the
 * address. One value, so the two cannot drift apart.
 *
 * `href` is that address and never `#`, which is what keeps a destination a real
 * link: it can be opened in another tab, copied, and reached with Tab. The
 * click handler is what keeps an ordinary activation inside the page.
 */
function destination(path: string, label: string, icon: IconName): NavItem {
  return { id: path, href: path, label, icon };
}

export function AppShell({
  current,
  children,
  session = httpSessionClient,
  accountProfile = httpAccountProfileClient,
  onboardingPending = false,
}: AppShellProps): ReactElement {
  const { t } = useLocale();
  // Taken from the context rather than received as a property: the rail is one
  // more caller of the application's navigation, and it stopped being the only
  // one with a navigator when every screen got the same one (REQ-146).
  const { navigate } = useNavigation();

  /** Whether the confirmation is on screen, and how the last attempt went. */
  const [asking, setAsking] = useState(false);
  const [ending, setEnding] = useState(false);
  const [failed, setFailed] = useState(false);
  const [profile, setProfile] = useState<AccountProfile>();
  const [pictureBroken, setPictureBroken] = useState(false);

  /** Whether the rail is a drawer, and whether the drawer is open. */
  const narrow = useNarrowViewport();
  const [menuOpen, setMenuOpen] = useState(false);
  const [headerHidden, setHeaderHidden] = useState(false);

  /** What the button says it controls (REQ-186), and what the trap walks. */
  const navId = useId();
  const menuButton = useRef<HTMLButtonElement>(null);
  const work = useRef<HTMLElement>(null);

  useEffect(() => {
    let current = true;
    void accountProfile
      .read()
      .then((value) => {
        if (current) setProfile(value);
      })
      .catch(() => {
        if (current) setProfile({ connected: false });
      });
    return () => {
      current = false;
    };
  }, [accountProfile]);

  // The drawer, by the id the button already names. No second ref for the same
  // element: `aria-controls` exists to point at exactly this, and a rail that
  // could be found by one route and not the other would be a contradiction.
  const drawerOf = useCallback(
    (): HTMLElement | null => document.getElementById(navId),
    [navId],
  );

  const closeMenu = useCallback((): void => {
    setMenuOpen(false);
    // Back to the control that opened it. Focus left on `body` is a keyboard
    // operator who has to walk the page from the top again to get anywhere.
    menuButton.current?.focus();
  }, []);

  // A viewport that grew past the cutoff takes the drawer with it: the rail is
  // a column again, so an "open" drawer would only be leaving `main` inert with
  // no scrim in sight to explain why nothing answers. No focus is moved here,
  // because nobody asked for anything: the window was resized.
  useEffect(() => {
    if (!narrow) {
      setMenuOpen(false);
      setHeaderHidden(false);
    }
  }, [narrow]);

  useEffect(() => {
    const surface = work.current;

    if (!narrow || surface === null) {
      return undefined;
    }

    let previous = surface.scrollTop;
    const followScroll = (): void => {
      const currentTop = surface.scrollTop;

      if (menuOpen || currentTop <= 0 || currentTop < previous) {
        setHeaderHidden(false);
      } else if (currentTop > previous) {
        setHeaderHidden(true);
      }

      previous = currentTop;
    };

    surface.addEventListener("scroll", followScroll, { passive: true });

    return (): void => surface.removeEventListener("scroll", followScroll);
  }, [narrow, menuOpen]);

  // Opening moves focus INTO the drawer, onto the first destination. Without
  // it, Tab would continue from the button into whatever the browser thinks
  // comes next, which is the work behind the scrim.
  useEffect(() => {
    if (menuOpen) {
      stopsOf(drawerOf())[0]?.focus();
    }
  }, [menuOpen, drawerOf]);

  // Escape, and the trap. On the window rather than on the panel, for the
  // reason `Modal` records: the drawer has to answer the key wherever focus
  // happens to be when it opens.
  useEffect(() => {
    if (!menuOpen) {
      return undefined;
    }

    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        closeMenu();
        return;
      }

      if (event.key !== "Tab") {
        return;
      }

      const stops = stopsOf(drawerOf());

      if (stops.length === 0) {
        return;
      }

      const here = stops.indexOf(document.activeElement as HTMLElement);
      // Focus outside the drawer walks back IN, at whichever end it came from,
      // which is what a Tab pressed while the button still holds focus does.
      const next = event.shiftKey
        ? stops[(here <= 0 ? stops.length : here) - 1]
        : stops[here === stops.length - 1 ? 0 : here + 1];

      event.preventDefault();
      next?.focus();
    };

    window.addEventListener("keydown", onKey);

    return (): void => window.removeEventListener("keydown", onKey);
  }, [menuOpen, closeMenu, drawerOf]);

  // Picking a destination puts the drawer away: it covers the work, and the
  // work is the screen the operator just asked for. Wide, there is no drawer
  // and no button, so this is the plain navigation it always was.
  const goTo = useCallback(
    (address: string): void => {
      closeMenu();
      navigate(address);
    },
    [closeMenu, navigate],
  );

  const endSession = useCallback(async (): Promise<void> => {
    setEnding(true);
    setFailed(false);

    const ended = await session.close();

    setEnding(false);

    // Only the instance can revoke, so only the instance can be believed: a
    // shell that closed itself over a refused request would send the operator
    // to the access screen while their session stayed open.
    if (!ended) {
      setFailed(true);
      return;
    }

    setAsking(false);
    navigate(LOGIN_ADDRESS);
  }, [navigate, session]);

  const rail = (
    <AppNav
      id={navId}
      // Shut, the drawer is out of the tab order and out of the accessibility
      // tree, and it is still IN the document: `aria-controls` above names an
      // id, and an id a screen reader cannot follow states a relation the page
      // does not have (REQ-186). Never hidden while the rail is a column.
      hidden={narrow && !menuOpen}
      label={t("nav.label")}
      brandLead={t("nav.brandLead")}
      brandAccent={t("nav.brandAccent")}
      account={
        profile === undefined ? null : profile.connected &&
          profile.name !== undefined ? (
          <div className="mc-nav__account" aria-label={t("nav.account.label")}>
            {profile.pictureUrl !== undefined && !pictureBroken ? (
              <img
                className="mc-nav__account-picture"
                src={profile.pictureUrl}
                alt=""
                onError={(): void => setPictureBroken(true)}
              />
            ) : (
              <span className="mc-nav__account-fallback" aria-hidden="true">
                {profile.name.slice(0, 1).toUpperCase()}
              </span>
            )}
            <span className="mc-nav__account-name">{profile.name}</span>
          </div>
        ) : (
          <p className="mc-nav__account mc-nav__account--empty">
            {t("nav.account.unavailable")}
          </p>
        )
      }
      current={current}
      onNavigate={goTo}
      items={
        onboardingPending
          ? [
              destination("/setup", t("nav.setup"), "check"),
              destination("/instance", t("nav.instance"), "database"),
            ]
          : [
              destination("/dashboard", t("nav.dashboard"), "layout-dashboard"),
              destination("/automations", t("nav.automations"), "zap"),
              destination("/publications", t("nav.publications"), "image"),
              destination("/settings", t("nav.settings"), "settings"),
              destination("/instance", t("nav.instance"), "database"),
            ]
      }
      // Under the destinations, which is where the prototype puts the
      // session. A real button and not a link: it does not lead anywhere,
      // it ends something, and Tab reaches it for the same reason it reaches
      // every destination above it (REQ-159).
      footer={
        <Button
          variant="ghost"
          icon="log-out"
          onClick={(): void => {
            setFailed(false);
            setAsking(true);
            // The drawer goes away and focus is NOT sent back to the button:
            // the confirmation is about to take it, and two claims on the
            // focus in one frame is how a dialog opens behind a menu.
            setMenuOpen(false);
          }}
        >
          {t("nav.signOut")}
        </Button>
      }
    />
  );

  return (
    <div
      className={`mc-shell${
        narrow && headerHidden && !menuOpen ? " mc-shell--bar-hidden" : ""
      }${narrow && menuOpen ? " mc-shell--menu-open" : ""}`}
    >
      {/* The bar, and it exists only on a handset: the first grid row, holding
          the one control that reaches the destinations. */}
      {narrow ? (
        <div className="mc-shell__bar">
          <IconButton
            icon={menuOpen ? "x" : "menu"}
            label={t(menuOpen ? "nav.closeMenu" : "nav.menu")}
            bordered
            ref={menuButton}
            aria-expanded={menuOpen}
            aria-controls={navId}
            onClick={(): void => {
              if (menuOpen) {
                closeMenu();
              } else {
                setMenuOpen(true);
              }
            }}
          />
          {/* The product's name, so the bar the rail folds into is still the
              application and not an anonymous strip with a glyph. The same mark
              the rail draws, from the same two catalogue words. */}
          <Brand lead={t("nav.brandLead")} accent={t("nav.brandAccent")} />
        </div>
      ) : null}

      {narrow && menuOpen ? (
        // Not a control and never in the tab order: it says what is out of play
        // and gives the pointer the ordinary way out of a drawer. `mousedown`
        // for the reason `Modal` gives: a selection that ended out here should
        // not close what it started in.
        //
        // The `preventDefault` is the focus return, and it was measured going
        // wrong without it: pressing a pointer down moves focus to whatever was
        // pressed, and the browser does that AFTER this handler runs, so the
        // focus `closeMenu` put back on the button landed on `body` instead.
        <div
          className="mc-shell__scrim"
          onMouseDown={(event): void => {
            event.preventDefault();
            closeMenu();
          }}
        />
      ) : null}

      {rail}

      {/* Its own scrolling column: the rail stays put while a long screen
          moves, which is the point of the grid above. The landmark of the page,
          and the only one: the shell renders exactly one screen (REQ-148).

          `inert` while the drawer is open: the trap holds the keyboard, and
          this is what holds everything else. A region behind a scrim that a
          screen reader can still walk into is a region the operator is told
          they can use and cannot see. */}
      <main ref={work} className="mc-work" inert={narrow && menuOpen}>
        {children}
      </main>

      {asking ? (
        <ConfirmDialog
          title={t("nav.signOutTitle")}
          consequence={t("nav.signOutConsequence")}
          destructive
          pending={ending}
          // The word changes while it works and the button keeps a word, the
          // way the access screen's does: a control whose label empties out
          // while it runs is one the operator cannot name to anyone.
          confirmLabel={ending ? t("nav.signingOut") : t("nav.signOutConfirm")}
          cancelLabel={t("nav.signOutStay")}
          // No `groups`: ending a session reaches no stored record, so there is
          // nothing to enumerate and the disclosure never appears. What it
          // costs is what the consequence says.
          onConfirm={(): void => {
            void endSession();
          }}
          onCancel={(): void => {
            setAsking(false);
            setFailed(false);
          }}
        >
          {failed ? (
            <Notice nature="error" title={t("nav.signOutFailedTitle")}>
              {t("nav.signOutFailed")}
            </Notice>
          ) : null}
        </ConfirmDialog>
      ) : null}
    </div>
  );
}
