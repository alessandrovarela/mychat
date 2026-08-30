import { useCallback, useId, useState } from "react";
import type { CSSProperties, FormEvent, ReactElement } from "react";
import {
  Brand,
  Button,
  Field,
  Icon,
  ICON_SIZE,
  Notice,
} from "../components/index.js";
import type { NoticeNature } from "../components/index.js";
import { useLocale } from "../locale.js";
import { useNavigation } from "../navigation.js";
import { DASHBOARD_ADDRESS } from "./dashboard.js";

/**
 * The access screen (REQ-031, REQ-034, REQ-035, REQ-104): sign in, sign out,
 * and the state of holding no session at all.
 *
 * The one decision worth stating is that a WRONG PASSWORD and a BLOCKED ORIGIN
 * are two different answers here, never one. `POST /api/session` refuses with
 * 401 when the password does not match and with 429 when the ceiling of
 * REQ-034 has already closed on this origin, and in the second case the
 * password was not even checked. Folding them into one message would tell an
 * operator who typed the right password that they typed the wrong one, and
 * would hide the only fact that helps them: how long the block lasts, which the
 * answer carries in `retry-after`.
 *
 * REQ-115 is that distinction made visible. The four outcomes this screen can
 * reach used to be four identical paragraphs, so the difference existed in the
 * sentence and nowhere else. Each one now arrives as a `Notice` carrying a
 * nature, a glyph and a title of its own:
 *
 *   - a refused password is an `error`. It is recoverable right now, and the
 *     field beside it still holds what was typed;
 *   - a blocked origin is a `warning`. Nothing is wrong with the password, and
 *     the only useful fact is the wait, which is in the title's sentence;
 *   - an instance that did not answer is an `error` that is nobody's typing
 *     mistake, and its title says so instead of blaming the password;
 *   - a session that could not be ended is an `error` too, and it is the only
 *     one of the four that appears beside an OPEN session.
 *
 * Everything an operator reads comes from the catalogue. The codes below are
 * codes: they are branched on, never rendered.
 */

export const SESSION_ENDPOINT = "/api/session";

/**
 * Where this screen lives, named so the interface can SEND an operator here
 * instead of writing the address twice.
 *
 * The rail's sign out is the caller (`src/web/shell.tsx`): once the instance
 * confirms the revocation, the operator holds no session, and this is the one
 * screen that answers without one.
 */
export const LOGIN_ADDRESS = "/login";

/** Header the 429 carries, in seconds. Read as a number, never shown as text. */
const RETRY_AFTER_HEADER = "retry-after";

const UNAUTHORIZED_STATUS = 401;
const TOO_MANY_STATUS = 429;

/**
 * Why an attempt did not open a session.
 *
 *   - `invalid_credentials`: the instance checked the password and refused it.
 *   - `too_many_attempts`: the instance refused BEFORE checking anything.
 *   - `unreachable`: no answer arrived, so nothing was attempted at all.
 */
export const SESSION_REFUSALS = [
  "invalid_credentials",
  "too_many_attempts",
  "unreachable",
] as const;

export type SessionRefusal = (typeof SESSION_REFUSALS)[number];

export interface SessionRefused {
  readonly ok: false;
  readonly reason: SessionRefusal;
  /**
   * How long the origin has to wait, in seconds. Only ever set beside
   * `too_many_attempts`, and only when the answer actually carried it: a wait
   * this build invented would be worse than no number.
   */
  readonly retryAfterSeconds?: number;
}

export type SessionOutcome = { readonly ok: true } | SessionRefused;

/** The two calls the screen makes, so a test drives them with a double. */
export interface SessionClient {
  open(password: string): Promise<SessionOutcome>;
  /** True when the instance confirmed the session is over. */
  close(): Promise<boolean>;
}

/** Seconds from the header, or undefined when it says nothing usable. */
export function retryAfterOf(header: string | null): number | undefined {
  if (header === null || header.trim() === "") {
    return undefined;
  }

  const seconds = Number(header);

  return Number.isFinite(seconds) && seconds > 0
    ? Math.ceil(seconds)
    : undefined;
}

