import { useEffect, useRef, useState } from "react";
import type { ChangeEvent, ReactElement } from "react";
import {
  AssetGrid,
  Button,
  Field,
  FileUpload,
  Modal,
  Notice,
} from "../components/index.js";
import type { AssetRemoval, AssetTile } from "../components/index.js";

/**
 * The resource control of the unified automation editor (REQ-223, REQ-224).
 *
 * This file used to carry a second thing: the per-type field editor of the v1
 * flow screen, which the phase-3k aggregate replaced. It went out with the
 * screen that mounted it, and with it went the controls that asked an operator
 * for a parameter name, a delivery form and a button label, which REQ-214
 * forbids the common path from showing at all.
 */

export type Translate = (
  key: string,
  params?: Record<string, unknown>,
) => string;

/**
 * The private catalogue entry the resource controls can point at.
 *
 * Two names, and the difference is the whole reason the screen reads one and
 * writes the other: `name` is the catalogue's KEY, minted at upload so that two
 * uploads of `guide.pdf` are two resources (REQ-292), and `fileName` is what
 * the operator called the file. A definition points at the key; a person picks
 * by the name they typed, which is why `guide~1a2b3c4d.pdf` never reaches the
 * screen.
 */
export interface AssetEntry {
  readonly name: string;
  readonly fileName: string;
  readonly publicUrl: string;
}

export interface AssetUploadContract {
  readonly contentTypes: readonly string[];
  readonly maxBytes: number;
}

export type AssetFailureReason =
  | "unreachable"
  | "unauthorized"
  | "failed"
  | "invalid_data"
  | "invalid_name"
  | "unsupported_content_type"
  | "too_large"
  | "already_exists"
  | "not_found";

export type AssetListOutcome =
  | {
      readonly ok: true;
      readonly assets: readonly AssetEntry[];
      readonly upload?: AssetUploadContract;
    }
  | { readonly ok: false; readonly reason: AssetFailureReason };

export type AssetUploadInput = Readonly<{
  name: string;
  contentType: string;
  data: string;
}>;

export type AssetUploadOutcome =
  | { readonly ok: true; readonly asset: AssetEntry }
  | { readonly ok: false; readonly reason: AssetFailureReason };

/**
 * How many automations use one resource, counted where they are stored.
 *
 * A number and not a guess: the screen holds the definitions it was given for
 * ONE automation, and the question is about all of them, including the ones no
 * current parser can read (`src/storage/asset-usage.ts`).
 */
export type AssetUsageOutcome =
  | { readonly ok: true; readonly usedBy: number }
  | { readonly ok: false; readonly reason: AssetFailureReason };

export type AssetRemoveOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: AssetFailureReason };

/** The one transport boundary shared by the flow and automation forms. */
export interface AssetsClient {
  list(): Promise<AssetListOutcome>;
  upload(input: AssetUploadInput): Promise<AssetUploadOutcome>;
  /** Asked BEFORE the deletion, so the warning can carry a number (REQ-293). */
  usage(name: string): Promise<AssetUsageOutcome>;
  remove(name: string): Promise<AssetRemoveOutcome>;
}

export const ASSETS_ENDPOINT = "/api/assets";

interface AssetAnswer {
  readonly status: number;
  readonly body: unknown;
}

function assetRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

async function assetCall(
  url: string,
  init?: RequestInit,
): Promise<AssetAnswer | undefined> {
  try {
    const response = await fetch(url, init);
    const body: unknown = await response.json().catch(() => undefined);

    return { status: response.status, body };
  } catch {
    return undefined;
  }
}

function assetFailure(answer: AssetAnswer | undefined): AssetFailureReason {
  if (answer === undefined) {
    return "unreachable";
  }

  if (answer.status === 401) {
    return "unauthorized";
  }

  const code = assetRecord(answer.body)?.["error"];

  return code === "invalid_data" ||
    code === "invalid_name" ||
    code === "unsupported_content_type" ||
    code === "too_large" ||
    code === "already_exists" ||
    code === "not_found"
    ? code
    : "failed";
}

function assetEntries(value: unknown): AssetEntry[] {
  const raw = assetRecord(value)?.["assets"];

  if (!Array.isArray(raw)) {
    return [];
  }

  return raw.flatMap((entry): AssetEntry[] => assetOf(entry) ?? []);
}

