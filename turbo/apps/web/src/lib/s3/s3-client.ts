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
import pLimit from "p-limit";
import { env } from "../../env";
import * as fs from "node:fs";
import * as path from "node:path";
import { PassThrough } from "node:stream";
import archiver from "archiver";
import type {
  S3Uri,
  S3Object,
  DownloadResult,
  UploadResult,
  PresignedFile,
  S3StorageManifest,
  UploadWithManifestResult,
} from "./types";
import { S3DownloadError, S3UploadError } from "./types";
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

  if (
    !envVars.R2_ACCOUNT_ID ||
    !envVars.R2_ACCESS_KEY_ID ||
    !envVars.R2_SECRET_ACCESS_KEY
  ) {
    throw new Error(
      "R2 credentials not configured. Set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, and R2_SECRET_ACCESS_KEY environment variables.",
    );
  }

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
    throw new S3DownloadError(
      `Failed to list objects in s3://${bucket}/${prefix}`,
      bucket,
      undefined,
      error instanceof Error ? error : undefined,
    );
  }
}

/**
 * Download single S3 object to local path
 * @param bucket - S3 bucket name
 * @param key - S3 object key
 * @param localPath - Local file path to save to
 */
export async function downloadS3Object(
  bucket: string,
  key: string,
  localPath: string,
): Promise<void> {
  const client = getS3Client();

  try {
    // Ensure directory exists
    const dir = path.dirname(localPath);
    await fs.promises.mkdir(dir, { recursive: true });

    // Download object
    const command = new GetObjectCommand({
      Bucket: bucket,
      Key: key,
    });

    const response = await client.send(command);

    if (!response.Body) {
      throw new Error("Empty response body");
    }

    // Write to file
    const chunks: Uint8Array[] = [];
    for await (const chunk of response.Body as AsyncIterable<Uint8Array>) {
      chunks.push(chunk);
    }

    const buffer = Buffer.concat(chunks);
    await fs.promises.writeFile(localPath, buffer);
  } catch (error) {
    throw new S3DownloadError(
      `Failed to download s3://${bucket}/${key} to ${localPath}`,
      bucket,
      key,
      error instanceof Error ? error : undefined,
    );
  }
}

/**
 * Download entire S3 directory to local path
 * @param s3Uri - S3 URI in format s3://bucket/prefix
 * @param localPath - Local directory path to download to
 * @returns Download result with statistics
 */
export async function downloadS3Directory(
  s3Uri: string,
  localPath: string,
): Promise<DownloadResult> {
  const { bucket, prefix } = parseS3Uri(s3Uri);

  // List all objects
  const objects = await listS3Objects(bucket, prefix);

  // Filter out directory markers (keys ending with /)
  const files = objects.filter((obj) => !obj.key.endsWith("/"));

  if (files.length === 0) {
    // Empty directory is not an error
    return {
      localPath,
      filesDownloaded: 0,
      totalBytes: 0,
    };
  }

  // Download each file
  let totalBytes = 0;
  const downloadPromises = files.map(async (file) => {
    // Calculate relative path (remove prefix)
    const relativePath = file.key.startsWith(prefix)
      ? file.key.slice(prefix.length).replace(/^\//, "")
      : file.key;

    const targetPath = path.join(localPath, relativePath);

    await downloadS3Object(bucket, file.key, targetPath);
    totalBytes += file.size;
  });

  await Promise.all(downloadPromises);

  return {
    localPath,
    filesDownloaded: files.length,
    totalBytes,
  };
}

/**
 * Upload single file to S3
 * @param bucket - S3 bucket name
 * @param key - S3 object key
 * @param localPath - Local file path to upload from
 */
export async function uploadS3Object(
  bucket: string,
  key: string,
  localPath: string,
): Promise<void> {
  const client = getS3Client();

  try {
    const fileContent = await fs.promises.readFile(localPath);

    const command = new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: fileContent,
    });

    await client.send(command);
  } catch (error) {
    throw new S3UploadError(
      `Failed to upload ${localPath} to s3://${bucket}/${key}`,
      bucket,
      key,
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
    throw new S3UploadError(
      `Failed to upload buffer to s3://${bucket}/${key}`,
      bucket,
      key,
      error instanceof Error ? error : undefined,
    );
  }
}

/**
 * Upload entire directory to S3
 * @param localPath - Local directory path to upload from
 * @param s3Uri - S3 URI in format s3://bucket/prefix
 * @returns Upload result with statistics
 */
