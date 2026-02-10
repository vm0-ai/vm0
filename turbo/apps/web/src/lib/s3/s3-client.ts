import {
  S3Client,
  ListObjectsV2Command,
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectsCommand,
  HeadObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { env } from "../../env";
import type { S3Object, S3StorageManifest } from "./types";
import { s3DownloadError, s3UploadError } from "./types";

/**
 * Get S3 client for server-to-S3 operations (upload, download, list, delete).
 * Uses S3_ENDPOINT which may be a container-internal address (e.g. http://minio:9000).
 */
function getS3Client(): S3Client {
  const envVars = env();

  const endpoint =
    envVars.S3_ENDPOINT ||
    `https://${envVars.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;
  const region = envVars.S3_REGION || "auto";
  const forcePathStyle = envVars.S3_FORCE_PATH_STYLE === "true";

  return new S3Client({
    region,
    endpoint,
    credentials: {
      accessKeyId: envVars.R2_ACCESS_KEY_ID,
      secretAccessKey: envVars.R2_SECRET_ACCESS_KEY,
    },
    forcePathStyle,
  });
}

/**
 * Get S3 client for generating presigned URLs consumed by external clients
 * (CLI, browsers, public API). Uses S3_PUBLIC_ENDPOINT so the resulting URLs
 * are reachable from outside the Docker network. Falls back to the internal
 * endpoint when S3_PUBLIC_ENDPOINT is not set (e.g. SaaS / R2).
 */
function getPublicS3Client(): S3Client {
  const envVars = env();

  const publicEndpoint = envVars.S3_PUBLIC_ENDPOINT;
  if (!publicEndpoint) {
    return getS3Client();
  }

  const region = envVars.S3_REGION || "auto";
  const forcePathStyle = envVars.S3_FORCE_PATH_STYLE === "true";

  return new S3Client({
    region,
    endpoint: publicEndpoint,
    credentials: {
      accessKeyId: envVars.R2_ACCESS_KEY_ID,
      secretAccessKey: envVars.R2_SECRET_ACCESS_KEY,
    },
    forcePathStyle,
  });
}

/**
 * List all objects under S3 prefix
 * @param bucket - S3 bucket name
 * @param prefix - S3 prefix (directory path)
 * @returns Array of S3 objects
 */
export async function listS3Objects(
  bucket: string,
  prefix: string,
): Promise<S3Object[]> {
  const client = getS3Client();
  const objects: S3Object[] = [];
  let continuationToken: string | undefined;

  try {
    do {
      const command = new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix,
        ContinuationToken: continuationToken,
      });

      const response = await client.send(command);

      if (response.Contents) {
        for (const item of response.Contents) {
          if (item.Key && item.Size !== undefined && item.LastModified) {
            objects.push({
              key: item.Key,
              size: item.Size,
              lastModified: item.LastModified,
            });
          }
        }
      }

      continuationToken = response.NextContinuationToken;
    } while (continuationToken);

    return objects;
  } catch (error) {
    throw s3DownloadError(
      `Failed to list objects in s3://${bucket}/${prefix}`,
      bucket,
      undefined,
      error instanceof Error ? error : undefined,
    );
  }
}

/**
 * Upload buffer data directly to S3
 * @param bucket - S3 bucket name
 * @param key - S3 object key
 * @param data - Buffer data to upload
 * @param contentType - Optional MIME type for the file
 */
export async function uploadS3Buffer(
  bucket: string,
  key: string,
  data: Buffer,
  contentType?: string,
): Promise<void> {
  const client = getS3Client();

  try {
    const command = new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: data,
      ...(contentType && { ContentType: contentType }),
    });

    await client.send(command);
  } catch (error) {
    throw s3UploadError(
      `Failed to upload buffer to s3://${bucket}/${key}`,
      bucket,
      key,
      error instanceof Error ? error : undefined,
    );
  }
}

/**
 * Delete specific S3 objects by key
 * @param bucket - S3 bucket name
 * @param keys - Array of S3 object keys to delete
 */
export async function deleteS3Objects(
  bucket: string,
  keys: string[],
): Promise<void> {
  if (keys.length === 0) return;

  const client = getS3Client();

  // Delete in batches of 1000 (AWS limit)
  const batchSize = 1000;
  for (let i = 0; i < keys.length; i += batchSize) {
    const batch = keys.slice(i, i + batchSize);

    const command = new DeleteObjectsCommand({
      Bucket: bucket,
      Delete: {
        Objects: batch.map((key) => ({ Key: key })),
      },
    });

    await client.send(command);
  }
}

/**
 * Generate presigned URL for downloading a single S3 object.
 * Set usePublicEndpoint=true when the URL is consumed by external clients
 * (CLI, browsers) rather than by sandbox containers in the Docker network.
 */
export async function generatePresignedUrl(
  bucket: string,
  key: string,
  expiresIn: number = 86400,
  filename?: string,
  usePublicEndpoint: boolean = false,
): Promise<string> {
  const client = usePublicEndpoint ? getPublicS3Client() : getS3Client();

  const command = new GetObjectCommand({
    Bucket: bucket,
    Key: key,
    ...(filename && {
      ResponseContentDisposition: `attachment; filename="${filename}"`,
    }),
  });

  return getSignedUrl(client, command, { expiresIn });
}

