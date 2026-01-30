/**
 * Unit tests for content-addressable storage hash computation
 *
 * These tests verify the pure function computeContentHashFromHashes
 * which computes deterministic version IDs from storage content.
 */

import { describe, it, expect } from "vitest";
import { computeContentHashFromHashes } from "../storage/content-hash";

describe("computeContentHashFromHashes", () => {
  it("should compute same version ID for same content (deterministic)", () => {
    const storageId = "test-storage-id-123";
    const files = [
      { path: "file1.txt", hash: "f".repeat(64), size: 100 },
      { path: "file2.txt", hash: "a".repeat(64), size: 200 },
    ];

    // Compute version ID multiple times
    const versionId1 = computeContentHashFromHashes(storageId, files);
    const versionId2 = computeContentHashFromHashes(storageId, files);
    const versionId3 = computeContentHashFromHashes(storageId, files);

    // All should be identical
    expect(versionId1).toBe(versionId2);
    expect(versionId2).toBe(versionId3);

    // Should be a valid SHA-256 hash (64 hex chars)
    expect(versionId1).toMatch(/^[a-f0-9]{64}$/);
  });

  it("should produce same hash regardless of file order (sorted internally)", () => {
    const storageId = "test-storage-id-456";
    const files = [
      { path: "file1.txt", hash: "f".repeat(64), size: 100 },
      { path: "file2.txt", hash: "a".repeat(64), size: 200 },
    ];

    const filesReordered = [
      { path: "file2.txt", hash: "a".repeat(64), size: 200 },
      { path: "file1.txt", hash: "f".repeat(64), size: 100 },
    ];

    const versionId = computeContentHashFromHashes(storageId, files);
    const versionIdReordered = computeContentHashFromHashes(
      storageId,
      filesReordered,
    );

    expect(versionIdReordered).toBe(versionId);
  });

  it("should produce different version IDs for different storages with same content", () => {
    const storageId1 = "storage-id-one";
    const storageId2 = "storage-id-two";
    const files = [{ path: "same-file.txt", hash: "g".repeat(64), size: 100 }];

    const versionId1 = computeContentHashFromHashes(storageId1, files);
    const versionId2 = computeContentHashFromHashes(storageId2, files);

    // Should be different because storage IDs are different
    expect(versionId1).not.toBe(versionId2);
  });

  it("should compute consistent hash for empty storage", () => {
    const storageId = "empty-storage-id";
    const emptyFiles: { path: string; hash: string; size: number }[] = [];

    const versionId1 = computeContentHashFromHashes(storageId, emptyFiles);
    const versionId2 = computeContentHashFromHashes(storageId, emptyFiles);

    expect(versionId1).toBe(versionId2);
    expect(versionId1).toMatch(/^[a-f0-9]{64}$/);
  });

  it("should produce different hashes for empty storages with different IDs", () => {
    const emptyFiles: { path: string; hash: string; size: number }[] = [];

    const versionId1 = computeContentHashFromHashes("storage-a", emptyFiles);
    const versionId2 = computeContentHashFromHashes("storage-b", emptyFiles);

    expect(versionId1).not.toBe(versionId2);
  });

  it("should produce different hash when file content changes", () => {
    const storageId = "content-change-test";
    const files1 = [{ path: "data.txt", hash: "a".repeat(64), size: 100 }];
    const files2 = [{ path: "data.txt", hash: "b".repeat(64), size: 100 }];

    const versionId1 = computeContentHashFromHashes(storageId, files1);
    const versionId2 = computeContentHashFromHashes(storageId, files2);

    expect(versionId1).not.toBe(versionId2);
  });

  it("should produce different hash when file path changes", () => {
    const storageId = "path-change-test";
    const files1 = [{ path: "old-name.txt", hash: "x".repeat(64), size: 50 }];
    const files2 = [{ path: "new-name.txt", hash: "x".repeat(64), size: 50 }];

    const versionId1 = computeContentHashFromHashes(storageId, files1);
    const versionId2 = computeContentHashFromHashes(storageId, files2);

    expect(versionId1).not.toBe(versionId2);
  });
});