/**
 * One catalogue entry off the wire, or nothing.
 *
 * The route answers all three fields (`src/http/api/assets.ts`), so an entry
 * missing one is an answer this screen does not understand and drops rather
 * than half-reads: a tile with no `fileName` would be labelled with the minted
 * key, which is the exact thing the grid exists to stop showing.
 */
function assetOf(value: unknown): [AssetEntry] | undefined {
  const record = assetRecord(value);

  return typeof record?.["name"] === "string" &&
    typeof record["fileName"] === "string" &&
    typeof record["publicUrl"] === "string"
    ? [
        {
          name: record["name"],
          fileName: record["fileName"],
          publicUrl: record["publicUrl"],
        },
      ]
    : undefined;
}

function uploadContract(value: unknown): AssetUploadContract | undefined {
  const upload = assetRecord(assetRecord(value)?.["upload"]);
  const contentTypes = upload?.["contentTypes"];
  const maxBytes = upload?.["maxBytes"];
  return Array.isArray(contentTypes) &&
    contentTypes.every((entry) => typeof entry === "string") &&
    typeof maxBytes === "number"
    ? { contentTypes, maxBytes }
    : undefined;
}

export const httpAssetsClient: AssetsClient = {
  list: async (): Promise<AssetListOutcome> => {
    const answer = await assetCall(ASSETS_ENDPOINT);

    if (answer?.status !== 200) {
      return { ok: false, reason: assetFailure(answer) };
    }

    return {
      ok: true,
      assets: assetEntries(answer.body),
      upload: uploadContract(answer.body),
    };
  },
  upload: async (input): Promise<AssetUploadOutcome> => {
    const answer = await assetCall(ASSETS_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
    const asset =
      answer?.status === 200
        ? assetOf(assetRecord(answer.body)?.["asset"])
        : undefined;

    return asset === undefined
      ? { ok: false, reason: assetFailure(answer) }
      : { ok: true, asset: asset[0] };
  },
  usage: async (name): Promise<AssetUsageOutcome> => {
    const answer = await assetCall(
      `${ASSETS_ENDPOINT}/${encodeURIComponent(name)}/usage`,
    );
    const usedBy =
      answer?.status === 200 ? assetRecord(answer.body)?.["usedBy"] : undefined;

    return Array.isArray(usedBy)
      ? { ok: true, usedBy: usedBy.length }
      : { ok: false, reason: assetFailure(answer) };
  },
  remove: async (name): Promise<AssetRemoveOutcome> => {
    const answer = await assetCall(
      `${ASSETS_ENDPOINT}/${encodeURIComponent(name)}`,
      { method: "DELETE" },
    );

    return answer?.status === 200
      ? { ok: true }
      : { ok: false, reason: assetFailure(answer) };
  },
};

/**
 * What counts as an image on this screen, and what the file dialog offers
 * (REQ-224, REQ-231).
 *
 * `png` and `jpeg`, and no `webp`: the platform's media specification names
 * those two and nothing else ("Send messages", v26.0, consulted 2026-08-16).
 * The catalogue answered by the API is still the authority — this list only
 * decides which of the CHOSEN control accepts a file before spending an upload
 * on it — but a wider list here would let an operator pick a file that the
 * catalogue then refuses, which reads as the product being broken rather than
 * as the format being unsupported.
 */
const IMAGE_CONTENT_TYPES: readonly string[] = ["image/jpeg", "image/png"];

/** File names this screen shows in the image picker rather than the file one. */
const IMAGE_NAME_PATTERN = /\.(?:jpe?g|png)$/i;

/** The resource control used by automation values of type `asset`. */
export interface AssetPickerProps {
  readonly id: string;
  readonly label: string;
  readonly hint?: string;
  readonly value: string | undefined;
  readonly optional: boolean;
  readonly disabled?: boolean;
  /**
   * Narrows both existing choices and uploads at the concrete use site.
   *
   * Three and not two since REQ-289. A cover is an image and nothing else, and
   * the file a message used to carry was a document and nothing else, so both
   * of those narrow. A card BUTTON opens whichever of the two the operator has,
   * which is what its own label says out loud ("PDF or image"), so it narrows
   * to nothing: a control offering only documents under that label would be
   * refusing exactly half of what it promises.
   */
  readonly accept?: "file" | "image" | "any";
  readonly t: Translate;
  readonly client?: AssetsClient;
  onChange(value: string | undefined): void;
  onBusy?(busy: boolean): void;
  /**
   * What the control's own remove button does, when taking the file away means
   * more to the screen than forgetting the reference: the cover of a card is
   * offered by a control the form draws, so removing it removes that too.
   * Absent, removing clears the choice and leaves the control where it is.
   */
  onRemove?(): void;
}

function assetFailureMessage(
  reason: AssetFailureReason,
  t: Translate,
  /** What the catalogue says it takes, so a refusal can NAME it (REQ-231). */
  formats: readonly string[],
): string {
  switch (reason) {
    case "unauthorized":
      return t("screens.assets.sessionExpired");
    case "invalid_data":
      return t("screens.assets.invalidData");
    case "invalid_name":
      return t("screens.assets.invalidName");
    case "unsupported_content_type":
      // The accepted formats travel WITH the refusal. Told only that the format
      // is wrong, an operator's next move is to try another file and find out;
      // told which ones work, their next move is to convert the one they have.
      return t("screens.assets.unsupportedType", {
        formats: formats.join(", "),
      });
    case "too_large":
      return t("screens.assets.tooLarge");
    case "already_exists":
      return t("screens.assets.alreadyExists");
    case "not_found":
      return t("screens.assets.notFound");
    case "unreachable":
      return t("screens.assets.unreachable");
    case "failed":
      return t("screens.assets.failed");
  }
}

function bytesAsBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;

  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(
      ...bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length)),
    );
  }

  return btoa(binary);
}

