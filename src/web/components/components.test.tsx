import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { useState } from "react";
import type { ReactElement } from "react";
import en from "../../i18n/locales/en.json";
import pt from "../../i18n/locales/pt-BR.json";
import type {
  AssetRemoval,
  AssetTile,
  LengthAdviceNature,
  LengthCeilings,
} from "./index.js";
import * as system from "./index.js";
import {
  AppNav,
  AssetGrid,
  Brand,
  Button,
  ButtonLink,
  CapMeter,
  Card,
  Checkbox,
  Chip,
  ConfirmDialog,
  DataTable,
  EmptyState,
  Field,
  FileUpload,
  Icon,
  IconButton,
  KeywordField,
  LENGTH_ADVICE_NATURES,
  LENGTH_ADVICE_TEXT_KEYS,
  lengthAdvice,
  measureLength,
  Modal,
  Notice,
  Pagination,
  PendingState,
  PublicationGrid,
  Select,
  StatusBadge,
  TextArea,
  Toast,
  TOAST_CEILING_MS,
  TOAST_FLOOR_MS,
  TOAST_MS_PER_CHARACTER,
  TOAST_VIEWPORT_ID,
  toastReadingTimeMs,
  TrendChart,
} from "./index.js";

/**
 * REQ-116: every interactive control is reachable and operable by keyboard,
 * with a visible focus indicator, and the suite refuses a control with no
 * accessible name.
 *
 * Three checks, because the requirement is three claims:
 *
 *   - NAME. Every specimen below is rendered and every focusable element it
 *     produces is looked up by its role AND a non-empty accessible name. An
 *     element that is focusable but nameless is reported by component, by tag
 *     and by role. This is the check that bites when a label is dropped from a
 *     glyph-only control, which is the whole reason `IconButton.label` and
 *     `Chip.removeLabel` are required in their types.
 *   - FOCUS. The indicator is a rule of the system (`tokens/base.css`), so what
 *     has to be proven is that nothing takes it away. The sweep reads every
 *     file of the interface and refuses `outline: none` unless the same rule
 *     puts a ring back.
 *   - OPERATION. Where a component implements keyboard behaviour of its own
 *     (the chip that removes, the dialog that closes, the keyword field that
 *     commits a word), it is driven from the keyboard here and nowhere else.
 *
 * A fourth check rides along, and it belongs to this file rather than to the
 * catalogue's guardian: a component KNOWS NO LANGUAGE. Every word a specimen
 * renders is a sentinel the specimen itself passed, so any letter that reaches
 * the screen from inside a component is a word written into the code.
 */

/**
 * A stand-in for a word that arrives from the catalogue.
 *
 * Shaped so it can be told apart from anything a component might contribute on
 * its own, and delimited with `~` rather than braces or brackets, which are
 * both key descriptors to `userEvent.keyboard`.
 */
function word(key: string): string {
  return `~${key}~`;
}

/** Every sentinel, so what a component added of its own is what is left. */
const SENTINEL = /~[\w.-]+~/g;

interface Specimen {
  readonly name: string;
  /** Rendered as the screens are expected to render it. */
  readonly element: ReactElement;
  /**
   * Whether the component draws through a PORTAL, so what it rendered is not in
   * the container the renderer hands back.
   *
   * Only `Toast`, which is anchored to the viewport and lands in a strip on the
   * body. Without this every sweep below would read an empty container for it,
   * and a component whose control has no accessible name would pass by having
   * nothing to look at.
   */
  readonly portal?: true;
}

/** Where a specimen really drew, which is the whole body for a portal. */
function drawnIn(container: HTMLElement, specimen: Specimen): HTMLElement {
  return specimen.portal === true ? document.body : container;
}

/**
 * One specimen per component, with every word passed in.
 *
 * A component that needs another one to be usable is shown that way, because
 * that is the arrangement the system prescribes: a `Select` has no label of its
 * own and gets one from the `Field` around it, exactly as the design system's
 * own note says.
 */
const SPECIMENS: readonly Specimen[] = [
  {
    name: "AppNav",
    element: (
      <AppNav
        label={word("nav.label")}
        brandLead={word("nav.brandLead")}
        brandAccent={word("nav.brandAccent")}
        current="/dashboard"
        onNavigate={() => undefined}
        items={[
          {
            id: "/dashboard",
            href: "/dashboard",
            label: word("nav.dashboard"),
            icon: "layout-dashboard",
          },
          {
            id: "/flows",
            href: "/flows",
            label: word("nav.flows"),
            icon: "workflow",
          },
        ]}
        groups={[
          {
            title: word("nav.settings"),
            items: [
              {
                id: "/settings/language",
                href: "/settings/language",
                label: word("nav.language"),
                icon: "languages",
              },
            ],
          },
        ]}
        sessionNote={word("nav.session")}
        footer={
          <Button variant="ghost" icon="log-out">
            {word("nav.signOut")}
          </Button>
        }
      />
    ),
  },
  {
    name: "AssetGrid",
    element: (
      <AssetGrid
        items={[
          {
            name: word("asset.imageKey"),
            fileName: word("asset.imageName"),
            url: "/assets/cover.png",
            kind: "image",
          },
          {
            name: word("asset.fileKey"),
            fileName: word("asset.fileName"),
            url: "/assets/guide.pdf",
            kind: "file",
          },
        ]}
        selectedName={word("asset.imageKey")}
        onSelect={() => undefined}
        selectLabel={(fileName) => `${word("asset.use")} ${fileName}`}
        thumbnailAlt={(fileName) => `${word("asset.alt")} ${fileName}`}
        brokenLabel={word("asset.broken")}
        kindLabel={word("asset.kind")}
        emptyLabel={word("asset.empty")}
        removal={undefined}
        onRemoveRequest={() => undefined}
        onRemoveConfirm={() => undefined}
        onRemoveCancel={() => undefined}
        removeLabel={(fileName) => `${word("asset.delete")} ${fileName}`}
        removeQuestion={(fileName) => `${word("asset.deleteAsk")} ${fileName}`}
        usageLabel={(count) => `${word("asset.usage")} ${count}`}
        usagePendingLabel={word("asset.counting")}
        removeWarning={word("asset.warning")}
        removeConfirmLabel={word("asset.deleteYes")}
        removeWorkingLabel={word("asset.deleting")}
        removeCancelLabel={word("asset.keep")}
      />
    ),
  },
  {
    name: "Brand",
    element: (
      <Brand lead={word("nav.brandLead")} accent={word("nav.brandAccent")} />
    ),
  },
  {
    name: "Button",
    element: (
      <Button variant="primary" icon="plus">
        {word("button.label")}
      </Button>
    ),
  },
  {
    name: "ButtonLink",
    element: (
      <ButtonLink href="/destination" variant="primary" iconEnd="arrow-right">
        {word("buttonLink.label")}
      </ButtonLink>
    ),
  },
  {
    name: "CapMeter",
    element: (
      <CapMeter
        name={word("cap.name")}
        used={86}
        limit={100}
        status="attention"
        statusLabel={word("cap.status")}
        usageLabel={word("cap.usage")}
        note={word("cap.note")}
      />
    ),
  },
  {
    name: "Card",
    element: (
      <Card
        media={<img src="/thumb.png" alt={word("card.thumbnail")} />}
        title={word("card.title")}
        badge={<StatusBadge state="active">{word("card.state")}</StatusBadge>}
        sentence={word("card.sentence")}
        meta={[word("card.meta")]}
        actions={
          <Button variant="ghost" icon="pencil">
            {word("card.edit")}
          </Button>
        }
      />
    ),
  },
  {
    name: "Checkbox",
    element: (
      <Checkbox
        id="once"
        label={word("check.label")}
        hint={word("check.hint")}
      />
    ),
  },
  {
    name: "Chip",
    element: (
      <Chip mono onRemove={() => undefined} removeLabel={word("chip.remove")}>
        {word("chip.word")}
      </Chip>
    ),
  },
  {
    name: "ConfirmDialog",
    element: (
      <ConfirmDialog
        title={word("confirm.title")}
        consequence={word("confirm.consequence")}
        summary={word("confirm.summary")}
        counts={[{ label: word("confirm.active"), state: "active" }]}
        groups={[
          {
            title: word("confirm.group"),
            items: [{ id: word("confirm.id"), name: word("confirm.name") }],
          },
        ]}
        listLabel={word("confirm.list")}
        hideLabel={word("confirm.hide")}
        confirmLabel={word("confirm.commit")}
        cancelLabel={word("confirm.cancel")}
        onConfirm={() => undefined}
        onCancel={() => undefined}
      />
    ),
  },
  {
    name: "DataTable",
    element: (
      <DataTable
        bars
        caption={word("table.caption")}
        columns={[
          { key: "period", label: word("table.period") },
          { key: "comment", label: word("table.comments") },
        ]}
        rows={[
          { key: "14", label: word("table.hour"), cells: { comment: 12 } },
        ]}
        total={{ label: word("table.total"), cells: { comment: 12 } }}
      />
    ),
  },
  {
    name: "EmptyState",
    element: (
      <EmptyState
        icon="zap"
        title={word("empty.title")}
        action={
          <Button variant="primary" icon="plus">
            {word("empty.action")}
          </Button>
        }
      >
        {word("empty.text")}
      </EmptyState>
    ),
  },
  {
    name: "Field",
    element: (
      <Field
        id="target"
        label={word("field.label")}
        hint={word("field.hint")}
        error={word("field.error")}
        advice={{ nature: "truncation", message: word("field.advice") }}
        optional
        optionalLabel={word("field.optional")}
        mono
      />
    ),
  },
  {
    name: "FileUpload",
    element: (
      <FileUpload
        kind="image"
        kindLabel={word("upload.kind")}
        fileName={word("upload.name")}
        previewUrl="/assets/cover.png"
        note={word("upload.note")}
        emptyHint={word("upload.empty")}
        chooseLabel={word("upload.choose")}
        replaceLabel={word("upload.replace")}
        removeLabel={word("upload.remove")}
        thumbnailAlt={word("upload.alt")}
        brokenLabel={word("upload.broken")}
        onChoose={() => undefined}
        onRemove={() => undefined}
      />
    ),
  },
  {
    name: "Icon",
    element: <Icon name="triangle-alert" label={word("icon.label")} />,
  },
  {
    name: "IconButton",
    element: <IconButton icon="x" label={word("iconbutton.label")} />,
  },
  {
    name: "KeywordField",
    // Inside a Field, which is where its input gets a label: the keyword box is
    // a control, and a control with no label names nothing.
    element: (
      <Field id="keywords" label={word("keywords.label")}>
        <KeywordField
          id="keywords"
          keywords={[word("keywords.first")]}
          onAdd={() => undefined}
          onRemove={() => undefined}
          placeholder={word("keywords.placeholder")}
          removeLabel={(keyword) => `${word("keywords.remove")} ${keyword}`}
          modeLabel={word("keywords.mode")}
          mode="contains"
          modeOptions={[
            { value: "contains", label: word("keywords.contains") },
          ]}
          onModeChange={() => undefined}
        />
      </Field>
    ),
  },
  {
    name: "Modal",
    element: (
      <Modal
        title={word("modal.title")}
        lead={word("modal.lead")}
        onClose={() => undefined}
        closeLabel={word("modal.close")}
        footer={<Button variant="secondary">{word("modal.footer")}</Button>}
      >
        {word("modal.body")}
      </Modal>
    ),
  },
  {
    name: "Notice",
    element: (
      <Notice
        nature="error"
        title={word("notice.title")}
        issues={[
          { path: word("notice.path"), message: word("notice.message") },
        ]}
        actions={<Button variant="secondary">{word("notice.retry")}</Button>}
      >
        {word("notice.text")}
      </Notice>
    ),
  },
  {
    name: "Pagination",
    element: (
      <Pagination
        label={word("pagination.count")}
        previousLabel={word("pagination.previous")}
        nextLabel={word("pagination.next")}
        atStart
        onPrevious={() => undefined}
        onNext={() => undefined}
      />
    ),
  },
  {
    name: "PendingState",
    element: <PendingState label={word("pending.label")} skeleton={2} />,
  },
  {
    name: "PublicationGrid",
    element: (
      <PublicationGrid
        items={[
          {
            id: word("grid.first"),
            mediaType: word("grid.type"),
            publishedLabel: word("grid.date"),
          },
          {
            id: word("grid.second"),
            // A caption is data and not a word of the interface, so it arrives
            // as a sentinel like every other text the specimen is handed: what
            // this sweep is checking is that the component adds none of its own.
            caption: word("grid.caption"),
            mediaType: word("grid.type"),
            publishedLabel: word("grid.date"),
            thumbnailUrl: "/thumbs/second.jpg",
          },
        ]}
        selectedId={word("grid.first")}
        onSelect={() => undefined}
        selectLabel={(id) => `${word("grid.select")} ${id}`}
        thumbnailAlt={(id) => `${word("grid.alt")} ${id}`}
        brokenLabel={word("grid.broken")}
      />
    ),
  },
  {
    name: "Select",
    element: (
      <Field id="flow" label={word("select.label")}>
        <Select
          id="flow"
          placeholder={word("select.placeholder")}
          options={[{ value: "standard", label: word("select.option") }]}
        />
      </Field>
    ),
  },
  {
    name: "StatusBadge",
    element: <StatusBadge state="info">{word("badge.label")}</StatusBadge>,
  },
  {
    name: "TextArea",
    element: (
      <TextArea
        id="definition"
        label={word("textarea.label")}
        hint={word("textarea.hint")}
        issues={[
          { path: word("textarea.path"), message: word("textarea.message") },
        ]}
        issuesTitle={word("textarea.issues")}
        toolbar={
          <StatusBadge state="info" mono dot={false}>
            {word("textarea.version")}
          </StatusBadge>
        }
      />
    ),
  },
  {
    name: "Toast",
    portal: true,
    element: (
      <Toast
        nature="success"
        title={word("toast.title")}
        message={word("toast.message")}
        dismissLabel={word("toast.dismiss")}
        onDismiss={() => undefined}
      />
    ),
  },
  {
    name: "TrendChart",
    element: (
      <TrendChart
        label={word("trend.label")}
        axes={{ x: word("trend.axis.x"), y: word("trend.axis.y") }}
        note={word("trend.note")}
        periods={[word("trend.first"), word("trend.last")]}
        series={[
          {
            key: "comment",
            label: word("trend.comments"),
            counts: [3, 1],
            peakLabel: word("trend.peak"),
          },
        ]}
      />
    ),
  },
];

/**
 * The components that render a control, named here so a specimen that quietly
 * stopped rendering one cannot pass by finding nothing to check.
 */
const WITH_CONTROLS: readonly string[] = [
  "AppNav",
  "AssetGrid",
  "Button",
  "ButtonLink",
  "Card",
  "Checkbox",
  "Chip",
  "ConfirmDialog",
  "EmptyState",
  "Field",
  "FileUpload",
  "IconButton",
  "KeywordField",
  "Modal",
  "Notice",
  "Pagination",
  "PublicationGrid",
  "Select",
  "TextArea",
  "Toast",
];

/**
 * What a keyboard can land on. `[tabindex]` is in the list because a dialog is
 * focused programmatically when it opens, and a thing that receives focus has
 * to be nameable too.
 */
const FOCUSABLE = "button, a[href], input, select, textarea, [tabindex]";

/** Any accessible name at all, as long as it is not blank. */
const NON_EMPTY = /\S/;

/**
 * The role an element answers to, so the name can be looked up through the same
 * query the screens use. An element whose role this does not know is reported
 * rather than skipped: a silent skip is a control nobody checked.
 */
function roleOf(element: Element): string | undefined {
  const explicit = element.getAttribute("role");

  if (explicit !== null) {
    return explicit;
  }

  switch (element.tagName.toLowerCase()) {
    case "button":
      return "button";
    case "a":
      return "link";
    case "select":
      return "combobox";
    case "textarea":
      return "textbox";
    case "input":
      return element.getAttribute("type") === "checkbox"
        ? "checkbox"
        : "textbox";
    default:
      return undefined;
  }
}

/** `<button class="mc-iconbtn">`, enough to find the control in the source. */
function describeElement(element: Element): string {
  const classes = element.getAttribute("class");

  return `<${element.tagName.toLowerCase()}${classes === null ? "" : ` class="${classes}"`}>`;
}

function controlsOf(container: HTMLElement): readonly Element[] {
  return [...container.querySelectorAll(FOCUSABLE)];
}

function unnamedControls(name: string, container: HTMLElement): string[] {
  const findings: string[] = [];

  for (const control of controlsOf(container)) {
    const role = roleOf(control);

    if (role === undefined) {
      findings.push(
        `${name}: ${describeElement(control)} is focusable and this sweep does not know its role, so its name was never checked`,
      );
      continue;
    }

    const named = within(container).queryAllByRole(role, { name: NON_EMPTY });

    if (!named.includes(control as HTMLElement)) {
      findings.push(
        `${name}: ${describeElement(control)} has role "${role}" and no accessible name`,
      );
    }
  }

  return findings;
}

