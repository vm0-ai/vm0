/**
 * Blob Module
 * Manages content-addressable blob storage with deduplication
 */

import { downloadBlob as downloadBlobFromS3 } from "../s3/s3-client";
import { env } from "../../../env";

/**
 * Download a single blob by hash
 *
 * @param hash SHA-256 hash of the blob
 * @returns Blob content as Buffer
 */
export async function downloadBlob(hash: string): Promise<Buffer> {
  const bucketName = env().R2_USER_STORAGES_BUCKET_NAME;
  return downloadBlobFromS3(bucketName, hash);
}