/**
 * What the browser says the file is, or what its name says when the browser
 * says nothing.
 *
 * The fallback names only formats the platform actually carries (REQ-231).
 * Anything else becomes `application/octet-stream` and is refused here, which
 * is the point: a format guessed into existence at this line would be accepted
 * at upload and refused at delivery, to a contact already waiting.
 */
function contentTypeFor(file: File): string {
  if (file.type !== "") {
    return file.type;
  }

  const extension = file.name.toLowerCase().split(".").pop();

  return extension === "pdf"
    ? "application/pdf"
    : extension === "png"
      ? "image/png"
      : extension === "jpg" || extension === "jpeg"
        ? "image/jpeg"
        : "application/octet-stream";
}

/**
 * Where a resource is read from when the catalogue could not be.
 *
 * The public address of a resource is the route's prefix and its key, and the
 * screen can build it without asking: a catalogue request that failed says
 * nothing about a cover chosen a minute ago, and drawing it beats telling the
 * operator their picture is broken because a list did not load.
 */
const ASSET_ADDRESS_PREFIX = "/assets";

/** The catalogue as the grid takes it: the key selects, the file name reads. */
function assetTiles(assets: readonly AssetEntry[]): readonly AssetTile[] {
  return assets.map((asset) => ({
    name: asset.name,
    fileName: asset.fileName,
    url: asset.publicUrl,
    kind: IMAGE_NAME_PATTERN.test(asset.name) ? "image" : "file",
  }));
}

/**
 * Lists resources and uploads a new one without writing the reference early.
 *
 * The selected name is changed only after the API answers success. That small
 * ordering rule is the contract's important part: a failed or still-running
 * upload can never make a definition point at bytes that do not exist.
 *
 * What the operator sees was a dropdown of names until REQ-290 and REQ-291, and
 * both halves of that are corrected here: the chosen file is shown as itself,
 * and the catalogue opens as a grid of pictures. The file dialog is reached
 * from inside that grid, so uploading a new file and re-using an old one are
 * one gesture with two answers rather than two controls that look alike.
 */