export async function uploadS3Directory(
  localPath: string,
  s3Uri: string,
): Promise<UploadResult> {
  const { bucket, prefix } = parseS3Uri(s3Uri);

  // Get all files in directory recursively
  const files = await getAllFiles(localPath);

  if (files.length === 0) {
    return {
      s3Prefix: prefix,
      filesUploaded: 0,
      totalBytes: 0,
    };
  }

  // Upload each file
  let totalBytes = 0;
  const uploadPromises = files.map(async (filePath) => {
    // Calculate relative path from base directory
    const relativePath = path.relative(localPath, filePath);

    // Create S3 key by combining prefix with relative path
    const s3Key = prefix ? path.posix.join(prefix, relativePath) : relativePath;

    // Get file size
    const stats = await fs.promises.stat(filePath);
    totalBytes += stats.size;

    await uploadS3Object(bucket, s3Key, filePath);
  });

  await Promise.all(uploadPromises);

  return {
    s3Prefix: prefix,
    filesUploaded: files.length,
    totalBytes,
  };
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
 * Delete all objects under S3 prefix
 * @param s3Uri - S3 URI in format s3://bucket/prefix
 */
export async function deleteS3Directory(s3Uri: string): Promise<void> {
  const { bucket, prefix } = parseS3Uri(s3Uri);
  const client = getS3Client();

  // List all objects under prefix
  const objects = await listS3Objects(bucket, prefix);

  if (objects.length === 0) {
    return;
  }

  // Delete in batches of 1000 (AWS limit)
  const batchSize = 1000;
  for (let i = 0; i < objects.length; i += batchSize) {
    const batch = objects.slice(i, i + batchSize);

    const command = new DeleteObjectsCommand({
      Bucket: bucket,
      Delete: {
        Objects: batch.map((obj) => ({ Key: obj.key })),
      },
    });

    await client.send(command);
  }
}

/**
 * Get all files in directory recursively
 * @param dirPath - Directory path
 * @returns Array of file paths
 */
async function getAllFiles(dirPath: string): Promise<string[]> {
  const files: string[] = [];
  const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);

    if (entry.isDirectory()) {
      const subFiles = await getAllFiles(fullPath);
      files.push(...subFiles);
    } else {
      files.push(fullPath);
    }
  }

  return files;
}

/**
 * Generate presigned URL for downloading a single S3 object
 * @param bucket - S3 bucket name
 * @param key - S3 object key
 * @param expiresIn - URL expiration time in seconds (default: 86400 = 24 hours)
 * @returns Presigned URL string
 */
export async function generatePresignedUrl(
  bucket: string,
  key: string,
  expiresIn: number = 86400,
): Promise<string> {
  const client = getS3Client();

  const command = new GetObjectCommand({
    Bucket: bucket,
    Key: key,
  });

  return getSignedUrl(client, command, { expiresIn });
}

/**
 * Generate presigned URLs for all files under an S3 prefix
 * @param bucket - S3 bucket name
 * @param prefix - S3 prefix (directory path)
 * @param expiresIn - URL expiration time in seconds (default: 86400 = 24 hours)
 * @returns Array of files with presigned URLs
 */
export async function generatePresignedUrlsForPrefix(
  bucket: string,
  prefix: string,
  expiresIn: number = 86400,
): Promise<PresignedFile[]> {
  // List all objects under prefix
  const objects = await listS3Objects(bucket, prefix);

  // Filter out directory markers (keys ending with /)
  const files = objects.filter((obj) => !obj.key.endsWith("/"));

  if (files.length === 0) {
    return [];
  }

  // Generate presigned URLs for all files in parallel
  const presignedFiles = await Promise.all(
    files.map(async (file) => {
      // Calculate relative path (remove prefix)
      const relativePath = file.key.startsWith(prefix)
        ? file.key.slice(prefix.length).replace(/^\//, "")
        : file.key;

      const url = await generatePresignedUrl(bucket, file.key, expiresIn);

      return {
        path: relativePath,
        url,
        size: file.size,
      };
    }),
  );

  return presignedFiles;
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
    throw new S3DownloadError(
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
    throw new S3DownloadError(`Empty response body for blob`, bucket, blobKey);
  }

  const chunks: Uint8Array[] = [];
  for await (const chunk of response.Body as AsyncIterable<Uint8Array>) {
    chunks.push(chunk);
  }

  return Buffer.concat(chunks);
}

/**
 * Create archive.tar.gz from blob hashes by downloading blobs from S3
 * Used for incremental upload where we need to assemble archive from existing + new blobs
 *
 * @param bucket - S3 bucket name
 * @param archiveKey - S3 key for the output archive
 * @param files - Array of file info with path and blob hash
 */
export async function createArchiveFromBlobs(
  bucket: string,
  archiveKey: string,
  files: Array<{ path: string; blobHash: string; size: number }>,
): Promise<void> {
  // Download all blobs first
  const blobContents = new Map<string, Buffer>();
  const uniqueHashes = [...new Set(files.map((f) => f.blobHash))];

  // Download blobs in parallel with concurrency limit
  const limit = pLimit(10);
  await Promise.all(
    uniqueHashes.map((hash) =>
      limit(async () => {
        const content = await downloadBlob(bucket, hash);
        blobContents.set(hash, content);
      }),
    ),
  );

  // Build file entries for archive
  const fileEntries: FileEntry[] = files.map((f) => ({
    path: f.path,
    content: blobContents.get(f.blobHash)!,
  }));

  // Stream archive to S3
  await streamTarGzToS3(bucket, archiveKey, fileEntries);
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
