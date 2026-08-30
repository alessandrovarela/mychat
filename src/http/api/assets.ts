import type { FastifyInstance } from "fastify";
import {
  ASSET_CONTENT_TYPES,
  AssetWriteError,
  MAX_ASSET_BYTES,
  assetFileName,
  storeNewAsset,
} from "../../storage/assets.js";
import type { AssetCatalogue, AssetBody } from "../../storage/assets.js";
import type { AssetUsageReader } from "../../storage/asset-usage.js";
import {
  apiRoute,
  arrayOf,
  BOOLEAN,
  inputObject,
  outputObject,
  refusalObject,
  STATUS,
  STRING,
} from "./contract.js";

/** The private catalogue the operator's resource selector reads and writes. */
export const ASSETS_API_ROUTE = "/api/assets";

/** One resource of the catalogue, by its immutable key. */
export const ASSET_API_ROUTE = `${ASSETS_API_ROUTE}/:name`;

/** Where that one resource is used, asked BEFORE deleting it (REQ-293). */
export const ASSET_USAGE_API_ROUTE = `${ASSET_API_ROUTE}/usage`;

/** The refusal when the address names a resource the catalogue does not have. */
export const ASSET_NOT_FOUND = "not_found";

/**
 * Base64 has a predictable expansion: four bytes on the wire for every three
 * bytes in the stored object. The route accepts a little headroom for the JSON
 * envelope and rejects the decoded object in the storage binding at 25 MB.
 * Keeping this limit on this route (rather than the whole process) means the
 * webhook and ordinary API requests retain their smaller defaults.
 */
export const ASSETS_API_BODY_LIMIT = MAX_ASSET_BYTES * 2 + 64 * 1024;

/**
 * A resource on the wire: its key, the name it was sent under, and its address.
 *
 * `name` is the IDENTITY and the only thing a definition ever holds (REQ-292);
 * `fileName` is what the operator called the file, which two resources are
 * allowed to share. The screen shows the second and selects by the first.
 */
const ASSET = outputObject(
  {
    name: STRING,
    fileName: STRING,
    publicUrl: STRING,
  },
  ["name", "fileName", "publicUrl"],
);

/** One automation that refers to a resource, for the deletion dialogue. */
const ASSET_USAGE = outputObject(
  {
    automationId: STRING,
    enabled: BOOLEAN,
    publicationId: STRING,
  },
  ["automationId", "enabled"],
);

const NAME_PARAMS = inputObject({ name: { type: "string", minLength: 1 } }, [
  "name",
]);

const NO_QUERY = inputObject({});

const UPLOAD_CONTRACT = outputObject(
  {
    contentTypes: arrayOf(STRING),
    maxBytes: { type: "number" },
  },
  ["contentTypes", "maxBytes"],
);

const ASSET_LIST = outputObject(
  { assets: arrayOf(ASSET), upload: UPLOAD_CONTRACT },
  ["assets", "upload"],
);

const UPLOAD_BODY = inputObject(
  {
    name: { type: "string", minLength: 1 },
    contentType: { type: "string", minLength: 1 },
    // The bytes are carried as standard base64 so the API has no implicit
    // multipart dependency and the same request works from the browser and
    // from a small command-line client.
    data: { type: "string", minLength: 1 },
  },
  ["name", "contentType", "data"],
);

const UPLOAD_ANSWER = outputObject({ asset: ASSET }, ["asset"]);

const ASSET_USAGE_ANSWER = outputObject(
  { asset: ASSET, usedBy: arrayOf(ASSET_USAGE) },
  ["asset", "usedBy"],
);

const DELETE_ANSWER = outputObject(
  { deleted: ASSET, usedBy: arrayOf(ASSET_USAGE) },
  ["deleted", "usedBy"],
);

/** Decode standard base64 without Buffer's permissive character dropping. */
function decodeBase64(value: string): Uint8Array | undefined {
  // RFC 4648's alphabet, with padding only in the final quartet. Empty files
  // are not resources in the UI contract, and the input schema already rejects
  // an empty string before this function runs.
  if (value.length % 4 !== 0) {
    return undefined;
  }

  // A single giant regular expression over a 33 MB value can recurse through
  // the regexp engine's backtracking stack. Scan characters in a flat loop so
  // the documented 25 MB input remains a normal, bounded request.
  let padding = 0;
  const firstPadding = value.indexOf("=");
  if (firstPadding !== -1) {
    padding = value.length - firstPadding;
    if (padding > 2 || firstPadding < value.length - 2) {
      return undefined;
    }
    for (let index = firstPadding; index < value.length; index += 1) {
      if (value[index] !== "=") {
        return undefined;
      }
    }
  }

  const dataEnd = value.length - padding;
  for (let index = 0; index < dataEnd; index += 1) {
    const code = value.charCodeAt(index);
    const alphabet =
      (code >= 65 && code <= 90) ||
      (code >= 97 && code <= 122) ||
      (code >= 48 && code <= 57) ||
      code === 43 ||
      code === 47;
    if (!alphabet) {
      return undefined;
    }
  }

  const bytes = Buffer.from(value, "base64");
  // Canonical re-encoding catches non-zero unused padding bits, which Node's
  // decoder otherwise accepts. A caller can therefore never smuggle a second
  // textual representation of one key through this envelope.
  return bytes.toString("base64") === value
    ? Uint8Array.from(bytes)
    : undefined;
}

