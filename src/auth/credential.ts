import { hash, verify } from "@node-rs/argon2";
import type { Options } from "@node-rs/argon2";
import { eq } from "drizzle-orm";
import type { MyChatDatabase } from "../storage/database.js";
import { operatorCredential } from "../storage/schema.js";
import type { OperatorCredentialRow } from "../storage/schema.js";

/**
 * The operator's password (REQ-033, REQ-101).
 *
 * One rule governs this whole file: the password exists as an argument and
 * nowhere else. It is never returned, never stored, never put into a message
 * and never given to a logger. What leaves here is a derivation, and the only
 * question anyone can ask afterwards is whether a candidate produces the same
 * one.
 */

/** The single row. One instance, one operator, one credential. */
export const OPERATOR_CREDENTIAL_ID = "operator";

/**
 * Written into `algorithm` beside every hash this module produces.
 *
 * A hash is unverifiable without knowing what made it, and the day these
 * parameters change the rows already written must stay verifiable. This name is
 * what lets `verifyOperatorPassword` pick a function instead of inferring one
 * from the string's shape.
 */
export const PASSWORD_ALGORITHM = "argon2id";

/**
 * Argon2id at the parameters OWASP recommends for password storage: 19 MiB of
 * memory, two passes, one lane.
 *
 * Stated explicitly rather than left to the library's defaults, which is the
 * point: a default is a value someone else may change in a minor release, and a
 * silent weakening of the only thing standing between a stolen database and the
 * operator's account is exactly the change nobody would notice. Argon2id is the
 * hybrid, so it resists GPU cracking and side channels rather than one of the
 * two (REQ-033 asks for brute-force resistance, and a fast hash is not that).
 *
 * Measured at roughly 13 ms per derivation on the author's machine, which is
 * negligible for a login and ruinous for an attacker enumerating candidates.
 */
const HASH_OPTIONS: Options = {
  // `Algorithm.Argon2id`, written as its value: the package declares that enum
  // as an ambient `const enum`, which `verbatimModuleSyntax` refuses to import.
  // The number is not taken on trust anywhere: the test asserts the `$argon2id$`
  // prefix of what actually gets stored, so a wrong one here fails loudly
  // instead of quietly selecting argon2d.
  algorithm: 2,
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
};

/**
 * Shortest password accepted.
 *
 * The derivation function is only half of brute-force resistance: it fixes the
 * cost of one guess, and the length fixes how many guesses there are. Eight is
 * a floor against the accident this command makes possible, an empty or
 * near-empty entry typed blind because nothing is echoed back, not a claim
 * about what a good password is.
 */
export const MINIMUM_PASSWORD_LENGTH = 8;

export interface StoredOperatorCredential {
  /** The derivation, carrying its own salt and parameters as encoded. */
  readonly passwordHash: string;
  /** Which derivation produced it, so verifying never guesses. */
  readonly algorithm: string;
  readonly updatedAt: Date;
}

export interface OperatorCredentialStore {
  /** Undefined until the password has been set for the first time. */
  read(): Promise<StoredOperatorCredential | undefined>;
  /** Sets or replaces the credential. There is only ever one row. */
  write(passwordHash: string, algorithm: string, now: Date): Promise<void>;
}

function toStored(row: OperatorCredentialRow): StoredOperatorCredential {
  return {
    passwordHash: row.passwordHash,
    algorithm: row.algorithm,
    updatedAt: row.updatedAt,
  };
}

export function createOperatorCredentialStore(
  db: MyChatDatabase,
): OperatorCredentialStore {
  const where = eq(operatorCredential.id, OPERATOR_CREDENTIAL_ID);

  return {
    read(): Promise<StoredOperatorCredential | undefined> {
      const [row] = db.select().from(operatorCredential).where(where).all();
      return Promise.resolve(row === undefined ? undefined : toStored(row));
    },

    write(passwordHash: string, algorithm: string, now: Date): Promise<void> {
      db.insert(operatorCredential)
        .values({
          id: OPERATOR_CREDENTIAL_ID,
          passwordHash,
          algorithm,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: operatorCredential.id,
          set: { passwordHash, algorithm, updatedAt: now },
        })
        .run();

      return Promise.resolve();
    },
  };
}

/**
 * Derives the stored form of a password. The argument does not survive the
 * call: what comes back carries a random salt and the parameters used, and
 * nothing that can be turned back into the password.
 */
export function hashPassword(password: string): Promise<string> {
  return hash(password, HASH_OPTIONS);
}

export type SetPasswordOutcome =
  | {
      readonly ok: true;
      /** True when a credential was already in force and has just been replaced. */
      readonly replaced: boolean;
    }
  | { readonly ok: false; readonly reason: "too_short" };

/**
 * Sets or replaces the operator's password (REQ-101).
 *
 * A refusal writes nothing, which is what makes "nothing was changed" a fact
 * rather than a message: the credential in force keeps authenticating, and an
 * operator who mistyped is not locked out by their own typo.
 */
export async function setOperatorPassword(
  password: string,
  store: OperatorCredentialStore,
  now: Date,
): Promise<SetPasswordOutcome> {
  if (password.length < MINIMUM_PASSWORD_LENGTH) {
    return { ok: false, reason: "too_short" };
  }

  const existing = await store.read();
  await store.write(await hashPassword(password), PASSWORD_ALGORITHM, now);

  return { ok: true, replaced: existing !== undefined };
}

/**
 * Whether `candidate` is the operator's password in force (REQ-033). This is
 * what a session check calls.
 *
 * The store is read on EVERY call, deliberately, and that is what REQ-101's
 * last clause means by "without restarting the process": a hash cached at
 * start-up would keep authenticating the old password until someone restarted,
 * so replacing a credential would not actually revoke anything. Reading here
 * costs one indexed lookup on a single-row table, next to a derivation that
 * costs milliseconds.
 *
 * False when nothing has been set yet: an installation with no password must
 * authenticate nobody, least of all someone who sent an empty one.
 */
export async function verifyOperatorPassword(
  candidate: string,
  store: OperatorCredentialStore,
): Promise<boolean> {
  const stored = await store.read();

  if (stored === undefined) {
    return false;
  }

  if (stored.algorithm !== PASSWORD_ALGORITHM) {
    // The column exists so verification picks a function rather than inferring
    // one. Exactly one is known here, so a row written by anything else cannot
    // be checked, and refusing is the only honest answer available: verifying
    // against a function that did not produce the hash would always say no
    // anyway, while pretending it had asked the right question.
    return false;
  }

  return verify(stored.passwordHash, candidate);
}
