import { computed, type Computed } from "ccstate";

import { env } from "../../lib/env";
import { downloadS3Buffer, listS3Objects } from "../external/s3";

const EXT_MIMETYPE_MAP: Readonly<Record<string, string>> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  svg: "image/svg+xml",
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  aac: "audio/aac",
  flac: "audio/flac",
  m4a: "audio/mp4",
  mp3: "audio/mpeg",
  mpga: "audio/mpeg",
  oga: "audio/ogg",
  ogg: "audio/ogg",
  opus: "audio/opus",
  wav: "audio/wav",
  pdf: "application/pdf",
  txt: "text/plain",
  csv: "text/csv",
  md: "text/markdown",
  html: "text/html",
  htm: "text/html",
  json: "application/json",
};

function inferMimetype(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase();
  const mapped = ext ? EXT_MIMETYPE_MAP[ext] : undefined;
  return mapped ?? "application/octet-stream";
}

interface DownloadFileResult {
  readonly buffer: Buffer;
  readonly contentType: string;
  readonly filename: string;
}

/**
 * Locate and download a web-uploaded file by its file ID and owning user.
 * Returns null when no matching S3 object exists.
 */
export function zeroWebDownloadFile(
  fileId: string,
  userId: string,
): Computed<Promise<DownloadFileResult | null>> {
  return computed(async (get): Promise<DownloadFileResult | null> => {
    const bucket = env("R2_USER_STORAGES_BUCKET_NAME");
    if (!bucket) {
      return null;
    }

    const prefix = `uploads/${userId}/${fileId}/`;
    const objects = await get(listS3Objects(bucket, prefix));

    if (objects.length === 0) {
      return null;
    }

    const s3Object = objects[0]!;
    const filename = s3Object.key.split("/").pop() ?? fileId;
    const contentType = inferMimetype(filename);
    const buffer = await get(downloadS3Buffer(bucket, s3Object.key));

    return { buffer, contentType, filename };
  });
}
