import { computed, type Computed } from "ccstate";

import { env } from "../../lib/env";
import { inferMimetype } from "../../lib/mimetype";
import { downloadS3Buffer, listS3Objects } from "../external/s3";

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
