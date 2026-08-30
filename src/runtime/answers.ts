import { EMAIL_ATTRIBUTE } from "../engine/ports.js";
import type { AttributeValue, AwaitedAnswer } from "../engine/ports.js";

/**
 * Reading a contact's answer against what the wait asked for (REQ-022,
 * REQ-250).
 *
 * This is the half of the conditional resume that has an opinion. `suspension.ts`
 * owns the record and the order the wait keeps with trigger matching; this owns
 * the single question "does this answer end the wait, and what did it
 * produce". Kept apart because the two
 * change for different reasons: a new step kind adds a case here, while the
 * durable record and the routing stay exactly as they are.
 *
 * The wait carries WHAT it expects and not only that it expects something, so
 * the answer of a confirmation is judged against the very words that went out
 * on its button. Holding the label anywhere else would allow a record declaring
 * a button and carrying no words to compare against, which is a wait nothing
 * could satisfy and nobody reviewing it would see.
 */

/**
 * The attribute a collected address is written to (REQ-022, REQ-024).
 *
 * Declared with the engine's ports and re-exported here, where the answer
 * reader has always exposed it. The engine reads the SAME key to skip a
 * question it already has the answer to (REQ-024), and two declarations of one
 * key is exactly the split this constant exists to prevent.
 */
export { EMAIL_ATTRIBUTE };

/**
 * Pragmatic, not RFC 5322: one local part, one dotted domain, no spaces.
 *
 * The full grammar accepts quoted strings, comments and bare hostnames, and a
 * validator that accepted `bob@localhost` would hand the operator a list of
 * addresses nothing can deliver to. What matters here is that the rule is
 * binary and that a person who typed their address is not asked twice.
 */
const EMAIL_PATTERN =
  /^[^\s@]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*\.[A-Za-z]{2,}$/;

/** Sentence punctuation and the angle brackets mail clients wrap around one. */
const TRIMMED_EDGES = /^[<([{"'\s]+|[>)\]}"'.,;:!?\s]+$/g;

export function isEmailAddress(candidate: string): boolean {
  return EMAIL_PATTERN.test(candidate);
}

/**
 * The address inside an answer, if there is one.
 *
 * Contacts answer "sure, it is bob@example.com" as often as they answer with
 * the address alone, and treating the first as a mistake would re-ask someone
 * who already answered correctly. The FIRST address wins when a message carries
 * two, which is arbitrary and stated here rather than discovered later: nothing
 * in the message says which of two the person meant, and asking again for a
 * question they answered twice is worse than picking one.
 */
export function emailIn(text: string): string | undefined {
  for (const word of text.split(/\s+/)) {
    const candidate = word.replace(TRIMMED_EDGES, "");
    if (isEmailAddress(candidate)) {
      return candidate;
    }
  }

  return undefined;
}

/**
 * Combining marks, which is what an accent becomes once the text is taken
 * apart (REQ-248).
 */
const COMBINING_MARKS = /\p{M}/gu;

/**
 * One button's words, reduced to what two spellings of them have in common
 * (REQ-248).
 *
 * Three things are folded, and each one is a way the same answer really
 * arrives: the CASE, because a phone capitalises the first letter of a sentence
 * on its own; the BLANKS at the edges, because a tap carries none and typing
 * carries one as often as not; and the ACCENTS, because "já segui" is typed
 * "ja segui" by anybody in a hurry, and refusing that would leave the person
 * staring at a button they answered correctly.
 *
 * NFD and not the NFC of `matching.ts`, and the difference is the point rather
 * than a preference. Both forms exist because an accented letter can be one
 * code point or a letter followed by a combining mark, and they are
 * INDISTINGUISHABLE on screen. Composing (NFC) makes the two spellings equal
 * while keeping the accent, which is what keyword matching wants: in Portuguese
 * accents separate real words, and folding them there would make "e" match "é".
 * Here the accent has to GO, and it can only go once the letter has been taken
 * apart: in NFC "já" is a single character with nothing to remove, while in NFD
 * it is "j", "a" and a mark that can be dropped. So the text is decomposed
 * first, the marks are dropped, and what is left is the plain letters.
 *
 * Deliberately NOT reused for keyword matching, which keeps its own rule for
 * the reason above. What justifies folding accents here is that the answer is
 * ONE known phrase the operator chose, so there is no other word it could be
 * confused with.
 */
function foldedForComparison(value: string): string {
  return value
    .normalize("NFD")
    .replace(COMBINING_MARKS, "")
    .trim()
    .toLowerCase();
}

/**
 * Whether what the contact sent is the text of this button (REQ-248, REQ-250).
 *
 * Exported because two steps need the SAME reading of one answer: the
 * confirmation, whose button is a yes, and the request to follow, whose button
 * asks for the platform to be consulted again (REQ-245). Two copies of this
 * comparison would be two definitions of what counts as tapping a button.
 *
 * An empty label matches NOTHING, the empty message included. A wait declaring
 * a button with no words is one no contact could ever satisfy, and reading it
 * as "anything at all" would quietly restore the loosest rule there is, which
 * is what REQ-250 exists to remove.
 */
export function isButtonAnswer(label: string, text: string): boolean {
  const expected = foldedForComparison(label);
  return expected !== "" && foldedForComparison(text) === expected;
}

/** What an accepted answer leaves behind on the contact, when it leaves one. */
export interface AnswerAttribute {
  readonly key: string;
  readonly value: AttributeValue;
}

/**
 * The verdict on one answer. `rejected` is not a failure: the contact wrote
 * something, it simply was not what the step is waiting for, and the run stays
 * where it was.
 */
export type AnswerVerdict =
  | { readonly kind: "accepted"; readonly attribute?: AnswerAttribute }
  | { readonly kind: "rejected" };

export function readAnswer(
  expects: AwaitedAnswer,
  text: string,
): AnswerVerdict {
  if (expects === "follow") {
    // REQ-100. No text a contact can type makes them a follower, so this wait
    // is ended by the QUERY and never by an answer. `routeInbound` already
    // branches before reaching here, and this guard exists for the caller that
    // does not: falling through to the catch-all below would open the follow
    // gate on a typed message, which is the one mistake REQ-027 cannot afford,
    // because a resource handed over cannot be taken back.
    //
    // The button REQ-245 added to that step makes this guard MORE necessary and
    // not less. The words on it are a request to consult the platform again,
    // never a key: a step declaring them as the answer it accepts would hand
    // the resource to whoever reads the button and types it back.
    return { kind: "rejected" };
  }

  if (expects === "email") {
    const address = emailIn(text);
    return address === undefined
      ? { kind: "rejected" }
      : {
          kind: "accepted",
          attribute: { key: EMAIL_ATTRIBUTE, value: address },
        };
  }

  if (typeof expects === "object") {
    // REQ-250. Only what the button says is a yes. Every other message is
    // refused, and that refusal is the whole reason a deadline of a week is
    // safe: while any answer counted, a message about something else, days
    // later, from somebody who never read the question, was stored as consent
    // and the resource went out on it.
    return isButtonAnswer(expects.label, text)
      ? { kind: "accepted" }
      : { kind: "rejected" };
  }

  // `any`: the answer was the point, not its content. A sticker, an empty
  // postback and a typed "ok" all end this wait (REQ-067). Nothing declares it
  // since REQ-250; what still carries it is a record written before the
  // confirmation had a button, and this is the reading those records were
  // created under.
  return { kind: "accepted" };
}
