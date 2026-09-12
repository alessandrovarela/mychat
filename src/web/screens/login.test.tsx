import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import en from "../../i18n/locales/en.json";
import pt from "../../i18n/locales/pt-BR.json";
import { LocaleProvider } from "../locale.js";
import type { LocaleClient, LocaleState } from "../locale.js";
import { NavigationProvider, useNavigation } from "../navigation.js";
import { routes as registeredRoutes } from "../routes.js";
import { DASHBOARD_ADDRESS } from "./dashboard.js";
import {
  httpSessionClient,
  LOGIN_ADDRESS,
  LoginScreen,
  retryAfterOf,
  SESSION_ENDPOINT,
} from "./login.js";
import type {
  SessionClient,
  SessionOutcome,
  SetupClient,
  SetupOutcome,
  SetupStorage,
} from "./login.js";

/**
 * The access screen, in the emulated DOM the gate can afford (ADR-017,
 * ADR-018: no browser, no container).
 *
 * The assertion this file exists for is that 401 and 429 are TWO answers here.
 * An operator refused because the ceiling of REQ-034 closed on their address
 * was not told their password is wrong, because it was never checked, and the
 * only fact that helps them is how long the block lasts. A screen that folded
 * the two into one message would pass a test that only checked "something is
 * shown", so the test compares the two sentences and demands they differ.
 *
 * REQ-115 widens that from two answers to four. The screen used to render every
 * outcome as the same paragraph, so the last group below takes all four at
 * once, collects the notice each produces, and demands that no two of them read
 * the same and that each carries a nature of its own. A screen that put four
 * different sentences inside four identical blocks would pass every earlier
 * test in this file and fail that one.
 *
 * Not a word of any of it is written here: every assertion is against the
 * shipped catalogue, which is criterion 43 from the positive side.
 */

const PT = "pt-BR";
const EN = "en";
const PASSWORD = "a-long-enough-password";

const copy = en.screens.login;
const setupCopy = en.screens.setup;

/** Resolves a catalogue entry the way the translator does, for a query. */
function text(
  template: string,
  params: Record<string, string | number>,
): string {
  return Object.entries(params).reduce(
    (resolved, [name, value]) =>
      resolved.split(`{{${name}}}`).join(String(value)),
    template,
  );
}

/** The instance's language, so the provider never reaches for `fetch`. */
function localeClient(locale: string): LocaleClient {
  return {
    read: (): Promise<LocaleState> =>
      Promise.resolve({ locale, available: [EN, PT] }),
    write: (): Promise<LocaleState> =>
      Promise.resolve({ locale, available: [EN, PT] }),
  };
}

interface SessionDouble extends SessionClient {
  /** Every password the screen sent, in order. */
  readonly attempts: string[];
  answer: SessionOutcome;
  ended: boolean;
  closes: number;
}

function createSessionDouble(): SessionDouble {
  const double: SessionDouble = {
    attempts: [],
    answer: { ok: true },
    ended: true,
    closes: 0,

    open: (password: string): Promise<SessionOutcome> => {
      double.attempts.push(password);
      return Promise.resolve(double.answer);
    },

    close: (): Promise<boolean> => {
      double.closes += 1;
      return Promise.resolve(double.ended);
    },
  };

  return double;
}

interface SetupDouble extends SetupClient {
  readonly requests: Array<{
    password: string;
    passwordConfirmation: string;
    storage: SetupStorage;
  }>;
  completeState: boolean;
  answer: SetupOutcome;
}

function createSetupDouble(complete = true): SetupDouble {
  const double: SetupDouble = {
    requests: [],
    completeState: complete,
    answer: { ok: true },
    state: (): Promise<{ readonly complete: boolean }> =>
      Promise.resolve({ complete: double.completeState }),
    complete: (input): Promise<SetupOutcome> => {
      double.requests.push(input);
      if (double.answer.ok) double.completeState = true;
      return Promise.resolve(double.answer);
    },
  };
  return double;
}

function show(client: SessionClient, locale = EN): ReactElement {
  return (
    <LocaleProvider client={localeClient(locale)}>
      <LoginScreen client={client} />
    </LocaleProvider>
  );
}

