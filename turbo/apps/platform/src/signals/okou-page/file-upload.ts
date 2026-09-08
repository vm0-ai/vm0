import { uploadsContract } from "@okouai/api-contracts/contracts/uploads";
import { command } from "ccstate";
import { delay } from "signal-timers";

import { IN_VITEST } from "../../env.ts";
import { accept } from "../../lib/accept.ts";
import { fetchResource } from "../../lib/resource-fetch.ts";
import { apiClient$ } from "../api-client.ts";
import { onRejection, setLoop, settle, tapError } from "../utils.ts";

export interface UploadedFileInfo {
  readonly id: string;
  readonly url: string;
  readonly contentType: string;
}

function uploadedFileInfo(
  file: Pick<UploadedFileInfo, "id" | "url">,
  contentType: string,
): UploadedFileInfo {
  return { id: file.id, url: file.url, contentType };
}

const MULTIPART_UPLOAD_THRESHOLD_BYTES = 5 * 1024 * 1024;
const MAX_PART_UPLOAD_ATTEMPTS = 5;
const PART_UPLOAD_RETRY_BASE_DELAY_MS = 250;
const MULTIPART_ABORT_TIMEOUT_MS = 5000;

interface MultipartUploadReference {
  readonly id: string;
  readonly filename: string;
  readonly uploadId: string;
}

const abortMultipartUpload$ = command(
  async (
    { get },
    upload: MultipartUploadReference,
    signal: AbortSignal,
  ): Promise<void> => {
    const client = get(apiClient$)(uploadsContract);
    await tapError(
      accept(
        client.abortMultipart({
          body: upload,
          fetchOptions: {
            keepalive: true,
            signal,
          },
        }),
        [200],
        signal,
        { showErrorToast: false },
      ),
    );
  },
);

function uploadContentTypeByExtension(ext: string): string | undefined {
  const contentTypeByExtension: Record<string, string | undefined> = {
    aac: "audio/aac",
    "7z": "application/x-7z-compressed",
    ai: "application/postscript",
    avif: "image/avif",
    bmp: "image/bmp",
    bz2: "application/x-bzip2",
    csv: "text/csv",
    db: "application/vnd.sqlite3",
    doc: "application/msword",
    docm: "application/vnd.ms-word.document.macroenabled.12",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    dotm: "application/vnd.ms-word.template.macroenabled.12",
    dotx: "application/vnd.openxmlformats-officedocument.wordprocessingml.template",
    epub: "application/epub+zip",
    flac: "audio/flac",
    gif: "image/gif",
    gz: "application/gzip",
    har: "application/json",
    heic: "image/heic",
    heif: "image/heif",
    htm: "text/html",
    html: "text/html",
    jpeg: "image/jpeg",
    jpg: "image/jpeg",
    json: "application/json",
    key: "application/vnd.apple.keynote",
    m4a: "audio/mp4",
    md: "text/markdown",
    mov: "video/quicktime",
    mp3: "audio/mpeg",
    mp4: "video/mp4",
    mpga: "audio/mpga",
    odp: "application/vnd.oasis.opendocument.presentation",
    ods: "application/vnd.oasis.opendocument.spreadsheet",
    odt: "application/vnd.oasis.opendocument.text",
    oga: "audio/ogg",
    ogg: "audio/ogg",
    opus: "audio/opus",
    numbers: "application/vnd.apple.numbers",
    pages: "application/vnd.apple.pages",
    parquet: "application/vnd.apache.parquet",
    pdf: "application/pdf",
    png: "image/png",
    potm: "application/vnd.ms-powerpoint.template.macroenabled.12",
    potx: "application/vnd.openxmlformats-officedocument.presentationml.template",
    ppsm: "application/vnd.ms-powerpoint.slideshow.macroenabled.12",
    ppsx: "application/vnd.openxmlformats-officedocument.presentationml.slideshow",
    ppt: "application/vnd.ms-powerpoint",
    pptm: "application/vnd.ms-powerpoint.presentation.macroenabled.12",
    pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    psd: "image/vnd.adobe.photoshop",
    rar: "application/vnd.rar",
    rtf: "application/rtf",
    sqlite: "application/vnd.sqlite3",
    sqlite3: "application/vnd.sqlite3",
    svg: "image/svg+xml",
    tar: "application/x-tar",
    tgz: "application/gzip",
    tif: "image/tiff",
    tiff: "image/tiff",
    txt: "text/plain",
    tsv: "text/tab-separated-values",
    wav: "audio/wav",
    wave: "audio/wave",
    webm: "video/webm",
    webp: "image/webp",
    xls: "application/vnd.ms-excel",
    xlsb: "application/vnd.ms-excel.sheet.binary.macroenabled.12",
    xlsm: "application/vnd.ms-excel.sheet.macroenabled.12",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    xltm: "application/vnd.ms-excel.template.macroenabled.12",
    xltx: "application/vnd.openxmlformats-officedocument.spreadsheetml.template",
    xml: "application/xml",
    xz: "application/x-xz",
    yaml: "application/yaml",
    yml: "application/yaml",
    zip: "application/zip",
  };
  return contentTypeByExtension[ext];
}

export function inferUploadContentType(file: File): string {
  const explicitType = file.type.split(";")[0]?.trim().toLowerCase();
  if (explicitType && explicitType !== "application/octet-stream") {
    return explicitType;
  }
  const ext = file.name.split(".").pop()?.toLowerCase();
  return ext
    ? (uploadContentTypeByExtension(ext) ?? "application/octet-stream")
    : "application/octet-stream";
}

