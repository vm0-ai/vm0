import { Buffer } from "node:buffer";

import { command } from "ccstate";
import { zeroUploadsContract } from "@vm0/api-contracts/contracts/zero-uploads";

import { hostResolvesToBlockedAddress } from "../../lib/blocked-fetch-host";
import { env } from "../../lib/env";
import { badRequestMessage } from "../../lib/error";
import {
  buildArtifactKey,
  buildFileUrl,
  sanitizeArtifactFilename,
} from "../../lib/file-url";
import { inferMimetype } from "../../lib/mimetype";
import { authContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf } from "../context/request";
import { putS3Object } from "../external/s3";
import { recordWebUploadedFile$ } from "../services/run-uploaded-files.service";
import { rejectSuspendedOrg$ } from "../services/zero-org-suspension.service";
import type { RouteEntry } from "../route-entry";
import { settle } from "../utils";

const MAX_IMAGE_IMPORT_SIZE_BYTES = 25 * 1024 * 1024;
const MAX_IMAGE_IMPORT_SIZE_LABEL = "25 MB";

const ALLOWED_IMPORT_IMAGE_TYPES: Readonly<Set<string>> = new Set([
  "image/avif",
  "image/bmp",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
]);

type ImportImageError =
  | ReturnType<typeof badRequestMessage>
  | ReturnType<typeof badGateway>;

function badGateway(message: string, code: string) {
  return {
    status: 502 as const,
    body: { error: { message, code } },
  };
}

async function importHostError(
  hostname: string,
): Promise<ImportImageError | null> {
  const resolved = await settle(hostResolvesToBlockedAddress(hostname));
  if (!resolved.ok) {
    return badGateway(
      "Couldn't resolve image URL host",
      "IMAGE_IMPORT_FETCH_FAILED",
    );
  }
  return resolved.value
    ? badRequestMessage("Image URL host is not allowed")
    : null;
}

async function parsedImportUrl(value: string): Promise<URL | ImportImageError> {
  const parsed = new URL(value);
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return badRequestMessage("Image URL must use http or https");
  }
  const hostError = await importHostError(parsed.hostname);
  if (hostError) {
    return hostError;
  }
  return parsed;
}

function importImageContentType(response: Response, url: URL): string | null {
  const header =
    response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() ??
    "";
  const declared = header === "image/jpg" ? "image/jpeg" : header;
  if (ALLOWED_IMPORT_IMAGE_TYPES.has(declared)) {
    return declared;
  }
  // No or opaque content-type — fall back to the URL's filename extension.
  if (declared && declared !== "application/octet-stream") {
    return null;
  }
  const inferred = inferMimetype(url.pathname.split("/").pop() ?? "");
  return ALLOWED_IMPORT_IMAGE_TYPES.has(inferred) ? inferred : null;
}

function importImageFilename(url: URL, contentType: string): string {
  const lastPathSegment = url.pathname.split("/").pop() ?? "";
  const filename = sanitizeArtifactFilename(lastPathSegment) || "image";
  return /\.[a-z0-9]{1,8}$/i.test(filename)
    ? filename
    : `${filename}.${contentType.slice("image/".length)}`;
}

async function fetchImportImage(
  url: URL,
  signal: AbortSignal,
): Promise<
  { readonly response: Response; readonly url: URL } | ImportImageError
> {
  const settled = await settle(
    fetch(url, {
      headers: { accept: "image/*" },
      redirect: "manual",
      signal,
    }),
    signal,
  );
  if (!settled.ok) {
    return badGateway("Couldn't fetch image URL", "IMAGE_IMPORT_FETCH_FAILED");
  }
  signal.throwIfAborted();
  return { response: settled.value, url };
}

async function readImportImageBytes(
  response: Response,
  signal: AbortSignal,
): Promise<Uint8Array | ImportImageError> {
  if (!response.body) {
    return badGateway("Empty image response", "IMAGE_IMPORT_FETCH_FAILED");
  }

  // Cap the download incrementally so a huge or lying content-length can't
  // buffer unbounded memory; `return` cancels the stream automatically.
  const chunks: Uint8Array[] = [];
  let totalLength = 0;
  for await (const chunk of response.body) {
    signal.throwIfAborted();
    totalLength += chunk.byteLength;
    if (totalLength > MAX_IMAGE_IMPORT_SIZE_BYTES) {
      return badRequestMessage(
        `Image too large (max ${MAX_IMAGE_IMPORT_SIZE_LABEL})`,
      );
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

const importImageInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(authContext$);
  const bodyResult = await get(bodyResultOf(zeroUploadsContract.importImage));
  signal.throwIfAborted();
  if (!bodyResult.ok) {
    return bodyResult.response;
  }

  if (auth.orgId) {
    const suspended = await set(rejectSuspendedOrg$, auth.orgId, signal);
    if (suspended) {
      return suspended;
    }
  }

  const sourceUrl = await parsedImportUrl(bodyResult.data.url);
  signal.throwIfAborted();
  if ("status" in sourceUrl) {
    return sourceUrl;
  }

  const fetched = await fetchImportImage(sourceUrl, signal);
  if ("status" in fetched) {
    return fetched;
  }
  if (!fetched.response.ok) {
    return badGateway("Couldn't fetch image URL", "IMAGE_IMPORT_FETCH_FAILED");
  }

  const contentType = importImageContentType(fetched.response, fetched.url);
  if (!contentType) {
    return badRequestMessage(
      "Image URL must point to a PNG, JPEG, GIF, WebP, AVIF, or BMP image",
    );
  }

  const bytes = await readImportImageBytes(fetched.response, signal);
  if ("status" in bytes) {
    return bytes;
  }

  const id = crypto.randomUUID();
  const filename = importImageFilename(fetched.url, contentType);
  const s3Key = buildArtifactKey(auth.userId, id, filename);
  const bucket = env("R2_USER_ARTIFACTS_BUCKET_NAME");
  const url = buildFileUrl(auth.userId, id, filename);

  await get(putS3Object(bucket, s3Key, Buffer.from(bytes), contentType));
  signal.throwIfAborted();

  await set(
    recordWebUploadedFile$,
    {
      runId: "runId" in auth ? auth.runId : undefined,
      externalId: id,
      userId: auth.userId,
      orgId: "orgId" in auth ? auth.orgId : null,
      filename,
      contentType,
      sizeBytes: bytes.byteLength,
      url,
      s3Key,
      metadata: { sourceUrl: bodyResult.data.url },
    },
    signal,
  );
  signal.throwIfAborted();

  return {
    status: 200 as const,
    body: {
      id,
      filename,
      contentType,
      size: bytes.byteLength,
      url,
    },
  };
});

export const zeroUploadsImportImageRoutes: readonly RouteEntry[] = [
  {
    route: zeroUploadsContract.importImage,
    handler: authRoute({ requiredCapability: "file:write" }, importImageInner$),
  },
];
