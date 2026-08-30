import { createInterface } from "node:readline";
import type { Interface } from "node:readline";
import { Writable } from "node:stream";
import type { SecretReader } from "./set-password.js";

/**
 * Reading a secret from a terminal with nothing echoed back.
 *
 * Kept apart from the command it serves so the command can be tested with no
 * terminal at all: `set-password.ts` declares the port, this file is the one
 * binding that knows what a keyboard is.
 */

export interface TerminalSecretReader extends SecretReader {
  /**
   * Releases the interface. Not optional politeness: an open readline holds the
   * event loop, so a process that never closes it never exits.
   */
  close(): void;
}

/**
 * A reader that prompts on `output` and echoes nothing.
 *
 * The silence comes from handing readline a sink that discards every byte
 * instead of the real output. readline writes each keystroke back to whatever
 * it was given, so giving it nowhere is what keeps the typed characters off the
 * screen, and the prompt reaches the operator because it is written to the real
 * output directly, before the question is asked.
 *
 * Lines are QUEUED rather than awaited one `question` at a time, which is what
 * makes a second read work when both lines arrived together (a paste, or input
 * piped from a file). readline splits a chunk into every line it contains and
 * announces them all immediately, so a read that started after the announcement
 * would wait forever for a line already delivered.
 */
export function createTerminalSecretReader(
  input: NodeJS.ReadableStream = process.stdin,
  output: NodeJS.WritableStream = process.stdout,
): TerminalSecretReader {
  let session: Interface | undefined;

  /** Lines announced before anyone asked for them. */
  const delivered: string[] = [];
  /** Readers that asked before a line existed, in the order they asked. */
  const waiting: ((line: string) => void)[] = [];

  function open(): Interface {
    if (session !== undefined) {
      return session;
    }

    session = createInterface({
      input,
      output: new Writable({
        write(_chunk, _encoding, done) {
          done();
        },
      }),
      terminal: true,
    });

    session.on("line", (line: string) => {
      const reader = waiting.shift();
      if (reader === undefined) {
        delivered.push(line);
      } else {
        reader(line);
      }
    });

    // End of input with a read outstanding: answer with nothing rather than
    // hang. An empty entry is refused downstream by the minimum length, which
    // is the honest outcome for an operator who supplied nothing.
    session.on("close", () => {
      while (waiting.length > 0) {
        waiting.shift()?.("");
      }
    });

    return session;
  }

  return {
    async read(prompt: string): Promise<string> {
      output.write(prompt);
      open();

      try {
        const buffered = delivered.shift();

        return (
          buffered ??
          (await new Promise<string>((resolve) => {
            waiting.push(resolve);
          }))
        );
      } finally {
        // The newline the echo would have produced. Without it the next prompt
        // continues the current line.
        output.write("\n");
      }
    },

    close(): void {
      session?.close();
      session = undefined;
    },
  };
}