/** The real client: same origin, so the session cookie travels on its own. */
export const httpSessionClient: SessionClient = {
  open: async (password: string): Promise<SessionOutcome> => {
    let response: Response;

    try {
      response = await fetch(SESSION_ENDPOINT, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password }),
      });
    } catch {
      return { ok: false, reason: "unreachable" };
    }

    if (response.ok) {
      return { ok: true };
    }

    if (response.status === TOO_MANY_STATUS) {
      const seconds = retryAfterOf(response.headers.get(RETRY_AFTER_HEADER));

      return seconds === undefined
        ? { ok: false, reason: "too_many_attempts" }
        : {
            ok: false,
            reason: "too_many_attempts",
            retryAfterSeconds: seconds,
          };
    }

    return {
      ok: false,
      reason:
        response.status === UNAUTHORIZED_STATUS
          ? "invalid_credentials"
          : "unreachable",
    };
  },

  close: async (): Promise<boolean> => {
    try {
      const response = await fetch(SESSION_ENDPOINT, { method: "DELETE" });

      // The row is what revokes, and only the instance can remove it: a screen
      // that cleared its own state over a failed request would show a signed
      // out panel while the session was still open.
      return response.ok;
    } catch {
      return false;
    }
  },
};

export interface LoginScreenProps {
  /** Injected by tests. The running interface always talks to `/api/session`. */
  readonly client?: SessionClient;
}

/** What the screen is showing about the last thing the operator asked for. */
type Outcome =
  | { readonly kind: "refused"; readonly refusal: SessionRefused }
  | { readonly kind: "signOutFailed" };

/** A notice, resolved: the nature that colours it and the two texts inside. */
interface Announcement {
  readonly nature: NoticeNature;
  readonly title: string;
  readonly sentence: string;
}

/**
 * The frame of the one public screen, ported from the prototype
 * (`mychat-design-system/project/ui_kits/panel/LoginScreen.jsx`).
 *
 * Written here rather than as a rule in the system sheet because the prototype
 * writes it here too: this is the only screen with this frame, the values are
 * all tokens, and a class of its own would be a rule with a single caller. The
 * surface and the full height come from `.mc-public`, which the application
 * wraps every public route in (`src/web/App.tsx`).
 */
const PAGE: CSSProperties = {
  display: "flex",
  minHeight: "100%",
  alignItems: "center",
  justifyContent: "center",
  padding: "var(--space-10) var(--space-4)",
};

/** Narrow on purpose: one field and one button need no more width than this. */
const COLUMN: CSSProperties = {
  width: "100%",
  maxWidth: "26rem",
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-5)",
};

const HEADING: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-3)",
};

const BRAND_TEXT: CSSProperties = { fontSize: "var(--text-lg)" };

