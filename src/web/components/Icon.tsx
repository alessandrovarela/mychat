import type { CSSProperties, ReactElement, SVGProps } from "react";

/**
 * Icon: the single glyph renderer of the system, and the only way a glyph
 * enters the interface.
 *
 * The drawing is inlined rather than fetched, which is a product constraint and
 * not a preference. MyChat ships as a self-hosted image with a standing rule
 * against new dependencies (KEEL), so there is no icon package and no icon
 * font; and a request per glyph would make the interface render half drawn on
 * an instance whose network is slow, for decoration. So an icon is markup the
 * page already holds.
 *
 * Every glyph is a 24x24 stroked outline, stroke width 2, painted in
 * `currentColor`: one visual family, no fills. `currentColor` is why no colour
 * token appears in this file: the glyph takes the colour of the text it sits
 * beside, which is the only way an icon inside a button stays right in both
 * themes and in every variant.
 *
 * The markup below is the inner markup of the 47 files in the design system's
 * `assets/icons/`, carried over verbatim (generated from those files, not
 * retyped).
 */
const GLYPHS = {
  "arrow-left": '<path d="M19 12H5"></path> <path d="m12 19-7-7 7-7"></path>',
  "arrow-right": '<path d="M5 12h14"></path> <path d="m12 5 7 7-7 7"></path>',
  "at-sign":
    '<circle cx="12" cy="12" r="4"></circle> <path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-4 8"></path>',
  braces:
    '<path d="M8 3H7a2 2 0 0 0-2 2v5a2 2 0 0 1-2 2 2 2 0 0 1 2 2v5c0 1.1.9 2 2 2h1"></path> <path d="M16 21h1a2 2 0 0 0 2-2v-5c0-1.1.9-2 2-2a2 2 0 0 1-2-2V5a2 2 0 0 0-2-2h-1"></path>',
  check: '<path d="M20 6 9 17l-5-5"></path>',
  "chevron-down": '<path d="m6 9 6 6 6-6"></path>',
  "chevron-left": '<path d="m15 18-6-6 6-6"></path>',
  "chevron-right": '<path d="m9 18 6-6-6-6"></path>',
  // The only glyph in this file the design system's `assets/icons/` does not
  // carry: it ships the other three chevrons and not the upward one, and the
  // flow editor needs it to move a step up. Drawn as the mirror of
  // `chevron-down`, in the same family (24x24, stroke 2, no fill), so the pair
  // that sits side by side on a step row reads as one control in two
  // directions.
  "chevron-up": '<path d="m18 15-6-6-6 6"></path>',
  "circle-alert":
    '<circle cx="12" cy="12" r="10"></circle> <line x1="12" x2="12" y1="8" y2="12"></line> <line x1="12" x2="12.01" y1="16" y2="16"></line>',
  "circle-check":
    '<circle cx="12" cy="12" r="10"></circle> <path d="m9 12 2 2 4-4"></path>',
  clock:
    '<circle cx="12" cy="12" r="10"></circle> <path d="M12 6v6l4 2"></path>',
  copy: '<rect width="14" height="14" x="8" y="8" rx="2" ry="2"></rect> <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"></path>',
  database:
    '<ellipse cx="12" cy="5" rx="9" ry="3"></ellipse> <path d="M3 5V19A9 3 0 0 0 21 19V5"></path> <path d="M3 12A9 3 0 0 0 21 12"></path>',
  ellipsis:
    '<circle cx="12" cy="12" r="1"></circle> <circle cx="19" cy="12" r="1"></circle> <circle cx="5" cy="12" r="1"></circle>',
  "external-link":
    '<path d="M15 3h6v6"></path> <path d="M10 14 21 3"></path> <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path>',
  eye: '<path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0"></path> <circle cx="12" cy="12" r="3"></circle>',
  "eye-off":
    '<path d="M10.733 5.076a10.744 10.744 0 0 1 11.205 6.575 1 1 0 0 1 0 .696 10.747 10.747 0 0 1-1.444 2.49"></path> <path d="M14.084 14.158a3 3 0 0 1-4.242-4.242"></path> <path d="M17.479 17.499a10.75 10.75 0 0 1-15.417-5.151 1 1 0 0 1 0-.696 10.75 10.75 0 0 1 4.446-5.143"></path> <path d="m2 2 20 20"></path>',
  file: '<path d="M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z"></path> <path d="M14 2v5a1 1 0 0 0 1 1h5"></path>',
  "file-pen":
    '<path d="M14 2v5a1 1 0 0 0 1 1h5"></path> <path d="M14 22H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v4"></path> <path d="m17.5 15.5 3 3"></path> <path d="m13 21 1.5-4.5 5-5a2.121 2.121 0 0 1 3 3l-5 5z"></path>',
  "grid-2x2":
    '<path d="M12 3v18"></path> <path d="M3 12h18"></path> <rect x="3" y="3" width="18" height="18" rx="2"></rect>',
  image:
    '<rect width="18" height="18" x="3" y="3" rx="2" ry="2"></rect> <circle cx="9" cy="9" r="2"></circle> <path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"></path>',
  "image-off":
    '<line x1="2" x2="22" y1="2" y2="22"></line> <path d="M10.41 10.41a2 2 0 1 1-2.83-2.83"></path> <line x1="13.5" x2="6" y1="13.5" y2="21"></line> <line x1="18" x2="21" y1="12" y2="15"></line> <path d="M3.59 3.59A1.99 1.99 0 0 0 3 5v14a2 2 0 0 0 2 2h14c.55 0 1.052-.22 1.41-.59"></path> <path d="M21 15V5a2 2 0 0 0-2-2H9"></path>',
  info: '<circle cx="12" cy="12" r="10"></circle> <path d="M12 16v-4"></path> <path d="M12 8h.01"></path>',
  languages:
    '<path d="m5 8 6 6"></path> <path d="m4 14 6-6 2-3"></path> <path d="M2 5h12"></path> <path d="M7 2h1"></path> <path d="m22 22-5-10-5 10"></path> <path d="M14 18h6"></path>',
  "layout-dashboard":
    '<rect width="7" height="9" x="3" y="3" rx="1"></rect> <rect width="7" height="5" x="14" y="3" rx="1"></rect> <rect width="7" height="9" x="14" y="12" rx="1"></rect> <rect width="7" height="5" x="3" y="16" rx="1"></rect>',
  link: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"></path> <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"></path>',
  list: '<path d="M3 5h.01"></path> <path d="M3 12h.01"></path> <path d="M3 19h.01"></path> <path d="M8 5h13"></path> <path d="M8 12h13"></path> <path d="M8 19h13"></path>',
  "loader-circle": '<path d="M21 12a9 9 0 1 1-6.219-8.56"></path>',
  lock: '<rect width="18" height="11" x="3" y="11" rx="2" ry="2"></rect> <path d="M7 11V7a5 5 0 0 1 10 0v4"></path>',
  "log-out":
    '<path d="m16 17 5-5-5-5"></path> <path d="M21 12H9"></path> <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"></path>',
  mail: '<path d="m22 7-8.991 5.727a2 2 0 0 1-2.009 0L2 7"></path> <rect x="2" y="4" width="20" height="16" rx="2"></rect>',
  menu: '<path d="M4 5h16"></path> <path d="M4 12h16"></path> <path d="M4 19h16"></path>',
  "message-circle":
    '<path d="M2.992 16.342a2 2 0 0 1 .094 1.167l-1.065 3.29a1 1 0 0 0 1.236 1.168l3.413-.998a2 2 0 0 1 1.099.092 10 10 0 1 0-4.777-4.719"></path>',
  pause:
    '<rect x="14" y="3" width="5" height="18" rx="1"></rect> <rect x="5" y="3" width="5" height="18" rx="1"></rect>',
  pencil:
    '<path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"></path> <path d="m15 5 4 4"></path>',
  play: '<path d="M5 5a2 2 0 0 1 3.008-1.728l11.997 6.998a2 2 0 0 1 .003 3.458l-12 7A2 2 0 0 1 5 19z"></path>',
  plus: '<path d="M5 12h14"></path> <path d="M12 5v14"></path>',
  "refresh-cw":
    '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"></path> <path d="M21 3v5h-5"></path> <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"></path> <path d="M8 16H3v5"></path>',
  search:
    '<path d="m21 21-4.34-4.34"></path> <circle cx="11" cy="11" r="8"></circle>',
  settings:
    '<path d="M9.671 4.136a2.34 2.34 0 0 1 4.659 0 2.34 2.34 0 0 0 3.319 1.915 2.34 2.34 0 0 1 2.33 4.033 2.34 2.34 0 0 0 0 3.831 2.34 2.34 0 0 1-2.33 4.033 2.34 2.34 0 0 0-3.319 1.915 2.34 2.34 0 0 1-4.659 0 2.34 2.34 0 0 0-3.32-1.915 2.34 2.34 0 0 1-2.33-4.033 2.34 2.34 0 0 0 0-3.831A2.34 2.34 0 0 1 6.35 6.051a2.34 2.34 0 0 0 3.319-1.915"></path> <circle cx="12" cy="12" r="3"></circle>',
  tag: '<path d="M12.586 2.586A2 2 0 0 0 11.172 2H4a2 2 0 0 0-2 2v7.172a2 2 0 0 0 .586 1.414l8.704 8.704a2.426 2.426 0 0 0 3.42 0l6.58-6.58a2.426 2.426 0 0 0 0-3.42z"></path> <circle cx="7.5" cy="7.5" r=".5" fill="currentColor"></circle>',
  timer:
    '<line x1="10" x2="14" y1="2" y2="2"></line> <line x1="12" x2="15" y1="14" y2="11"></line> <circle cx="12" cy="14" r="8"></circle>',
  "trash-2":
    '<path d="M10 11v6"></path> <path d="M14 11v6"></path> <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"></path> <path d="M3 6h18"></path> <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>',
  "triangle-alert":
    '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"></path> <path d="M12 9v4"></path> <path d="M12 17h.01"></path>',
  unlink:
    '<path d="m18.84 12.25 1.72-1.71h-.02a5.004 5.004 0 0 0-.12-7.07 5.006 5.006 0 0 0-6.95 0l-1.72 1.71"></path> <path d="m5.17 11.75-1.71 1.71a5.004 5.004 0 0 0 .12 7.07 5.006 5.006 0 0 0 6.95 0l1.71-1.71"></path> <line x1="8" x2="8" y1="2" y2="5"></line> <line x1="2" x2="5" y1="8" y2="8"></line> <line x1="16" x2="16" y1="19" y2="22"></line> <line x1="19" x2="22" y1="16" y2="16"></line>',
  "user-check":
    '<path d="m16 11 2 2 4-4"></path> <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"></path> <circle cx="9" cy="7" r="4"></circle>',
  workflow:
    '<rect width="8" height="8" x="3" y="3" rx="2"></rect> <path d="M7 11v4a2 2 0 0 0 2 2h4"></path> <rect width="8" height="8" x="13" y="13" rx="2"></rect>',
  x: '<path d="M18 6 6 18"></path> <path d="m6 6 12 12"></path>',
  zap: '<path d="M15.914 4a1.5 1.5 0 00-2.474-1.561l-9 9A1.5 1.5 0 005.5 14h4.002a.5.5 0 01.471.666L8.086 20a1.5 1.5 0 002.475 1.56l9-9A1.5 1.5 0 0018.5 10h-3.997a.5.5 0 01-.472-.667z"></path>',
} as const;

