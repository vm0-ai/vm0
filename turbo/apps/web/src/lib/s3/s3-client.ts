import {
  S3Client,
  ListObjectsV2Command,
  GetObjectCommand,
} from "@aws-sdk/client-s3";
import { env } from "../../env";
import * as fs from "node:fs";
import * as path from "node:path";
import type { S3Uri, S3Object, DownloadResult } from "./types";
import { S3DownloadError } from "./types";

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
