import {
  S3Client,
  ListObjectsV2Command,
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectsCommand,
} from "@aws-sdk/client-s3";
import { env } from "../../env";
import * as fs from "node:fs";
import * as path from "node:path";
import type { S3Uri, S3Object, DownloadResult, UploadResult } from "./types";
import { S3DownloadError, S3UploadError } from "./types";

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
 * Get S3 client instance
 */
function getS3Client(): S3Client {
  const envVars = env();

  if (
    !envVars.AWS_REGION ||
    !envVars.AWS_ACCESS_KEY_ID ||
    !envVars.AWS_SECRET_ACCESS_KEY
  ) {
    throw new Error(
      "AWS credentials not configured. Set AWS_REGION, AWS_ACCESS_KEY_ID, and AWS_SECRET_ACCESS_KEY environment variables.",
    );
  }

  return new S3Client({
    region: envVars.AWS_REGION,
    credentials: {
      accessKeyId: envVars.AWS_ACCESS_KEY_ID,
      secretAccessKey: envVars.AWS_SECRET_ACCESS_KEY,
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
