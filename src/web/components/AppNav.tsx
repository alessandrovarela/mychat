import type { ReactElement, ReactNode } from "react";
import { replacesTheScreen } from "../navigation.js";
import { Brand } from "./Brand.js";
import { Icon, ICON_SIZE } from "./Icon.js";
import type { IconName } from "./Icon.js";

/**
 * AppNav: the fixed left rail, which is the navigation the product does not
 * have yet (REQ-112).
 *
 * A handful of flat addresses, no hierarchy to model and one operator with no
 * roles: a rail is the honest shape. Work above, settings and the session
 * below, and the brand at the top is the product name set in type (`Brand`,
 * REQ-331), because the repository ships no logo and nothing is invented in its
 * place.
 *
 * The name used to arrive here as one string and be drawn beside a square
 * carrying its first letter. The square was deliberate and it was kept honest
 * the same way: the letter was taken from the name, so no symbol was invented.
 * The user asked for the prototype's treatment while there is no logo, which
 * accents the name's second word and draws nothing else, and it invents no
 * symbol either. It is a placeholder until a logo exists and not an answer to
 * the request for one.
 *
 * The current item carries `aria-current="page"`, which is the programmatic
 * mark acceptance criterion 6 asks for and the same mark the language screen
 * already uses for the language in force. Colour alone would leave the current
 * screen unknowable to a screen reader.
 *
 * Each destination is an `<a href>`, so it is reachable by Tab, opens in a new
 * tab on the middle button, and answers Enter with no key handling of our own.
 * `onNavigate` intercepts the click when the caller routes in the page instead
 * of reloading it, and it intercepts the ORDINARY activation alone: a modified
 * click asks for another tab, and a rail that swallowed it would leave the
 * operator on the same screen with nothing having happened. The rule is the
 * navigator's own (`replacesTheScreen`), asked here because this is the one
 * destination in the interface that does not route through its `follow`, and
 * copying the four modifier keys into this file would be a second rule to keep
 * in step with the first. Nothing flows the other way: the navigation knows no
 * component, so there is no circle in the pair.
 *
 * It matters twice since a screen can hold its exits (REQ-295). A click that
 * opens another tab leaves the editor where it is with the work still in it,
 * and answering it with "your changes are unsaved" would be a warning about a
 * loss that was never going to happen.
 *
 * The address is required rather than defaulted (REQ-276): an anchor that only
 * acts is a button drawn wrong.
 */

export interface NavItem {
  /** Matched against `current`. The route is the natural value. */
  readonly id: string;
  readonly label: string;
  readonly icon: IconName;
  /**
   * The address this destination goes to, REQUIRED (REQ-276).
   *
   * It used to be optional, with `#` written in where a caller left it out, and
   * that is the shape the requirement is about: an anchor with no address goes
   * nowhere, so it is an ACTION dressed as a destination, and the browser gives
   * it neither the keyboard behaviour of a button nor a target of any declared
   * size. A destination that cannot say where it goes is not one.
   */
  readonly href: string;
}

export interface NavGroup {
  readonly title: string;
  readonly items: readonly NavItem[];
}

export interface AppNavProps {
  readonly items: readonly NavItem[];
  /**
   * The id of the `nav` element, for a control that says it opens this rail:
   * `aria-controls` has to name something a screen reader can follow
   * (REQ-186), and the casing gives the rail an id for exactly that.
   */
  readonly id?: string;
  /**
   * Out of the tab order and out of the accessibility tree, without leaving the
   * document. The casing sets it while the rail is a shut drawer on a handset;
   * the sheet carries `.mc-nav[hidden]` so the attribute outranks the `display`
   * this rail declares for itself (REQ-199).
   */
  readonly hidden?: boolean;
  /** The accessible name of the navigation itself, from the catalogue. */
  readonly label: string;
  /** The first word of the product name, from the catalogue. */
  readonly brandLead: string;
  /** Its second word, the one the mark writes in the accent. */
  readonly brandAccent: string;
  /** Connected account identity, kept beside the product mark in the rail. */
  readonly account?: ReactNode;
  /** The id of the screen on show. Sets `aria-current="page"`. */
  readonly current?: string;
  /** Given, the rail intercepts the click instead of following the href. */
  readonly onNavigate?: (id: string) => void;
  /** Secondary groups under the main list. */
  readonly groups?: readonly NavGroup[];
  /** The state of the session, in words. Not a control. */
  readonly sessionNote?: ReactNode;
  /** Sign out, language switch. */
  readonly footer?: ReactNode;
}

export function AppNav({
  items,
  id,
  hidden = false,
  label,
  brandLead,
  brandAccent,
  account,
  current,
  onNavigate,
  groups = [],
  sessionNote,
  footer,
}: AppNavProps): ReactElement {
  const renderItem = (item: NavItem): ReactElement => (
    <li key={item.id}>
      <a
        className="mc-nav__link"
        href={item.href}
        aria-current={current === item.id ? "page" : undefined}
        onClick={(event) => {
          if (onNavigate !== undefined && replacesTheScreen(event)) {
            event.preventDefault();
            onNavigate(item.id);
          }
        }}
      >
        <Icon name={item.icon} size={ICON_SIZE.control} />
        {item.label}
      </a>
    </li>
  );

  return (
    <nav className="mc-nav" id={id} hidden={hidden} aria-label={label}>
      <Brand lead={brandLead} accent={brandAccent} />
      {account}

      <ul className="mc-nav__list">{items.map(renderItem)}</ul>

      {groups.map((group) => (
        <div className="mc-nav__group" key={group.title}>
          <span className="mc-nav__grouphead">{group.title}</span>
          <ul className="mc-nav__list">{group.items.map(renderItem)}</ul>
        </div>
      ))}

      <div className="mc-nav__foot">
        {sessionNote === undefined ? null : (
          <span className="mc-nav__session">
            <Icon name="lock" size={ICON_SIZE.chip} />
            {sessionNote}
          </span>
        )}
        {footer}
      </div>
    </nav>
  );
}
