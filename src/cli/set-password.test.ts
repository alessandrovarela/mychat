import { PassThrough, Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createOperatorCredentialStore,
  verifyOperatorPassword,
} from "../auth/index.js";
import type { OperatorCredentialStore } from "../auth/index.js";
import { IN_MEMORY_DATABASE, openDatabase } from "../storage/database.js";
import type { DatabaseHandle } from "../storage/database.js";
import { operatorCredential } from "../storage/schema.js";
import { runSetPassword } from "./set-password.js";
import type { SecretReader } from "./set-password.js";
import { createTerminalSecretReader } from "./terminal-secret.js";

/**
 * Proves REQ-101: a command sets the operator's password, reads it without
 * showing it, stores only the hash, and a second run replaces what the first
 * one wrote, in the same process.
 *
 * The password is entered through an injected port, so every case here runs
 * with no terminal. The one binding that does know about terminals gets its own
 * case at the bottom, and it is the one that proves nothing is echoed.
 */

const PASSWORD = "Zq7-Vamp!Krux9";
const OTHER_PASSWORD = "Bx4=Fjord?Wisp2";
const NOW = new Date("2026-08-02T09:00:00.000Z");

let handle: DatabaseHandle;
let credentials: OperatorCredentialStore;
/** Everything the command wrote anywhere an operator could read it. */
let transcript: string[];

beforeEach(() => {
  handle = openDatabase({ databasePath: IN_MEMORY_DATABASE });
  credentials = createOperatorCredentialStore(handle.db);
  transcript = [];
});

afterEach(() => {
  handle.close();
});

/** A reader that answers with a script, in order, and records what it was asked. */
function scripted(...answers: readonly string[]): SecretReader {
  const queue = [...answers];

  return {
    read(prompt: string): Promise<string> {
      // The prompt is operator-visible output too, so it belongs in the
      // transcript: a prompt that echoed back what was already typed would leak
      // exactly as badly as a confirmation line would.
      transcript.push(prompt);
      const answer = queue.shift();
      expect(
        answer,
        "the command asked more times than expected",
      ).toBeDefined();
      return Promise.resolve(answer ?? "");
    },
  };
}

function run(...answers: readonly string[]): Promise<number> {
  return runSetPassword({
    credentials,
    secrets: scripted(...answers),
    now: () => NOW,
    out: (line) => transcript.push(line),
    err: (line) => transcript.push(line),
  });
}

/**
 * Every fragment of `secret` from four characters up.
 *
 * Acceptance criterion 4 says no FRAGMENT of the password may appear, not that
 * the whole string may not: a mask that printed all but the last character
 * would sail past a check for the complete value while handing an onlooker
 * almost everything.
 */
function fragmentsOf(secret: string, minimum = 4): string[] {
  const fragments: string[] = [];

  for (let start = 0; start + minimum <= secret.length; start += 1) {
    for (let end = start + minimum; end <= secret.length; end += 1) {
      fragments.push(secret.slice(start, end));
    }
  }

  return fragments;
}

function expectNoTraceOf(secret: string, text: string): void {
  const leaked = fragmentsOf(secret).filter((fragment) =>
    text.includes(fragment),
  );

  expect(
    leaked,
    "the password reached output that an operator can read",
  ).toEqual([]);
}

describe("REQ-101: setting the operator password from the command line", () => {
  it("stores the credential and reports it", async () => {
    await expect(run(PASSWORD, PASSWORD)).resolves.toBe(0);

    await expect(verifyOperatorPassword(PASSWORD, credentials)).resolves.toBe(
      true,
    );
  });

  it("shows no fragment of the password, and stores none either", async () => {
    await run(PASSWORD, PASSWORD);

    // Acceptance criterion 4, both halves: what the terminal saw, and what the
    // database kept.
    expectNoTraceOf(PASSWORD, transcript.join("\n"));
    expectNoTraceOf(
      PASSWORD,
      JSON.stringify(handle.db.select().from(operatorCredential).all()),
    );
  });

  it("asks twice and changes nothing when the two entries differ", async () => {
    await expect(run(PASSWORD, OTHER_PASSWORD)).resolves.toBe(1);

    // Nothing was written, so neither entry authenticates: a mistyped
    // confirmation must not leave the operator guessing which one took.
    await expect(verifyOperatorPassword(PASSWORD, credentials)).resolves.toBe(
      false,
    );
    await expect(
      verifyOperatorPassword(OTHER_PASSWORD, credentials),
    ).resolves.toBe(false);
  });

  it("refuses a password under the minimum and keeps the one in force", async () => {
    await run(PASSWORD, PASSWORD);

    await expect(run("short", "short")).resolves.toBe(1);

    await expect(verifyOperatorPassword(PASSWORD, credentials)).resolves.toBe(
      true,
    );
  });

  /**
   * Acceptance criterion 5. Nothing between the two runs restarts anything: the
   * same store, the same open database and the same process throughout, which
   * is precisely the claim being made.
   */
  it("replaces the credential in force without restarting", async () => {
    await run(PASSWORD, PASSWORD);
    await expect(verifyOperatorPassword(PASSWORD, credentials)).resolves.toBe(
      true,
    );

    await expect(run(OTHER_PASSWORD, OTHER_PASSWORD)).resolves.toBe(0);

    await expect(verifyOperatorPassword(PASSWORD, credentials)).resolves.toBe(
      false,
    );
    await expect(
      verifyOperatorPassword(OTHER_PASSWORD, credentials),
    ).resolves.toBe(true);
  });
});

/**
 * The binding that touches a keyboard, and the only case here that can prove
 * criterion 4's first clause: the port above can promise that nothing is
 * echoed, but only this implementation can be caught doing it.
 */
describe("reading a secret from a terminal", () => {
  /** Collects everything written to what the operator would be looking at. */
  function screen(): { stream: Writable; text: () => string } {
    const chunks: string[] = [];

    return {
      stream: new Writable({
        write(chunk: Buffer | string, _encoding, done) {
          chunks.push(chunk.toString());
          done();
        },
      }),
      text: () => chunks.join(""),
    };
  }

  it("returns what was typed while echoing none of it", async () => {
    const keyboard = new PassThrough();
    const display = screen();
    const reader = createTerminalSecretReader(keyboard, display.stream);

    const typed = reader.read("password: ");
    keyboard.write(`${PASSWORD}\n`);

    await expect(typed).resolves.toBe(PASSWORD);
    reader.close();

    expect(display.text()).toContain("password: ");
    expectNoTraceOf(PASSWORD, display.text());
  });

  it("reads twice from the same input without losing what is buffered", async () => {
    const keyboard = new PassThrough();
    const display = screen();
    const reader = createTerminalSecretReader(keyboard, display.stream);

    // Both lines arrive in one chunk, which is what a paste or a piped input
    // looks like. A reader that opened a fresh interface per call would drop
    // the second line with the first interface it closed.
    const first = reader.read("password: ");
    keyboard.write(`${PASSWORD}\n${OTHER_PASSWORD}\n`);
    await expect(first).resolves.toBe(PASSWORD);

    await expect(reader.read("again: ")).resolves.toBe(OTHER_PASSWORD);
    reader.close();

    expectNoTraceOf(PASSWORD, display.text());
    expectNoTraceOf(OTHER_PASSWORD, display.text());
  });
});
