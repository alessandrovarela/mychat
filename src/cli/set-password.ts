import { setOperatorPassword, MINIMUM_PASSWORD_LENGTH } from "../auth/index.js";
import type { OperatorCredentialStore } from "../auth/index.js";
import { t } from "../i18n/index.js";

/**
 * The command that gives the instance its operator password (REQ-101).
 *
 * It is the ONLY way one gets set. There is no environment variable, no
 * configuration field and no seed: REQ-033 forbids a plain-text password in the
 * configuration, and leaving a second path open would make that refusal
 * decorative.
 */

export interface SecretReader {
  /**
   * Reads one secret. `prompt` is already resolved text, and the contract that
   * matters is what does NOT happen: nothing the operator types is echoed.
   */
  read(prompt: string): Promise<string>;
}

export interface SetPasswordDeps {
  readonly credentials: OperatorCredentialStore;
  readonly secrets: SecretReader;
  readonly now: () => Date;
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
}

/**
 * Prompts, confirms, and stores only the derivation. Returns the exit code.
 *
 * The confirmation is not ceremony. Nothing is echoed, so a typo is invisible
 * by construction, and the operator would discover it at the login screen of an
 * instance they can no longer get into. Asking twice is what turns that into a
 * message instead of a lockout.
 *
 * The password is a local binding here and nowhere else: it is not returned,
 * not interpolated into any message, and not handed to `out` or `err`, which is
 * how the whole command produces no trace of it (acceptance criterion 4).
 */
export async function runSetPassword(deps: SetPasswordDeps): Promise<number> {
  const password = await deps.secrets.read(t("auth.passwordPrompt"));
  const confirmation = await deps.secrets.read(t("auth.passwordConfirm"));

  if (password !== confirmation) {
    deps.err(t("auth.passwordMismatch"));
    return 1;
  }

  const outcome = await setOperatorPassword(
    password,
    deps.credentials,
    deps.now(),
  );

  if (!outcome.ok) {
    deps.err(t("auth.passwordTooShort", { minimum: MINIMUM_PASSWORD_LENGTH }));
    return 1;
  }

  deps.out(t(outcome.replaced ? "auth.passwordReplaced" : "auth.passwordSet"));
  return 0;
}
