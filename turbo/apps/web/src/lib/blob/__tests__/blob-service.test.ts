import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  beforeAll,
  afterAll,
} from "vitest";
import { eq, like } from "drizzle-orm";
import { initServices } from "../../init-services";
import { blobs } from "../../../db/schema/blob";
import * as s3Client from "../../s3/s3-client";
import type { FileEntry } from "../../storage/content-hash";

// Mock AWS SDK (third-party external dependency)
vi.mock("@aws-sdk/client-s3");

// Set required environment variables before initServices
process.env.R2_USER_STORAGES_BUCKET_NAME = "test-blobs-bucket";

// Prefix for test data to enable cleanup
const TEST_HASH_PREFIX = "test_";

// Import BlobService after setting up mocks
let BlobService: typeof import("../blob-service").BlobService;

describe("BlobService", () => {
  let blobService: InstanceType<typeof BlobService>;

  beforeAll(async () => {
    initServices();
    // Dynamically import to avoid env() being called before initServices
    const blobModule = await import("../blob-service");
    BlobService = blobModule.BlobService;
  });

  beforeEach(async () => {
    blobService = new BlobService();
    vi.clearAllMocks();

    // Mock s3Client functions (spying on real module)
    vi.spyOn(s3Client, "uploadS3Buffer").mockResolvedValue(undefined);

    // Clean up test blobs before each test
    await globalThis.services.db
      .delete(blobs)
      .where(like(blobs.hash, `${TEST_HASH_PREFIX}%`));
  });

  afterAll(async () => {
    // Final cleanup
    await globalThis.services.db
      .delete(blobs)
      .where(like(blobs.hash, `${TEST_HASH_PREFIX}%`));
  });

  describe("uploadBlobs", () => {
    it("should return empty result for empty file list", async () => {
      const result = await blobService.uploadBlobs([]);

      expect(result).toEqual({
        hashes: new Map(),
        newBlobsCount: 0,
        existingBlobsCount: 0,
        bytesUploaded: 0,
      });

      expect(s3Client.uploadS3Buffer).not.toHaveBeenCalled();
    });

    it("should upload new blobs to S3 and insert into database", async () => {
      const files: FileEntry[] = [
        { path: "file1.txt", content: Buffer.from("content1") },
        { path: "file2.txt", content: Buffer.from("content2") },
      ];

      vi.mocked(s3Client.uploadS3Buffer).mockResolvedValue(undefined);

      const result = await blobService.uploadBlobs(files);

      expect(result.newBlobsCount).toBe(2);
      expect(result.existingBlobsCount).toBe(0);
      expect(result.hashes.size).toBe(2);
      expect(s3Client.uploadS3Buffer).toHaveBeenCalledTimes(2);

      // Verify blobs were actually inserted into database
      const hash1 = result.hashes.get("file1.txt")!;
      const hash2 = result.hashes.get("file2.txt")!;

      const dbBlobs = await globalThis.services.db
        .select()
        .from(blobs)
        .where(eq(blobs.hash, hash1));

      expect(dbBlobs).toHaveLength(1);
      expect(dbBlobs[0]!.refCount).toBe(1);

      // Clean up the non-test-prefixed blobs
      await globalThis.services.db.delete(blobs).where(eq(blobs.hash, hash1));
      await globalThis.services.db.delete(blobs).where(eq(blobs.hash, hash2));
    });

    it("should deduplicate existing blobs", async () => {
      // First, insert a blob directly
      const content = Buffer.from("existing-content");
      const crypto = await import("node:crypto");
      const existingHash = crypto
        .createHash("sha256")
        .update(content)
        .digest("hex");

      // Clean up first in case of leftover data
      await globalThis.services.db
        .delete(blobs)
        .where(eq(blobs.hash, existingHash));

      await globalThis.services.db.insert(blobs).values({
        hash: existingHash,
        size: content.length,
        refCount: 1,
      });

      const files: FileEntry[] = [{ path: "file1.txt", content }];

      const result = await blobService.uploadBlobs(files);

      expect(result.newBlobsCount).toBe(0);
      expect(result.existingBlobsCount).toBe(1);
      expect(result.bytesUploaded).toBe(0);
      expect(s3Client.uploadS3Buffer).not.toHaveBeenCalled();

      // Verify ref count was incremented
      const dbBlobs = await globalThis.services.db
        .select()
        .from(blobs)
        .where(eq(blobs.hash, existingHash));

      expect(dbBlobs[0]!.refCount).toBe(2);

      // Cleanup
      await globalThis.services.db
        .delete(blobs)
        .where(eq(blobs.hash, existingHash));
    });

    it("should handle mixed new and existing blobs", async () => {
      // Insert one existing blob
      const existingContent = Buffer.from("existing-content-mixed");
      const crypto = await import("node:crypto");
      const existingHash = crypto
        .createHash("sha256")
        .update(existingContent)
        .digest("hex");

      // Clean up first in case of leftover data
      await globalThis.services.db
        .delete(blobs)
        .where(eq(blobs.hash, existingHash));

      await globalThis.services.db.insert(blobs).values({
        hash: existingHash,
        size: existingContent.length,
        refCount: 1,
      });

      const files: FileEntry[] = [
        { path: "new.txt", content: Buffer.from("new-content-unique") },
        { path: "existing.txt", content: existingContent },
      ];

      vi.mocked(s3Client.uploadS3Buffer).mockResolvedValue(undefined);

      const result = await blobService.uploadBlobs(files);

      expect(result.newBlobsCount).toBe(1);
      expect(result.existingBlobsCount).toBe(1);
      expect(result.hashes.size).toBe(2);
      expect(s3Client.uploadS3Buffer).toHaveBeenCalledTimes(1);

      // Clean up
      const newHash = result.hashes.get("new.txt")!;
      await globalThis.services.db
        .delete(blobs)
        .where(eq(blobs.hash, existingHash));
      await globalThis.services.db.delete(blobs).where(eq(blobs.hash, newHash));
    });

    it("should deduplicate files with same content", async () => {
      const files: FileEntry[] = [
        { path: "file1.txt", content: Buffer.from("same-content-dedup") },
        { path: "file2.txt", content: Buffer.from("same-content-dedup") },
      ];

      vi.mocked(s3Client.uploadS3Buffer).mockResolvedValue(undefined);

      const result = await blobService.uploadBlobs(files);

      // Two files but only one unique blob
      expect(result.hashes.size).toBe(2);
      expect(result.newBlobsCount).toBe(1);
      expect(s3Client.uploadS3Buffer).toHaveBeenCalledTimes(1);

      // Both files should have the same hash
      const hash1 = result.hashes.get("file1.txt");
      const hash2 = result.hashes.get("file2.txt");
      expect(hash1).toBe(hash2);

      // Clean up
      await globalThis.services.db.delete(blobs).where(eq(blobs.hash, hash1!));
    });
  });

  describe("decrementRefCounts", () => {
    it("should do nothing for empty hash list", async () => {
      await blobService.decrementRefCounts([]);

      // No error should be thrown
    });

    it("should decrement ref counts for given hashes", async () => {
      // Insert a blob with ref_count = 2
      const hash = `${TEST_HASH_PREFIX}decrement_test`;
      await globalThis.services.db.insert(blobs).values({
        hash,
        size: 100,
        refCount: 2,
      });

      await blobService.decrementRefCounts([hash]);

      // Verify ref count was decremented
      const dbBlobs = await globalThis.services.db
        .select()
        .from(blobs)
        .where(eq(blobs.hash, hash));

      expect(dbBlobs[0]!.refCount).toBe(1);
    });
  });

  describe("exists", () => {
    it("should return true when blob exists", async () => {
      const hash = `${TEST_HASH_PREFIX}exists_true`;
      await globalThis.services.db.insert(blobs).values({
        hash,
        size: 100,
        refCount: 1,
      });

      const result = await blobService.exists(hash);

      expect(result).toBe(true);
    });

    it("should return false when blob does not exist", async () => {
      const result = await blobService.exists(`${TEST_HASH_PREFIX}nonexistent`);

      expect(result).toBe(false);
    });
  });
});
