import type { CSSProperties, ReactElement } from "react";

/**
 * Brand: the product's name, set in type, which is the whole mark (REQ-331).
 *
 * The repository ships no logo and nothing is drawn in place of one. Until a
 * logo exists the NAME is the mark: the first word in the ink of the text
 * around it, the second in the accent, which is the treatment
 * `docs/prototipo-automacao.html` draws (`.brand`) and the one the user
 * approved by looking at the page. This is a PLACEHOLDER until there is a
 * logo, not an answer to the request for one: the day a logo arrives it takes
 * the place of this component.
 *
 * What stood here before was a square carrying the name's first letter, and
 * that square was a deliberate choice made under the rule this treatment obeys
 * too: invent no symbol. Taking the letter from the name was how the old mark
 * kept it; carrying no mark at all is how this one does. The rail is one
 * element lighter for it.
 *
 * The two words arrive from the catalogue like every other word a component
 * shows. Where the name splits is a fact about the NAME and not something the
 * code can work out: a component that cut the string at its second capital
 * would silently draw the whole of a name that has none, with no accent
 * anywhere and no test to notice.
 */
export interface BrandProps {
  /** The first word, in the ink of the text around it. From the catalogue. */
  readonly lead: string;
  /** The second word, written in the accent. From the catalogue. */
  readonly accent: string;
  /**
   * The type size where it is not the sheet's own, in tokens.
   *
   * The access screen sets the name at the size of its heading, which is the
   * one placement where the mark is the biggest thing on the screen rather
   * than the quietest thing in a bar.
   */
  readonly style?: CSSProperties;
}

export function Brand({ lead, accent, style }: BrandProps): ReactElement {
  return (
    <span className="mc-brand" style={style}>
      {lead}
      <span className="mc-brand__accent">{accent}</span>
    </span>
  );
}