/**
 * Every glyph the system ships, as a type derived from the drawings themselves.
 *
 * Derived, and not a hand-written union beside the object: the two would drift,
 * and a name with no drawing renders nothing at all. Here `<Icon name="foo" />`
 * fails to compile unless `foo` is one of the keys above.
 */
export type IconName = keyof typeof GLYPHS;

export const ICON_NAMES = Object.keys(GLYPHS) as readonly IconName[];

/**
 * The edge lengths the system uses, named by where they are used.
 *
 * A glyph size is a measurement of the widget that holds it (a 20px remove
 * button cannot hold a 20px glyph), so these are not steps of the spacing
 * ladder and they are not tokens. They are named here so the same six numbers
 * are not spelled out across twenty files.
 */
export const ICON_SIZE = {
  /** The smallest mark the system draws: the chip's x, an inline badge glyph.
   * The MARK is this small; the target around it is `--tap` like every other
   * control (REQ-268), and the two are not the same measurement. */
  chip: 13,
  /** Inside a badge or a step circle, where the glyph replaces a character. */
  dense: 14,
  /** Beside a line of text: field errors, the pending sentence. */
  text: 16,
  /** Inside a control, a navigation item or a notice. */
  control: 18,
  /** Standing alone: the fallback for a thumbnail that did not load. */
  standalone: 20,
  /** The empty state, where the glyph is the largest thing on the block. */
  display: 26,
} as const;

