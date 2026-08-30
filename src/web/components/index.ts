/**
 * The design system's components, ported from `mychat-design-system/project`
 * into the application (REQ-116).
 *
 * One file per component, named as the design system names it, so a component
 * on screen can be read against the `.prompt.md` that explains why it is shaped
 * the way it is. The five families of the prototype (core, data, feedback,
 * forms, navigation) are a reading order and not directories: twenty-one ported
 * files do not need a tree, and every screen imports from this one door.
 *
 * Six components were added after the port and have no `.prompt.md` behind
 * them. `TrendChart` is the visual reading the panel was asked for (REQ-154),
 * and the prototype had no chart of any kind. `FileUpload` and `AssetGrid` are
 * the resource controls REQ-290 and REQ-291 put where a dropdown of names used
 * to be. `Toast` is where the answer to a write goes since REQ-312, and the
 * prototype answered a write with a band at the top of the page. `ButtonLink`
 * is the typed door for a destination wearing the button shape. `Brand` is the
 * product's name set in type, which is the mark until there is a logo
 * (REQ-331), and the design system's wordmark page still draws the square it
 * replaced. The rules below are what all five were built to obey rather than an
 * exception to them.
 *
 * Two rules hold across all of them, and both are the reason this task exists:
 *
 *   - a component knows no language. Every word an operator can read arrives as
 *     a property, from the catalogue, passed by the screen. Where a word is
 *     what makes a control usable (the name of a remove button, of a dialog's
 *     close, of a mode select), the type REQUIRES it, so the compiler refuses
 *     the omission instead of a reviewer catching it.
 *   - a component holds no colour and no measurement of its own. The rules live
 *     in `components.css`, in tokens, and that sheet enters the application
 *     once through `styles/app.css`. No component imports CSS.
 */

export { AppNav } from "./AppNav.js";
export type { AppNavProps, NavGroup, NavItem } from "./AppNav.js";

export { AssetGrid } from "./AssetGrid.js";
export type { AssetGridProps, AssetRemoval, AssetTile } from "./AssetGrid.js";

export { Brand } from "./Brand.js";
export type { BrandProps } from "./Brand.js";

export { Button } from "./Button.js";
export type { ButtonProps, ButtonVariant } from "./Button.js";

export { ButtonLink } from "./ButtonLink.js";
export type { ButtonLinkProps } from "./ButtonLink.js";

export { CapMeter } from "./CapMeter.js";
export type { CapMeterProps, CapStatus } from "./CapMeter.js";

export { Card } from "./Card.js";
export type { CardProps } from "./Card.js";

export { Checkbox } from "./Checkbox.js";
export type { CheckboxProps } from "./Checkbox.js";

export { Chip } from "./Chip.js";
export type { ChipProps, ChipTone } from "./Chip.js";

export { ConfirmDialog } from "./ConfirmDialog.js";
export type {
  ConfirmDialogProps,
  ReachCount,
  ReachGroup,
  ReachItem,
} from "./ConfirmDialog.js";

export { DataTable } from "./DataTable.js";
export type {
  DataTableProps,
  TableColumn,
  TableRow,
  TableTotal,
} from "./DataTable.js";

export { EmptyState } from "./EmptyState.js";
export type { EmptyStateProps } from "./EmptyState.js";

export { Field } from "./Field.js";
export type { FieldAdvice, FieldProps } from "./Field.js";

export { FileUpload } from "./FileUpload.js";
export type { FileUploadProps } from "./FileUpload.js";

export { Icon, ICON_NAMES, ICON_SIZE } from "./Icon.js";
export type { IconName, IconProps } from "./Icon.js";

export { IconButton } from "./IconButton.js";
export type { IconButtonProps, IconButtonTone } from "./IconButton.js";

export { KeywordField } from "./KeywordField.js";
export type { KeywordFieldProps } from "./KeywordField.js";

/**
 * The one module here that renders nothing: what a field's advice layer is
 * DECIDED by (REQ-307, REQ-308). It leaves by this door with the rest because a
 * screen that draws the advice needs both halves, and the system has one door.
 */
export {
  LENGTH_ADVICE_NATURES,
  LENGTH_ADVICE_TEXT_KEYS,
  lengthAdvice,
  measureLength,
} from "./length-advice.js";
export type {
  LengthAdvice,
  LengthAdviceNature,
  LengthCeilings,
  LengthMeasurement,
} from "./length-advice.js";

export { Modal } from "./Modal.js";
export type { ModalProps, ModalSize } from "./Modal.js";

export { Notice } from "./Notice.js";
export type { NoticeIssue, NoticeNature, NoticeProps } from "./Notice.js";

export { Pagination } from "./Pagination.js";
export type { PaginationProps } from "./Pagination.js";

export { PendingState } from "./PendingState.js";
export type { PendingStateProps } from "./PendingState.js";

export { PublicationGrid } from "./PublicationGrid.js";
export type {
  PublicationGridProps,
  PublicationItem,
} from "./PublicationGrid.js";

export { Select } from "./Select.js";
export type { SelectOption, SelectProps } from "./Select.js";

export { StatusBadge } from "./StatusBadge.js";
export type { BadgeState, StatusBadgeProps } from "./StatusBadge.js";

export { TextArea } from "./TextArea.js";
export type { DefinitionIssue, TextAreaProps } from "./TextArea.js";

export {
  Toast,
  TOAST_VIEWPORT_ID,
  toastReadingTimeMs,
  TOAST_CEILING_MS,
  TOAST_FLOOR_MS,
  TOAST_MS_PER_CHARACTER,
} from "./Toast.js";
export type { ToastProps } from "./Toast.js";

export { TrendChart } from "./TrendChart.js";
export type { TrendChartProps, TrendSeries } from "./TrendChart.js";
