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
