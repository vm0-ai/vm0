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
import { SessionHistoryService } from "../session-history-service";
import { initServices } from "../../init-services";
import { blobs } from "../../../db/schema/blob";
import * as s3Client from "../../s3/s3-client";

// Mock AWS SDK (third-party external dependency)
vi.mock("@aws-sdk/client-s3");

// Set required environment variables
process.env.R2_USER_STORAGES_BUCKET_NAME = "test-storages-bucket";

describe("SessionHistoryService", () => {
  let service: SessionHistoryService;

  beforeAll(async () => {
    initServices();
  });

  beforeEach(async () => {
    service = new SessionHistoryService();
    vi.clearAllMocks();

    // Mock s3Client functions (spying on real module)
    vi.spyOn(s3Client, "uploadS3Buffer").mockResolvedValue(undefined);
    vi.spyOn(s3Client, "downloadBlob").mockImplementation(
      async (bucket: string, hash: string) => {
        // Fetch from database to simulate S3 download
        const [blob] = await globalThis.services.db
          .select()
          .from(blobs)
          .where(eq(blobs.hash, hash));
        if (!blob) {
          throw new Error(`Blob not found: ${hash}`);
        }
        // Return mock content for testing
        return Buffer.from(`{"role":"user","content":"hello from ${hash}"}\n`);
      },
    );

    // Clean up test blobs from database
    await globalThis.services.db
      .delete(blobs)
      .where(like(blobs.hash, `%`))
      .execute();
  });

  afterAll(async () => {
    // Final cleanup
    await globalThis.services.db
      .delete(blobs)
      .where(like(blobs.hash, `%`))
      .execute();
  });

  describe("store", () => {
    it("should upload content to blob service and return hash", async () => {
      const content = '{"role":"user","content":"hello"}\n';

      const hash = await service.store(content);

      // Verify hash format
      expect(hash).toBeDefined();
      expect(hash).toHaveLength(64); // SHA-256 hex length

      // Verify S3 upload was called
      expect(s3Client.uploadS3Buffer).toHaveBeenCalledTimes(1);

      // Verify blob was inserted into database
      const [blob] = await globalThis.services.db
        .select()
        .from(blobs)
        .where(eq(blobs.hash, hash));

      expect(blob).toBeDefined();
      expect(blob!.size).toBe(Buffer.from(content, "utf-8").length);
    });

    it("should handle large JSONL content", async () => {
      // Simulate a large conversation history
      const lines = Array.from({ length: 1000 }, (_, i) =>
        JSON.stringify({
          role: i % 2 === 0 ? "user" : "assistant",
          content: `Message ${i}`,
        }),
      );
      const content = lines.join("\n") + "\n";

      const hash = await service.store(content);

      expect(hash).toBeDefined();
      expect(hash).toHaveLength(64);

      // Verify blob was stored
      const [blob] = await globalThis.services.db
        .select()
        .from(blobs)
        .where(eq(blobs.hash, hash));

      expect(blob).toBeDefined();
      expect(blob!.size).toBe(Buffer.from(content, "utf-8").length);
    });
  });

  describe("retrieve", () => {
    it("should download content from blob service", async () => {
      const content = '{"role":"user","content":"hello"}\n';
      // First store to get the hash
      const hash = await service.store(content);

      // Now retrieve it
      const result = await service.retrieve(hash);

      expect(s3Client.downloadBlob).toHaveBeenCalledWith(
        "test-storages-bucket",
        hash,
      );
      // The mock returns a standard format, so verify it's a string
      expect(typeof result).toBe("string");
      expect(result).toContain("hello from");
    });
  });

  describe("resolve", () => {
    it("should prioritize hash over legacy text", async () => {
      const content = '{"role":"user","content":"hello"}\n';
      const hash = await service.store(content);
      const legacyContent = '{"from":"legacy"}\n';

      const result = await service.resolve(hash, legacyContent);

      expect(s3Client.downloadBlob).toHaveBeenCalledWith(
        "test-storages-bucket",
        hash,
      );
      // Should use hash, not legacy
      expect(result).toContain("hello from");
    });

    it("should fallback to legacy text when hash is null", async () => {
      const legacyContent = '{"from":"legacy"}\n';

      const result = await service.resolve(null, legacyContent);

      expect(s3Client.downloadBlob).not.toHaveBeenCalled();
      expect(result).toBe(legacyContent);
    });

    it("should return null when both hash and legacy text are null", async () => {
      const result = await service.resolve(null, null);

      expect(s3Client.downloadBlob).not.toHaveBeenCalled();
      expect(result).toBeNull();
    });

    it("should use hash even when legacy text is empty string", async () => {
      const content = '{"role":"user","content":"hello"}\n';
      const hash = await service.store(content);

      const result = await service.resolve(hash, "");

      expect(s3Client.downloadBlob).toHaveBeenCalledWith(
        "test-storages-bucket",
        hash,
      );
      expect(result).toContain("hello from");
    });

    it("should return null when legacy text is empty string and hash is null", async () => {
      // Empty string is falsy so it returns null (no valid session history)
      const result = await service.resolve(null, "");

      expect(result).toBeNull();
    });

    it("should fallback to legacy text when R2 retrieval fails", async () => {
      // Use a fake hash that doesn't exist in the database
      const fakeHash =
        "abc123def456789012345678901234567890123456789012345678901234abcd";
      const legacyContent = '{"from":"legacy"}\n';

      // Mock downloadBlob to throw an error
      vi.spyOn(s3Client, "downloadBlob").mockRejectedValue(
        new Error("Blob not found: " + fakeHash),
      );

      const result = await service.resolve(fakeHash, legacyContent);

      expect(s3Client.downloadBlob).toHaveBeenCalledWith(
        "test-storages-bucket",
        fakeHash,
      );
      // Should fallback to legacy content instead of throwing
      expect(result).toBe(legacyContent);
    });

    it("should throw error when R2 retrieval fails and no legacy text available", async () => {
      const fakeHash =
        "abc123def456789012345678901234567890123456789012345678901234abcd";

      // Mock downloadBlob to throw an error
      vi.spyOn(s3Client, "downloadBlob").mockRejectedValue(
        new Error("Blob not found: " + fakeHash),
      );

      // Should throw because no fallback available
      await expect(service.resolve(fakeHash, null)).rejects.toThrow(
        "Blob not found",
      );
    });
  });
});