async function uploadPartWithRetry(
  uploadUrl: string,
  body: Blob,
  contentType: string,
  signal: AbortSignal,
): Promise<void> {
  let attempt = 0;
  await setLoop(
    async (loopSignal) => {
      attempt += 1;
      const result = await settle(
        fetchResource(
          uploadUrl,
          {
            method: "PUT",
            body,
            headers: { "content-type": contentType },
          },
          loopSignal,
        ),
        loopSignal,
      );
      if (result.ok) {
        if (result.value.ok) {
          return true;
        }
        if (attempt === MAX_PART_UPLOAD_ATTEMPTS) {
          throw new Error(
            `storage returned ${result.value.status} ${result.value.statusText}`,
          );
        }
      } else if (attempt === MAX_PART_UPLOAD_ATTEMPTS) {
        throw result.error;
      }
      await delay(
        IN_VITEST ? 0 : PART_UPLOAD_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1),
        { signal: loopSignal },
      );
      return false;
    },
    0,
    signal,
    { retryTransientErrors: false },
  );
  signal.throwIfAborted();
}

type UploadPurpose = "image-reference" | undefined;

const uploadFile$ = command(
  async (
    { get, set },
    file: File,
    purpose: UploadPurpose,
    signal: AbortSignal,
  ): Promise<UploadedFileInfo> => {
    const client = get(apiClient$)(uploadsContract);
    const contentType = inferUploadContentType(file);

    // The browser transfers bytes directly to storage. The narrow
    // image-reference purpose selects a private-artifact allocation without
    // changing ordinary composer attachment uploads.
    const prepared = await accept(
      client.prepare({
        body: {
          filename: file.name,
          contentType,
          size: file.size,
          ...(file.size >= MULTIPART_UPLOAD_THRESHOLD_BYTES
            ? { multipart: true as const }
            : {}),
          ...(purpose === undefined ? {} : { purpose }),
        },
        fetchOptions: { signal },
      }),
      [200],
    );
    signal.throwIfAborted();

    if ("multipart" in prepared.body) {
      const multipart = prepared.body.multipart;
      let completionStarted = false;
      return await onRejection(
        (async () => {
          signal.throwIfAborted();
          for (const part of multipart.parts) {
            const start = (part.partNumber - 1) * multipart.partSize;
            const end = Math.min(start + multipart.partSize, file.size);
            await uploadPartWithRetry(
              part.uploadUrl,
              file.slice(start, end, prepared.body.contentType),
              prepared.body.contentType,
              signal,
            );
          }

          signal.throwIfAborted();
          completionStarted = true;
          const completed = await accept(
            client.completeMultipart({
              body: {
                id: prepared.body.id,
                filename: prepared.body.filename,
                uploadId: multipart.uploadId,
                partCount: multipart.parts.length,
              },
              fetchOptions: { signal },
            }),
            [200],
          );
          signal.throwIfAborted();
          if (purpose === undefined) {
            return uploadedFileInfo(completed.body, prepared.body.contentType);
          }
          const finalized = await accept(
            client.complete({
              body: { id: completed.body.id },
              fetchOptions: { signal },
            }),
            [200],
          );
          signal.throwIfAborted();
          return uploadedFileInfo(finalized.body, finalized.body.contentType);
        })(),
        async () => {
          // Once completion begins, aborting can race a successful R2 finalize.
          // Pre-completion failures still release the multipart upload eagerly;
          // pending private-artifact rows follow the backend's orphan cleanup.
          if (completionStarted) {
            return;
          }
          const cleanupSignal = AbortSignal.timeout(MULTIPART_ABORT_TIMEOUT_MS);
          await set(
            abortMultipartUpload$,
            {
              id: prepared.body.id,
              filename: prepared.body.filename,
              uploadId: multipart.uploadId,
            },
            cleanupSignal,
          );
        },
      );
    }

    const putResponse = await fetchResource(
      prepared.body.uploadUrl,
      {
        method: "PUT",
        body: file,
        headers: {
          "content-type": prepared.body.contentType,
          ...prepared.body.uploadHeaders,
        },
      },
      signal,
    );
    signal.throwIfAborted();

    if (!putResponse.ok) {
      throw new Error(
        `storage returned ${putResponse.status} ${putResponse.statusText}`,
      );
    }
    if (purpose === undefined) {
      return uploadedFileInfo(prepared.body, prepared.body.contentType);
    }

    const finalized = await accept(
      client.complete({
        body: { id: prepared.body.id },
        fetchOptions: { signal },
      }),
      [200],
    );
    signal.throwIfAborted();
    return uploadedFileInfo(finalized.body, finalized.body.contentType);
  },
);

/** Upload an ordinary composer attachment without changing its existing flow. */
export const uploadFileToStorage$ = command(
  async ({ set }, file: File, signal: AbortSignal) => {
    return await set(uploadFile$, file, undefined, signal);
  },
);

interface UploadedPrivateArtifact {
  readonly id: string;
}

/** Upload and finalize one owner-authenticated private artifact. */
export const uploadPrivateArtifactToStorage$ = command(
  async (
    { set },
    file: File,
    signal: AbortSignal,
  ): Promise<UploadedPrivateArtifact> => {
    const uploaded = await set(uploadFile$, file, "image-reference", signal);
    return { id: uploaded.id };
  },
);