export function AssetPicker({
  id,
  label,
  hint,
  value,
  optional,
  disabled = false,
  accept = "file",
  t,
  client = httpAssetsClient,
  onChange,
  onBusy,
  onRemove,
}: AssetPickerProps): ReactElement {
  const [assets, setAssets] = useState<readonly AssetEntry[]>([]);
  const [contract, setContract] = useState<AssetUploadContract>();
  const [loading, setLoading] = useState(true);
  const [catalogueFailure, setCatalogueFailure] = useState<
    AssetFailureReason | undefined
  >(undefined);
  const [uploadFailure, setUploadFailure] = useState<
    AssetFailureReason | undefined
  >(undefined);
  const [removalFailure, setRemovalFailure] = useState<
    AssetFailureReason | undefined
  >(undefined);
  const [uploading, setUploading] = useState(false);
  const [browsing, setBrowsing] = useState(false);
  // Which tile is asking to be confirmed, and what the catalogue has answered
  // about it so far (REQ-293). It lives here rather than in the grid because
  // the count in it is the catalogue's answer, and the grid has no transport.
  const [removal, setRemoval] = useState<AssetRemoval | undefined>(undefined);
  // The file dialog is opened from inside the catalogue, and the input itself
  // stays OUT of it: the dialog closes the moment a file is chosen, and an
  // input that unmounts with it would take the upload in flight along.
  const chooser = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setCatalogueFailure(undefined);

    void client
      .list()
      .then((outcome) => {
        if (!alive) {
          return;
        }

        if (outcome.ok) {
          setAssets(outcome.assets);
          setContract(outcome.upload);
        } else {
          setCatalogueFailure(outcome.reason);
        }
        setLoading(false);
      })
      .catch(() => {
        if (alive) {
          setCatalogueFailure("unreachable");
          setLoading(false);
        }
      });

    return (): void => {
      alive = false;
    };
  }, [client]);

  /**
   * Shuts the catalogue, and with it whatever a tile was asking.
   *
   * Both together, always: a confirmation left standing would come back with
   * the dialog the next time it opens, asking about a deletion nobody is in
   * the middle of any more.
   */
  const closeCatalogue = (): void => {
    setBrowsing(false);
    setRemoval(undefined);
    setRemovalFailure(undefined);
  };

  const upload = async (
    event: ChangeEvent<HTMLInputElement>,
  ): Promise<void> => {
    const file = event.target.files?.[0];
    // Reset so selecting the same file after a refusal still emits `change`.
    event.target.value = "";

    if (file === undefined) {
      return;
    }

    // The catalogue closes as soon as a file is chosen: what happens next, a
    // refusal or a picture, belongs to the control in the form, and a dialog
    // left open over it would hide both.
    closeCatalogue();

    const contentType = contentTypeFor(file);
    const allowed = contract?.contentTypes ?? [];
    const acceptedForUse =
      accept === "any"
        ? true
        : accept === "image"
          ? IMAGE_CONTENT_TYPES.includes(contentType)
          : !contentType.startsWith("image/");
    if (
      !acceptedForUse ||
      (allowed.length > 0 && !allowed.includes(contentType)) ||
      (contract !== undefined && file.size > contract.maxBytes)
    ) {
      setUploadFailure(
        contract !== undefined && file.size > contract.maxBytes
          ? "too_large"
          : "unsupported_content_type",
      );
      return;
    }

    setUploadFailure(undefined);
    setUploading(true);
    onBusy?.(true);

    try {
      const data = bytesAsBase64(new Uint8Array(await file.arrayBuffer()));
      const outcome = await client.upload({
        name: file.name,
        contentType,
        data,
      });

      if (outcome.ok) {
        setAssets((current) => [
          outcome.asset,
          ...current.filter((asset) => asset.name !== outcome.asset.name),
        ]);
        onChange(outcome.asset.name);
      } else {
        setUploadFailure(outcome.reason);
      }
    } catch {
      setUploadFailure("unreachable");
    } finally {
      setUploading(false);
      onBusy?.(false);
    }
  };

  /**
   * The operator asked to delete a file, so the catalogue is asked what that
   * costs (REQ-293).
   *
   * The tile enters confirmation at once and carries no number yet: the
   * question is on screen while the answer travels, and the commit stays shut
   * until it lands, because a warning without its count is not the informed
   * act the requirement asks for.
   */
  const askRemoval = (name: string): void => {
    setRemovalFailure(undefined);
    setRemoval({ name });

    void client
      .usage(name)
      .then((outcome) => {
        if (outcome.ok) {
          setRemoval((current) =>
            current?.name === name
              ? { name, usageCount: outcome.usedBy }
              : current,
          );
          return;
        }

        // Nothing was deleted and nothing can be: a question that cannot say
        // what it costs is withdrawn rather than asked without the number.
        setRemoval((current) => (current?.name === name ? undefined : current));
        setRemovalFailure(outcome.reason);
      })
      .catch(() => {
        setRemoval((current) => (current?.name === name ? undefined : current));
        setRemovalFailure("unreachable");
      });
  };

  const removeAsset = (name: string): void => {
    setRemoval((current) =>
      current?.name === name ? { ...current, pending: true } : current,
    );
    onBusy?.(true);

    void client
      .remove(name)
      .then((outcome) => {
        if (outcome.ok) {
          setAssets((current) =>
            current.filter((asset) => asset.name !== name),
          );

          // A definition may not point at bytes that are gone. Cleared here,
          // where it is known, rather than found out at delivery by a contact
          // already waiting.
          if (value === name) {
            if (onRemove === undefined) {
              onChange(undefined);
            } else {
              onRemove();
            }
          }
        } else {
          setRemovalFailure(outcome.reason);
        }

        setRemoval((current) => (current?.name === name ? undefined : current));
      })
      .catch(() => {
        setRemovalFailure("unreachable");
        setRemoval((current) => (current?.name === name ? undefined : current));
      })
      .finally(() => onBusy?.(false));
  };

  const selectedDisabled = disabled || loading || uploading;
  const failure = uploadFailure ?? catalogueFailure;
  // What THIS control takes, not everything the catalogue takes: naming the
  // document formats in the cover's refusal would send an operator to convert
  // their image into a PDF.
  const acceptedFormats = (contract?.contentTypes ?? []).filter((type) =>
    accept === "any"
      ? true
      : accept === "image"
        ? IMAGE_CONTENT_TYPES.includes(type)
        : !type.startsWith("image/"),
  );
  // The chosen resource as the catalogue knows it. Unknown to the catalogue is
  // an ordinary state and not a fault: the list may still be arriving, or may
  // have failed, and the reference is good either way.
  const chosen =
    value === undefined
      ? undefined
      : assets.find((asset) => asset.name === value);
  const chosenName = chosen?.fileName ?? value;
  // Which FACE the control wears. A control that takes either reads it off what
  // was actually chosen, so a picture picked through a button is still drawn as
  // a picture: the face follows the file, and only a narrowed control can know
  // it in advance.
  const kind: "image" | "file" =
    accept === "any"
      ? chosenName !== undefined && IMAGE_NAME_PATTERN.test(chosenName)
        ? "image"
        : "file"
      : accept === "image"
        ? "image"
        : "file";
  const control = (
    <FileUpload
      id={id}
      kind={kind}
      kindLabel={t("screens.assets.documentKind")}
      fileName={chosenName}
      previewUrl={
        value === undefined
          ? undefined
          : (chosen?.publicUrl ??
            `${ASSET_ADDRESS_PREFIX}/${encodeURIComponent(value)}`)
      }
      note={chosenName === undefined ? undefined : t("screens.assets.stored")}
      emptyHint={
        kind === "image"
          ? t("screens.assets.noImageYet")
          : t("screens.assets.noFileYet")
      }
      chooseLabel={t("screens.assets.choose")}
      replaceLabel={t("screens.assets.replace")}
      removeLabel={t("screens.assets.remove")}
      thumbnailAlt={t("screens.assets.thumbnailAlt", {
        name: chosenName ?? "",
      })}
      brokenLabel={t("screens.assets.thumbnailBroken")}
      disabled={selectedDisabled}
      onChoose={(): void => setBrowsing(true)}
      onRemove={(): void => {
        setUploadFailure(undefined);
        if (onRemove === undefined) {
          onChange(undefined);
        } else {
          onRemove();
        }
      }}
    />
  );
  const error =
    failure === undefined
      ? undefined
      : assetFailureMessage(failure, t, acceptedFormats);

  return (
    <div className="mc-stack">
      {optional ? (
        <Field
          id={id}
          label={label}
          hint={hint}
          error={error}
          optional
          optionalLabel={t("screens.automations.optionalLabel")}
        >
          {control}
        </Field>
      ) : (
        <Field id={id} label={label} hint={hint} error={error}>
          {control}
        </Field>
      )}

      {/* Named and reachable, drawn nowhere: what the operator presses is the
          catalogue's own action, and the browser opens its file dialogue from
          this input either way. */}
      <input
        ref={chooser}
        id={`${id}-upload`}
        className="mc-offscreen"
        type="file"
        aria-label={t("screens.assets.uploadLabel")}
        accept={
          accept === "any"
            ? ".pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png"
            : accept === "image"
              ? ".jpg,.jpeg,.png,image/jpeg,image/png"
              : ".pdf,application/pdf"
        }
        disabled={selectedDisabled}
        aria-busy={uploading}
        onChange={(event): void => {
          void upload(event);
        }}
      />

      {browsing ? (
        <Modal
          title={t("screens.assets.catalogueTitle")}
          lead={t("screens.assets.uploadHint")}
          // Drawn on the desktop layout, and read on every one (REQ-335). Two
          // sentences of reassurance sat above the tiles on a 320px screen and
          // pushed the catalogue itself under the fold, which is the one thing
          // this dialog exists to show. They stay in the document, so the
          // operator who hears the dialog instead of seeing it still learns
          // that deleting an automation does not delete its file.
          leadWideOnly
          onClose={closeCatalogue}
          // The way out is DOWN HERE, beside the action, and there is no X in
          // the head (REQ-304). The X was chosen so the dialog would not have
          // two exits; it kept the count right and made the one exit almost
          // invisible, and a way out nobody finds is the same as none.
          footer={
            <>
              <Button variant="secondary" onClick={closeCatalogue}>
                {t("screens.assets.catalogueClose")}
              </Button>
              <Button
                variant="primary"
                icon="plus"
                disabled={selectedDisabled}
                onClick={(): void => chooser.current?.click()}
              >
                {t("screens.assets.uploadLabel")}
              </Button>
            </>
          }
        >
          {/* Read inside the dialog, because the dialog is where the deletion
              was asked for: a refusal answered behind the catalogue is a
              refusal nobody is looking at. */}
          {removalFailure === undefined ? null : (
            <Notice nature="error">
              {assetFailureMessage(removalFailure, t, acceptedFormats)}
            </Notice>
          )}

          <AssetGrid
            items={assetTiles(
              assets.filter((asset) =>
                accept === "any"
                  ? true
                  : accept === "image"
                    ? IMAGE_NAME_PATTERN.test(asset.name)
                    : !IMAGE_NAME_PATTERN.test(asset.name),
              ),
            )}
            selectedName={value}
            onSelect={(name): void => {
              onChange(name);
              closeCatalogue();
            }}
            removal={removal}
            onRemoveRequest={askRemoval}
            onRemoveConfirm={removeAsset}
            onRemoveCancel={(): void => setRemoval(undefined)}
            removeLabel={(fileName): string =>
              t("screens.assets.deleteLabel", { name: fileName })
            }
            removeQuestion={(fileName): string =>
              t("screens.assets.deleteQuestion", { name: fileName })
            }
            usageLabel={(count): string =>
              count === 0
                ? t("screens.assets.deleteUnused")
                : t("screens.assets.deleteUsage", { count })
            }
            usagePendingLabel={t("screens.assets.deleteCounting")}
            removeWarning={t("screens.assets.deleteWarning")}
            removeConfirmLabel={t("screens.assets.deleteConfirm")}
            removeWorkingLabel={t("screens.assets.deleteWorking")}
            removeCancelLabel={t("screens.assets.deleteCancel")}
            selectLabel={(fileName): string =>
              t("screens.assets.use", { name: fileName })
            }
            thumbnailAlt={(fileName): string =>
              t("screens.assets.thumbnailAlt", { name: fileName })
            }
            brokenLabel={t("screens.assets.thumbnailBroken")}
            kindLabel={t("screens.assets.documentKind")}
            emptyLabel={
              loading
                ? t("screens.assets.loading")
                : t("screens.assets.catalogueEmpty")
            }
          />
        </Modal>
      ) : null}

      {uploading ? (
        <Notice nature="info">{t("screens.assets.uploading")}</Notice>
      ) : null}
    </div>
  );
}
