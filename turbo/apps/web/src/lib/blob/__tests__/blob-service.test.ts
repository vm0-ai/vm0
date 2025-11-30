import { describe, it, expect, vi, beforeEach } from "vitest";
import { BlobService } from "../blob-service";
import * as s3Client from "../../s3/s3-client";
import type { FileEntry } from "../../storage/content-hash";

// Mock dependencies
vi.mock("../../s3/s3-client");
vi.mock("../../../env", () => ({
  env: () => ({
    S3_USER_STORAGES_NAME: "test-bucket",
  }),
}));

describe("BlobService", () => {
  let blobService: BlobService;

  beforeEach(() => {
    blobService = new BlobService();
    vi.clearAllMocks();
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

      // Mock database - no existing blobs
      const mockDb = {
        select: vi.fn().mockReturnThis(),
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockResolvedValue([]),
        insert: vi.fn().mockReturnThis(),
        values: vi.fn().mockReturnThis(),
        onConflictDoUpdate: vi.fn().mockResolvedValue(undefined),
      };

      globalThis.services = {
        db: mockDb as never,
      } as never;

      vi.mocked(s3Client.uploadS3Buffer).mockResolvedValue(undefined);

      const result = await blobService.uploadBlobs(files);

      expect(result.newBlobsCount).toBe(2);
      expect(result.existingBlobsCount).toBe(0);
      expect(result.hashes.size).toBe(2);
      expect(s3Client.uploadS3Buffer).toHaveBeenCalledTimes(2);
    });

    it("should deduplicate existing blobs", async () => {
      const files: FileEntry[] = [
        { path: "file1.txt", content: Buffer.from("existing-content") },
      ];

      // Compute expected hash for the content
      const crypto = await import("node:crypto");
      const expectedHash = crypto
        .createHash("sha256")
        .update(Buffer.from("existing-content"))
        .digest("hex");

      // Mock database - blob already exists
      const mockDb = {
        select: vi.fn().mockReturnThis(),
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockResolvedValue([{ hash: expectedHash }]),
        update: vi.fn().mockReturnThis(),
        set: vi.fn().mockReturnThis(),
      };

      // Make the where mock chainable for update
      mockDb.where = vi.fn().mockImplementation(() => {
        return Promise.resolve([{ hash: expectedHash }]);
      });

      // Re-mock for update chain
      const mockDbWithUpdate = {
        select: vi.fn().mockReturnThis(),
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockResolvedValue([{ hash: expectedHash }]),
        update: vi.fn().mockReturnThis(),
        set: vi.fn().mockReturnThis(),
      };
      mockDbWithUpdate.update = vi.fn().mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(undefined),
        }),
      });

      globalThis.services = {
        db: mockDbWithUpdate as never,
      } as never;

      const result = await blobService.uploadBlobs(files);

      expect(result.newBlobsCount).toBe(0);
      expect(result.existingBlobsCount).toBe(1);
      expect(result.bytesUploaded).toBe(0);
      expect(s3Client.uploadS3Buffer).not.toHaveBeenCalled();
    });

    it("should handle mixed new and existing blobs", async () => {
      const files: FileEntry[] = [
        { path: "new.txt", content: Buffer.from("new-content") },
        { path: "existing.txt", content: Buffer.from("existing-content") },
      ];

      const crypto = await import("node:crypto");
      const existingHash = crypto
        .createHash("sha256")
        .update(Buffer.from("existing-content"))
        .digest("hex");

      // Mock database with one existing blob
      let selectCalled = false;
      const mockDb = {
        select: vi.fn().mockReturnThis(),
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockImplementation(() => {
          if (!selectCalled) {
            selectCalled = true;
            return Promise.resolve([{ hash: existingHash }]);
          }
          return Promise.resolve(undefined);
        }),
        insert: vi.fn().mockReturnThis(),
        values: vi.fn().mockReturnThis(),
        onConflictDoUpdate: vi.fn().mockResolvedValue(undefined),
        update: vi.fn().mockReturnValue({
          set: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue(undefined),
          }),
        }),
      };

      globalThis.services = {
        db: mockDb as never,
      } as never;

      vi.mocked(s3Client.uploadS3Buffer).mockResolvedValue(undefined);

      const result = await blobService.uploadBlobs(files);

      expect(result.newBlobsCount).toBe(1);
      expect(result.existingBlobsCount).toBe(1);
      expect(result.hashes.size).toBe(2);
      expect(s3Client.uploadS3Buffer).toHaveBeenCalledTimes(1);
    });

    it("should rollback S3 uploads on database failure", async () => {
      const files: FileEntry[] = [
        { path: "file1.txt", content: Buffer.from("content1") },
      ];

      // Mock database - fails on insert
      const mockDb = {
        select: vi.fn().mockReturnThis(),
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockResolvedValue([]),
        insert: vi.fn().mockReturnThis(),
        values: vi.fn().mockReturnThis(),
        onConflictDoUpdate: vi
          .fn()
          .mockRejectedValue(new Error("Database error")),
      };

      globalThis.services = {
        db: mockDb as never,
      } as never;

      vi.mocked(s3Client.uploadS3Buffer).mockResolvedValue(undefined);
      vi.mocked(s3Client.deleteS3Objects).mockResolvedValue(undefined);

      await expect(blobService.uploadBlobs(files)).rejects.toThrow(
        "Database error",
      );

      // Verify rollback was called
      expect(s3Client.deleteS3Objects).toHaveBeenCalledWith(
        "test-bucket",
        expect.arrayContaining([expect.stringMatching(/^blobs\/.*\.blob$/)]),
      );
    });

    it("should deduplicate files with same content", async () => {
      const files: FileEntry[] = [
        { path: "file1.txt", content: Buffer.from("same-content") },
        { path: "file2.txt", content: Buffer.from("same-content") },
      ];

      const mockDb = {
        select: vi.fn().mockReturnThis(),
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockResolvedValue([]),
        insert: vi.fn().mockReturnThis(),
        values: vi.fn().mockReturnThis(),
        onConflictDoUpdate: vi.fn().mockResolvedValue(undefined),
      };

      globalThis.services = {
        db: mockDb as never,
      } as never;

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
    });
  });

  describe("decrementRefCounts", () => {
    it("should do nothing for empty hash list", async () => {
      const mockDb = {
        update: vi.fn(),
      };

      globalThis.services = {
        db: mockDb as never,
      } as never;

      await blobService.decrementRefCounts([]);

      expect(mockDb.update).not.toHaveBeenCalled();
    });

    it("should decrement ref counts for given hashes", async () => {
      const mockWhere = vi.fn().mockResolvedValue(undefined);
      const mockSet = vi.fn().mockReturnValue({ where: mockWhere });
      const mockUpdate = vi.fn().mockReturnValue({ set: mockSet });

      const mockDb = {
        update: mockUpdate,
      };

      globalThis.services = {
        db: mockDb as never,
      } as never;

      await blobService.decrementRefCounts(["hash1", "hash2"]);

      expect(mockUpdate).toHaveBeenCalled();
      expect(mockSet).toHaveBeenCalled();
      expect(mockWhere).toHaveBeenCalled();
    });
  });

  describe("exists", () => {
    it("should return true when blob exists", async () => {
      const mockDb = {
        select: vi.fn().mockReturnThis(),
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        limit: vi.fn().mockResolvedValue([{ hash: "existing-hash" }]),
      };

      globalThis.services = {
        db: mockDb as never,
      } as never;

      const result = await blobService.exists("existing-hash");

      expect(result).toBe(true);
    });

    it("should return false when blob does not exist", async () => {
      const mockDb = {
        select: vi.fn().mockReturnThis(),
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        limit: vi.fn().mockResolvedValue([]),
      };

      globalThis.services = {
        db: mockDb as never,
      } as never;

      const result = await blobService.exists("non-existing-hash");

      expect(result).toBe(false);
    });
  });
});