export function LoginScreen({
  client = httpSessionClient,
}: LoginScreenProps = {}): ReactElement {
  const { t } = useLocale();
  const { navigate } = useNavigation();
  const passwordFieldId = useId();

  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | undefined>(undefined);
  /**
   * Whether THIS page holds a session it opened. It starts false because a
   * freshly loaded page has opened none: the cookie may still be in the
   * browser, and every private route says so on the first call the panel makes.
   *
   * Inside the application the operator does not stay to read what it renders:
   * the navigation below takes them to the panel. It is kept because it is the
   * confirmation and the revocation of REQ-031 and REQ-104 proven end to end,
   * from a password typed to a session ended, which no other test in the
   * interface covers. The operator's way OUT no longer depends on it: the rail
   * carries sign out on every private screen (REQ-159, `src/web/shell.tsx`),
   * and both call the same `close()` written below.
   */
  const [opened, setOpened] = useState(false);

  const submit = useCallback(
    async (event: FormEvent<HTMLFormElement>): Promise<void> => {
      event.preventDefault();
      setBusy(true);
      setOutcome(undefined);

      const answer = await client.open(password);

      setBusy(false);

      if (!answer.ok) {
        // The password stays in the field: a blocked origin will type the same
        // one again in a minute, and clearing it punishes the wrong mistake.
        setOutcome({ kind: "refused", refusal: answer });
        return;
      }

      setPassword("");
      setOpened(true);
      // Entering LEADS somewhere (REQ-146). This screen used to end here, with
      // a confirmation and a sign-out button, which is a dead end: the operator
      // signed in and had to reach for the address bar to use what they had
      // just unlocked. The panel is the destination the specification fixed,
      // and it is asked for through the navigation the application exposes,
      // which is what makes the screen change without the page being fetched
      // again.
      navigate(DASHBOARD_ADDRESS);
    },
    [client, navigate, password],
  );

  const signOut = useCallback(async (): Promise<void> => {
    setBusy(true);
    setOutcome(undefined);

    const ended = await client.close();

    setBusy(false);

    if (!ended) {
      setOutcome({ kind: "signOutFailed" });
      return;
    }

    setOpened(false);
  }, [client]);

  const announcement =
    outcome === undefined ? undefined : announcementOf(outcome, t);

  return (
    <div style={PAGE}>
      <div style={COLUMN}>
        <div style={HEADING}>
          {/* The mark the rail draws, at the size of the heading under it:
              the name in type, its second word in the accent, and no symbol,
              because there is no logo to use and none is invented (REQ-331). */}
          <Brand
            lead={t("nav.brandLead")}
            accent={t("nav.brandAccent")}
            style={BRAND_TEXT}
          />
          <h1 style={BRAND_TEXT}>{t("screens.login.title")}</h1>
        </div>

        <div className="mc-panel">
          {announcement === undefined ? null : (
            <Notice nature={announcement.nature} title={announcement.title}>
              {announcement.sentence}
            </Notice>
          )}

          {opened ? (
            <>
              <Notice nature="success" title={t("screens.login.signedInTitle")}>
                {t("screens.login.signedIn")}
              </Notice>
              <Button
                variant="secondary"
                icon="log-out"
                disabled={busy}
                onClick={(): void => {
                  void signOut();
                }}
              >
                {t("screens.login.signOut")}
              </Button>
            </>
          ) : (
            <form
              className="mc-stack"
              onSubmit={(event): void => {
                void submit(event);
              }}
            >
              <p className="mc-panel__note">{t("screens.login.intro")}</p>

              <Field
                id={passwordFieldId}
                type="password"
                name="password"
                label={t("screens.login.passwordLabel")}
                autoComplete="current-password"
                required
                value={password}
                onChange={(event): void => {
                  setPassword(event.target.value);
                }}
              />

              {/* The word changes while it works, and the button keeps a word:
                  a control whose label empties out is one the operator cannot
                  name to anyone. */}
              <Button type="submit" variant="primary" block pending={busy}>
                {busy
                  ? t("screens.login.submitting")
                  : t("screens.login.submit")}
              </Button>

              <p className="mc-source">
                <Icon name="lock" size={ICON_SIZE.chip} />
                {t("screens.login.note")}
              </p>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * The notice for an outcome, and the only place the four part ways.
 *
 * Nature and title come first because they are what an operator reads before
 * the sentence: a `warning` headed "attempts blocked" is already a different
 * answer from an `error` headed "password refused", whatever follows it.
 */
function announcementOf(
  outcome: Outcome,
  t: (key: string, params?: Record<string, unknown>) => string,
): Announcement {
  if (outcome.kind === "signOutFailed") {
    return {
      nature: "error",
      title: t("screens.login.signOutFailedTitle"),
      sentence: t("screens.login.signOutFailed"),
    };
  }

  const refusal = outcome.refusal;

  if (refusal.reason === "invalid_credentials") {
    return {
      nature: "error",
      title: t("screens.login.wrongPasswordTitle"),
      sentence: t("screens.login.wrongPassword"),
    };
  }

  if (refusal.reason === "too_many_attempts") {
    // The number is what makes the message actionable, and it only exists when
    // the answer carried it: otherwise the operator is told to wait, not told
    // to wait a length this screen made up.
    return {
      nature: "warning",
      title: t("screens.login.blockedTitle"),
      sentence:
        refusal.retryAfterSeconds === undefined
          ? t("screens.login.blockedUnknown")
          : t("screens.login.blocked", { seconds: refusal.retryAfterSeconds }),
    };
  }

  return {
    nature: "error",
    title: t("screens.login.unreachableTitle"),
    sentence: t("screens.login.unreachable"),
  };
}
