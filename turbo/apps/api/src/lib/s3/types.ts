/**
 * S3 URI components
 */
export interface S3Uri {
  bucket: string;
  prefix: string;
}

/**
 * S3 object metadata
 */
export interface S3Object {
  key: string;
  size: number;
  lastModified: Date;
}

/**
 * Result of downloading S3 directory
 */
export interface DownloadResult {
  localPath: string;
  filesDownloaded: number;
  totalBytes: number;
}

/**
 * Result of uploading directory to S3
 */
export interface UploadResult {
  s3Prefix: string;
  filesUploaded: number;
  totalBytes: number;
}

/**
 * File with presigned URL for direct download
 */
export interface PresignedFile {
  /** Relative path within the storage */
  path: string;
  /** Presigned URL for downloading the file */
  url: string;
  /** File size in bytes */
  size: number;
}

/**
 * S3 download error
 */
export class S3DownloadError extends Error {
  constructor(
    message: string,
    public readonly bucket: string,
    public readonly key?: string,
    public readonly cause?: Error,
  ) {
    super(message);
    this.name = "S3DownloadError";
  }
}

/**
 * S3 upload error
 */
export class S3UploadError extends Error {
  constructor(
    message: string,
    public readonly bucket: string,
    public readonly key?: string,
    public readonly cause?: Error,
  ) {
    super(message);
    this.name = "S3UploadError";
  }
}

/**
 * File entry with hash for manifest generation
 */
export interface FileEntryWithHash {
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

/**
 * Result of uploading directory with manifest and archive
 */
export interface UploadWithManifestResult extends UploadResult {
  /** The generated storage manifest */
  manifest: S3StorageManifest;
}
