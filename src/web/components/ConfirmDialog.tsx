import { useId, useState } from "react";
import type { ReactElement, ReactNode } from "react";
import { Button } from "./Button.js";
import { Modal } from "./Modal.js";
import { StatusBadge } from "./StatusBadge.js";
import type { BadgeState } from "./StatusBadge.js";

/**
 * ConfirmDialog: a confirmation WITH ITS CONSEQUENCE, which is REQ-061.
 *
 * The reach panel is the most important piece of the flows screen: before
 * anything is written, the operator reads what is about to happen, how many
 * automations it touches split into in force and off, and can list them by
 * name. So `consequence` and the counts are props and not slots a caller may
 * forget, and the groups render as real lists because REQ-061 says the reach is
 * enumerable.
 *
 * `onCancel` is required beside `onConfirm`: a confirmation with no way back is
 * not a confirmation, it is an announcement. It is deliberately drawn in the
 * footer beside the consequence, rather than duplicated as an X in the head:
 * every confirmation has one visible way to decline it (REQ-374).
 */

export interface ReachCount {
  /** The number and the word together, from the catalogue. */
  readonly label: string;
  readonly state?: BadgeState;
}

export interface ReachItem {
  readonly id: string;
  readonly name: string;
}

export interface ReachGroup {
  readonly title: string;
  readonly items: readonly ReachItem[];
}

interface ConfirmDialogBase {
  readonly open?: boolean;
  readonly title: ReactNode;
  /** What is about to happen, in one sentence, from the catalogue. */
  readonly consequence: ReactNode;
  /** How many records the change reaches, already formatted by the caller. */
  readonly summary?: ReactNode;
  readonly counts?: readonly ReachCount[];
  readonly confirmLabel: string;
  readonly cancelLabel: string;
  /** Makes the commit button destructive. For delete and detach. */
  readonly destructive?: boolean;
  readonly pending?: boolean;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
  readonly children?: ReactNode;
}

/**
 * The reach, listable, or nothing to list at all.
 *
 * The two words of the disclosure exist only when there IS a reach to
 * enumerate, and the correlation is stated in the type for the reason
 * `Modal`'s close is: a confirmation whose consequence reaches no other record
 * (discarding what an editor holds, REQ-151) would otherwise be asked for two
 * sentences the catalogue would carry and nothing would ever render.
 */
type ConfirmList =
  | {
      /** The reach, listable. REQ-061 requires that it can be enumerated. */
      readonly groups: readonly ReachGroup[];
      readonly listLabel: string;
      readonly hideLabel: string;
    }
  | {
      readonly groups?: undefined;
      readonly listLabel?: undefined;
      readonly hideLabel?: undefined;
    };

export type ConfirmDialogProps = ConfirmDialogBase & ConfirmList;

export function ConfirmDialog({
  open = true,
  title,
  consequence,
  summary,
  counts = [],
  groups = [],
  listLabel,
  hideLabel,
  confirmLabel,
  cancelLabel,
  destructive = false,
  pending = false,
  onConfirm,
  onCancel,
  children,
}: ConfirmDialogProps): ReactElement {
  const [listed, setListed] = useState(false);
  const hasGroups = groups.some((group) => group.items.length > 0);
  /** What the disclosure points at. Minted here, so two dialogs never share it. */
  const listId = useId();

  return (
    <Modal
      open={open}
      size="md"
      title={title}
      onClose={onCancel}
      footer={
        <>
          <Button variant="secondary" onClick={onCancel}>
            {cancelLabel}
          </Button>
          <Button
            variant={destructive ? "destructive" : "primary"}
            onClick={onConfirm}
            pending={pending}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="mc-consequence">
        <p className="mc-consequence__lead">{consequence}</p>
        {summary === undefined ? null : (
          <p className="mc-panel__note">{summary}</p>
        )}
        {counts.length === 0 ? null : (
          <div className="mc-consequence__counts">
            {counts.map((count) => (
              <StatusBadge key={count.label} state={count.state ?? "neutral"}>
                {count.label}
              </StatusBadge>
            ))}
          </div>
        )}
      </div>

      {/* Both or neither, which is what the props type says: destructuring a
          union loses the correlation, so it is restated here. */}
      {hasGroups && listLabel !== undefined && hideLabel !== undefined ? (
        <>
          <Button
            variant="secondary"
            onClick={() => setListed((was) => !was)}
            // The state of the disclosure, announced instead of implied by the
            // word on the button changing, and the region it opens NAMED
            // (REQ-186): "expanded" on its own tells a screen reader that
            // something opened and never what.
            aria-expanded={listed}
            aria-controls={listId}
          >
            {listed ? hideLabel : listLabel}
          </Button>
          {/* The region the control names, in the document open or shut, so
              `aria-controls` above points at something real in both states: an
              id that resolves to nothing asserts a relation the page does not
              have, which is worse than asserting none. What changes is the
              CONTENT: shut, the groups are not rendered, so there is nothing
              left to reach by any route.

              The id sits on the region itself. It sat on a wrapper until
              REQ-199, because `hidden` is a `display: none` the BROWSER declares
              and the grid below outranks it; the stylesheet states that rule
              now, so the element that IS the list is the one the control
              names. */}
          <div className="mc-reachlist" id={listId} hidden={!listed}>
            {listed
              ? groups.map((group) => (
                  <div className="mc-reachlist__group" key={group.title}>
                    <span className="mc-reachlist__head">{group.title}</span>
                    <ul>
                      {group.items.map((item) => (
                        <li key={item.id}>
                          {/* Two elements and no text between them: the gap is
                              the stylesheet's, so no whitespace of ours can
                              turn into a string literal on the next
                              reformat. */}
                          <span>{item.name}</span>
                          <code>{item.id}</code>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))
              : null}
          </div>
        </>
      ) : null}

      {children}
    </Modal>
  );
}
