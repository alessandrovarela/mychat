import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { AssetPicker, httpAssetsClient } from "./flow-step-fields.js";
import type {
  AssetListOutcome,
  AssetRemoveOutcome,
  AssetUploadOutcome,
  AssetUsageOutcome,
  AssetsClient,
} from "./flow-step-fields.js";

const COPY: Readonly<Record<string, string>> = {
  "screens.assets.choose": "Choose from my files",
  "screens.assets.replace": "Replace",
  "screens.assets.remove": "Remove",
  "screens.assets.noImageYet": "No image chosen yet",
  "screens.assets.noFileYet": "No file chosen yet",
  "screens.assets.stored": "Stored with us",
  "screens.assets.documentKind": "PDF",
  "screens.assets.thumbnailAlt": "Thumbnail of {{name}}",
  "screens.assets.thumbnailBroken": "No preview",
  "screens.assets.use": "Use {{name}}",
  "screens.assets.deleteLabel": "Delete {{name}}",
  "screens.assets.deleteQuestion": "Delete {{name}}?",
  "screens.assets.deleteCounting": "Counting where it is used",
  "screens.assets.deleteUnused": "No automation uses this file.",
  "screens.assets.deleteUsage": "Used by {{count}} automations.",
  "screens.assets.deleteWarning":
    "The messages already delivered stop working: whoever already received the link can no longer open it.",
  "screens.assets.deleteConfirm": "Delete",
  "screens.assets.deleteWorking": "Deleting",
  "screens.assets.deleteCancel": "Keep",
  "screens.assets.catalogueTitle": "Your files",
  "screens.assets.catalogueClose": "Close your files",
  "screens.assets.catalogueEmpty": "You have not sent any file yet",
  "screens.assets.loading": "Reading resources",
  "screens.assets.uploadLabel": "Send a new file",
  "screens.assets.uploadHint": "Everything you sent is kept here",
  "screens.assets.uploading": "Uploading the resource",
  "screens.assets.assetHint": "Choose or upload a resource",
  "screens.assets.assetDefaultHint": "Default resource: {{value}}",
  "screens.assets.sessionExpired": "Session expired",
  "screens.assets.invalidData": "Invalid data",
  "screens.assets.invalidName": "Invalid name",
  "screens.assets.unsupportedType":
    "Unsupported type. Accepted formats: {{formats}}.",
  "screens.assets.tooLarge": "Too large",
  "screens.assets.alreadyExists": "A resource with that name already exists",
  "screens.assets.notFound":
    "That file no longer exists, so nothing was deleted.",
  "screens.assets.unreachable": "Catalogue unavailable",
  "screens.assets.failed": "Resource operation failed",
  "screens.automations.optionalLabel": "optional",
};

function t(key: string, params?: Record<string, unknown>): string {
  return (COPY[key] ?? key).replace(/\{\{(\w+)\}\}/g, (_, name: string) =>
    String(params?.[name] ?? ""),
  );
}

/**
 * A resource as the catalogue really answers it since REQ-292: the KEY is
 * minted at upload so a second `guide.pdf` is a second resource, and the name
 * the operator gave the file travels beside it. Every fixture here carries the
 * pair, because a fixture where the two are equal cannot tell which one the
 * screen puts on the tile.
 */
const GUIDE = {
  name: "guide~1a2b3c4d.pdf",
  fileName: "guide.pdf",
  publicUrl: "/assets/guide~1a2b3c4d.pdf",
} as const;

const COVER = {
  name: "cover~5e6f7a8b.png",
  fileName: "cover.png",
  publicUrl: "/assets/cover~5e6f7a8b.png",
} as const;

/**
 * The catalogue as a stub, with the two deletion answers already good.
 *
 * Defaulted rather than demanded of every call site: most of what is proved
 * here never deletes anything, and a fixture that has to spell out four
 * methods to test an upload is a fixture nobody reads. What a case cares about
 * it overrides.
 */
