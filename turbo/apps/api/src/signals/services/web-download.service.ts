import { computed, type Computed } from "ccstate";

import { downloadS3Buffer } from "../external/s3";
import { uploadedArtifactObject } from "./uploaded-artifact.service";

interface DownloadFileResult {
  readonly buffer: Buffer;
  readonly contentType: string;
  readonly filename: string;
  readonly isPrivate: boolean;
}

/**
 * Locate and download a user-owned file by its file ID and owning user.
 * Returns null when no matching S3 object exists.
 */
export function webDownloadFile(
  fileId: string,
  userId: string,
  orgId?: string,
): Computed<Promise<DownloadFileResult | null>> {
  return computed(async (get): Promise<DownloadFileResult | null> => {
    const object = await get(
      uploadedArtifactObject({ userId, orgId, id: fileId }),
    );
    if (!object) {
      return null;
    }

    const buffer = await get(downloadS3Buffer(object.bucket, object.key));

    return {
      buffer,
      contentType: object.contentType,
      filename: object.filename,
      isPrivate: object.isPrivate,
    };
  });
}
