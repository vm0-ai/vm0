import { computed, type Computed } from "ccstate";

import { env } from "../../lib/env";
import { downloadS3Buffer } from "../external/s3";
import { resolvedArtifactObject } from "./artifact-storage.service";

interface DownloadFileResult {
  readonly buffer: Buffer;
  readonly contentType: string;
  readonly filename: string;
}

/**
 * Locate and download a user-owned file by its file ID and owning user.
 * Returns null when no matching S3 object exists.
 */
export function zeroWebDownloadFile(
  fileId: string,
  userId: string,
): Computed<Promise<DownloadFileResult | null>> {
  return computed(async (get): Promise<DownloadFileResult | null> => {
    const bucket = env("R2_USER_ARTIFACTS_BUCKET_NAME");
    if (!bucket) {
      return null;
    }
    const object = await get(resolvedArtifactObject(userId, fileId));
    if (!object) {
      return null;
    }

    const buffer = await get(downloadS3Buffer(bucket, object.key));

    return {
      buffer,
      contentType: object.contentType,
      filename: object.filename,
    };
  });
}