describe("REQ-116: every interactive control has an accessible name", () => {
  it("has a specimen for every component the system exports", () => {
    // Guards the sweep itself: a component added without a specimen would be
    // a component this file never renders and never checks.
    const exported = Object.entries(system)
      .filter(
        ([name, value]) =>
          typeof value === "function" && /^[A-Z]/.test(name.charAt(0)),
      )
      .map(([name]) => name)
      .sort();

    expect(exported).toEqual([...SPECIMENS].map(({ name }) => name).sort());
    // Twenty-one ported from the design system, and six added since:
    // `TrendChart` is the visual reading REQ-154 asks the panel for, and the
    // prototype had no chart of any kind; `FileUpload` and `AssetGrid` are the
    // resource controls REQ-290 and REQ-291 replaced a dropdown of names with;
    // `Toast` is where the answer to a write goes since REQ-312, and the
    // prototype answered a write with a band at the top of the page;
    // `ButtonLink` owns destinations with a button shape (REQ-351); `Brand` is
    // the product's name set in type, which is the mark while there is no logo
    // (REQ-331), and the square it replaced was drawn by the rail itself.
    expect(exported).toHaveLength(27);
  });

  it("renders a control in every component that is supposed to have one", () => {
    const found = SPECIMENS.flatMap((specimen) => {
      const { name, element } = specimen;
      const { container, unmount } = render(element);
      const controls = controlsOf(drawnIn(container, specimen)).length;
      unmount();

      return controls === 0 ? [] : [name];
    });

    // Both directions on purpose. A specimen that renders nothing would pass
    // the name sweep by having nothing to name, and a component that grew a
    // control nobody declared is a control nobody thought about.
    expect(found).toEqual(WITH_CONTROLS);
  });

  it("names every focusable element of every component", () => {
    const findings = SPECIMENS.flatMap((specimen) => {
      const { name, element } = specimen;
      const { container, unmount } = render(element);
      const unnamed = unnamedControls(name, drawnIn(container, specimen));
      unmount();

      return unnamed;
    });

    expect(findings).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * The focus indicator, which is a rule of the system
 * ------------------------------------------------------------------ */

/**
 * Every source of the interface, as text, read through the same mechanism
 * `styles/tokens.test.ts` uses: this program has the DOM and no Node types, so
 * `node:fs` is not available here and would not typecheck.
 */
const WEB_SOURCES = import.meta.glob<string>("../**/*.{ts,tsx,css}", {
  eager: true,
  query: "?raw",
  import: "default",
});

const GLOB_BASE = "src/web/components";

function repositoryPath(globKey: string): string {
  const segments = GLOB_BASE.split("/");

  for (const step of globKey.split("/")) {
    if (step === "..") {
      segments.pop();
    } else if (step !== ".") {
      segments.push(step);
    }
  }

  return segments.join("/");
}

/**
 * The files the focus sweep reads: everything but the tests.
 *
 * A test is excluded for the same reason the literal guardian excludes them: a
 * check that hunts for a removed outline has to carry the words "outline: none"
 * in its own fixtures, and finding itself is not a finding.
 */
const WEB_FILES: readonly (readonly [string, string])[] = Object.entries(
  WEB_SOURCES,
)
  .map(([key, source]): readonly [string, string] => [
    repositoryPath(key),
    source,
  ])
  .filter(([path]) => !/\.test\.tsx?$/.test(path))
  .sort(([a], [b]) => a.localeCompare(b));

/** `outline: none`, `outline: 0`, and the two long hands that mean the same. */
const FOCUS_REMOVAL = /outline(?:-(?:width|style))?\s*:\s*(?:none|0)\b/gi;

/** What may legitimately replace it: a ring drawn with a shadow. */
const REPLACEMENT = /box-shadow\s*:/i;

/**
 * The rule that contains `at`, read between its braces.
 *
 * Flat blocks only, which is all this stylesheet has: no nesting, and the
 * at-rules it does use (`@media`, `@keyframes`) wrap whole rules rather than
 * declarations.
 */
function ruleAround(source: string, at: number): string {
  const open = source.lastIndexOf("{", at);
  const close = source.indexOf("}", at);

  return source.slice(open + 1, close === -1 ? source.length : close);
}

function focusRemovals(path: string, source: string): readonly string[] {
  return [...source.matchAll(FOCUS_REMOVAL)].flatMap((match) => {
    if (REPLACEMENT.test(ruleAround(source, match.index))) {
      return [];
    }

    const line = source.slice(0, match.index).split("\n").length;

    return [
      `${path}:${line} removes the focus indicator (${match[0]}) and puts none back`,
    ];
  });
}

describe("REQ-116: the focus indicator is applied by the system", () => {
  it("declares the indicator once, for everything", () => {
    const base = WEB_FILES.find(
      ([path]) => path === "src/web/styles/tokens/base.css",
    );

    expect(base, "the document rules are missing").toBeDefined();

    const rules = base?.[1] ?? "";
    const focusRule = rules.slice(rules.indexOf(":focus-visible"));

    // `:focus-visible` rather than `:focus`, so a control clicked with a mouse
    // does not get a ring, and a control reached with Tab always does.
    expect(focusRule).toContain("outline:");
    expect(focusRule).toContain("var(--rule-focus)");
  });

  it("reads the real files of the interface", () => {
    const paths = WEB_FILES.map(([path]) => path);

    // Guards the sweep: a glob that matched nothing would report success
    // forever, which is the one way a check fails without saying so.
    expect(paths).toContain("src/web/components/components.css");
    expect(paths).toContain("src/web/components/Button.tsx");
    expect(paths).toContain("src/web/styles/app.css");
    expect(paths.length).toBeGreaterThan(20);

    for (const [path, source] of WEB_FILES) {
      expect(source.length, path).toBeGreaterThan(0);
    }
  });

  it("finds a removal, and accepts one that puts a ring back", () => {
    // The detector proved on fixtures, so a green sweep below means the files
    // are clean and not that the pattern stopped matching.
    expect(focusRemovals("f.css", ".a:focus { outline: none; }")).toHaveLength(
      1,
    );
    expect(focusRemovals("f.css", ".a:focus { outline: 0; }")).toHaveLength(1);
    expect(
      focusRemovals(
        "f.css",
        ".a:focus { outline: none; box-shadow: var(--ring-focus); }",
      ),
    ).toHaveLength(0);
    expect(
      focusRemovals("f.css", ".a:focus { outline-offset: 1px; }"),
    ).toHaveLength(0);
  });

  it("keeps the indicator in every file of the interface", () => {
    const findings = WEB_FILES.flatMap(([path, source]) =>
      focusRemovals(path, source),
    );

    expect(findings).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * Operation by keyboard, where the component implements it
 * ------------------------------------------------------------------ */

describe("REQ-116: the components are operable by keyboard", () => {
  it("removes a keyword with Tab and Enter (Chip)", async () => {
    const user = userEvent.setup();
    const removed: string[] = [];

    render(
      <Chip
        mono
        onRemove={() => removed.push(word("chip.word"))}
        removeLabel={word("chip.remove")}
      >
        {word("chip.word")}
      </Chip>,
    );

    await user.tab();

    expect(
      within(document.body).getByRole("button", { name: word("chip.remove") }),
    ).toHaveFocus();

    await user.keyboard("{Enter}");

    expect(removed).toEqual([word("chip.word")]);
  });

  it("takes focus when it opens and closes on Escape (Modal)", async () => {
    const user = userEvent.setup();
    let closed = 0;

    render(
      <Modal
        title={word("modal.title")}
        onClose={() => {
          closed += 1;
        }}
        closeLabel={word("modal.close")}
      >
        {word("modal.body")}
      </Modal>,
    );

    // Focus lands inside the dialog, so the next Tab walks the dialog's own
    // controls instead of the page underneath it.
    const dialog = within(document.body).getByRole("dialog", {
      name: word("modal.title"),
    });

    expect(dialog).toHaveFocus();

    await user.tab();

    expect(
      within(document.body).getByRole("button", { name: word("modal.close") }),
    ).toHaveFocus();

    await user.keyboard("{Escape}");

    expect(closed).toBe(1);
  });

  it("gives focus back to the control that opened it when it closes (Modal)", async () => {
    const user = userEvent.setup();

    function Opener(): ReactElement {
      const [open, setOpen] = useState(false);

      return (
        <>
          <Button onClick={() => setOpen(true)}>{word("opener")}</Button>
          {open ? (
            <Modal
              title={word("modal.title")}
              onClose={() => setOpen(false)}
              closeLabel={word("modal.close")}
            >
              {word("modal.body")}
            </Modal>
          ) : null}
        </>
      );
    }

    render(<Opener />);

    const opener = within(document.body).getByRole("button", {
      name: word("opener"),
    });

    await user.click(opener);
    await user.keyboard("{Escape}");

    // Not `body`: the operator is put back where they were, so the control
    // they pressed is the one the next Tab or Enter acts on (REQ-303).
    expect(
      within(document.body).queryByRole("dialog", {
        name: word("modal.title"),
      }),
    ).toBeNull();
    expect(opener).toHaveFocus();
  });

  it("draws no close control in the head when the way out is in the footer (Modal)", () => {
    render(
      <Modal
        title={word("modal.title")}
        onClose={() => undefined}
        footer={<Button variant="secondary">{word("modal.footer")}</Button>}
      >
        {word("modal.body")}
      </Modal>,
    );

    const dialog = within(document.body).getByRole("dialog", {
      name: word("modal.title"),
    });

    expect(
      (dialog.querySelector(".mc-modal__head") as HTMLElement).querySelector(
        "button",
      ),
    ).toBeNull();
    expect(
      within(dialog.querySelector(".mc-modal__foot") as HTMLElement).getByRole(
        "button",
        { name: word("modal.footer") },
      ),
    ).toBeInTheDocument();
  });

  it("commits a keyword with Enter and with a comma (KeywordField)", async () => {
    const user = userEvent.setup();
    const added: string[] = [];

    render(
      <Field id="keywords" label={word("keywords.label")}>
        <KeywordField
          id="keywords"
          keywords={[]}
          onAdd={(keyword) => added.push(keyword)}
          removeLabel={(keyword) => `${word("keywords.remove")} ${keyword}`}
        />
      </Field>,
    );

    const input = within(document.body).getByRole("textbox", {
      name: word("keywords.label"),
    });

    await user.click(input);
    await user.keyboard(`${word("kw.one")}{Enter}`);
    await user.keyboard(`${word("kw.two")},`);

    expect(added).toEqual([word("kw.one"), word("kw.two")]);
  });

  it("chooses a publication with Tab and Enter (PublicationGrid)", async () => {
    const user = userEvent.setup();
    const chosen: string[] = [];

    render(
      <PublicationGrid
        items={[
          {
            id: word("grid.first"),
            mediaType: word("grid.type"),
            publishedLabel: word("grid.date"),
          },
        ]}
        onSelect={(id) => chosen.push(id)}
        selectLabel={(id) => `${word("grid.select")} ${id}`}
        thumbnailAlt={(id) => `${word("grid.alt")} ${id}`}
        brokenLabel={word("grid.broken")}
      />,
    );

    await user.tab();
    await user.keyboard("{Enter}");

    expect(chosen).toEqual([word("grid.first")]);
  });

  it("reaches a destination with Tab and Enter (AppNav)", async () => {
    const user = userEvent.setup();
    const asked: string[] = [];

    render(
      <AppNav
        label={word("nav.label")}
        brandLead={word("nav.brandLead")}
        brandAccent={word("nav.brandAccent")}
        current="/dashboard"
        onNavigate={(id) => asked.push(id)}
        items={[
          {
            id: "/dashboard",
            href: "/dashboard",
            label: word("nav.dashboard"),
            icon: "layout-dashboard",
          },
          {
            id: "/flows",
            href: "/flows",
            label: word("nav.flows"),
            icon: "workflow",
          },
        ]}
      />,
    );

    await user.tab();
    await user.tab();
    await user.keyboard("{Enter}");

    expect(asked).toEqual(["/flows"]);
  });

  it("marks the screen on show programmatically, not only in colour (AppNav)", () => {
    render(
      <AppNav
        label={word("nav.label")}
        brandLead={word("nav.brandLead")}
        brandAccent={word("nav.brandAccent")}
        current="/flows"
        items={[
          {
            id: "/dashboard",
            href: "/dashboard",
            label: word("nav.dashboard"),
            icon: "layout-dashboard",
          },
          {
            id: "/flows",
            href: "/flows",
            label: word("nav.flows"),
            icon: "workflow",
          },
        ]}
      />,
    );

    expect(
      within(document.body).getByRole("link", { name: word("nav.flows") }),
    ).toHaveAttribute("aria-current", "page");
  });
});

/* ------------------------------------------------------------------ *
 * Confirmations and chips: one visible exit, interface pills
 * ------------------------------------------------------------------ */

describe("REQ-374: confirmations have one visible exit in their footer", () => {
  it("puts the decline button in the footer and does not duplicate it as a header X", () => {
    render(
      <ConfirmDialog
        title={word("confirm.title")}
        consequence={word("confirm.consequence")}
        confirmLabel={word("confirm.commit")}
        cancelLabel={word("confirm.cancel")}
        onConfirm={() => undefined}
        onCancel={() => undefined}
      />,
    );

    const dialog = within(document.body).getByRole("dialog", {
      name: word("confirm.title"),
    });
    const head = dialog.querySelector(".mc-modal__head") as HTMLElement;
    const foot = dialog.querySelector(".mc-modal__foot") as HTMLElement;

    expect(head.querySelector("button")).toBeNull();
    expect(
      within(foot).getByRole("button", { name: word("confirm.cancel") }),
    ).toBeInTheDocument();
    expect(
      within(foot).getByRole("button", { name: word("confirm.commit") }),
    ).toBeInTheDocument();
  });
});

describe("REQ-375: chips are pills except a quoted quick reply", () => {
  it("keeps interface chips pill-shaped and preserves the conversation reply shape", () => {
    const interfaceChip = bodiesOf(".mc-chip")[0] ?? "";
    const phrase = bodiesOf(".mc-chip--phrase")[0] ?? "";
    const quotedReply = bodiesOf(".mc-phone .mc-chip")[0] ?? "";

    expect(cornerOf(interfaceChip)).toBe(
      resolved("var(--radius-pill)", APPLICATION_TOKENS),
    );
    expect(cornerOf(phrase)).toBe(
      resolved("var(--radius-pill)", APPLICATION_TOKENS),
    );
    expect(cornerOf(quotedReply)).toBe(
      resolved("var(--radius-sm)", APPLICATION_TOKENS),
    );
  });

  it("would catch a quick reply accidentally promoted to an interface pill", () => {
    const stale = (bodiesOf(".mc-phone .mc-chip")[0] ?? "").replace(
      "border-radius: var(--radius-sm);",
      "border-radius: var(--radius-pill);",
    );

    expect(cornerOf(stale)).not.toBe(
      resolved("var(--radius-sm)", APPLICATION_TOKENS),
    );
  });

  it("keeps the quoted quick reply separate from the centred phrase pill", () => {
    const phrase = bodiesOf(".mc-chip--phrase")[0] ?? "";
    const quotedReply = bodiesOf(".mc-phone .mc-chip")[0] ?? "";

    expect(phrase).toContain("align-items: center;");
    expect(quotedReply).not.toContain("align-items: center;");
    expect(cornerOf(quotedReply)).toBe(
      resolved("var(--radius-sm)", APPLICATION_TOKENS),
    );
  });
});

/* ------------------------------------------------------------------ *
 * The rail intercepts the click that replaces the screen, and no other
 * ------------------------------------------------------------------ */

/**
 * REQ-295: a destination of the rail is a link before it is a router.
 *
 * The rail used to answer EVERY click on a destination with `preventDefault`,
 * so a modified click, which asks the browser for another tab, changed the
 * screen in this one instead and opened nothing. That was already a defect, and
 * a screen that can hold its exits turns it into a worse one: the editor asks
 * the operator whether to discard their work over a click that would have left
 * the editor exactly where it was, with the work still in it.
 *
 * The rule is the navigator's own and is not copied into the rail: this is the
 * one destination in the interface that does not route through `follow`.
 */
describe("REQ-295: the rail keeps a modified click for the browser", () => {
  const items = [
    {
      id: "/dashboard",
      href: "/dashboard",
      label: word("nav.dashboard"),
      icon: "layout-dashboard" as const,
    },
  ];

  function railTo(asked: string[]): ReactElement {
    return (
      <AppNav
        label={word("nav.label")}
        brandLead={word("nav.brandLead")}
        brandAccent={word("nav.brandAccent")}
        current="/dashboard"
        onNavigate={(id) => asked.push(id)}
        items={items}
      />
    );
  }

  /**
   * Clicks the destination and answers whether the rail took the click.
   *
   * Read from a listener of the document, which runs after the rail's own: an
   * intercepted click is one whose default is already prevented by the time it
   * gets there. The click is then stopped whatever the answer was, because this
   * emulated DOM cannot follow a link and prints a paragraph about it over a
   * suite that is behaving exactly as it should.
   */
  function tookTheClick(modifier: MouseEventInit = {}): boolean {
    let intercepted = false;
    const record = (event: MouseEvent): void => {
      intercepted = event.defaultPrevented;
      event.preventDefault();
    };

    document.addEventListener("click", record);
    fireEvent.click(
      screen.getByRole("link", { name: word("nav.dashboard") }),
      modifier,
    );
    document.removeEventListener("click", record);

    return intercepted;
  }

  it("routes the ordinary activation in the page", () => {
    const asked: string[] = [];

    render(railTo(asked));

    expect(tookTheClick()).toBe(true);
    expect(asked).toEqual(["/dashboard"]);
  });

  it.each([
    ["meta", { metaKey: true }],
    ["ctrl", { ctrlKey: true }],
    ["shift", { shiftKey: true }],
  ])("leaves a %s click to the browser", (_name, modifier) => {
    const asked: string[] = [];

    render(railTo(asked));

    // The default stands, so the browser does what the address says, and the
    // rail asked the application for nothing at all: no screen is replaced, so
    // no screen has anything to be asked about.
    expect(tookTheClick(modifier)).toBe(false);
    expect(asked).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * Colour is never the only carrier (acceptance criterion 23)
 * ------------------------------------------------------------------ */

describe("REQ-116: the state is in words beside any tone", () => {
  it.each(["normal", "attention", "critical"] as const)(
    "spells the status out at the %s level (CapMeter)",
    (status) => {
      render(
        <CapMeter
          name={word("cap.name")}
          used={86}
          limit={100}
          status={status}
          statusLabel={word(`cap.${status}`)}
          usageLabel={word("cap.usage")}
        />,
      );

      const meter = within(document.body).getByRole("meter");

      // The word is on screen, and it is part of what the meter announces:
      // the fill's colour says the same thing to whoever can see colour.
      expect(
        within(document.body).getByText(word(`cap.${status}`)),
      ).toBeVisible();
      expect(meter).toHaveAccessibleName(
        `${word("cap.name")} ${word("cap.usage")} ${word(`cap.${status}`)}`,
      );
    },
  );
});

/* ------------------------------------------------------------------ *
 * What a screen reader is told about a field
 * ------------------------------------------------------------------ */

describe("REQ-148: the optional marker is a word beside the label", () => {
  it("announces two words and not one glued string (Field)", () => {
    render(
      <Field
        id="asset"
        label={word("field.label")}
        optional
        optionalLabel={word("field.optional")}
      />,
    );

    // Two words with a boundary between them. The dot that separates them on
    // screen is drawn by the stylesheet, and generated content is not text a
    // name is built from: read off the label, the two are one word nobody
    // wrote, and that is what a screen reader would say.
    expect(within(document.body).getByRole("textbox")).toHaveAccessibleName(
      `${word("field.label")} ${word("field.optional")}`,
    );
  });

  it("says nothing extra when the field is not optional (Field)", () => {
    render(<Field id="asset" label={word("field.label")} />);

    expect(within(document.body).getByRole("textbox")).toHaveAccessibleName(
      word("field.label"),
    );
  });

  it("names a nested control the same two ways (Field + Select)", () => {
    render(
      <Field
        id="flow"
        label={word("select.label")}
        optional
        optionalLabel={word("field.optional")}
      >
        <Select
          id="flow"
          options={[{ value: "standard", label: word("select.option") }]}
        />
      </Field>,
    );

    // The marker belongs to the field and not to the input the field happens
    // to render, so a control handed to it as `children` is named the same way.
    expect(within(document.body).getByRole("combobox")).toHaveAccessibleName(
      `${word("select.label")} ${word("field.optional")}`,
    );
  });
});

describe("REQ-149: a nested control carries the refusal of its field", () => {
  /** The nested control of the pair the design system prescribes. */
  function nestedSelect(props: {
    readonly error?: string;
    readonly hint?: string;
    readonly describedBy?: string;
  }): ReactElement {
    return (
      <Field
        id="flow"
        label={word("select.label")}
        error={props.error}
        hint={props.hint}
      >
        <Select
          id="flow"
          aria-describedby={props.describedBy}
          options={[{ value: "standard", label: word("select.option") }]}
        />
      </Field>
    );
  }

  function control(): HTMLElement {
    return within(document.body).getByRole("combobox", {
      name: word("select.label"),
    });
  }

  it("describes the control by the message the field renders", () => {
    render(nestedSelect({ error: word("field.error") }));

    // Both halves: the wiring, and what that wiring makes the control say. A
    // control pointing at an id nobody rendered describes nothing.
    expect(control()).toHaveAttribute("aria-describedby", "flow-error");
    expect(control()).toHaveAccessibleDescription(word("field.error"));
    expect(control()).toHaveAttribute("aria-invalid", "true");
  });

  it("hands over the hint as well, in the field's own order", () => {
    render(
      nestedSelect({ error: word("field.error"), hint: word("field.hint") }),
    );

    // The refusal first: it is the thing that changed.
    expect(control()).toHaveAttribute(
      "aria-describedby",
      "flow-error flow-field-hint",
    );
    expect(control()).toHaveAccessibleDescription(
      `${word("field.error")} ${word("field.hint")}`,
    );
  });

  it("marks nothing invalid while the field is not refused", () => {
    render(nestedSelect({ hint: word("field.hint") }));

    expect(control()).toHaveAttribute("aria-describedby", "flow-field-hint");
    expect(control()).not.toHaveAttribute("aria-invalid");
  });

  it("keeps a description the control already had, and repeats no id", () => {
    render(
      nestedSelect({ error: word("field.error"), describedBy: "flow-error" }),
    );

    // A screen that wired the message itself, from outside: the id is the one
    // the field composes, so joining the two blindly would have it announced
    // twice.
    expect(control()).toHaveAttribute("aria-describedby", "flow-error");

    render(nestedSelect({ error: word("field.error"), describedBy: "aside" }));

    expect(
      within(document.body).getAllByRole("combobox").at(-1),
    ).toHaveAttribute("aria-describedby", "aside flow-error");
  });
});

/**
 * Every control the design system prescribes for nesting in a `Field`, with the
 * ROLE of the element a keyboard lands on, because that element is where the
 * wiring has to arrive: a component that keeps it on the wrapper it renders, or
 * drops it in its own signature, describes nobody who is not looking at the
 * screen.
 *
 * All three, and not the one the pair is usually shown with: the defect this
 * covers was two components failing for OPPOSITE reasons (one forwarding
 * nothing, one letting what arrived overwrite what it had), and a suite that
 * exercises a single control finds neither.
 */
const NESTED_CONTROLS: readonly {
  readonly name: string;
  readonly role: string;
  readonly control: ReactElement;
}[] = [
  {
    name: "Select",
    role: "combobox",
    control: (
      <Select
        id="nested"
        options={[{ value: "standard", label: word("select.option") }]}
      />
    ),
  },
  {
    name: "TextArea",
    role: "textbox",
    control: <TextArea id="nested" label={word("textarea.label")} />,
  },
  {
    name: "KeywordField",
    role: "textbox",
    control: (
      <KeywordField
        id="nested"
        keywords={[word("keywords.first")]}
        onAdd={() => undefined}
        onRemove={() => undefined}
        removeLabel={(keyword) => `${word("keywords.remove")} ${keyword}`}
      />
    ),
  },
];

describe("REQ-185: the field's wiring reaches every control it nests", () => {
  it.each(NESTED_CONTROLS)(
    "describes $name by the refusal and the hint of its field",
    ({ role, control }) => {
      render(
        <Field
          id="nested"
          label={word("field.label")}
          error={word("field.error")}
          hint={word("field.hint")}
        >
          {control}
        </Field>,
      );

      const focusable = within(document.body).getByRole(role);

      // Both halves, as with any wiring: the ids, and what the control says
      // because of them. The refusal comes first, being what changed.
      expect(focusable).toHaveAttribute(
        "aria-describedby",
        "nested-error nested-field-hint",
      );
      expect(focusable).toHaveAccessibleDescription(
        `${word("field.error")} ${word("field.hint")}`,
      );
      expect(focusable).toHaveAttribute("aria-invalid", "true");
    },
  );

  it.each(NESTED_CONTROLS)(
    "marks $name invalid never on its own account",
    ({ role, control }) => {
      render(
        <Field
          id="nested"
          label={word("field.label")}
          hint={word("field.hint")}
        >
          {control}
        </Field>,
      );

      const focusable = within(document.body).getByRole(role);

      expect(focusable).toHaveAttribute(
        "aria-describedby",
        "nested-field-hint",
      );
      expect(focusable).not.toHaveAttribute("aria-invalid");
    },
  );

  /** The box refused path by path, inside a field that was also refused. */
  function refusedTextArea(error?: string): ReactElement {
    return (
      <Field id="nested" label={word("field.label")} error={error}>
        <TextArea
          id="nested"
          label={word("textarea.label")}
          issues={[
            { path: word("textarea.path"), message: word("textarea.message") },
          ]}
          issuesTitle={word("textarea.issues")}
        />
      </Field>
    );
  }

  it("announces the box's own refusals beside the field's (TextArea)", () => {
    render(refusedTextArea(word("field.error")));

    const textarea = within(document.body).getByRole("textbox");

    // Two refusals about one field, composed in two places: the field's
    // message, and the list of paths the instance itself named. Whichever of
    // them wins alone, the operator is told half of why nothing was written.
    expect(textarea).toHaveAttribute(
      "aria-describedby",
      "nested-issues nested-error",
    );
    expect(textarea).toHaveAccessibleDescription(
      new RegExp(
        `${word("textarea.message")}[\\s\\S]*${word("field.error")}`,
        "u",
      ),
    );
  });

  it("stays invalid on its own refusals when the field has none", () => {
    render(refusedTextArea());

    // The field is not refused and hands down an `aria-invalid` of nothing.
    // The definition in the box IS refused, and that is not the field's to
    // erase.
    expect(within(document.body).getByRole("textbox")).toHaveAttribute(
      "aria-invalid",
      "true",
    );
  });
});

describe("REQ-212: nested hints keep distinct relationships", () => {
  it("describes a TextArea by both its own hint and the Field hint", () => {
    render(
      <Field
        id="nested-hints"
        label={word("field.label")}
        hint={word("field.hint")}
      >
        <TextArea
          id="nested-hints"
          label={word("textarea.label")}
          hint={word("textarea.hint")}
        />
      </Field>,
    );

    const textarea = within(document.body).getByRole("textbox");

    expect(textarea).toHaveAttribute(
      "aria-describedby",
      "nested-hints-textarea-hint nested-hints-field-hint",
    );
    expect(
      document.getElementById("nested-hints-textarea-hint"),
    ).toHaveTextContent(word("textarea.hint"));
    expect(
      document.getElementById("nested-hints-field-hint"),
    ).toHaveTextContent(word("field.hint"));
    expect(textarea).toHaveAccessibleDescription(
      `${word("textarea.hint")} ${word("field.hint")}`,
    );
  });
});

/**
 * REQ-267: the tip is a second sentence, in a second PLACE.
 *
 * `Field` and `TextArea` already carried a hint, and the temptation was to
 * reuse it. The two say different things at different moments: the tip says
 * what the option is FOR and is read before anything is typed, so it goes under
 * the label; the hint reports on the ANSWER (a ceiling, a format) and goes
 * under the control. In one slot the two take turns being in the wrong place.
 */
describe("REQ-267: the tip sits under the label, the hint under the control", () => {
  it("draws the Field's tip between the label and the control, and describes with both", () => {
    render(
      <Field
        id="tipped"
        label={word("field.label")}
        tip={word("field.tip")}
        hint={word("field.hint")}
      />,
    );

    const control = within(document.body).getByRole("textbox");
    const tip = document.getElementById("tipped-field-tip");

    expect(tip).toHaveTextContent(word("field.tip"));
    // Between the two, in the document itself: an order asserted on the ids
    // alone would pass with the sentence rendered at the foot of the page.
    expect(tip?.previousElementSibling?.textContent).toContain(
      word("field.label"),
    );
    expect(tip?.nextElementSibling).toBe(control);
    expect(control).toHaveAttribute(
      "aria-describedby",
      "tipped-field-tip tipped-field-hint",
    );
  });

  it("puts the refusal first, then the tip, then the hint", () => {
    render(
      <Field
        id="refused"
        label={word("field.label")}
        tip={word("field.tip")}
        hint={word("field.hint")}
        error={word("field.error")}
      />,
    );

    // What CHANGED is announced first: the refusal is why the operator is
    // reading this field again at all.
    expect(
      within(document.body).getByRole("textbox"),
    ).toHaveAccessibleDescription(
      `${word("field.error")} ${word("field.tip")} ${word("field.hint")}`,
    );
  });

  it("draws the TextArea's tip under its own label, beside its own hint", () => {
    render(
      <TextArea
        id="tipped-area"
        label={word("textarea.label")}
        tip={word("textarea.tip")}
        hint={word("textarea.hint")}
      />,
    );

    const control = within(document.body).getByRole("textbox");
    const tip = document.getElementById("tipped-area-textarea-tip");

    expect(tip).toHaveTextContent(word("textarea.tip"));
    expect(tip?.previousElementSibling?.textContent).toContain(
      word("textarea.label"),
    );
    expect(tip?.nextElementSibling).toBe(control);
    expect(control).toHaveAccessibleDescription(
      `${word("textarea.tip")} ${word("textarea.hint")}`,
    );
  });
});

/* ------------------------------------------------------------------ *
 * REQ-198: a class from outside adds, and never replaces
 * ------------------------------------------------------------------ */

/**
 * The same three controls, and the same shape of defect as REQ-185: two of them
 * spread `rest` AFTER the class they had composed, so a `className` from a
 * caller did not add to the control's styling, it took the place of it. The
 * control kept working and stopped looking like itself, which is the failure a
 * green suite is happiest to keep.
 *
 * `Select` is here having always been right (it destructures `className` and
 * folds it in): the pin is over the FAMILY, so the one that already held is
 * what keeps the other two from drifting back.
 *
 * Each control is listed with the class it composes for itself, because
 * asserting only that the outside class survived would pass for a component
 * that dropped its own and kept the visitor.
 */
const OUTSIDE_CLASS = "mc-probe";

const CLASSED_CONTROLS: readonly {
  readonly name: string;
  readonly role: string;
  readonly own: readonly string[];
  readonly control: ReactElement;
}[] = [
  {
    name: "Select",
    role: "combobox",
    own: ["mc-input", "mc-select"],
    control: (
      <Select
        id="classed"
        className={OUTSIDE_CLASS}
        options={[{ value: "standard", label: word("select.option") }]}
      />
    ),
  },
  {
    name: "TextArea",
    role: "textbox",
    own: ["mc-input", "mc-textarea"],
    control: (
      <TextArea
        id="classed"
        className={OUTSIDE_CLASS}
        label={word("textarea.label")}
      />
    ),
  },
  {
    name: "KeywordField",
    role: "textbox",
    own: ["mc-keywords__input"],
    control: (
      <KeywordField
        id="classed"
        className={OUTSIDE_CLASS}
        keywords={[word("keywords.first")]}
        onAdd={() => undefined}
        onRemove={() => undefined}
        removeLabel={(keyword) => `${word("keywords.remove")} ${keyword}`}
      />
    ),
  },
];

describe("REQ-198: a caller's class adds to a control's own", () => {
  it.each(CLASSED_CONTROLS)(
    "keeps $name styled as itself while carrying the class it was given",
    ({ role, own, control }) => {
      render(control);

      const focusable = within(document.body).getByRole(role);
      const classes = (focusable.getAttribute("class") ?? "").split(/\s+/);

      expect(classes).toContain(OUTSIDE_CLASS);

      for (const name of own) {
        expect(classes, `${name} survived the caller's class`).toContain(name);
      }
    },
  );

  it.each(NESTED_CONTROLS)(
    "leaves $name's class clean when given none",
    ({ role, control }) => {
      // The other direction, and the reason `.filter(Boolean)` is in each of
      // the three: given nothing, a naive join writes the empty string into the
      // attribute (`"mc-input mc-textarea "`). Harmless to the cascade and a
      // slow way to make every later class assertion a guessing game, so it is
      // held here rather than left to whoever reads the DOM next.
      render(control);

      const attribute =
        within(document.body).getByRole(role).getAttribute("class") ?? "";

      expect(attribute).toBe(attribute.trim());
      expect(attribute).not.toMatch(/\s{2,}/u);
    },
  );
});

/* ------------------------------------------------------------------ *
 * The bars of a counting table, sized by the count
 * ------------------------------------------------------------------ */

/**
 * The bar of every numeric cell, in reading order, in pixels.
 *
 * `undefined` where a cell drew none, so an erased bar is told apart from a
 * short one instead of shifting every index after it.
 */
function barWidths(container: HTMLElement): readonly (number | undefined)[] {
  return [...container.querySelectorAll("tbody td")].map((cell) => {
    const bar = cell.querySelector<HTMLElement>(".mc-table__bar");

    return bar === null ? undefined : Number.parseFloat(bar.style.width);
  });
}

function countingTable(cells: readonly (number | string)[]): ReactElement {
  return (
    <DataTable
      bars
      columns={[
        { key: "period", label: word("table.period") },
        { key: "comment", label: word("table.comments") },
      ]}
      rows={cells.map((value, index) => ({
        key: `${index}`,
        label: word("table.hour"),
        cells: { comment: value },
      }))}
    />
  );
}

describe("REQ-155: the bars are sized by the count, not by its text", () => {
  // The languages the catalogue ships, formatted by the same Intl the screens
  // use: in English the thousands separator is a comma and in Portuguese it is
  // a full stop, which is exactly what a bar read out of the text trips on.
  it.each(["en", "pt-BR"] as const)(
    "keeps every bar, in order and in proportion, under %s",
    (locale) => {
      const format = new Intl.NumberFormat(locale);
      const counts = [1234, 617, 12];
      const { container } = render(
        countingTable(counts.map((count) => format.format(count))),
      );
      const widths = barWidths(container);

      // Nothing erased: a four-digit cell formatted for its locale is not a
      // number `Number()` can read, and one unreadable cell used to flatten
      // the whole table through the maximum.
      expect(widths.filter((width) => width === undefined)).toEqual([]);
      expect(widths.every((width) => (width ?? 0) > 0)).toBe(true);

      // Nothing inverted: the largest count draws the longest bar.
      expect(widths[0]).toBeGreaterThan(widths[1] ?? 0);
      expect(widths[1]).toBeGreaterThan(widths[2] ?? 0);

      // And proportional to the count rather than to anything about the text:
      // 1234 is twice 617, whatever the punctuation between the digits.
      expect((widths[0] ?? 0) / (widths[1] ?? 1)).toBeCloseTo(2, 1);
    },
  );

  it("sizes a plain number exactly as it sizes its formatted text", () => {
    const { container: asNumbers } = render(countingTable([1234, 617]));
    const { container: asText } = render(countingTable(["1.234", "617"]));

    expect(barWidths(asText)).toEqual(barWidths(asNumbers));
  });

  it("draws no bar for a cell that is no count, and erases none", () => {
    const { container } = render(countingTable([1234, word("table.dash")]));
    const [counted, uncountable] = barWidths(container);

    // The unreadable cell is sized by nothing rather than by zero, and the one
    // beside it is still drawn: what a component cannot measure it leaves out
    // of the comparison instead of flattening it.
    expect(counted).toBeGreaterThan(0);
    expect(uncountable).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ *
 * The strips of a drawing, on one scale
 * ------------------------------------------------------------------ */

/** Every column of a strip, in period order, in percent of the plot. */
function columnHeights(
  container: HTMLElement,
  series: string,
): readonly (number | undefined)[] {
  const strip = container.querySelector(`[data-series="${series}"]`);

  return [...(strip?.querySelectorAll<HTMLElement>("[data-count]") ?? [])].map(
    (slot) => {
      const bar = slot.querySelector<HTMLElement>(".mc-trend__bar");

      return bar === null ? undefined : Number.parseFloat(bar.style.height);
    },
  );
}

function drawing(
  series: readonly (readonly [string, readonly number[]])[],
): ReactElement {
  return (
    <TrendChart
      label={word("trend.label")}
      axes={{ x: word("trend.axis.x"), y: word("trend.axis.y") }}
      periods={[word("trend.first"), word("trend.second")]}
      series={series.map(([key, counts]) => ({
        key,
        label: word(`trend.${key}`),
        counts,
        peakLabel: word("trend.peak"),
      }))}
    />
  );
}

describe("REQ-154: the strips of one drawing share one scale", () => {
  it("measures every strip against the largest count of the drawing", () => {
    const { container } = render(
      drawing([
        ["comment", [4, 1]],
        ["message", [2, 1]],
      ]),
    );

    // Four is the tallest count anywhere in the drawing, so it is a full
    // column, and two is half of it IN THE STRIP BELOW. Measured strip by
    // strip, the two would both be full and a reader would conclude the two
    // types ran level.
    expect(columnHeights(container, "comment")).toEqual([100, 25]);
    expect(columnHeights(container, "message")).toEqual([50, 25]);
  });

  it("keeps the slot of a period that counted nothing, and draws no column", () => {
    const { container } = render(drawing([["comment", [3, 0]]]));

    // The slot stays, so the strip has one place per period and a zero reads as
    // an empty place on the baseline rather than as a period that vanished.
    expect(columnHeights(container, "comment")).toEqual([100, undefined]);
    expect(
      container.querySelectorAll('[data-series="comment"] [data-count]'),
    ).toHaveLength(2);
  });

  it("still draws a sliver where the peak would round it away", () => {
    const { container } = render(drawing([["comment", [400, 1]]]));
    const [, sliver] = columnHeights(container, "comment");

    // One event against a peak of four hundred rounds to nothing, and a column
    // that is empty where something WAS counted says the opposite of the truth.
    expect(sliver).toBeGreaterThan(0);
  });

  it("names the axes, draws a shared scale, and keeps every non-zero quantity visible", () => {
    const { container } = render(
      drawing([
        ["comment", [4, 1]],
        ["message", [2, 0]],
      ]),
    );
    const slots = container.querySelectorAll<HTMLElement>("[data-count]");

    expect(slots).toHaveLength(4);
    expect(slots[0]).toHaveAttribute("title", word("trend.first"));
    expect(slots[0]?.querySelector(".mc-trend__value")).toHaveTextContent("4");
    expect(slots[3]?.querySelector(".mc-trend__value")).toBeNull();
    expect(
      container.querySelector(".mc-trend__axis-title--x"),
    ).toHaveTextContent(word("trend.axis.x"));
    expect(
      container.querySelector(".mc-trend__axis-title--y"),
    ).toHaveTextContent(word("trend.axis.y"));
    expect(container.querySelector(".mc-trend__scale")).toHaveTextContent(
      "420",
    );

    // The named, expandable table belongs to the screen because it carries the
    // same values alongside its other aggregates. The chart must not insert a
    // duplicate counting table ahead of that keyboard route.
    expect(container.querySelector("table")).toBeNull();
  });
});

/* ------------------------------------------------------------------ *
 * A component knows no language, and owns no stylesheet
 * ------------------------------------------------------------------ */

describe("REQ-117: no operator-facing word lives inside a component", () => {
  it("renders only the words its caller passed", () => {
    const findings = SPECIMENS.flatMap((specimen) => {
      const { name, element } = specimen;
      const { container, unmount } = render(element);
      const drawn = drawnIn(container, specimen);

      // Both what is read on screen and what is read out: an accessible name
      // written into a component is text just as much as a paragraph is.
      const written = [drawn.textContent ?? ""];

      for (const node of drawn.querySelectorAll("*")) {
        for (const attribute of ["aria-label", "alt", "title", "placeholder"]) {
          written.push(node.getAttribute(attribute) ?? "");
        }
      }

      unmount();

      return written.flatMap((text) => {
        const residue = text.replace(SENTINEL, "").replace(/[^\p{L}]/gu, "");

        return residue === "" ? [] : [`${name}: "${residue}"`];
      });
    });

    expect(findings).toEqual([]);
  });

  it("imports no stylesheet of its own", () => {
    // REQ-110's other half: the cascade is decided in `styles/app.css`, so a
    // component that pulled its own sheet would order itself by whenever its
    // module happened to be evaluated.
    const findings = WEB_FILES.filter(
      ([path]) =>
        path.startsWith("src/web/components/") && path.endsWith(".tsx"),
    ).flatMap(([path, source]) =>
      /import\s+["'][^"']+\.css["']/.test(source) ? [path] : [],
    );

    expect(findings).toEqual([]);

    const app = WEB_FILES.find(([path]) => path === "src/web/styles/app.css");

    expect(app?.[1]).toContain("../components/components.css");
  });
});

/* ------------------------------------------------------------------ *
 * REQ-268: every button the system renders is cut to the one tap size
 * ------------------------------------------------------------------ */

/**
 * The other half of the guard `styles/tokens.test.ts` opens, and it reads from
 * the opposite end.
 *
 * That file walks the SHEET and refuses a height written outside the token on
 * anything whose class carries `btn`. It is the check that catches a second
 * size being invented, and it is blind by construction to a control the naming
 * convention never named: the publication tile is a real `<button>` and there
 * is no `btn` anywhere in `.mc-pubtile`.
 *
 * So this one starts from the RENDER. Every specimen of the system is mounted,
 * every `<button>` and every `<a href>` it produced is collected with the
 * classes it really carries, and each of those classes is looked up in the
 * sheet. A control whose classes name no rule with a height at all is reported
 * exactly like one sized from a number: neither of them has the floor, and the
 * difference between "shrunk to 28px" and "whatever the content happened to be"
 * is a difference in luck, not in guarantee.
 *
 * Conditional groups are cut out of the sheet before the lookup. A floor that
 * only exists under `@media` is a floor that only exists on some screens, and
 * the requirement is about fingers, which every screen has in front of it.
 */

/** The one token a control's size may come from (REQ-268). */
const TAP = "var(--tap)";

const COMPONENT_SHEET =
  WEB_FILES.find(
    ([path]) => path === "src/web/components/components.css",
  )?.[1] ?? "";

/** Comments out, so a selector is never read with prose glued to its front. */
function withoutComments(sheet: string): string {
  return sheet.replace(/\/\*[\s\S]*?\*\//g, "");
}

/**
 * The sheet with every conditional group removed, braces balanced: what is
 * left is what a control is sized to before any viewport has an opinion.
 */
function unconditional(sheet: string): string {
  let text = sheet;

  for (;;) {
    const start = text.search(/@media[^{]*\{/);

    if (start === -1) {
      return text;
    }

    let depth = 0;
    let end = text.indexOf("{", start);

    for (let index = end; index < text.length; index += 1) {
      depth += text[index] === "{" ? 1 : text[index] === "}" ? -1 : 0;

      if (depth === 0) {
        end = index;
        break;
      }
    }

    text = text.slice(0, start) + text.slice(end + 1);
  }
}

const BASE_SHEET = unconditional(withoutComments(COMPONENT_SHEET));

/** One rule, innermost: everything since the last brace, then its body. */
const RULE = /([^{}]+)\{([^{}]*)\}/g;

/** What gives a control its height, in the physical name and the logical one. */
const HEIGHT = /(?:^|[;{\s])(?:min-)?(?:height|block-size)\s*:\s*([^;}]+)/g;

/** Every height the sheet declares for exactly this class, on its own. */
function sizedBy(className: string): readonly string[] {
  const values: string[] = [];

  for (const [, prelude = "", body = ""] of BASE_SHEET.matchAll(RULE)) {
    const selectors = prelude.split(",").map((one) => one.trim());

    if (!selectors.includes(`.${className}`)) {
      continue;
    }

    for (const [, value = ""] of body.matchAll(HEIGHT)) {
      values.push(value.trim());
    }
  }

  return values;
}

interface RenderedControl {
  readonly name: string;
  readonly description: string;
  readonly classes: readonly string[];
}

/** Every button and every link the system's own specimens really produce. */
function renderedControls(): readonly RenderedControl[] {
  return SPECIMENS.flatMap((specimen) => {
    const { name, element } = specimen;
    const { container, unmount } = render(element);
    const found = [
      ...drawnIn(container, specimen).querySelectorAll("button, a[href]"),
    ].map((control): RenderedControl => ({
      name,
      description: describeElement(control),
      classes: [...control.classList],
    }));

    unmount();

    return found;
  });
}

describe("REQ-268: the size axis is gone from the components", () => {
  it("offers no size on Button and none on IconButton", () => {
    // Refused by the COMPILER and not by an assertion, which is the only place
    // a property that does not exist can be refused: if `size` ever comes back
    // to either component these two lines stop being errors, and `vite build`
    // fails on the directive that suppresses nothing.
    const axis = (
      <>
        {/* @ts-expect-error REQ-268: a button has one size, so it takes none */}
        <Button size="sm">{word("btn.label")}</Button>
        {/* @ts-expect-error REQ-268: a button has one size, so it takes none */}
        <IconButton icon="x" label={word("icon.label")} size="sm" />
      </>
    );

    // And rendered as well, because a property the type refuses can still
    // arrive from plain JavaScript: what must not exist is the CLASS that would
    // resize the control once it did.
    const { container } = render(axis);
    const modifiers = [...container.querySelectorAll("button")].flatMap(
      (control) =>
        [...control.classList].filter((one) => /--(xs|sm|md|lg|xl)$/.test(one)),
    );

    expect(modifiers).toEqual([]);
  });

  it("keeps no size modifier in the sheet either", () => {
    // The classes screens used to write by hand. Button and ButtonLink now
    // keep a type between every caller and the stylesheet.
    expect(BASE_SHEET).not.toContain(".mc-btn--sm");
    expect(BASE_SHEET).not.toContain(".mc-btn--lg");
    expect(BASE_SHEET).not.toContain(".mc-iconbtn--sm");
  });
});

describe("REQ-268: every control the system renders has the tap floor", () => {
  it("reads the sheet, and the rule that sizes a button", () => {
    // A sweep that read an empty module would pass everything below forever:
    // vitest replaces a stylesheet with nothing unless `css` is on.
    expect(COMPONENT_SHEET.length).toBeGreaterThan(0);
    expect(BASE_SHEET.length).toBeGreaterThan(0);

    // The two rules the whole product's buttons are cut by, each declaring the
    // token and nothing else. Compared whole, so a second declaration slipped
    // in beside them is a failure and not a detail.
    expect(sizedBy("mc-btn")).toEqual([TAP]);
    expect(sizedBy("mc-iconbtn")).toEqual([TAP]);

    // And the conditional groups really came out: the handset rule of REQ-269
    // is in the sheet and must not be what answers for a floor.
    expect(COMPONENT_SHEET).toContain("@media (max-width: 35rem)");
    expect(BASE_SHEET).not.toContain("@media");
  });

  it("collects its controls off real renders and not off a list", () => {
    const controls = renderedControls();

    // Guards the sweep: a specimen set that rendered no button would make the
    // check below pass on an empty list, which is a check that cannot fail.
    expect(controls.length).toBeGreaterThan(5);

    const classes = new Set(controls.flatMap(({ classes: own }) => own));

    // Three shapes of control, and the third is the one a sheet-side sweep
    // cannot see: `.mc-pubtile` is a `<button>` with no `btn` in its name.
    expect(classes).toContain("mc-btn");
    expect(classes).toContain("mc-iconbtn");
    expect(classes).toContain("mc-pubtile");
  });

  it("sizes every one of them from var(--tap), and nothing else", () => {
    const findings = renderedControls().flatMap(
      ({ name, description, classes }) => {
        const declared = classes.flatMap((one) => sizedBy(one));

        if (declared.length === 0) {
          return [
            `${name}: ${description} is sized by no rule of the sheet, so nothing holds it to the tap floor`,
          ];
        }

        return declared.flatMap((value) =>
          value.includes(TAP)
            ? []
            : [
                `${name}: ${description} takes its height from ${value} instead of ${TAP}`,
              ],
        );
      },
    );

    expect(findings).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * REQ-276: a link goes somewhere, a button does something
 * ------------------------------------------------------------------ */

/**
 * The rule that made an action read as a destination, and the reason this
 * guard is written against the DRAWING and not against a class name.
 *
 * The weight was called `link`, and a guard that only refused that name would
 * pass the next one called `quiet` doing the same thing. What has to be absent
 * is the underlined, unframed text: it says "this goes somewhere" to whoever
 * reads it, it answers Enter and not Space to whoever is on a keyboard, and it
 * has no visible size at all to whoever is aiming a thumb at it. REQ-268 held
 * its HEIGHT the whole time, which is exactly why the defect survived: a height
 * nobody can see is a height nobody aims at.
 */
const UNDERLINE = /text-decoration\s*:\s*underline/;

/** Every anchor the system's own specimens really produce. */
function renderedAnchors(): readonly {
  readonly name: string;
  readonly description: string;
  readonly href: string | null;
}[] {
  return SPECIMENS.flatMap((specimen) => {
    const { name, element } = specimen;
    const { container, unmount } = render(element);
    const found = [...drawnIn(container, specimen).querySelectorAll("a")].map(
      (anchor) => ({
        name,
        description: describeElement(anchor),
        href: anchor.getAttribute("href"),
      }),
    );

    unmount();

    return found;
  });
}

describe("REQ-276: no weight of the button is drawn as a link", () => {
  it("offers no link weight on Button or ButtonLink", () => {
    // Refused by the COMPILER, which is the only place a value a type does not
    // accept can be refused: the day `link` comes back to the union this line
    // stops being an error and `vite build` fails on a directive that
    // suppresses nothing.
    const weight = (
      // @ts-expect-error REQ-276: an action is a button, so there is no link weight
      <Button variant="link">{word("btn.label")}</Button>
    );
    const destination = (
      // @ts-expect-error REQ-276: a destination may wear a button weight, never a link weight
      <ButtonLink href="/x" variant="link">
        {word("link.label")}
      </ButtonLink>
    );

    // Rendered as well, because the component interpolates whatever weight
    // reaches it and plain JavaScript can still hand it one. What must not
    // exist is a RULE that would draw it as a destination, and the sweep below
    // is what says so for every weight at once.
    expect(render(weight).container.querySelector("a")).toBeNull();
    expect(destination).toBeDefined();
  });

  it("reads the sheet, and the weights really written in it", () => {
    // Guards the sweep: an empty sheet would pass every check below forever.
    expect(BASE_SHEET.length).toBeGreaterThan(0);
    expect(BASE_SHEET).toContain(".mc-btn--secondary");
    expect(BASE_SHEET).toContain(".mc-btn--removal");
  });

  it("draws no button of the system as underlined text", () => {
    const underlined = [...BASE_SHEET.matchAll(RULE)]
      .filter(
        ([, prelude = "", body = ""]) =>
          /\.mc-btn\b/.test(prelude) && UNDERLINE.test(body),
      )
      .map(([, prelude = ""]) => prelude.trim().replace(/\s+/g, " "));

    expect(underlined).toEqual([]);

    // And the detector bites: written as a fixture rather than into the sheet,
    // because the sheet is the thing under test.
    expect(
      [
        ...".mc-btn--quiet { text-decoration: underline; }".matchAll(RULE),
      ].filter(
        ([, prelude = "", body = ""]) =>
          /\.mc-btn\b/.test(prelude) && UNDERLINE.test(body),
      ),
    ).toHaveLength(1);
  });

  it("gives every anchor the components render a destination to go to", () => {
    const anchors = renderedAnchors();

    // Guards the sweep again: a specimen set that rendered no anchor would make
    // the check below pass on an empty list.
    expect(anchors.length).toBeGreaterThan(0);

    // An anchor with no address, or one pointing at the page it already is on,
    // navigates nowhere: whatever it does, it does through a click handler, and
    // that is an ACTION drawn as a destination. It answers Enter and not Space,
    // announces itself as a link, and no rule of this system gives it a size.
    const findings = anchors.flatMap(({ name, description, href }) =>
      href === null || href.trim() === "" || href.trim() === "#"
        ? [
            `${name}: ${description} is an anchor going nowhere, so it acts instead of navigating (REQ-276)`,
          ]
        : [],
    );

    expect(findings).toEqual([]);
  });
});

describe("REQ-327: the floor reaches the controls that are not buttons", () => {
  it("cuts the switch label to the tap size, and leaves the track alone", () => {
    // REQ-268 is written about BUTTONS, and a switch is not one: measured in a
    // browser, the three trigger switches of Settings were 24px tall at 320,
    // 390, 768 and 1440, in both themes, while every button on the same screen
    // was 44.
    //
    // The floor goes on the LABEL, which is the whole clickable area of a
    // checkbox, so the drawing of the track is untouched: a switch that grew to
    // 44px would be a second switch, different from the one the rest of the
    // product renders.
    expect(sizedBy("mc-switch")).toEqual([TAP]);
    expect(sizedBy("mc-switch__track")).toEqual(["1.5rem"]);

    // Unconditional, like every other floor of REQ-268: a size that only holds
    // under a media query is a size that only holds on some screens, and the
    // finger is the same on all of them.
    expect(BASE_SHEET).toContain("min-block-size: var(--tap)");
  });

  it("REQ-356: cuts the CHECKBOX label to the same floor", () => {
    // The half REQ-327 left behind, and it was left behind honestly: that
    // requirement is about the Settings screen, and the switch is what Settings
    // renders. The checkbox is the other control that is not a button, it is
    // rendered by the editor as well, and with a one line label it measured
    // 22px in the browser, which is half the floor.
    expect(sizedBy("mc-check")).toEqual([TAP]);

    // The BOX keeps its own size, exactly as the switch track does: growing it
    // would be a second checkbox, different from the one the rest of the
    // product draws. The floor belongs to the label, which is what a thumb
    // hits, and the drawing is untouched.
    expect(sizedBy("mc-check input")).toEqual(["1.125rem"]);
  });
});

/* ------------------------------------------------------------------ *
 * REQ-280: the next keyword is typed into an empty chip
 * ------------------------------------------------------------------ */

/**
 * The place where a word is added, which had no edge anywhere.
 *
 * The field is a box full of chips, and the entry inside it declared
 * `border: 0` on a transparent fill: a caret in the middle of a row of solid
 * pills, with nothing on the screen saying that the row is where you type. The
 * prototype draws it as the chips beside it, dashed and unfilled, which is the
 * one shape that reads as "a word goes here and there is none yet".
 *
 * jsdom applies no stylesheet, so no test here can measure a rendered outline.
 * What is guarded is the sheet, read as text, plus the half of the requirement
 * that IS structural: the entry is really the last thing in the row of chips,
 * which is read off a render.
 *
 * The corner and the type size were guarded here as well, and against the chip
 * beside the entry. They belong to REQ-300 below, which holds them against the
 * prototype instead, because the prototype is what decides how the entry reads.
 */
const KEYWORD_ENTRY = ".mc-keywords__input";

/** The bodies of every rule the sheet writes for exactly this selector. */
function bodiesOf(selector: string): readonly string[] {
  const bodies: string[] = [];

  for (const [, prelude = "", body = ""] of BASE_SHEET.matchAll(RULE)) {
    if (
      prelude
        .split(",")
        .map((one) => one.trim())
        .includes(selector)
    ) {
      bodies.push(body);
    }
  }

  return bodies;
}

describe("REQ-280: the entry for a new keyword is drawn as an empty chip", () => {
  it("gives it the dashed outline of an offer instead of no edge at all", () => {
    // A sweep that read an empty module would pass everything below forever.
    expect(BASE_SHEET.length).toBeGreaterThan(0);

    const [entry] = bodiesOf(KEYWORD_ENTRY);

    expect(entry, `${KEYWORD_ENTRY} is in the sheet`).toBeDefined();

    // Dashed, and on the colour this system already means an offer by. Solid
    // would say "decided", which is what the chips beside it are.
    expect(entry).toMatch(/border:\s*1px dashed var\(--rule-strong\);/);
    expect(entry).not.toMatch(/border:\s*0;/);

    // Unfilled, so the word being typed is not yet a word that was added.
    expect(entry).toContain("background: transparent;");
  });

  it("keeps it in the same row the added words are in", () => {
    const [row] = bodiesOf(".mc-keywords");

    expect(row).toContain("display: flex;");
    expect(row).toContain("flex-wrap: wrap;");
  });

  it("renders it inside that row, after the words already added", () => {
    const { container } = render(
      <KeywordField
        id="entry"
        keywords={[word("keywords.first"), word("keywords.second")]}
        onAdd={() => undefined}
        onRemove={() => undefined}
        removeLabel={(keyword) => `${word("keywords.remove")} ${keyword}`}
      />,
    );

    const row = container.querySelector(".mc-keywords");
    const entry = container.querySelector(KEYWORD_ENTRY);

    expect(row).not.toBeNull();
    expect(entry).not.toBeNull();

    // Two chips and the entry, in that order and in one parent: the outline
    // above is what the entry looks like, and this is where it stands.
    expect([...(row?.children ?? [])]).toHaveLength(3);
    expect([...(row?.children ?? [])].at(-1)).toBe(entry);
  });
});

/* ------------------------------------------------------------------ *
 * REQ-300: the entry for a new keyword is the prototype's, to the letter
 * ------------------------------------------------------------------ */

/**
 * A guardian that reads a file outside `src/web`, as the palette's does.
 *
 * `docs/prototipo-automacao.html` is where a screen is proposed in this project
 * and it is the artefact the user APPROVES BY LOOKING AT IT, so where it and
 * the application disagree the application is the one that is wrong. REQ-280
 * drew this entry as an empty chip and then, arguing that the empty chip has to
 * read like the decided ones beside it, gave it the chip's corner and the body
 * type size instead of the pill and the 0.875rem the prototype draws. The
 * argument was internal to the screen; the decision went the other way, and
 * this is what keeps it that way.
 *
 * What it compares is the RESOLVED value and never the spelling. Both files
 * write `var(--radius-pill)` for the corner, and a comparison of two strings
 * would still have passed on the day one of the two sheets moved the token
 * underneath: what the person approving the page saw is 999px, so 999px is what
 * is bound. It is also what lets the application name a length its own way,
 * `var(--text-sm)` against a prototype that writes the number out, without the
 * guardian having an opinion about names.
 *
 * REQ-299 in `styles/tokens.test.ts` cannot reach any of this: it binds the
 * tokens the two files both declare in the PALETTE, and the corner and the type
 * ladder live in sheets it never opens.
 */
const PROTOTYPE_PATH = "docs/prototipo-automacao.html";

const COMPONENT_SHEET_PATH = "src/web/components/components.css";

/**
 * The prototype, as text, through a glob rather than an import: every relative
 * specifier in this repository ends in `.js` (REQ-082), and a `?raw` import of
 * an `.html` file would be the one exception. A glob is not a specifier.
 *
 * Conditional groups come out of it exactly as they come out of `BASE_SHEET`,
 * so a base rule is held against a base rule and never against what some
 * viewport happens to say instead.
 */
const PROTOTYPE_SOURCES = import.meta.glob<string>(
  "../../../docs/prototipo-automacao.html",
  { eager: true, query: "?raw", import: "default" },
);

const PROTOTYPE_SHEET = unconditional(
  withoutComments(Object.values(PROTOTYPE_SOURCES)[0] ?? ""),
);

/** The prototype's own name for the place where the next word is typed. */
const PROTOTYPE_ENTRY = ".chipinput";

/**
 * What a sheet declares for exactly this selector, on its own.
 *
 * The prototype is a page and not a stylesheet, so its first rule opens after
 * markup instead of after a brace, and reading a prelude backwards the way
 * `bodiesOf` does would hand back the whole document head. The selector is
 * anchored on the line it opens instead, which also keeps `.chipinput` off any
 * compound rule that merely contains the word.
 */
function bodyFor(sheet: string, selector: string): string | undefined {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  return new RegExp(`(?:^|[};])\\s*${escaped}\\s*\\{([^{}]*)\\}`).exec(
    sheet,
  )?.[1];
}

/** The custom properties a `:root` block declares, by name. */
function declarationsOf(block: string): ReadonlyMap<string, string> {
  return new Map(
    [...block.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map(
      ([, name = "", value = ""]): readonly [string, string] => [
        name,
        value.trim(),
      ],
    ),
  );
}

/** The first `:root` block of a sheet, which is where a ladder is declared. */
function rootBlock(sheet: string): string {
  const opening = ":root {";
  const start = sheet.indexOf(opening);

  if (start === -1) {
    return "";
  }

  const close = sheet.indexOf("}", start + opening.length);

  return close === -1 ? "" : sheet.slice(start + opening.length, close);
}

/**
 * Every token the application declares at the root, from every sheet of
 * `styles/tokens/`: the corner comes from one of them and the type size from
 * another, and which one is not this guardian's business.
 */
const APPLICATION_TOKENS: ReadonlyMap<string, string> = new Map(
  WEB_FILES.filter(([path]) =>
    path.startsWith("src/web/styles/tokens/"),
  ).flatMap(([, source]) => [
    ...declarationsOf(rootBlock(unconditional(withoutComments(source)))),
  ]),
);

const PROTOTYPE_TOKENS = declarationsOf(rootBlock(PROTOTYPE_SHEET));

/**
 * A declared value as the browser would paint it: `!important` dropped, and
 * every `var()` replaced by what the same file declares for it.
 *
 * Bounded rather than recursive, because a token pointing at itself is a page
 * that never renders and not a test that never returns.
 */
function resolved(value: string, tokens: ReadonlyMap<string, string>): string {
  let text = value.replace(/!important/g, "").trim();

  for (let step = 0; step < 4 && text.includes("var("); step += 1) {
    text = text.replace(
      /var\((--[\w-]+)\)/g,
      (whole, name: string) => tokens.get(name) ?? whole,
    );
  }

  return text.trim();
}

/** What a rule declares for one property, or nothing if it declares none. */
function declaredValue(body: string, property: string): string {
  return (
    new RegExp(`(?:^|[;{\\s])${property}\\s*:\\s*([^;}]+)`).exec(body)?.[1] ??
    ""
  );
}

/** The two properties REQ-300 binds, in the words the requirement uses. */
const FOLLOWED: readonly {
  readonly name: string;
  readonly property: string;
}[] = [
  { name: "corner", property: "border-radius" },
  { name: "type size", property: "font-size" },
];

/** Every property the screen paints differently, named with both values. */
function entryDrift(entry: string): readonly string[] {
  const approvedBody = bodyFor(PROTOTYPE_SHEET, PROTOTYPE_ENTRY) ?? "";

  return FOLLOWED.flatMap(({ name, property }) => {
    const painted = resolved(
      declaredValue(entry, property),
      APPLICATION_TOKENS,
    );
    const approved = resolved(
      declaredValue(approvedBody, property),
      PROTOTYPE_TOKENS,
    );

    return painted === approved
      ? []
      : [
          `${name} (${property}) is ${painted || "unset"} in ${COMPONENT_SHEET_PATH}, ${approved || "unset"} in ${PROTOTYPE_PATH}`,
        ];
  });
}

describe("REQ-300: the entry for a new word is drawn as the prototype draws it", () => {
  it("reads both files, and finds the entry and a ladder in each", () => {
    // A glob that matched nothing, a selector renamed, a `<style>` block moved:
    // each one leaves every assertion below comparing nothing with nothing and
    // reporting success.
    expect(PROTOTYPE_SHEET.length).toBeGreaterThan(0);
    expect(BASE_SHEET.length).toBeGreaterThan(0);

    const approved = bodyFor(PROTOTYPE_SHEET, PROTOTYPE_ENTRY);
    const [entry] = bodiesOf(KEYWORD_ENTRY);

    expect(
      approved,
      `${PROTOTYPE_ENTRY} is in ${PROTOTYPE_PATH}`,
    ).toBeDefined();
    expect(
      entry,
      `${KEYWORD_ENTRY} is in ${COMPONENT_SHEET_PATH}`,
    ).toBeDefined();

    for (const { property } of FOLLOWED) {
      expect(declaredValue(approved ?? "", property)).not.toBe("");
      expect(declaredValue(entry ?? "", property)).not.toBe("");
    }

    // And the ladders really resolve: a `var()` left standing on either side
    // would be compared as text and would agree with the wrong thing.
    expect(APPLICATION_TOKENS.size).toBeGreaterThan(20);
    expect(PROTOTYPE_TOKENS.size).toBeGreaterThan(20);
    expect(resolved("var(--radius-pill)", APPLICATION_TOKENS)).toMatch(/^\d/);
    expect(resolved("var(--radius-pill)", PROTOTYPE_TOKENS)).toMatch(/^\d/);
  });

  it("paints the corner and the type size at the prototype's values", () => {
    const [entry] = bodiesOf(KEYWORD_ENTRY);

    expect(entryDrift(entry ?? "")).toEqual([]);
  });

  it("reports a value the screen changed, naming the property and both sides", () => {
    // The rule exactly as it stood before REQ-300: the chip's corner and the
    // body type size, which is the divergence this guardian exists to catch.
    const stale = (bodiesOf(KEYWORD_ENTRY)[0] ?? "")
      .replace(
        "border-radius: var(--radius-pill);",
        "border-radius: var(--radius-sm);",
      )
      .replace("font-size: var(--text-sm);", "font-size: var(--text-base);");

    expect(entryDrift(stale)).toEqual([
      `corner (border-radius) is ${resolved("var(--radius-sm)", APPLICATION_TOKENS)} in ${COMPONENT_SHEET_PATH}, ${resolved("var(--radius-pill)", PROTOTYPE_TOKENS)} in ${PROTOTYPE_PATH}`,
      `type size (font-size) is ${resolved("var(--text-base)", APPLICATION_TOKENS)} in ${COMPONENT_SHEET_PATH}, 0.875rem in ${PROTOTYPE_PATH}`,
    ]);
  });

  it("changes no height while it changes the shape", () => {
    const [entry] = bodiesOf(KEYWORD_ENTRY);

    // A corner and a type size are the whole requirement. The floor a finger
    // aims at is REQ-268's and is not the prototype's to move (KEEL: 44px).
    expect(entry).toContain(`min-height: ${TAP};`);
  });
});

/* ------------------------------------------------------------------ *
 * REQ-305: the chip of a word is drawn as the entry beside it
 * ------------------------------------------------------------------ */

/**
 * The other half of REQ-300, and the field is where it is written.
 *
 * REQ-300 gave the entry the prototype's pill and stopped there, which left one
 * control holding two shapes: a pill where the next word is typed, boxes for
 * the words already added. This binds the chip to the entry instead of to the
 * prototype, and it binds it INSIDE the field, because a chip is not always a
 * word: the wording of a step is a chip that is a box on purpose (REQ-274), and
 * the reply drawn in the handset is a picture of another product (REQ-298).
 *
 * jsdom applies no stylesheet, so nothing here measures a rendered corner. The
 * sheet is read as text and the values are compared RESOLVED, as REQ-300 does:
 * both rules spell `var(--radius-pill)` today, and two strings would agree with
 * each other on the day the token moved under one of them.
 *
 * The tint is the other claim of the requirement, and it is not restated in the
 * chip's own rule: it arrives from the `accent` tone the field renders every
 * chip with. So it is proved where it really happens, off a render and off the
 * rule that paints that tone, and `styles/tokens.test.ts` measures the pair in
 * both themes.
 */
const KEYWORD_CHIP = ".mc-keywords .mc-chip";

/** The corner a rule declares, as the browser would paint it. */
function cornerOf(body: string): string {
  return resolved(declaredValue(body, "border-radius"), APPLICATION_TOKENS);
}

describe("REQ-305: the chip of an added word takes the entry's shape", () => {
  it("reads the sheet, and finds the chip's rule and the entry's in it", () => {
    // A selector renamed or a sweep that read nothing would leave every
    // comparison below holding an empty string against an empty string.
    expect(BASE_SHEET.length).toBeGreaterThan(0);

    const [chip] = bodiesOf(KEYWORD_CHIP);
    const [entry] = bodiesOf(KEYWORD_ENTRY);

    expect(chip, `${KEYWORD_CHIP} is in ${COMPONENT_SHEET_PATH}`).toBeDefined();
    expect(
      entry,
      `${KEYWORD_ENTRY} is in ${COMPONENT_SHEET_PATH}`,
    ).toBeDefined();

    // And both corners really resolve to a length: a `var()` left standing
    // would be compared as text and would agree with the wrong thing.
    expect(cornerOf(chip ?? "")).toMatch(/^\d/);
    expect(cornerOf(entry ?? "")).toMatch(/^\d/);
  });

  it("gives it the corner the entry has, at the value the two paint", () => {
    const [chip] = bodiesOf(KEYWORD_CHIP);
    const [entry] = bodiesOf(KEYWORD_ENTRY);

    expect(cornerOf(chip ?? "")).toBe(cornerOf(entry ?? ""));
    expect(cornerOf(chip ?? "")).toBe(
      resolved("var(--radius-pill)", APPLICATION_TOKENS),
    );
  });

  it("reports a chip that went back to a corner of its own", () => {
    // The shape exactly as it stood before this requirement: the chip's square
    // corner beside an entry that had already become a pill. Written as a
    // fixture rather than into the sheet, because the sheet is under test.
    const stale = (bodiesOf(KEYWORD_CHIP)[0] ?? "").replace(
      "border-radius: var(--radius-pill);",
      "border-radius: var(--radius-sm);",
    );
    const [entry] = bodiesOf(KEYWORD_ENTRY);

    expect(cornerOf(stale)).toBe(
      resolved("var(--radius-sm)", APPLICATION_TOKENS),
    );
    expect(cornerOf(stale)).not.toBe(cornerOf(entry ?? ""));
  });

  it("takes the edge off the chip instead of leaving one drawn", () => {
    const [chip] = bodiesOf(KEYWORD_CHIP);

    expect(chip).toContain("border-color: transparent;");

    // Transparent, and not `border: 0`: the base rule sizes the chip with a
    // hairline on every side, and dropping it would move every pill in the row
    // by two pixels to change a colour nobody can see.
    expect(chip).not.toMatch(/border:\s*0;/);
  });

  it("fills it with the tint, through the tone the field really renders", () => {
    const { container } = render(
      <KeywordField
        id="tint"
        keywords={[word("keywords.first")]}
        onAdd={() => undefined}
        onRemove={() => undefined}
        removeLabel={(keyword) => `${word("keywords.remove")} ${keyword}`}
      />,
    );

    const chip = container.querySelector(KEYWORD_CHIP);

    // The rule above paints a shape and no colour, so this is the whole of the
    // claim that the chip is `--accent-soft`: the field renders the tinted
    // tone, and the tinted tone is what carries the tint.
    expect(chip).not.toBeNull();
    expect(chip).toHaveClass("mc-chip--accent");

    const [accent] = bodiesOf(".mc-chip--accent");

    expect(accent).toContain("background: var(--accent-soft);");
    expect(accent).toContain("color: var(--accent-ink);");
  });
});

/* ------------------------------------------------------------------ *
 * REQ-281: one rule decides how short a multi-line box may be
 * ------------------------------------------------------------------ */

/**
 * The floor of every box that takes more than one line, in one place.
 *
 * `.mc-textarea` carried 9rem, 144px, and the prototype answers 74px: an empty
 * box the height of an essay under a label that asks for a sentence. Three
 * rules of the same sheet declared a floor for the same control, so which one
 * a screen got depended on which modifier it happened to pass.
 *
 * jsdom applies no stylesheet, so nothing here measures a rendered box. What is
 * guarded is that ONE rule declares it, that the number it declares is the
 * prototype's, and that the class carrying it reaches every box the component
 * renders. The sheet-wide half, that no other stylesheet declares another one
 * for the same selector, is in `styles/tokens.test.ts`.
 */

/** What a rem is worth to a reader who changed nothing. */
const ROOT_FONT_PX = 16;

/** The floor the prototype writes for a multi-line box. */
const TEXTAREA_FLOOR_PX = 74;

/** The one departure the prototype itself draws: a box for a sentence. */
const COMPACT_FLOOR_PX = 56;

/** A length in rem as a number of pixels, or NaN if it is not written in rem. */
function remPx(length: string): number {
  return /^[\d.]+rem$/.test(length.trim())
    ? Number.parseFloat(length) * ROOT_FONT_PX
    : Number.NaN;
}

describe("REQ-281: one rule decides the floor of a multi-line box", () => {
  it("declares it once, and at the 74px the prototype draws", () => {
    expect(BASE_SHEET.length).toBeGreaterThan(0);

    // Compared whole, so a second declaration slipped in beside it is a
    // failure and not a detail: two rules is two decisions.
    const declared = sizedBy("mc-textarea");

    expect(declared).toHaveLength(1);

    // In rem and not in px, as the tap floor is and for the same reason: a
    // reader who enlarged the browser's text gets a box that grew with it. The
    // pixels are arithmetic off the sheet, so a value edited down fails here
    // instead of waiting for somebody to notice.
    const floor = declared[0] ?? "";

    expect(floor).toMatch(/rem$/);
    expect(remPx(floor)).toBe(TEXTAREA_FLOOR_PX);
  });

  it("keeps the one departure the prototype draws, and keeps it lower", () => {
    const compact = sizedBy("mc-textarea--compact");

    expect(compact).toHaveLength(1);
    expect(remPx(compact[0] ?? "")).toBe(COMPACT_FLOOR_PX);

    // A box for a SENTENCE is shorter than the ordinary one (REQ-266). Held
    // against the shared floor rather than asserted on its own, so the day the
    // floor moves under it this stops claiming a difference it lost.
    expect(remPx(compact[0] ?? "")).toBeLessThan(
      remPx(sizedBy("mc-textarea")[0] ?? ""),
    );
  });

  it("puts that rule's class on every box the component renders", () => {
    const { container, unmount } = render(
      <TextArea id="plain" label={word("textarea.label")} />,
    );
    const written = container.querySelector("textarea");

    expect([...(written?.classList ?? [])]).toContain("mc-textarea");

    unmount();
  });
});

/* ------------------------------------------------------------------ *
 * REQ-290 and REQ-291: a file is recognised by what it looks like
 * ------------------------------------------------------------------ */

/**
 * The two halves of one correction, and the reason they are proven here rather
 * than by looking at a screen.
 *
 * jsdom applies no stylesheet, so "it is a grid" and "it has a thumbnail" are
 * not things this file can measure: what it CAN decide is that the picture is
 * in the document, that it carries the address of the resource it stands for,
 * and that the name read on screen is the one the operator gave the file rather
 * than the key the catalogue minted (REQ-292). The pixels were read in a
 * browser, and the rules the sheet writes are held by `styles/tokens.test.ts`.
 */
const ASSET_ITEMS = [
  {
    name: "cover~1a2b3c4d.png",
    fileName: "cover.png",
    url: "/assets/cover~1a2b3c4d.png",
    kind: "image",
  },
  {
    name: "guide~5e6f7a8b.pdf",
    fileName: "guide.pdf",
    url: "/assets/guide~5e6f7a8b.pdf",
    kind: "file",
  },
] as const;

/**
 * What the caller of the grid owns about a deletion (REQ-293): which tile is
 * asking, what the catalogue answered about it, and the three ways to answer.
 */
interface Deletion {
  readonly items?: readonly AssetTile[];
  readonly removal?: AssetRemoval;
  readonly onRemoveRequest?: (name: string) => void;
  readonly onRemoveConfirm?: (name: string) => void;
  readonly onRemoveCancel?: () => void;
}

function catalogue(
  selected?: string,
  onSelect: (name: string) => void = () => undefined,
  deletion: Deletion = {},
): ReactElement {
  return (
    <AssetGrid
      items={deletion.items ?? ASSET_ITEMS}
      selectedName={selected}
      onSelect={onSelect}
      selectLabel={(fileName) => `${word("asset.use")} ${fileName}`}
      thumbnailAlt={(fileName) => `${word("asset.alt")} ${fileName}`}
      brokenLabel={word("asset.broken")}
      kindLabel={word("asset.kind")}
      emptyLabel={word("asset.empty")}
      removal={deletion.removal}
      onRemoveRequest={deletion.onRemoveRequest ?? ((): void => undefined)}
      onRemoveConfirm={deletion.onRemoveConfirm ?? ((): void => undefined)}
      onRemoveCancel={deletion.onRemoveCancel ?? ((): void => undefined)}
      removeLabel={(fileName) => `${word("asset.delete")} ${fileName}`}
      removeQuestion={(fileName) => `${word("asset.deleteAsk")} ${fileName}`}
      usageLabel={(count) => `${word("asset.usage")} ${count}`}
      usagePendingLabel={word("asset.counting")}
      removeWarning={word("asset.warning")}
      removeConfirmLabel={word("asset.deleteYes")}
      removeWorkingLabel={word("asset.deleting")}
      removeCancelLabel={word("asset.keep")}
    />
  );
}

describe("REQ-290: the upload control shows what was chosen", () => {
  it("draws the chosen image at the address the catalogue gave it", () => {
    const { container } = render(
      <FileUpload
        kind="image"
        kindLabel={word("upload.kind")}
        fileName="cover.png"
        previewUrl="/assets/cover~1a2b3c4d.png"
        emptyHint={word("upload.empty")}
        chooseLabel={word("upload.choose")}
        replaceLabel={word("upload.replace")}
        removeLabel={word("upload.remove")}
        thumbnailAlt={`${word("upload.alt")} cover.png`}
        brokenLabel={word("upload.broken")}
        onChoose={() => undefined}
        onRemove={() => undefined}
      />,
    );

    const thumbnail = container.querySelector("img");

    expect(thumbnail).not.toBeNull();
    expect(thumbnail).toHaveAttribute("src", "/assets/cover~1a2b3c4d.png");
    expect(thumbnail).toHaveClass("mc-uploader__thumb");
    // The name the operator gave the file, and never the minted key.
    expect(container.textContent).toContain("cover.png");
    expect(container.textContent).not.toContain("cover~1a2b3c4d.png");
  });

  it("gives what was chosen a button that takes it away", async () => {
    const removed = vi.fn();
    const user = userEvent.setup();

    render(
      <FileUpload
        kind="file"
        kindLabel={word("upload.kind")}
        fileName="guide.pdf"
        emptyHint={word("upload.empty")}
        chooseLabel={word("upload.choose")}
        replaceLabel={word("upload.replace")}
        removeLabel={word("upload.remove")}
        thumbnailAlt={word("upload.alt")}
        brokenLabel={word("upload.broken")}
        onChoose={() => undefined}
        onRemove={removed}
      />,
    );

    await user.click(
      screen.getByRole("button", { name: word("upload.remove") }),
    );

    expect(removed).toHaveBeenCalledTimes(1);
  });

  it("serves a document by marking its kind instead of drawing it", () => {
    // The same control, the other face: nothing is drawn of a PDF that a
    // picture would help anyone recognise, so what it shows is what it IS.
    const { container } = render(
      <FileUpload
        kind="file"
        kindLabel={word("upload.kind")}
        fileName="guide.pdf"
        emptyHint={word("upload.empty")}
        chooseLabel={word("upload.choose")}
        replaceLabel={word("upload.replace")}
        removeLabel={word("upload.remove")}
        thumbnailAlt={word("upload.alt")}
        brokenLabel={word("upload.broken")}
        onChoose={() => undefined}
        onRemove={() => undefined}
      />,
    );

    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector(".mc-uploader__mark")?.textContent).toBe(
      word("upload.kind"),
    );
    expect(container.textContent).toContain("guide.pdf");
  });

  it("offers the catalogue while nothing is chosen, and nothing to remove", async () => {
    const chosen = vi.fn();
    const user = userEvent.setup();
    const { container } = render(
      <FileUpload
        kind="image"
        kindLabel={word("upload.kind")}
        emptyHint={word("upload.empty")}
        chooseLabel={word("upload.choose")}
        replaceLabel={word("upload.replace")}
        removeLabel={word("upload.remove")}
        thumbnailAlt={word("upload.alt")}
        brokenLabel={word("upload.broken")}
        onChoose={chosen}
        onRemove={() => undefined}
      />,
    );

    expect(container.querySelector(".mc-uploader--empty")).not.toBeNull();
    expect(
      screen.queryByRole("button", { name: word("upload.remove") }),
    ).toBeNull();

    await user.click(
      screen.getByRole("button", { name: word("upload.choose") }),
    );

    expect(chosen).toHaveBeenCalledTimes(1);
  });

  it("falls back to a labelled mark when the picture does not load", () => {
    const { container } = render(
      <FileUpload
        kind="image"
        kindLabel={word("upload.kind")}
        fileName="cover.png"
        previewUrl="/assets/gone.png"
        emptyHint={word("upload.empty")}
        chooseLabel={word("upload.choose")}
        replaceLabel={word("upload.replace")}
        removeLabel={word("upload.remove")}
        thumbnailAlt={word("upload.alt")}
        brokenLabel={word("upload.broken")}
        onChoose={() => undefined}
        onRemove={() => undefined}
      />,
    );

    fireEvent.error(container.querySelector("img") as HTMLImageElement);

    expect(container.querySelector("img")).toBeNull();
    expect(
      container.querySelector(".mc-uploader__mark--broken")?.textContent,
    ).toContain(word("upload.broken"));
    // A resource whose address answered 404 is still chosen: the name stays.
    expect(container.textContent).toContain("cover.png");
  });
});

describe("REQ-291: the catalogue is a grid of tiles of one size, never a line", () => {
  it("draws every image as a thumbnail carrying its own address", () => {
    const { container } = render(catalogue());
    const tile = container.querySelector(".mc-assettile");
    const thumbnail = tile?.querySelector("img");

    expect(container.querySelector("ul.mc-assetgrid")).not.toBeNull();
    expect(thumbnail).not.toBeNull();
    expect(thumbnail).toHaveAttribute("src", "/assets/cover~1a2b3c4d.png");
    expect(thumbnail).toHaveAttribute(
      "alt",
      `${word("asset.alt")} ${"cover.png"}`,
    );
    // The whole point of the requirement: an image is never offered as its
    // name alone, which is what the dropdown this replaced could only do.
    expect(tile?.textContent).toContain("cover.png");
    expect(container.textContent).not.toContain("cover~1a2b3c4d.png");
  });

  it("gives a document the same tile, marked with its kind where the picture goes", () => {
    const { container } = render(catalogue());
    const cells = Array.from(
      container.querySelectorAll("ul.mc-assetgrid > li"),
    );
    const pdf = screen.getByRole("button", {
      name: `${word("asset.use")} guide.pdf`,
    });

    // One shape for the whole catalogue: the document's cell is the image's
    // cell down to the class the grid lays out by, so neither can be given a
    // width or a height the other is not (REQ-291). A tile laid out as a line
    // was tried, and refused by eye.
    expect(cells.map((cell) => cell.className)).toEqual([
      "mc-assetgrid__item",
      "mc-assetgrid__item",
    ]);
    expect(pdf).toHaveClass("mc-assettile");
    expect(container.querySelector(".mc-assetrow")).toBeNull();

    // Nothing is drawn of a PDF, so the frame that holds a thumbnail holds the
    // kind instead, and the name goes on reading on the tile: two documents
    // are told apart by the name and by nothing else.
    expect(pdf.querySelector("img")).toBeNull();
    expect(
      pdf.querySelector(".mc-assettile__frame .mc-assettile__kind")
        ?.textContent,
    ).toContain(word("asset.kind"));
    expect(pdf.querySelector(".mc-assettile__name")?.textContent).toContain(
      "guide.pdf",
    );
  });

  it("selects by the key and announces the one already chosen", async () => {
    const picked = vi.fn();
    const user = userEvent.setup();

    render(catalogue("cover~1a2b3c4d.png", picked));

    const chosen = screen.getByRole("button", {
      name: `${word("asset.use")} cover.png`,
    });

    expect(chosen).toHaveAttribute("aria-pressed", "true");

    await user.click(
      screen.getByRole("button", { name: `${word("asset.use")} guide.pdf` }),
    );

    // The KEY travels, because that is what a definition points at (REQ-292),
    // while the operator only ever read the name they gave the file.
    expect(picked).toHaveBeenCalledWith("guide~5e6f7a8b.pdf");
  });

  it("says the catalogue is empty instead of drawing an empty grid", () => {
    const { container } = render(
      catalogue(undefined, undefined, { items: [] }),
    );

    expect(container.querySelector("ul.mc-assetgrid")).toBeNull();
    expect(container.textContent).toContain(word("asset.empty"));
  });

  it("falls back to a labelled frame when a thumbnail does not load", () => {
    const { container } = render(catalogue());

    fireEvent.error(
      container.querySelector(".mc-assettile img") as HTMLImageElement,
    );

    expect(container.querySelector(".mc-assettile img")).toBeNull();
    expect(
      container.querySelector(".mc-assettile__fallback")?.textContent,
    ).toContain(word("asset.broken"));
  });
});

/* ------------------------------------------------------------------ *
 * REQ-293: deleting a file is an explicit act, confirmed on the tile
 * ------------------------------------------------------------------ */

/**
 * The back end has answered `usage` and `DELETE` since the catalogue was
 * built, and no screen called either: asked "how do I delete a file?", the
 * product had no answer. This is that answer, and its shape was decided by
 * eye: the confirmation happens on the TILE, inside the grid, because the
 * catalogue is already a dialog and a dialog stacked on a dialog puts the file
 * name in one window and the decision in another.
 *
 * What the tile has to say is the whole of REQ-293: how many automations use
 * the file, counted where the definitions are and never guessed here, and that
 * the messages ALREADY DELIVERED stop working, which is the part nothing
 * undoes. The button an operator sent yesterday points at our address, and the
 * address is what disappears.
 */

const GUIDE_KEY = "guide~5e6f7a8b.pdf";

describe("REQ-293: deleting a file is confirmed on the tile itself", () => {
  it("offers the deletion on every tile, by the key the catalogue deletes by", async () => {
    const asked = vi.fn();
    const user = userEvent.setup();

    render(catalogue(undefined, undefined, { onRemoveRequest: asked }));

    // Named per file, so twenty tiles are not twenty controls called Delete.
    await user.click(
      screen.getByRole("button", {
        name: `${word("asset.delete")} guide.pdf`,
      }),
    );

    expect(asked).toHaveBeenCalledWith(GUIDE_KEY);
  });

  it("turns that tile into the question, in the grid and not over it", () => {
    const { container, rerender } = render(catalogue());
    const before = container.querySelectorAll("ul.mc-assetgrid > li").length;

    rerender(
      catalogue(undefined, undefined, {
        removal: { name: GUIDE_KEY, usageCount: 3 },
      }),
    );

    const grid = container.querySelector("ul.mc-assetgrid");
    const asking = container.querySelector(".mc-assetconfirm");

    // Same grid, same cells: the question is asked where the file is.
    expect(container.querySelectorAll("ul.mc-assetgrid > li")).toHaveLength(
      before,
    );
    expect(asking?.closest("li")?.parentElement).toBe(grid);
    // And no second dialog over the one the catalogue already is.
    expect(container.querySelector('[role="dialog"]')).toBeNull();

    expect(asking?.textContent).toContain(
      `${word("asset.deleteAsk")} guide.pdf`,
    );
    // The count is the caller's, which is who asked the catalogue for it.
    expect(asking?.textContent).toContain(`${word("asset.usage")} 3`);
    expect(asking?.textContent).toContain(word("asset.warning"));

    // The rest of the catalogue is still the catalogue.
    expect(
      screen.getByRole("button", { name: `${word("asset.use")} cover.png` }),
    ).toHaveAttribute("aria-pressed", "false");
  });

  it("keeps the deletion shut until the count is in", () => {
    const { rerender } = render(
      catalogue(undefined, undefined, { removal: { name: GUIDE_KEY } }),
    );

    // A warning without its number is not the informed act REQ-293 asks for,
    // so the tile says the count is still travelling and commits nothing.
    expect(screen.getByText(word("asset.counting"))).not.toBeNull();
    expect(
      screen.getByRole("button", { name: word("asset.deleteYes") }),
    ).toBeDisabled();

    rerender(
      catalogue(undefined, undefined, {
        removal: { name: GUIDE_KEY, usageCount: 0 },
      }),
    );

    expect(screen.getByText(`${word("asset.usage")} 0`)).not.toBeNull();
    expect(
      screen.getByRole("button", { name: word("asset.deleteYes") }),
    ).toBeEnabled();
  });

  it("deletes when confirmed, and gives the tile back when refused", async () => {
    const confirmed = vi.fn();
    const refused = vi.fn();
    const user = userEvent.setup();
    const deletion = {
      removal: { name: GUIDE_KEY, usageCount: 2 },
      onRemoveConfirm: confirmed,
      onRemoveCancel: refused,
    };
    const { container, rerender } = render(
      catalogue(undefined, undefined, deletion),
    );

    await user.click(
      screen.getByRole("button", { name: word("asset.deleteYes") }),
    );
    await user.click(screen.getByRole("button", { name: word("asset.keep") }));

    expect(confirmed).toHaveBeenCalledWith(GUIDE_KEY);
    expect(refused).toHaveBeenCalledTimes(1);

    // Refused: the tile is a tile again, choosable as it was, and nothing was
    // deleted.
    rerender(catalogue(undefined, undefined, { onRemoveCancel: refused }));

    expect(container.querySelector(".mc-assetconfirm")).toBeNull();
    expect(
      screen.getByRole("button", { name: `${word("asset.use")} guide.pdf` }),
    ).toHaveAttribute("aria-pressed", "false");
  });

  it("says it is working, and refuses a second press while it is", () => {
    render(
      catalogue(undefined, undefined, {
        removal: { name: GUIDE_KEY, usageCount: 2, pending: true },
      }),
    );

    // A different word, because "Deleting" is not "Delete": the commit is out
    // of reach while it runs, and so is the way back, which has nothing left
    // to give back.
    expect(
      screen.getByRole("button", { name: word("asset.deleting") }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: word("asset.keep") }),
    ).toBeDisabled();
  });

  it("moves the focus into the question and back to the tile it was asked on", async () => {
    const user = userEvent.setup();
    const { rerender } = render(catalogue());

    await user.click(
      screen.getByRole("button", {
        name: `${word("asset.delete")} guide.pdf`,
      }),
    );
    rerender(
      catalogue(undefined, undefined, {
        removal: { name: GUIDE_KEY, usageCount: 2 },
      }),
    );

    // The way back holds the focus, not the way out: a confirmation opens on
    // the answer that changes nothing.
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: word("asset.keep") }),
    );

    rerender(catalogue());

    expect(document.activeElement).toBe(
      screen.getByRole("button", {
        name: `${word("asset.delete")} guide.pdf`,
      }),
    );
  });

  it("puts the focus on what took its place when the tile is gone", () => {
    const { container, rerender } = render(catalogue());

    rerender(
      catalogue(undefined, undefined, {
        removal: { name: GUIDE_KEY, usageCount: 0 },
      }),
    );
    // Deleted: the control the focus was on left the document with it, and
    // focus on a removed node is focus on the body, which inside a dialog is
    // nowhere at all.
    rerender(catalogue(undefined, undefined, { items: [ASSET_ITEMS[0]] }));

    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: `${word("asset.use")} cover.png` }),
    );

    rerender(
      catalogue(undefined, undefined, {
        items: [ASSET_ITEMS[0]],
        removal: { name: "cover~1a2b3c4d.png", usageCount: 0 },
      }),
    );
    rerender(catalogue(undefined, undefined, { items: [] }));

    // The last one: what is left is the sentence that stands for the whole
    // catalogue, and it takes the focus rather than dropping it.
    expect(document.activeElement).toBe(
      container.querySelector(".mc-assetgrid__empty"),
    );
  });
});

/* ------------------------------------------------------------------ *
 * REQ-298: the preview is drawn in the conversation's own colour
 * ------------------------------------------------------------------ */

/**
 * The handset beside the automation form draws Instagram's direct, and
 * Instagram's direct does not repaint itself when the operator changes the
 * theme of our panel. The drawing is a CITATION of another product, so it is
 * not entitled to our tokens: the user saw the two side by side and said the
 * prototype's version was the better one, which is that argument arriving from
 * the other end.
 *
 * Two questions, and neither answers the other:
 *
 *   - is each piece painted in the colour the prototype approves? Compared as
 *     the RESOLVED colour and never as the spelling, the way REQ-300 above
 *     compares a corner: the application names its values through the
 *     `--direct-*` family and the prototype writes the digits out, and what the
 *     user approved is the digits;
 *   - does anything in the quotation still reach for a token of the PRODUCT?
 *     That is the requirement stated mechanically rather than piece by piece,
 *     and it is what covers the two shapes the prototype never had to draw, the
 *     file row and the photograph, which have no counterpart to be held
 *     against. The panel AROUND the drawing is ours and keeps the product's
 *     tokens: the edge of the quotation is the handset, not the aside.
 *
 * What neither of them asks is whether those colours are legible, which is the
 * half that goes silent when a family leaves the palette: `styles/tokens.test.ts`
 * puts every pair the family makes against the same 4.5:1 as the rest of the
 * product, and refuses a fixed colour that no pair measures.
 */
const DIRECT_PREFIX = "--direct-";

/** A colour as six digits, whatever notation it was written in. */
function hexOf(value: string): string {
  const found = /#([\da-f]{3}|[\da-f]{6})\b/i.exec(value);

  if (found === null) {
    return "";
  }

  const digits = (found[1] ?? "").toLowerCase();

  return `#${digits.length === 3 ? [...digits].map((digit) => `${digit}${digit}`).join("") : digits}`;
}

/**
 * The colour one declaration ends up painting: the value read, its tokens
 * followed to the bottom, and the colour taken out of whatever else the
 * shorthand carries.
 *
 * A shorthand is why the colour is extracted rather than compared whole: the
 * bezel is `0.5rem solid var(--direct-bezel)` here and `9px solid #14161a`
 * there, and the requirement is about the colour and not about the millimetre.
 */
function paintedColour(
  body: string,
  property: string,
  tokens: ReadonlyMap<string, string>,
): string {
  return hexOf(resolved(declaredValue(body, property), tokens));
}

/** Each piece of the drawing, beside the rule of the prototype that decides it. */
const QUOTED: readonly {
  readonly what: string;
  readonly selector: string;
  readonly property: string;
  readonly approvedSelector: string;
  readonly approvedProperty: string;
}[] = [
  {
    what: "the bezel",
    selector: ".mc-phone",
    property: "border",
    approvedSelector: ".phone",
    approvedProperty: "border",
  },
  {
    what: "the screen",
    selector: ".mc-phone",
    property: "background",
    approvedSelector: ".phone-in",
    approvedProperty: "background",
  },
  {
    what: "the status bar",
    selector: ".mc-phone__bar",
    property: "color",
    approvedSelector: ".phone-top",
    approvedProperty: "color",
  },
  {
    what: "the name over a message",
    selector: ".mc-msg__who",
    property: "color",
    approvedSelector: ".who",
    approvedProperty: "color",
  },
  {
    what: "what a message is written in",
    selector: ".mc-msg__bubble",
    property: "color",
    approvedSelector: ".phone-in",
    approvedProperty: "color",
  },
  {
    what: "the contact's bubble",
    selector: ".mc-msg__bubble",
    property: "background",
    approvedSelector: ".bubble-them",
    approvedProperty: "background",
  },
  {
    what: "the account's bubble",
    selector: ".mc-msg--mine .mc-msg__bubble",
    property: "background",
    approvedSelector: ".bubble-you",
    approvedProperty: "background",
  },
  {
    what: "the ink on the account's bubble",
    selector: ".mc-msg--mine .mc-msg__bubble",
    property: "color",
    approvedSelector: ".bubble-you",
    approvedProperty: "color",
  },
  {
    what: "the card the delivery arrives in",
    selector: ".mc-preview-card",
    property: "background",
    approvedSelector: ".pcard",
    approvedProperty: "background",
  },
  {
    what: "the edge of that card",
    selector: ".mc-preview-card",
    property: "border",
    approvedSelector: ".pcard",
    approvedProperty: "border",
  },
  {
    what: "the card's second line",
    selector: ".mc-preview-card__text",
    property: "color",
    approvedSelector: ".pcard-body span",
    approvedProperty: "color",
  },
  {
    what: "the button the contact presses",
    selector: ".mc-preview-card__button",
    property: "color",
    approvedSelector: ".pcard-btn",
    approvedProperty: "color",
  },
  {
    what: "the line between two buttons",
    selector: ".mc-preview-card__button",
    property: "border-block-start",
    approvedSelector: ".pcard-btn",
    approvedProperty: "border-top",
  },
];

/**
 * The step label is deliberately not in that list, and the reason is a
 * measurement. The prototype drew it in a second, dimmer grey, #6f757e, which
 * reaches 4.19:1 on the screen it sits on, under the 4.5:1 floor
 * (`styles/tokens.test.ts`). It takes the grey of the name below it instead,
 * 6.28:1, which is the prototype's own other value and not an invented one.
 * Holding it against `.conv-label` here would have been binding the application
 * to a colour the contrast guardian refuses.
 *
 * The prototype was corrected to that same grey afterwards (3n.7), so the pair
 * would agree today. Adding it to the list is still a change to this guardian's
 * reach rather than a consequence of that repair, and it belongs to whoever
 * owns REQ-298 and REQ-299.
 */
const NOT_QUOTED = ".mc-msg__step";

/** Every piece the application paints differently, named with both colours. */
function quotationDrift(sheet: string): readonly string[] {
  return QUOTED.flatMap(
    ({ what, selector, property, approvedSelector, approvedProperty }) => {
      const painted = paintedColour(
        bodyFor(sheet, selector) ?? "",
        property,
        APPLICATION_TOKENS,
      );
      const approved = paintedColour(
        bodyFor(PROTOTYPE_SHEET, approvedSelector) ?? "",
        approvedProperty,
        PROTOTYPE_TOKENS,
      );

      return painted === approved
        ? []
        : [
            `${what} (${selector} ${property}) is ${painted || "unset"} in ${COMPONENT_SHEET_PATH}, ${approved || "unset"} at ${approvedSelector} in ${PROTOTYPE_PATH}`,
          ];
    },
  );
}

/** The blocks the drawing is made of, which is the reach of the sweep below. */
const QUOTED_BLOCK = /^mc-(?:phone|msg|preview-card|preview-link)(?:__|--|$)/;

/**
 * The properties that put a colour on the screen.
 *
 * Corners and shadows are out: `border-radius` is a step of a ladder and takes
 * the product's, and the shadow under the handset is how the drawing sits on
 * OUR panel rather than part of the drawing.
 */
const PAINTED_PROPERTY =
  /(?:^|[;{\s])(background-color|background|border-block-start|border-color|border|color)\s*:\s*([^;}]+)/g;

interface QuotedRule {
  readonly selector: string;
  readonly body: string;
}

/** Every rule of the sheet that paints a part of the quotation. */
const QUOTED_RULES: readonly QuotedRule[] = [
  ...withoutComments(COMPONENT_SHEET).matchAll(RULE),
]
  .map(([, prelude = "", body = ""]): QuotedRule => ({
    selector: prelude.trim().replace(/\s+/g, " "),
    body,
  }))
  .filter(({ selector }) =>
    [...selector.matchAll(/\.([\w-]+)/g)].some(([, name = ""]) =>
      QUOTED_BLOCK.test(name),
    ),
  );

/** Every product token still painting inside the quotation, named with its rule. */
function productTokensInQuotation(
  rules: readonly QuotedRule[],
): readonly string[] {
  return rules.flatMap(({ selector, body }) =>
    [...body.matchAll(PAINTED_PROPERTY)].flatMap(
      ([, property = "", value = ""]) =>
        [...value.matchAll(/var\((--[\w-]+)\)/g)]
          .map(([, name = ""]) => name)
          .filter((name) => !name.startsWith(DIRECT_PREFIX))
          .map(
            (name) =>
              `${selector} paints ${property} with ${name}, a token of the product, inside the conversation the preview quotes`,
          ),
    ),
  );
}

describe("REQ-298: the preview is drawn in the conversation's own colour", () => {
  it("reads both files, and finds every piece in each", () => {
    // A glob that matched nothing, a class renamed on either side, a `<style>`
    // block moved: each one leaves the comparison holding nothing against
    // nothing and reporting success.
    expect(PROTOTYPE_SHEET.length).toBeGreaterThan(0);
    expect(BASE_SHEET.length).toBeGreaterThan(0);

    for (const {
      what,
      selector,
      property,
      approvedSelector,
      approvedProperty,
    } of QUOTED) {
      expect(
        paintedColour(
          bodyFor(BASE_SHEET, selector) ?? "",
          property,
          APPLICATION_TOKENS,
        ),
        `${what}: ${selector} paints no ${property}`,
      ).toMatch(/^#[\da-f]{6}$/);
      expect(
        paintedColour(
          bodyFor(PROTOTYPE_SHEET, approvedSelector) ?? "",
          approvedProperty,
          PROTOTYPE_TOKENS,
        ),
        `${what}: ${approvedSelector} paints no ${approvedProperty}`,
      ).toMatch(/^#[\da-f]{6}$/);
    }

    // And the one piece held back from the comparison is really in the sheet,
    // so the note above is about a rule that exists.
    expect(bodyFor(BASE_SHEET, NOT_QUOTED)).toBeDefined();
  });

  it("paints every piece in the colour the prototype approves", () => {
    expect(quotationDrift(BASE_SHEET)).toEqual([]);
  });

  it("reports a piece painted in a product token, naming both colours", () => {
    // The rule exactly as it stood before REQ-298: the account's bubble in the
    // accent, which is the drawing following the theme of the panel beside it.
    const stale = BASE_SHEET.replace(
      "background: var(--direct-mine);",
      "background: var(--accent);",
    );

    expect(quotationDrift(stale)).toEqual([
      `the account's bubble (.mc-msg--mine .mc-msg__bubble background) is ${resolved("var(--accent)", APPLICATION_TOKENS)} in ${COMPONENT_SHEET_PATH}, ${paintedColour(bodyFor(PROTOTYPE_SHEET, ".bubble-you") ?? "", "background", PROTOTYPE_TOKENS)} at .bubble-you in ${PROTOTYPE_PATH}`,
    ]);
  });

  it("lets no token of the product paint inside the quotation", () => {
    // The sweep has to have found the drawing: a regex that matched no rule
    // would report nothing forever.
    const selectors = QUOTED_RULES.map(({ selector }) => selector);

    expect(selectors.length).toBeGreaterThan(15);
    expect(selectors).toContain(".mc-phone");
    expect(selectors).toContain(".mc-msg--mine .mc-msg__bubble");
    expect(selectors).toContain(".mc-preview-card__button");

    expect(productTokensInQuotation(QUOTED_RULES)).toEqual([]);
  });

  it("reports a product token inside the drawing, naming the rule", () => {
    expect(
      productTokensInQuotation([
        {
          selector: ".mc-msg__bubble",
          body: "background: var(--surface-card);",
        },
      ]),
    ).toEqual([
      ".mc-msg__bubble paints background with --surface-card, a token of the product, inside the conversation the preview quotes",
    ]);
  });
});

/* ------------------------------------------------------------------ *
 * REQ-307, REQ-308: what the platform will do to this text, while it is typed
 * ------------------------------------------------------------------ */

/**
 * The layer that replaced a refusal (REQ-306), and the reason it is TWO things
 * and not one message with a number in it.
 *
 * A quick reply label longer than the platform shows is ACCEPTED: it is stored
 * whole, it is delivered whole, and what the contact sees is cut. The old
 * behaviour refused to store it, which refused what the platform itself
 * delivers, and the measurement on the real account on 2026-08-19 is what
 * settled that (`docs/platform-limits.md`, the note "O corte do rótulo"). So
 * one nature PREDICTS, and it may not be drawn as an error, because the field
 * is not in error. The other nature is a refusal that has not happened yet, and
 * it may not be drawn as a prediction, because something IS going to be turned
 * away.
 *
 * What is proved here, in that order: the two counts and the one that decides;
 * the boundary, which is strictly past and never at; which nature wins when
 * both ceilings are behind; that the sentence appears and goes with the
 * keystrokes; that the field keeps carrying it to whoever is not looking at the
 * screen; and that the difference between the natures survives in the markup,
 * in the glyph and in the token, and not in a colour alone.
 */

/**
 * Fixture ceilings, and deliberately NOT the platform's own numbers: what this
 * layer answers for is firing on the ceiling it was GIVEN. The real numbers
 * live in configuration (`src/config/limits.ts`) and reach a screen from there,
 * which is what keeps a platform limit out of the code that draws.
 */
const TRUNCATES_AT = 20;
const REFUSES_AT = 30;

/** A text a person and `String.length` count the same way. */
function plain(count: number): string {
  return "a".repeat(count);
}

/**
 * The character REQ-306's finding turned on: one to whoever typed it, two to
 * `String.length`. A twenty-character label ending in it counted twenty-one,
 * and the count argued with anybody counting by eye.
 */
const LOCK = "🔒";

const CATALOGUES = { en, "pt-BR": pt } as const;

/**
 * The shipped sentence of a nature, reached through the key the layer
 * publishes: a key that named nothing would make every assertion below compare
 * an empty string with an empty string.
 */
function sentenceOf(
  locale: keyof typeof CATALOGUES,
  nature: LengthAdviceNature,
): string {
  const [section = "", name = ""] = LENGTH_ADVICE_TEXT_KEYS[nature].split(".");
  const body = (CATALOGUES[locale] as Record<string, unknown>)[section];
  const sentence =
    typeof body === "object" && body !== null
      ? (body as Record<string, unknown>)[name]
      : undefined;

  return typeof sentence === "string" ? sentence : "";
}

/** The catalogue's sentence with its number in it, as a screen renders it. */
function said(nature: LengthAdviceNature, max: number): string {
  return sentenceOf("en", nature).split("{{max}}").join(String(max));
}

/** A field wired the way a screen wires it: the advice recomputed per keystroke. */
function AdvisedField({
  ceilings,
}: {
  readonly ceilings: LengthCeilings;
}): ReactElement {
  const [value, setValue] = useState("");
  const advice = lengthAdvice(value, ceilings);

  return (
    <Field
      id="advised"
      label={word("field.label")}
      advice={
        advice === undefined
          ? undefined
          : {
              nature: advice.nature,
              message: said(advice.nature, advice.limit),
            }
      }
      value={value}
      onChange={(event) => setValue(event.target.value)}
    />
  );
}

describe("REQ-307: the cut is predicted while the text is typed", () => {
  it("counts what a person counts and what String.length counts", () => {
    expect(measureLength(plain(TRUNCATES_AT))).toEqual({
      graphemes: TRUNCATES_AT,
      units: TRUNCATES_AT,
      counted: TRUNCATES_AT,
    });

    // The disagreement itself: twenty characters on screen, twenty-one units.
    expect(measureLength(`${plain(TRUNCATES_AT - 1)}${LOCK}`)).toEqual({
      graphemes: TRUNCATES_AT,
      units: TRUNCATES_AT + 1,
      counted: TRUNCATES_AT + 1,
    });
  });

  it("says nothing while the text is inside the ceiling", () => {
    expect(
      lengthAdvice(plain(TRUNCATES_AT), { truncatesAt: TRUNCATES_AT }),
    ).toBeUndefined();
  });

  it("predicts the cut one character past the point the platform truncates", () => {
    expect(
      lengthAdvice(plain(TRUNCATES_AT + 1), { truncatesAt: TRUNCATES_AT }),
    ).toMatchObject({ nature: "truncation", limit: TRUNCATES_AT });
  });

  it("fires on whichever count reaches the ceiling first", () => {
    // Twenty characters to whoever typed them and twenty-one units to the
    // platform's counter, against a ceiling of twenty: the count that fires is
    // the one that got there first, which is what stops a text from arriving
    // cut with no advice at all.
    const advice = lengthAdvice(`${plain(TRUNCATES_AT - 1)}${LOCK}`, {
      truncatesAt: TRUNCATES_AT,
    });

    expect(advice?.measured.graphemes).toBe(TRUNCATES_AT);
    expect(advice?.nature).toBe("truncation");
  });

  it("advises nothing about a ceiling the field does not have", () => {
    expect(lengthAdvice(plain(REFUSES_AT * 2), {})).toBeUndefined();
    // Past what would be a maximum, on a field that has none: still the cut.
    expect(
      lengthAdvice(plain(REFUSES_AT + 1), { truncatesAt: TRUNCATES_AT })
        ?.nature,
    ).toBe("truncation");
  });

  it("appears as the text passes the point and goes when it comes back", async () => {
    const user = userEvent.setup();

    render(<AdvisedField ceilings={{ truncatesAt: TRUNCATES_AT }} />);

    const field = within(document.body).getByRole("textbox");
    const sentence = said("truncation", TRUNCATES_AT);

    expect(sentence).not.toBe("");

    await user.type(field, plain(TRUNCATES_AT));
    expect(within(document.body).queryByText(sentence)).toBeNull();

    await user.type(field, "a");
    expect(within(document.body).getByText(sentence)).toBeInTheDocument();
    // The field is NOT in error: this text is going to be stored whole, and
    // marking it invalid would say the opposite of the sentence beside it.
    expect(field).not.toHaveAttribute("aria-invalid");

    await user.keyboard("{Backspace}");
    expect(within(document.body).queryByText(sentence)).toBeNull();
  });
});

describe("REQ-308: the refusal to come is said in red, and goes when it stops being true", () => {
  it("appears past the maximum and goes when the text comes back inside", async () => {
    const user = userEvent.setup();

    render(
      <AdvisedField
        ceilings={{ truncatesAt: TRUNCATES_AT, refusesAt: REFUSES_AT }}
      />,
    );

    const field = within(document.body).getByRole("textbox");
    const sentence = said("limit", REFUSES_AT);

    expect(sentence).not.toBe("");

    await user.type(field, plain(REFUSES_AT));
    expect(within(document.body).queryByText(sentence)).toBeNull();

    await user.type(field, "a");
    expect(within(document.body).getByText(sentence)).toBeInTheDocument();

    await user.keyboard("{Backspace}");
    expect(within(document.body).queryByText(sentence)).toBeNull();
    // Back inside the maximum and still past the point of the cut, so what is
    // left standing is the OTHER nature and not silence.
    expect(
      within(document.body).getByText(said("truncation", TRUNCATES_AT)),
    ).toBeInTheDocument();
  });

  it("says the refusal and not the cut when the text is past both", () => {
    expect(
      lengthAdvice(plain(REFUSES_AT + 1), {
        truncatesAt: TRUNCATES_AT,
        refusesAt: REFUSES_AT,
      }),
    ).toMatchObject({ nature: "limit", limit: REFUSES_AT });
  });

  it("is written in the token the field's own refusal is written in", () => {
    const refusal = bodyFor(BASE_SHEET, ".mc-field__error");
    const limit = bodyFor(BASE_SHEET, ".mc-field__advice--limit");
    const truncation = bodyFor(BASE_SHEET, ".mc-field__advice--truncation");

    expect(
      limit,
      `.mc-field__advice--limit is in ${COMPONENT_SHEET_PATH}`,
    ).toBeDefined();
    expect(
      truncation,
      `.mc-field__advice--truncation is in ${COMPONENT_SHEET_PATH}`,
    ).toBeDefined();

    // The red is the one the form already refuses in, named rather than picked:
    // a second red would be a second answer to the same question.
    expect(refusal).toContain("color: var(--danger-ink);");
    expect(limit).toContain("color: var(--danger-ink);");
    // And the prediction is NOT that red, which is the whole of the two natures
    // as far as a stylesheet can carry it.
    expect(truncation).not.toContain("var(--danger-ink)");
    expect(truncation).toContain("color: var(--warning-ink);");
  });
});

describe("REQ-307, REQ-308: one layer, two natures, and nobody left out of it", () => {
  it("names a sentence in both languages for each nature, never the same one", () => {
    for (const locale of Object.keys(
      CATALOGUES,
    ) as (keyof typeof CATALOGUES)[]) {
      const sentences = LENGTH_ADVICE_NATURES.map((nature) =>
        sentenceOf(locale, nature),
      );

      for (const [index, sentence] of sentences.entries()) {
        const nature = LENGTH_ADVICE_NATURES[index] ?? "limit";

        // The number the platform imposes is said, and it arrives from
        // configuration through the caller: a sentence with the number written
        // into it would be a platform limit living in the catalogue.
        expect(
          sentence,
          `${locale}: ${LENGTH_ADVICE_TEXT_KEYS[nature]}`,
        ).toContain("{{max}}");
      }

      // Two natures, two sentences: the tone is carried by the words before it
      // is carried by anything a stylesheet does.
      expect(new Set(sentences).size, locale).toBe(sentences.length);
    }
  });

  it("marks the two natures apart in the markup and in the glyph", () => {
    const drawn = LENGTH_ADVICE_NATURES.map((nature) => {
      const { container, unmount } = render(
        <Field
          id="advised"
          label={word("field.label")}
          advice={{ nature, message: word(`field.${nature}`) }}
        />,
      );

      const advice = container.querySelector(".mc-field__advice");
      const drawing = {
        className: advice?.className ?? "",
        glyph: advice?.querySelector("svg")?.innerHTML ?? "",
      };

      unmount();
      return drawing;
    });

    const [limit, truncation] = drawn;

    expect(limit?.className).not.toBe(truncation?.className);
    // Colour is never the only carrier (the design system's rule 4.2), so the
    // mark differs too: the refusal to come takes the refusal's own glyph, and
    // the prediction takes one that is not an alert.
    expect(limit?.glyph).not.toBe("");
    expect(limit?.glyph).not.toBe(truncation?.glyph);
  });

  it("is announced when it appears, and politely", () => {
    render(
      <Field
        id="advised"
        label={word("field.label")}
        advice={{ nature: "limit", message: word("field.advice") }}
      />,
    );

    // `status` and not `alert`: it comes and goes with the keystrokes, and an
    // assertive region would cut across the letters being echoed back.
    expect(within(document.body).getByRole("status")).toHaveTextContent(
      word("field.advice"),
    );
  });

  it.each(NESTED_CONTROLS)(
    "hands $name the advice of the field it sits in",
    ({ role, control }) => {
      render(
        <Field
          id="nested"
          label={word("field.label")}
          hint={word("field.hint")}
          advice={{ nature: "truncation", message: word("field.advice") }}
        >
          {control}
        </Field>,
      );

      const focusable = within(document.body).getByRole(role);

      // The defect REQ-185 exists for, in the slot added last: an advice drawn
      // on the screen and wired to nothing is an advice for whoever is looking
      // at it, and for nobody else.
      expect(focusable).toHaveAttribute(
        "aria-describedby",
        "nested-advice nested-field-hint",
      );
      expect(focusable).toHaveAccessibleDescription(
        `${word("field.advice")} ${word("field.hint")}`,
      );
      expect(focusable).not.toHaveAttribute("aria-invalid");
    },
  );
});

/* ------------------------------------------------------------------ *
 * REQ-312: the answer to a write is a toast, announced and temporary
 * ------------------------------------------------------------------ */

/**
 * The other half of the pair `Notice` is the first half of.
 *
 * What is proved here is the whole of what makes an automatic dismissal safe,
 * because a message that removes itself is a defect unless every one of these
 * holds: it is ANNOUNCED (a live region, said in both attributes REQ-312 names);
 * it stays long enough to be READ, and longer when there is more of it; it stops
 * leaving while anybody is reading it; and it can be sent away by hand.
 *
 * The clock is the part with no other way to check it. A duration is invisible
 * on screen and invisible in a snapshot, so it is driven here with fake timers
 * and asserted at the boundary from both sides: one millisecond before, still
 * there; one millisecond after, gone. A test that only advanced "a lot" would
 * pass over a floor of eight seconds and over a floor of eight milliseconds.
 */
describe("REQ-312: a toast is announced, waits to be read, and then goes", () => {
  const MESSAGE = word("toast.message");

  function raise(onDismiss: () => void, message: string = MESSAGE): void {
    render(
      <Toast
        nature="success"
        message={message}
        dismissLabel={word("toast.dismiss")}
        onDismiss={onDismiss}
      />,
    );
  }

  /** The toast, found through the strip it is portalled into. */
  function box(): HTMLElement {
    const strip = document.getElementById(TOAST_VIEWPORT_ID);

    if (strip === null) throw new Error("no toast has been raised");

    return within(strip).getByRole("status");
  }

  /** Runs a body with the clock in hand, and gives the clock back either way. */
  function onFakeTime(body: () => void): void {
    vi.useFakeTimers();

    try {
      body();
    } finally {
      vi.useRealTimers();
    }
  }

  it("announces itself politely, in both of the attributes the rule names", () => {
    raise(() => undefined);

    // The two together and not the role alone: `status` carries an implicit
    // polite live region, and what is implicit is what a screen reader is free
    // to disagree about.
    expect(box()).toHaveAttribute("role", "status");
    expect(box()).toHaveAttribute("aria-live", "polite");
    expect(box()).toHaveTextContent(MESSAGE);
  });

  it("is drawn in a strip fixed to the viewport, and not at the top of the page", () => {
    const { container } = render(<div />);

    raise(() => undefined);

    // Not in the caller's own tree at all, which is the whole mechanism: the
    // page it answers for may be scrolled anywhere.
    expect(container.contains(box())).toBe(false);
    expect(document.getElementById(TOAST_VIEWPORT_ID)?.contains(box())).toBe(
      true,
    );
    // jsdom applies no stylesheet, so the RULE is what is asserted, exactly as
    // the sweeps above assert every other rule of this sheet.
    expect(withoutComments(COMPONENT_SHEET)).toMatch(
      /\.mc-toasts\s*\{[^}]*position:\s*fixed/,
    );
  });

  it("goes by itself, once the sentence has had the time to be read", () => {
    onFakeTime(() => {
      const dismissed = vi.fn();

      raise(dismissed);

      act(() => {
        vi.advanceTimersByTime(TOAST_FLOOR_MS - 1);
      });
      expect(dismissed).not.toHaveBeenCalled();

      act(() => {
        vi.advanceTimersByTime(1);
      });
      expect(dismissed).toHaveBeenCalledTimes(1);
    });
  });

  it("gives a longer sentence longer, under a floor and under a ceiling", () => {
    // The floor is what a short confirmation gets, and it is a FLOOR: the
    // arithmetic would give "Draft saved" under a second.
    expect(toastReadingTimeMs("Draft saved.")).toBe(TOAST_FLOOR_MS);

    // Past the floor the length decides, which is what the long sentences this
    // catalogue writes on purpose need.
    const long = "x".repeat(400);

    expect(toastReadingTimeMs(long)).toBe(400 * TOAST_MS_PER_CHARACTER);
    expect(toastReadingTimeMs(long)).toBeGreaterThan(TOAST_FLOOR_MS);

    expect(toastReadingTimeMs("x".repeat(10_000))).toBe(TOAST_CEILING_MS);
  });

  it("counts the title in, because the title is read too", () => {
    const title = "y".repeat(300);

    expect(toastReadingTimeMs(title + "x".repeat(300))).toBeGreaterThan(
      toastReadingTimeMs("x".repeat(300)),
    );
  });

  it("stops the clock while the pointer is on it, and resumes where it stopped", () => {
    onFakeTime(() => {
      const dismissed = vi.fn();

      raise(dismissed);

      act(() => {
        vi.advanceTimersByTime(3_000);
      });
      fireEvent.mouseEnter(box());

      // However long the pointer rests there: somebody reading is not somebody
      // to be interrupted, and this is what makes the close button reachable
      // at all.
      act(() => {
        vi.advanceTimersByTime(60_000);
      });
      expect(dismissed).not.toHaveBeenCalled();

      fireEvent.mouseLeave(box());

      // What is LEFT, and not the whole time again: five of the eight seconds
      // were already read.
      act(() => {
        vi.advanceTimersByTime(TOAST_FLOOR_MS - 3_000 - 1);
      });
      expect(dismissed).not.toHaveBeenCalled();

      act(() => {
        vi.advanceTimersByTime(1);
      });
      expect(dismissed).toHaveBeenCalledTimes(1);
    });
  });

  it("stops the clock while the caret is inside it", () => {
    onFakeTime(() => {
      const dismissed = vi.fn();

      raise(dismissed);

      const close = within(box()).getByRole("button", {
        name: word("toast.dismiss"),
      });

      act(() => {
        close.focus();
      });
      act(() => {
        vi.advanceTimersByTime(TOAST_FLOOR_MS * 4);
      });

      // The keyboard's version of the sentence above: a control that leaves
      // while the caret is on it drops the focus onto the body.
      expect(dismissed).not.toHaveBeenCalled();
    });
  });

  it("is sent away by hand, on a control named from the catalogue", () => {
    const dismissed = vi.fn();

    raise(dismissed);

    const close = within(box()).getByRole("button", {
      name: word("toast.dismiss"),
    });

    // `--tap` square, like every icon button of the system (REQ-268): a toast
    // that can only be closed by aiming at eighteen pixels is a toast nobody
    // closes.
    expect(close.classList).toContain("mc-iconbtn");

    fireEvent.click(close);

    expect(dismissed).toHaveBeenCalledTimes(1);
  });
});

/**
 * REQ-315: the handset shows all of a long message, or scrolls to it
 *
 * The defect this guards was found by eye, with a capture, and it could only
 * be found that way: jsdom applies no stylesheet, so no test in this
 * repository has ever been able to fail on a rendered width. What follows is
 * therefore the half a stylesheet CAN be held to, that the carrying
 * declarations are written, on the boxes that carry them, and that the classes
 * they name are really the classes the markup wears. The pixels behind it
 * were measured in Chrome against the built sheet, at 320, 390, 768 and 1440
 * wide, in windows 600, 800 and 1400 tall, in both themes.
 *
 * What the measurement said, and why each rule below exists. With the
 * sixty-seven character quick reply the operator really stored on the account
 * (the platform accepts it; only the editor warns, REQ-307), the thread laid
 * itself out 499px wide inside a 312px screen. The bezel's `overflow: hidden`
 * then cut 187px off the right of EVERY message, not only the long one, since
 * one column sizes them all: what he read was "Clica no", "o limi", "Estou e",
 * words broken mid-way. The widest box in the drawing was the quick reply
 * chip, at 467px, because a chip's label may not wrap and an unwrappable line
 * carries its own full length as a minimum, and a grid item is never made
 * narrower than its minimum unless it is told it may be.
 *
 * After the rules below, in all 120 measured combinations: nothing crosses the
 * frame, the thread's scroll width equals its client width, and what exceeds
 * the height scrolls instead of disappearing.
 */
describe("REQ-339: the preview draws the line breaks the direct will carry", () => {
  it("keeps the operator's newlines in the bubble, instead of collapsing them", () => {
    const bubble = bodyFor(BASE_SHEET, ".mc-msg__bubble");

    expect(
      bubble,
      `.mc-msg__bubble declares nothing in ${COMPONENT_SHEET_PATH}`,
    ).toBeDefined();
    // `pre-line` would satisfy the newline and silently normalise runs of
    // spaces, which a preview that must not lie may not do.
    expect(bubble).toContain("white-space: pre-wrap");
  });

  it("leaves the listing card flattening on purpose, because it composes a sentence", () => {
    // The card does NOT quote the operator: it builds a catalogue sentence
    // with their words set inside it (`emphasised`). A newline there would cut
    // a sentence in half, and the two reserved lines of the title are sized
    // for a summary and not for a message. The flattening is a decision, so it
    // is asserted rather than left to whichever rule happens to win.
    for (const selector of [".mc-autocard", ".mc-autocard__title"]) {
      const body = bodyFor(BASE_SHEET, selector);
      if (body !== undefined) {
        expect(body).not.toContain("white-space: pre-wrap");
        expect(body).not.toContain("white-space: pre-line");
      }
    }
  });
});

describe("REQ-315: the handset shows all of a long message, or scrolls to it", () => {
  /** What the sheet declares for exactly this selector, unconditionally. */
  function handsetRule(selector: string): string {
    const body = bodyFor(BASE_SHEET, selector);

    // A selector that has stopped existing must not read as a rule that has
    // stopped being needed: every case below asserts on this text, and an
    // empty string would satisfy the negative ones for free.
    expect(
      body,
      `${selector} declares nothing in ${COMPONENT_SHEET_PATH}`,
    ).toBeDefined();

    return body ?? "";
  }

  /**
   * Every box between the bezel and the words, and what each one is told.
   *
   * Written as a list because the chain is the point: each of these is an item
   * of the box above it, so a repair at one level only moves the overflow one
   * level in. The first three are grid containers whose single column has to
   * be the width of the screen rather than the width of its contents; the
   * fourth is the item whose own minimum was beating the maximum beside it.
   */
  const CHAIN: readonly (readonly [string, string])[] = [
    [".mc-phone", "grid-template-columns: minmax(0, 1fr)"],
    [".mc-phone__thread", "grid-template-columns: minmax(0, 1fr)"],
    [".mc-msg", "grid-template-columns: minmax(0, 1fr)"],
    [".mc-msg__bubble", "min-inline-size: 0"],
  ];

  it("lets every box between the frame and the words be narrower than its content", () => {
    for (const [selector, declaration] of CHAIN) {
      expect(handsetRule(selector), selector).toContain(declaration);
    }
  });

  it("keeps the bubble's maximum a maximum, measured against the screen", () => {
    const bubble = handsetRule(".mc-msg__bubble");

    // The pair is the claim: 90% of what is only ever 90% of the frame. The
    // cap on its own is what the capture showed being obeyed on paper while
    // half the bubble sat outside the phone.
    expect(bubble).toContain("max-inline-size: 90%");
    expect(bubble).toContain("min-inline-size: 0");
  });

  it("scrolls what exceeds the height instead of hiding it", () => {
    const thread = handsetRule(".mc-phone__thread");

    expect(thread).toContain("overflow-y: auto");
    expect(thread).toContain("overscroll-behavior: contain");
    // The bezel goes on clipping, which is what a bezel is: the difference is
    // that nothing reaches it any more.
    expect(handsetRule(".mc-phone")).toContain("overflow: hidden");
  });

  it("caps the screen once, and never puts a floor under it", () => {
    // One ceiling, in one rule. A second one written anywhere else is a second
    // answer to "how tall is a handset", and the first screen to disagree with
    // it would be the one nobody is looking at.
    const ceilings = [...BASE_SHEET.matchAll(RULE)].flatMap(
      ([, prelude = "", body = ""]) =>
        prelude.includes(".mc-phone") &&
        /max-(?:block-size|height)\s*:/.test(body)
          ? [prelude.trim()]
          : [],
    );

    expect(ceilings).toEqual([".mc-phone__thread"]);
    expect(handsetRule(".mc-phone__thread")).toContain(
      "max-block-size: min(60vh, 34rem)",
    );

    // And it is a ceiling and nothing else: a minimum height here would be a
    // second rule deciding the floor of a box, which one rule already decides
    // for the whole interface (REQ-281).
    for (const [selector] of [[".mc-phone"], [".mc-phone__thread"]]) {
      expect(handsetRule(selector ?? ""), selector).not.toMatch(
        /min-(?:block-size|height)\s*:/,
      );
    }
  });

  it("wraps the words of a quick reply inside the handset, and only there", () => {
    // In the editor a chip is one of a row of pills and one line with an
    // ellipsis is its right shape, with the whole word a click away in the
    // field it came from. Inside the drawing the same rule was the widest box
    // on screen, and an ellipsis there would answer a question about
    // truncation by truncating.
    expect(handsetRule(".mc-phone .mc-chip__label")).toContain(
      "white-space: normal",
    );
    expect(handsetRule(".mc-chip__label")).toContain("white-space: nowrap");
  });

  it("names the classes the markup really wears, with a label too long for one line", () => {
    // The rules above are worth nothing against a selector nobody renders.
    const label =
      "Ja estou te seguindo por aqui e quero receber o guia completo agora!";
    const { container } = render(<Chip tone="accent">{label}</Chip>);
    const worn = container.querySelector(".mc-chip__label");

    expect(worn).not.toBeNull();
    expect(worn?.textContent).toBe(label);
    expect(container.querySelector(".mc-chip--accent")).not.toBeNull();
  });

  it("draws that chip and those bubbles inside the handset the sheet talks about", () => {
    // The other end of the same pairing: the screen that owns the drawing.
    // Both halves have to be here, because a rule with no markup and markup
    // with no rule fail in exactly the same way and neither says so.
    const [, screenSource = ""] =
      WEB_FILES.find(
        ([path]) => path === "src/web/screens/automation-form.tsx",
      ) ?? [];

    expect(screenSource.length).toBeGreaterThan(0);

    for (const name of [
      "mc-phone",
      "mc-phone__thread",
      "mc-msg__bubble",
      '<Chip tone="accent">',
    ]) {
      expect(screenSource, name).toContain(name);
    }
  });
});

/* ------------------------------------------------------------------ *
 * REQ-331: the mark is the name, set in type
 * ------------------------------------------------------------------ */

/**
 * The wordmark, which was a square with a letter in it until the user asked for
 * the prototype's treatment while there is no logo.
 *
 * The square was not careless: the repository ships no logo, nothing was
 * invented in its place, and the letter inside it was taken from the name so
 * that no symbol was drawn. What replaces it keeps the same rule and drops the
 * shape. `My` in the ink of the text around it, `Chat` in the accent, and
 * nothing else on the screen.
 *
 * Three claims, and each is proved where it can be:
 *
 *   - STRUCTURE, off a render: one element inside the mark, the name unbroken
 *     as text, and no square anywhere in the rail;
 *   - the WORDS, off the catalogues: two keys that really are the name split in
 *     two, in every locale. Three keys for one name is three chances to drift,
 *     and this is what makes them one fact;
 *   - the TYPE, off the sheets, against `docs/prototipo-automacao.html` the way
 *     REQ-300 above does it: RESOLVED values, never spellings, because what the
 *     user approved is what the page painted.
 *
 * The colour is not compared here beyond the token the accent word is written
 * in: `styles/tokens.test.ts` measures that ink on the grounds the mark stands
 * on, in both themes, which is the half of REQ-331 a render cannot answer.
 */
const PROTOTYPE_BRAND = ".brand";

const PROTOTYPE_BRAND_ACCENT = ".brand span";

const BRAND = ".mc-brand";

const BRAND_ACCENT = ".mc-brand__accent";

/** What the prototype decides about the wordmark, in the requirement's words. */
const BRAND_TYPE: readonly {
  readonly name: string;
  readonly property: string;
}[] = [
  { name: "weight", property: "font-weight" },
  { name: "tracking", property: "letter-spacing" },
];

/** Every property of the mark the application paints differently. */
function brandDrift(mark: string, accent: string): readonly string[] {
  const approvedMark = bodyFor(PROTOTYPE_SHEET, PROTOTYPE_BRAND) ?? "";
  const approvedAccent = bodyFor(PROTOTYPE_SHEET, PROTOTYPE_BRAND_ACCENT) ?? "";

  const drifted = (
    [
      [BRAND, mark, approvedMark, BRAND_TYPE],
      [
        BRAND_ACCENT,
        accent,
        approvedAccent,
        [{ name: "ink", property: "color" }],
      ],
    ] as const
  ).flatMap(([selector, painted, approved, followed]) =>
    followed.flatMap(({ name, property }) => {
      const here = resolved(
        declaredValue(painted, property),
        APPLICATION_TOKENS,
      );
      const there = resolved(
        declaredValue(approved, property),
        PROTOTYPE_TOKENS,
      );

      return here === there
        ? []
        : [
            `${selector}: ${name} (${property}) is ${here || "unset"} in ${COMPONENT_SHEET_PATH}, ${there || "unset"} in ${PROTOTYPE_PATH}`,
          ];
    }),
  );

  return drifted;
}

describe("REQ-331: the brand is the name in type, and the square is gone", () => {
  it("draws the name as one string, in two spans and no more", () => {
    const { container } = render(
      <Brand lead={word("nav.brandLead")} accent={word("nav.brandAccent")} />,
    );
    const mark = container.querySelector(BRAND);

    expect(mark).not.toBeNull();
    // Unbroken, which is what keeps a colour change inside a name from being
    // two words to whoever is listening to the page instead of looking at it.
    expect(mark?.textContent).toBe(
      `${word("nav.brandLead")}${word("nav.brandAccent")}`,
    );
    expect(mark?.querySelector(BRAND_ACCENT)?.textContent).toBe(
      word("nav.brandAccent"),
    );
    // One child and nothing else: no chip, no square, no glyph.
    expect(mark?.querySelectorAll("*")).toHaveLength(1);
  });

  it("puts no square at the top of the rail", () => {
    const { container } = render(
      <AppNav
        label={word("nav.label")}
        brandLead={word("nav.brandLead")}
        brandAccent={word("nav.brandAccent")}
        current="/dashboard"
        items={[
          {
            id: "/dashboard",
            href: "/dashboard",
            label: word("nav.dashboard"),
            icon: "layout-dashboard",
          },
        ]}
      />,
    );

    expect(container.querySelector(BRAND)).not.toBeNull();
    expect(container.querySelector('[class*="brandmark"]')).toBeNull();
    // And the rule the square was drawn by is out of the sheet as well, in the
    // rail and in the bar the rail folds into: a class left behind is a mark
    // one line of JSX away from coming back.
    expect(COMPONENT_SHEET.length).toBeGreaterThan(0);
    expect(COMPONENT_SHEET).not.toContain("mc-nav__brand");
    expect(COMPONENT_SHEET).not.toContain("mc-shell__brand");
  });

  it("carries the two words in every catalogue, and never translates them", () => {
    const names = Object.entries(CATALOGUES).map(([locale, catalogue]) => {
      const { brandLead, brandAccent } = catalogue.nav;

      expect(brandLead, locale).not.toBe("");
      expect(brandAccent, locale).not.toBe("");

      return `${brandLead}|${brandAccent}`;
    });

    // The whole name lives nowhere else: the catalogue used to carry it beside
    // the halves and REQ-172 called that third copy dead the moment nothing
    // asked for it, which it was. So the halves ARE the name, and the one thing
    // left to hold is that they say the same thing in every language: a product
    // name is not a word to translate, and a catalogue with `Chat` turned into
    // `Conversa` would put another product's mark on the rail.
    expect(new Set(names).size, names.join(", ")).toBe(1);
  });

  it("reads both files, and finds the mark in each", () => {
    // A selector renamed on either side leaves every comparison below holding
    // an empty string against an empty string and reporting success.
    expect(PROTOTYPE_SHEET.length).toBeGreaterThan(0);
    expect(BASE_SHEET.length).toBeGreaterThan(0);

    for (const selector of [PROTOTYPE_BRAND, PROTOTYPE_BRAND_ACCENT]) {
      expect(
        bodyFor(PROTOTYPE_SHEET, selector),
        `${selector} is in ${PROTOTYPE_PATH}`,
      ).toBeDefined();
    }

    for (const selector of [BRAND, BRAND_ACCENT]) {
      expect(
        bodiesOf(selector)[0],
        `${selector} is in ${COMPONENT_SHEET_PATH}`,
      ).toBeDefined();
    }
  });

  it("sets the name in the weight, the tracking and the ink the prototype draws", () => {
    const [mark] = bodiesOf(BRAND);
    const [accent] = bodiesOf(BRAND_ACCENT);

    expect(brandDrift(mark ?? "", accent ?? "")).toEqual([]);
  });

  it("reports a value the screen changed, naming the property and both sides", () => {
    // The mark as the rail drew it before this requirement: the weight of a
    // heading, and the name in one ink with the accent nowhere in it.
    const stale = (bodiesOf(BRAND)[0] ?? "").replace(
      "font-weight: var(--weight-brand);",
      "font-weight: var(--weight-semibold);",
    );

    expect(brandDrift(stale, "")).toEqual([
      `${BRAND}: weight (font-weight) is ${resolved("var(--weight-semibold)", APPLICATION_TOKENS)} in ${COMPONENT_SHEET_PATH}, 650 in ${PROTOTYPE_PATH}`,
      `${BRAND_ACCENT}: ink (color) is unset in ${COMPONENT_SHEET_PATH}, ${resolved("var(--accent)", PROTOTYPE_TOKENS)} in ${PROTOTYPE_PATH}`,
    ]);
  });
});