/** The family weight. 1.5 only above 32px, which nothing in the product uses. */
const STROKE_WIDTH = 2;

export interface IconProps extends Omit<SVGProps<SVGSVGElement>, "name"> {
  /** Which glyph to draw. */
  readonly name: IconName;
  /** Edge length in px. See `ICON_SIZE` for the six the system uses. */
  readonly size?: number;
  readonly strokeWidth?: number;
  /**
   * Accessible name. Omit it and the glyph is hidden from assistive technology,
   * which is right whenever a visible word sits beside it, and a visible word
   * almost always does: colour and shape are never the only carrier of
   * information in this interface.
   */
  readonly label?: string;
  readonly style?: CSSProperties;
}

export function Icon({
  name,
  size = ICON_SIZE.standalone,
  strokeWidth = STROKE_WIDTH,
  label,
  style,
  ...rest
}: IconProps): ReactElement {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      // Hidden when it is unnamed, because an unnamed glyph beside a word is
      // decoration: announcing it would read the same information twice.
      aria-hidden={label === undefined ? true : undefined}
      role={label === undefined ? undefined : "img"}
      aria-label={label}
      // Internet Explorer's legacy tab stop for SVG, kept because it costs one
      // attribute and a focus stop with no control behind it is a keyboard trap.
      focusable="false"
      style={{ display: "block", flex: "0 0 auto", ...style }}
      // The markup is a module-local constant written above, never operator
      // input and never data from the platform, so there is nothing here for an
      // injection to arrive through. The alternative is 47 hand-written JSX
      // trees that no longer match the files they came from.
      dangerouslySetInnerHTML={{ __html: GLYPHS[name] }}
      {...rest}
    />
  );
}