/**
 * Download and parse manifest.json from S3
 * @param bucket - S3 bucket name
 * @param s3Key - S3 key prefix (e.g., "userId/storageName/versionId")
 * @returns Parsed storage manifest
 */
export async function downloadManifest(
  bucket: string,
  s3Key: string,
): Promise<S3StorageManifest> {
  const client = getS3Client();
  const manifestKey = `${s3Key}/manifest.json`;

  const command = new GetObjectCommand({
    Bucket: bucket,
    Key: manifestKey,
  });

  const response = await client.send(command);

  if (!response.Body) {
    throw s3DownloadError(
      `Empty response body for manifest`,
      bucket,
      manifestKey,
    );
  }

  const chunks: Uint8Array[] = [];
  for await (const chunk of response.Body as AsyncIterable<Uint8Array>) {
    chunks.push(chunk);
  }

  const buffer = Buffer.concat(chunks);
  const manifest = JSON.parse(buffer.toString("utf-8")) as S3StorageManifest;

  return manifest;
}

/**
 * Download a single blob from S3
 * @param bucket - S3 bucket name
 * @param hash - Blob hash (SHA-256)
 * @returns Blob content as Buffer
 */
export async function downloadBlob(
  bucket: string,
  hash: string,
): Promise<Buffer> {
  const client = getS3Client();
  const blobKey = `blobs/${hash}.blob`;

  const command = new GetObjectCommand({
    Bucket: bucket,
    Key: blobKey,
  });

  const response = await client.send(command);

  if (!response.Body) {
    throw s3DownloadError(`Empty response body for blob`, bucket, blobKey);
  }

  const chunks: Uint8Array[] = [];
  for await (const chunk of response.Body as AsyncIterable<Uint8Array>) {
    chunks.push(chunk);
  }

  return Buffer.concat(chunks);
}

/**
 * Generate presigned URL for uploading (PUT) a single S3 object.
 * Used for direct client-to-S3 uploads that bypass Vercel serverless limits.
 * Set usePublicEndpoint=true when the URL is consumed by external clients.
 */
export async function generatePresignedPutUrl(
  bucket: string,
  key: string,
  contentType: string = "application/octet-stream",
  expiresIn: number = 3600,
  usePublicEndpoint: boolean = false,
): Promise<string> {
  const client = usePublicEndpoint ? getPublicS3Client() : getS3Client();

  const command = new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    ContentType: contentType,
  });

  return getSignedUrl(client, command, { expiresIn });
}

/**
 * Upload content directly to S3 (server-side).
 * Use this instead of presigned URLs when uploading from the server itself.
 *
 * @param bucket - S3 bucket name
 * @param key - S3 object key
 * @param body - Content to upload
 * @param contentType - MIME type of the content
 */
export async function putS3Object(
  bucket: string,
  key: string,
  body: string | Buffer,
  contentType: string,
): Promise<void> {
  const client = getS3Client();

  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: body,
      ContentType: contentType,
    }),
  );
}

/**
 * Check if an S3 object exists using HeadObject
 * Does not download the object content, only checks metadata
 *
 * @param bucket - S3 bucket name
 * @param key - S3 object key
 * @returns true if object exists, false if not found
 * @throws Error for other S3 errors (permissions, etc.)
 */
export async function s3ObjectExists(
  bucket: string,
  key: string,
): Promise<boolean> {
  const client = getS3Client();

  try {
    await client.send(
      new HeadObjectCommand({
        Bucket: bucket,
        Key: key,
      }),
    );
    return true;
  } catch (error) {
    // NotFound is the expected error when object doesn't exist
    if ((error as { name?: string }).name === "NotFound") {
      return false;
    }
    // Re-throw other errors (permissions, etc.)
    throw error;
  }
}

/**
 * Verify that S3 files exist for a storage version.
 * Checks manifest.json and archive.tar.gz (if fileCount > 0).
 *
 * Used to validate that a version in the database has corresponding S3 files,
 * particularly important for deduplication scenarios where we need to ensure
 * the files weren't deleted.
 *
 * @param bucket - S3 bucket name
 * @param s3Key - Base S3 key for the version (e.g., "userId/artifact/name/versionId")
 * @param fileCount - Number of files in the version (0 means empty artifact, no archive needed)
 * @returns true if all required files exist, false otherwise
 */
export async function verifyS3FilesExist(
  bucket: string,
  s3Key: string,
  fileCount: number,
): Promise<boolean> {
  const manifestKey = `${s3Key}/manifest.json`;
  const archiveKey = `${s3Key}/archive.tar.gz`;

  const [manifestExists, archiveExists] = await Promise.all([
    s3ObjectExists(bucket, manifestKey),
    // Empty artifacts (fileCount === 0) don't have an archive file
    fileCount > 0 ? s3ObjectExists(bucket, archiveKey) : Promise.resolve(true),
  ]);

  return manifestExists && archiveExists;
}
