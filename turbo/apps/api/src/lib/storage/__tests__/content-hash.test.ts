import { describe, it, expect } from "vitest";
import {
  computeContentHash,
  computeContentHashFromHashes,
  hashFileContent,
  formatShortVersion,
  isValidVersionId,
  isValidVersionPrefix,
  MIN_VERSION_PREFIX_LENGTH,
  FULL_VERSION_LENGTH,
} from "../content-hash";

// Test storage IDs (UUIDs)
const STORAGE_ID_1 = "11111111-1111-1111-1111-111111111111";
const STORAGE_ID_2 = "22222222-2222-2222-2222-222222222222";

describe("computeContentHash", () => {
  it("should return 64-character hex string", () => {
    const files = [{ path: "test.txt", content: Buffer.from("hello") }];
    const hash = computeContentHash(STORAGE_ID_1, files);

    expect(hash).toHaveLength(FULL_VERSION_LENGTH);
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("should be deterministic - same storageId and content produces same hash", () => {
    const files = [
      { path: "a.txt", content: Buffer.from("content a") },
      { path: "b.txt", content: Buffer.from("content b") },
    ];

    const hash1 = computeContentHash(STORAGE_ID_1, files);
    const hash2 = computeContentHash(STORAGE_ID_1, files);

    expect(hash1).toBe(hash2);
  });

  it("should produce same hash regardless of file order", () => {
    const filesOrder1 = [
      { path: "a.txt", content: Buffer.from("content a") },
      { path: "b.txt", content: Buffer.from("content b") },
    ];

    const filesOrder2 = [
      { path: "b.txt", content: Buffer.from("content b") },
      { path: "a.txt", content: Buffer.from("content a") },
    ];

    const hash1 = computeContentHash(STORAGE_ID_1, filesOrder1);
    const hash2 = computeContentHash(STORAGE_ID_1, filesOrder2);

    expect(hash1).toBe(hash2);
  });

  it("should produce different hash for different content", () => {
    const files1 = [{ path: "test.txt", content: Buffer.from("hello") }];
    const files2 = [{ path: "test.txt", content: Buffer.from("world") }];

    const hash1 = computeContentHash(STORAGE_ID_1, files1);
    const hash2 = computeContentHash(STORAGE_ID_1, files2);

    expect(hash1).not.toBe(hash2);
  });

  it("should produce different hash for different paths", () => {
    const files1 = [{ path: "a.txt", content: Buffer.from("content") }];
    const files2 = [{ path: "b.txt", content: Buffer.from("content") }];

    const hash1 = computeContentHash(STORAGE_ID_1, files1);
    const hash2 = computeContentHash(STORAGE_ID_1, files2);

    expect(hash1).not.toBe(hash2);
  });

  it("should produce different hash for different storageId (same content)", () => {
    const files = [{ path: "test.txt", content: Buffer.from("same content") }];

    const hash1 = computeContentHash(STORAGE_ID_1, files);
    const hash2 = computeContentHash(STORAGE_ID_2, files);

    expect(hash1).not.toBe(hash2);
  });

  it("should handle empty file list", () => {
    const hash = computeContentHash(STORAGE_ID_1, []);

    expect(hash).toHaveLength(FULL_VERSION_LENGTH);
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("should produce different hash for empty file list with different storageId", () => {
    const hash1 = computeContentHash(STORAGE_ID_1, []);
    const hash2 = computeContentHash(STORAGE_ID_2, []);

    expect(hash1).not.toBe(hash2);
  });

  it("should handle files with empty content", () => {
    const files = [{ path: "empty.txt", content: Buffer.from("") }];
    const hash = computeContentHash(STORAGE_ID_1, files);

    expect(hash).toHaveLength(FULL_VERSION_LENGTH);
  });

  it("should handle nested paths", () => {
    const files = [
      { path: "dir/subdir/file.txt", content: Buffer.from("nested") },
      { path: "root.txt", content: Buffer.from("root") },
    ];

    const hash = computeContentHash(STORAGE_ID_1, files);
    expect(hash).toHaveLength(FULL_VERSION_LENGTH);
  });

  it("should handle binary content", () => {
    const binaryContent = Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe, 0xfd]);
    const files = [{ path: "binary.bin", content: binaryContent }];

    const hash = computeContentHash(STORAGE_ID_1, files);
    expect(hash).toHaveLength(FULL_VERSION_LENGTH);
  });
});

describe("formatShortVersion", () => {
  it("should return first 8 characters", () => {
    const fullVersion =
      "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2";
    const short = formatShortVersion(fullVersion);

    expect(short).toBe("a1b2c3d4");
    expect(short).toHaveLength(8);
  });
});

describe("isValidVersionId", () => {
  it("should accept valid 64-char hex string", () => {
    const validHash =
      "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2";
    expect(isValidVersionId(validHash)).toBe(true);
  });

  it("should accept uppercase hex", () => {
    const validHash =
      "A1B2C3D4E5F6A7B8C9D0E1F2A3B4C5D6E7F8A9B0C1D2E3F4A5B6C7D8E9F0A1B2";
    expect(isValidVersionId(validHash)).toBe(true);
  });

  it("should reject too short strings", () => {
    expect(isValidVersionId("a1b2c3d4")).toBe(false);
  });

  it("should reject too long strings", () => {
    const tooLong =
      "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2extra";
    expect(isValidVersionId(tooLong)).toBe(false);
  });

  it("should reject non-hex characters", () => {
    const invalid =
      "g1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2";
    expect(isValidVersionId(invalid)).toBe(false);
  });

  it("should reject UUID format", () => {
    const uuid = "a1b2c3d4-e5f6-a7b8-c9d0-e1f2a3b4c5d6";
    expect(isValidVersionId(uuid)).toBe(false);
  });
});

describe("isValidVersionPrefix", () => {
  it("should accept 8-character prefix", () => {
    expect(isValidVersionPrefix("a1b2c3d4")).toBe(true);
  });

  it("should accept longer prefixes", () => {
    expect(isValidVersionPrefix("a1b2c3d4e5f6")).toBe(true);
  });

  it("should accept full 64-character hash", () => {
    const fullHash =
      "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2";
    expect(isValidVersionPrefix(fullHash)).toBe(true);
  });

  it("should reject prefix shorter than minimum", () => {
    expect(isValidVersionPrefix("a1b2c3")).toBe(false);
    expect(isValidVersionPrefix("a1b2c3d")).toBe(false);
  });

  it("should reject non-hex characters", () => {
    expect(isValidVersionPrefix("a1b2c3g4")).toBe(false);
  });

  it("should accept uppercase", () => {
    expect(isValidVersionPrefix("A1B2C3D4")).toBe(true);
  });

  it("should have correct minimum length constant", () => {
    expect(MIN_VERSION_PREFIX_LENGTH).toBe(8);
  });
});

describe("computeContentHashFromHashes", () => {
  it("should produce IDENTICAL hash to computeContentHash for same data", () => {
    const files = [
      { path: "a.txt", content: Buffer.from("content a") },
      { path: "b.txt", content: Buffer.from("content b") },
    ];

    // Compute hash using original method (with content)
    const hashFromContent = computeContentHash(STORAGE_ID_1, files);

    // Compute hash using new method (with pre-computed hashes)
    const filesWithHashes = files.map((f) => ({
      path: f.path,
      hash: hashFileContent(f.content),
      size: f.content.length,
    }));
    const hashFromHashes = computeContentHashFromHashes(
      STORAGE_ID_1,
      filesWithHashes,
    );

    // They MUST be identical
    expect(hashFromHashes).toBe(hashFromContent);
  });

  it("should produce IDENTICAL hash regardless of file order", () => {
    const filesOrder1 = [
      {
        path: "a.txt",
        hash: hashFileContent(Buffer.from("content a")),
        size: 9,
      },
      {
        path: "b.txt",
        hash: hashFileContent(Buffer.from("content b")),
        size: 9,
      },
    ];

    const filesOrder2 = [
      {
        path: "b.txt",
        hash: hashFileContent(Buffer.from("content b")),
        size: 9,
      },
      {
        path: "a.txt",
        hash: hashFileContent(Buffer.from("content a")),
        size: 9,
      },
    ];

    const hash1 = computeContentHashFromHashes(STORAGE_ID_1, filesOrder1);
    const hash2 = computeContentHashFromHashes(STORAGE_ID_1, filesOrder2);

    expect(hash1).toBe(hash2);
  });

  it("should handle empty file list", () => {
    const hashFromContent = computeContentHash(STORAGE_ID_1, []);
    const hashFromHashes = computeContentHashFromHashes(STORAGE_ID_1, []);

    expect(hashFromHashes).toBe(hashFromContent);
  });

  it("should produce different hash for different storageId", () => {
    const files = [
      {
        path: "test.txt",
        hash: hashFileContent(Buffer.from("content")),
        size: 7,
      },
    ];

    const hash1 = computeContentHashFromHashes(STORAGE_ID_1, files);
    const hash2 = computeContentHashFromHashes(STORAGE_ID_2, files);

    expect(hash1).not.toBe(hash2);
  });

  it("should return 64-character hex string", () => {
    const files = [
      {
        path: "test.txt",
        hash: hashFileContent(Buffer.from("hello")),
        size: 5,
      },
    ];
    const hash = computeContentHashFromHashes(STORAGE_ID_1, files);

    expect(hash).toHaveLength(FULL_VERSION_LENGTH);
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("should work with many files", () => {
    // Create 100 files
    const files = Array.from({ length: 100 }, (_, i) => ({
      path: `file${i}.txt`,
      content: Buffer.from(`content ${i}`),
    }));

    const hashFromContent = computeContentHash(STORAGE_ID_1, files);
    const filesWithHashes = files.map((f) => ({
      path: f.path,
      hash: hashFileContent(f.content),
      size: f.content.length,
    }));
    const hashFromHashes = computeContentHashFromHashes(
      STORAGE_ID_1,
      filesWithHashes,
    );

    expect(hashFromHashes).toBe(hashFromContent);
  });
});