function clientOf(
  list: AssetListOutcome,
  upload: () => Promise<AssetUploadOutcome>,
  rest: Partial<AssetsClient> = {},
): AssetsClient {
  return {
    list: vi.fn(async () => list),
    upload: vi.fn(upload),
    usage: vi.fn(async (): Promise<AssetUsageOutcome> => ({
      ok: true,
      usedBy: 0,
    })),
    remove: vi.fn(async (): Promise<AssetRemoveOutcome> => ({ ok: true })),
    ...rest,
  };
}

describe("resource selector and uploader", () => {
  it("reads the upload content types and size ceiling from the catalogue", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          assets: [COVER],
          upload: { contentTypes: ["image/png"], maxBytes: 2048 },
        }),
        { status: 200 },
      ),
    );
    await expect(httpAssetsClient.list()).resolves.toEqual({
      ok: true,
      assets: [COVER],
      upload: { contentTypes: ["image/png"], maxBytes: 2048 },
    });
    fetchMock.mockRestore();
  });

  it("drops an entry that arrives without the name its operator gave it", async () => {
    // The route answers all three fields. Half-reading one would put the minted
    // key on the tile, which is the exact thing the grid exists to stop.
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          assets: [{ name: GUIDE.name, publicUrl: GUIDE.publicUrl }, COVER],
          upload: { contentTypes: ["image/png"], maxBytes: 2048 },
        }),
        { status: 200 },
      ),
    );

    await expect(httpAssetsClient.list()).resolves.toMatchObject({
      ok: true,
      assets: [COVER],
    });
    fetchMock.mockRestore();
  });

  it("REQ-291: opens the catalogue as pictures and writes the key of the one chosen", async () => {
    const onChange = vi.fn();
    const client = clientOf({ ok: true, assets: [COVER] }, async () => ({
      ok: false,
      reason: "failed",
    }));
    const user = userEvent.setup();

    render(
      <AssetPicker
        id="asset"
        label="Resource"
        value={undefined}
        optional={false}
        accept="image"
        t={t}
        client={client}
        onChange={onChange}
      />,
    );

    await user.click(await screen.findByLabelText("Resource"));

    const dialog = await screen.findByRole("dialog");
    const thumbnail = dialog.querySelector("img");

    expect(thumbnail).toHaveAttribute("src", COVER.publicUrl);
    expect(thumbnail).toHaveAttribute("alt", "Thumbnail of cover.png");
    // What the operator reads is the name they gave the file. The key is what
    // travels, and it never appears on screen (REQ-292).
    expect(dialog.textContent).toContain("cover.png");
    expect(dialog.textContent).not.toContain(COVER.name);

    await user.click(screen.getByRole("button", { name: "Use cover.png" }));

    expect(onChange).toHaveBeenCalledWith(COVER.name);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("REQ-291: shows a document as a grid tile with its kind, and no picture", async () => {
    const client = clientOf({ ok: true, assets: [GUIDE] }, async () => ({
      ok: false,
      reason: "failed",
    }));
    const user = userEvent.setup();

    render(
      <AssetPicker
        id="asset"
        label="Resource"
        value={undefined}
        optional={false}
        t={t}
        client={client}
        onChange={vi.fn()}
      />,
    );

    await user.click(await screen.findByLabelText("Resource"));

    const dialog = await screen.findByRole("dialog");
    const tile = dialog.querySelector(".mc-assettile");

    expect(tile).not.toBeNull();
    expect(dialog.querySelector(".mc-assetrow")).toBeNull();
    expect(tile?.closest("li")).not.toHaveClass("mc-assetgrid__item--wide");
    expect(tile?.querySelector("img")).toBeNull();
    expect(
      tile?.querySelector(".mc-assettile__frame .mc-assettile__kind")
        ?.textContent,
    ).toContain("PDF");
    expect(tile?.textContent).toContain("guide.pdf");
  });

  it("REQ-290: shows the chosen resource and takes it back", async () => {
    const onChange = vi.fn();
    const client = clientOf({ ok: true, assets: [COVER] }, async () => ({
      ok: false,
      reason: "failed",
    }));
    const user = userEvent.setup();

    const { container } = render(
      <AssetPicker
        id="asset"
        label="Resource"
        value={COVER.name}
        optional={false}
        accept="image"
        t={t}
        client={client}
        onChange={onChange}
      />,
    );

    await waitFor(() =>
      expect(container.querySelector(".mc-uploader__thumb")).toHaveAttribute(
        "src",
        COVER.publicUrl,
      ),
    );
    expect(screen.getByText("cover.png")).toBeInTheDocument();
    expect(screen.queryByText(COVER.name)).toBeNull();

    await user.click(screen.getByRole("button", { name: "Remove" }));

    expect(onChange).toHaveBeenCalledWith(undefined);
  });

  it("lets the screen own what removing means, when it means more", async () => {
    // The cover of a card is offered by a control the form draws, so taking the
    // picture away has to take that offer with it (REQ-232). Left to this
    // component, removing would clear the choice and leave the empty control.
    const onChange = vi.fn();
    const onRemove = vi.fn();
    const client = clientOf({ ok: true, assets: [COVER] }, async () => ({
      ok: false,
      reason: "failed",
    }));
    const user = userEvent.setup();

    render(
      <AssetPicker
        id="asset"
        label="Resource"
        value={COVER.name}
        optional
        accept="image"
        t={t}
        client={client}
        onChange={onChange}
        onRemove={onRemove}
      />,
    );

    await user.click(await screen.findByRole("button", { name: "Remove" }));

    expect(onRemove).toHaveBeenCalledTimes(1);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("keeps the reference unchanged until the upload answers", async () => {
    const onChange = vi.fn();
    let finish!: (outcome: AssetUploadOutcome) => void;
    const upload = vi.fn(
      () =>
        new Promise<AssetUploadOutcome>((resolve) => {
          finish = resolve;
        }),
    );
    const client = clientOf({ ok: true, assets: [] }, upload);
    const user = userEvent.setup();

    render(
      <AssetPicker
        id="asset"
        label="Resource"
        value={undefined}
        optional={false}
        t={t}
        client={client}
        onChange={onChange}
      />,
    );

    // A PDF, because that is the only file format the platform carries and
    // therefore the only one this control offers (REQ-231).
    const file = new File(["hello"], "guide.pdf", { type: "application/pdf" });
    await user.upload(await screen.findByLabelText("Send a new file"), file);

    expect(upload).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "guide.pdf",
        contentType: "application/pdf",
        data: expect.any(String),
      }),
    );
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Resource")).toBeDisabled();

    finish({ ok: true, asset: GUIDE });

    await waitFor(() => expect(onChange).toHaveBeenCalledWith(GUIDE.name));
    // And it joins the catalogue under the name its operator gave it.
    await user.click(screen.getByLabelText("Resource"));
    expect(
      await screen.findByRole("button", { name: "Use guide.pdf" }),
    ).toBeInTheDocument();
  });

  it("localizes a refusal and does not write its name", async () => {
    const onChange = vi.fn();
    const client = clientOf({ ok: true, assets: [] }, async () => ({
      ok: false,
      reason: "already_exists",
    }));
    const user = userEvent.setup();

    render(
      <AssetPicker
        id="asset"
        label="Resource"
        value={undefined}
        optional={false}
        t={t}
        client={client}
        onChange={onChange}
      />,
    );

    await user.upload(
      await screen.findByLabelText("Send a new file"),
      new File(["hello"], "guide.pdf", { type: "application/pdf" }),
    );

    expect(
      await screen.findByText(COPY["screens.assets.alreadyExists"] ?? ""),
    ).toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("rejects a non-image in the image picker before uploading", async () => {
    const upload = vi.fn(async (): Promise<AssetUploadOutcome> => ({
      ok: true,
      asset: { ...GUIDE },
    }));
    const client = clientOf(
      {
        ok: true,
        assets: [],
        upload: {
          contentTypes: ["application/pdf", "image/png"],
          maxBytes: 2048,
        },
      },
      upload,
    );
    render(
      <AssetPicker
        id="image"
        label="Image"
        value={undefined}
        optional
        accept="image"
        t={t}
        client={client}
        onChange={vi.fn()}
      />,
    );
    fireEvent.change(await screen.findByLabelText("Send a new file"), {
      target: {
        files: [new File(["pdf"], "wrong.pdf", { type: "application/pdf" })],
      },
    });
    expect(upload).not.toHaveBeenCalled();
    // REQ-231: the refusal NAMES what would have worked, and names only what
    // this control takes — sending someone to convert their cover into a PDF
    // would be worse than saying nothing.
    expect(
      screen.getByText("Unsupported type. Accepted formats: image/png."),
    ).toBeInTheDocument();
  });

  it("refuses a WebP cover before spending an upload on it", async () => {
    // The format the platform does not carry (REQ-231). Caught here, the
    // operator learns it while choosing the file; caught at the delivery, they
    // learn it from a contact who never received anything.
    const upload = vi.fn(async (): Promise<AssetUploadOutcome> => ({
      ok: true,
      asset: {
        name: "cover~9c8d7e6f.webp",
        fileName: "cover.webp",
        publicUrl: "/assets/cover~9c8d7e6f.webp",
      },
    }));
    const client = clientOf(
      {
        ok: true,
        assets: [],
        upload: {
          contentTypes: ["application/pdf", "image/jpeg", "image/png"],
          maxBytes: 2048,
        },
      },
      upload,
    );
    render(
      <AssetPicker
        id="image"
        label="Image"
        value={undefined}
        optional
        accept="image"
        t={t}
        client={client}
        onChange={vi.fn()}
      />,
    );
    fireEvent.change(await screen.findByLabelText("Send a new file"), {
      target: {
        files: [new File(["webp"], "cover.webp", { type: "image/webp" })],
      },
    });

    expect(upload).not.toHaveBeenCalled();
    expect(
      screen.getByText(
        "Unsupported type. Accepted formats: image/jpeg, image/png.",
      ),
    ).toBeInTheDocument();
  });

  it("says the file no longer exists when another tab removed it first", async () => {
    const client = clientOf({ ok: true, assets: [GUIDE] }, refusedUpload, {
      usage: vi.fn(async () => ({ ok: true as const, usedBy: 0 })),
      remove: vi.fn(async (): Promise<AssetRemoveOutcome> => ({
        ok: false,
        reason: "not_found",
      })),
    });
    const user = userEvent.setup();

    render(
      <AssetPicker
        id="asset"
        label="Resource"
        value={undefined}
        optional={false}
        t={t}
        client={client}
        onChange={vi.fn()}
      />,
    );

    await user.click(await screen.findByLabelText("Resource"));
    await user.click(
      await screen.findByRole("button", { name: "Delete guide.pdf" }),
    );
    await screen.findByText("No automation uses this file.");
    await user.click(screen.getByRole("button", { name: "Delete" }));

    expect(
      await screen.findByText(
        "That file no longer exists, so nothing was deleted.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Use guide.pdf" }),
    ).toBeInTheDocument();
  });

  /**
   * REQ-293, the half that had no screen: the catalogue could delete since it
   * was built, and nothing ever called it. Asked "how do I delete a file?",
   * the product's answer was that you do not.
   *
   * The count is the point of these three. It is READ from the catalogue, per
   * file, at the moment the deletion is asked for, because the screen holds
   * one automation's definition and the question is about all of them: an
   * automation nobody can parse any more still holds the key, and the contacts
   * it wrote to still have the link.
   */
  const refusedUpload = async (): Promise<AssetUploadOutcome> => ({
    ok: false,
    reason: "failed",
  });

  it("REQ-293: counts the uses at the catalogue and warns on the tile itself", async () => {
    const client = clientOf({ ok: true, assets: [GUIDE] }, refusedUpload, {
      usage: vi.fn(async () => ({ ok: true as const, usedBy: 3 })),
    });
    const user = userEvent.setup();

    render(
      <AssetPicker
        id="asset"
        label="Resource"
        value={undefined}
        optional={false}
        t={t}
        client={client}
        onChange={vi.fn()}
      />,
    );

    await user.click(await screen.findByLabelText("Resource"));
    await user.click(
      await screen.findByRole("button", { name: "Delete guide.pdf" }),
    );

    // Asked by the KEY, which is what the catalogue answers about (REQ-292).
    expect(client.usage).toHaveBeenCalledWith(GUIDE.name);

    const dialog = await screen.findByRole("dialog");
    const asking = await waitFor(() => {
      const found = dialog.querySelector(".mc-assetconfirm");
      expect(found?.textContent).toContain("Used by 3 automations.");
      return found;
    });

    // In the grid, on the tile, and not in a second dialog over the first.
    expect(asking?.closest("li")?.parentElement).toBe(
      dialog.querySelector("ul.mc-assetgrid"),
    );
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(asking?.textContent).toContain("Delete guide.pdf?");
    expect(asking?.textContent).toContain(
      "The messages already delivered stop working",
    );
  });

  it("REQ-293: confirming deletes the file and lets go of the reference", async () => {
    const onChange = vi.fn();
    const client = clientOf({ ok: true, assets: [GUIDE] }, refusedUpload, {
      usage: vi.fn(async () => ({ ok: true as const, usedBy: 1 })),
      remove: vi.fn(async () => ({ ok: true as const })),
    });
    const user = userEvent.setup();

    render(
      <AssetPicker
        id="asset"
        label="Resource"
        value={GUIDE.name}
        optional={false}
        t={t}
        client={client}
        onChange={onChange}
      />,
    );

    await user.click(await screen.findByLabelText("Resource"));
    await user.click(
      await screen.findByRole("button", { name: "Delete guide.pdf" }),
    );
    await user.click(
      // The word alone, which is the commit: the tile's own control is named
      // for its file ("Delete guide.pdf") and is not in the document while the
      // question stands.
      await screen.findByRole("button", { name: "Delete" }),
    );

    expect(client.remove).toHaveBeenCalledWith(GUIDE.name);
    // The tile is gone from the catalogue, and so is the reference to it: a
    // definition pointing at bytes that are not there is a dead link found at
    // delivery, by a contact already waiting.
    expect(
      await screen.findByText("You have not sent any file yet"),
    ).toBeInTheDocument();
    expect(onChange).toHaveBeenCalledWith(undefined);
  });

  it("REQ-373: deleting a selected cover lets the form remove its empty cover field", async () => {
    const onChange = vi.fn();
    const onRemove = vi.fn();
    const client = clientOf({ ok: true, assets: [COVER] }, refusedUpload, {
      usage: vi.fn(async () => ({ ok: true as const, usedBy: 1 })),
      remove: vi.fn(async () => ({ ok: true as const })),
    });
    const user = userEvent.setup();

    render(
      <AssetPicker
        id="cover"
        label="Cover"
        value={COVER.name}
        optional
        accept="image"
        t={t}
        client={client}
        onChange={onChange}
        onRemove={onRemove}
      />,
    );

    await user.click(await screen.findByLabelText("Cover"));
    await user.click(
      await screen.findByRole("button", { name: "Delete cover.png" }),
    );
    await user.click(await screen.findByRole("button", { name: "Delete" }));

    expect(client.remove).toHaveBeenCalledWith(COVER.name);
    expect(onRemove).toHaveBeenCalledTimes(1);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("REQ-293: refusing gives the tile back and deletes nothing", async () => {
    const client = clientOf({ ok: true, assets: [GUIDE] }, refusedUpload, {
      usage: vi.fn(async () => ({ ok: true as const, usedBy: 2 })),
      remove: vi.fn(async () => ({ ok: true as const })),
    });
    const user = userEvent.setup();

    render(
      <AssetPicker
        id="asset"
        label="Resource"
        value={undefined}
        optional={false}
        t={t}
        client={client}
        onChange={vi.fn()}
      />,
    );

    await user.click(await screen.findByLabelText("Resource"));
    await user.click(
      await screen.findByRole("button", { name: "Delete guide.pdf" }),
    );
    await screen.findByText("Used by 2 automations.");
    await user.click(screen.getByRole("button", { name: "Keep" }));

    const dialog = await screen.findByRole("dialog");

    expect(client.remove).not.toHaveBeenCalled();
    expect(dialog.querySelector(".mc-assetconfirm")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Use guide.pdf" }),
    ).toBeInTheDocument();
  });

  /**
   * REQ-303, and what it is really about.
   *
   * The report was that the catalogue never came back after a click outside
   * it, and the guess in the notes was a flag left true. It is not: the flag
   * comes back on all three ways out, which is what these cases hold. What
   * did not come back was the OPERATOR's place on the page, because the
   * dialog dropped focus on `body` when it went. On a form as long as this
   * one, the control that opens the catalogue is then unfocused and, after
   * any scrolling, off screen: nothing on the page leads back to it, which is
   * why the operator's only way out was reloading.
   *
   * The other half of that place is the page's own scroll, held by
   * `overscroll-behavior` on the veil. That one is layout, so it is measured
   * in a browser and cannot be asserted here.
   */
  const exits: readonly {
    name: string;
    leave: (user: ReturnType<typeof userEvent.setup>) => Promise<void>;
  }[] = [
    {
      name: "the veil",
      leave: async (): Promise<void> => {
        const veil = document.querySelector(".mc-overlay");
        // `mousedown`, because that is the event the veil answers: a click
        // that STARTED inside the dialog must not close it.
        fireEvent.mouseDown(veil as Element);
      },
    },
    {
      name: "the escape key",
      leave: async (user): Promise<void> => {
        await user.keyboard("{Escape}");
      },
    },
    {
      name: "the button in the footer",
      leave: async (user): Promise<void> => {
        await user.click(
          screen.getByRole("button", { name: "Close your files" }),
        );
      },
    },
  ];

  for (const exit of exits) {
    it(`REQ-303: closing by ${exit.name} gives the control back its focus, and the catalogue opens again`, async () => {
      const client = clientOf({ ok: true, assets: [GUIDE] }, refusedUpload);
      const user = userEvent.setup();

      render(
        <AssetPicker
          id="asset"
          label="Resource"
          value={undefined}
          optional={false}
          t={t}
          client={client}
          onChange={vi.fn()}
        />,
      );

      const choose = await screen.findByLabelText("Resource");

      await user.click(choose);
      await screen.findByRole("dialog");

      await exit.leave(user);

      expect(screen.queryByRole("dialog")).toBeNull();
      expect(choose).toHaveFocus();

      await user.click(choose);

      expect(await screen.findByRole("dialog")).toBeInTheDocument();
    });
  }

  it("REQ-304: the catalogue is left by a button in the footer, beside the action, and carries no X", async () => {
    const client = clientOf({ ok: true, assets: [GUIDE] }, refusedUpload);
    const user = userEvent.setup();

    render(
      <AssetPicker
        id="asset"
        label="Resource"
        value={undefined}
        optional={false}
        t={t}
        client={client}
        onChange={vi.fn()}
      />,
    );

    await user.click(await screen.findByLabelText("Resource"));

    const dialog = await screen.findByRole("dialog");
    const foot = dialog.querySelector(".mc-modal__foot");

    expect(
      within(foot as HTMLElement).getByRole("button", {
        name: "Close your files",
      }),
    ).toBeInTheDocument();
    expect(
      within(foot as HTMLElement).getByRole("button", {
        name: "Send a new file",
      }),
    ).toBeInTheDocument();
    // The head holds the title and nothing to press: one way out, and the one
    // that is read rather than the one that is spotted.
    expect(
      (dialog.querySelector(".mc-modal__head") as HTMLElement).querySelector(
        "button",
      ),
    ).toBeNull();
  });
});

/* ------------------------------------------------------------------
 * REQ-335: the catalogue's explanation is a sentence for the DESKTOP
 * ------------------------------------------------------------------ */

/**
 * The stylesheet, as text.
 *
 * jsdom applies no CSS, so nothing here can measure that the sentence is off
 * the picture on a 320px screen: that half was measured in Chrome, at 320 and
 * at 1024. What IS decided without a browser is the half that rots, and it is
 * the one that matters most here: WHICH way the sentence is hidden. Hidden
 * with `display: none` it would leave the accessibility tree too, and the
 * operator who hears this dialog would stop being told that a file survives
 * the automation that used it.
 *
 * Read through `import.meta.glob` and not through an import, for the reason
 * `styles/tokens.test.ts` records: a `?raw` specifier would break
 * `tests/import-extensions.test.ts` (REQ-082).
 */
const SHEETS = import.meta.glob<string>("../components/components.css", {
  eager: true,
  query: "?raw",
  import: "default",
});

const COMPONENT_SHEET = Object.values(SHEETS)[0] ?? "";

/** The body of the first `{ ... }` after `header`, braces balanced. */
function blockAfter(source: string, header: string): string {
  const open = source.indexOf("{", source.indexOf(header));
  let depth = 0;

  for (let index = open; index < source.length; index += 1) {
    depth += source[index] === "{" ? 1 : source[index] === "}" ? -1 : 0;

    if (depth === 0) {
      return source.slice(open + 1, index);
    }
  }

  return "";
}

/** The media query a selector is written INSIDE, header and body. */
function queryAround(selector: string): { header: string; body: string } {
  const at = COMPONENT_SHEET.indexOf(selector);

  expect(at, `${selector} is not in the sheet at all`).toBeGreaterThan(-1);

  const opened = COMPONENT_SHEET.lastIndexOf("@media", at);

  expect(opened, `${selector} is under no media query`).toBeGreaterThan(-1);

  const rest = COMPONENT_SHEET.slice(opened);
  const body = blockAfter(rest, "@media");

  // The nearest `@media` above it could be one that CLOSED before it: the
  // block is read back to check the selector is really inside this one.
  expect(body, `${selector} is outside the query above it`).toContain(selector);

  return {
    header: rest.slice(0, rest.indexOf("{")).trim(),
    body,
  };
}

describe("REQ-335: the catalogue explains itself on the desktop only", () => {
  it("marks the lead as the one the narrow layout does not draw", async () => {
    const client = clientOf({ ok: true, assets: [GUIDE] }, async () => ({
      ok: false,
      reason: "failed",
    }));
    const user = userEvent.setup();

    render(
      <AssetPicker
        id="asset"
        label="Resource"
        value={undefined}
        optional={false}
        t={t}
        client={client}
        onChange={vi.fn()}
      />,
    );

    await user.click(await screen.findByLabelText("Resource"));

    const dialog = await screen.findByRole("dialog");
    const lead = dialog.querySelector(".mc-modal__lead");

    expect(lead?.textContent).toBe("Everything you sent is kept here");
    expect(lead).toHaveClass("mc-modal__lead--wide");

    // And it is still THERE, on every width, which is the other half of the
    // decision: the screen writes the sentence and the sheet decides who sees
    // it. A dialog that dropped the paragraph from the document would pass a
    // photograph of a handset and fail the operator using a screen reader.
    expect(
      within(dialog).getByText("Everything you sent is kept here"),
    ).toBeInTheDocument();
  });

  it("hides it below the desktop cutoff, and hides it from the eye only", () => {
    // A sweep that read an empty module would pass everything below forever:
    // vitest replaces a stylesheet with nothing unless `css` is on.
    expect(COMPONENT_SHEET.length).toBeGreaterThan(0);

    const { header, body } = queryAround(".mc-modal__lead--wide");

    // The cutoff the shell and the editor already answer "is this the desktop
    // layout" with. A third number would be a second answer to one question.
    expect(header).toMatch(/@media\s*\(max-width:\s*48rem\)/);

    const rule = blockAfter(body, ".mc-modal__lead--wide");

    // Off the picture: clipped to a point, and out of flow so the head does not
    // keep its gap. This is `.mc-offscreen`'s recipe, which the file input in
    // this same dialog is already hidden with.
    expect(rule).toContain("position: absolute;");
    expect(rule).toContain("clip-path: inset(50%);");

    // And NOT out of the document. `display: none` is not a stronger version of
    // the same thing: it takes the sentence away from a screen reader as well,
    // and the cost this removal is paying is vertical pixels, which a screen
    // reader does not spend.
    expect(rule).not.toContain("display: none");

    // The modifier carries it, never the base class: the other dialog of this
    // product leads with a sentence too (the publication picker), and it was
    // not asked to lose it.
    expect(body).not.toContain(".mc-modal__lead {");
  });
});
