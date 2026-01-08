import { describe, it, expect, vi, beforeEach } from "vitest";
import { SessionHistoryService } from "../session-history-service";
import * as blobServiceModule from "../../blob/blob-service";

// Mock blob service
vi.mock("../../blob/blob-service", () => ({
  blobService: {
    uploadBlobs: vi.fn(),
    downloadBlob: vi.fn(),
  },
}));

describe("SessionHistoryService", () => {
  let service: SessionHistoryService;

  beforeEach(() => {
    service = new SessionHistoryService();
    vi.clearAllMocks();
  });

  describe("store", () => {
    it("should upload content to blob service and return hash", async () => {
      const content = '{"role":"user","content":"hello"}\n';
      const mockHash =
        "abc123def456789012345678901234567890123456789012345678901234abcd";

      vi.mocked(blobServiceModule.blobService.uploadBlobs).mockResolvedValue({
        hashes: new Map([[`session-history-${mockHash}.jsonl`, mockHash]]),
        newBlobsCount: 1,
        existingBlobsCount: 0,
        bytesUploaded: Buffer.from(content, "utf-8").length,
      });

      const hash = await service.store(content);

      expect(blobServiceModule.blobService.uploadBlobs).toHaveBeenCalledTimes(
        1,
      );
      const callArg = vi.mocked(blobServiceModule.blobService.uploadBlobs).mock
        .calls[0]![0];
      expect(callArg).toHaveLength(1);
      expect(callArg[0]!.path).toMatch(/^session-history-.*\.jsonl$/);
      expect(callArg[0]!.content.toString("utf-8")).toBe(content);
      expect(hash).toBeDefined();
      expect(hash).toHaveLength(64); // SHA-256 hex length
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

      vi.mocked(blobServiceModule.blobService.uploadBlobs).mockResolvedValue({
        hashes: new Map(),
        newBlobsCount: 1,
        existingBlobsCount: 0,
        bytesUploaded: Buffer.from(content, "utf-8").length,
      });

      const hash = await service.store(content);

      expect(hash).toBeDefined();
      expect(hash).toHaveLength(64);
    });
  });

  describe("retrieve", () => {
    it("should download content from blob service", async () => {
      const hash =
        "abc123def456789012345678901234567890123456789012345678901234abcd";
      const content = '{"role":"user","content":"hello"}\n';

      vi.mocked(blobServiceModule.blobService.downloadBlob).mockResolvedValue(
        Buffer.from(content, "utf-8"),
      );

      const result = await service.retrieve(hash);

      expect(blobServiceModule.blobService.downloadBlob).toHaveBeenCalledWith(
        hash,
      );
      expect(result).toBe(content);
    });
  });

  describe("resolve", () => {
    it("should prioritize hash over legacy text", async () => {
      const hash =
        "abc123def456789012345678901234567890123456789012345678901234abcd";
      const r2Content = '{"from":"r2"}\n';
      const legacyContent = '{"from":"legacy"}\n';

      vi.mocked(blobServiceModule.blobService.downloadBlob).mockResolvedValue(
        Buffer.from(r2Content, "utf-8"),
      );

      const result = await service.resolve(hash, legacyContent);

      expect(blobServiceModule.blobService.downloadBlob).toHaveBeenCalledWith(
        hash,
      );
      expect(result).toBe(r2Content);
    });

    it("should fallback to legacy text when hash is null", async () => {
      const legacyContent = '{"from":"legacy"}\n';

      const result = await service.resolve(null, legacyContent);

      expect(blobServiceModule.blobService.downloadBlob).not.toHaveBeenCalled();
      expect(result).toBe(legacyContent);
    });

    it("should return null when both hash and legacy text are null", async () => {
      const result = await service.resolve(null, null);

      expect(blobServiceModule.blobService.downloadBlob).not.toHaveBeenCalled();
      expect(result).toBeNull();
    });

    it("should use hash even when legacy text is empty string", async () => {
      const hash =
        "abc123def456789012345678901234567890123456789012345678901234abcd";
      const r2Content = '{"from":"r2"}\n';

      vi.mocked(blobServiceModule.blobService.downloadBlob).mockResolvedValue(
        Buffer.from(r2Content, "utf-8"),
      );

      const result = await service.resolve(hash, "");

      expect(blobServiceModule.blobService.downloadBlob).toHaveBeenCalledWith(
        hash,
      );
      expect(result).toBe(r2Content);
    });

    it("should return null when legacy text is empty string and hash is null", async () => {
      // Empty string is falsy so it returns null (no valid session history)
      const result = await service.resolve(null, "");

      expect(result).toBeNull();
    });

    it("should fallback to legacy text when R2 retrieval fails", async () => {
      const hash =
        "abc123def456789012345678901234567890123456789012345678901234abcd";
      const legacyContent = '{"from":"legacy"}\n';

      vi.mocked(blobServiceModule.blobService.downloadBlob).mockRejectedValue(
        new Error("R2 connection failed"),
      );

      const result = await service.resolve(hash, legacyContent);

      expect(blobServiceModule.blobService.downloadBlob).toHaveBeenCalledWith(
        hash,
      );
      // Should fallback to legacy content instead of throwing
      expect(result).toBe(legacyContent);
    });

    it("should throw error when R2 retrieval fails and no legacy text available", async () => {
      const hash =
        "abc123def456789012345678901234567890123456789012345678901234abcd";

      vi.mocked(blobServiceModule.blobService.downloadBlob).mockRejectedValue(
        new Error("R2 connection failed"),
      );

      // Should throw because no fallback available
      await expect(service.resolve(hash, null)).rejects.toThrow(
        "R2 connection failed",
      );
    });
  });
});
