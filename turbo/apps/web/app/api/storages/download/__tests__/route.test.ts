import { describe, it, expect, vi, beforeEach } from "vitest";
import { GET } from "../route";
import {
  createTestRequest,
  createTestArtifact,
  insertStorageVersion,
} from "../../../../../src/__tests__/api-test-helpers";
import {
  testContext,
  uniqueId,
} from "../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../src/__tests__/clerk-mock";

vi.hoisted(() => {
  vi.stubEnv("R2_USER_STORAGES_BUCKET_NAME", "test-storages-bucket");
});

const context = testContext();

describe("GET /api/storages/download", () => {
  beforeEach(async () => {
    context.setupMocks();
    await context.setupUser();
  });

  it("should return 401 when not authenticated", async () => {
    mockClerk({ userId: null });

    const request = createTestRequest(
      "http://localhost:3000/api/storages/download?name=test&type=volume",
    );

    const response = await GET(request);
    expect(response.status).toBe(401);
  });

  it("should return 400 when name parameter is missing", async () => {
    const request = createTestRequest(
      "http://localhost:3000/api/storages/download?type=volume",
    );

    const response = await GET(request);
    expect(response.status).toBe(400);

    const json = await response.json();
    expect(json.error.message).toContain("name");
  });

  it("should return 400 when type parameter is missing", async () => {
    const request = createTestRequest(
      "http://localhost:3000/api/storages/download?name=test",
    );

    const response = await GET(request);
    expect(response.status).toBe(400);

    const json = await response.json();
    expect(json.error.message).toContain("type");
  });

  it("should return 400 when type is invalid", async () => {
    const request = createTestRequest(
      "http://localhost:3000/api/storages/download?name=test&type=invalid",
    );

    const response = await GET(request);
    expect(response.status).toBe(400);

    const json = await response.json();
    expect(json.error.message).toContain("type");
  });

  it("should return 404 when storage does not exist", async () => {
    const request = createTestRequest(
      `http://localhost:3000/api/storages/download?name=${uniqueId("nonexistent")}&type=volume`,
    );

    const response = await GET(request);
    expect(response.status).toBe(404);
  });

  it("should return 404 when storage has no versions", async () => {
    const storageName = uniqueId("no-versions");

    // Create storage without committing (via prepare only with skipCommit)
    await createTestArtifact(storageName, { skipCommit: true });

    const request = createTestRequest(
      `http://localhost:3000/api/storages/download?name=${storageName}&type=artifact`,
    );

    const response = await GET(request);
    expect(response.status).toBe(404);

    const json = await response.json();
    expect(json.error.message).toContain("no versions");
  });

  it("should return empty=true for empty storage", async () => {
    const storageName = uniqueId("empty");

    // Create empty artifact (no files)
    const { versionId } = await createTestArtifact(storageName, {
      empty: true,
    });

    const request = createTestRequest(
      `http://localhost:3000/api/storages/download?name=${storageName}&type=artifact`,
    );

    const response = await GET(request);
    expect(response.status).toBe(200);

    const json = await response.json();
    expect(json.empty).toBe(true);
    expect(json.versionId).toBe(versionId);
    expect(json.fileCount).toBe(0);
    expect(json.url).toBeUndefined();
  });

  it("should return presigned URL for non-empty storage", async () => {
    const storageName = uniqueId("with-files");
    const files = [
      { path: "file1.txt", hash: "a".repeat(64), size: 500 },
      { path: "file2.txt", hash: "b".repeat(64), size: 500 },
    ];

    // Create artifact with files
    const { versionId } = await createTestArtifact(storageName, { files });

    const request = createTestRequest(
      `http://localhost:3000/api/storages/download?name=${storageName}&type=artifact`,
    );

    const response = await GET(request);
    expect(response.status).toBe(200);

    const json = await response.json();
    expect(json.url).toBe("https://mock-presigned-url");
    expect(json.versionId).toBe(versionId);
    expect(json.fileCount).toBe(2);
    expect(json.size).toBe(1000);
    expect(json.empty).toBeUndefined();
  });

  it("should return presigned URL for specific version", async () => {
    const storageName = uniqueId("specific-version");
    const files1 = [{ path: "file1.txt", hash: "c".repeat(64), size: 500 }];
    const files2 = [
      { path: "file1.txt", hash: "c".repeat(64), size: 500 },
      { path: "file2.txt", hash: "d".repeat(64), size: 1500 },
    ];

    // Create first version
    const { versionId: version1Id } = await createTestArtifact(storageName, {
      files: files1,
    });

    // Create second version (with different files)
    await createTestArtifact(storageName, { files: files2 });

    // Request specific older version
    const request = createTestRequest(
      `http://localhost:3000/api/storages/download?name=${storageName}&type=artifact&version=${version1Id}`,
    );

    const response = await GET(request);
    expect(response.status).toBe(200);

    const json = await response.json();
    expect(json.versionId).toBe(version1Id);
    expect(json.fileCount).toBe(1);
    expect(json.size).toBe(500);
  });

  describe("version prefix resolution", () => {
    it("should resolve version by short prefix (8+ characters)", async () => {
      const storageName = uniqueId("prefix-resolve");
      const files = [{ path: "test.txt", hash: "e".repeat(64), size: 100 }];

      // Create artifact
      const { versionId } = await createTestArtifact(storageName, { files });

      // Use first 8 characters as prefix
      const shortPrefix = versionId.slice(0, 8);

      const request = createTestRequest(
        `http://localhost:3000/api/storages/download?name=${storageName}&type=artifact&version=${shortPrefix}`,
      );

      const response = await GET(request);
      expect(response.status).toBe(200);

      const json = await response.json();
      expect(json.versionId).toBe(versionId);
    });

    it("should return 400 when version prefix is too short", async () => {
      const storageName = uniqueId("prefix-short");
      const files = [{ path: "test.txt", hash: "f".repeat(64), size: 100 }];

      // Create artifact
      await createTestArtifact(storageName, { files });

      // Use only 7 characters (minimum is 8)
      const tooShortPrefix = "abcdefg";

      const request = createTestRequest(
        `http://localhost:3000/api/storages/download?name=${storageName}&type=artifact&version=${tooShortPrefix}`,
      );

      const response = await GET(request);
      expect(response.status).toBe(400);

      const json = await response.json();
      // Zod validation rejects short prefixes at API contract level
      expect(json.error.message).toContain("8");
    });

    it("should return 400 when version prefix is ambiguous", async () => {
      const storageName = uniqueId("prefix-ambiguous");
      const files = [{ path: "v1.txt", hash: "1".repeat(64), size: 100 }];

      // Create first version via API
      const { versionId } = await createTestArtifact(storageName, { files });

      // Insert a second version that shares the same 8-char prefix
      const ambiguousId = versionId.slice(0, 8) + "0".repeat(56);
      await insertStorageVersion(storageName, ambiguousId);

      const prefix = versionId.slice(0, 8);
      const request = createTestRequest(
        `http://localhost:3000/api/storages/download?name=${storageName}&type=artifact&version=${prefix}`,
      );

      const response = await GET(request);
      expect(response.status).toBe(400);

      const json = await response.json();
      expect(json.error.message).toContain("Ambiguous");
    });

    /**
     * Guard test: version prefix that resembles scientific notation.
     *
     * jsonQuery is intentionally disabled in ts-rest-handler.ts (#2666).
     * The hex prefix "846e3519" looks like scientific notation to JSON.parse(),
     * which returns Infinity and corrupts the value before Zod validation.
     * If someone re-enables jsonQuery, this test will fail.
     */
    it("should resolve version prefix that resembles scientific notation (jsonQuery guard)", async () => {
      const storageName = uniqueId("sci-notation");
      const sciNotationPrefix = "846e3519";
      const uniqueSuffix = uniqueId("")
        .replace(/[^0-9a-f]/gi, "0")
        .slice(0, 56)
        .padEnd(56, "0");
      const fullVersionId = sciNotationPrefix + uniqueSuffix;

      // Create storage without committing, then insert a version with the known prefix
      await createTestArtifact(storageName, { skipCommit: true });
      await insertStorageVersion(storageName, fullVersionId);

      const request = createTestRequest(
        `http://localhost:3000/api/storages/download?name=${storageName}&type=artifact&version=${sciNotationPrefix}`,
      );

      const response = await GET(request);
      expect(response.status).toBe(200);

      const json = await response.json();
      expect(json.versionId).toBe(fullVersionId);
    });

    it("should return 400 when version prefix contains invalid characters", async () => {
      const storageName = uniqueId("prefix-invalid");
      const files = [{ path: "test.txt", hash: "0".repeat(64), size: 100 }];

      // Create artifact
      await createTestArtifact(storageName, { files });

      // Use invalid hex characters (g, h, etc. are not valid hex)
      const invalidPrefix = "ghijklmn";

      const request = createTestRequest(
        `http://localhost:3000/api/storages/download?name=${storageName}&type=artifact&version=${invalidPrefix}`,
      );

      const response = await GET(request);
      // Zod validation rejects non-hex characters at API contract level
      expect(response.status).toBe(400);

      const json = await response.json();
      expect(json.error.message).toContain("hex");
    });

    it("should return 404 when version prefix does not match any version", async () => {
      const storageName = uniqueId("prefix-nomatch");
      const files = [{ path: "test.txt", hash: "9".repeat(64), size: 100 }];

      // Create artifact
      await createTestArtifact(storageName, { files });

      // Use a valid hex prefix that doesn't match any version
      const nonMatchingPrefix = "00000000";

      const request = createTestRequest(
        `http://localhost:3000/api/storages/download?name=${storageName}&type=artifact&version=${nonMatchingPrefix}`,
      );

      const response = await GET(request);
      expect(response.status).toBe(404);

      const json = await response.json();
      expect(json.error.message).toContain("not found");
    });
  });
});