const ADDRESS = "address";

/** Reports the address the application's navigation is holding. */
function Address(): ReactElement {
  const { address } = useNavigation();

  return <p data-testid={ADDRESS}>{address}</p>;
}

/**
 * The screen INSIDE the application's navigation, which is where it runs.
 *
 * The probe beside it is what tells a screen that merely wrote the address bar
 * apart from one that asked the application to change screen: only the second
 * moves this value, and only the second makes the panel appear in production.
 */
function inApp(client: SessionClient, locale = EN): ReactElement {
  return (
    <LocaleProvider client={localeClient(locale)}>
      <NavigationProvider pathname={LOGIN_ADDRESS}>
        <LoginScreen client={client} />
        <Address />
      </NavigationProvider>
    </LocaleProvider>
  );
}

/** Types the password and submits, which is the whole of the operator's part. */
async function signIn(
  user: ReturnType<typeof userEvent.setup>,
  password = PASSWORD,
): Promise<void> {
  const field = await screen.findByLabelText(copy.passwordLabel);

  await user.clear(field);
  await user.type(field, password);
  await user.click(screen.getByRole("button", { name: copy.submit }));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("REQ-031: the screen that opens a session", () => {
  it("sends the password the operator typed and shows the session is open", async () => {
    const user = userEvent.setup();
    const client = createSessionDouble();

    render(show(client));
    await signIn(user);

    await waitFor(() => {
      expect(client.attempts).toEqual([PASSWORD]);
    });

    const confirmation = await screen.findByRole("status");

    expect(confirmation).toHaveTextContent(copy.signedInTitle);
    expect(confirmation).toHaveTextContent(copy.signedIn);
    // The form is gone, so the same password cannot be sent twice by accident.
    expect(screen.queryByLabelText(copy.passwordLabel)).toBeNull();
  });

  it("starts in the unauthenticated state, with the form and no session", async () => {
    render(show(createSessionDouble()));

    expect(
      await screen.findByLabelText(copy.passwordLabel),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: copy.submit }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: copy.signOut })).toBeNull();
    // The absence of sign-up and of password recovery is stated, so it reads as
    // a decision rather than as a screen someone forgot to finish.
    expect(screen.getByText(copy.note)).toBeInTheDocument();
  });
});

