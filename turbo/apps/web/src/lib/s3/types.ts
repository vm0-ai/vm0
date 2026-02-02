/**
 * S3 object metadata
 */
export interface S3Object {
  key: string;
  size: number;
  lastModified: Date;
}

/**
 * S3 download error
 */
interface S3DownloadError extends Error {
  readonly name: "S3DownloadError";
  readonly bucket: string;
  readonly key?: string;
  readonly cause?: Error;
}

export function s3DownloadError(
  message: string,
  bucket: string,
  key?: string,
  cause?: Error,
): S3DownloadError {
  const error = new Error(message) as S3DownloadError;
  (error as { name: string }).name = "S3DownloadError";
  (error as { bucket: string }).bucket = bucket;
  if (key !== undefined) {
    (error as { key: string }).key = key;
  }
  if (cause !== undefined) {
    (error as { cause: Error }).cause = cause;
  }
  return error;
}

/**
 * S3 upload error
 */
interface S3UploadError extends Error {
  readonly name: "S3UploadError";
  readonly bucket: string;
  readonly key?: string;
  readonly cause?: Error;
}

export function s3UploadError(
  message: string,
  bucket: string,
  key?: string,
  cause?: Error,
): S3UploadError {
  const error = new Error(message) as S3UploadError;
  (error as { name: string }).name = "S3UploadError";
  (error as { bucket: string }).bucket = bucket;
  if (key !== undefined) {
    (error as { key: string }).key = key;
  }
  if (cause !== undefined) {
    (error as { cause: Error }).cause = cause;
  }
  return error;
}

/**
 * File entry with hash for manifest generation
 */
interface FileEntryWithHash {
  /** Relative path within the storage */
  path: string;
  /** SHA-256 hash of file content */
  hash: string;
  /** File size in bytes */
  size: number;
}

/**
 * Storage manifest for incremental upload support
 * Stored as manifest.json alongside archive.tar.gz in S3
 */
export interface S3StorageManifest {
  /** Version ID (overall content hash) */
  version: string;
  /** ISO timestamp when manifest was created */
  createdAt: string;
  /** Total size of all files in bytes */
  totalSize: number;
  /** Number of files in the storage */
  fileCount: number;
  /** Array of files with their paths, hashes, and sizes */
  files: FileEntryWithHash[];
}
