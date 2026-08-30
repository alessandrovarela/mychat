import { useEffect, useRef, useState } from "react";
import type { ReactElement } from "react";
import { createPortal } from "react-dom";
import { IconButton } from "./IconButton.js";
import { Notice } from "./Notice.js";
import type { NoticeNature } from "./Notice.js";

/**
 * Toast: the answer to a write, anchored to the VIEWPORT and not to the top of
 * a document (REQ-312).
 *
 * The defect it exists for is the one `Notice` documents from the other side: a
 * confirmation born at the top of a form whose button sits at the end is a
 * confirmation nobody sees. That was answered by moving the FOCUS to the
 * sentence, which reaches a screen reader and drags the page to the top of
 * itself for everyone else, leaving the operator's eye and the operator's caret
 * far from the control they just pressed. A message that does not depend on
 * where the page is scrolled needs neither: it appears in the corner, it is
 * announced where it stands, and the page does not move at all.
 *
 * WHAT BECOMES ONE, and it is a rule and not a list: a message that ANSWERS a
 * finished action and asks nothing further. A confirmation of a write, and a
 * general refusal of one. What stays a box in the page is everything that
 * describes a STANDING condition (a listing that will not load, a session that
 * expired, a platform answering degraded), everything carrying an action that
 * has to stay reachable, and every piece of context that was on the page before
 * anybody pressed anything. A standing condition put in a corner and taken away
 * eight seconds later is a fact about the screen that the screen stops showing.
 *
 * WHAT NEVER BECOMES ONE: the refusal of a FIELD. That layer is drawn under the
 * control it belongs to, in `Field`, and it stays until the field is fixed
 * (REQ-310, REQ-311). A person hunting for the field they got wrong cannot be
 * hunting for the sentence that told them at the same time.
 */

/**
 * The floor, and it is a floor because of who reads slowest, not who reads
 * fastest.
 *
 * A screen reader has to reach the live region, queue behind whatever it was
 * already saying, and speak the whole sentence; somebody looking at the other
 * end of the screen has to notice a corner move, look at it and start reading.
 * Eight seconds is what is left of the usual four once both of those are paid.
 */
export const TOAST_FLOOR_MS = 8_000;

/**
 * How much longer a LONGER sentence stays, per character.
 *
 * The duration is derived from the text rather than fixed, because this
 * catalogue writes long sentences on purpose and a fixed duration sized for
 * "Draft saved" cuts them in half. 70ms a character is roughly 170 words a
 * minute, which is unhurried reading and slower than the 200-250 usually
 * quoted, because the reader here did not choose to read this and is starting
 * from wherever their eye already was.
 */
export const TOAST_MS_PER_CHARACTER = 70;

/**
 * The ceiling, which exists so a defect cannot pin a box over the corner of the
 * interface: past this, the message is too long to be a toast and belongs in
 * the page, and the close button is the way out either way.
 */
export const TOAST_CEILING_MS = 30_000;

/** How long a toast of this much text stays, before anybody hovers it. */
export function toastReadingTimeMs(text: string): number {
  return Math.min(
    TOAST_CEILING_MS,
    Math.max(TOAST_FLOOR_MS, text.length * TOAST_MS_PER_CHARACTER),
  );
}

/**
 * The corner every toast is drawn in, made once and kept.
 *
 * Outside React and appended to the body, because the alternative is mounting
 * it in the shell, and a screen rendered on its own (which is how most of them
 * are tested, and how a screen behind a route renders before the shell settles)
 * would then have nowhere to put its answer. Made once and never removed: an
 * empty container costs nothing and a container that comes and goes is a live
 * region that comes and goes.
 */
export const TOAST_VIEWPORT_ID = "mc-toasts";

function viewport(): HTMLElement {
  const found = document.getElementById(TOAST_VIEWPORT_ID);

  if (found !== null) return found;

  const made = document.createElement("div");

  made.id = TOAST_VIEWPORT_ID;
  made.className = "mc-toasts";
  document.body.append(made);

  return made;
}

export interface ToastProps {
  /** `success` for a confirmation, `error` for a refusal. */
  readonly nature?: NoticeNature;
  /** Short line above the sentence. Optional, like the notice's. */
  readonly title?: string;
  /**
   * The sentence, from the catalogue. A STRING and not a node, because the time
   * it stays is measured from it: a duration that cannot see the text is a
   * duration guessed for the shortest one.
   */
  readonly message: string;
  /** The word on the close button, from the catalogue (REQ-074). */
  readonly dismissLabel: string;
  /**
   * Clears the state that put the toast on screen, whether the time ran out or
   * the operator closed it. The caller owns the state, exactly as it did when
   * this was a box in the page, so nothing here has to be told twice.
   *
   * The other half of that ownership is a contract, and it is load bearing:
   * a caller MUST clear the state before starting the next write. The reading
   * time belongs to the ELEMENT, so a second answer that only changes the props
   * of a toast already on screen inherits whatever was left of the first one's
   * clock, and a different sentence can get a second to be read in.
   */
  readonly onDismiss: () => void;
}

export function Toast({
  nature = "success",
  title,
  message,
  dismissLabel,
  onDismiss,
}: ToastProps): ReactElement | null {
  /**
   * Held while the pointer is over the toast or the caret is inside it.
   *
   * A message that runs out from under the person who moved towards it to read
   * it is worse than one that never appeared, and the close button cannot be
   * pressed by anybody the timer beats to it. This is also the whole of what
   * makes the automatic dismissal safe: the way to keep the sentence is to look
   * at it.
   */
  const [held, setHeld] = useState(false);
  const total = toastReadingTimeMs(`${title ?? ""}${message}`);
  /** What is left of the reading time, so a hold pauses rather than restarts. */
  const left = useRef(total);
  const dismiss = useRef(onDismiss);

  useEffect(() => {
    dismiss.current = onDismiss;
  });

  useEffect(() => {
    if (held) return undefined;

    const startedAt = Date.now();
    const timer = setTimeout(() => dismiss.current(), left.current);

    return () => {
      clearTimeout(timer);
      left.current = Math.max(0, left.current - (Date.now() - startedAt));
    };
    // `onDismiss` is deliberately NOT a dependency: it is a new closure on
    // every render of the caller, and depending on it would restart the timer
    // on every keystroke elsewhere on the screen, which is a toast that never
    // leaves. The ref above is what keeps the latest one callable.
  }, [held]);

  return createPortal(
    <div
      className="mc-toast"
      // The live region is THIS element and not the notice inside it, so there
      // is exactly one: `role` plus `aria-live` together, because REQ-312 asks
      // for both and because the role alone leaves the politeness implicit.
      // `polite` and never `assertive`: the answer to a write is not worth
      // cutting across whatever the operator is being told already.
      role="status"
      aria-live="polite"
      onMouseEnter={(): void => setHeld(true)}
      onMouseLeave={(): void => setHeld(false)}
      // `focus`/`blur` bubble in React, so the caret reaching the close button
      // holds the toast open the same way the pointer does.
      onFocus={(): void => setHeld(true)}
      onBlur={(): void => setHeld(false)}
    >
      <Notice
        className="mc-toast__box"
        nature={nature}
        title={title}
        // `none`, because the element above already announces this subtree and
        // a region inside a region is announced twice or not at all.
        role="none"
      >
        {message}
      </Notice>
      <IconButton
        className="mc-toast__close"
        icon="x"
        label={dismissLabel}
        onClick={onDismiss}
      />
    </div>,
    viewport(),
  );
}
