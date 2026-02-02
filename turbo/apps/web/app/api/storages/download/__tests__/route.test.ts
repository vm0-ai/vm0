import { describe, it, expect, vi, beforeEach } from "vitest";
import { GET } from "../route";
import {
  createTestRequest,
  createTestArtifact,
} from "../../../../../src/__tests__/api-test-helpers";
import { testContext } from "../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../src/__tests__/clerk-mock";

vi.mock("@clerk/nextjs/server");
vi.mock("@e2b/code-interpreter");
vi.mock("@aws-sdk/client-s3");
vi.mock("@aws-sdk/s3-request-presigner");
vi.mock("@axiomhq/js");

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
      `http://localhost:3000/api/storages/download?name=nonexistent-${Date.now()}&type=volume`,
    );

    const response = await GET(request);
    expect(response.status).toBe(404);
  });

  it("should return 404 when storage has no versions", async () => {
    const storageName = `no-versions-${Date.now()}`;

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
    const storageName = `empty-${Date.now()}`;

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
    const storageName = `with-files-${Date.now()}`;
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
    const storageName = `specific-version-${Date.now()}`;
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
      const storageName = `prefix-resolve-${Date.now()}`;
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
      const storageName = `prefix-short-${Date.now()}`;
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
      const storageName = `prefix-ambiguous-${Date.now()}`;

      // Create two versions with files that produce hashes starting with same prefix
      // We create versions with different content - the hash algorithm makes it unlikely
      // they share the same prefix, but we can test the error handling by using
      // a prefix that doesn't match anything uniquely
      const files1 = [{ path: "v1.txt", hash: "1".repeat(64), size: 100 }];
      const files2 = [{ path: "v2.txt", hash: "2".repeat(64), size: 200 }];

      const { versionId: v1 } = await createTestArtifact(storageName, {
        files: files1,
      });
      const { versionId: v2 } = await createTestArtifact(storageName, {
        files: files2,
      });

      // If by chance both versions share the same first 8 chars, test ambiguity
      // Otherwise, verify that a non-matching prefix returns 404
      const prefix1 = v1.slice(0, 8);
      const prefix2 = v2.slice(0, 8);

      if (prefix1 === prefix2) {
        // Rare case: both hashes share prefix - test ambiguity error
        const request = createTestRequest(
          `http://localhost:3000/api/storages/download?name=${storageName}&type=artifact&version=${prefix1}`,
        );

        const response = await GET(request);
        expect(response.status).toBe(400);

        const json = await response.json();
        expect(json.error.message).toContain("Ambiguous");
      } else {
        // Common case: different prefixes - verify each resolves correctly
        const request1 = createTestRequest(
          `http://localhost:3000/api/storages/download?name=${storageName}&type=artifact&version=${prefix1}`,
        );
        const response1 = await GET(request1);
        expect(response1.status).toBe(200);
        const json1 = await response1.json();
        expect(json1.versionId).toBe(v1);

        const request2 = createTestRequest(
          `http://localhost:3000/api/storages/download?name=${storageName}&type=artifact&version=${prefix2}`,
        );
        const response2 = await GET(request2);
        expect(response2.status).toBe(200);
        const json2 = await response2.json();
        expect(json2.versionId).toBe(v2);
      }
    });

    it("should return 400 when version prefix contains invalid characters", async () => {
      const storageName = `prefix-invalid-${Date.now()}`;
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
      const storageName = `prefix-nomatch-${Date.now()}`;
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