describe("REQ-441: first installation is configured before ordinary login", () => {
  it("keeps the ordinary login form for an already configured instance", async () => {
    const setup = createSetupDouble(true);

    render(
      <LocaleProvider client={localeClient(EN)}>
        <LoginScreen client={createSessionDouble()} setup={setup} />
      </LocaleProvider>,
    );

    expect(
      await screen.findByLabelText(copy.passwordLabel),
    ).toBeInTheDocument();
    expect(screen.queryByText(setupCopy.intro)).toBeNull();
  });

  it("collects a confirmed password and tested external storage, then returns to login", async () => {
    const user = userEvent.setup();
    const setup = createSetupDouble(false);
    const session = createSessionDouble();

    render(
      <LocaleProvider client={localeClient(EN)}>
        <LoginScreen client={session} setup={setup} />
      </LocaleProvider>,
    );

    await screen.findByText(setupCopy.intro);
    expect(screen.getByText(setupCopy.metaNote)).toBeInTheDocument();
    expect(screen.getByText(setupCopy.localNote)).toBeInTheDocument();
    await user.selectOptions(
      screen.getByLabelText(setupCopy.storageLabel),
      "r2",
    );
    await user.type(screen.getByLabelText(setupCopy.passwordLabel), PASSWORD);
    await user.type(
      screen.getByLabelText(setupCopy.confirmationLabel),
      PASSWORD,
    );
    await user.type(
      screen.getByLabelText(setupCopy.endpointLabel),
      "https://r2.example.test",
    );
    await user.type(
      screen.getByLabelText(setupCopy.accessKeyLabel),
      "access-key",
    );
    await user.type(
      screen.getByLabelText(setupCopy.secretKeyLabel),
      "secret-key",
    );
    await user.type(screen.getByLabelText(setupCopy.bucketLabel), "assets");
    await user.click(screen.getByRole("button", { name: setupCopy.submit }));

    await waitFor(() => {
      expect(setup.requests).toEqual([
        {
          password: PASSWORD,
          passwordConfirmation: PASSWORD,
          locale: "en",
          timeZone: "UTC",
          storage: {
            driver: "r2",
            endpoint: "https://r2.example.test",
            accessKeyId: "access-key",
            secretAccessKey: "secret-key",
            bucket: "assets",
          },
        },
      ]);
    });
    expect(
      await screen.findByLabelText(copy.passwordLabel),
    ).toBeInTheDocument();
    expect(screen.queryByText(setupCopy.intro)).toBeNull();
  });

  it("shows ordinary login immediately in the language chosen during setup", async () => {
    const user = userEvent.setup();
    const setup = createSetupDouble(false);

    render(
      <LocaleProvider client={localeClient(EN)}>
        <LoginScreen client={createSessionDouble()} setup={setup} />
      </LocaleProvider>,
    );

    await screen.findByText(setupCopy.intro);
    await user.selectOptions(screen.getByLabelText(setupCopy.localeLabel), PT);
    await user.type(screen.getByLabelText(setupCopy.passwordLabel), PASSWORD);
    await user.type(
      screen.getByLabelText(setupCopy.confirmationLabel),
      PASSWORD,
    );
    await user.click(screen.getByRole("button", { name: setupCopy.submit }));

    expect(
      await screen.findByLabelText(pt.screens.login.passwordLabel),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText(copy.passwordLabel)).toBeNull();
  });

  it("names and marks a password that is too short before sending setup", async () => {
    const user = userEvent.setup();
    const setup = createSetupDouble(false);

    render(
      <LocaleProvider client={localeClient(EN)}>
        <LoginScreen client={createSessionDouble()} setup={setup} />
      </LocaleProvider>,
    );

    await screen.findByText(setupCopy.intro);
    const password = screen.getByLabelText(setupCopy.passwordLabel);
    await user.type(password, "123456");
    await user.type(
      screen.getByLabelText(setupCopy.confirmationLabel),
      "123456",
    );
    await user.click(screen.getByRole("button", { name: setupCopy.submit }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      setupCopy.passwordTooShort,
    );
    expect(password).toHaveAttribute("aria-invalid", "true");
    expect(setup.requests).toEqual([]);
  });

  it("names and marks the confirmation when the passwords do not match", async () => {
    const user = userEvent.setup();
    const setup = createSetupDouble(false);

    render(
      <LocaleProvider client={localeClient(EN)}>
        <LoginScreen client={createSessionDouble()} setup={setup} />
      </LocaleProvider>,
    );

    await screen.findByText(setupCopy.intro);
    await user.type(screen.getByLabelText(setupCopy.passwordLabel), PASSWORD);
    const confirmation = screen.getByLabelText(setupCopy.confirmationLabel);
    await user.type(confirmation, "a-different-password");
    await user.click(screen.getByRole("button", { name: setupCopy.submit }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      setupCopy.confirmationMismatch,
    );
    expect(confirmation).toHaveAttribute("aria-invalid", "true");
    expect(setup.requests).toEqual([]);
  });
});

describe("REQ-034: a wrong password and a blocked origin are two answers", () => {
  it("says the password was refused, and never that the origin is blocked", async () => {
    const user = userEvent.setup();
    const client = createSessionDouble();
    client.answer = { ok: false, reason: "invalid_credentials" };

    render(show(client));
    await signIn(user);

    const alert = await screen.findByRole("alert");

    expect(alert).toHaveTextContent(copy.wrongPasswordTitle);
    expect(alert).toHaveTextContent(copy.wrongPassword);
    expect(alert).not.toHaveTextContent(copy.blockedTitle);
  });

  it("says the attempts were refused before the check, and how long to wait", async () => {
    const user = userEvent.setup();

    const wrong = createSessionDouble();
    wrong.answer = { ok: false, reason: "invalid_credentials" };

    const refused = render(show(wrong));
    await signIn(user);
    const wrongText = (await screen.findByRole("alert")).textContent;

    refused.unmount();

    const blocked = createSessionDouble();
    blocked.answer = {
      ok: false,
      reason: "too_many_attempts",
      retryAfterSeconds: 45,
    };

    render(show(blocked));
    await signIn(user);

    const blockedAlert = await screen.findByRole("alert");

    // The two facts an operator needs and a folded message destroys: this is
    // NOT the wrong-password sentence, and it carries the wait from
    // `retry-after`. Treating the 429 as a 401 fails right here.
    expect(blockedAlert.textContent).not.toBe(wrongText);
    expect(blockedAlert).toHaveTextContent(text(copy.blocked, { seconds: 45 }));
    expect(blockedAlert).not.toHaveTextContent(copy.wrongPassword);
  });

  it("tells the operator to wait without inventing a length", async () => {
    const user = userEvent.setup();
    const client = createSessionDouble();
    client.answer = { ok: false, reason: "too_many_attempts" };

    render(show(client));
    await signIn(user);

    const alert = await screen.findByRole("alert");

    expect(alert).toHaveTextContent(copy.blockedUnknown);
    // No number at all: a wait this screen made up would be worse than none.
    expect(alert.textContent).not.toMatch(/\d/);
  });

  it("reports an instance that did not answer as its own case", async () => {
    const user = userEvent.setup();
    const client = createSessionDouble();
    client.answer = { ok: false, reason: "unreachable" };

    render(show(client));
    await signIn(user);

    const alert = await screen.findByRole("alert");

    expect(alert).toHaveTextContent(copy.unreachableTitle);
    expect(alert).toHaveTextContent(copy.unreachable);
  });
});

describe("REQ-104: ending the session", () => {
  it("ends it and returns the screen to the unauthenticated state", async () => {
    const user = userEvent.setup();
    const client = createSessionDouble();

    render(show(client));
    await signIn(user);

    await user.click(await screen.findByRole("button", { name: copy.signOut }));

    expect(
      await screen.findByLabelText(copy.passwordLabel),
    ).toBeInTheDocument();
    expect(client.closes).toBe(1);
  });

  it("keeps the session on screen when the instance did not confirm", async () => {
    const user = userEvent.setup();
    const client = createSessionDouble();
    client.ended = false;

    render(show(client));
    await signIn(user);
    await user.click(await screen.findByRole("button", { name: copy.signOut }));

    const alert = await screen.findByRole("alert");

    expect(alert).toHaveTextContent(copy.signOutFailedTitle);
    expect(alert).toHaveTextContent(copy.signOutFailed);
    // Still signed in, because only the instance can revoke: a screen that
    // cleared itself would show a closed panel over an open session.
    expect(
      screen.getByRole("button", { name: copy.signOut }),
    ).toBeInTheDocument();
  });
});

describe("REQ-115: the four outcomes are four different blocks", () => {
  /**
   * The one shape every notice of this system carries, so a nature can be read
   * back off the DOM. `Notice` is the component under `components/Notice.tsx`
   * and `mc-notice--<nature>` is the class it writes; the query is by ROLE, and
   * only the nature (which has no accessible counterpart, because it is
   * conveyed by the glyph and the title beside it) is read from the class.
   */
  function natureOf(element: HTMLElement): string {
    const found = [...element.classList].find((name) =>
      name.startsWith("mc-notice--"),
    );

    return found ?? "";
  }

  /** Signs in against one answer and reports what the screen announced. */
  async function announce(
    answer: SessionOutcome,
  ): Promise<{ nature: string; text: string }> {
    const user = userEvent.setup();
    const client = createSessionDouble();
    client.answer = answer;

    const mounted = render(show(client));
    await signIn(user);

    const alert = await screen.findByRole("alert");
    const reported = { nature: natureOf(alert), text: alert.textContent ?? "" };

    mounted.unmount();
    return reported;
  }

  it("gives each refusal its own nature, title and sentence", async () => {
    const wrong = await announce({
      ok: false,
      reason: "invalid_credentials",
    });
    const blocked = await announce({
      ok: false,
      reason: "too_many_attempts",
      retryAfterSeconds: 45,
    });
    const unreachable = await announce({ ok: false, reason: "unreachable" });

    // The whole defect this task closes: three answers that used to render as
    // three identical paragraphs. Nothing about them may coincide.
    const texts = [wrong.text, blocked.text, unreachable.text];
    expect(new Set(texts).size).toBe(texts.length);

    // A refused password is recoverable now; a blocked origin has to wait and
    // is nobody's typing mistake, so it does not wear the refusal's colour.
    expect(wrong.nature).toBe("mc-notice--error");
    expect(blocked.nature).toBe("mc-notice--warning");
    expect(blocked.nature).not.toBe(wrong.nature);
    expect(unreachable.nature).toBe("mc-notice--error");
    // Same nature as the refused password, so the title is what has to part
    // them, and the instance being silent is not the operator's fault.
    expect(unreachable.text).not.toContain(copy.wrongPasswordTitle);
  });

  it("announces an open session as a confirmation and not as a fault", async () => {
    const user = userEvent.setup();

    render(show(createSessionDouble()));
    await signIn(user);

    // A status and not an alert: the fourth outcome of this screen is the one
    // that went right, and it must not arrive with the weight of a refusal.
    const confirmation = await screen.findByRole("status");

    expect(natureOf(confirmation)).toBe("mc-notice--success");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows the sign-in button working, without losing its word", async () => {
    const user = userEvent.setup();
    const client = createSessionDouble();
    let release = (): void => {};
    client.open = (): Promise<SessionOutcome> =>
      new Promise((resolve) => {
        release = (): void => resolve({ ok: true });
      });

    render(show(client));
    await signIn(user);

    // The loading state of this screen. The button is out of reach while the
    // attempt is in flight and still says what it is doing, which is what a
    // spinner with no word cannot do.
    const pending = await screen.findByRole("button", {
      name: copy.submitting,
    });
    expect(pending).toBeDisabled();

    release();
    await screen.findByRole("status");
  });
});

describe("REQ-146: entering leads to the panel", () => {
  it("goes to the panel once the session is open", async () => {
    const user = userEvent.setup();
    const client = createSessionDouble();

    render(inApp(client));
    await signIn(user);

    // The dead end this closes: the correct password used to leave the operator
    // on the access screen, reading that the session was open beside a button
    // that closed it again. The panel is where entering leads.
    await waitFor(() => {
      expect(screen.getByTestId(ADDRESS)).toHaveTextContent(DASHBOARD_ADDRESS);
    });

    // The address bar followed, so the operator can reload, bookmark and share
    // where they are: the screen changed inside the page, it was not swapped
    // behind an address that still says `/login`.
    expect(window.location.pathname).toBe(DASHBOARD_ADDRESS);
  });

  it("goes nowhere while the password is refused", async () => {
    const user = userEvent.setup();
    const client = createSessionDouble();
    client.answer = { ok: false, reason: "invalid_credentials" };

    render(inApp(client));
    await signIn(user);

    await screen.findByRole("alert");

    // A refusal is not a session: navigating here would take an operator who
    // holds nothing to a screen every private route refuses to answer.
    expect(screen.getByTestId(ADDRESS)).toHaveTextContent(LOGIN_ADDRESS);
  });

  it("goes nowhere before the operator has sent anything", async () => {
    render(inApp(createSessionDouble()));

    expect(
      await screen.findByLabelText(copy.passwordLabel),
    ).toBeInTheDocument();
    expect(screen.getByTestId(ADDRESS)).toHaveTextContent(LOGIN_ADDRESS);
  });
});

describe("REQ-159: this screen is where the interface sends a revoked session", () => {
  it("registers the address the rail returns to, and keeps it public", () => {
    // The rail ends the session and goes to `LOGIN_ADDRESS`
    // (`src/web/shell.tsx`). An address the table does not claim would render
    // nothing at all, and an operator who has just signed out would be looking
    // at an empty page; a private one would refuse the very operator it was
    // meant to receive.
    const access = registeredRoutes.find(
      (route) => route.path === LOGIN_ADDRESS,
    );

    expect(access).toBeDefined();
    expect(access?.public).toBe(true);
  });

  it("keeps the panel that proves the revocation, for the screen's own path", async () => {
    const user = userEvent.setup();
    const client = createSessionDouble();

    // Mounted outside the application's navigation, which is the only place
    // this state survives a sign-in: inside it, entering leads to the panel
    // (REQ-146). It is kept because it is the one test in the interface that
    // drives a password typed all the way to a session ended, and REQ-159 adds
    // a second way out rather than replacing this proof.
    render(show(client));
    await signIn(user);
    await user.click(await screen.findByRole("button", { name: copy.signOut }));

    await waitFor(() => {
      expect(client.closes).toBe(1);
    });
  });
});

describe("REQ-074: the first screen is in the instance's language", () => {
  it("renders the access screen in the configured language", async () => {
    // The defect this task closes, from the interface side: the screen an
    // operator meets BEFORE any session has to be in the instance's language,
    // which is why reading `/api/locale` is public (`src/http/access.ts`, and
    // `src/http/public-reads.test.ts` for the route itself).
    render(show(createSessionDouble(), PT));

    expect(
      await screen.findByRole("heading", { name: "Acesso do operador" }),
    ).toBeInTheDocument();
    expect(
      await screen.findByLabelText("Senha do operador"),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Entrar" })).toBeInTheDocument();
  });
});

describe("the client that talks to /api/session", () => {
  function stubFetch(
    status: number,
    headers: Record<string, string> = {},
  ): ReturnType<typeof vi.fn> {
    const stub = vi.fn(() =>
      Promise.resolve({
        ok: status >= 200 && status < 300,
        status,
        headers: { get: (name: string) => headers[name] ?? null },
      } as unknown as Response),
    );

    vi.stubGlobal("fetch", stub);
    return stub;
  }

  it("sends the password over the declared contract", async () => {
    const stub = stubFetch(200);

    expect(await httpSessionClient.open(PASSWORD)).toEqual({ ok: true });
    expect(stub).toHaveBeenCalledWith(SESSION_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: PASSWORD }),
    });
  });

  it("maps 401 onto the refused password", async () => {
    stubFetch(401);

    expect(await httpSessionClient.open(PASSWORD)).toEqual({
      ok: false,
      reason: "invalid_credentials",
    });
  });

  it("maps 429 onto the ceiling, carrying retry-after", async () => {
    stubFetch(429, { "retry-after": "45" });

    // The status is what separates them, and the header is the only place the
    // wait exists: this is the mapping the screen's two messages depend on.
    expect(await httpSessionClient.open(PASSWORD)).toEqual({
      ok: false,
      reason: "too_many_attempts",
      retryAfterSeconds: 45,
    });
  });

  it("still reports the ceiling when no retry-after arrives", async () => {
    stubFetch(429);

    expect(await httpSessionClient.open(PASSWORD)).toEqual({
      ok: false,
      reason: "too_many_attempts",
    });
  });

  it("reads a header that says nothing usable as no wait at all", () => {
    expect(retryAfterOf("45")).toBe(45);
    expect(retryAfterOf("0.4")).toBe(1);
    expect(retryAfterOf(null)).toBeUndefined();
    expect(retryAfterOf("")).toBeUndefined();
    expect(retryAfterOf("soon")).toBeUndefined();
    expect(retryAfterOf("-3")).toBeUndefined();
  });

  it("reports a request that never got an answer", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("offline"))),
    );

    expect(await httpSessionClient.open(PASSWORD)).toEqual({
      ok: false,
      reason: "unreachable",
    });
    expect(await httpSessionClient.close()).toBe(false);
  });

  it("ends the session over the route that revokes it", async () => {
    const stub = stubFetch(204);

    expect(await httpSessionClient.close()).toBe(true);
    expect(stub).toHaveBeenCalledWith(SESSION_ENDPOINT, { method: "DELETE" });
  });
});
