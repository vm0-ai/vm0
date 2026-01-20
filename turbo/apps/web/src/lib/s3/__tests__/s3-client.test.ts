import { describe, it, expect, vi, beforeEach } from "vitest";
import { parseS3Uri, uploadStorageVersionArchive } from "../s3-client";
import type { FileEntry } from "../../storage/content-hash";

// Set required environment variables before any imports
process.env.R2_ACCOUNT_ID = "test-account-id";
process.env.R2_ACCESS_KEY_ID = "test-key";
process.env.R2_SECRET_ACCESS_KEY = "test-secret";
process.env.R2_USER_STORAGES_BUCKET_NAME = "test-bucket";

// Mock AWS SDK
vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: vi.fn().mockImplementation(() => ({
    send: vi.fn().mockResolvedValue({}),
  })),
  ListObjectsV2Command: vi.fn(),
  GetObjectCommand: vi.fn(),
  PutObjectCommand: vi.fn(),
  DeleteObjectsCommand: vi.fn(),
}));

vi.mock("@aws-sdk/lib-storage", () => ({
  Upload: vi.fn().mockImplementation(() => ({
    done: vi.fn().mockResolvedValue({}),
  })),
}));

vi.mock("@aws-sdk/s3-request-presigner", () => ({
  getSignedUrl: vi.fn().mockResolvedValue("https://signed-url.example.com"),
}));

describe("parseS3Uri", () => {
  it("should parse valid S3 URI with prefix", () => {
    const result = parseS3Uri("s3://my-bucket/path/to/files");

    expect(result).toEqual({
      bucket: "my-bucket",
      prefix: "path/to/files",
    });
  });

  it("should parse S3 URI without prefix", () => {
    const result = parseS3Uri("s3://my-bucket/");

    expect(result).toEqual({
      bucket: "my-bucket",
      prefix: "",
    });
  });

  it("should parse S3 URI with bucket only", () => {
    const result = parseS3Uri("s3://my-bucket");

    expect(result).toEqual({
      bucket: "my-bucket",
      prefix: "",
    });
  });

  it("should parse S3 URI with nested prefix", () => {
    const result = parseS3Uri("s3://my-bucket/a/b/c/d");

    expect(result).toEqual({
      bucket: "my-bucket",
      prefix: "a/b/c/d",
    });
  });

  it("should throw error for invalid URI format", () => {
    expect(() => parseS3Uri("invalid-uri")).toThrow(
      "Invalid S3 URI format: invalid-uri",
    );
  });

  it("should throw error for http URL", () => {
    expect(() => parseS3Uri("https://bucket.s3.amazonaws.com/key")).toThrow(
      "Invalid S3 URI format",
    );
  });

  it("should throw error for empty string", () => {
    expect(() => parseS3Uri("")).toThrow("Invalid S3 URI format");
  });
});

describe("uploadStorageVersionArchive", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should upload manifest and archive for file entries", async () => {
    const files: FileEntry[] = [
      { path: "file1.txt", content: Buffer.from("content1") },
      { path: "file2.txt", content: Buffer.from("content2") },
    ];

    const blobHashes = new Map<string, string>();
    blobHashes.set("file1.txt", "hash1");
    blobHashes.set("file2.txt", "hash2");

    const result = await uploadStorageVersionArchive(
      "s3://test-bucket/user-123/storage-abc/version-xyz",
      "version-xyz",
      files,
      blobHashes,
    );

    expect(result.s3Prefix).toBe("user-123/storage-abc/version-xyz");
    expect(result.filesUploaded).toBe(2);
    expect(result.totalBytes).toBe(16); // "content1" + "content2"
    expect(result.manifest.version).toBe("version-xyz");
    expect(result.manifest.fileCount).toBe(2);
    expect(result.manifest.files).toHaveLength(2);
    expect(result.manifest.files[0]?.hash).toBe("hash1");
    expect(result.manifest.files[1]?.hash).toBe("hash2");
  });

  it("should handle empty file list", async () => {
    const result = await uploadStorageVersionArchive(
      "s3://test-bucket/prefix",
      "version-id",
      [],
      new Map(),
    );

    expect(result.filesUploaded).toBe(0);
    expect(result.totalBytes).toBe(0);
    expect(result.manifest.files).toHaveLength(0);
  });

  it("should compute hash if not provided in blobHashes map", async () => {
    const files: FileEntry[] = [
      { path: "file.txt", content: Buffer.from("test-content") },
    ];

    // Empty map - hash should be computed
    const blobHashes = new Map<string, string>();

    const result = await uploadStorageVersionArchive(
      "s3://test-bucket/prefix",
      "version-id",
      files,
      blobHashes,
    );

    // Hash should be computed from content
    expect(result.manifest.files[0]?.hash).toBeDefined();
    expect(result.manifest.files[0]?.hash.length).toBe(64); // SHA-256 hex length
  });

  it("should include correct file metadata in manifest", async () => {
    const files: FileEntry[] = [
      { path: "dir/nested/file.txt", content: Buffer.from("hello world") },
    ];

    const blobHashes = new Map<string, string>();
    blobHashes.set("dir/nested/file.txt", "test-hash");

    const result = await uploadStorageVersionArchive(
      "s3://bucket/prefix",
      "v1",
      files,
      blobHashes,
    );

    const fileEntry = result.manifest.files[0];
    expect(fileEntry?.path).toBe("dir/nested/file.txt");
    expect(fileEntry?.hash).toBe("test-hash");
    expect(fileEntry?.size).toBe(11); // "hello world".length
  });
});
