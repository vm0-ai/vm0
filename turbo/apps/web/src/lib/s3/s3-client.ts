import {
  S3Client,
  ListObjectsV2Command,
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectsCommand,
  HeadObjectCommand,
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { env } from "../../env";
import { PassThrough } from "node:stream";
import archiver from "archiver";
import type {
  S3Uri,
  S3Object,
  S3StorageManifest,
  UploadWithManifestResult,
} from "./types";
import { s3DownloadError, s3UploadError } from "./types";
import { hashFileContent, type FileEntry } from "../storage/content-hash";

/**
 * Parse S3 URI into bucket and prefix
 * @param uri - S3 URI in format s3://bucket/prefix
 * @returns Parsed bucket and prefix
 */
export function parseS3Uri(uri: string): S3Uri {
  const s3UriPattern = /^s3:\/\/([^/]+)\/?(.*)$/;
  const match = uri.match(s3UriPattern);

  if (!match) {
    throw new Error(
      `Invalid S3 URI format: ${uri}. Expected: s3://bucket/prefix`,
    );
  }

  return {
    bucket: match[1]!,
    prefix: match[2] || "",
  };
}

/**
 * Get S3 client instance configured for Cloudflare R2
 */
function getS3Client(): S3Client {
  const envVars = env();

  return new S3Client({
    region: "auto",
    endpoint: `https://${envVars.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: envVars.R2_ACCESS_KEY_ID,
      secretAccessKey: envVars.R2_SECRET_ACCESS_KEY,
    },
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
 */
export async function uploadS3Buffer(
  bucket: string,
  key: string,
  data: Buffer,
): Promise<void> {
  const client = getS3Client();

  try {
    const command = new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: data,
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
 * Generate presigned URL for downloading a single S3 object
 * @param bucket - S3 bucket name
 * @param key - S3 object key
 * @param expiresIn - URL expiration time in seconds (default: 86400 = 24 hours)
 * @param filename - Optional filename for the download (sets Content-Disposition header)
 * @returns Presigned URL string
 */
export async function generatePresignedUrl(
  bucket: string,
  key: string,
  expiresIn: number = 86400,
  filename?: string,
): Promise<string> {
  const client = getS3Client();

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
 * Stream tar.gz archive directly to S3 using multipart upload
 * Avoids loading entire archive into memory
 *
 * @param bucket - S3 bucket name
 * @param key - S3 object key
 * @param fileEntries - Array of file entries with content
 */
async function streamTarGzToS3(
  bucket: string,
  key: string,
  fileEntries: FileEntry[],
): Promise<void> {
  const client = getS3Client();
  const passThrough = new PassThrough();

  // Create archiver and pipe to passthrough stream
  const archive = archiver("tar", { gzip: true });
  archive.pipe(passThrough);

  // Start multipart upload with streaming
  const upload = new Upload({
    client,
    params: {
      Bucket: bucket,
      Key: key,
      Body: passThrough,
      ContentType: "application/gzip",
    },
    // Use 5MB parts (minimum for multipart)
    partSize: 5 * 1024 * 1024,
    // Upload parts concurrently
    queueSize: 4,
  });

  // Add files to archive (this starts the streaming)
  for (const file of fileEntries) {
    archive.append(file.content, { name: file.path });
  }

  // Finalize archive (signals end of data)
  const finalizePromise = archive.finalize();

  // Wait for both archive finalization and upload completion
  await Promise.all([finalizePromise, upload.done()]);
}

/**
 * Upload storage version with manifest.json and archive.tar.gz
 *
 * Creates the new S3 structure:
 * - {prefix}/manifest.json - File manifest with blob hashes
 * - {prefix}/archive.tar.gz - Streaming tar.gz archive for fast download
 *
 * Note: Blobs are uploaded separately by the blob service
 *
 * @param s3Uri - S3 URI in format s3://bucket/prefix
 * @param versionId - Version ID (content hash) for the manifest
 * @param fileEntries - Array of file entries with content
 * @param blobHashes - Map of file path to blob hash (from blob service)
 * @returns Upload result with manifest
 */
export async function uploadStorageVersionArchive(
  s3Uri: string,
  versionId: string,
  fileEntries: FileEntry[],
  blobHashes: Map<string, string>,
): Promise<UploadWithManifestResult> {
  const { bucket, prefix } = parseS3Uri(s3Uri);

  // Calculate total size
  const totalSize = fileEntries.reduce((sum, f) => sum + f.content.length, 0);

  // 1. Create manifest with blob hashes
  const manifest: S3StorageManifest = {
    version: versionId,
    createdAt: new Date().toISOString(),
    totalSize,
    fileCount: fileEntries.length,
    files: fileEntries.map((f) => ({
      path: f.path,
      hash: blobHashes.get(f.path) || hashFileContent(f.content),
      size: f.content.length,
    })),
  };

  // 2. Upload manifest.json
  const manifestJson = JSON.stringify(manifest, null, 2);
  await uploadS3Buffer(
    bucket,
    `${prefix}/manifest.json`,
    Buffer.from(manifestJson),
  );

  // 3. Stream archive.tar.gz directly to S3 using multipart upload
  await streamTarGzToS3(bucket, `${prefix}/archive.tar.gz`, fileEntries);

  return {
    s3Prefix: prefix,
    filesUploaded: fileEntries.length,
    totalBytes: totalSize,
    manifest,
  };
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
 * Generate presigned URL for uploading (PUT) a single S3 object
 * Used for direct client-to-S3 uploads that bypass Vercel serverless limits
 *
 * @param bucket - S3 bucket name
 * @param key - S3 object key
 * @param contentType - MIME type of the file (default: application/octet-stream)
 * @param expiresIn - URL expiration time in seconds (default: 3600 = 1 hour)
 * @returns Presigned PUT URL string
 */
export async function generatePresignedPutUrl(
  bucket: string,
  key: string,
  contentType: string = "application/octet-stream",
  expiresIn: number = 3600,
): Promise<string> {
  const client = getS3Client();

  const command = new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    ContentType: contentType,
  });

  return getSignedUrl(client, command, { expiresIn });
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