interface PresentedAsset {
  readonly name: string;
  readonly fileName: string;
  readonly publicUrl: string;
}

async function presentAsset(
  assets: AssetCatalogue,
  name: string,
): Promise<PresentedAsset> {
  return {
    name,
    fileName: assetFileName(name),
    publicUrl: await assets.publicUrl(name),
  };
}

function refusalStatus(error: AssetWriteError): number {
  return error.code === "already_exists" ? STATUS.conflict : STATUS.refused;
}

/**
 * Registers the authenticated resource catalogue. The caller places this
 * module inside `registerAccess`' guarded scope; the public `/assets` file
 * route is deliberately registered by the composition root before that scope.
 */
export function registerAssetRoutes(
  scope: FastifyInstance,
  assets: AssetCatalogue,
  usage: AssetUsageReader,
): void {
  apiRoute(scope, {
    method: "GET",
    url: ASSETS_API_ROUTE,
    contract: {
      querystring: inputObject({}),
      response: { 200: ASSET_LIST },
    },
    handler: async () => {
      const names = await assets.list();
      const listed = await Promise.all(
        names.map((name) => presentAsset(assets, name)),
      );
      return {
        status: STATUS.ok,
        payload: {
          assets: listed,
          upload: {
            contentTypes: [...ASSET_CONTENT_TYPES],
            maxBytes: MAX_ASSET_BYTES,
          },
        },
      };
    },
  });

  apiRoute<
    unknown,
    unknown,
    {
      name: string;
      contentType: string;
      data: string;
    }
  >(scope, {
    method: "POST",
    url: ASSETS_API_ROUTE,
    bodyLimit: ASSETS_API_BODY_LIMIT,
    contract: {
      body: UPLOAD_BODY,
      response: {
        200: UPLOAD_ANSWER,
        409: refusalObject(),
        422: refusalObject(),
      },
    },
    handler: async ({ body }) => {
      const bytes = decodeBase64(body.data);
      if (bytes === undefined) {
        return {
          status: STATUS.refused,
          payload: { error: "invalid_data" },
        };
      }

      const input: AssetBody = {
        bytes,
        contentType: body.contentType,
      };

      let stored;
      try {
        // A NEW resource, always (REQ-292). The name travelling in the request
        // is what the operator called their file, and sending the same one
        // twice is two files, not a replacement and not a refusal: an
        // automation already delivered goes on delivering the bytes it was
        // built with.
        stored = await storeNewAsset(assets, body.name, input);
      } catch (error) {
        if (error instanceof AssetWriteError) {
          return {
            status: refusalStatus(error),
            payload: { error: error.code },
          };
        }
        throw error;
      }

      return {
        status: STATUS.ok,
        payload: {
          asset: await presentAsset(assets, stored.name),
        },
      };
    },
  });

  apiRoute<{ name: string }>(scope, {
    method: "GET",
    url: ASSET_USAGE_API_ROUTE,
    contract: {
      params: NAME_PARAMS,
      querystring: NO_QUERY,
      response: {
        200: ASSET_USAGE_ANSWER,
        404: refusalObject(),
      },
    },
    // Asked BEFORE the deletion and not answered by it: the dialogue that warns
    // the operator has to show what will break while the file is still there.
    handler: async ({ params }) => {
      if (!(await assets.exists(params.name))) {
        return {
          status: STATUS.notFound,
          payload: { error: ASSET_NOT_FOUND },
        };
      }

      return {
        status: STATUS.ok,
        payload: {
          asset: await presentAsset(assets, params.name),
          usedBy: await usage.read(params.name),
        },
      };
    },
  });

  apiRoute<{ name: string }>(scope, {
    method: "DELETE",
    url: ASSET_API_ROUTE,
    contract: {
      params: NAME_PARAMS,
      response: {
        200: DELETE_ANSWER,
        404: refusalObject(),
      },
    },
    handler: async ({ params }) => {
      if (!(await assets.exists(params.name))) {
        return {
          status: STATUS.notFound,
          payload: { error: ASSET_NOT_FOUND },
        };
      }

      // Both reads happen while the object still exists: afterwards there is no
      // address to present, and the answer would name a file it could not
      // describe.
      const deleted = await presentAsset(assets, params.name);
      const usedBy = await usage.read(params.name);

      // Not refused when it is in use, on purpose (REQ-293). Deleting is an
      // explicit act that WARNS; a resource that could not be deleted while any
      // automation mentions it would be a resource the operator cannot ever
      // remove, and the warning is what makes the choice theirs.
      await assets.remove(params.name);

      return { status: STATUS.ok, payload: { deleted, usedBy } };
    },
  });
}
